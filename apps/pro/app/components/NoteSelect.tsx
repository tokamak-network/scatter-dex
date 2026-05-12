"use client";

import { useMemo } from "react";
import type { VaultNote } from "../lib/vault";
import { Field } from "@zkscatter/ui";

interface Props {
  /** Funding-side token address (sellToken). Notes whose `note.token`
   *  doesn't match are hidden — submitting with a mismatched note
   *  would fail at the OrderModal "vault note is in a different
   *  token" gate, so pre-filter here. */
  sellTokenAddress: string;
  notes: readonly VaultNote[];
  selectedId: string | null;
  onSelect(id: string | null): void;
}

/** Workbench's funding-note picker. Filters by sell-side token and
 *  shows balance per note so the user knows which deposit is about
 *  to back the order. Without this the form defaulted to `notes[0]`
 *  regardless of token, which silently failed at submit when the
 *  first note was in the wrong currency. */
export function NoteSelect({ sellTokenAddress, notes, selectedId, onSelect }: Props) {
  const matching = useMemo(
    () =>
      notes.filter(
        (n) => n.note.token === BigInt(sellTokenAddress.toLowerCase()),
      ),
    [notes, sellTokenAddress],
  );

  // Auto-reset the selection when it falls outside the filtered set
  // (token change, withdrawal, etc.). Done at render rather than in
  // an effect so the workbench's `note` prop stays consistent with
  // what's actually in the dropdown.
  if (selectedId && !matching.some((n) => n.id === selectedId)) {
    // Defer the parent state update until after render to avoid a
    // setState-in-render warning. `queueMicrotask` is enough — we
    // want the reset visible on the very next commit, not the next
    // frame.
    queueMicrotask(() => onSelect(matching[0]?.id ?? null));
  }

  if (matching.length === 0) {
    return (
      <Field label="Fund with">
        <div className="rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-xs text-[var(--color-text-muted)]">
          No matching notes. Deposit on the left to fund this side.
        </div>
      </Field>
    );
  }

  return (
    <Field label="Fund with">
      <select
        value={selectedId ?? matching[0]!.id}
        onChange={(e) => onSelect(e.target.value)}
        className="w-full rounded-md border border-[var(--color-border-strong)] bg-white px-3 py-2 font-mono text-sm"
      >
        {matching.map((n) => (
          <option key={n.id} value={n.id}>
            {n.label} · {n.amount} {n.symbol}
          </option>
        ))}
      </select>
    </Field>
  );
}
