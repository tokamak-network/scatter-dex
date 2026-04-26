"use client";

import Link from "next/link";
import { useOrders, type OrderRecord } from "../lib/orders";

const SEED_ORDERS: OrderRecord[] = [
  { id: "seed-1", label: "ord_8412", side: "sell", pair: "ETH/USDC", price: "4,205", size: "2.0", status: "settled",   createdAt: Date.parse("2026-04-26T09:14:00Z") },
  { id: "seed-2", label: "ord_8401", side: "buy",  pair: "WBTC/USDC", price: "67,210", size: "0.15", status: "matching", createdAt: Date.parse("2026-04-26T08:51:00Z") },
  { id: "seed-3", label: "ord_8388", side: "sell", pair: "ETH/USDC", price: "4,198", size: "1.5", status: "settled",   createdAt: Date.parse("2026-04-25T22:30:00Z") },
  { id: "seed-4", label: "ord_8377", side: "buy",  pair: "TON/USDC", price: "5.42",   size: "1500", status: "cancelled", createdAt: Date.parse("2026-04-25T18:02:00Z") },
];

function formatWhen(ts: number): string {
  // Fixed locale + time zone so the SSG-rendered cell matches what
  // the client renders during hydration. Without `timeZone: "UTC"`
  // the server (typically UTC) and the client (user's system zone)
  // would format different local times for the same instant.
  // The "UTC" suffix is explicit so users don't misread their own
  // zone into the value.
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
  const all: OrderRecord[] = [...orders, ...SEED_ORDERS];

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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Pill({ s }: { s: string }) {
  const map: Record<string, string> = {
    settled:   "bg-[var(--color-success-soft)] text-[var(--color-success)]",
    matching:  "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
    cancelled: "bg-[var(--color-bg)] text-[var(--color-text-muted)]",
  };
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${map[s] || ""}`}>{s}</span>;
}
