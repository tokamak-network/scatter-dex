"use client";

import { isConfiguredAddress } from "@zkscatter/sdk";
import { DEMO_NETWORK } from "../../lib/network";
import { CommitmentPoolPanel } from "../_components/CommitmentPoolPanel";
import { ContractSection } from "../_components/ContractSection";

export default function ProtocolCommitmentPoolPage() {
  const c = DEMO_NETWORK.contracts;
  return (
    <ContractSection
      title="CommitmentPool"
      address={c.commitmentPool}
      ready={isConfiguredAddress(c.commitmentPool)}
      envHint="NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS"
    >
      <CommitmentPoolPanel address={c.commitmentPool} />
    </ContractSection>
  );
}
