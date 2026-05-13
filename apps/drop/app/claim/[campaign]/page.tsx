"use client";

import { use, useState } from "react";

/**
 * Static marketing mock for the future Scatter Drop claim flow.
 * Renders preview-only UI: clicking "Claim" flips local state but
 * no SDK calls, no signing, no on-chain dispatch happens. The page
 * is mounted only for marketing; do not wire real submit paths
 * into it without a separate design pass for drop's recipient
 * model (the project hasn't committed to a particular privacy
 * shape yet — EIP-5564 stealth was removed repo-wide in Phase 2.4,
 * and the replacement is unspecified).
 */
export default function Claim({ params }: { params: Promise<{ campaign: string }> }) {
  const { campaign } = use(params);
  const [done, setDone] = useState(false);

  return (
    <div className="mx-auto max-w-md py-10">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 inline-block h-12 w-12 rounded-full bg-[var(--color-primary-soft)] text-3xl leading-[3rem] text-[var(--color-primary)]">
            🎁
          </div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">From ProjectName</div>
          <div className="mt-1 text-3xl font-semibold">12,000 $XYZ</div>
          <div className="mt-1 text-sm text-[var(--color-text-muted)]">
            Claim ends in <span className="font-medium text-[var(--color-text)]">13d 4h</span>
          </div>
        </div>

        {!done ? (
          <>
            <div className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs text-[var(--color-text-muted)]">
              Eligibility verified: <span className="font-medium text-[var(--color-success)]">zk-X509 ✓</span>{" "}
              · 3+ months wallet activity
            </div>
            <button
              onClick={() => setDone(true)}
              className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
            >
              Claim — gasless
            </button>
            <div className="mt-3 text-center text-xs text-[var(--color-text-muted)]">
              No gas. Project covers it.
            </div>
          </>
        ) : (
          <div className="text-center">
            <div className="mx-auto mb-3 inline-block h-10 w-10 rounded-full bg-[var(--color-success-soft)] text-2xl leading-[2.5rem] text-[var(--color-success)]">✓</div>
            <div className="font-semibold">Claimed</div>
            <div className="mt-1 text-sm text-[var(--color-text-muted)]">12,000 $XYZ received.</div>
          </div>
        )}

        <div className="mt-6 border-t border-[var(--color-border)] pt-4 text-center text-xs text-[var(--color-text-subtle)]">
          campaign: <span className="font-mono">{campaign}</span>
        </div>
      </div>
    </div>
  );
}
