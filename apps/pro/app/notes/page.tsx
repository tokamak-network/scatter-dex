"use client";

import { useMemo, useState } from "react";
import { EmptyState } from "@zkscatter/ui";
import { useVault, type VaultNote } from "../lib/vault";
import { useOrders } from "../lib/orders";
import {
  aggregateBySymbol,
  deriveNoteStatus,
  type NoteStatusInfo,
} from "../lib/noteStatus";
import { WithdrawModal } from "../components/WithdrawModal";
import { DepositModal } from "../components/DepositModal";
import { WorkspaceBar } from "../components/WorkspaceBar";
import { formatNum, formatWhen } from "../lib/format";

/** Full Escrow page — combines the workbench's pool summary,
 *  notes list and deposit / withdraw actions into one place.
 *  Lives at `/notes` for URL stability but presents as "Escrow"
 *  in the nav and headings (the term "note" was confusing for
 *  the operator audience). */
export default function EscrowPage() {
  const { notes } = useVault();
  const { orders, loaded: ordersLoaded } = useOrders();
  const [withdrawNote, setWithdrawNote] = useState<VaultNote | null>(null);
  const [depositOpen, setDepositOpen] = useState(false);

  const symbolBuckets = useMemo(
    () => aggregateBySymbol(notes, orders),
    [notes, orders],
  );

  // Build a `noteId → NoteStatusInfo` lookup once per (notes,
  // orders) change so the row render below is O(1) instead of
  // re-scanning `orders` for every row. Gated on `ordersLoaded` so
  // pre-hydration we don't paint stale "available" pills against
  // notes that are actually locked by a yet-to-load order.
  const statusMap = useMemo(() => {
    if (!ordersLoaded) return new Map<string, NoteStatusInfo>();
    const m = new Map<string, NoteStatusInfo>();
    for (const n of notes) m.set(n.id, deriveNoteStatus(n, orders));
    return m;
  }, [notes, orders, ordersLoaded]);

  const sorted = useMemo(
    () => notes.slice().sort((a, b) => b.createdAt - a.createdAt),
    [notes],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Escrow</h1>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          Your escrowed balances, every note in the vault, and the
          deposit / withdraw actions tied to them.
        </p>
      </div>

      <WorkspaceBar />

      {/* Pool summary — per-symbol Available / Locked / Pending,
          mirrors the workbench's left-column block. */}
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
            Escrow pool
          </div>
          <button
            type="button"
            onClick={() => setDepositOpen(true)}
            className="rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-1.5 text-sm font-medium hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]"
          >
            + Deposit
          </button>
        </div>
        {symbolBuckets.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">
            No assets yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {symbolBuckets.map((b) => (
              <div
                key={b.symbol}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                    {b.symbol}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
                    Available
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-xl font-bold leading-none">
                  {formatNum(b.available)}
                </div>
                {(b.locked > 0 || b.pending > 0) && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
                    {b.locked > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-warning)] bg-[var(--color-warning-soft)] px-2 py-0.5 font-medium text-[var(--color-warning)]">
                        🔒 <span className="font-mono">{formatNum(b.locked)}</span> locked
                      </span>
                    )}
                    {b.pending > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 py-0.5 font-medium text-[var(--color-text-muted)]">
                        ⏳ <span className="font-mono">{formatNum(b.pending)}</span> pending
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Notes — full table */}
      <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="border-b border-[var(--color-border)] px-5 py-3 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Notes ({notes.length})
        </div>
        {sorted.length === 0 ? (
          <div className="p-5">
            <EmptyState>
              No deposits yet. Use <strong>+ Deposit</strong> above to add a note.
            </EmptyState>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-bg)] text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="px-4 py-2 text-left">Label</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2 text-right">Leaf</th>
                <th className="px-4 py-2 text-right">Deposited</th>
                <th className="px-4 py-2 text-right">Status</th>
                <th className="px-4 py-2 text-right" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((n) => {
                const info: NoteStatusInfo =
                  statusMap.get(n.id) ??
                  (ordersLoaded
                    ? { status: "available" }
                    : { status: "pending" });
                return (
                  <tr
                    key={n.id}
                    className="border-t border-[var(--color-border)]"
                  >
                    <td className="px-4 py-2 font-mono">{n.label}</td>
                    <td className="px-4 py-2 text-right font-mono font-semibold">
                      {n.amount} {n.symbol}
                    </td>
                    <td className="px-4 py-2 text-right font-mono text-xs text-[var(--color-text-muted)]">
                      {n.leafIndex >= 0 ? `#${n.leafIndex}` : "pending"}
                    </td>
                    <td
                      className="px-4 py-2 text-right text-xs text-[var(--color-text-muted)]"
                      // Server pre-renders in the build machine's timezone;
                      // the client re-renders in the viewer's local tz. The
                      // first paint difference is harmless (same instant,
                      // different label) so we suppress the warning here
                      // rather than blocking SSR on a mounted gate.
                      suppressHydrationWarning
                    >
                      {formatWhen(n.createdAt)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <StatusPill info={info} />
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() =>
                          info.status === "available" && setWithdrawNote(n)
                        }
                        disabled={info.status !== "available"}
                        className="text-xs font-medium text-[var(--color-primary)] hover:underline disabled:cursor-not-allowed disabled:text-[var(--color-text-subtle)] disabled:no-underline"
                      >
                        Withdraw
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <WithdrawModal
        open={!!withdrawNote}
        onClose={() => setWithdrawNote(null)}
        initialNote={withdrawNote}
      />
      <DepositModal
        open={depositOpen}
        onClose={() => setDepositOpen(false)}
      />
    </div>
  );
}

function StatusPill({ info }: { info: NoteStatusInfo }) {
  if (info.status === "available") {
    return (
      <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-success)]">
        Available
      </span>
    );
  }
  if (info.status === "locked") {
    return (
      <span
        className="rounded-full bg-[var(--color-warning-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-warning)]"
        title={`Locked by ${info.lockedByOrder?.label ?? "an open order"} — cancel that order to release the funds`}
      >
        Locked · {info.lockedByOrder?.label ?? "open"}
      </span>
    );
  }
  return (
    <span
      className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]"
      title={
        info.pendingFromOrder
          ? `Pending change from ${info.pendingFromOrder.label}`
          : "Awaiting on-chain confirmation"
      }
    >
      Pending
    </span>
  );
}
