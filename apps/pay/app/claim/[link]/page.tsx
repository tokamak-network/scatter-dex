"use client";

import { use, useEffect, useState } from "react";
import { useWallet, shortAddr } from "@zkscatter/sdk/react";

// Demo claim payload. The real Pay reads this from its claim record
// store keyed off the URL path, then verifies the secret hashes to the
// claimHash that's on-chain via the SDK before showing "Claim".
const DEMO_CLAIM = {
  senderName: "Acme DAO",
  senderVerified: true,
  amount: "3,500",
  token: "USDC",
  label: "April payroll",
  availableFrom: "2026-04-01",
  payslipHref: "/payouts/p_2026_04_payroll/payslip/alice",
};

export default function Claim({ params }: { params: Promise<{ link: string }> }) {
  const { link } = use(params);
  const { account, connect, connectError } = useWallet();
  const [secret, setSecret] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isAvailable, setIsAvailable] = useState<boolean>();

  useEffect(() => {
    if (typeof window === "undefined") return;
    setSecret(window.location.hash.replace(/^#/, "") || null);
    setIsAvailable(new Date() >= new Date(DEMO_CLAIM.availableFrom));
  }, []);

  return (
    <div className="mx-auto max-w-md py-10">
      <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
        {/* Verified sender mark */}
        <div className="mb-5 flex items-center justify-center gap-2 text-xs">
          <span className="text-[var(--color-text-subtle)]">From</span>
          <span className="font-medium">{DEMO_CLAIM.senderName}</span>
          {DEMO_CLAIM.senderVerified && (
            <span
              title="zk-X509 verified organization"
              className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--color-success)]"
            >
              ✓ Verified
            </span>
          )}
        </div>

        {/* Amount */}
        <div className="mb-2 text-center text-xs uppercase tracking-wide text-[var(--color-text-subtle)]">
          {DEMO_CLAIM.label}
        </div>
        <div className="text-center text-3xl font-semibold">
          {DEMO_CLAIM.amount} {DEMO_CLAIM.token}
        </div>
        <div className="mt-1 text-center text-sm text-[var(--color-text-muted)]">
          You only see your amount.
        </div>

        {/* No-expiry assurance */}
        <div className="mx-auto mt-5 inline-block w-full rounded-md bg-[var(--color-primary-soft)] p-2 text-center text-xs text-[var(--color-primary)]">
          🔒 Funds can only go to you — even if this link is forwarded.
          <span className="mt-0.5 block text-[10px] text-[var(--color-text-muted)]">
            Claim anytime — no expiry.
          </span>
        </div>

        {/* Availability */}
        <div className="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-xs">
          {isAvailable === undefined ? (
            <span className="text-[var(--color-text-muted)]">
              Checking availability…
            </span>
          ) : isAvailable ? (
            <span className="text-[var(--color-success)]">
              ✓ Available to claim now ({DEMO_CLAIM.availableFrom})
            </span>
          ) : (
            <span className="text-[var(--color-warning)]">
              ⏳ Available from {DEMO_CLAIM.availableFrom}
            </span>
          )}
        </div>

        {/* Action */}
        {!done ? (
          <div className="mt-5 space-y-3">
            {!account ? (
              <>
                <button
                  onClick={() => void connect()}
                  className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)]"
                >
                  Connect wallet to claim
                </button>
                {connectError && (
                  <div className="text-center text-xs text-[var(--color-error,#dc2626)]">
                    {connectError === "no-wallet"
                      ? "Install MetaMask to continue."
                      : connectError}
                  </div>
                )}
                <div className="text-center text-[11px] text-[var(--color-text-muted)]">
                  We never see your wallet keys. Funds are released directly to
                  the recipient address bound to this link.
                </div>
              </>
            ) : (
              <>
                <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-center text-xs text-[var(--color-text-muted)]">
                  Connected: <span className="font-mono">{shortAddr(account)}</span>
                </div>
                <button
                  onClick={() => setDone(true)}
                  disabled={!isAvailable || !secret}
                  className="w-full rounded-lg bg-[var(--color-primary)] py-3 text-sm font-medium text-white hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                >
                  Claim — gasless
                </button>
                {!secret && (
                  <div className="text-center text-xs text-[var(--color-warning)]">
                    This link is missing its secret. Open the original email
                    or message you received and click the link there.
                  </div>
                )}
                <div className="text-center text-xs text-[var(--color-text-muted)]">
                  No gas. Powered by zkScatter relayers.
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="mt-6 text-center">
            <div className="mx-auto mb-3 inline-block h-10 w-10 rounded-full bg-[var(--color-success-soft)] text-2xl leading-[2.5rem] text-[var(--color-success)]">
              ✓
            </div>
            <div className="font-semibold">Claimed</div>
            <div className="mt-1 text-sm text-[var(--color-text-muted)]">
              {DEMO_CLAIM.amount} {DEMO_CLAIM.token} received.
            </div>
          </div>
        )}

        {/* Payslip / receipt */}
        <div className="mt-6 flex items-center justify-between border-t border-[var(--color-border)] pt-3 text-xs">
          <a
            href={DEMO_CLAIM.payslipHref}
            target="_blank"
            rel="noreferrer"
            className="text-[var(--color-primary)] hover:underline"
          >
            Download payslip (PDF) ↓
          </a>
          <span className="font-mono text-[10px] text-[var(--color-text-subtle)]">{link}</span>
        </div>
      </div>
    </div>
  );
}
