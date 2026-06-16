import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import type { OrderClaim } from "./orders";
import { isClaimNullifierSpentOn, settlementReader } from "./claimProbe";

/** Probes the on-chain nullifier for each recipient leaf and returns
 *  a `leafIndex → spent?` map of the leaves the chain has confirmed.
 *
 *  Why this exists: the order drawer used to derive each recipient's
 *  "Claimed / Ready" badge from the order record's local
 *  `claimedLeafIndexes` array — but nothing keeps that array in sync
 *  with the chain (the gasless claim + /claim page only write to the
 *  Claims inbox). So the drawer drifted from the /claim page, which
 *  reads `settlement.claimNullifiers` directly: a leaf claimed elsewhere
 *  showed "Ready", and a stale local entry showed "Claimed" for a leaf
 *  that was never actually spent. This probes the same on-chain source
 *  the /claim page trusts, so the two surfaces agree.
 *
 *  One-shot per (claims, settlement, provider) — matches the /claim
 *  page's single mount-time probe and avoids hammering the RPC (a
 *  concern given public-node 429s). Only resolved leaves appear in the
 *  map; a leaf whose probe errored or hasn't returned is simply absent,
 *  so callers fall back to their optimistic local state for it. */
export function useOnChainClaimedLeaves(
  claims: ReadonlyArray<OrderClaim> | undefined,
  settlementAddress: string | undefined,
): Map<number, boolean> {
  const { readProvider } = useWallet();
  const [spent, setSpent] = useState<Map<number, boolean>>(() => new Map());

  // Stable identity for the probe inputs so a re-render that doesn't
  // change the claims/settlement (e.g. the table's 30s clock tick)
  // doesn't re-fire the RPC sweep.
  const probeKey = useMemo(
    () =>
      `${settlementAddress ?? ""}|` +
      (claims ?? []).map((c) => `${c.leafIndex}:${c.secret}`).join(","),
    [claims, settlementAddress],
  );

  useEffect(() => {
    if (!readProvider || !settlementAddress || !claims || claims.length === 0) {
      return;
    }
    let cancelled = false;
    (async () => {
      // One contract for the whole sweep; the per-leaf calls still batch
      // into a single RPC round-trip under ethers' auto-batching.
      const settlement = settlementReader(readProvider, settlementAddress);
      const results = await Promise.all(
        claims.map(async (c) => {
          try {
            const isSpent = await isClaimNullifierSpentOn(
              settlement,
              c.secret,
              c.leafIndex,
            );
            return [c.leafIndex, isSpent] as const;
          } catch {
            // Per-leaf probe failure → omit; caller keeps optimistic state.
            return null;
          }
        }),
      );
      if (cancelled) return;
      setSpent(
        new Map(results.filter((r): r is readonly [number, boolean] => r !== null)),
      );
    })();
    return () => {
      cancelled = true;
    };
    // probeKey captures claims + settlementAddress; readProvider is the
    // other input. Listing the raw arrays would re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey, readProvider]);

  return spent;
}
