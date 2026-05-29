import { ethers } from "ethers";
import { RELAYER_REGISTRY_ABI } from "../core/contracts";
import { RelayerClient } from "./client";
import type { RelayerInfo, RelayerOnChain, RelayerStatsResponse } from "./types";

/** Read the registry contract's active list and return the full
 *  on-chain row for each. Pure read; no side effects. */
export async function loadActiveRelayers(
  registryAddress: string,
  provider: ethers.Provider,
): Promise<RelayerOnChain[]> {
  const registry = new ethers.Contract(registryAddress, RELAYER_REGISTRY_ABI, provider);
  const activeAddresses = (await registry.getActiveRelayers()) as string[];
  return Promise.all(
    activeAddresses.map(async (addr): Promise<RelayerOnChain> => {
      const r = await registry.relayers(addr);
      return {
        address: addr,
        url: r.url,
        name: r.name ?? "",
        fee: Number(r.fee),
        bond: r.bond,
        registeredAt: Number(r.registeredAt),
        exitRequestedAt: Number(r.exitRequestedAt),
        active: r.active,
      };
    }),
  );
}

export interface LoadOpts {
  /** Per-relayer probe timeout. Defaults to 3 s — long enough for
   *  a healthy node, short enough that one stuck node doesn't drag
   *  the whole list. */
  probeTimeoutMs?: number;
  /** When true, also probe `/api/relayer/stats` per relayer in
   *  parallel with `/api/info`. Info-success / stats-failure leaves
   *  `stats: undefined` (older relayer build, transport error). */
  withStats?: boolean;
}

/** Combine on-chain registry data with a live `/api/info` probe per
 *  relayer. Probes run in parallel; offline relayers come back
 *  with `online: false` and `api: undefined`.
 *
 *  When `withStats` is set, also probes `/api/relayer/stats` in
 *  parallel with `/api/info`. The two probes are independent — a
 *  relayer can be `online: true` (info ok) but have `stats: undefined`
 *  if it's an older build that doesn't expose the endpoint. */
export async function loadRelayersWithApiInfo(
  registryAddress: string,
  provider: ethers.Provider,
  opts: LoadOpts = {},
): Promise<RelayerInfo[]> {
  const onChain = await loadActiveRelayers(registryAddress, provider);
  const timeoutMs = opts.probeTimeoutMs ?? 3_000;
  return Promise.all(
    onChain.map(async (r): Promise<RelayerInfo> => {
      const client = new RelayerClient(r.url, { timeoutMs });
      const [infoResult, statsResult] = await Promise.all([
        client.getInfo().then((api) => ({ ok: true as const, api })).catch(() => ({ ok: false as const })),
        opts.withStats
          ? client.getStats().then((stats) => ({ ok: true as const, stats })).catch(() => ({ ok: false as const }))
          : Promise.resolve({ ok: false as const }),
      ]);
      if (!infoResult.ok) return { ...r, online: false };
      return {
        ...r,
        api: infoResult.api,
        stats: statsResult.ok ? statsResult.stats : undefined,
        online: true,
      };
    }),
  );
}

interface SharedObSettlement {
  txHash: string;
  blockNumber: number;
  submitter: string;
  makerRelayer: string;
  takerRelayer?: string | null;
  makerNullifier: string;
  takerNullifier: string;
  sellToken?: string | null;
  buyToken?: string | null;
  sellAmount?: string | null;
  buyAmount?: string | null;
  feeMaker: string;
  feeTaker: string;
  /** Pay = scatterDirectAuth, Pro = settleAuth. Absent for rows
   *  pushed by older relayers or pre-byApp indexer state — the
   *  aggregator counts those in the all-segment totals but skips
   *  them in byApp so the split doesn't fabricate attribution. */
  type?: "settleAuth" | "scatterDirectAuth" | null;
}

interface SharedObListResponse {
  settlements: SharedObSettlement[];
  count: number;
}

/** Combine on-chain registry + live `/api/info` (per-peer health probe)
 *  + per-relayer stats *aggregated from the shared orderbook indexer*
 *  instead of each peer's local DB.
 *
 *  Why prefer shared-OB over peer `/api/relayer/stats`?
 *   - **Survives relayer DB wipe.** Peer local DBs reset whenever the
 *     relayer is restarted with `RESET_STATE=1` or rm'd manually; the
 *     shared-OB indexer is the durable source of truth.
 *   - **No double-count.** Each on-chain settle is one row in shared-OB
 *     with explicit maker_relayer / taker_relayer / fee_maker /
 *     fee_taker columns, so per-relayer attribution doesn't depend on
 *     whether the peer's local writer happened to be sell-only or
 *     both-leg. Volume here is built sell-side per role (maker_relayer
 *     sells `sellToken`, taker_relayer sells `buyToken`).
 *   - **Revenue parity for counterparty.** Fees are attributed by the
 *     relayer that brought each order (maker_relayer earns fee_maker
 *     in `buyToken`, taker_relayer earns fee_taker in `sellToken`),
 *     regardless of which peer actually submitted on-chain. */
export async function loadRelayersWithSharedOrderbookStats(
  registryAddress: string,
  provider: ethers.Provider,
  sharedOrderbookUrl: string,
  opts: LoadOpts = {},
): Promise<RelayerInfo[]> {
  const onChain = await loadActiveRelayers(registryAddress, provider);
  const timeoutMs = opts.probeTimeoutMs ?? 3_000;
  // Fetch shared-OB once for all relayers — beats N parallel
  // per-relayer calls because every relayer shares the same row set.
  // Paginate-until-exhausted (see fetchAllSettlements) so totals
  // remain correct beyond the per-page MAX_LIMIT cap shared-OB
  // enforces; capped at SHARED_OB_MAX_PAGES pages to bound work.
  const allSettles = await fetchAllSettlements(sharedOrderbookUrl, timeoutMs);
  // Single-pass index of all settlements keyed by relayer address.
  // Cuts the per-relayer aggregation cost from O(N × R) to O(R + N×K)
  // where N=relayers, R=settlement rows, K=unique tokens per
  // relayer — the per-relayer pass over the full settlement list
  // was the dominant cost when the indexer grows past a few
  // hundred rows.
  const statsByAddr = buildAllStatsFromSharedOb(allSettles);
  return Promise.all(
    onChain.map(async (r): Promise<RelayerInfo> => {
      const client = new RelayerClient(r.url, { timeoutMs });
      const infoResult = await client
        .getInfo()
        .then((api) => ({ ok: true as const, api }))
        .catch(() => ({ ok: false as const }));
      const stats = finalizeStats(r.address, statsByAddr.get(r.address.toLowerCase()));
      if (!infoResult.ok) return { ...r, online: false, stats };
      return { ...r, api: infoResult.api, stats, online: true };
    }),
  );
}

/** Fetch + build per-relayer stats from the shared orderbook for ONE
 *  address. Used by the relayer detail page so its numbers don't
 *  drift from the leaderboard (which already reads from shared-OB).
 *  Returns null on fetch failure so the caller can fall back to the
 *  peer's local /api/relayer/stats. */
export async function fetchRelayerStatsFromSharedOrderbook(
  sharedOrderbookUrl: string,
  address: string,
  timeoutMs = 3_000,
): Promise<RelayerStatsResponse | null> {
  const rows = await fetchAllSettlements(sharedOrderbookUrl, timeoutMs);
  if (rows.length === 0) return null;
  const byAddr = buildAllStatsFromSharedOb(rows);
  return finalizeStats(address, byAddr.get(address.toLowerCase()));
}

// Per-page cap shared-OB enforces on /api/settlements (MAX_LIMIT in
// shared-orderbook/src/routes/settlements.ts). A single fetch can't
// exceed this; multi-page exhaustion is the only way to get the full
// history.
const SHARED_OB_PAGE_SIZE = 500;
// Hard cap on the number of pages we'll fetch — at 500 rows/page this
// is 25 000 settlements, well above what a single browser session
// needs and short enough to bail out before a runaway loop hangs the
// page on a misbehaving indexer.
const SHARED_OB_MAX_PAGES = 50;

async function fetchAllSettlements(
  sharedOrderbookUrl: string,
  timeoutMs: number,
): Promise<SharedObSettlement[]> {
  const base = sharedOrderbookUrl.replace(/\/+$/, "");
  const out: SharedObSettlement[] = [];
  try {
    // Paginate-until-exhausted via offset. Without this, networks
    // with >500 settlements silently undercounted, drifting volume
    // and revenue rankings as more trades landed. The /api/settlements
    // endpoint enumerates by block_number DESC (idx_settle_block), so
    // a stable offset is safe — new rows on top would only appear on
    // the next refresh tick.
    for (let page = 0; page < SHARED_OB_MAX_PAGES; page += 1) {
      const offset = page * SHARED_OB_PAGE_SIZE;
      const res = await fetch(
        `${base}/api/settlements?limit=${SHARED_OB_PAGE_SIZE}&offset=${offset}`,
        { signal: AbortSignal.timeout(timeoutMs) },
      );
      if (!res.ok) break;
      const data = (await res.json()) as SharedObListResponse;
      const batch = data.settlements ?? [];
      out.push(...batch);
      // Short page (or empty) means we've reached the end. Avoids a
      // pointless extra round-trip that would always return 0 rows.
      if (batch.length < SHARED_OB_PAGE_SIZE) break;
    }
    return out;
  } catch {
    // Partial result is acceptable — better to show some leaderboard
    // numbers than blank the whole page on a transient page-fetch
    // failure mid-pagination.
    return out;
  }
}

interface RelayerAggregate {
  txCount: number;
  volByToken: Map<string, { count: number; totalVolume: bigint }>;
  feeByToken: Map<string, { count: number; totalWei: bigint }>;
  /** Same shape as the top-level fields, but partitioned by the
   *  settlement's entry-point (`scatterDirectAuth` → pay,
   *  `settleAuth` → pro). Rows whose indexer record lacks a `type`
   *  (older relayer push / pre-migration backfill) contribute to
   *  the top-level totals only — they're invisible here, which is
   *  why the operators leaderboard's segment view shows "—" for
   *  them rather than crediting an unknown side. */
  byApp: {
    pay: { txCount: number; volByToken: Map<string, { count: number; totalVolume: bigint }>; feeByToken: Map<string, { count: number; totalWei: bigint }> };
    pro: { txCount: number; volByToken: Map<string, { count: number; totalVolume: bigint }>; feeByToken: Map<string, { count: number; totalWei: bigint }> };
  };
}

/** Single-pass index of the shared-OB settlement list into per-relayer
 *  aggregates. Sell-only per-relayer attribution mirrors the per-
 *  relayer DB writer rule:
 *   - maker_relayer accrues `sellAmount` of `sellToken` (its user's
 *     sell leg) + `feeMaker` in `buyToken`.
 *   - taker_relayer accrues `buyAmount` of `buyToken` (its user's
 *     sell leg — taker.sellToken == settlement.buyToken) + `feeTaker`
 *     in `sellToken`.
 *   - scatterDirectAuth (Pay) has `takerRelayer = null`; only the
 *     maker side fires.
 *  All address keys are lowercased to match shared-OB's storage. */
function buildAllStatsFromSharedOb(
  rows: SharedObSettlement[],
): Map<string, RelayerAggregate> {
  const byAddr = new Map<string, RelayerAggregate>();
  const ensure = (addr: string): RelayerAggregate => {
    let agg = byAddr.get(addr);
    if (!agg) {
      agg = {
        txCount: 0,
        volByToken: new Map(),
        feeByToken: new Map(),
        byApp: {
          pay: { txCount: 0, volByToken: new Map(), feeByToken: new Map() },
          pro: { txCount: 0, volByToken: new Map(), feeByToken: new Map() },
        },
      };
      byAddr.set(addr, agg);
    }
    return agg;
  };
  // Bucket selector — undefined when the row's `type` is unknown
  // (older relayer push / pre-migration row). Callers fall back to
  // counting in aggregate only.
  const subFor = (
    agg: RelayerAggregate,
    type: SharedObSettlement["type"],
  ): RelayerAggregate["byApp"]["pay"] | undefined =>
    type === "scatterDirectAuth"
      ? agg.byApp.pay
      : type === "settleAuth"
      ? agg.byApp.pro
      : undefined;
  // Token-volume / fee accumulators that take an explicit sub-map so
  // the caller can fan-out a single (token, amount) pair into both
  // the aggregate map and the byApp sub-map without re-parsing the
  // BigInt twice.
  const addVolTo = (
    map: Map<string, { count: number; totalVolume: bigint }>,
    tok: string,
    v: bigint,
  ) => {
    const cur = map.get(tok) ?? { count: 0, totalVolume: 0n };
    cur.totalVolume += v;
    cur.count += 1;
    map.set(tok, cur);
  };
  const addFeeTo = (
    map: Map<string, { count: number; totalWei: bigint }>,
    tok: string,
    v: bigint,
  ) => {
    if (v === 0n) return;
    const cur = map.get(tok) ?? { count: 0, totalWei: 0n };
    cur.totalWei += v;
    cur.count += 1;
    map.set(tok, cur);
  };
  const addVol = (
    agg: RelayerAggregate,
    sub: RelayerAggregate["byApp"]["pay"] | undefined,
    tok: string | null | undefined,
    amt: string | null | undefined,
  ) => {
    if (!tok || !amt) return;
    const k = tok.toLowerCase();
    let v: bigint;
    try { v = BigInt(amt); } catch { return; /* malformed wei string — drop the row */ }
    addVolTo(agg.volByToken, k, v);
    if (sub) addVolTo(sub.volByToken, k, v);
  };
  const addFee = (
    agg: RelayerAggregate,
    sub: RelayerAggregate["byApp"]["pay"] | undefined,
    tok: string | null | undefined,
    amt: string | null | undefined,
  ) => {
    if (!tok || !amt) return;
    const k = tok.toLowerCase();
    let v: bigint;
    try { v = BigInt(amt); } catch { return; }
    addFeeTo(agg.feeByToken, k, v);
    if (sub) addFeeTo(sub.feeByToken, k, v);
  };
  for (const row of rows) {
    const maker = row.makerRelayer?.toLowerCase();
    const taker = row.takerRelayer?.toLowerCase();
    // Three shapes to handle:
    //   1) Cross-relayer match (maker != taker): each relayer counts
    //      ONE leg (its own user's sell side) + one tx, the
    //      counterparty records the other half in the peer's bucket.
    //   2) Single-relayer match (maker == taker): one relayer brought
    //      both sides of the trade. txCount is ONE (it's one tx) but
    //      throughput accrues to BOTH tokens — the relayer's user-pair
    //      contributed both legs to the pool. Without the both-leg
    //      add here, single-relayer matches would silently undercount
    //      the buy-leg token's throughput on that relayer.
    //   3) scatterDirectAuth (Pay): taker is NULL, only the maker
    //      branch fires.
    if (maker) {
      const agg = ensure(maker);
      const sub = subFor(agg, row.type);
      agg.txCount += 1;
      if (sub) sub.txCount += 1;
      addVol(agg, sub, row.sellToken, row.sellAmount);
      addFee(agg, sub, row.buyToken, row.feeMaker);
    }
    if (taker) {
      const agg = ensure(taker);
      const sub = subFor(agg, row.type);
      // Avoid double-counting the tx itself when both sides credit
      // the same relayer; only the legs (different tokens) accrue
      // a second time. Same rule applies inside the byApp sub-agg
      // so a self-self match doesn't inflate Pro txCount.
      if (taker !== maker) {
        agg.txCount += 1;
        if (sub) sub.txCount += 1;
      }
      addVol(agg, sub, row.buyToken, row.buyAmount);
      addFee(agg, sub, row.sellToken, row.feeTaker);
    }
  }
  return byAddr;
}

/** Materialise the public RelayerStatsResponse shape for one address
 *  from a precomputed aggregate (or an absent one — a registered
 *  relayer with zero activity still needs a valid empty response so
 *  the leaderboard renders "—" instead of crashing). */
function finalizeStats(
  address: string,
  agg: RelayerAggregate | undefined,
): RelayerStatsResponse {
  const txCount = agg?.txCount ?? 0;
  return {
    address,
    // `totalOrders` mirrors `settledOrders` here because shared-OB
    // doesn't see failed/reverted attempts — only the on-chain
    // settle events relayers push after a confirmed receipt land in
    // the indexer. That means `successRate` derived from this slice
    // is structurally 100% (or 0% with no history) and isn't
    // comparable to the peer-reported success rate which divides
    // settled / total ATTEMPTS. Left as 100/0 so the UI doesn't
    // crash on null, but the leaderboard column reads "Success" as
    // "confirmed share of confirmed attempts" — see the page footer
    // for what the source actually means.
    totalOrders: txCount,
    settledOrders: txCount,
    successRate: txCount > 0 ? 100 : 0,
    crossRelayerSettled: 0,
    totalTradeOffers: 0,
    settledTradeOffers: 0,
    avgSettleTimeMs: null,
    uptimeSince: null,
    pendingOrders: 0,
    settledVolume: agg
      ? Array.from(agg.volByToken, ([sellToken, { count, totalVolume }]) => ({
          sellToken,
          count,
          totalVolume: totalVolume.toString(),
        }))
      : [],
    feeTotals: agg
      ? Array.from(agg.feeByToken, ([token, { count, totalWei }]) => ({
          token,
          count,
          totalWei: totalWei.toString(),
        }))
      : [],
    // Emit byApp only when at least one segment has counted a
    // settlement — matches the optional jsdoc on
    // `RelayerStatsResponse.byApp` and lets the operators
    // leaderboard's "older relayer / no split" path fire for
    // never-active relayers (rather than render a 0%·0% mix bar).
    // PayProMixBar already returns null when both sides are zero,
    // so the visual outcome is the same — this just keeps the
    // wire payload honest about whether per-app data exists.
    byApp: agg && hasByAppActivity(agg.byApp) ? materializeByApp(agg.byApp) : undefined,
  };
}

function hasByAppActivity(byApp: RelayerAggregate["byApp"]): boolean {
  return byApp.pay.txCount > 0 || byApp.pro.txCount > 0;
}

function materializeByApp(
  byApp: RelayerAggregate["byApp"],
): NonNullable<RelayerStatsResponse["byApp"]> {
  const one = (sub: RelayerAggregate["byApp"]["pay"]) => ({
    // shared-OB only sees confirmed settlements (relayers push after
    // the receipt), so totalOrders === settledOrders here — same
    // shape contract as the aggregate fields above.
    totalOrders: sub.txCount,
    settledOrders: sub.txCount,
    settledVolume: Array.from(sub.volByToken, ([sellToken, { count, totalVolume }]) => ({
      sellToken,
      count,
      totalVolume: totalVolume.toString(),
    })),
    feeTotals: Array.from(sub.feeByToken, ([token, { count, totalWei }]) => ({
      token,
      count,
      totalWei: totalWei.toString(),
    })),
  });
  return { pay: one(byApp.pay), pro: one(byApp.pro) };
}
