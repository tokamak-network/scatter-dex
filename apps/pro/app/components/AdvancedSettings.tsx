"use client";

import { useTradeForm } from "../lib/tradeForm";

/** Collapsible Advanced section. Houses just the max-fee tuner;
 *  the "Order valid until" deadline lives in the main form so the
 *  user always sees when their order has to settle. */
export function AdvancedSettings() {
  const { advancedOpen, setAdvancedOpen, maxFeeBps, setMaxFeeBps } = useTradeForm();

  if (!advancedOpen) {
    return (
      <button
        type="button"
        onClick={() => setAdvancedOpen(true)}
        className="mt-3 text-xs font-medium text-[var(--color-text-muted)] hover:text-[var(--color-primary)]"
      >
        ▸ Advanced settings (max fee)
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
          aria-label="Max relayer fee in basis points"
          className="w-full"
        />
        <p className="text-[11px] text-[var(--color-text-subtle)]">
          Hard cap. Relayers compete below this — quoted fee shown at submit.
        </p>
      </section>
    </div>
  );
}
