"use client";

import type { ReactNode } from "react";

interface FieldProps {
  /** Plain string for most fields; pass ReactNode when the label
   *  needs an inline element (e.g. a tooltip icon next to the
   *  text). Backward-compatible — string is assignable to
   *  ReactNode. */
  label: ReactNode;
  /** Optional subdued helper line under the input. */
  hint?: ReactNode;
  /** Optional error text — when set, replaces the hint and tints
   *  the field's border. */
  error?: ReactNode;
  /** The actual input — leave full styling to the caller (different
   *  inputs need different padding, font, type). */
  children: ReactNode;
}

/** Label + input wrapper. Keeps form rows consistent across the
 *  Deposit / Order / Withdraw / Settings flows without forcing a
 *  specific input element type. */
export function Field({ label, hint, error, children }: FieldProps) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-semibold text-[var(--color-text-muted)]">
        {label}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-[var(--color-danger)]">{error}</span>
      ) : hint ? (
        <span className="mt-1 block text-xs text-[var(--color-text-muted)]">{hint}</span>
      ) : null}
    </label>
  );
}
