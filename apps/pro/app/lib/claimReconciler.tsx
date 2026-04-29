"use client";

import { useMemo } from "react";
import {
  useClaimReconciler,
  type ClaimWatchKey,
} from "@zkscatter/sdk/react";
import { useOrders } from "./orders";
import { useActiveNetwork } from "./activeNetwork";

/** Watches `PrivateClaim` events on the active settlement contract
 *  and flips an order's status to `claimed` when its per-row
 *  nullifier matches. The hook walks `useOrders().orders` and
 *  builds the watch list from rows that carry a real
 *  `claim.claimsRoot` (seeded demo orders without it are skipped).
 *
 *  Settlements are not yet wired in Pro (orders complete via a
 *  demo timer), so the reconciler is a no-op until a real settle
 *  path lands; mounting it now means that flip is just a
 *  data-source change later, not a new code path. */
export function ClaimReconciler() {
  const { orders, markClaimed } = useOrders();
  const { network } = useActiveNetwork();
  const settlementAddress = network.contracts.privateSettlement;

  // `ordersKey` is a content hash that gates the SDK hook's
  // Poseidon rebuild. Includes only the fields that actually
  // change `watchKeys` membership — collapsing `status` to a
  // claimed/non-claimed bit so normal lifecycle transitions
  // (matching → claimable) don't churn re-Poseidon work the
  // watch set is invariant under.
  const ordersKey = useMemo(
    () =>
      orders
        .map(
          (o) =>
            `${o.id}:${o.status === "claimed" ? "C" : "U"}:${o.claim?.claimsRoot ?? ""}:${o.claim?.secret ?? ""}:${o.claim?.leafIndex ?? ""}`,
        )
        .join("|"),
    [orders],
  );
  const watchKeys = useMemo<ClaimWatchKey<string>[]>(() => {
    const out: ClaimWatchKey<string>[] = [];
    for (const o of orders) {
      if (o.status === "claimed") continue;
      if (!o.claim?.claimsRoot) continue;
      out.push({
        rowKey: o.id,
        secret: o.claim.secret,
        leafIndex: o.claim.leafIndex,
        claimsRoot: o.claim.claimsRoot,
      });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordersKey]);

  useClaimReconciler<string>({
    settlementAddress,
    watchKeys,
    label: "pro-claimReconciler",
    onClaimed: (orderId) => markClaimed(orderId),
  });

  return null;
}
