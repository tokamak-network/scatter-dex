import type { ReactNode } from "react";

interface StatProps {
  label: string;
  value: string;
  /** Sub-line under the value. Accepts any ReactNode so callers can
   *  drop in a tooltip / colored span / hydration-safe `<When>` cell.
   *  Optional — pages that don't need a sub-line render the slot
   *  empty instead of being forced to pass an empty string. */
  sub?: ReactNode;
  /** Smaller surface variant for nested panels (e.g. inside another card). */
  compact?: boolean;
}

export function Stat({ label, value, sub, compact }: StatProps) {
  if (compact) {
    return (
      <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-4">
        <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
        <div className="mt-1 text-lg font-semibold">{value}</div>
        <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">{sub}</div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left">
      <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">{label}</div>
      <div className="mt-2 text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-[var(--color-text-muted)]">{sub}</div>
    </div>
  );
}
