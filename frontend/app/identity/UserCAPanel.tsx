"use client";

import { AlertCircle, Loader2, CheckCircle, XCircle, ExternalLink, User } from "lucide-react";

type Status = "idle" | "checking" | "verified" | "not-verified" | "error";

export default function UserCAPanel({
  account,
  status,
  verifiedUntil,
  error,
  zkX509Url,
}: {
  account: string | null;
  status: Status;
  verifiedUntil: number;
  error: string;
  zkX509Url: string;
}) {
  return (
    <div className="rounded-2xl border border-outline-variant/10 bg-surface-container overflow-hidden">
      {/* Card header */}
      <div className="px-8 pt-8 pb-6 border-b border-outline-variant/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-primary/15 flex items-center justify-center">
            <User className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-headline font-bold text-xl text-on-surface">User Identity</h2>
            <p className="text-xs text-primary font-medium">Private CA (zk-X509)</p>
          </div>
        </div>
        <p className="text-sm text-on-surface-variant leading-relaxed">
          Your real identity is verified once via zk-X509 but never revealed on-chain.
          Only a &quot;verified&quot; flag is stored — your name, organization, and certificate
          details remain cryptographically hidden.
        </p>
      </div>

      {/* Card body */}
      <div className="px-8 py-6">
        {!account && (
          <div className="text-center py-6">
            <AlertCircle className="w-7 h-7 text-on-surface-variant/30 mx-auto mb-2" />
            <p className="text-sm text-on-surface-variant">Connect wallet to check</p>
          </div>
        )}

        {status === "checking" && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-on-surface-variant">
            <Loader2 className="w-5 h-5 animate-spin" />
            Checking...
          </div>
        )}

        {status === "verified" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-primary" />
              <div>
                <p className="text-sm font-semibold text-primary">Verified</p>
                <p className="text-xs text-on-surface-variant">
                  Valid until {new Date(verifiedUntil * 1000).toLocaleDateString("en-US", {
                    year: "numeric", month: "long", day: "numeric",
                  })}
                </p>
              </div>
            </div>
            <div className="rounded-lg bg-surface p-4">
              <p className="text-xs text-on-surface-variant font-medium mb-2">You can:</p>
              <ul className="text-xs text-on-surface-variant list-disc list-inside space-y-1">
                <li>Deposit assets into the commitment pool</li>
                <li>Create and sign private orders</li>
                <li>Claim settled funds to any wallet</li>
              </ul>
            </div>
          </div>
        )}

        {status === "not-verified" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <XCircle className="w-5 h-5 text-error" />
              <div>
                <p className="text-sm font-semibold text-error">Not Verified</p>
                <p className="text-xs text-on-surface-variant">
                  Your wallet has not been registered with zk-X509.
                </p>
              </div>
            </div>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              Verify your identity using an X.509 certificate from a trusted CA.
              The ZK proof ensures no personal data is stored on-chain.
            </p>
            <a
              href={zkX509Url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center justify-center gap-2 w-full py-3 gradient-btn text-on-primary-fixed rounded-lg font-semibold text-sm"
            >
              Register via zk-X509
              <ExternalLink className="w-4 h-4" />
            </a>
          </div>
        )}

        {status === "error" && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-error/5 border border-error/20 text-error text-xs">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* On-chain visibility */}
      <div className="px-8 py-4 bg-surface/50 border-t border-outline-variant/10">
        <p className="text-[11px] text-on-surface-variant/60 font-medium uppercase tracking-wider mb-2">On-chain visibility</p>
        <div className="flex flex-wrap gap-2">
          <span className="px-2 py-1 rounded bg-primary/10 text-primary text-[11px] font-medium">isVerified: boolean</span>
          <span className="px-2 py-1 rounded bg-primary/10 text-primary text-[11px] font-medium">verifiedUntil: timestamp</span>
        </div>
        <p className="text-[11px] text-on-surface-variant/40 mt-2">Name, organization, and certificate details are never stored on-chain.</p>
      </div>
    </div>
  );
}
