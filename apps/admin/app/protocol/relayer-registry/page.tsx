"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { ContractSection } from "../_components/ContractSection";
import { RelayerRegistryPanel } from "../_components/RelayerRegistryPanel";

export default function ProtocolRelayerRegistryPage() {
  const c = DEMO_NETWORK.contracts;
  return (
    <ContractSection
      title="RelayerRegistry"
      address={c.relayerRegistry}
      ready={isConfiguredAddress(c.relayerRegistry)}
      envHint="NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS"
    >
      <RelayerRegistryPanel address={c.relayerRegistry} />
    </ContractSection>
  );
}
