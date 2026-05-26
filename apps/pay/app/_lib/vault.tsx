"use client";

import { useMemo } from "react";
import { createVaultProvider, useWallet } from "@zkscatter/sdk/react";
import {
  createFolderNoteAdapter,
  createIndexedDbNoteAdapter,
  idForCommitment,
  type NoteStorageAdapter,
} from "@zkscatter/sdk/notes";
import { getNetworkConfig } from "./network";
import { useFolderStorage } from "./folderStorage";

export type { VaultNote, VaultState } from "@zkscatter/sdk/react";

// Pay is single-network — `getNetworkConfig()` reads NEXT_PUBLIC_PAY_*
// envs at build time, so chainId is stable for the lifetime of the
// bundle. Adapter selection: prefer the folder backend whenever the
// user has picked one (so deposits land in the same notes folder
// frontend uses); fall back to per-chain + per-account IndexedDB
// otherwise so two wallets sharing the same browser don't read each
// other's notes.
const { VaultProvider, useVault } = createVaultProvider({
  useChainId: () => getNetworkConfig().chainId,
  useAdapter: (chainId): NoteStorageAdapter => {
    const { account } = useWallet();
    const accountKey = account?.toLowerCase() ?? "anon";
    const { ready: folderReady } = useFolderStorage();
    return useMemo(
      () =>
        folderReady
          // Folder adapter now stamps + filters by account, matching
          // the per-account IDB DB-name used in the no-folder branch
          // — without this, switching wallets while sharing a folder
          // would surface the previous wallet's notes as if they
          // were spendable from the current one.
          ? createFolderNoteAdapter({ chainId, accountKey })
          : createIndexedDbNoteAdapter({
              dbName: `zkscatter-pay-notes-${chainId}-${accountKey}`,
            }),
      [folderReady, chainId, accountKey],
    );
  },
  // Content-addressed id matches the folder adapter's identity rule
  // so a note added in-memory has the same id it'll read back as
  // after a folder reload.
  makeId: ({ commitment }) => idForCommitment(commitment),
  // Pay's adapters already filter by chainId (folder via opts, IDB
  // via per-chain DB name), so no extra filterHydrated.
});

export { VaultProvider, useVault };
