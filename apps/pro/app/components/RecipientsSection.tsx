"use client";

import { Button } from "@zkscatter/ui";
import { useTradeForm, type RecipientRow } from "../lib/tradeForm";
import { useConfirm } from "../lib/useConfirm";

const MAX_RECIPIENTS = 16;

/** Recipients + per-row release schedule. Surfaced as a top-level
 *  form section (not behind the Advanced toggle) because the
 *  multi-recipient distribution + per-row delay is core to Pro's
 *  pitch — hiding it behind ▸ Advanced makes a launch-feature
 *  invisible to first-time users. The expiry / max-fee knobs stay
 *  in `AdvancedSettings`. */
export function RecipientsSection() {
  const {
    recipients,
    addRecipient,
    removeRecipient,
    updateRecipient,
    resetRecipients,
  } = useTradeForm();
  const { confirm, dialog: confirmDialog } = useConfirm();

  return (
    <section className="mt-4 space-y-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Recipients ({recipients.length}/{MAX_RECIPIENTS})
        </span>
        <button
          type="button"
          onClick={async () => {
            // Single empty row is the default — no work to lose, skip
            // the prompt. Confirm only when the user has actually
            // built up a multi-recipient list.
            const hasInput =
              recipients.length > 1 ||
              recipients[0]?.address.trim() !== "" ||
              recipients[0]?.amount.trim() !== "";
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
      <div className="space-y-1.5">
        {recipients.map((r, i) => (
          <RecipientRowItem
            key={r.id}
            index={i}
            row={r}
            canRemove={recipients.length > 1}
            onChange={updateRecipient}
            onRemove={() => removeRecipient(r.id)}
          />
        ))}
      </div>
      {recipients.length < MAX_RECIPIENTS && (
        <Button size="sm" variant="secondary" onClick={addRecipient}>
          + Add recipient
        </Button>
      )}
      <p className="text-[11px] text-[var(--color-text-subtle)]">
        Up to 16 recipients per order. Empty address = your own wallet.
        Per-row delay schedules each release.
      </p>
      {confirmDialog}
    </section>
  );
}

function RecipientRowItem({
  index,
  row,
  canRemove,
  onChange,
  onRemove,
}: {
  index: number;
  row: RecipientRow;
  canRemove: boolean;
  onChange: <K extends keyof RecipientRow>(id: number, field: K, value: RecipientRow[K]) => void;
  onRemove: () => void;
}) {
  // Two-row card. A single 7-column horizontal grid got crushed in
  // the workbench's col-span-5 slot; splitting into "address row" +
  // "amount/schedule row" gives the 0x… input the width it needs at
  // any container size while keeping the recipient self-contained.
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
      <div className="grid grid-cols-[auto_1fr_auto_5rem_4rem] items-center gap-1.5 pl-7">
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
          Delay
        </span>
        <input
          type="number"
          min={0}
          value={row.delay}
          onChange={(e) => onChange(row.id, "delay", e.target.value)}
          aria-label={`Recipient ${index + 1} delay`}
          className="w-full rounded border border-[var(--color-border-strong)] bg-white px-1.5 py-1 text-right font-mono"
        />
        <select
          value={row.delayUnit}
          onChange={(e) => onChange(row.id, "delayUnit", e.target.value as RecipientRow["delayUnit"])}
          aria-label={`Recipient ${index + 1} delay unit`}
          className="rounded border border-[var(--color-border-strong)] bg-white px-1 py-1"
        >
          <option value="min">min</option>
          <option value="hr">hr</option>
          <option value="day">day</option>
        </select>
      </div>
    </div>
  );
}
