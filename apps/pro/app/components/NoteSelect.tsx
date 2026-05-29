"use client";

import { useEffect, useMemo, useState } from "react";
import type { VaultNote } from "../lib/vault";
import { Button, Field } from "@zkscatter/ui";
import { useFolder } from "../lib/folder";

interface Props {
  /** Funding-side token address (sellToken). Notes whose `note.token`
   *  doesn't match are hidden — submitting with a mismatched note
   *  would fail at the OrderModal "vault note is in a different
   *  token" gate, so pre-filter here. */
  sellTokenAddress: string;
  /** Symbol shown in the empty-state CTA — "Deposit ETH" reads better
   *  than "Deposit on the left to fund this side", and ties the action
   *  to the side the user is actually trying to fund. */
  sellTokenSymbol: string;
  notes: readonly VaultNote[];
  selectedId: string | null;
  onSelect(id: string | null): void;
  /** Inline Deposit CTA. Hooked to the same `DepositModal` the
   *  position-panel button opens, so users notice the entry point
   *  without having to scan the left column. The token symbol is
   *  passed so the caller can pre-select the right token on the
   *  modal — the trigger label says "+ Deposit USDC" while in
   *  Buy ETH mode, and the modal needs to land on USDC to match. */
  onDeposit(tokenSymbol: string): void;
}

/** Workbench's funding-note picker. Filters by sell-side token and
 *  shows balance per note so the user knows which deposit is about
 *  to back the order. Without this the form defaulted to `notes[0]`
 *  regardless of token, which silently failed at submit when the
 *  first note was in the wrong currency. */
export function NoteSelect({
  sellTokenAddress,
  sellTokenSymbol,
  notes,
  selectedId,
  onSelect,
  onDeposit,
}: Props) {
  const { ready: folderReady } = useFolder();
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

  // `Date.now()` would be different between SSR and the first client
  // paint → hydration mismatch. Defer the ticking reference time to
  // `useEffect` and use `null` (= "no relative age yet") for the
  // server render. A 60s tick keeps "just now" / "Xm old" from
  // freezing while the form stays open without spinning the renderer.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

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
        <div className="space-y-2 rounded-md border border-dashed border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-3">
          <p className="text-xs text-[var(--color-text-muted)]">
            No {sellTokenSymbol} notes in your vault yet. Deposit{" "}
            {sellTokenSymbol} to fund this side of the order.
          </p>
          <Button
            onClick={() => onDeposit(sellTokenSymbol)}
            size="sm"
            block
            disabled={!folderReady}
            title={folderReady ? undefined : "Pick a workspace folder first"}
          >
            {folderReady
              ? `+ Deposit ${sellTokenSymbol}`
              : `Pick a folder to deposit ${sellTokenSymbol}`}
          </Button>
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
            {now !== null ? ` · ${formatRelativeAge(n.createdAt, now)}` : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Coarse relative-time suffix for the funding-note picker so multiple
 *  `lot-N` of the same token are visually distinguishable at a glance.
 *  Granularity caps at days — anything more precise would shift inside
 *  the dropdown between clicks. */
function formatRelativeAge(createdAtMs: number, nowMs: number): string {
  const ageMs = nowMs - createdAtMs;
  if (ageMs < 60_000) return "just now";
  const mins = Math.floor(ageMs / 60_000);
  if (mins < 60) return `${mins}m old`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h old`;
  const days = Math.floor(hours / 24);
  return `${days}d old`;
}
