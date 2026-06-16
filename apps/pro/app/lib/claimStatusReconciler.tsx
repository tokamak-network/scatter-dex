"use client";

import { useEffect, useRef } from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { resolveSpentClaimLeaves } from "@zkscatter/sdk/claim";
import { useOrders, type OrderRecord } from "./orders";
import { useActiveNetwork } from "./activeNetwork";

/** How often to reconcile claim status against the chain/indexer. */
const POLL_INTERVAL_MS = 60_000;

/** Reconciles each claimable order's on-chain claim status into the local
 *  record so the My-orders list/tabs flip to "Claimed" without opening the
 *  drawer.
 *
 *  For every `claimable` order it resolves the recipient leaves NOT already
 *  recorded (`resolveSpentClaimLeaves`, indexer-first / RPC fallback) and
 *  records the confirmed-spent ones via `markLeavesClaimed`. Because that
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
        for (const o of ordersRef.current) {
          if (cancelled) return;
          if (o.status !== "claimable") continue;
          const claims =
            o.claims && o.claims.length > 0 ? o.claims : o.claim ? [o.claim] : [];
          if (claims.length === 0) continue;
          const cached = new Set(o.claimedLeafIndexes ?? []);
          const uncached = claims.filter((c) => !cached.has(c.leafIndex));
          if (uncached.length === 0) continue; // all recorded → never re-query

          let spent: Set<number>;
          try {
            spent = await resolveSpentClaimLeaves({
              entries: uncached.map((c) => ({ secret: c.secret, leafIndex: c.leafIndex })),
              chainId,
              settlementAddress,
              provider: readProvider ?? undefined,
              sharedOrderbookUrl,
            });
          } catch {
            continue; // transient resolve failure → leave the order for next tick
          }
          if (cancelled) return;
          if (spent.size > 0) markRef.current(o.id, [...spent]);
        }
      } catch (err) {
        // Belt-and-suspenders: the per-order resolve is already try/caught, but
        // a stray throw elsewhere in the pass (e.g. a markLeavesClaimed write)
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
