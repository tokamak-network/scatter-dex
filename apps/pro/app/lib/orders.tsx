"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { bigintToHex, openIDB } from "@zkscatter/sdk/util";
import { useActiveNetwork } from "./activeNetwork";
import { newId } from "./newId";

export type OrderStatus = "matching" | "claimable" | "claimed" | "cancelled";

/** Claim material captured at order-submit time so the user can
 *  release their proceeds later via the claim flow. Phase 5 will
 *  read this from on-chain settlement events instead of carrying
 *  it client-side. */
export interface OrderClaim {
  secret: bigint;
  recipient: string;
  /** Token address as 0x-prefixed hex. */
  token: string;
  amount: bigint;
  /** Unix-seconds release time the order set. */
  releaseTime: bigint;
  /** Index of this claim in the settlement's claims tree (0 for
   *  the demo's single-claim distribution). */
  leafIndex: number;
  /** Bytes32 hex of the claims-tree root the order was settled
   *  under. The reconciler uses this together with `secret` and
   *  `leafIndex` to compute the per-row nullifier and match against
   *  on-chain `PrivateClaim` events. Optional because seeded demo
   *  rows don't carry it. */
  claimsRoot?: string;
}

/** A submitted private limit order. Persisted per-chain in
 *  IndexedDB so orders survive refresh + browser restart; falls
 *  back to in-memory when IDB is unavailable (SSR, private mode). */
export interface OrderRecord {
  /** Stable id used as the React key and IDB primary key. */
  id: string;
  /** Display label (`ord-1`, `ord-2`…). */
  label: string;
  side: "sell" | "buy";
  pair: string;
  price: string;
  size: string;
  status: OrderStatus;
  /** Material the user needs to claim once the order settles.
   *  Optional because seeded demo rows don't carry it. */
  claim?: OrderClaim;
  /** Authorize-circuit nonce used at order-submit time. Required
   *  later for the cancel proof (the cancel circuit publishes
   *  `nonceNullifier(secret, nonce)` to kill *this* order
   *  specifically). Optional because seeded demo rows don't carry
   *  it. */
  nonce?: bigint;
  /** Vault note id that funded the order — needed by the cancel
   *  flow to look up the spending note and rotate it. */
  noteId?: string;
  /** When the order was submitted (ms epoch). */
  createdAt: number;
}

interface OrdersState {
  orders: OrderRecord[];
  add(
    o: Omit<OrderRecord, "id" | "label" | "createdAt" | "status">,
  ): OrderRecord;
  /** Mark an order as claimed. Idempotent. */
  markClaimed(id: string): void;
  /** Mark an order as cancelled. Only valid for `matching` orders;
   *  no-op when the order is already filled / claimed / cancelled. */
  markCancelled(id: string): void;
}

const OrdersCtx = createContext<OrdersState | null>(null);

export function useOrders(): OrdersState {
  const ctx = useContext(OrdersCtx);
  if (!ctx) throw new Error("useOrders must be used inside <OrdersProvider>");
  return ctx;
}

// ── IDB persistence ──────────────────────────────────────────
// Bigints (secret, amount, releaseTime, nonce) are hex-encoded on
// the wire so the structured-clone serialiser doesn't have to
// understand them. Keyed per chainId to match the vault adapter —
// switching networks shows a different (correct) order list.

const STORE = "orders";
const VERSION = 1;

/** Wire shape — exported only so the unit test can pin the
 *  on-disk schema and round-trip every field; do not depend on
 *  the WireOrder shape from app code. */
export interface WireOrder {
  id: string;
  label: string;
  side: "sell" | "buy";
  pair: string;
  price: string;
  size: string;
  status: OrderStatus;
  claim?: {
    secretHex: string;
    recipient: string;
    token: string;
    amountHex: string;
    releaseTimeHex: string;
    leafIndex: number;
    claimsRoot?: string;
  };
  nonceHex?: string;
  noteId?: string;
  createdAt: number;
}

export function serialize(o: OrderRecord): WireOrder {
  return {
    id: o.id,
    label: o.label,
    side: o.side,
    pair: o.pair,
    price: o.price,
    size: o.size,
    status: o.status,
    claim: o.claim
      ? {
          secretHex: bigintToHex(o.claim.secret),
          recipient: o.claim.recipient,
          token: o.claim.token,
          amountHex: bigintToHex(o.claim.amount),
          releaseTimeHex: bigintToHex(o.claim.releaseTime),
          leafIndex: o.claim.leafIndex,
          claimsRoot: o.claim.claimsRoot,
        }
      : undefined,
    nonceHex: o.nonce !== undefined ? bigintToHex(o.nonce) : undefined,
    noteId: o.noteId,
    createdAt: o.createdAt,
  };
}

export function deserialize(w: WireOrder): OrderRecord {
  return {
    id: w.id,
    label: w.label,
    side: w.side,
    pair: w.pair,
    price: w.price,
    size: w.size,
    status: w.status,
    claim: w.claim
      ? {
          secret: BigInt(w.claim.secretHex),
          recipient: w.claim.recipient,
          token: w.claim.token,
          amount: BigInt(w.claim.amountHex),
          releaseTime: BigInt(w.claim.releaseTimeHex),
          leafIndex: w.claim.leafIndex,
          claimsRoot: w.claim.claimsRoot,
        }
      : undefined,
    nonce: w.nonceHex !== undefined ? BigInt(w.nonceHex) : undefined,
    noteId: w.noteId,
    createdAt: w.createdAt,
  };
}

let warnedOnce = false;
function warnOnce(reason: string, err?: unknown): void {
  if (warnedOnce) return;
  warnedOnce = true;
  // eslint-disable-next-line no-console
  console.warn(`[scatter pro orders] ${reason} — falling back to in-memory`, err);
}

interface OrdersAdapter {
  loadAll(): Promise<OrderRecord[]>;
  put(o: OrderRecord): Promise<void>;
}

function createOrdersAdapter(dbName: string): OrdersAdapter {
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  function open(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = openIDB({
      dbName,
      version: VERSION,
      stores: [{ name: STORE, keyPath: "id" }],
      onWarn: warnOnce,
    });
    return dbPromise;
  }
  return {
    async loadAll() {
      const db = await open();
      if (!db) return [];
      return new Promise<OrderRecord[]>((resolve) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).getAll();
        req.onsuccess = () => {
          const wire = (req.result ?? []) as WireOrder[];
          const out: OrderRecord[] = [];
          for (const w of wire) {
            try {
              out.push(deserialize(w));
            } catch (e) {
              warnOnce(`skipping malformed order ${w.id ?? "<no id>"}`, e);
            }
          }
          resolve(out);
        };
        req.onerror = () => {
          warnOnce("loadAll tx errored", req.error);
          resolve([]);
        };
      });
    },
    async put(o) {
      const db = await open();
      if (!db) return;
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(serialize(o));
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          warnOnce("put tx errored", tx.error);
          resolve();
        };
        tx.onabort = () => resolve();
      });
    },
  };
}

export function OrdersProvider({ children }: { children: React.ReactNode }) {
  const { network } = useActiveNetwork();
  const chainId = network.chainId;
  const adapter = useMemo(
    () => createOrdersAdapter(`zkscatter-pro-orders-${chainId}`),
    [chainId],
  );

  const [orders, setOrders] = useState<OrderRecord[]>([]);
  // Latest committed `orders` for use inside event-driven callbacks
  // (markClaimed / markCancelled / promote). Read here keeps the
  // side-effect (`adapter.put`) outside the setState updater, which
  // React 18 Strict Mode otherwise invokes twice — without this we'd
  // double-write to IDB in dev for every mutation.
  const ordersRef = useRef<OrderRecord[]>([]);
  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);
  const labelCounter = useRef(0);
  // Tracks demo-lifecycle promote timers so they're cleared on
  // unmount (HMR, route swap) and don't fire setOrders against an
  // unmounted provider.
  const promoteTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Hydrate from IDB on mount / chain change. Seed labelCounter from
  // the largest `ord-N` we find so post-hydration adds don't clash
  // with the persisted ones. Clears any in-flight timers + their
  // scheduled-set bookkeeping so a promote scheduled against the
  // previous chain's adapter can't write back to the new one.
  useEffect(() => {
    let cancelled = false;
    const timers = promoteTimers.current;
    for (const t of timers) clearTimeout(t);
    timers.clear();
    scheduledIds.current.clear();
    adapter.loadAll().then((loaded) => {
      if (cancelled) return;
      const sorted = loaded.sort((a, b) => b.createdAt - a.createdAt);
      setOrders(sorted);
      let maxSeq = 0;
      for (const o of loaded) {
        const m = /^ord-(\d+)$/.exec(o.label);
        if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
      }
      labelCounter.current = maxSeq;
    });
    return () => {
      cancelled = true;
    };
  }, [adapter]);

  useEffect(() => {
    const timers = promoteTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

  // Track which order ids already have a pending promotion timer so
  // we don't double-schedule on every `orders` change (the array
  // identity changes on any add / mark*, which would otherwise leak
  // a new timer per matching row per state transition).
  const scheduledIds = useRef<Set<string>>(new Set());

  // Demo lifecycle: matching → claimable 8 s after createdAt.
  // Schedules a one-shot timer per matching order we haven't
  // scheduled yet. Persists the transition through the adapter.
  useEffect(() => {
    const timers = promoteTimers.current;
    const scheduled = scheduledIds.current;
    for (const o of orders) {
      if (o.status !== "matching") continue;
      if (scheduled.has(o.id)) continue;
      const elapsed = Date.now() - o.createdAt;
      const remaining = Math.max(0, 8_000 - elapsed);
      const id = o.id;
      const handle = setTimeout(() => {
        timers.delete(handle);
        scheduled.delete(id);
        const target = ordersRef.current.find((x) => x.id === id);
        if (!target || target.status !== "matching") return;
        const promoted: OrderRecord = { ...target, status: "claimable" };
        adapter.put(promoted);
        setOrders((prev) => prev.map((x) => (x.id === id ? promoted : x)));
      }, remaining);
      timers.add(handle);
      scheduled.add(id);
    }
  }, [orders, adapter]);

  const add = useCallback(
    (o: Omit<OrderRecord, "id" | "label" | "createdAt" | "status">) => {
      const seq = ++labelCounter.current;
      const order: OrderRecord = {
        ...o,
        id: newId(),
        label: `ord-${seq}`,
        createdAt: Date.now(),
        status: "matching",
      };
      setOrders((prev) => [order, ...prev]);
      adapter.put(order);
      return order;
    },
    [adapter],
  );

  const markClaimed = useCallback(
    (id: string) => {
      const target = ordersRef.current.find((o) => o.id === id);
      // Bail when the id isn't present or the order is already
      // claimed — keeps the put + setState idempotent across repeat
      // calls and avoids re-rendering with an identical-content list.
      if (!target || target.status === "claimed") return;
      const next: OrderRecord = { ...target, status: "claimed" };
      adapter.put(next);
      setOrders((prev) => prev.map((o) => (o.id === id ? next : o)));
    },
    [adapter],
  );

  const markCancelled = useCallback(
    (id: string) => {
      const target = ordersRef.current.find((o) => o.id === id);
      if (!target || target.status !== "matching") return;
      const next: OrderRecord = { ...target, status: "cancelled" };
      adapter.put(next);
      setOrders((prev) => prev.map((o) => (o.id === id ? next : o)));
    },
    [adapter],
  );

  const value = useMemo<OrdersState>(
    () => ({ orders, add, markClaimed, markCancelled }),
    [orders, add, markClaimed, markCancelled],
  );

  return <OrdersCtx.Provider value={value}>{children}</OrdersCtx.Provider>;
}
