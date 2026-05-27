"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { ContractSection } from "../_components/ContractSection";
import { PrivateSettlementPanel } from "../_components/PrivateSettlementPanel";

export default function ProtocolSettlementPage() {
  const c = DEMO_NETWORK.contracts;
  return (
    <ContractSection
      title="PrivateSettlement"
      address={c.privateSettlement}
      ready={isConfiguredAddress(c.privateSettlement)}
      envHint="NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS"
    >
      <PrivateSettlementPanel address={c.privateSettlement} />
    </ContractSection>
  );
}
