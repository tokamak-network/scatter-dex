"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useOrders, type OrderRecord, type OrderStatus } from "../lib/orders";
import { ClaimModal } from "../components/ClaimModal";
import { CancelOrderModal } from "../components/CancelOrderModal";
import { StatusBadge } from "../components/StatusBadge";

const SEED_ORDERS: OrderRecord[] = [
  { id: "seed-1", label: "ord_8412", side: "sell", pair: "ETH/USDC", price: "4,205",  size: "2.0",  status: "claimable", createdAt: Date.parse("2026-04-26T09:14:00Z") },
  { id: "seed-2", label: "ord_8401", side: "buy",  pair: "TON/USDT", price: "5.43",   size: "1200", status: "matching",  createdAt: Date.parse("2026-04-26T08:51:00Z") },
  { id: "seed-3", label: "ord_8388", side: "sell", pair: "ETH/USDC", price: "4,198",  size: "1.5",  status: "claimed",   createdAt: Date.parse("2026-04-25T22:30:00Z") },
  { id: "seed-4", label: "ord_8377", side: "buy",  pair: "TON/USDC", price: "5.42",   size: "1500", status: "cancelled", createdAt: Date.parse("2026-04-25T18:02:00Z") },
];

type StatusFilter = "all" | OrderStatus;
const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "matching", label: "Matching" },
  { key: "claimable", label: "Filled" },
  { key: "claimed", label: "Claimed" },
  { key: "cancelled", label: "Cancelled" },
];

function formatWhen(ts: number): string {
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
  const realIds = useMemo(() => new Set(orders.map((o) => o.id)), [orders]);
  const [claimTarget, setClaimTarget] = useState<OrderRecord | null>(null);
  const [cancelTarget, setCancelTarget] = useState<OrderRecord | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");

  const visible = useMemo(
    () => (filter === "all" ? all : all.filter((o) => o.status === filter)),
    [all, filter],
  );

  // Counts per filter so the segmented control can show "(N)" hints
  // — answers "how many open orders do I have" at a glance without
  // requiring the user to click each tab.
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: all.length,
      matching: 0,
      claimable: 0,
      claimed: 0,
      cancelled: 0,
    };
    for (const o of all) c[o.status]++;
    return c;
  }, [all]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Orders</h1>
        <Link href="/app" className="text-sm text-[var(--color-primary)] hover:underline">
          ← Back to workbench
        </Link>
      </div>
      <div className="flex flex-wrap gap-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-sm">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`flex-1 rounded px-3 py-1.5 font-medium transition-colors ${
              filter === f.key
                ? "bg-[var(--color-primary)] text-white"
                : "text-[var(--color-text-muted)] hover:bg-[var(--color-bg)]"
            }`}
          >
            {f.label}
            <span className="ml-1.5 text-[11px] opacity-70">({counts[f.key]})</span>
          </button>
        ))}
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
            {visible.map((o) => (
              <tr key={o.id} className="border-t border-[var(--color-border)]">
                <td className="px-5 py-3 font-mono text-xs">{o.label}</td>
                <td className="px-5 py-3">{o.side === "sell" ? "Sell" : "Buy"}</td>
                <td className="px-5 py-3">{o.pair}</td>
                <td className="px-5 py-3 text-right font-mono">{o.price}</td>
                <td className="px-5 py-3 text-right font-mono">{o.size}</td>
                <td className="px-5 py-3"><StatusBadge status={o.status} /></td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">{formatWhen(o.createdAt)}</td>
                <td className="px-5 py-3 text-right">
                  {o.status === "matching" && realIds.has(o.id) && (
                    <button
                      onClick={() => setCancelTarget(o)}
                      className="rounded-md border border-[var(--color-danger)] px-3 py-1 text-xs font-medium text-[var(--color-danger)] hover:bg-white"
                    >
                      Cancel
                    </button>
                  )}
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
      <CancelOrderModal
        open={!!cancelTarget}
        order={cancelTarget}
        onClose={() => setCancelTarget(null)}
      />
    </div>
  );
}
