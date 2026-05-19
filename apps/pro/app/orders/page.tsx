"use client";

import { useEffect, useMemo, useState } from "react";
import { useOrders, type OrderRecord, type OrderStatus } from "../lib/orders";
import { ClaimModal } from "../components/ClaimModal";
import { CancelOrderModal } from "../components/CancelOrderModal";
import { StatusBadge } from "../components/StatusBadge";
import { OrderDetailDrawer } from "../components/OrderDetailDrawer";
import { WorkspaceBar } from "../components/WorkspaceBar";
import { formatWhen } from "../lib/format";

// "Expired" is a UI-derived bucket: `status === "matching"` AND the
// settle deadline already passed. Not a real OrderStatus on disk.
type StatusFilter = "all" | OrderStatus | "expired";
const FILTERS: Array<{ key: StatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "matching", label: "Matching" },
  { key: "expired", label: "Expired" },
  { key: "claimable", label: "Ready to claim" },
  { key: "claimed", label: "Claimed" },
  { key: "cancelled", label: "Cancelled" },
];

function isExpired(o: OrderRecord, nowMs: number): boolean {
  if (o.status !== "matching") return false;
  if (o.expiry === undefined) return false;
  return Number(o.expiry) * 1000 <= nowMs;
}

export default function Orders() {
  const { orders } = useOrders();
  // Re-evaluate the Expired bucket every minute so an expiry
  // crossing while the tab sits open shifts the order into the
  // Expired filter without a refresh.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const all = orders;
  const realIds = useMemo(() => new Set(orders.map((o) => o.id)), [orders]);
  const [claimTarget, setClaimTarget] = useState<OrderRecord | null>(null);
  const [cancelTarget, setCancelTarget] = useState<OrderRecord | null>(null);
  const [drawerTarget, setDrawerTarget] = useState<OrderRecord | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");

  // Resolve the live order each render so status transitions
  // (matching → claimable, etc.) reflect in the open drawer
  // without forcing the user to close and reopen. Falls back to
  // the captured pointer if the order disappears from the list
  // (rare — keeps the drawer from blanking mid-interaction).
  const liveDrawerTarget = useMemo(
    () =>
      drawerTarget ? all.find((o) => o.id === drawerTarget.id) ?? drawerTarget : null,
    [all, drawerTarget],
  );
  const drawerCanCancel =
    liveDrawerTarget?.status === "matching" && realIds.has(liveDrawerTarget.id);
  const drawerCanClaim =
    liveDrawerTarget?.status === "claimable" && !!liveDrawerTarget.claim;

  const visible = useMemo(() => {
    if (filter === "all") return all;
    if (filter === "expired") return all.filter((o) => isExpired(o, nowMs));
    // The Matching filter excludes expired rows so the two buckets
    // don't double-count — an expired-but-still-`matching`-on-disk
    // order should only appear under Expired.
    if (filter === "matching") {
      return all.filter((o) => o.status === "matching" && !isExpired(o, nowMs));
    }
    return all.filter((o) => o.status === filter);
  }, [all, filter, nowMs]);

  // Counts per filter so the segmented control can show "(N)" hints
  // — answers "how many open orders do I have" at a glance without
  // requiring the user to click each tab.
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = {
      all: all.length,
      matching: 0,
      expired: 0,
      claimable: 0,
      claimed: 0,
      cancelled: 0,
    };
    for (const o of all) {
      if (o.status === "matching" && isExpired(o, nowMs)) c.expired++;
      else c[o.status]++;
    }
    return c;
  }, [all, nowMs]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">My orders</h1>

      {/* Title above, workspace context just under it — matches the
          address-book / wallet pages so the layout stays uniform
          across every folder-backed page. */}
      <WorkspaceBar />
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
              <tr
                key={o.id}
                role="button"
                tabIndex={0}
                onClick={() => setDrawerTarget(o)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setDrawerTarget(o);
                  }
                }}
                className="cursor-pointer border-t border-[var(--color-border)] hover:bg-[var(--color-primary-soft)] focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--color-primary)]"
              >
                <td className="px-5 py-3 font-mono text-xs">{o.label}</td>
                <td className="px-5 py-3">{o.side === "sell" ? "Sell" : "Buy"}</td>
                <td className="px-5 py-3">{o.pair}</td>
                <td className="px-5 py-3 text-right font-mono">{o.price}</td>
                <td className="px-5 py-3 text-right font-mono">{o.size}</td>
                <td className="px-5 py-3">
                  {isExpired(o, nowMs) ? (
                    <span className="rounded-full border border-[var(--color-danger)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-danger)]">
                      Expired
                    </span>
                  ) : (
                    <StatusBadge status={o.status} />
                  )}
                </td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">{formatWhen(o.createdAt)}</td>
                <td className="px-5 py-3 text-right" onClick={(e) => e.stopPropagation()}>
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
      <OrderDetailDrawer
        open={!!liveDrawerTarget}
        order={liveDrawerTarget}
        onClose={() => setDrawerTarget(null)}
        onCancel={
          drawerCanCancel
            ? () => {
                if (liveDrawerTarget) setCancelTarget(liveDrawerTarget);
                setDrawerTarget(null);
              }
            : undefined
        }
        onClaim={
          drawerCanClaim
            ? () => {
                if (liveDrawerTarget) setClaimTarget(liveDrawerTarget);
                setDrawerTarget(null);
              }
            : undefined
        }
      />
    </div>
  );
}
