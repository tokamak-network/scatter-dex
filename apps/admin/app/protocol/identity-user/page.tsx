"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { ContractSection } from "../_components/ContractSection";
import { IdentityGatePanel } from "../_components/IdentityGatePanel";

// User-side identity = the IdentityGate aggregator that
// CommitmentPool deposits + PrivateSettlement check before letting
// a user transact. Holds a list of zk-X509 IdentityRegistry CAs
// (OR-combined): trust any one → trusted.
export default function ProtocolIdentityUserPage() {
  const c = DEMO_NETWORK.contracts;
  return (
    <ContractSection
      title="IdentityGate — user CA trusted set"
      address={c.identityGate}
      ready={isConfiguredAddress(c.identityGate)}
      envHint="NEXT_PUBLIC_IDENTITY_GATE_ADDRESS"
    >
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        These zk-X509 CAs authenticate <strong>Pay and Pro end users</strong> — the
        registry list below gates every <code className="font-mono">CommitmentPool.deposit()</code>{" "}
        and <code className="font-mono">PrivateSettlement</code> call by checking each
        sender against the trusted set. Multiple CAs are OR-combined: a user verified by
        any one registry passes the gate. Add a registry to trust it; remove to stop.
        Operator (relayer) authentication is configured separately on the{" "}
        <strong>Identity (relayer)</strong> tab.
      </p>
      <IdentityGatePanel address={c.identityGate} />
    </ContractSection>
  );
}
