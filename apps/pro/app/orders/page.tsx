"use client";

import { useEffect, useMemo, useState } from "react";
import { shortAddr } from "@zkscatter/sdk/react";
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

/** Pair display is "BASE/QUOTE" (e.g. ETH/USDC). For side=sell the
 *  user sells base, gets quote; for side=buy the user sells quote,
 *  gets base. Below helpers project the (side, pair, price, size)
 *  shape stored on disk into the per-token sell/buy columns the user
 *  asked for — strings rather than bigints because the underlying
 *  fields are display strings (already formatted at submit time). */
function pairParts(o: OrderRecord): { base: string; quote: string } {
  const [base = "", quote = ""] = o.pair.split("/");
  return { base, quote };
}

function sellSymbol(o: OrderRecord): string {
  const { base, quote } = pairParts(o);
  return o.side === "sell" ? base : quote;
}

function buySymbol(o: OrderRecord): string {
  const { base, quote } = pairParts(o);
  return o.side === "sell" ? quote : base;
}

/** Multiply two decimal display strings while preserving precision
 *  the user typed. Falls back to Number math when either side parses
 *  as NaN — the row still renders something rather than blanking on
 *  a malformed legacy order. */
function mulDisplay(a: string, b: string): string {
  const cleanA = a.replace(/,/g, "");
  const cleanB = b.replace(/,/g, "");
  const na = Number(cleanA);
  const nb = Number(cleanB);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return "—";
  const product = na * nb;
  // Match the orderbook page's display rounding so a user who copies
  // a value between surfaces sees the same number.
  return product.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function sellDisplay(o: OrderRecord): string {
  // Sell-side: size is in base, so sell amount = size in base units.
  // Buy-side: size is in base (what the user buys), so sell amount =
  // size × price in quote units.
  return o.side === "sell" ? o.size : mulDisplay(o.size, o.price);
}

function buyDisplay(o: OrderRecord): string {
  return o.side === "sell" ? mulDisplay(o.size, o.price) : o.size;
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
              <th className="px-5 py-3 text-right">Sell</th>
              <th className="px-5 py-3 text-right">Buy</th>
              <th className="px-5 py-3 text-left">Status</th>
              <th className="px-5 py-3 text-left">Relayer</th>
              <th className="px-5 py-3 text-left">Submitted</th>
              <th className="px-5 py-3 text-left">Settle by</th>
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
                <td className="px-5 py-3 text-right font-mono">
                  <span className="font-semibold">{sellDisplay(o)}</span>{" "}
                  <span className="text-[var(--color-text-muted)]">{sellSymbol(o)}</span>
                </td>
                <td className="px-5 py-3 text-right font-mono">
                  <span className="font-semibold">{buyDisplay(o)}</span>{" "}
                  <span className="text-[var(--color-text-muted)]">{buySymbol(o)}</span>
                </td>
                <td className="px-5 py-3">
                  {isExpired(o, nowMs) ? (
                    <span className="rounded-full border border-[var(--color-danger)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-danger)]">
                      Expired
                    </span>
                  ) : (
                    <StatusBadge status={o.status} />
                  )}
                </td>
                <td className="px-5 py-3">
                  {o.relayer ? (
                    <div className="flex flex-col">
                      <span className="text-xs font-medium">
                        {o.relayer.name ?? shortAddr(o.relayer.address)}
                      </span>
                      {o.relayer.name && (
                        <span className="font-mono text-[10px] text-[var(--color-text-muted)]">
                          {shortAddr(o.relayer.address)}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-[var(--color-text-subtle)]">—</span>
                  )}
                </td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">{formatWhen(o.createdAt)}</td>
                <td className="px-5 py-3 text-[var(--color-text-muted)]">
                  {o.expiry !== undefined ? (
                    <span className={isExpired(o, nowMs) ? "text-[var(--color-danger)]" : ""}>
                      {formatWhen(Number(o.expiry) * 1000)}
                    </span>
                  ) : (
                    <span className="text-[var(--color-text-subtle)]">—</span>
                  )}
                </td>
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
