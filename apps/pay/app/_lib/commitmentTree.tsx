"use client";

import { useMemo } from "react";
import {
  CommitmentTreeProvider as SdkCommitmentTreeProvider,
  useCommitmentTree as sdkUseCommitmentTree,
  type CommitmentTreeState,
} from "@zkscatter/sdk/react";
import { getNetworkConfig } from "./network";

// Pay is single-network — addresses are inlined at build time.
// Resolve once at module mount and feed the SDK provider.
export function CommitmentTreeProvider({ children }: { children: React.ReactNode }) {
  const poolAddress = useMemo(() => getNetworkConfig().contracts.commitmentPool, []);
  return (
    <SdkCommitmentTreeProvider poolAddress={poolAddress}>{children}</SdkCommitmentTreeProvider>
  );
}

export const useCommitmentTree = sdkUseCommitmentTree;
export type { CommitmentTreeState };
