"use client";

import { useMemo } from "react";
import { createVaultProvider, useEdDSAKey, useWallet } from "@zkscatter/sdk/react";
import {
  createFolderNoteAdapter,
  createIndexedDbNoteAdapter,
  createSignatureNoteCipher,
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
    // Wallet-signature-derived AES-GCM cipher for the IDB fallback.
    // `signature` is null until the user's first signing flow (deposit,
    // payout, withdraw — or the balance card's Unlock button), so a
    // fresh session starts with a cipher-less adapter: plaintext legacy
    // notes still load, encrypted ones surface as `useVault().lockedNotes`.
    // Once the key is derived the memo re-runs → the new adapter
    // generation decrypts everything and re-encrypts legacy plaintext
    // rows on their next put. Nulled while the folder backend is active
    // (its own threat model — user-visible files) so the session's
    // first signature doesn't pointlessly regenerate the folder adapter
    // and re-read every note file.
    const { signature } = useEdDSAKey();
    const cipherSig = folderReady ? null : signature;
    return useMemo(
      () =>
        folderReady
          // Folder adapter stamps + filters by account, matching
          // the per-account IDB DB-name used in the no-folder branch
          // — without this, switching wallets while sharing a folder
          // would surface the previous wallet's notes as if they
          // were spendable from the current one.
          ? createFolderNoteAdapter({ chainId, accountKey })
          : createIndexedDbNoteAdapter({
              dbName: `zkscatter-pay-notes-${chainId}-${accountKey}`,
              ...(cipherSig ? createSignatureNoteCipher(cipherSig) : {}),
            }),
      [folderReady, chainId, accountKey, cipherSig],
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
