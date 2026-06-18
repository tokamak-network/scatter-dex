"use client";

import {
  useLeafIndexReconciler,
  usePhantomDepositDetector,
  useWallet,
} from "@zkscatter/sdk/react";
import { useVault } from "./vault";
import { useCommitmentTree } from "./commitmentTree";

export function VaultReconciler() {
  const { notes, setLeafIndex, markFailed } = useVault();
  const tree = useCommitmentTree();
  // Read receipts through the public node — a reverted deposit is a
  // global fact, and it's the same authoritative source settlement
  // trusts (mirrors the identity-gate read path).
  const { rpcProvider } = useWallet();
  useLeafIndexReconciler({ notes, setLeafIndex, tree, label: "pay-vaultReconciler" });
  // Flag phantom deposits (reverted tx → commitment never inserted) so
  // the UI stops showing them as Pending forever.
  usePhantomDepositDetector({
    notes,
    markFailed,
    provider: rpcProvider,
    label: "pay-phantomDetector",
  });
  return null;
}
