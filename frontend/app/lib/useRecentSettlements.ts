"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ethers } from "ethers";
import { getReadProvider, getSafeFromBlock } from "./provider";
import { getPrivateSettlementAddress } from "./config";
import { PRIVATE_SETTLEMENT_ABI } from "./contracts";

export type SettlementPath = "p2p" | "dex";

export interface SettlementRow {
  path: SettlementPath;
  txHash: string;
  blockNumber: number;
  /** Position of the tx within the block; used for stable ordering
   *  when multiple settlements land in the same block. */
  transactionIndex: number;
  /** Position of the log within the tx; needed as a React key and as
   *  a secondary sort key when a tx emits multiple settlement logs. */
  logIndex: number;
  /** seconds since epoch; undefined until the block header is fetched */
  timestamp?: number;
  /** P2P: makerRelayer. DEX: submitter. */
  participant: string;
  /** DEX only. */
  sellToken?: string;
  buyToken?: string;
  sellAmount?: bigint;
  amountOut?: bigint;
  /** P2P only. Maker + taker fees (same token = buy token, so not annotated here). */
  feeTokenMaker?: bigint;
  feeTokenTaker?: bigint;
}

export interface UseRecentSettlementsResult {
  rows: SettlementRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

// The settlement contract doesn't emit a token pair on PrivateSettledAuth
// (would require tx calldata decode), so P2P rows land without sellToken /
// buyToken. DEX rows carry all fields. The UI handles the asymmetry.

// Block timestamps are immutable — cache across refreshes so repeated
// "Refresh" clicks only fetch headers for blocks we haven't seen yet.
const tsCache = new Map<number, number>();

export function useRecentSettlements(limit: number = 100): UseRecentSettlementsResult {
  const [rows, setRows] = useState<SettlementRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Trivial ID — incrementing triggers the effect below without relying on
  // a boolean flag that could miss back-to-back refreshes.
  const [tick, setTick] = useState(0);
  // Per-run token: each effect increments `loadIdRef` and captures the new
  // value locally. State updates only commit when the captured value is
  // still current. A shared cancellation boolean is racy across rapid
  // refreshes — the cleanup flip gets stomped by the next effect's reset.
  const loadIdRef = useRef(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const runId = ++loadIdRef.current;
    setLoading(true);
    setError(null);

    (async () => {
      try {
        const provider = getReadProvider();
        const contract = new ethers.Contract(
          getPrivateSettlementAddress(),
          PRIVATE_SETTLEMENT_ABI,
          provider,
        );
        const fromBlock = await getSafeFromBlock(provider);

        // Both event queries run in parallel; the contract serializes them
        // internally anyway, but we save a round-trip on the RPC side.
        const [authLogs, dexLogs] = await Promise.all([
          contract.queryFilter(contract.filters.PrivateSettledAuth(), fromBlock),
          contract.queryFilter(contract.filters.SettledWithDex(), fromBlock),
        ]);

        const merged: SettlementRow[] = [];
        for (const log of authLogs) {
          const e = log as ethers.EventLog;
          merged.push({
            path: "p2p",
            txHash: e.transactionHash,
            blockNumber: e.blockNumber,
            transactionIndex: e.transactionIndex,
            logIndex: e.index,
            participant: String(e.args.makerRelayer),
            feeTokenMaker: BigInt(e.args.feeTokenMaker),
            feeTokenTaker: BigInt(e.args.feeTokenTaker),
          });
        }
        for (const log of dexLogs) {
          const e = log as ethers.EventLog;
          merged.push({
            path: "dex",
            txHash: e.transactionHash,
            blockNumber: e.blockNumber,
            transactionIndex: e.transactionIndex,
            logIndex: e.index,
            participant: String(e.args.submitter),
            sellToken: String(e.args.sellToken),
            buyToken: String(e.args.buyToken),
            sellAmount: BigInt(e.args.sellAmount),
            amountOut: BigInt(e.args.amountOut),
          });
        }

        // (block, tx, log) descending — stable across ties so refresh
        // doesn't shuffle same-block events.
        merged.sort((a, b) =>
          b.blockNumber - a.blockNumber
          || b.transactionIndex - a.transactionIndex
          || b.logIndex - a.logIndex
        );
        const trimmed = merged.slice(0, limit);

        // Block timestamps are fetched only for the trimmed set so the cost
        // scales with `limit`, not with every historical event. Cache hits
        // short-circuit the RPC entirely. `allSettled` keeps a single
        // pruned / flaky node from nuking the whole page — timestamps are
        // UI polish, not load-bearing.
        const uniqueBlocks = Array.from(new Set(trimmed.map((r) => r.blockNumber)));
        const toFetch = uniqueBlocks.filter((n) => !tsCache.has(n));
        const fetched = await Promise.allSettled(toFetch.map((n) => provider.getBlock(n)));
        for (const r of fetched) {
          if (r.status === "fulfilled" && r.value) {
            tsCache.set(r.value.number, Number(r.value.timestamp));
          }
        }
        for (const r of trimmed) r.timestamp = tsCache.get(r.blockNumber);

        if (runId === loadIdRef.current) setRows(trimmed);
      } catch (e) {
        if (runId === loadIdRef.current) {
          console.error("useRecentSettlements: failed to fetch events:", e);
          const err = e as { shortMessage?: string; reason?: string; message?: string };
          setError(err?.shortMessage || err?.reason || err?.message || "Failed to load settlements");
        }
      } finally {
        if (runId === loadIdRef.current) setLoading(false);
      }
    })();
  }, [limit, tick]);

  return { rows, loading, error, refresh };
}
