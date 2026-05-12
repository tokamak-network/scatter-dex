"use client";

import { useEffect, useMemo } from "react";
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
  // BigInt(address.toLowerCase()) on every render added up — the
  // hash is hot when notes is large. Memo the parsed key so the
  // filter is a plain bigint compare per note.
  const sellTokenKey = useMemo(
    () => BigInt(sellTokenAddress.toLowerCase()),
    [sellTokenAddress],
  );
  const matching = useMemo(
    () => notes.filter((n) => n.note.token === sellTokenKey),
    [notes, sellTokenKey],
  );

  // Auto-reset the selection when it falls outside the filtered set
  // (token change, withdrawal, etc.). Effect — not in-render —
  // because the parent's setState during render warns under
  // StrictMode and risks an infinite loop if `onSelect` isn't
  // stabilised with useCallback at the call site.
  const firstId = matching[0]?.id ?? null;
  const selectedIsValid =
    selectedId !== null && matching.some((n) => n.id === selectedId);
  useEffect(() => {
    if (selectedId !== null && !selectedIsValid) {
      onSelect(firstId);
    }
  }, [selectedId, selectedIsValid, firstId, onSelect]);

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
