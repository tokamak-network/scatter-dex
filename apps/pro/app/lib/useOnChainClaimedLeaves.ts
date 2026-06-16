import { useEffect, useMemo, useRef, useState } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { resolveSpentClaimLeaves } from "@zkscatter/sdk/claim";
import type { OrderClaim } from "./orders";
import { useActiveNetwork } from "./activeNetwork";

/** Resolves which recipient leaves are spent (claimed) on-chain and returns a
 *  `leafIndex → spent?` map.
 *
 *  Why this exists: the order drawer used to derive each recipient's
 *  "Claimed / Ready" badge from the order record's local `claimedLeafIndexes`
 *  array — but nothing keeps that array in sync with the chain, so the drawer
 *  drifted from the /claim page (which reads the on-chain nullifier directly).
 *
 *  Resolution goes through the shared SDK resolver: a single batch query to the
 *  claim-nullifier indexer (`/api/claim-nullifiers`) when one is configured,
 *  falling back to a direct `claimNullifiers` RPC probe otherwise. That keeps
 *  this off the public RPC's per-leaf path (429s) when the indexer is live.
 *
 *  One-shot per (claims, settlement, chain, indexer). The map holds only the
 *  confirmed-spent leaves (`true`); a leaf absent from the map is "not confirmed
 *  spent" — genuinely unclaimed, or the indexer is behind head / unavailable —
 *  so callers fall back to their optimistic local state via `get(...) ?? local`.
 *  Synthesising `false` for absent leaves would wrongly override that fallback. */
export function useOnChainClaimedLeaves(
  claims: ReadonlyArray<OrderClaim> | undefined,
  settlementAddress: string | undefined,
): Map<number, boolean> {
  const { readProvider } = useWallet();
  const { network } = useActiveNetwork();
  const [spent, setSpent] = useState<Map<number, boolean>>(() => new Map());

  // Read the latest `claims` from a ref inside the effect rather than
  // depending on the array itself — callers pass an unmemoized array, so
  // listing it as a dep would re-fire the sweep on every render. The
  // `probeKey` string below is what actually gates re-resolving.
  const claimsRef = useRef(claims);
  claimsRef.current = claims;

  // Stable identity for the resolve inputs so a re-render that doesn't change
  // the claims/settlement (e.g. the recipients table's 30s clock tick) doesn't
  // re-fire the resolve.
  const probeKey = useMemo(
    () =>
      `${settlementAddress ?? ""}|` +
      (claims ?? []).map((c) => `${c.leafIndex}:${c.secret}`).join(","),
    [claims, settlementAddress],
  );

  const sharedOrderbookUrl = network.sharedOrderbookUrl;
  const chainId = network.chainId;

  useEffect(() => {
    // Clear any prior order's result first: while the new resolve is in flight
    // the caller must fall back to *this* order's optimistic local state, not
    // show the previous order's spent leaves (leaf indices like 0/1 collide
    // across orders). Also covers wallet disconnect / network switch.
    setSpent(new Map());
    const currentClaims = claimsRef.current;
    if (
      !isConfiguredAddress(settlementAddress) ||
      !currentClaims ||
      currentClaims.length === 0
    ) {
      return;
    }
    // Nothing can answer without either an indexer or a provider.
    if (!sharedOrderbookUrl && !readProvider) return;
    let cancelled = false;
    (async () => {
      const spentSet = await resolveSpentClaimLeaves({
        entries: currentClaims.map((c) => ({ secret: c.secret, leafIndex: c.leafIndex })),
        chainId,
        settlementAddress,
        provider: readProvider ?? undefined,
        sharedOrderbookUrl,
      });
      if (cancelled) return;
      // Map the confirmed-spent leaves to `true` only. Absent leaves stay
      // absent so the consumer's `get(...) ?? local` falls back to optimistic
      // local state — the resolver can't assert "unspent" (an absent leaf may
      // just be behind the indexer, or unresolved when no provider answered).
      setSpent(new Map([...spentSet].map((leafIndex) => [leafIndex, true as const])));
    })();
    return () => {
      cancelled = true;
    };
    // probeKey captures claims + settlementAddress via claimsRef so the
    // unmemoized `claims` array isn't a dep (it would re-run every render);
    // provider, chain, and indexer URL are the other runtime inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey, readProvider, chainId, sharedOrderbookUrl]);

  return spent;
}
