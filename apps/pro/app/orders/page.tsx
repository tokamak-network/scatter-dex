"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useOrders, type OrderRecord } from "../lib/orders";
import { ClaimModal } from "../components/ClaimModal";

import type { OrderStatus } from "../lib/orders";

// Class lookup keyed by `OrderStatus` so a typo here is a compile
// error and adding a new status surfaces a missing entry.
const PILL_CLASSES: Record<OrderStatus, string> = {
  claimed:   "bg-[var(--color-success-soft)] text-[var(--color-success)]",
  claimable: "bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
  matching:  "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
  cancelled: "bg-[var(--color-bg)] text-[var(--color-text-muted)]",
};

const SEED_ORDERS: OrderRecord[] = [
  { id: "seed-1", label: "ord_8412", side: "sell", pair: "ETH/USDC",  price: "4,205",  size: "2.0",  status: "claimable", createdAt: Date.parse("2026-04-26T09:14:00Z") },
  { id: "seed-2", label: "ord_8401", side: "buy",  pair: "WBTC/USDC", price: "67,210", size: "0.15", status: "matching",  createdAt: Date.parse("2026-04-26T08:51:00Z") },
  { id: "seed-3", label: "ord_8388", side: "sell", pair: "ETH/USDC",  price: "4,198",  size: "1.5",  status: "claimed",   createdAt: Date.parse("2026-04-25T22:30:00Z") },
  { id: "seed-4", label: "ord_8377", side: "buy",  pair: "TON/USDC",  price: "5.42",   size: "1500", status: "cancelled", createdAt: Date.parse("2026-04-25T18:02:00Z") },
];

function formatWhen(ts: number): string {
  // Fixed locale + time zone so the SSG-rendered cell matches what
  // the client renders during hydration.
  const d = new Date(ts);
  return (
    d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    }) + " UTC"
  );
}

export default function Orders() {
  const { orders } = useOrders();
  const all = useMemo<OrderRecord[]>(() => [...orders, ...SEED_ORDERS], [orders]);
  const [claimTarget, setClaimTarget] = useState<OrderRecord | null>(null);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Orders</h1>
        <Link href="/app" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Back to workbench
        </Link>
      </div>
      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-3 text-left">Order</th>
              <th className="px-5 py-3 text-left">Side</th>
              <th className="px-5 py-3 text-left">Pair</th>
              <th className="px-5 py-3 text-right">Price</th>
              <th className="px-5 py-3 text-right">Size</th>
              <th className="px-5 py-3 text-left">Status</th>
              <th className="px-5 py-3 text-left">When</th>
              <th className="px-5 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {all.map((o) => (
              <tr key={o.id} className="border-t border-[var(--color-border)]">
                <td className="px-5 py-3 font-mono text-xs">{o.label}</td>
                <td className="px-5 py-3">{o.side === "sell" ? "Sell" : "Buy"}</td>
                <td className="px-5 py-3">{o.pair}</td>
                <td className="px-5 py-3 text-right font-mono">{o.price}</td>
                <td className="px-5 py-3 text-right font-mono">{o.size}</td>
                <td className="px-5 py-3"><Pill s={o.status} /></td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">{formatWhen(o.createdAt)}</td>
                <td className="px-5 py-3 text-right">
                  {o.status === "claimable" && o.claim && (
                    <button
                      onClick={() => setClaimTarget(o)}
                      className="rounded-md border border-[var(--color-primary)] px-3 py-1 text-xs font-medium text-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
                    >
                      Claim
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ClaimModal
        open={!!claimTarget}
        order={claimTarget}
        onClose={() => setClaimTarget(null)}
      />
    </div>
  );
}

function Pill({ s }: { s: OrderStatus }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PILL_CLASSES[s]}`}>{s}</span>;
}
