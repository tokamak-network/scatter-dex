"use client";

import { ethers } from "ethers";
import type { SourceNotesPick } from "../../../_lib/sourceNotes";

export interface SourceNotesPanelProps {
  token: string;
  decimals: number;
  account: string | null;
  vaultLoaded: boolean;
  availableRaw: bigint;
  pendingRaw: bigint;
  sourcePick: SourceNotesPick;
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
  sourcePick,
}: SourceNotesPanelProps) {
  const fmt = (raw: bigint) => ethers.formatUnits(raw, decimals);

  if (!account) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Connect a wallet to see your source notes.
      </div>
    );
  }
  if (!vaultLoaded) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
        Reading your vault…
      </div>
    );
  }

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Source notes (auto-pick)</h3>
        <button
          disabled
          title="Manual selection arrives in Phase E"
          className="rounded border border-[var(--color-border-strong)] px-2 py-1 text-[var(--color-text-subtle)] opacity-40"
        >
          Change selection
        </button>
      </div>
      <div className="mb-2 text-[var(--color-text-muted)]">
        Available:{" "}
        <span className="font-mono">
          {fmt(availableRaw)} {token}
        </span>
        {pendingRaw > 0n && (
          <>
            {" · Pending: "}
            <span className="font-mono">
              {fmt(pendingRaw)} {token}
            </span>
          </>
        )}
      </div>
      {pendingRaw > 0n && (
        <div className="mb-2 text-[var(--color-text-subtle)]">
          Pending notes are deposited but waiting for the next block — they become spendable once
          the reconciler observes them.
        </div>
      )}
      {sourcePick.notes.length > 0 ? (
        <ul className="space-y-0.5 font-mono">
          {sourcePick.notes.map(({ note: n, spend }) => (
            <li key={n.id} className="flex justify-between">
              <span>
                {n.label} · deposited {new Date(n.createdAt).toISOString().slice(0, 10)}
              </span>
              <span>
                {fmt(spend)} / {fmt(n.note.amount)} {token}
              </span>
            </li>
          ))}
          <li className="mt-2 flex justify-between border-t border-[var(--color-border)] pt-2 text-[var(--color-text-muted)]">
            <span>Change after run (new note)</span>
            <span>
              {fmt(sourcePick.changeRaw)} {token}
            </span>
          </li>
        </ul>
      ) : (
        <div className="text-[var(--color-text-muted)]">
          {availableRaw > 0n
            ? "Matching notes are available, but they don't cover the run total. Deposit below to close the shortfall."
            : "No matching notes yet. Deposit below to fund this run."}
        </div>
      )}
    </div>
  );
}
