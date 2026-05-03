"use client";

import { ethers } from "ethers";
import type { VaultNote } from "@zkscatter/sdk/react";
import type { SourceNotesPick } from "../../../_lib/sourceNotes";

export interface SourceNotesPanelProps {
  token: string;
  decimals: number;
  account: string | null;
  vaultLoaded: boolean;
  availableRaw: bigint;
  pendingRaw: bigint;
  /** Wei still missing relative to the run's `totalEscrowRaw`. The
   *  panel renders the shortfall warning + deposit CTA inline so
   *  the operator doesn't have to scroll past the source-notes box
   *  to find a separate banner. */
  shortfallRaw: bigint;
  /** Every vault note matching the current token, regardless of
   *  reconciler state. Drives the per-deposit listing the operator
   *  uses to confirm what's available before signing. */
  tokenNotes: readonly VaultNote[];
  sourcePick: SourceNotesPick;
  /** Set of vault note ids the operator manually selected for this
   *  run; flipping a checkbox toggles membership through `onToggle`.
   *  When the selection is empty the wizard falls back to the
   *  auto-pick `sourcePick`. */
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Wired to FundsStep's deposit modal so the empty state can
   *  surface a primary CTA instead of the operator hunting for the
   *  shortfall banner below. Optional so other surfaces can reuse
   *  the panel read-only. */
  onDeposit?: () => void;
  /** True when the deposit env is wired (relayer registry / WETH /
   *  pool addresses set). When false, the inline CTA is rendered
   *  but disabled with the same "env not configured" hint the
   *  shortfall banner uses. */
  depositConfigured?: boolean;
}

/** Read-only view of the auto-picked source notes for the run plus
 *  the pending/available split. Gated on wallet + vault load — until
 *  the vault has settled, "your notes" would flicker between empty
 *  and populated. */
export function SourceNotesPanel({
  token,
  decimals,
  account,
  vaultLoaded,
  availableRaw,
  pendingRaw,
  shortfallRaw,
  tokenNotes,
  sourcePick,
  selectedIds,
  onToggle,
  onDeposit,
  depositConfigured = true,
}: SourceNotesPanelProps) {
  const fmt = (raw: bigint) => ethers.formatUnits(raw, decimals);

  if (!account) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Connect a wallet to see your deposited balance.
      </div>
    );
  }
  if (!vaultLoaded) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Reading your deposits…
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Deposit balance (notes)</h3>
        <button
          disabled
          title="Manual selection arrives in Phase E"
          className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-[var(--color-text-subtle)] opacity-40"
        >
          Change selection
        </button>
      </div>
      <div className="mb-2 text-[var(--color-text-muted)]">
        Ready to spend:{" "}
        <span className="font-mono">
          {fmt(availableRaw)} {token}
        </span>
        {pendingRaw > 0n && (
          <>
            {" · Confirming: "}
            <span className="font-mono">
              {fmt(pendingRaw)} {token}
            </span>
          </>
        )}
      </div>
      {pendingRaw > 0n && (
        <div className="mb-2 text-[var(--color-text-subtle)]">
          Confirming deposits are on-chain but waiting for the next block —
          they become spendable shortly.
        </div>
      )}
      {tokenNotes.length > 0 && (
        <>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
            Your deposits ({tokenNotes.length}) — check the ones to spend
          </div>
          <table className="w-full text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
              <tr>
                <th className="py-1 w-8" />
                <th className="py-1 text-left">Status</th>
                <th className="py-1 text-left">Label · Deposited</th>
                <th className="py-1 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {tokenNotes.map((n) => {
                const ready = n.leafIndex >= 0;
                const checked = selectedIds.has(n.id);
                return (
                  <tr key={n.id} className="border-t border-[var(--color-border)]">
                    <td className="py-1.5 align-middle">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!ready}
                        onChange={() => onToggle(n.id)}
                        title={
                          !ready
                            ? "Confirming on-chain — selectable after one block"
                            : undefined
                        }
                      />
                    </td>
                    <td className="py-1.5">
                      {ready ? (
                        <span className="rounded-full bg-[var(--color-primary-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-primary)]">
                          Ready
                        </span>
                      ) : (
                        <span className="rounded-full bg-[var(--color-bg)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-text-muted)]">
                          Confirming
                        </span>
                      )}
                    </td>
                    <td className="py-1.5">
                      <span className="font-mono">{n.label}</span>{" "}
                      <span className="text-[var(--color-text-muted)]">
                        · {new Date(n.createdAt).toISOString().slice(0, 10)}
                      </span>
                    </td>
                    <td className="py-1.5 text-right font-mono">
                      {fmt(n.note.amount)} {token}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
      {shortfallRaw > 0n && (() => {
        // The shortfall in `shortfallRaw` only counts what's spendable
        // RIGHT NOW (leafIndex ≥ 0). Pending deposits cover part of it
        // automatically once the next block lands and the reconciler
        // assigns leaf indices. Surface that as a "wait" state instead
        // of asking the operator to deposit again.
        const remaining =
          shortfallRaw > pendingRaw ? shortfallRaw - pendingRaw : 0n;
        const fullyCoveredByPending = remaining === 0n;
        return (
          <div
            className={`mt-3 rounded-md border p-3 ${
              fullyCoveredByPending
                ? "border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)]"
                : "border-[var(--color-warning)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]"
            }`}
          >
            <div className="mb-2">
              {fullyCoveredByPending ? (
                <>
                  Your{" "}
                  <strong>
                    {fmt(pendingRaw)} {token}
                  </strong>{" "}
                  deposit is confirming on-chain. Wait one block — it
                  becomes spendable automatically.
                </>
              ) : availableRaw > 0n || pendingRaw > 0n ? (
                <>
                  Shortfall:{" "}
                  <strong>
                    {fmt(remaining)} {token}
                  </strong>
                  . Deposit more to escrow to close the gap.
                </>
              ) : (
                <>
                  No escrow balance available to send. Deposit{" "}
                  <strong>
                    {fmt(remaining)} {token}
                  </strong>{" "}
                  into escrow to fund this run.
                </>
              )}
            </div>
            {!fullyCoveredByPending && onDeposit && (
              <button
                onClick={depositConfigured ? onDeposit : undefined}
                disabled={!depositConfigured}
                title={depositConfigured ? undefined : "Deposit env not configured"}
                className="rounded-md bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
              >
                {depositConfigured
                  ? `Deposit ${fmt(remaining)} ${token}`
                  : "Deposit (env not configured)"}
              </button>
            )}
          </div>
        );
      })()}
    </div>
  );
}
