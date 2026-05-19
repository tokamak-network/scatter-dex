"use client";

import type { OrderStatus } from "../lib/orders";

const META: Record<OrderStatus, { label: string; cls: string; step: number }> = {
  matching: {
    label: "Matching",
    cls: "border-[var(--color-border-strong)] bg-white text-[var(--color-text-muted)]",
    step: 1,
  },
  claimable: {
    label: "Ready to claim",
    cls: "border-[var(--color-success)] bg-[var(--color-success-soft)] text-[var(--color-success)]",
    step: 2,
  },
  claimed: {
    label: "Claimed",
    cls: "border-[var(--color-primary)] bg-[var(--color-primary-soft)] text-[var(--color-primary)]",
    step: 3,
  },
  cancelled: {
    label: "Cancelled",
    cls: "border-[var(--color-border-strong)] bg-white text-[var(--color-text-subtle)]",
    step: 0,
  },
};

const TOTAL_STEPS = 3;

/** Lifecycle pill: Matching → Filled → Claimed (with Cancelled as a
 *  terminal alt). The badge's text is the accessible label; the
 *  optional progress bar underneath gives a glanceable position in
 *  the lifecycle. */
export function StatusBadge({ status }: { status: OrderStatus }) {
  const m = META[status];
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
    >
      {m.label}
    </span>
  );
}

export function StatusProgress({ status }: { status: OrderStatus }) {
  const m = META[status];
  if (status === "cancelled") return null;
  const pct = Math.round((m.step / TOTAL_STEPS) * 100);
  return (
    <div
      className="h-1 w-full overflow-hidden rounded-full bg-[var(--color-bg)]"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={TOTAL_STEPS}
      aria-valuenow={m.step}
      aria-label={`Order ${m.label}`}
    >
      <div
        className="h-full bg-[var(--color-primary)] transition-[width] duration-300"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
