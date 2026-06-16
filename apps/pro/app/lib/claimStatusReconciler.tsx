"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useWallet } from "@zkscatter/sdk/react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { resolveSpentClaimEntries } from "@zkscatter/sdk/claim";
import { useOrders, type OrderRecord } from "./orders";
import { useActiveNetwork } from "./activeNetwork";

/** How often to reconcile claim status against the chain/indexer. */
const POLL_INTERVAL_MS = 60_000;

interface ClaimStatusRefreshValue {
  /** Run one reconcile pass right now (the manual "Refresh" button). Resolves
   *  when the pass finishes; a no-op if one is already in flight. */
  refresh: () => Promise<void>;
  /** True while a manual refresh is running — for button spinner/disable. */
  refreshing: boolean;
}

const ClaimStatusRefreshContext = createContext<ClaimStatusRefreshValue | null>(null);

/** Reconciles each order's on-chain claim status into the local record so the
 *  My-orders list/tabs (and the open drawer) reflect reality without manual
 *  intervention. Runs automatically every {@link POLL_INTERVAL_MS}, and on
 *  demand via the {@link useClaimStatusRefresh} `refresh()` exposed to a
 *  Refresh button (a claim made elsewhere — a recipient's link — only lands in
 *  the local record on the next pass, so an immediate manual trigger avoids the
 *  up-to-60s wait).
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
 *  Mounted app-wide (wraps the page subtree); renders its children unchanged. */
export function ClaimStatusRefreshProvider({ children }: { children: ReactNode }): ReactNode {
  const { orders, reconcileClaimedLeaves } = useOrders();
  const { readProvider } = useWallet();
  const { network } = useActiveNetwork();
  const settlementAddress = network.contracts.privateSettlement;
  const chainId = network.chainId;
  const sharedOrderbookUrl = network.sharedOrderbookUrl;

  // Read the latest orders + writer through refs so `runPass` (and the polling
  // effect that depends on it) isn't rebuilt on every orders mutation — which
  // would reset the interval and re-fire a pass on each local edit.
  const ordersRef = useRef<OrderRecord[]>(orders);
  ordersRef.current = orders;
  const reconcileRef = useRef(reconcileClaimedLeaves);
  reconcileRef.current = reconcileClaimedLeaves;
  // `runningRef` serializes BACKGROUND passes only (two polls never overlap); a
  // manual refresh is allowed to run alongside a poll so it's never a silent
  // no-op while a slow indexer pass is in flight. `manualRunningRef` debounces
  // double-clicks of Refresh. `passSeqRef` is a monotonically-increasing pass
  // id: a pass abandons its writes if a newer pass has since started, so a slow
  // background (indexer) pass can't finish last and clobber a fast manual (RPC)
  // pass's fresh result — the newest read always wins. `cancelledRef` abandons
  // writes once the provider has unmounted.
  const runningRef = useRef(false);
  const manualRunningRef = useRef(false);
  const cancelledRef = useRef(false);
  const passSeqRef = useRef(0);
  const [refreshing, setRefreshing] = useState(false);

  // `direct` forces a chain RPC probe instead of the indexer. The 60s poll
  // uses the indexer (cheap, 429-safe), but a manual Refresh wants ground
  // truth NOW: the claim indexer deliberately trails head by a confirmation
  // margin + poll interval, so a just-made claim isn't visible there for a
  // minute or two. A direct `claimNullifiers` read reflects it the instant the
  // tx is mined. RPC-direct resolves `authoritative: false`, so the reconcile
  // is add-only (it can promote a just-claimed leaf but never demote on a
  // transient read failure) — exactly right for a manual "did my claim land?".
  const runPass = useCallback(async (direct = false): Promise<void> => {
    if (cancelledRef.current) return; // never run after teardown
    if (!direct && runningRef.current) return; // serialize background polls only
    // Nothing to resolve against without a settlement, and nothing can answer
    // without either an indexer or a provider.
    if (!isConfiguredAddress(settlementAddress)) return;
    if (!sharedOrderbookUrl && !readProvider) return;
    const seq = ++passSeqRef.current; // this pass's id; bail if a newer one starts
    if (!direct) runningRef.current = true;
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
      // Skip after teardown, when there's nothing to resolve, or once a newer
      // pass has superseded this one.
      if (entries.length === 0 || cancelledRef.current || seq < passSeqRef.current) return;

      let spent: Set<string>;
      let authoritative: boolean;
      try {
        ({ spent, authoritative } = await resolveSpentClaimEntries({
          entries,
          chainId,
          provider: readProvider ?? undefined,
          sharedOrderbookUrl,
          // Manual refresh wants chain ground truth now; the resolver still
          // falls back to the indexer if there's no provider to probe.
          preferProvider: direct,
        }));
      } catch {
        return; // transient resolve failure → leave it for the next pass
      }
      // A newer pass started while this one's request was in flight — discard
      // this (now possibly stale) result so a slow indexer pass can't clobber a
      // fast manual RPC pass that already wrote the fresh truth.
      if (cancelledRef.current || seq < passSeqRef.current) return;

      // Group the confirmed-spent leaves back by order.
      const spentByOrder = new Map<string, number[]>();
      for (const key of spent) {
        const ref = keyMap.get(key);
        if (!ref) continue;
        const list = spentByOrder.get(ref.orderId);
        if (list) list.push(ref.leafIndex);
        else spentByOrder.set(ref.orderId, [ref.leafIndex]);
      }
      // Reconcile EVERY processed order to its spent set — including those
      // that resolved to zero. When `authoritative` (indexer answered) this
      // can drop a stale leaf and heal a falsely-"claimed" order back to
      // claimable; otherwise (RPC fallback) it's add-only so a partial
      // failure can't demote a real claim. The order may have been
      // cancelled/removed while in flight, so re-check before writing.
      for (const orderId of processedOrders) {
        if (cancelledRef.current || seq < passSeqRef.current) return;
        const cur = ordersRef.current.find((o) => o.id === orderId);
        if (!cur || (cur.status !== "claimable" && cur.status !== "claimed")) continue;
        reconcileRef.current(orderId, spentByOrder.get(orderId) ?? [], authoritative);
      }
    } catch (err) {
      // Belt-and-suspenders: the batched resolve is already try/caught, but a
      // stray throw elsewhere in the pass (e.g. a reconcileClaimedLeaves write)
      // must not surface as an unhandled rejection from the `void runPass()`.
      console.warn("[ClaimStatusRefreshProvider] reconcile pass failed", err);
    } finally {
      if (!direct) runningRef.current = false;
    }
  }, [settlementAddress, chainId, sharedOrderbookUrl, readProvider]);

  const refresh = useCallback(async (): Promise<void> => {
    if (manualRunningRef.current) return; // debounce double-clicks
    manualRunningRef.current = true;
    setRefreshing(true);
    try {
      await runPass(true); // direct chain probe — don't wait on the indexer
    } finally {
      manualRunningRef.current = false;
      // Don't touch state if the provider unmounted mid-refresh.
      if (!cancelledRef.current) setRefreshing(false);
    }
  }, [runPass]);

  useEffect(() => {
    cancelledRef.current = false;
    void runPass();
    const id = setInterval(() => void runPass(), POLL_INTERVAL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [runPass]);

  const value = useMemo<ClaimStatusRefreshValue>(
    () => ({ refresh, refreshing }),
    [refresh, refreshing],
  );

  return (
    <ClaimStatusRefreshContext.Provider value={value}>
      {children}
    </ClaimStatusRefreshContext.Provider>
  );
}

/** Access the manual claim-status `refresh()` + `refreshing` flag. Returns a
 *  no-op fallback when used outside the provider so a stray consumer can't
 *  crash (the button just won't do anything). */
export function useClaimStatusRefresh(): ClaimStatusRefreshValue {
  return useContext(ClaimStatusRefreshContext) ?? NOOP_REFRESH;
}

const NOOP_REFRESH: ClaimStatusRefreshValue = {
  refresh: async () => {},
  refreshing: false,
};
