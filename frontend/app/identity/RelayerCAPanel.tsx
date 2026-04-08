"use client";

import { ethers } from "ethers";
import { AlertCircle, Loader2, CheckCircle, XCircle, ExternalLink, Building2 } from "lucide-react";

type Status = "idle" | "checking" | "verified" | "not-verified" | "error";

export type RelayerInfo = {
  url: string;
  fee: number;
  bond: bigint;
  registeredAt: number;
};

export default function RelayerCAPanel({
  account,
  status,
  relayerInfo,
  error,
  zkX509Url,
}: {
  account: string | null;
  status: Status;
  relayerInfo: RelayerInfo | null;
  error: string;
  zkX509Url: string;
}) {
  return (
    <div className="rounded-2xl border border-outline-variant/10 bg-surface-container overflow-hidden">
      {/* Card header */}
      <div className="px-8 pt-8 pb-6 border-b border-outline-variant/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-xl bg-tertiary/15 flex items-center justify-center">
            <Building2 className="w-5 h-5 text-tertiary" />
          </div>
          <div>
            <h2 className="font-headline font-bold text-xl text-on-surface">Relayer Identity</h2>
            <p className="text-xs text-tertiary font-medium">Public Entity CA</p>
          </div>
        </div>
        <p className="text-sm text-on-surface-variant leading-relaxed">
          Relayers operate as publicly identified, licensed intermediaries.
          Their organization name, jurisdiction, and certificate details are
          fully disclosed on-chain via zk-X509 with full disclosure mask.
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

        {status === "verified" && relayerInfo && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="w-5 h-5 text-tertiary" />
              <div>
                <p className="text-sm font-semibold text-tertiary">Active Relayer</p>
                <p className="text-xs text-on-surface-variant">
                  Registered {new Date(relayerInfo.registeredAt * 1000).toLocaleDateString("en-US", {
                    year: "numeric", month: "long", day: "numeric",
                  })}
                </p>
              </div>
            </div>
            <div className="rounded-lg bg-surface p-4 space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-on-surface-variant">Endpoint</span>
                <span className="text-on-surface font-mono">{relayerInfo.url}</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-on-surface-variant">Fee</span>
                <span className="text-on-surface font-mono">{(relayerInfo.fee / 100).toFixed(2)}%</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-on-surface-variant">Bond</span>
                <span className="text-on-surface font-mono">{ethers.formatEther(relayerInfo.bond)} ETH</span>
              </div>
            </div>
            <div className="rounded-lg bg-surface p-4">
              <p className="text-xs text-on-surface-variant font-medium mb-2">Responsibilities:</p>
              <ul className="text-xs text-on-surface-variant list-disc list-inside space-y-1">
                <li>Match and settle private orders</li>
                <li>Submit gasless claim proofs on behalf of users</li>
                <li>Retain off-chain order logs for compliance</li>
                <li>Respond to lawful disclosure requests</li>
              </ul>
            </div>
          </div>
        )}

        {status === "not-verified" && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <XCircle className="w-5 h-5 text-on-surface-variant/50" />
              <div>
                <p className="text-sm font-semibold text-on-surface-variant">Not Registered</p>
                <p className="text-xs text-on-surface-variant/70">
                  This wallet is not registered as a relayer.
                </p>
              </div>
            </div>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              To become a relayer, you must first verify through the Relayer CA (Public Entity)
              with full disclosure of your organization identity. Then register
              your endpoint and fee on the Relayer Registry.
            </p>
            <div className="flex gap-3">
              <a
                href={zkX509Url}
                target="_blank"
                rel="noreferrer"
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-surface-bright text-on-surface rounded-lg font-semibold text-sm border border-outline-variant/15 hover:border-outline-variant/30 transition-colors"
              >
                Verify via Relayer CA
                <ExternalLink className="w-4 h-4" />
              </a>
              <a
                href="/relayer/register"
                className="flex-1 flex items-center justify-center gap-2 py-3 bg-tertiary/15 text-tertiary rounded-lg font-semibold text-sm hover:bg-tertiary/20 transition-colors"
              >
                Register Relayer
              </a>
            </div>
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
          <span className="px-2 py-1 rounded bg-tertiary/10 text-tertiary text-[11px] font-medium">Country (C)</span>
          <span className="px-2 py-1 rounded bg-tertiary/10 text-tertiary text-[11px] font-medium">Organization (O)</span>
          <span className="px-2 py-1 rounded bg-tertiary/10 text-tertiary text-[11px] font-medium">Org Unit (OU)</span>
          <span className="px-2 py-1 rounded bg-tertiary/10 text-tertiary text-[11px] font-medium">Common Name (CN)</span>
        </div>
        <p className="text-[11px] text-on-surface-variant/40 mt-2">Full disclosure required — relayers are publicly accountable entities.</p>
      </div>
    </div>
  );
}
