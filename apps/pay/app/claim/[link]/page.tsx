"use client";

import { use, useState } from "react";

export default function Claim({ params }: { params: Promise<{ link: string }> }) {
  const { link } = use(params);
  const [stealth, setStealth] = useState(true);
  const [done, setDone] = useState(false);

  return (
    <div className="mx-auto max-w-md py-10">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 inline-block h-10 w-10 rounded-full bg-[var(--color-primary-soft)] text-2xl leading-[2.5rem] text-[var(--color-primary)]">
            ↓
          </div>
          <div className="text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
            From Acme DAO
          </div>
          <div className="mt-1 text-3xl font-semibold">3,500 USDC</div>
          <div className="mt-1 text-sm text-[var(--color-text-muted)]">
            April payroll · You only see your amount
          </div>
        </div>

        {!done ? (
          <>
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
                  Recommended. Funds land at a one-time address only your wallet can spend.
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
              No gas. Recipient pays nothing. Powered by zkScatter relayers.
            </div>
          </>
        ) : (
          <div className="text-center">
            <div className="mx-auto mb-3 inline-block h-10 w-10 rounded-full bg-[var(--color-success-soft)] text-2xl leading-[2.5rem] text-[var(--color-success)]">
              ✓
            </div>
            <div className="font-semibold">Claimed</div>
            <div className="mt-1 text-sm text-[var(--color-text-muted)]">
              3,500 USDC received{stealth ? " at stealth address" : ""}.
            </div>
          </div>
        )}

        <div className="mt-6 border-t border-[var(--color-border)] pt-4 text-center text-xs text-[var(--color-text-subtle)]">
          link: <span className="font-mono">{link}</span>
        </div>
      </div>
    </div>
  );
}
