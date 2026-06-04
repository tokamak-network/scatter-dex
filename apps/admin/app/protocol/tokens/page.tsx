"use client";

import { useState } from "react";
import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { ContractSection } from "../_components/ContractSection";
import { TokenWhitelistEditor, TokenWhitelistList } from "../_components/TokenWhitelistEditor";

export default function ProtocolTokensPage() {
  const c = DEMO_NETWORK.contracts;
  const poolReady = isConfiguredAddress(c.commitmentPool);
  const settlementReady = isConfiguredAddress(c.privateSettlement);
  const [reloadKey, setReloadKey] = useState(0);

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
    <div className="space-y-8">
      <ContractSection title="Whitelisted tokens" address={null} ready>
        <TokenWhitelistList
          poolAddress={c.commitmentPool}
          settlementAddress={c.privateSettlement}
          reloadKey={reloadKey}
        />
      </ContractSection>
      <ContractSection title="Add / remove token (Pool + Settlement)" address={null} ready>
        <TokenWhitelistEditor
          poolAddress={c.commitmentPool}
          settlementAddress={c.privateSettlement}
          onWrite={() => setReloadKey((k) => k + 1)}
        />
      </ContractSection>
    </div>
  );
}
