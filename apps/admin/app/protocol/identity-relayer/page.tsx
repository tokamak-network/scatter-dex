"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { ContractSection } from "../_components/ContractSection";
import { SetAddressCard } from "../_components/SetAddressCard";

const RELAYER_REGISTRY_IDENTITY_ABI = [
  "function identityRegistry() external view returns (address)",
  "function setIdentityRegistry(address _identityRegistry) external",
];

export default function ProtocolIdentityRelayerPage() {
  const c = DEMO_NETWORK.contracts;
  return (
    <ContractSection
      title="RelayerRegistry — operator CA"
      address={c.relayerRegistry}
      ready={isConfiguredAddress(c.relayerRegistry)}
      envHint="NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS"
    >
      <p className="mb-3 text-xs text-[var(--color-text-muted)]">
        This zk-X509 CA registry authenticates <strong>relayer operators</strong>.{" "}
        <code className="font-mono">RelayerRegistry.register()</code> gates every new
        operator by calling{" "}
        <code className="font-mono">isVerified(msg.sender)</code> on the single address
        below. (No aggregator on this side yet — to support multiple operator CAs, deploy
        a Relayer <code className="font-mono">IdentityGate</code> and point this slot at
        it.) End-user authentication is configured separately on the{" "}
        <strong>Identity (user)</strong> tab.
      </p>
      <SetAddressCard
        title="Change zk-X509 CA registry address"
        description="RelayerRegistry.setIdentityRegistry(address) — replace the zk-X509 CA that register() trusts. Takes effect immediately for new register() calls; already-registered relayers are unaffected."
        submitLabel="Set identity registry"
        contractAddress={c.relayerRegistry}
        contractAbi={RELAYER_REGISTRY_IDENTITY_ABI}
        readerFn="identityRegistry"
        setterFn="setIdentityRegistry"
        showFullAddressHeader={{ label: "Currently registered zk-X509 CA" }}
      />
    </ContractSection>
  );
}
