"use client";

import { useEffect } from "react";
import { useVault } from "./vault";
import { useCommitmentTree } from "./commitmentTree";

/** Back-fills `leafIndex` on vault notes once the deposit's
 *  `CommitmentInserted` event lands in the live tree. Without this,
 *  realSettle's `-1` guard leaves a partial-spend's change UTXO
 *  unspendable until the user manually refreshes. */
export function VaultReconciler() {
  const { notes, setLeafIndex } = useVault();
  const tree = useCommitmentTree();

  useEffect(() => {
    if (!tree.ready || tree.mode === "demo") return;
    for (const n of notes) {
      if (n.leafIndex >= 0) continue;
      const idx = tree.findIndex(n.commitment);
      if (idx >= 0) void setLeafIndex(n.id, idx);
    }
  }, [notes, tree.ready, tree.mode, tree.leafCount, tree.findIndex, setLeafIndex]);

  return null;
}
