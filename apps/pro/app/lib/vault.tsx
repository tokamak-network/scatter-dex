"use client";

import { useMemo } from "react";
import { createVaultProvider, useWallet } from "@zkscatter/sdk/react";
import {
  createFolderNoteAdapter,
  createIndexedDbNoteAdapter,
  idForCommitment,
  type NoteStorageAdapter,
} from "@zkscatter/sdk/notes";
import { useActiveNetwork } from "./activeNetwork";
import { useFolder } from "./folder";

export type { VaultNote, VaultState } from "@zkscatter/sdk/react";

// Pro mirrors Pay's hybrid storage model: prefer the folder backend
// whenever the user has picked one (so deposits land in the same
// notes folder frontend / Pay use and survive a browser data wipe),
// fall back to per-chain + per-account IndexedDB otherwise so two
// wallets sharing the same browser don't read each other's notes.
// Content-addressed `idForCommitment` keeps a deposit's id stable
// across folder and IDB sources — a note added in-memory has the
// same id it reads back as after a folder reload.
const { VaultProvider, useVault } = createVaultProvider({
  useChainId: () => useActiveNetwork().network.chainId,
  useAdapter: (chainId): NoteStorageAdapter => {
    const { account } = useWallet();
    const accountKey = account?.toLowerCase() ?? "anon";
    const { ready: folderReady } = useFolder();
    return useMemo(
      () =>
        folderReady
          ? createFolderNoteAdapter({ chainId })
          : createIndexedDbNoteAdapter({
              dbName: `zkscatter-pro-notes-${chainId}-${accountKey}`,
            }),
      [folderReady, chainId, accountKey],
    );
  },
  makeId: ({ commitment }) => idForCommitment(commitment),
  // Belt-and-suspenders chainId filter: even though both adapters
  // are already keyed per-chain, legacy notes (pre-keying) may have
  // lived in the unkeyed DB. Filter at hydrate so a note tagged
  // with the wrong chainId can't re-enter the active vault.
  // Notes without a `chainId` tag are grandfathered through.
  filterHydrated: (notes, chainId) =>
    notes.filter((n) => n.chainId === undefined || n.chainId === chainId),
});

export { VaultProvider, useVault };
