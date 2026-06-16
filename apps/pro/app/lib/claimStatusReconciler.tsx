"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { resolveSpentClaimEntries } from "@zkscatter/sdk/claim";
import { useOrders, type OrderRecord } from "./orders";
import { useActiveNetwork } from "./activeNetwork";

/** How often to reconcile claim status against the chain/indexer. */
const POLL_INTERVAL_MS = 60_000;

/** Reconciles each order's on-chain claim status into the local record so the
 *  My-orders list/tabs reflect reality without opening the drawer.
 *
 *  Each pass collects EVERY recipient leaf of every non-terminal order with
 *  claims (status `claimable` or `claimed`) and resolves them in one batch
 *  (`resolveSpentClaimEntries`, indexer-first / RPC fallback). It then
 *  reconciles each order to the chain's authoritative confirmed-spent set via
 *  `reconcileClaimedLeaves` — which both promotes an order to `claimed` once
 *  every leaf is spent AND self-heals a stale/wrong `claimedLeafIndexes` (a
 *  leaf an older build wrongly recorded gets dropped, demoting a falsely
 *  "claimed" order back to `claimable`).
 *
 *  It re-queries all leaves each pass (not just uncached) precisely so it can
 *  detect-and-correct stale data; the indexer answers the whole set in one
 *  batched request, so the load stays low. `matching` (pre-settle) and
 *  `cancelled` orders are skipped entirely.
 *
 *  Mounted app-wide (next to `ClaimReconciler`); renders nothing. */
export function ClaimStatusReconciler(): null {
  const { orders, reconcileClaimedLeaves } = useOrders();
  const { readProvider } = useWallet();
  const { network } = useActiveNetwork();
  const settlementAddress = network.contracts.privateSettlement;
  const chainId = network.chainId;
  const sharedOrderbookUrl = network.sharedOrderbookUrl;

  // Read the latest orders + writer through refs so the polling effect isn't
  // torn down and rebuilt on every orders mutation (which would reset the
  // interval and re-fire a pass on each local edit).
  const ordersRef = useRef<OrderRecord[]>(orders);
  ordersRef.current = orders;
  const reconcileRef = useRef(reconcileClaimedLeaves);
  reconcileRef.current = reconcileClaimedLeaves;

  useEffect(() => {
    // Nothing to resolve against without a settlement, and nothing can answer
    // without either an indexer or a provider.
    if (!isConfiguredAddress(settlementAddress)) return;
    if (!sharedOrderbookUrl && !readProvider) return;

    let cancelled = false;
    let running = false;
    const tick = async (): Promise<void> => {
      if (running || cancelled) return; // don't overlap a slow pass / run after teardown
      running = true;
      try {
        // Collect EVERY leaf of every non-terminal order with claims into ONE
        // batch (not just uncached — re-querying is how stale data is detected
        // and healed). The indexer answers the whole set in one paged request.
        // An opaque key maps each entry back to its (order, leaf).
        const entries: {
          key: string;
          secret: bigint;
          leafIndex: number;
          settlementAddress: string;
        }[] = [];
        const keyMap = new Map<string, { orderId: string; leafIndex: number }>();
        const processedOrders = new Set<string>();
        for (const o of ordersRef.current) {
          if (o.status !== "claimable" && o.status !== "claimed") continue;
          const claims =
            o.claims && o.claims.length > 0 ? o.claims : o.claim ? [o.claim] : [];
          if (claims.length === 0) continue;
          processedOrders.add(o.id);
          for (const c of claims) {
            const key = String(entries.length);
            keyMap.set(key, { orderId: o.id, leafIndex: c.leafIndex });
            entries.push({ key, secret: c.secret, leafIndex: c.leafIndex, settlementAddress });
          }
        }
        if (entries.length === 0 || cancelled) return; // skip the request after teardown

        let spentKeys: Set<string>;
        try {
          spentKeys = await resolveSpentClaimEntries({
            entries,
            chainId,
            provider: readProvider ?? undefined,
            sharedOrderbookUrl,
          });
        } catch {
          return; // transient resolve failure → leave it for the next tick
        }
        if (cancelled) return;

        // Group the confirmed-spent leaves back by order.
        const spentByOrder = new Map<string, number[]>();
        for (const key of spentKeys) {
          const ref = keyMap.get(key);
          if (!ref) continue;
          const list = spentByOrder.get(ref.orderId);
          if (list) list.push(ref.leafIndex);
          else spentByOrder.set(ref.orderId, [ref.leafIndex]);
        }
        // Reconcile EVERY processed order to its authoritative spent set —
        // including those that resolved to zero (so a falsely-"claimed" order
        // with nothing actually spent is healed back to claimable). The order
        // may have been cancelled/removed while in flight, so re-check it's
        // still reconcilable before writing.
        for (const orderId of processedOrders) {
          if (cancelled) return;
          const cur = ordersRef.current.find((o) => o.id === orderId);
          if (!cur || (cur.status !== "claimable" && cur.status !== "claimed")) continue;
          reconcileRef.current(orderId, spentByOrder.get(orderId) ?? []);
        }
      } catch (err) {
        // Belt-and-suspenders: the batched resolve is already try/caught, but a
        // stray throw elsewhere in the pass (e.g. a reconcileClaimedLeaves write)
        // must not surface as an unhandled rejection from the `void tick()`.
        console.warn("[ClaimStatusReconciler] reconcile pass failed", err);
      } finally {
        running = false;
      }
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [settlementAddress, chainId, sharedOrderbookUrl, readProvider]);

  return null;
}
