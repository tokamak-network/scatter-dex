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
}

/** A submitted private limit order. Phase 3c stores everything in
 *  React state (lost on refresh); Phase 6 swaps in a real storage
 *  adapter from `@zkscatter/sdk/notes` so orders survive reloads. */
export interface OrderRecord {
  /** Stable per-session id used as the React key. */
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

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function OrdersProvider({ children }: { children: React.ReactNode }) {
  const [orders, setOrders] = useState<OrderRecord[]>([]);
  const labelCounter = useRef(0);
  // Tracks demo-lifecycle promote timers so they're cleared on
  // unmount (HMR, route swap) and don't fire setOrders against an
  // unmounted provider.
  const promoteTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timers = promoteTimers.current;
    return () => {
      for (const t of timers) clearTimeout(t);
      timers.clear();
    };
  }, []);

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
      // Demo lifecycle: matching → claimable after 8s. Bails out
      // (preserving array identity) if the order was cancelled or
      // already claimed by then. Real lifecycle events land with the
      // SDK migration.
      const handle = setTimeout(() => {
        promoteTimers.current.delete(handle);
        setOrders((prev) => {
          const target = prev.find((x) => x.id === order.id);
          if (!target || target.status !== "matching") return prev;
          return prev.map((x) =>
            x.id === order.id ? { ...x, status: "claimable" } : x,
          );
        });
      }, 8_000);
      promoteTimers.current.add(handle);
      return order;
    },
    [],
  );

  const markClaimed = useCallback((id: string) => {
    setOrders((prev) => {
      // Bail with the same array reference when the id isn't
      // present — React's bail-out skips the re-render entirely
      // instead of producing a new equal-content array.
      if (!prev.some((o) => o.id === id)) return prev;
      return prev.map((o) =>
        o.id === id ? { ...o, status: "claimed" } : o,
      );
    });
  }, []);

  const markCancelled = useCallback((id: string) => {
    setOrders((prev) => {
      const target = prev.find((o) => o.id === id);
      if (!target || target.status !== "matching") return prev;
      return prev.map((o) =>
        o.id === id ? { ...o, status: "cancelled" } : o,
      );
    });
  }, []);

  const value = useMemo<OrdersState>(
    () => ({ orders, add, markClaimed, markCancelled }),
    [orders, add, markClaimed, markCancelled],
  );

  return <OrdersCtx.Provider value={value}>{children}</OrdersCtx.Provider>;
}
