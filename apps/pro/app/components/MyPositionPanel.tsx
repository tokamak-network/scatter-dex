"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@zkscatter/ui";
import { useVault, type VaultNote } from "../lib/vault";
import { useOrders, type OrderRecord } from "../lib/orders";
import { aggregateBySymbol, deriveNoteStatus, type NoteStatusInfo } from "../lib/noteStatus";
import { WithdrawModal } from "./WithdrawModal";
import { StatusBadge } from "./StatusBadge";

/** Workbench left column. Replaces the old flat note list with the
 *  four-section "what does my money look like right now" view that a
 *  Pro trader actually scans on every page load:
 *
 *    1. Total escrow-pool balance — single dollar number + Deposit CTA
 *    2. Open orders — matching, with per-row Cancel
 *    3. Ready to claim — claimable, with Claim CTA
 *    4. Notes — raw note list, with per-row Withdraw
 *
 *  The component owns the modals (Deposit / Withdraw / Cancel /
 *  Claim) so the rest of the page can stay focused on the workbench
 *  and the modal lifecycle is local. */
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
  const { orders, loaded: ordersLoaded } = useOrders();

  const { open, claimable } = useMemo(() => {
    const o: OrderRecord[] = [];
    const c: OrderRecord[] = [];
    for (const ord of orders) {
      if (ord.status === "matching") o.push(ord);
      else if (ord.status === "claimable") c.push(ord);
    }
    return { open: o, claimable: c };
  }, [orders]);

  const [withdrawNote, setWithdrawNote] = useState<VaultNote | null>(null);

  // Three-bucket aggregation per symbol: Available (spendable now),
  // Locked (pinned by an open order — release path depends on the
  // pinning order's status), Pending (deposits awaiting
  // reconciliation, or change residuals awaiting settle). Naive
  // `Number` parsing is acceptable for the panel header; precise
  // BigInt math runs on the spend / withdraw paths so a rounding
  // wobble here can't drift real balances.
  const symbolBuckets = useMemo(
    () => aggregateBySymbol(notes, orders),
    [notes, orders],
  );

  // Build a per-note status map ONCE per (notes × orders) change
  // so the notes list render can do an O(1) lookup per row. The
  // previous per-row `deriveNoteStatus(n, orders)` was O(notes ×
  // orders), which is invisible at today's sizes but degrades as
  // the vault and order count grow.
  //
  // Gated on `ordersLoaded` — if notes hydrate before orders do,
  // computing status against an empty `orders` would flash every
  // note as Available (Withdraw enabled) for a tick. We instead
  // return an empty map, which the consumer renders as a
  // "Loading…" state without enabling write actions.
  const noteStatusMap = useMemo(() => {
    if (!ordersLoaded) return new Map<string, NoteStatusInfo>();
    const m = new Map<string, NoteStatusInfo>();
    for (const n of notes) m.set(n.id, deriveNoteStatus(n, orders));
    return m;
  }, [notes, orders, ordersLoaded]);

  return (
    <aside className="col-span-3 space-y-4">
      {/* Total */}
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
        <button
          onClick={onDeposit}
          className="mt-3 w-full rounded-md border border-[var(--color-border-strong)] bg-white py-2 text-sm font-medium hover:bg-[var(--color-primary-soft)]"
        >
          + Deposit
        </button>
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

      {/* Notes */}
      <Section title={`Notes (${notes.length})`}>
        {notes.length === 0 ? (
          <EmptyState>Deposit to start.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => {
              // While orders are still hydrating from the folder
              // adapter, treat every note as locked-pending — keep
              // Withdraw disabled so a note funding an open order
              // can't be double-spent during the race window.
              const info: NoteStatusInfo =
                noteStatusMap.get(n.id) ??
                (ordersLoaded
                  ? { status: "available" }
                  : { status: "pending" });
              return (
                <li
                  key={n.id}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5"
                >
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-[var(--color-text-muted)]">
                      {n.label}
                      <span className="ml-1 text-[10px] text-[var(--color-text-subtle)]">
                        {n.leafIndex >= 0 ? `· leaf #${n.leafIndex}` : "· leaf pending"}
                      </span>
                    </span>
                    {/* Only Available notes can be withdrawn directly.
                        Locked is releasable via the order's Cancel; Pending
                        needs the chain to catch up. The button stays
                        visible to anchor the row geometry, just disabled
                        with a reason in `title`. */}
                    <button
                      onClick={() => info.status === "available" && setWithdrawNote(n)}
                      disabled={info.status !== "available"}
                      title={lockedNoteHint(info)}
                      className="font-medium text-[var(--color-primary)] hover:underline disabled:cursor-not-allowed disabled:text-[var(--color-text-subtle)] disabled:no-underline"
                    >
                      Withdraw
                    </button>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-2">
                    <span className="font-mono text-sm font-semibold">
                      {n.amount} {n.symbol}
                    </span>
                    <NoteStatusBadge info={info} />
                  </div>
                  {/* Visible reason hint when withdraw isn't available
                      — native `title` attrs don't fire on touch / for AT
                      users. Matches the workbench Sign & submit hint
                      pattern. */}
                  {info.status !== "available" && (
                    <p
                      role="status"
                      className="mt-1 text-[10px] text-[var(--color-text-subtle)]"
                    >
                      {lockedNoteHint(info)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <WithdrawModal
        open={!!withdrawNote}
        onClose={() => setWithdrawNote(null)}
        initialNote={withdrawNote}
      />
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
}: {
  order: OrderRecord;
  selected: boolean;
  onSelect: () => void;
  pastTense?: boolean;
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
          <StatusBadge status={order.status} />
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

/** Human-readable reason why a non-Available note can't be
 *  withdrawn directly. Split from the inline JSX so the same
 *  string powers both the disabled-button `title` (desktop
 *  hover) and the visible `role=status` hint underneath (touch
 *  + AT). Tailors the locked branch by the pinning order's
 *  status — `matching` is cancellable, `claimable` is past
 *  cancel and clears on settle. */
function lockedNoteHint(info: NoteStatusInfo): string | undefined {
  if (info.status === "available") return undefined;
  if (info.status === "locked") {
    const label = info.lockedByOrder?.label ?? "an open order";
    if (info.lockedByOrder?.status === "claimable") {
      return `Locked by ${label}. Clears once recipients claim and the funding note settles on-chain.`;
    }
    return `Locked by ${label}. Cancel the order to release this note.`;
  }
  // pending
  if (info.pendingFromOrder) {
    return `Pending change from ${info.pendingFromOrder.label}. Available after settle.`;
  }
  return "Awaiting on-chain confirmation.";
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

function NoteStatusBadge({ info }: { info: NoteStatusInfo }) {
  if (info.status === "available") return null;
  if (info.status === "locked") {
    return (
      <span
        className="rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-warning)]"
        title={lockedNoteHint(info)}
      >
        Locked · {info.lockedByOrder?.label ?? "open order"}
      </span>
    );
  }
  // pending
  return (
    <span
      className="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
      title={
        info.pendingFromOrder
          ? `Change from ${info.pendingFromOrder.label}. Becomes available after settle.`
          : "Awaiting on-chain confirmation"
      }
    >
      Pending
      {info.pendingFromOrder ? ` · change from ${info.pendingFromOrder.label}` : ""}
    </span>
  );
}
