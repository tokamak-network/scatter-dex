"use client";

import { useTradeForm, type RecipientRow } from "../lib/tradeForm";
import { useConfirm } from "../lib/useConfirm";
import { Button } from "@zkscatter/ui";

const EXPIRY_PRESETS: Array<{ key: "15m" | "1h" | "4h" | "24h" | "7d"; label: string }> = [
  { key: "15m", label: "15m" },
  { key: "1h", label: "1h" },
  { key: "4h", label: "4h" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
];

const MAX_RECIPIENTS = 16;

/** Collapsible Advanced section of the order form. Hidden behind a
 *  single ▸ toggle so first-time users see the simple flow only.
 *  Power features (multi-recipient distribution, custom expiry,
 *  max-fee tuning) live here — defaults are chosen so 95% of users
 *  never expand. */
export function AdvancedSettings() {
  const {
    advancedOpen, setAdvancedOpen,
    recipients, addRecipient, removeRecipient, updateRecipient, resetRecipients,
    expiry, setExpiry,
    maxFeeBps, setMaxFeeBps,
  } = useTradeForm();
  const { confirm, dialog: confirmDialog } = useConfirm();

  if (!advancedOpen) {
    return (
      <button
        type="button"
        onClick={() => setAdvancedOpen(true)}
        className="mt-3 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
      >
        ▸ Advanced settings
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
          Advanced settings
        </span>
        <button
          type="button"
          onClick={() => setAdvancedOpen(false)}
          className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
        >
          ▾ Hide
        </button>
      </div>

      {/* Multi-recipient distribution */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-[var(--color-text-muted)]">
            Recipients ({recipients.length}/{MAX_RECIPIENTS})
          </span>
          <button
            type="button"
            onClick={async () => {
              // Single empty row is the default — no work to lose,
              // skip the prompt. Confirm only when the user has
              // actually built up a multi-recipient list.
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
          Up to 16 recipients in one private order. Empty address = your
          own wallet. Stealth mode derives a fresh one-time recipient
          from the recipient&apos;s meta-address (<code>st:eth:0x…</code>) per
          order — only the recipient can spend it.
        </p>
      </section>

      {/* Order validity */}
      <section className="space-y-1.5">
        <span className="block text-xs font-semibold text-[var(--color-text-muted)]">
          Order valid until
        </span>
        <div className="flex flex-wrap gap-1">
          {EXPIRY_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setExpiry(p.key)}
              className={`rounded px-2 py-1 text-xs font-medium ${
                expiry === p.key
                  ? "bg-[var(--color-primary)] text-white"
                  : "border border-[var(--color-border-strong)] hover:border-[var(--color-primary)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </section>

      {/* Max relayer fee */}
      <section className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-[var(--color-text-muted)]">
            Max relayer fee
          </span>
          <span className="font-mono text-xs">{maxFeeBps} bps</span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={maxFeeBps}
          onChange={(e) => setMaxFeeBps(Number(e.target.value))}
          className="w-full"
        />
        <p className="text-[11px] text-[var(--color-text-subtle)]">
          Hard cap. Relayers compete below this — quoted fee shown at submit.
        </p>
      </section>
      {confirmDialog}
    </div>
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
  // 7 columns: index · mode · address (fr) · amount · delay · delayUnit · remove
  return (
    <div className="grid grid-cols-[auto_5rem_1fr_5rem_4rem_3rem_auto] items-center gap-1.5 text-xs">
      <span className="font-mono text-[var(--color-text-subtle)]">#{index + 1}</span>
      <select
        value={row.mode}
        onChange={(e) => onChange(row.id, "mode", e.target.value as RecipientRow["mode"])}
        className="rounded border border-[var(--color-border-strong)] bg-white px-1.5 py-1"
      >
        <option value="regular">Regular</option>
        <option value="stealth">Stealth</option>
      </select>
      <input
        type="text"
        placeholder={row.mode === "stealth" ? "st:eth:0x…" : "0x… (empty = self)"}
        value={row.address}
        onChange={(e) => onChange(row.id, "address", e.target.value)}
        className="rounded border border-[var(--color-border-strong)] bg-white px-1.5 py-1 font-mono text-[11px]"
      />
      <input
        type="text"
        placeholder="amt"
        value={row.amount}
        onChange={(e) => onChange(row.id, "amount", e.target.value)}
        className="rounded border border-[var(--color-border-strong)] bg-white px-1.5 py-1 text-right font-mono"
      />
      <input
        type="number"
        min={0}
        value={row.delay}
        onChange={(e) => onChange(row.id, "delay", e.target.value)}
        className="rounded border border-[var(--color-border-strong)] bg-white px-1.5 py-1 text-right font-mono"
      />
      <select
        value={row.delayUnit}
        onChange={(e) => onChange(row.id, "delayUnit", e.target.value as RecipientRow["delayUnit"])}
        className="rounded border border-[var(--color-border-strong)] bg-white px-1 py-1"
      >
        <option value="min">min</option>
        <option value="hr">hr</option>
        <option value="day">day</option>
      </select>
      <button
        type="button"
        onClick={onRemove}
        disabled={!canRemove}
        aria-label="Remove recipient"
        className="rounded p-0.5 text-[var(--color-text-subtle)] hover:text-[var(--color-danger)] disabled:opacity-30"
      >
        ×
      </button>
    </div>
  );
}
