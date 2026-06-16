"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { resolveSpentClaimEntries } from "@zkscatter/sdk/claim";
import { useOrders, type OrderRecord } from "./orders";
import { useActiveNetwork } from "./activeNetwork";

/** How often to reconcile claim status against the chain/indexer. */
const POLL_INTERVAL_MS = 60_000;

/** Reconciles each claimable order's on-chain claim status into the local
 *  record so the My-orders list/tabs flip to "Claimed" without opening the
 *  drawer.
 *
 *  It collects the recipient leaves NOT already recorded across ALL claimable
 *  orders and resolves them in one batch (`resolveSpentClaimEntries`,
 *  indexer-first / RPC fallback), then records the confirmed-spent ones per
 *  order via `markLeavesClaimed`. Because that
 *  promotes the order to `claimed` once every leaf is recorded, this is what
 *  drives the list/tab transition. Already-recorded leaves are skipped each
 *  pass, and an order with every leaf recorded is skipped entirely, so a
 *  confirmed leaf is never re-queried — keeping the public RPC / indexer load
 *  minimal.
 *
 *  Mounted app-wide (next to `ClaimReconciler`); renders nothing. */
export function ClaimStatusReconciler(): null {
  const { orders, markLeavesClaimed } = useOrders();
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
  const markRef = useRef(markLeavesClaimed);
  markRef.current = markLeavesClaimed;

  useEffect(() => {
    // Nothing to resolve against without a settlement, and nothing can answer
    // without either an indexer or a provider.
    if (!isConfiguredAddress(settlementAddress)) return;
    if (!sharedOrderbookUrl && !readProvider) return;

    let cancelled = false;
    let running = false;
    const tick = async (): Promise<void> => {
      if (running) return; // don't overlap a slow pass
      running = true;
      try {
        // Collect every not-yet-recorded leaf across all claimable orders into
        // ONE batch, so the indexer resolves the whole set in a single (paged)
        // request instead of one per order. An opaque key maps each entry back
        // to its (order, leaf).
        const entries: {
          key: string;
          secret: bigint;
          leafIndex: number;
          settlementAddress: string;
        }[] = [];
        const keyMap = new Map<string, { orderId: string; leafIndex: number }>();
        for (const o of ordersRef.current) {
          if (o.status !== "claimable") continue;
          const claims =
            o.claims && o.claims.length > 0 ? o.claims : o.claim ? [o.claim] : [];
          if (claims.length === 0) continue;
          const cached = new Set(o.claimedLeafIndexes ?? []);
          for (const c of claims) {
            if (cached.has(c.leafIndex)) continue; // already recorded → never re-query
            const key = String(entries.length);
            keyMap.set(key, { orderId: o.id, leafIndex: c.leafIndex });
            entries.push({ key, secret: c.secret, leafIndex: c.leafIndex, settlementAddress });
          }
        }
        if (entries.length === 0) return;

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
        if (cancelled || spentKeys.size === 0) return;

        // Group the confirmed-spent leaves back by order, then record each
        // order once (markLeavesClaimed promotes to `claimed` when all are in).
        const byOrder = new Map<string, number[]>();
        for (const key of spentKeys) {
          const ref = keyMap.get(key);
          if (!ref) continue;
          const list = byOrder.get(ref.orderId);
          if (list) list.push(ref.leafIndex);
          else byOrder.set(ref.orderId, [ref.leafIndex]);
        }
        for (const [orderId, leaves] of byOrder) {
          if (cancelled) return;
          markRef.current(orderId, leaves);
        }
      } catch (err) {
        // Belt-and-suspenders: the batched resolve is already try/caught, but a
        // stray throw elsewhere in the pass (e.g. a markLeavesClaimed write)
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
