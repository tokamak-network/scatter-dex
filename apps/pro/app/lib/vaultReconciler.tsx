"use client";

import { useLeafIndexReconciler } from "@zkscatter/sdk/react";
import { useVault } from "./vault";
import { useCommitmentTree } from "./commitmentTree";

export function VaultReconciler() {
  const { notes, setLeafIndex } = useVault();
  const tree = useCommitmentTree();
  useLeafIndexReconciler({ notes, setLeafIndex, tree, label: "pro-vaultReconciler" });
  return null;
}
