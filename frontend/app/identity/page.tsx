"use client";

import { useState, useEffect, useCallback } from "react";
import { ShieldCheck, Building2, User } from "lucide-react";
import { loadOperatorRow, loadRegistrationStatus } from "@zkscatter/sdk/relayer";
import { useWallet } from "../lib/wallet";
import { getRelayerRegistryAddress, getZkX509Url } from "../lib/config";
import { getReadProvider } from "../lib/provider";
import UserCAPanel from "./UserCAPanel";
import RelayerCAPanel from "./RelayerCAPanel";
import type { RelayerInfo } from "./RelayerCAPanel";

type Status = "idle" | "checking" | "verified" | "not-verified" | "error";

export default function IdentityPage() {
  const { account } = useWallet();

  const [userStatus, setUserStatus] = useState<Status>("idle");
  const [verifiedUntil, setVerifiedUntil] = useState<number>(0);
  const [userError, setUserError] = useState("");

  const [relayerStatus, setRelayerStatus] = useState<Status>("idle");
  const [relayerInfo, setRelayerInfo] = useState<RelayerInfo | null>(null);
  const [relayerError, setRelayerError] = useState("");

  const checkIdentity = useCallback(async () => {
    // Reset derived state up front so an account switch / disconnect
    // never leaves the prior account's "Verified until …" or relayer
    // bond visible until the next fetch resolves.
    setVerifiedUntil(0);
    setRelayerInfo(null);
    setUserError("");
    setRelayerError("");

    if (!account) {
      setUserStatus("idle");
      setRelayerStatus("idle");
      return;
    }

    setUserStatus("checking");
    setRelayerStatus("checking");

    const provider = getReadProvider();
    const registryAddr = getRelayerRegistryAddress();

    // Two independent reads — fan out so the panel's perceived
    // latency is bounded by the slower of the two, not their sum.
    const [identityResult, relayerResult] = await Promise.allSettled([
      loadRegistrationStatus(registryAddr, account, provider),
      loadOperatorRow(registryAddr, account, provider),
    ]);

    if (identityResult.status === "fulfilled") {
      const status = identityResult.value;
      setVerifiedUntil(status.verifiedUntil);
      setUserStatus(status.isVerified ? "verified" : "not-verified");
    } else {
      console.error("Failed to load identity status", identityResult.reason);
      const err = identityResult.reason;
      setUserError(err instanceof Error ? err.message : "Failed to check identity");
      setUserStatus("error");
    }

    if (relayerResult.status === "fulfilled") {
      const row = relayerResult.value;
      if (row.active) {
        setRelayerInfo({
          url: row.url,
          fee: row.feeBps,
          bond: row.bond,
          registeredAt: row.registeredAt,
        });
        setRelayerStatus("verified");
      } else {
        setRelayerStatus("not-verified");
      }
    } else {
      console.error("Failed to load relayer status", relayerResult.reason);
      const err = relayerResult.reason;
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
        <UserCAPanel
          account={account}
          status={userStatus}
          verifiedUntil={verifiedUntil}
          error={userError}
          zkX509Url={zkX509Url}
        />
        <RelayerCAPanel
          account={account}
          status={relayerStatus}
          relayerInfo={relayerInfo}
          error={relayerError}
          zkX509Url={zkX509Url}
        />
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
