"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { EmptyState } from "@zkscatter/ui";
import { useVault } from "../lib/vault";
import { useOrders, type OrderRecord } from "../lib/orders";
import { aggregateBySymbol } from "../lib/noteStatus";
import { StatusBadge } from "./StatusBadge";

/** Workbench left column — order-centric:
 *    1. Open orders — non-expired matching, click row → detail
 *    2. Expired   — matching past `expiry`, cancel to recover
 *    3. Ready to claim — on-chain PrivateClaim observed
 *
 *  The escrow pool summary + notes list + deposit / withdraw
 *  actions all live on the dedicated /notes ("Escrow") page; the
 *  workbench just links there. Centralising those flows kept the
 *  workbench from accumulating cards that the user could trigger
 *  from the nav anyway. */
interface Props {
  /** Opens the page-level `DepositModal`. */
  onDeposit: () => void;
  /** The order currently shown in the workbench's center panel
   *  (or null when the trade form is active). Drives the per-row
   *  "selected" highlight + the `+ New order` button visibility. */
  selectedOrder: OrderRecord | null;
  /** Set the order shown in the center panel. Pass `null` to
   *  return to the trade form. */
  onSelectOrder: (order: OrderRecord | null) => void;
}

export function MyPositionPanel({ onDeposit, selectedOrder, onSelectOrder }: Props) {
  const { notes } = useVault();
  const { orders } = useOrders();

  // Three live buckets for the left panel:
  //   * open      — matching AND expiry in the future
  //   * expired   — matching AND expiry passed → unservable, recover
  //                 via Cancel; NOT eligible for "Ready to claim"
  //                 because no settle ever happened
  //   * claimable — status driven by an on-chain PrivateClaim event
  // Re-evaluates every minute so an expiry crossing while the tab
  // sits open shifts the order from Open → Expired without a
  // refresh.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const symbolBuckets = useMemo(
    () => aggregateBySymbol(notes, orders),
    [notes, orders],
  );

  const { open, expired, claimable } = useMemo(() => {
    const o: OrderRecord[] = [];
    const e: OrderRecord[] = [];
    const c: OrderRecord[] = [];
    for (const ord of orders) {
      if (ord.status === "matching") {
        const expiryMs = ord.expiry !== undefined ? Number(ord.expiry) * 1000 : null;
        if (expiryMs !== null && expiryMs <= nowMs) e.push(ord);
        else o.push(ord);
      } else if (ord.status === "claimable") {
        c.push(ord);
      }
    }
    return { open: o, expired: e, claimable: c };
  }, [orders, nowMs]);

  return (
    <aside className="col-span-3 space-y-4">
      {/* Escrow pool — at-a-glance balance + Deposit CTA. Per-note
          list (Withdraw, leaf #s, status detail) lives on the
          dedicated /notes page; the link below opens it. */}
      <Section>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Escrow pool
        </div>
        {symbolBuckets.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">No assets yet.</div>
        ) : (
          <div className="space-y-3 text-sm">
            {symbolBuckets.map((b) => (
              <SymbolBucketBlock key={b.symbol} bucket={b} />
            ))}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button
            onClick={onDeposit}
            className="flex-1 rounded-md border border-[var(--color-border-strong)] bg-white py-2 text-sm font-medium hover:bg-[var(--color-primary-soft)]"
          >
            + Deposit
          </button>
          <Link
            href="/notes"
            className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] py-2 text-center text-sm font-medium text-[var(--color-text-muted)] hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
            title="Full escrow page — notes, leaf numbers, per-note withdraw"
          >
            Manage →
          </Link>
        </div>
      </Section>


      {/* Open orders */}
      <Section
        title={`Open orders (${open.length})`}
        action={
          selectedOrder !== null && (
            <button
              type="button"
              onClick={() => onSelectOrder(null)}
              className="text-[11px] font-medium text-[var(--color-primary)] hover:underline"
              title="Return to the order form"
            >
              + New order
            </button>
          )
        }
      >
        {open.length === 0 ? (
          <EmptyState>No open orders. Place one on the right →</EmptyState>
        ) : (
          <ul className="space-y-1.5">
            {open.map((o) => (
              <OrderRow
                key={o.id}
                order={o}
                selected={selectedOrder?.id === o.id}
                onSelect={() => onSelectOrder(o)}
              />
            ))}
          </ul>
        )}
      </Section>

      {/* Expired — matching orders whose settle deadline passed.
          They can't match anymore (the on-chain `expiry` check
          would reject any settle attempt), so cancel to rotate the
          funding note back to Available. */}
      {expired.length > 0 && (
        <Section title={`Expired (${expired.length})`}>
          <ul className="space-y-1.5">
            {expired.map((o) => (
              <OrderRow
                key={o.id}
                order={o}
                selected={selectedOrder?.id === o.id}
                onSelect={() => onSelectOrder(o)}
                expired
              />
            ))}
          </ul>
          <p className="mt-2 text-[10px] text-[var(--color-text-subtle)]">
            Settle deadline passed without an on-chain match. The
            cancel flow is being reworked — recovery will land in a
            follow-up.
          </p>
        </Section>
      )}

      {/* Ready to claim */}
      <Section title={`Ready to claim (${claimable.length})`}>
        {claimable.length === 0 ? (
          <EmptyState>Nothing to claim right now.</EmptyState>
        ) : (
          <ul className="space-y-1.5">
            {claimable.map((o) => (
              <OrderRow
                key={o.id}
                order={o}
                selected={selectedOrder?.id === o.id}
                onSelect={() => onSelectOrder(o)}
                pastTense
              />
            ))}
          </ul>
        )}
      </Section>

    </aside>
  );
}

/** Compact one-glance order row. The full detail (recipients,
 *  claim payload, lifecycle, change residual) lives in the
 *  center-column `OrderDetailPanel` so the left panel can stay
 *  scannable — clicking the row swaps the center over to that
 *  order's detail. */
function OrderRow({
  order,
  selected,
  onSelect,
  pastTense,
  expired,
}: {
  order: OrderRecord;
  selected: boolean;
  onSelect: () => void;
  pastTense?: boolean;
  /** Renders the row in the expired-section style (muted text +
   *  red "Expired" pill replacing the live status badge). */
  expired?: boolean;
}) {
  const [base, quote] = order.pair.split("/");
  const sellSym = order.side === "sell" ? base : quote;
  const verb = pastTense
    ? order.side === "sell" ? "Sold" : "Bought"
    : order.side === "sell" ? "Sell" : "Buy";
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        className={`group flex w-full items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-xs transition-colors ${
          selected
            ? "border-[var(--color-primary)] bg-[var(--color-primary-soft)]"
            : "border-[var(--color-border)] bg-[var(--color-bg)] hover:border-[var(--color-primary)] hover:bg-[var(--color-primary-soft)]"
        }`}
      >
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono font-semibold">{order.label}</span>
            <span className="text-[10px] text-[var(--color-text-subtle)]">
              {base}/{quote}
            </span>
          </div>
          <div className="mt-0.5 text-[var(--color-text-muted)]">
            {verb} {order.size} {sellSym} @ {order.price}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {expired ? (
            <span className="rounded-full border border-[var(--color-danger)] bg-[var(--color-surface)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-danger)]">
              Expired
            </span>
          ) : (
            <StatusBadge status={order.status} />
          )}
          <span
            className={`text-[10px] font-medium ${
              selected
                ? "text-[var(--color-primary)]"
                : "text-[var(--color-text-subtle)] group-hover:text-[var(--color-primary)]"
            }`}
          >
            {selected ? "Viewing" : "View →"}
          </span>
        </div>
      </button>
    </li>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {title && (
        <div className="mb-2 flex items-baseline justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            {title}
          </div>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function SymbolBucketBlock({
  bucket,
}: {
  bucket: { symbol: string; available: number; locked: number; pending: number };
}) {
  const hasExtras = bucket.locked > 0 || bucket.pending > 0;
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          {bucket.symbol}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          Available
        </span>
      </div>
      <div className="mt-0.5 font-mono text-xl font-bold leading-none text-[var(--color-text)]">
        {formatNum(bucket.available)}
      </div>
      {hasExtras && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          {bucket.locked > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-2 py-0.5 font-medium text-[var(--color-warning)]"
              title="Pinned by an open order — cancel to release"
            >
              <span aria-hidden>🔒</span>
              <span className="font-mono">{formatNum(bucket.locked)}</span>
              <span>locked</span>
            </span>
          )}
          {bucket.pending > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-0.5 font-medium text-[var(--color-text-muted)]"
              title="Awaiting on-chain confirmation"
            >
              <span aria-hidden>⏳</span>
              <span className="font-mono">{formatNum(bucket.pending)}</span>
              <span>pending</span>
            </span>
          )}
        </div>
      )}
    </div>
  );
}

