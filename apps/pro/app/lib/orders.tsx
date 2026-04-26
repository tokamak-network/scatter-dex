"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

export type OrderStatus = "matching" | "settled" | "cancelled";

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
  /** When the order was submitted (ms epoch). */
  createdAt: number;
}

interface OrdersState {
  orders: OrderRecord[];
  add(o: Omit<OrderRecord, "id" | "label" | "createdAt" | "status">): OrderRecord;
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
  const [labelCounter, setLabelCounter] = useState(0);

  const add = useCallback(
    (o: Omit<OrderRecord, "id" | "label" | "createdAt" | "status">) => {
      const seq = labelCounter + 1;
      setLabelCounter(seq);
      const order: OrderRecord = {
        ...o,
        id: newId(),
        label: `ord-${seq}`,
        createdAt: Date.now(),
        status: "matching",
      };
      setOrders((prev) => [order, ...prev]);
      return order;
    },
    [labelCounter],
  );

  const value = useMemo<OrdersState>(() => ({ orders, add }), [orders, add]);

  return <OrdersCtx.Provider value={value}>{children}</OrdersCtx.Provider>;
}
