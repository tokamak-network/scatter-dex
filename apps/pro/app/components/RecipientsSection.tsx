"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@zkscatter/ui";
import { useTradeForm, type RecipientRow } from "../lib/tradeForm";
import { useConfirm } from "../lib/useConfirm";
import { useWalletBook } from "../lib/walletBook";
import { AddressBookPicker } from "./AddressBookPicker";
import { parseUnits } from "../lib/parseUnits";
import { formatTokenAmount } from "../lib/format";

const MAX_RECIPIENTS = 16;

interface RecipientsSectionProps {
  /** Quote-token symbol displayed alongside amount inputs so the
   *  user knows what currency the amounts are in (e.g. `USDC`). */
  quoteSymbol: string;
  /** Display string for the order's projected receive total (the
   *  `buyAmount`). Used by the `Split equally` helper to spread
   *  across rows and by the live sum/balance feedback. */
  receiveTotal: string;
  /** Decimals of the buy-side token. The live sum compares against
   *  `parseUnits(receiveTotal, decimals)` so rounding doesn't lie
   *  about an order that would actually pass validation. */
  receiveDecimals: number;
}

/** Recipients + per-row absolute release datetime. Surfaced as a
 *  top-level form section (not behind Advanced) because multi-
 *  recipient distribution + schedule is core to Pro's pitch. */
export function RecipientsSection({
  quoteSymbol,
  receiveTotal,
  receiveDecimals,
}: RecipientsSectionProps) {
  const {
    recipients,
    addRecipient,
    removeRecipient,
    updateRecipient,
    resetRecipients,
    setRecipients,
    splitEqually,
  } = useTradeForm();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const walletBook = useWalletBook();
  const [pickerOpen, setPickerOpen] = useState(false);

  const onPickFromBook = useCallback(
    (picked: typeof walletBook.entries) => {
      // Replace the rows with one per picked entry. The wizard
      // pattern from Pay matches what users expect — "I picked 3
      // contacts, I now see 3 rows" — instead of merging into the
      // current set.
      if (picked.length === 0) {
        setPickerOpen(false);
        return;
      }
      const rows: RecipientRow[] = picked.slice(0, MAX_RECIPIENTS).map((e, i) => ({
        id: Date.now() + i,
        address: e.address ?? "",
        amount: "",
        releaseAt: "",
      }));
      setRecipients(rows);
      setPickerOpen(false);
    },
    [setRecipients],
  );

  // Live sum across rows + delta vs the order's projected receive
  // total. Users get immediate feedback that their split adds up
  // (or doesn't) without having to wait for the submit-time
  // `resolveClaims` error. Track the first row whose amount didn't
  // parse — silently summing past it would hide validation errors
  // until submit and surface as a misleading "short by X" delta.
  const { sumStr, deltaStr, balanced, invalidRow } = useMemo(() => {
    if (!receiveTotal || receiveTotal.replace(/,/g, "") === "") {
      return { sumStr: "—", deltaStr: "", balanced: false, invalidRow: null };
    }
    let target: bigint;
    try {
      target = parseUnits(receiveTotal.replace(/,/g, ""), receiveDecimals);
    } catch {
      return { sumStr: "—", deltaStr: "", balanced: false, invalidRow: null };
    }
    let sum = 0n;
    let firstInvalid: number | null = null;
    recipients.forEach((r, i) => {
      if (!r.amount.trim()) return;
      try {
        sum += parseUnits(r.amount.replace(/,/g, ""), receiveDecimals);
      } catch {
        if (firstInvalid === null) firstInvalid = i + 1;
      }
    });
    const balanced = sum === target && firstInvalid === null;
    const diff = sum > target ? sum - target : target - sum;
    return {
      sumStr: `${formatTokenAmount(sum, receiveDecimals)} ${quoteSymbol}`,
      deltaStr: balanced
        ? ""
        : `${sum > target ? "over" : "short"} by ${formatTokenAmount(diff, receiveDecimals)} ${quoteSymbol}`,
      balanced,
      invalidRow: firstInvalid,
    };
  }, [recipients, receiveTotal, receiveDecimals, quoteSymbol]);

  return (
    <section className="mt-4 space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Recipients ({recipients.length}/{MAX_RECIPIENTS})
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => splitEqually(receiveTotal, receiveDecimals)}
            disabled={!receiveTotal || receiveTotal.replace(/,/g, "") === ""}
            className="text-[11px] font-medium text-[var(--color-primary)] hover:underline disabled:opacity-40"
            title="Spread the projected receive total evenly across all rows"
          >
            Split equally
          </button>
          <span className="text-[var(--color-text-subtle)]">·</span>
          <button
            type="button"
            onClick={async () => {
              // Confirm whenever the user has typed anything across
              // any row — including a `releaseAt` they set without
              // touching address/amount. Without scanning every row +
              // every field the reset can silently nuke a non-trivial
              // schedule with no prompt.
              const hasInput = recipients.some(
                (r) =>
                  r.address.trim() !== "" ||
                  r.amount.trim() !== "" ||
                  r.releaseAt.trim() !== "",
              );
              if (hasInput) {
                const ok = await confirm({
                  title: "Reset recipients?",
                  message: "Any addresses and amounts you've entered will be cleared.",
                  confirmLabel: "Reset",
                  danger: true,
                });
                if (!ok) return;
              }
              resetRecipients();
            }}
            className="text-[11px] text-[var(--color-text-subtle)] hover:text-[var(--color-primary)]"
          >
            Reset
          </button>
        </div>
      </div>

      <div className="space-y-1.5">
        {recipients.map((r, i) => (
          <RecipientRowItem
            key={r.id}
            index={i}
            row={r}
            canRemove={recipients.length > 1}
            quoteSymbol={quoteSymbol}
            onChange={updateRecipient}
            onRemove={() => removeRecipient(r.id)}
          />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {recipients.length < MAX_RECIPIENTS && (
          <Button size="sm" variant="secondary" onClick={addRecipient}>
            + Add recipient
          </Button>
        )}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setPickerOpen(true)}
          disabled={walletBook.entries.length === 0}
          title={
            walletBook.entries.length === 0
              ? "Address book is empty — add contacts on the /address-book page"
              : `Pick from ${walletBook.entries.length} contact${
                  walletBook.entries.length === 1 ? "" : "s"
                }`
          }
        >
          📇 Pick from address book
        </Button>
      </div>

      <p className="text-[11px] text-[var(--color-text-subtle)]">
        Up to 16 recipients per order. Empty address = your own wallet. Empty
        release time = claim immediately on settle.
      </p>
      <div
        className={`flex items-center justify-between text-[11px] ${
          invalidRow !== null
            ? "text-[var(--color-danger)]"
            : balanced
              ? "text-[var(--color-success)]"
              : "text-[var(--color-text-muted)]"
        }`}
      >
        <span>Allocated</span>
        <span className="font-mono">
          {invalidRow !== null
            ? `Recipient #${invalidRow} amount is invalid`
            : `${sumStr}${deltaStr ? ` · ${deltaStr}` : ""}`}
        </span>
      </div>

      {confirmDialog}
      {pickerOpen && (
        <AddressBookPicker
          entries={walletBook.entries}
          onCancel={() => setPickerOpen(false)}
          onPick={onPickFromBook}
        />
      )}
    </section>
  );
}

function RecipientRowItem({
  index,
  row,
  canRemove,
  quoteSymbol,
  onChange,
  onRemove,
}: {
  index: number;
  row: RecipientRow;
  canRemove: boolean;
  quoteSymbol: string;
  onChange: <K extends keyof RecipientRow>(id: number, field: K, value: RecipientRow[K]) => void;
  onRemove: () => void;
}) {
  return (
    <div className="space-y-1.5 rounded-md border border-[var(--color-border)] bg-white p-2 text-xs">
      <div className="grid grid-cols-[auto_1fr_auto] items-center gap-1.5">
        <span className="font-mono text-[var(--color-text-subtle)]">#{index + 1}</span>
        <input
          type="text"
          placeholder="0x… (empty = self)"
          value={row.address}
          onChange={(e) => onChange(row.id, "address", e.target.value)}
          aria-label={`Recipient ${index + 1} address`}
          className="w-full rounded border border-[var(--color-border-strong)] bg-white px-1.5 py-1 font-mono text-[11px]"
        />
        <button
          type="button"
          onClick={onRemove}
          disabled={!canRemove}
          aria-label={`Remove recipient ${index + 1}`}
          className="rounded p-0.5 text-[var(--color-text-subtle)] hover:text-[var(--color-danger)] disabled:opacity-30"
        >
          ×
        </button>
      </div>
      <div className="grid grid-cols-[auto_1fr_auto_auto] items-center gap-1.5 pl-7">
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          Amount
        </span>
        <input
          type="text"
          placeholder="0.0"
          value={row.amount}
          onChange={(e) => onChange(row.id, "amount", e.target.value)}
          aria-label={`Recipient ${index + 1} amount`}
          className="w-full rounded border border-[var(--color-border-strong)] bg-white px-1.5 py-1 text-right font-mono"
        />
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          {quoteSymbol}
        </span>
        <span className="ml-2 text-[10px] uppercase tracking-wide text-[var(--color-text-subtle)]">
          Claim from
        </span>
      </div>
      <div className="pl-7">
        <input
          type="datetime-local"
          value={row.releaseAt}
          onChange={(e) => onChange(row.id, "releaseAt", e.target.value)}
          aria-label={`Recipient ${index + 1} claim release time`}
          className="w-full rounded border border-[var(--color-border-strong)] bg-white px-1.5 py-1 font-mono"
        />
      </div>
    </div>
  );
}
