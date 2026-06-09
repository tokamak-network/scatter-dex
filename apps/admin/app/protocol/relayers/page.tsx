"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { ContractSection } from "../_components/ContractSection";
import { RelayersTable } from "../_components/RelayersTable";

export default function ProtocolRelayersPage() {
  const c = DEMO_NETWORK.contracts;
  return (
    <ContractSection
      title="Relayers"
      address={c.relayerRegistry}
      ready={isConfiguredAddress(c.relayerRegistry)}
      envHint="NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS"
    >
      <RelayersTable address={c.relayerRegistry} />
    </ContractSection>
  );
}
