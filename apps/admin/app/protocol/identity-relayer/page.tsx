"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { ContractSection } from "../_components/ContractSection";
import { SetAddressCard } from "../_components/SetAddressCard";

// Relayer-side identity = single CA address stored on
// RelayerRegistry. `register()` calls `isVerified(msg.sender)`
// on this single address — there is NO aggregator on this side
// today. To support multiple operator CAs, deploy a separate
// Relayer IdentityGate (see IdentityGate.sol header comment) and
// repoint this slot at it.
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
        <code className="font-mono">RelayerRegistry.register()</code> gates new operators
        by calling <code className="font-mono">isVerified(msg.sender)</code> on this
        single address. No aggregator on this side today — to support multiple operator
        CAs, deploy a Relayer{" "}
        <code className="font-mono">IdentityGate</code> and point this slot at it.
      </p>
      <SetAddressCard
        title="Set identity registry (Operator CA)"
        description="RelayerRegistry.setIdentityRegistry(address) — the contract RelayerRegistry asks isVerified() against."
        submitLabel="Set identity registry"
        contractAddress={c.relayerRegistry}
        contractAbi={RELAYER_REGISTRY_IDENTITY_ABI}
        readerFn="identityRegistry"
        setterFn="setIdentityRegistry"
      />
    </ContractSection>
  );
}
