"use client";

import { useEffect, useRef } from "react";
import { computeNullifier } from "@zkscatter/sdk/zk";
import { RelayerClient } from "@zkscatter/sdk/relayer";
import { useOrders, type OrderRecord } from "./orders";
import { useVault } from "./vault";

/** Poll cadence for the settle reconciler. 15s is fast enough that
 *  a relayer that settles within a few seconds shows up before the
 *  user notices the My-orders row is stale, but slow enough that an
 *  idle tab with no matching orders doesn't burn requests. */
const POLL_INTERVAL_MS = 15_000;

/** Watches `matching` orders and promotes them to `claimable` when
 *  the binding relayer reports `status=settled`. The earlier shape
 *  left orders pinned at "Matching" indefinitely after on-chain
 *  settle because nothing on the Pro side observed the
 *  `PrivateSettledAuth` event — the My-orders row, the escrow
 *  Recoverable badge, and the Shared OB row all read stale in
 *  lock-step. This reconciler is the bridge.
 *
 *  Design choice: relayer polling rather than an on-chain event
 *  subscription. The relayer already indexes the settle tx, exposes
 *  status via `GET /api/authorize-orders/:nullifier`, and Pro
 *  doesn't have a readProvider scoped to the settlement contract on
 *  every page. One per-relayer fetch per cycle (deduped below) keeps
 *  the surface tight while we ship; a `useSettlementReconciler` SDK
 *  hook can land later if direct-chain reads become preferable.
 *
 *  No-op when there are zero matching orders so the page can mount
 *  the component unconditionally without burning a poll on idle
 *  vaults. */
export function SettleReconciler() {
  const { orders, markClaimable } = useOrders();
  const { notes, remove: removeNote } = useVault();
  // Snapshot in refs so the polling loop reads the latest list at
  // fire time without listing them in the effect deps (which would
  // re-mount the interval on every order/vault mutation).
  const ordersRef = useRef(orders);
  const notesRef = useRef(notes);
  const markClaimableRef = useRef(markClaimable);
  const removeNoteRef = useRef(removeNote);
  useEffect(() => { ordersRef.current = orders; }, [orders]);
  useEffect(() => { notesRef.current = notes; }, [notes]);
  useEffect(() => { markClaimableRef.current = markClaimable; }, [markClaimable]);
  useEffect(() => { removeNoteRef.current = removeNote; }, [removeNote]);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const matching = ordersRef.current.filter(isPollable);
      if (matching.length === 0) return;
      // Resolve each order's funding-note nullifier in parallel. A
      // missing note (vault out of sync / order pre-dates a note-
      // schema migration) silently skips — we'd rather poll fewer
      // orders this cycle than throw and stall the whole loop.
      const lookups = await Promise.all(
        matching.map(async (o): Promise<{ order: OrderRecord; nullifier: string } | null> => {
          if (!o.noteId || !o.relayer?.url) return null;
          const note = notesRef.current.find((n) => n.id === o.noteId);
          if (!note) return null;
          try {
            const n = await computeNullifier(note.note);
            return { order: o, nullifier: n.toString() };
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      // Group by relayer URL so each relayer sees one client / one
      // session token across the per-order pollAuthorizeOrder calls.
      const byRelayer = new Map<string, Array<{ order: OrderRecord; nullifier: string }>>();
      for (const r of lookups) {
        if (!r) continue;
        const url = r.order.relayer!.url!;
        const bucket = byRelayer.get(url) ?? [];
        bucket.push(r);
        byRelayer.set(url, bucket);
      }
      await Promise.all(
        [...byRelayer.entries()].map(async ([url, rows]) => {
          const client = new RelayerClient(url, { timeoutMs: 4000 });
          await Promise.all(
            rows.map(async ({ order, nullifier }) => {
              try {
                const status = await client.pollAuthorizeOrder(nullifier);
                if (cancelled) return;
                if (status.status === "settled" && status.settleTxHash) {
                  markClaimableRef.current(order.id, status.settleTxHash);
                  // The funding note's nullifier is now burned on-
                  // chain — drop it from the vault so the escrow
                  // page stops flagging it as Locked. The note's id
                  // is on the OrderRecord; the change leaf will be
                  // picked up by the commitment indexer separately.
                  if (order.noteId) {
                    removeNoteRef.current(order.noteId).catch((err) => {
                      console.warn("Settle reconciler: vault.remove failed", err);
                    });
                  }
                }
              } catch {
                // Per-order failure (4xx, timeout) is non-fatal —
                // the next tick will retry. No log: a noisy steady-
                // state would spam the console for any expired-
                // matching order whose relayer 404s.
              }
            }),
          );
        }),
      );
    };
    tick();
    const id = setInterval(tick, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return null;
}

/** Only `matching` orders that carry a real relayer URL + noteId are
 *  pollable. The simulated path (no relayer.url) won't settle on-
 *  chain, so polling it would 404 forever. URL must also parse to
 *  an http(s) endpoint — a hand-edited workspace file containing
 *  a `file:` / `javascript:` URL would otherwise be handed straight
 *  to `fetch` and could leak local files or trigger CSP-bypass
 *  behaviour in unusual host setups. Defense-in-depth per the
 *  cross-PR explorer-URL safety pattern (Gemini security-medium). */
function isPollable(o: OrderRecord): boolean {
  if (o.status !== "matching" || !o.noteId || !o.relayer?.url) return false;
  try {
    const url = new URL(o.relayer.url);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
