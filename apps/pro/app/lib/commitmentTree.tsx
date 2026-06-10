"use client";

import {
  CommitmentTreeProvider as SdkCommitmentTreeProvider,
  useCommitmentTree as sdkUseCommitmentTree,
  type CommitmentTreeState,
} from "@zkscatter/sdk/react";
import { useActiveNetwork } from "./activeNetwork";

// Pro switches networks at runtime — bridge the active-network hook
// into the SDK provider so the tree rebuilds when the user toggles.
export function CommitmentTreeProvider({ children }: { children: React.ReactNode }) {
  const { network } = useActiveNetwork();
  return (
    <SdkCommitmentTreeProvider
      poolAddress={network.contracts.commitmentPool}
      serverUrl={network.sharedOrderbookUrl}
    >
      {children}
    </SdkCommitmentTreeProvider>
  );
}

export const useCommitmentTree = sdkUseCommitmentTree;
export type { CommitmentTreeState };
export {
  CommitmentProofUnavailableError,
  getMerkleProofWithFallback,
} from "@zkscatter/sdk/react";
