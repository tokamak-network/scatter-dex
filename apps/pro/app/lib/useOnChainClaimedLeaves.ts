import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { isConfiguredAddress } from "@zkscatter/sdk";
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

  // Read the latest `claims` from a ref inside the effect rather than
  // depending on the array itself — callers pass an unmemoized array, so
  // listing it as a dep would re-fire the sweep on every render. The
  // `probeKey` string below is what actually gates re-probing.
  const claimsRef = useRef(claims);
  claimsRef.current = claims;

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
    // Clear any prior order's result first: while the new probe is in
    // flight the caller must fall back to *this* order's optimistic local
    // state, not show the previous order's spent leaves (leaf indices like
    // 0/1 collide across orders). Also covers wallet disconnect / network
    // switch / unconfigured settlement, where there's nothing to probe.
    setSpent(new Map());
    const currentClaims = claimsRef.current;
    if (
      !readProvider ||
      !isConfiguredAddress(settlementAddress) ||
      !currentClaims ||
      currentClaims.length === 0
    ) {
      return;
    }
    let cancelled = false;
    (async () => {
      // One contract for the whole sweep; the per-leaf calls still batch
      // into a single RPC round-trip under ethers' auto-batching.
      const settlement = settlementReader(readProvider, settlementAddress);
      const results = await Promise.all(
        currentClaims.map(async (c) => {
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
    // probeKey captures claims + settlementAddress (read via claimsRef);
    // readProvider is the other input. Listing the raw array would re-run
    // on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey, readProvider]);

  return spent;
}
