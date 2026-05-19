"use client";

import { useMemo } from "react";
import { createVaultProvider, useWallet } from "@zkscatter/sdk/react";
import {
  createFolderNoteAdapter,
  idForCommitment,
  type NoteStorageAdapter,
} from "@zkscatter/sdk/notes";
import { useActiveNetwork } from "./activeNetwork";
import { useFolder } from "./folder";

export type { VaultNote, VaultState } from "@zkscatter/sdk/react";

// Pro is folder-only: VaultProvider mounts inside <FolderGate>, so
// by the time this hook runs the user has a notes folder selected.
// Every deposit / withdraw / change-note round-trips through that
// folder — IndexedDB is intentionally not used as a fallback so the
// folder is the single source of truth across Pro, Pay, and the
// legacy app.
//
// Content-addressed `idForCommitment` keeps a deposit's id stable
// across reloads — matches Pay so a folder shared between the two
// surfaces the same notes by the same id.
const { VaultProvider, useVault } = createVaultProvider({
  useChainId: () => useActiveNetwork().network.chainId,
  useAdapter: (chainId): NoteStorageAdapter => {
    // Mirrors Pay's `[chainId, accountKey]` keying with a Pro
    // addition: `currentId` covers folder pick + folder switch.
    // Without it the pre-pick adapter stays cached and the
    // provider's hydration effect never re-fires after the user
    // picks a folder mid-session. A fresh adapter instance on
    // any of the three changes lets vaultProvider treat it as a
    // generation bump → loadAll re-runs against the new
    // (folder × chain × account).
    const { currentId } = useFolder();
    const { account } = useWallet();
    const accountKey = account?.toLowerCase() ?? "anon";
    return useMemo(
      () => createFolderNoteAdapter({ chainId }),
      [chainId, currentId, accountKey],
    );
  },
  makeId: ({ commitment }) => idForCommitment(commitment),
  // Belt-and-suspenders chainId filter: notes from older versions
  // (pre-keying) may still exist in the folder; filter at hydrate
  // so a note tagged with the wrong chainId can't re-enter the
  // active vault. Notes without a `chainId` tag are grandfathered.
  filterHydrated: (notes, chainId) =>
    notes.filter((n) => n.chainId === undefined || n.chainId === chainId),
});

export { VaultProvider, useVault };
