"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers } from "ethers";
import {
  ShieldCheck, AlertCircle, Loader2, CheckCircle, XCircle,
  ExternalLink, Building2, User,
} from "lucide-react";
import { useWallet } from "../lib/wallet";
import { getIdentityGateAddress, getRelayerRegistryAddress, getZkX509Url } from "../lib/config";
import { IDENTITY_GATE_ABI, RELAYER_REGISTRY_ABI } from "../lib/contracts";
import { getReadProvider } from "../lib/provider";

type Status = "idle" | "checking" | "verified" | "not-verified" | "error";

export default function IdentityPage() {
  const { account } = useWallet();

  // User CA state
  const [userStatus, setUserStatus] = useState<Status>("idle");
  const [verifiedUntil, setVerifiedUntil] = useState<number>(0);
  const [userError, setUserError] = useState("");

  // Relayer CA state
  const [relayerStatus, setRelayerStatus] = useState<Status>("idle");
  const [relayerInfo, setRelayerInfo] = useState<{
    url: string; fee: number; bond: bigint; registeredAt: number;
  } | null>(null);
  const [relayerError, setRelayerError] = useState("");

  const checkIdentity = useCallback(async () => {
    if (!account) {
      setUserStatus("idle");
      setRelayerStatus("idle");
      return;
    }

    // Check User CA
    setUserStatus("checking");
    try {
      const provider = getReadProvider();
      const gate = new ethers.Contract(getIdentityGateAddress(), IDENTITY_GATE_ABI, provider);
      const verified = await gate.isVerified(account);
      if (verified) {
        const until = await gate.verifiedUntil(account);
        setVerifiedUntil(Number(until));
        setUserStatus("verified");
      } else {
        setUserStatus("not-verified");
      }
    } catch (err: unknown) {
      setUserError(err instanceof Error ? err.message : "Failed to check identity");
      setUserStatus("error");
    }

    // Check Relayer CA
    setRelayerStatus("checking");
    try {
      const provider = getReadProvider();
      const registry = new ethers.Contract(getRelayerRegistryAddress(), RELAYER_REGISTRY_ABI, provider);
      const r = await registry.relayers(account);
      if (r.active) {
        setRelayerInfo({
          url: r.url,
          fee: Number(r.fee),
          bond: r.bond,
          registeredAt: Number(r.registeredAt),
        });
        setRelayerStatus("verified");
      } else {
        setRelayerStatus("not-verified");
      }
    } catch (err: unknown) {
      setRelayerError(err instanceof Error ? err.message : "Failed to check relayer status");
      setRelayerStatus("error");
    }
  }, [account]);

  useEffect(() => { checkIdentity(); }, [checkIdentity]);

  const zkX509Url = getZkX509Url();

  return (
    <div className="pt-28 pb-32 px-6 max-w-[960px] mx-auto">
      {/* Header */}
      <div className="text-center mb-16">
        <ShieldCheck className="w-12 h-12 text-primary mx-auto mb-4" />
        <h1 className="text-3xl font-headline font-bold text-on-surface mb-3">
          Identity Verification
        </h1>
        <p className="text-on-surface-variant max-w-xl mx-auto">
          zkScatter uses a Dual-CA architecture. Users verify privately via zk-X509,
          while relayers register as public entities with full disclosure.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* ─── User CA ─── */}
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

            {userStatus === "checking" && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-on-surface-variant">
                <Loader2 className="w-5 h-5 animate-spin" />
                Checking...
              </div>
            )}

            {userStatus === "verified" && (
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

            {userStatus === "not-verified" && (
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

            {userStatus === "error" && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-error/5 border border-error/20 text-error text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{userError}</span>
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

        {/* ─── Relayer CA ─── */}
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

            {relayerStatus === "checking" && (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-on-surface-variant">
                <Loader2 className="w-5 h-5 animate-spin" />
                Checking...
              </div>
            )}

            {relayerStatus === "verified" && relayerInfo && (
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

            {relayerStatus === "not-verified" && (
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

            {relayerStatus === "error" && (
              <div className="flex items-start gap-2 p-3 rounded-lg bg-error/5 border border-error/20 text-error text-xs">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{relayerError}</span>
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
      </div>

      {/* Dual-CA explanation */}
      <div className="mt-16 rounded-2xl border border-outline-variant/10 bg-surface-container p-8 md:p-10">
        <h3 className="font-headline font-bold text-xl mb-6 text-center">How Dual-CA Works</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-primary/15 flex items-center justify-center mx-auto mb-4">
              <User className="w-6 h-6 text-primary" />
            </div>
            <h4 className="font-headline font-semibold text-sm mb-2">User CA</h4>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              Verifies identity via zk-X509 with <strong className="text-on-surface">zero disclosure</strong>.
              On-chain: only a boolean &quot;is verified&quot;.
              Your privacy is the protocol&apos;s priority.
            </p>
          </div>
          <div className="text-center flex flex-col items-center justify-center">
            <div className="w-12 h-12 rounded-full bg-outline-variant/15 flex items-center justify-center mb-4">
              <ShieldCheck className="w-6 h-6 text-on-surface-variant" />
            </div>
            <h4 className="font-headline font-semibold text-sm mb-2">Same Protocol</h4>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              Both use the same zk-X509 proof system.
              The only difference is the <strong className="text-on-surface">disclosure mask</strong> required
              by each registry.
            </p>
          </div>
          <div className="text-center">
            <div className="w-12 h-12 rounded-full bg-tertiary/15 flex items-center justify-center mx-auto mb-4">
              <Building2 className="w-6 h-6 text-tertiary" />
            </div>
            <h4 className="font-headline font-semibold text-sm mb-2">Relayer CA</h4>
            <p className="text-xs text-on-surface-variant leading-relaxed">
              Verifies identity via zk-X509 with <strong className="text-on-surface">full disclosure</strong>.
              On-chain: organization name, jurisdiction, license —
              publicly accountable by design.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
