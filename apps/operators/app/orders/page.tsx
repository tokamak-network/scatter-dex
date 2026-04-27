"use client";

import Link from "next/link";
import { useState } from "react";

type OrderStatus = "pending" | "settled" | "expired" | "cancelled";

interface OrderRow {
  id: string;
  pair: string;
  side: "buy" | "sell";
  size: string;
  maker: string;
  fee: string;
  submittedAt: string;
  status: OrderStatus;
}

const filters: { key: "all" | OrderStatus; label: string }[] = [
  { key: "all",       label: "All" },
  { key: "pending",   label: "Pending" },
  { key: "settled",   label: "Settled" },
  { key: "expired",   label: "Expired" },
  { key: "cancelled", label: "Cancelled" },
];

const orders: OrderRow[] = [
  { id: "0xab12…", pair: "USDC/WETH", side: "buy",  size: "8,400",  maker: "0x4f…91", fee: "2.52", submittedAt: "09:14:22", status: "settled" },
  { id: "0xcd34…", pair: "USDT/WBTC", side: "sell", size: "55,100", maker: "0x12…ab", fee: "16.53", submittedAt: "08:51:08", status: "settled" },
  { id: "0xef56…", pair: "USDC/TON",  side: "buy",  size: "12,800", maker: "0x88…c2", fee: "3.84",  submittedAt: "08:32:55", status: "settled" },
  { id: "0x1278…", pair: "USDC/WETH", side: "sell", size: "4,200",  maker: "0xa9…d3", fee: "1.26",  submittedAt: "09:18:01", status: "pending" },
  { id: "0x9abc…", pair: "USDT/TON",  side: "buy",  size: "2,100",  maker: "0xb1…e7", fee: "0.63",  submittedAt: "09:17:44", status: "pending" },
  { id: "0xdef0…", pair: "USDC/WBTC", side: "buy",  size: "780",    maker: "0xc4…f8", fee: "0.23",  submittedAt: "07:02:11", status: "expired" },
];

export default function OrdersPage() {
  const [filter, setFilter] = useState<"all" | OrderStatus>("all");
  const visible = filter === "all" ? orders : orders.filter((o) => o.status === filter);

  return (
    <div className="space-y-8">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Routed orders</h1>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Live feed of orders flowing through this relayer. Click a row to inspect
            the signed payload, claim status, and settlement transaction.
          </p>
        </div>
        <Link
          href="/dashboard"
          className="text-sm text-[var(--color-primary)] hover:underline"
        >
          ← Dashboard
        </Link>
      </header>

      <div className="flex items-center gap-2">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={
              filter === f.key
                ? "rounded-full bg-[var(--color-primary)] px-3 py-1 text-xs font-medium text-white"
                : "rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-1 text-xs text-[var(--color-text-muted)] hover:border-[var(--color-border-strong)]"
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-bg)] text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            <tr>
              <th className="px-5 py-3 text-left">Order</th>
              <th className="px-5 py-3 text-left">Pair</th>
              <th className="px-5 py-3 text-left">Side</th>
              <th className="px-5 py-3 text-right">Size (USD)</th>
              <th className="px-5 py-3 text-left">Maker</th>
              <th className="px-5 py-3 text-right">Fee</th>
              <th className="px-5 py-3 text-left">Submitted</th>
              <th className="px-5 py-3 text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((o) => (
              <tr key={o.id} className="border-t border-[var(--color-border)] hover:bg-[var(--color-primary-soft)]">
                <td className="px-5 py-3 font-mono text-xs">{o.id}</td>
                <td className="px-5 py-3">{o.pair}</td>
                <td className="px-5 py-3 capitalize">{o.side}</td>
                <td className="px-5 py-3 text-right font-mono">{o.size}</td>
                <td className="px-5 py-3 font-mono text-xs">{o.maker}</td>
                <td className="px-5 py-3 text-right font-mono text-[var(--color-success)]">{o.fee}</td>
                <td className="px-5 py-3 text-xs text-[var(--color-text-muted)]">{o.submittedAt}</td>
                <td className="px-5 py-3"><StatusPill status={o.status} /></td>
              </tr>
            ))}
            {visible.length === 0 && (
              <tr>
                <td colSpan={8} className="px-5 py-10 text-center text-sm text-[var(--color-text-muted)]">
                  No orders for this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-[var(--color-text-subtle)]">
        Showing mock data. Wired through SDK <code className="font-mono">relayerClient.getOrderHistory()</code> in v1.1.
      </p>
    </div>
  );
}

function StatusPill({ status }: { status: OrderStatus }) {
  const styles: Record<OrderStatus, string> = {
    pending:   "bg-[var(--color-warning-soft)] text-[var(--color-warning)]",
    settled:   "bg-[var(--color-success-soft)] text-[var(--color-success)]",
    expired:   "bg-[var(--color-bg)] text-[var(--color-text-muted)]",
    cancelled: "bg-[var(--color-bg)] text-[var(--color-text-muted)]",
  };
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}
