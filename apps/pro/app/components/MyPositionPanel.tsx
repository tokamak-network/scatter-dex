"use client";

import { useMemo, useState } from "react";
import { useVault, type VaultNote } from "../lib/vault";
import { useOrders, type OrderRecord } from "../lib/orders";
import { DepositModal } from "./DepositModal";
import { WithdrawModal } from "./WithdrawModal";
import { CancelOrderModal } from "./CancelOrderModal";
import { ClaimModal } from "./ClaimModal";
import { StatusBadge, StatusProgress } from "./StatusBadge";

/** Workbench left column. Replaces the old flat note list with the
 *  four-section "what does my money look like right now" view that a
 *  Pro trader actually scans on every page load:
 *
 *    1. Total private balance — single dollar number + Deposit CTA
 *    2. Open orders — matching, with per-row Cancel
 *    3. Ready to claim — claimable, with Claim CTA
 *    4. Notes — raw note list, with per-row Withdraw
 *
 *  The component owns the modals (Deposit / Withdraw / Cancel /
 *  Claim) so the rest of the page can stay focused on the workbench
 *  and the modal lifecycle is local. */
export function MyPositionPanel() {
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

  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawNote, setWithdrawNote] = useState<VaultNote | null>(null);
  const [cancelOrder, setCancelOrder] = useState<OrderRecord | null>(null);
  const [claimOrder, setClaimOrder] = useState<OrderRecord | null>(null);

  // Naive aggregation — the per-symbol amount string is whatever the
  // user entered at deposit time. A real total in dollars lands when
  // the price oracle hook ships; for now we surface the count of
  // notes plus the per-symbol breakdown so the panel doesn't lie
  // about a number it can't yet compute.
  const symbolTotals = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of notes) {
      const num = Number(String(n.amount).replace(/,/g, ""));
      if (Number.isFinite(num)) m.set(n.symbol, (m.get(n.symbol) ?? 0) + num);
    }
    return Array.from(m.entries());
  }, [notes]);

  return (
    <aside className="col-span-3 space-y-4">
      {/* Total */}
      <Section>
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Private balance
        </div>
        {symbolTotals.length === 0 ? (
          <div className="text-sm text-[var(--color-text-muted)]">No assets yet.</div>
        ) : (
          <div className="space-y-0.5 font-mono text-sm">
            {symbolTotals.map(([sym, total]) => (
              <div key={sym} className="flex justify-between">
                <span className="text-[var(--color-text-muted)]">{sym}</span>
                <span className="font-semibold">{formatNum(total)}</span>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => setDepositOpen(true)}
          className="mt-3 w-full rounded-md border border-[var(--color-border-strong)] bg-white py-2 text-sm font-medium hover:bg-[var(--color-primary-soft)]"
        >
          + Deposit
        </button>
      </Section>

      {/* Open orders */}
      <Section title={`Open orders (${open.length})`}>
        {open.length === 0 ? (
          <Empty>No open orders. Place one on the right →</Empty>
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
          <Empty>Nothing to claim right now.</Empty>
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
          <Empty>Deposit to start.</Empty>
        ) : (
          <ul className="space-y-2">
            {notes.map((n) => (
              <li
                key={n.id}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5"
              >
                <div className="flex items-baseline justify-between text-xs">
                  <span className="text-[var(--color-text-muted)]">{n.label}</span>
                  <button
                    onClick={() => setWithdrawNote(n)}
                    className="font-medium text-[var(--color-primary)] hover:underline"
                  >
                    Withdraw
                  </button>
                </div>
                <div className="mt-0.5 font-mono text-sm font-semibold">
                  {n.amount} {n.symbol}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <DepositModal open={depositOpen} onClose={() => setDepositOpen(false)} />
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

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-center text-xs text-[var(--color-text-muted)]">
      {children}
    </div>
  );
}

function formatNum(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
}
