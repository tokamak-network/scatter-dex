"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { SectionHeader } from "../components/SectionHeader";
import { DEMO_NETWORK } from "../lib/network";
import { CommitmentPoolPanel } from "./_components/CommitmentPoolPanel";
import { IdentityGatePanel } from "./_components/IdentityGatePanel";
import { PrivateSettlementPanel } from "./_components/PrivateSettlementPanel";
import { RelayerRegistryPanel } from "./_components/RelayerRegistryPanel";
import { TokenWhitelistEditor } from "./_components/TokenWhitelistEditor";

export default function ProtocolPage() {
  const c = DEMO_NETWORK.contracts;
  const registryReady = isConfiguredAddress(c.relayerRegistry);
  const poolReady = isConfiguredAddress(c.commitmentPool);
  const settlementReady = isConfiguredAddress(c.privateSettlement);
  const identityGateReady = isConfiguredAddress(c.identityGate);

  return (
    <div className="space-y-12">
      <header>
        <h1 className="text-2xl font-semibold">Protocol parameters</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--color-text-muted)]">
          Governed parameters across <code className="font-mono">RelayerRegistry</code>,{" "}
          <code className="font-mono">CommitmentPool</code>,{" "}
          <code className="font-mono">PrivateSettlement</code>, and{" "}
          <code className="font-mono">IdentityGate</code>. Reads are live; writes require the
          contract owner's signature.
        </p>
      </header>

      <ContractSection
        title="RelayerRegistry"
        address={c.relayerRegistry}
        ready={registryReady}
        envHint="NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS"
      >
        <RelayerRegistryPanel address={c.relayerRegistry} />
      </ContractSection>

      {poolReady && settlementReady && (
        <ContractSection
          title="Token whitelist (Pool + Settlement)"
          address={null}
          ready
        >
          <TokenWhitelistEditor
            poolAddress={c.commitmentPool}
            settlementAddress={c.privateSettlement}
          />
        </ContractSection>
      )}

      <ContractSection
        title="CommitmentPool"
        address={c.commitmentPool}
        ready={poolReady}
        envHint="NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS"
      >
        <CommitmentPoolPanel address={c.commitmentPool} />
      </ContractSection>

      <ContractSection
        title="PrivateSettlement"
        address={c.privateSettlement}
        ready={settlementReady}
        envHint="NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS"
      >
        <PrivateSettlementPanel address={c.privateSettlement} />
      </ContractSection>

      <ContractSection
        title="IdentityGate"
        address={c.identityGate}
        ready={identityGateReady}
        envHint="NEXT_PUBLIC_IDENTITY_GATE_ADDRESS"
      >
        <IdentityGatePanel address={c.identityGate} />
      </ContractSection>
    </div>
  );
}

interface SectionProps {
  title: string;
  address: string | null;
  ready: boolean;
  envHint?: string;
  children: React.ReactNode;
}

function ContractSection({ title, address, ready, envHint, children }: SectionProps) {
  if (!ready) {
    return (
      <section>
        <SectionHeader title={title} badge="mock" />
        <div className="rounded-xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-text-muted)]">
          Set <code className="font-mono">{envHint}</code> to enable this section on{" "}
          <strong>{DEMO_NETWORK.name}</strong>.
        </div>
      </section>
    );
  }
  return (
    <section>
      <SectionHeader
        title={title}
        badge="live"
        hint={address ? address : undefined}
      />
      {children}
    </section>
  );
}
