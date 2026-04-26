"use client";

import type { ReactNode } from "react";

export interface PreviewRow {
  label: string;
  value: ReactNode;
  /** Render the value in success-tone (e.g. "0 USDC — launch event"). */
  highlight?: boolean;
  /** Render the value muted (e.g. estimated gas). */
  muted?: boolean;
}

interface Props {
  /** Headline rows shown in larger type — usually "You pay" / "You receive". */
  primary: PreviewRow[];
  /** Secondary rows — fees, gas, slippage, expiry, etc. */
  secondary?: PreviewRow[];
  /** Footer line. Defaults to a custody-reassurance message. */
  footer?: ReactNode;
}

/** Unified pre-sign summary used by Deposit / Order / Claim /
 *  Withdraw / Cancel modals. The shape forces every flow to surface
 *  the same trust signals (what you pay, what you get, real fee in
 *  numbers, custody footer) so the user has a single mental model
 *  across actions. */
export function PreSignPreview({ primary, secondary, footer }: Props) {
  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-sm">
      <dl className="space-y-2">
        {primary.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
              {r.label}
            </dt>
            <dd
              className={`text-right font-mono text-base font-semibold ${
                r.highlight
                  ? "text-[var(--color-success)]"
                  : r.muted
                  ? "text-[var(--color-text-muted)]"
                  : ""
              }`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      {secondary && secondary.length > 0 && (
        <>
          <div className="my-3 border-t border-[var(--color-border)]" />
          <dl className="space-y-1.5 text-xs">
            {secondary.map((r) => (
              <div key={r.label} className="flex justify-between gap-4">
                <dt className="text-[var(--color-text-muted)]">{r.label}</dt>
                <dd
                  className={`text-right font-mono ${
                    r.highlight
                      ? "font-medium text-[var(--color-success)]"
                      : r.muted
                      ? "text-[var(--color-text-subtle)]"
                      : "text-[var(--color-text)]"
                  }`}
                >
                  {r.value}
                </dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <div className="mt-3 border-t border-[var(--color-border)] pt-2 text-xs text-[var(--color-text-subtle)]">
        {footer ?? "You keep custody until on-chain settlement. Cancel anytime before fill."}
      </div>
    </div>
  );
}
