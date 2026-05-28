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
        Aggregates multiple zk-X509 IdentityRegistry contracts (one per CA) using
        OR-combine. <code className="font-mono">CommitmentPool.deposit()</code> and{" "}
        <code className="font-mono">PrivateSettlement</code> read this when verifying
        users. Add a registry to trust it; remove to stop.
      </p>
      <IdentityGatePanel address={c.identityGate} />
    </ContractSection>
  );
}
