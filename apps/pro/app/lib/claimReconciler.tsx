"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  useClaimReconciler,
  type ClaimWatchKey,
} from "@zkscatter/sdk/react";
import { useOrders, type OrderRecord } from "./orders";
import { useVault } from "./vault";
import { useActiveNetwork } from "./activeNetwork";

/** Watches `PrivateClaim` events on the active settlement contract
 *  and flips an order's status to `claimed` when its per-row
 *  nullifier matches. The hook walks `useOrders().orders` and
 *  builds the watch list from rows that carry a real
 *  `claim.claimsRoot` (older orders without it are skipped).
 *
 *  Settlements are not yet wired in Pro (orders complete via a
 *  demo timer), so the reconciler is a no-op until a real settle
 *  path lands; mounting it now means that flip is just a
 *  data-source change later, not a new code path. */
export function ClaimReconciler() {
  const { orders, markClaimed } = useOrders();
  const { remove: vaultRemove } = useVault();
  const { network } = useActiveNetwork();
  const settlementAddress = network.contracts.privateSettlement;

  // When an order settles, the funding note's nullifier lands
  // on-chain alongside the PrivateClaim event — the note is now
  // unspendable. Drop it from the local vault so the panel
  // reflects the on-chain truth instead of carrying a zombie that
  // looks spendable but reverts at proof time.
  //
  // Read `orders` through a ref instead of listing it in the
  // useCallback deps: the SDK hook captures `onClaimed` into a
  // ref and reads it via `onClaimedRef.current`, but re-running
  // the deps array on every `orders` mutation would still churn
  // identity through the dependent effects. The ref keeps the
  // callback identity stable while still seeing the latest
  // orders list at fire time.
  const ordersRef = useRef<OrderRecord[]>(orders);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  const onClaimed = useCallback(
    (orderId: string) => {
      const order = ordersRef.current.find((o) => o.id === orderId);
      // Belt-and-suspenders: a cancelled order shouldn't be in
      // `watchKeys` (the filter below skips them), but a race
      // between mark{Claimed,Cancelled} and the SDK's subscription
      // teardown could fire `onClaimed` against a row the user
      // just cancelled. Refuse to wipe a vault note for an order
      // that's already moved out of the matching state.
      if (!order || order.status === "cancelled") return;
      markClaimed(orderId);
      if (order.noteId) {
        vaultRemove(order.noteId).catch((err) => {
          console.warn(`[claimReconciler] vault.remove(${order.noteId}) failed`, err);
        });
      }
    },
    [markClaimed, vaultRemove],
  );

  // `ordersKey` is a content hash that gates the SDK hook's
  // Poseidon rebuild. Includes only the fields that actually
  // change `watchKeys` membership — collapsing `status` to a
  // terminal/non-terminal bit so normal lifecycle transitions
  // (matching → claimable) don't churn re-Poseidon work the
  // watch set is invariant under. Both `claimed` and `cancelled`
  // are terminal — the watchKeys loop below drops both.
  const ordersKey = useMemo(
    () =>
      orders
        .map((o) => {
          const term = o.status === "claimed" || o.status === "cancelled" ? "T" : "U";
          return `${o.id}:${term}:${o.claim?.claimsRoot ?? ""}:${o.claim?.secret ?? ""}:${o.claim?.leafIndex ?? ""}`;
        })
        .join("|"),
    [orders],
  );
  const watchKeys = useMemo<ClaimWatchKey<string>[]>(() => {
    const out: ClaimWatchKey<string>[] = [];
    for (const o of orders) {
      // Skip terminal states — claimed (already removed from vault)
      // and cancelled (note was rotated by CancelOrderModal, the
      // original commitment is now nullified so any PrivateClaim
      // matching its old material would be spoofed/replayed).
      if (o.status === "claimed" || o.status === "cancelled") continue;
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
    onClaimed,
  });

  return null;
}
