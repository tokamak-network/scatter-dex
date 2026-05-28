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
  // Fetch shared-OB once for all relayers — single network round-trip
  // beats N parallel per-relayer calls when N is small (the usual
  // case). Bounded at limit=500 because the leaderboard view shows
  // lifetime totals; truncation manifests as conservative numbers,
  // not wrong direction.
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

async function fetchAllSettlements(
  sharedOrderbookUrl: string,
  timeoutMs: number,
): Promise<SharedObSettlement[]> {
  try {
    const res = await fetch(
      `${sharedOrderbookUrl.replace(/\/+$/, "")}/api/settlements?limit=500`,
      { signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as SharedObListResponse;
    return data.settlements ?? [];
  } catch {
    return [];
  }
}

interface RelayerAggregate {
  txCount: number;
  volByToken: Map<string, { count: number; totalVolume: bigint }>;
  feeByToken: Map<string, { count: number; totalWei: bigint }>;
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
      agg = { txCount: 0, volByToken: new Map(), feeByToken: new Map() };
      byAddr.set(addr, agg);
    }
    return agg;
  };
  const addVol = (
    agg: RelayerAggregate,
    tok: string | null | undefined,
    amt: string | null | undefined,
  ) => {
    if (!tok || !amt) return;
    const k = tok.toLowerCase();
    const cur = agg.volByToken.get(k) ?? { count: 0, totalVolume: 0n };
    try {
      cur.totalVolume += BigInt(amt);
      cur.count += 1;
      agg.volByToken.set(k, cur);
    } catch {
      /* malformed wei string — drop the row instead of crashing the page */
    }
  };
  const addFee = (
    agg: RelayerAggregate,
    tok: string | null | undefined,
    amt: string | null | undefined,
  ) => {
    if (!tok || !amt) return;
    const k = tok.toLowerCase();
    const cur = agg.feeByToken.get(k) ?? { count: 0, totalWei: 0n };
    try {
      const v = BigInt(amt);
      if (v === 0n) return;
      cur.totalWei += v;
      cur.count += 1;
      agg.feeByToken.set(k, cur);
    } catch {
      /* same — skip on parse failure */
    }
  };
  for (const row of rows) {
    const maker = row.makerRelayer?.toLowerCase();
    const taker = row.takerRelayer?.toLowerCase();
    if (maker) {
      const agg = ensure(maker);
      agg.txCount += 1;
      addVol(agg, row.sellToken, row.sellAmount);
      addFee(agg, row.buyToken, row.feeMaker);
    }
    if (taker && taker !== maker) {
      const agg = ensure(taker);
      agg.txCount += 1;
      addVol(agg, row.buyToken, row.buyAmount);
      addFee(agg, row.sellToken, row.feeTaker);
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
    totalOrders: txCount,
    settledOrders: txCount,
    // Shared-OB only stores confirmed on-chain rows, so success is
    // trivially 100% when there's any row. Show 0% with no history
    // so a brand-new relayer doesn't display "100%" before settling
    // anything (would be misleading green).
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
  };
}
