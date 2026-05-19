"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@zkscatter/ui";
import { useVault, type VaultNote } from "../lib/vault";
import { useOrders, type OrderRecord } from "../lib/orders";
import { aggregateBySymbol, deriveNoteStatus, type NoteStatusInfo } from "../lib/noteStatus";
import { WithdrawModal } from "./WithdrawModal";
import { CancelOrderModal } from "./CancelOrderModal";
import { ClaimModal } from "./ClaimModal";
import { StatusBadge, StatusProgress } from "./StatusBadge";

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
  /** Opens the page-level `DepositModal`. The modal moved out of
   *  this panel so the workbench can trigger it from `NoteSelect`
   *  too — two `DepositModal` instances would race on the vault's
   *  `addNote` write. */
  onDeposit: () => void;
}

export function MyPositionPanel({ onDeposit }: Props) {
  const { notes } = useVault();
  const { orders } = useOrders();

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
  const [cancelOrder, setCancelOrder] = useState<OrderRecord | null>(null);
  const [claimOrder, setClaimOrder] = useState<OrderRecord | null>(null);

  // Three-bucket aggregation per symbol: Available (spendable now),
  // Locked (pinned by an open order — releaseable via Cancel),
  // Pending (deposits awaiting reconciliation, or change residuals
  // awaiting settle). Naive `Number` parsing is acceptable for the
  // panel header; precise BigInt math runs on the spend / withdraw
  // paths so a rounding wobble here can't drift real balances.
  const symbolBuckets = useMemo(
    () => aggregateBySymbol(notes, orders),
    [notes, orders],
  );

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
          <div className="space-y-2 text-sm">
            {symbolBuckets.map((b) => (
              <div key={b.symbol}>
                <div className="font-mono text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  {b.symbol}
                </div>
                <BucketRow label="Available" value={b.available} tone="default" />
                {b.locked > 0 && (
                  <BucketRow label="Locked" value={b.locked} tone="locked" />
                )}
                {b.pending > 0 && (
                  <BucketRow label="Pending" value={b.pending} tone="pending" />
                )}
              </div>
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
      <Section title={`Open orders (${open.length})`}>
        {open.length === 0 ? (
          <EmptyState>No open orders. Place one on the right →</EmptyState>
        ) : (
          <ul className="space-y-2">
            {open.map((o) => (
              <li
                key={o.id}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-semibold">{o.label}</span>
                  <StatusBadge status={o.status} />
                </div>
                <div className="mt-1 flex items-baseline justify-between text-xs text-[var(--color-text-muted)]">
                  <span>
                    {o.side === "sell" ? "Sell" : "Buy"} {o.size} @ {o.price}
                  </span>
                  <button
                    onClick={() => setCancelOrder(o)}
                    className="font-medium text-[var(--color-danger)] hover:underline"
                  >
                    Cancel
                  </button>
                </div>
                <div className="mt-2">
                  <StatusProgress status={o.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Ready to claim */}
      <Section title={`Ready to claim (${claimable.length})`}>
        {claimable.length === 0 ? (
          <EmptyState>Nothing to claim right now.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {claimable.map((o) => (
              <li
                key={o.id}
                className="rounded-md border border-[var(--color-success-soft)] bg-[var(--color-success-soft)] p-2.5"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-semibold">{o.label}</span>
                  <StatusBadge status={o.status} />
                </div>
                <div className="mt-1 flex items-baseline justify-between text-xs text-[var(--color-text-muted)]">
                  <span>
                    {o.side === "sell" ? "Sold" : "Bought"} {o.size} @ {o.price}
                  </span>
                  <button
                    onClick={() => setClaimOrder(o)}
                    className="rounded bg-[var(--color-success)] px-2 py-0.5 text-[11px] font-medium text-white hover:opacity-90"
                  >
                    Claim
                  </button>
                </div>
              </li>
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
              const info = deriveNoteStatus(n, orders);
              return (
                <li
                  key={n.id}
                  className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5"
                >
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="text-[var(--color-text-muted)]">{n.label}</span>
                    {/* Only Available notes can be withdrawn directly.
                        Locked is releasable via the order's Cancel; Pending
                        needs the chain to catch up. The button stays
                        visible to anchor the row geometry, just disabled
                        with a reason in `title`. */}
                    <button
                      onClick={() => info.status === "available" && setWithdrawNote(n)}
                      disabled={info.status !== "available"}
                      title={
                        info.status === "locked"
                          ? `Locked by ${info.lockedByOrder?.label ?? "an open order"}. Cancel it to release.`
                          : info.status === "pending"
                            ? info.pendingFromOrder
                              ? `Pending change from ${info.pendingFromOrder.label}. Available after settle.`
                              : "Awaiting on-chain confirmation."
                            : undefined
                      }
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
      <CancelOrderModal
        open={!!cancelOrder}
        onClose={() => setCancelOrder(null)}
        order={cancelOrder}
      />
      <ClaimModal
        open={!!claimOrder}
        onClose={() => setClaimOrder(null)}
        order={claimOrder}
      />
    </aside>
  );
}

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      {title && (
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function BucketRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "default" | "locked" | "pending";
}) {
  const labelClass =
    tone === "locked"
      ? "text-[var(--color-warning)]"
      : tone === "pending"
        ? "text-[var(--color-text-subtle)]"
        : "text-[var(--color-text-muted)]";
  const valueClass =
    tone === "default"
      ? "font-semibold text-[var(--color-text)]"
      : "font-medium text-[var(--color-text-muted)]";
  return (
    <div className="flex items-baseline justify-between font-mono text-xs">
      <span className={labelClass}>{label}</span>
      <span className={valueClass}>{formatNum(value)}</span>
    </div>
  );
}

function NoteStatusBadge({ info }: { info: NoteStatusInfo }) {
  if (info.status === "available") return null;
  if (info.status === "locked") {
    return (
      <span
        className="rounded border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-warning)]"
        title="Funds an open order — cancel to release"
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
