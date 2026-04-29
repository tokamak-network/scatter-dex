"use client";

import { useEffect, useMemo, useRef } from "react";
import { ethers } from "ethers";
import { useWallet } from "@zkscatter/sdk/react";
import { PRIVATE_SETTLEMENT_IFACE } from "@zkscatter/sdk";
import { computeClaimNullifier, toBytes32Hex } from "@zkscatter/sdk/zk";
import { decodeClaimPackage } from "@zkscatter/sdk/notes";
import type {
  ClaimedRecipientInput,
  RunRecord,
} from "@zkscatter/sdk/storage";

interface ClaimReconcilerProps {
  record: RunRecord;
  settlementAddress: string;
  /** Receives the rows matched from `PrivateClaim` events. Persists
   *  via the run-record store; the reconciler doesn't carry its own
   *  side-effects. */
  markClaimed(entries: ClaimedRecipientInput[]): Promise<number>;
}

/** Coerce a bigint or hex string to a normalised lowercase 0x bytes32
 *  for topic comparison. Centralises the toBytes32Hex/String/lower
 *  trio that's otherwise repeated 6× in this file. */
function topicHex(v: bigint | string): string {
  return (typeof v === "bigint" ? toBytes32Hex(v) : String(v)).toLowerCase();
}

interface RowKey {
  rowIndex: number;
  /** Bytes32 hex (lowercase) the contract emits as the second indexed
   *  topic of `PrivateClaim`. Pre-computed so each event can be
   *  matched in O(1) without rebuilding Poseidon for every row. */
  nullifierHex: string;
  /** Bytes32 hex of the claimsRoot the row was settled under. The
   *  same RunRecord can host packages from different settlements
   *  (multi-batch in Phase 1d), so we filter by the package's root. */
  claimsRootHex: string;
}

/** Watches `PrivateClaim` events on the settlement contract and
 *  stamps `status: "claimed"` on RunRecord rows whose pre-computed
 *  nullifier matches an emitted log. Subscribes for live events
 *  AND queries history once on mount so a page revisit picks up
 *  claims that completed before the user opened the dashboard.
 *
 *  Pure side-effect component (returns null); persistence lives in
 *  `markClaimedBatch`. The reconciler's only state is the
 *  pre-computed row keys, kept in a ref so resubscribes don't
 *  rebuild Poseidon every render. */
export function ClaimReconciler({
  record,
  settlementAddress,
  markClaimed,
}: ClaimReconcilerProps) {
  const { readProvider } = useWallet();
  const recordRef = useRef(record);
  useEffect(() => {
    recordRef.current = record;
  }, [record]);

  // Decode + pre-compute (rowIndex, nullifierHex, claimsRootHex) for
  // every row that has a claimPackage AND isn't already claimed.
  // Recomputed when the record's recipient list shape changes
  // (string equality on the encoded packages catches both content
  // changes and array-length swaps).
  const keysVersion = record.recipients
    .map((r) => `${r.rowIndex}:${r.status}:${r.claimPackage ?? ""}`)
    .join("|");
  const rowKeysPromise = useMemo(() => {
    return Promise.all(
      record.recipients.map(async (r): Promise<RowKey | null> => {
        if (r.status === "claimed") return null;
        if (!r.claimPackage) return null;
        try {
          const pkg = decodeClaimPackage(r.claimPackage);
          const nullifier = await computeClaimNullifier(
            BigInt(pkg.secret),
            BigInt(pkg.leafIndex),
          );
          return {
            rowIndex: r.rowIndex,
            nullifierHex: topicHex(nullifier),
            claimsRootHex: topicHex(pkg.claimsRoot),
          };
        } catch {
          // Malformed package on this row — operator can't claim
          // it on the user's behalf, so skip rather than fail the
          // whole reconciler.
          return null;
        }
      }),
    ).then((keys) => keys.filter((k): k is RowKey => k !== null));
  }, [keysVersion]);

  useEffect(() => {
    if (!ethers.isAddress(settlementAddress) || settlementAddress === ethers.ZeroAddress) {
      return;
    }
    let cancelled = false;
    const contract = new ethers.Contract(
      settlementAddress,
      PRIVATE_SETTLEMENT_IFACE,
      readProvider,
    );

    void (async () => {
      const keys = await rowKeysPromise;
      if (cancelled || keys.length === 0) return;
      // Map nullifier → rowIndex (claimsRoot is also part of the
      // event topic but the nullifier is unique-by-recipient and
      // sufficient for a hit; the claimsRoot check below guards
      // against a wildly-misencoded package matching some other
      // run's claim event).
      const byNullifier = new Map<string, RowKey>();
      for (const k of keys) byNullifier.set(k.nullifierHex, k);

      const matchEvent = (
        claimsRoot: string | bigint,
        nullifier: string | bigint,
      ): RowKey | null => {
        const k = byNullifier.get(topicHex(nullifier));
        if (!k) return null;
        if (k.claimsRootHex !== topicHex(claimsRoot)) return null;
        return k;
      };

      // Historical sweep so a refresh / first-open catches claims
      // that fired while the page was closed. Bound the scan to the
      // settle tx's block — without this, queryFilter scans from
      // genesis and most public RPC endpoints (Alchemy / Infura) cap
      // at 10k blocks. Resolves the run's settle txHash to its
      // block number once; falls back to the last 50k blocks when
      // the receipt lookup fails (zero-hash placeholder, RPC blip).
      const claimsRoots = Array.from(new Set(keys.map((k) => k.claimsRootHex)));
      try {
        const fromBlock = await resolveFromBlock(
          readProvider,
          recordRef.current.txHash,
        );
        const history = await contract.queryFilter(
          contract.filters.PrivateClaim(claimsRoots),
          fromBlock,
        );
        if (cancelled) return;
        const now = Math.floor(Date.now() / 1000);
        const matches: ClaimedRecipientInput[] = [];
        for (const ev of history) {
          if (!(ev instanceof ethers.EventLog)) continue;
          const k = matchEvent(
            ev.args.claimsRoot as string,
            ev.args.nullifier as string,
          );
          if (!k) continue;
          // Block timestamp would be more accurate but requires a
          // separate getBlock RPC per event. Settle for `now` —
          // the operator UI rounds to "Xh ago" granularity anyway.
          matches.push({ rowIndex: k.rowIndex, claimedAt: now });
        }
        if (matches.length > 0) await markClaimed(matches);
      } catch (err) {
        console.warn("[claimReconciler] historical query failed:", err);
      }
    })();

    // Live subscription — fires for any future claim against this
    // settlement, then we filter against our key set in the handler.
    const handler = (
      claimsRoot: unknown,
      nullifier: unknown,
    ) => {
      void (async () => {
        const keys = await rowKeysPromise;
        const byNullifier = new Map<string, RowKey>();
        for (const k of keys) byNullifier.set(k.nullifierHex, k);
        const k = byNullifier.get(topicHex(nullifier as string | bigint));
        if (!k) return;
        if (k.claimsRootHex !== topicHex(claimsRoot as string | bigint)) return;
        const now = Math.floor(Date.now() / 1000);
        await markClaimed([{ rowIndex: k.rowIndex, claimedAt: now }]);
      })();
    };
    const filter = contract.filters.PrivateClaim();
    contract.on(filter, handler);

    return () => {
      cancelled = true;
      contract.off(filter, handler);
    };
  }, [settlementAddress, readProvider, rowKeysPromise, markClaimed]);

  return null;
}

/** Resolve `fromBlock` for the historical PrivateClaim queryFilter:
 *  prefer the actual block of the run's settle tx, fall back to a
 *  bounded "recent" window when that's unavailable. Without a bound
 *  ethers scans from block 0, which most public RPCs reject above
 *  ~10k blocks. */
async function resolveFromBlock(
  readProvider: ethers.Provider,
  settleTxHash: string,
): Promise<number> {
  // Sentinel zero-hash from the env-not-configured demo path —
  // there's no real settle to anchor to.
  if (!settleTxHash || /^0x0+$/.test(settleTxHash)) {
    return fallbackRecentBlock(readProvider);
  }
  try {
    const receipt = await readProvider.getTransactionReceipt(settleTxHash);
    if (receipt && typeof receipt.blockNumber === "number") {
      return receipt.blockNumber;
    }
  } catch {
    /* fall through */
  }
  return fallbackRecentBlock(readProvider);
}

async function fallbackRecentBlock(readProvider: ethers.Provider): Promise<number> {
  // ~7 days at 12s blocks. Big enough to catch a recent claim on a
  // testnet, small enough to satisfy public RPC log-range caps
  // (Alchemy / Infura cap at 10k–50k blocks per query).
  const RECENT_WINDOW = 50_000;
  try {
    const head = await readProvider.getBlockNumber();
    return Math.max(0, head - RECENT_WINDOW);
  } catch {
    return 0;
  }
}
