"use client";

import { useTradeForm } from "../lib/tradeForm";

const EXPIRY_PRESETS: Array<{ key: "15m" | "1h" | "4h" | "24h" | "7d"; label: string }> = [
  { key: "15m", label: "15m" },
  { key: "1h", label: "1h" },
  { key: "4h", label: "4h" },
  { key: "24h", label: "24h" },
  { key: "7d", label: "7d" },
];

/** Collapsible Advanced section. Houses the knobs most users
 *  never touch (order expiry preset, max relayer fee). The
 *  recipients list moved out into `<RecipientsSection>` because
 *  multi-recipient distribution + per-row schedule is core to
 *  Pro's pitch — keeping it behind ▸ Advanced made it invisible. */
export function AdvancedSettings() {
  const {
    advancedOpen, setAdvancedOpen,
    expiry, setExpiry,
    maxFeeBps, setMaxFeeBps,
  } = useTradeForm();

  if (!advancedOpen) {
    return (
      <button
        type="button"
        onClick={() => setAdvancedOpen(true)}
        className="mt-3 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
      >
        ▸ Advanced settings (expiry, max fee)
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
    </div>
  );
}
