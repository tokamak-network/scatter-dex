import { useState, useEffect, useRef, useCallback } from "react";
import { ethers } from "ethers";
import { getReadProvider, getSafeFromBlock } from "./provider";
import { getFeeVaultAddress } from "./config";
import { FEE_VAULT_ABI } from "./contracts";
import { getTokenList, type TokenInfo } from "./tokens";
import { extractEthersErrorMessage } from "./utils";
import { multicall, encodeCall, decodeResult } from "./multicall";

/**
 * Three platform-revenue streams emitted by FeeVault:
 *
 *   - `dex-fee`: the configured `dexPlatformFeeBps` cut on `settleWithDex`
 *     market orders. Accumulates in `platformRevenue(token)` until
 *     treasury sweeps it.
 *   - `dex-surplus`: positive DEX slippage (returned more than minOut) on
 *     `settleWithDex`. Same accumulation path as `dex-fee`.
 *   - `relayer-claim-skim`: the `platformFeeBps` cut taken when a relayer
 *     calls `FeeVault.claim()`. Funds go straight to treasury — *not*
 *     accumulated in `platformRevenue[]`. Lifetime totals come from the
 *     `PlatformFeeFromRelayerClaim` event stream alone, so they will
 *     NOT reconcile with `accumulated + lifetimeWithdrawn` for the same
 *     token. UI must call this out where the totals are surfaced.
 */
export const PLATFORM_REVENUE_SOURCES = [
  { id: "relayer-claim-skim", label: "Relayer-claim skim" },
  { id: "dex-fee",            label: "DEX market platform fee" },
  { id: "dex-surplus",        label: "DEX positive slippage" },
] as const;
export type PlatformRevenueSourceId = typeof PLATFORM_REVENUE_SOURCES[number]["id"];

export interface PlatformRevenueRow {
  token: string;
  symbol: string;
  decimals: number;
  /** Currently held by the FeeVault (DEX-side accruals only — relayer
   *  skim is treasury-direct and never lands in this bucket). */
  accumulated: bigint;
  /** Sum of all `PlatformRevenueWithdrawn` events for this token. */
  lifetimeWithdrawn: bigint;
}

export interface PlatformRevenueByTokenEntry {
  token: string;
  symbol: string;
  decimals: number;
  amount: bigint;
}

export interface PlatformRevenueBySource {
  source: PlatformRevenueSourceId;
  /** Per-token totals of lifetime accruals for this source. Only tokens
   *  the frontend recognises are included; unknown-token events are
   *  dropped silently (intentional — no symbol/decimals to render). */
  entries: PlatformRevenueByTokenEntry[];
}

export interface PlatformRevenueWithdrawal {
  token: string;
  symbol: string;
  decimals: number;
  amount: bigint;
  to: string;
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  txHash: string;
}

export interface PlatformRevenueData {
  treasury: string | null;
  platformFeeBps: number | null;
  rows: PlatformRevenueRow[];
  bySource: PlatformRevenueBySource[];
  recentWithdrawals: PlatformRevenueWithdrawal[];
  loading: boolean;
  error: string | null;
  fromBlock: number | null;
  /** Per-stream RPC failures that didn't cause a full reload error.
   *  UI should surface these as a banner so a "no events found"
   *  rendering isn't confused with a true empty result. */
  partialFailures: string[];
  /** Re-run the full fetch (useful for a manual "Refresh" button). */
  refetch: () => void;
}

export const RECENT_WITHDRAWAL_LIMIT = 10;

/**
 * Reads platform-side FeeVault data for the treasury board:
 *   - configured treasury address + relayer-claim platform fee bps
 *   - per-token currently-accumulated balance + lifetime withdrawals
 *   - per-source breakdown across all three accrual events
 *   - last N `PlatformRevenueWithdrawn` events
 *
 * All reads go through the public read provider — no wallet required.
 * Skips native (ETH) since FeeVault tracks ERC20 balances only. Each
 * event-stream `queryFilter` is `allSettled`-wrapped so a single RPC
 * timeout doesn't blank the whole page.
 */
export function usePlatformRevenue(): PlatformRevenueData {
  const [data, setData] = useState<Omit<PlatformRevenueData, "refetch">>({
    treasury: null, platformFeeBps: null, rows: [], bySource: [],
    recentWithdrawals: [], loading: false, error: null, fromBlock: null,
    partialFailures: [],
  });
  const loadIdRef = useRef(0);
  // Cache the in-flight load promise so rapid concurrent `refetch`
  // calls (e.g. user clicking the Refresh button repeatedly) await the
  // same fetch instead of fanning out duplicate RPC traffic.
  const inFlightRef = useRef<Promise<void> | null>(null);

  const load = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;
    const p = (async () => {
    const myId = ++loadIdRef.current;
    setData((d) => ({ ...d, loading: true, error: null, partialFailures: [] }));

    try {
      const feeVaultAddr = getFeeVaultAddress();
      if (!feeVaultAddr) {
        if (loadIdRef.current === myId) {
          setData({
            treasury: null, platformFeeBps: null, rows: [], bySource: [],
            recentWithdrawals: [], loading: false,
            error: "FeeVault not configured", fromBlock: null,
            partialFailures: [],
          });
        }
        return;
      }

      const provider = getReadProvider();
      const vault = new ethers.Contract(feeVaultAddr, FEE_VAULT_ABI, provider);
      const tokens = getTokenList().filter((t: TokenInfo) => !t.isNative);
      // No tokens configured = nothing to map events onto. Treat as a
      // configuration error rather than silently showing zeros.
      if (tokens.length === 0) {
        throw new Error("No ERC-20 tokens configured. Set NEXT_PUBLIC_TOKENS so platform revenue can be mapped to tokens.");
      }
      const fromBlock = await getSafeFromBlock(provider);

      // Run everything in one batch. The `treasury()` / `platformFeeBps()`
      // reads use `.catch` so they don't reject the whole batch (sentinel
      // = null in the UI); the queryFilters are wrapped in `allSettled`
      // so one failed range doesn't blank the whole page.
      // Batch all N per-token `platformRevenue(token)` reads plus
      // `treasury()` and `platformFeeBps()` into a single Multicall3
      // request — one round trip instead of 2+N. Falls back to
      // individual calls per-chunk inside `multicall()` if Multicall3
      // is unavailable on this chain.
      const vaultIface = new ethers.Interface(FEE_VAULT_ABI);
      const viewCalls = [
        { target: feeVaultAddr, callData: encodeCall(vaultIface, "treasury", []) },
        { target: feeVaultAddr, callData: encodeCall(vaultIface, "platformFeeBps", []) },
        ...tokens.map((t) => ({
          target: feeVaultAddr,
          callData: encodeCall(vaultIface, "platformRevenue", [t.address]),
        })),
      ];

      const [viewResults, eventsSettled] = await Promise.all([
        multicall(provider, viewCalls),
        Promise.allSettled([
          vault.queryFilter(vault.filters.PlatformFeeFromDex(), fromBlock),
          vault.queryFilter(vault.filters.PlatformSurplusFromDex(), fromBlock),
          vault.queryFilter(vault.filters.PlatformFeeFromRelayerClaim(), fromBlock),
          vault.queryFilter(vault.filters.PlatformRevenueWithdrawn(), fromBlock),
        ]),
      ]);

      const treasuryRes = viewResults[0].success
        ? (decodeResult(vaultIface, "treasury", viewResults[0].returnData)[0] as string)
        : null;
      const feeBpsRes = viewResults[1].success
        ? (decodeResult(vaultIface, "platformFeeBps", viewResults[1].returnData)[0] as bigint)
        : null;
      // Mirror the `PromiseSettledResult` shape for the per-token reads
      // so the rest of the hook can use one code path regardless of
      // whether the multicall or fallback path ran.
      const accumSettled: PromiseSettledResult<bigint>[] = tokens.map((_, i) => {
        const r = viewResults[2 + i];
        if (r.success) {
          return {
            status: "fulfilled",
            value: decodeResult(vaultIface, "platformRevenue", r.returnData)[0] as bigint,
          };
        }
        return { status: "rejected", reason: new Error("multicall entry failed") };
      });
      if (loadIdRef.current !== myId) return;

      const eventNames = ["PlatformFeeFromDex", "PlatformSurplusFromDex", "PlatformFeeFromRelayerClaim", "PlatformRevenueWithdrawn"] as const;
      const partialFailures: string[] = [];
      if (treasuryRes === null) partialFailures.push("treasury() RPC failed");
      if (feeBpsRes === null) partialFailures.push("platformFeeBps() RPC failed");
      const [dexFees, dexSurpluses, relayerSkims, withdrawals] = eventsSettled.map((res, i): ethers.Log[] => {
        if (res.status === "rejected") {
          const msg = `${eventNames[i]} scan: ${extractEthersErrorMessage(res.reason)}`;
          console.warn(`event scan failed (${eventNames[i]}):`, res.reason);
          partialFailures.push(msg);
          return [];
        }
        return res.value as ethers.Log[];
      });
      accumSettled.forEach((res, i) => {
        if (res.status === "rejected") {
          const msg = `platformRevenue(${tokens[i].symbol}): ${extractEthersErrorMessage(res.reason)}`;
          console.warn(`platformRevenue read failed for ${tokens[i].symbol}:`, res.reason);
          partialFailures.push(msg);
        }
      });

      const tokensByAddress = new Map(tokens.map((t) => [t.address.toLowerCase(), t]));

      // Sum a single event stream into a `Map<tokenLowercased, bigint>`.
      const sumByToken = (logs: ethers.Log[]): Map<string, bigint> => {
        const out = new Map<string, bigint>();
        for (const log of logs) {
          const e = log as ethers.EventLog;
          const tokLc = (e.args.token as string).toLowerCase();
          out.set(tokLc, (out.get(tokLc) ?? 0n) + (e.args.amount as bigint));
        }
        return out;
      };

      // Project a sum-Map onto the typed entries shape the UI consumes;
      // tokens not in the configured list are silently dropped.
      const toEntries = (sums: Map<string, bigint>): PlatformRevenueByTokenEntry[] => {
        const entries: PlatformRevenueByTokenEntry[] = [];
        for (const [tokLc, amount] of sums) {
          const meta = tokensByAddress.get(tokLc);
          if (!meta) continue;
          entries.push({ token: meta.address, symbol: meta.symbol, decimals: meta.decimals, amount });
        }
        return entries;
      };

      const bySource: PlatformRevenueBySource[] = [
        { source: "relayer-claim-skim", entries: toEntries(sumByToken(relayerSkims)) },
        { source: "dex-fee",            entries: toEntries(sumByToken(dexFees)) },
        { source: "dex-surplus",        entries: toEntries(sumByToken(dexSurpluses)) },
      ];

      // Single pass: aggregate withdrawals AND build the recent list.
      const withdrawnByToken = new Map<string, bigint>();
      const recentWithdrawals: PlatformRevenueWithdrawal[] = [];
      for (const log of withdrawals) {
        const e = log as ethers.EventLog;
        const tokAddr = e.args.token as string;
        const tokLc = tokAddr.toLowerCase();
        const amount = e.args.amount as bigint;
        withdrawnByToken.set(tokLc, (withdrawnByToken.get(tokLc) ?? 0n) + amount);
        const meta = tokensByAddress.get(tokLc);
        if (!meta) continue;
        recentWithdrawals.push({
          token: tokAddr, symbol: meta.symbol, decimals: meta.decimals, amount,
          to: e.args.to as string,
          blockNumber: e.blockNumber,
          transactionIndex: e.transactionIndex,
          logIndex: e.index,
          txHash: e.transactionHash,
        });
      }
      // Newest first; tx + log indices break ties for events in the
      // same block so the order is deterministic across re-renders.
      recentWithdrawals.sort((a, b) =>
        b.blockNumber - a.blockNumber
        || b.transactionIndex - a.transactionIndex
        || b.logIndex - a.logIndex);

      // Per-token rows: keep tokens with either current balance or any
      // historical withdrawal so `accumulated + lifetimeWithdrawn` always
      // reconciles to lifetime DEX-side revenue. `relayer-claim-skim`
      // never lands in `platformRevenue[]`, so its totals stay in the
      // by-source view only.
      const rows: PlatformRevenueRow[] = [];
      tokens.forEach((t, i) => {
        const accRes = accumSettled[i];
        const accumulated = accRes.status === "fulfilled" ? (accRes.value as bigint) : 0n;
        const tokLc = t.address.toLowerCase();
        const withdrawn = withdrawnByToken.get(tokLc) ?? 0n;
        if (accumulated > 0n || withdrawn > 0n) {
          rows.push({
            token: t.address, symbol: t.symbol, decimals: t.decimals,
            accumulated, lifetimeWithdrawn: withdrawn,
          });
        }
      });

      if (loadIdRef.current === myId) {
        setData({
          treasury: treasuryRes as string | null,
          platformFeeBps: feeBpsRes != null ? Number(feeBpsRes) : null,
          rows, bySource,
          recentWithdrawals: recentWithdrawals.slice(0, RECENT_WITHDRAWAL_LIMIT),
          loading: false, error: null, fromBlock,
          partialFailures,
        });
      }
    } catch (e: unknown) {
      console.warn("[usePlatformRevenue] load failed:", e);
      if (loadIdRef.current === myId) {
        setData({
          treasury: null, platformFeeBps: null, rows: [], bySource: [],
          recentWithdrawals: [], loading: false,
          error: extractEthersErrorMessage(e, "Failed to load platform revenue"),
          fromBlock: null,
          partialFailures: [],
        });
      }
    }
    })();
    inFlightRef.current = p;
    p.finally(() => { inFlightRef.current = null; });
    return p;
  }, []);

  useEffect(() => {
    load();
    return () => { loadIdRef.current++; };
  }, [load]);

  return { ...data, refetch: load };
}
