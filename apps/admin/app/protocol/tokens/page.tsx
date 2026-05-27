"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { ContractSection } from "../_components/ContractSection";
import { TokenWhitelistEditor } from "../_components/TokenWhitelistEditor";

export default function ProtocolTokensPage() {
  const c = DEMO_NETWORK.contracts;
  const poolReady = isConfiguredAddress(c.commitmentPool);
  const settlementReady = isConfiguredAddress(c.privateSettlement);
  if (!(poolReady && settlementReady)) {
    return (
      <ContractSection
        title="Token whitelist (Pool + Settlement)"
        address={null}
        ready={false}
        envHint="NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS / NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS"
      >
        {null}
      </ContractSection>
    );
  }
  return (
    <ContractSection title="Token whitelist (Pool + Settlement)" address={null} ready>
      <TokenWhitelistEditor
        poolAddress={c.commitmentPool}
        settlementAddress={c.privateSettlement}
      />
    </ContractSection>
  );
}
