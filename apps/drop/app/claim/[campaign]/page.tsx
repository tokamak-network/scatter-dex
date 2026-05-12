"use client";

import { use, useState } from "react";

/**
 * Static marketing mock for the future Scatter Drop claim flow.
 * Renders preview-only UI: clicking "Claim" flips local state but
 * no SDK calls, no signing, no on-chain dispatch happens. The
 * stealth-address checkbox is a deliberate placeholder for the
 * planned drop-specific stealth flow once the SDK's deprecated
 * stealth surface is rebuilt around the new identity-anchored
 * recipient model (tracked separately). Do not wire real submit
 * paths into this page without first removing the mock toggles. */
export default function Claim({ params }: { params: Promise<{ campaign: string }> }) {
  const { campaign } = use(params);
  // Preview-only UI flag — DOES NOT actually derive a stealth
  // address. Reusing the SDK's previously-deprecated stealth path
  // here would silently re-introduce the surface we deprecated;
  // any real claim flow needs its own design pass first.
  const [stealth, setStealth] = useState(true);
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
            <label className="mb-4 flex cursor-pointer items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm">
              <input
                type="checkbox"
                checked={stealth}
                onChange={(e) => setStealth(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">Receive at a stealth address</span>
                <span className="block text-xs text-[var(--color-text-muted)]">
                  Recommended. Hides your claim amount from public dashboards.
                </span>
                <span className="mt-1 block text-[10px] uppercase tracking-wide text-[var(--color-warning)]">
                  Preview — not yet active
                </span>
              </span>
            </label>
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
            <div className="mt-1 text-sm text-[var(--color-text-muted)]">12,000 $XYZ received{stealth ? " at stealth address" : ""}.</div>
          </div>
        )}

        <div className="mt-6 border-t border-[var(--color-border)] pt-4 text-center text-xs text-[var(--color-text-subtle)]">
          campaign: <span className="font-mono">{campaign}</span>
        </div>
      </div>
    </div>
  );
}
