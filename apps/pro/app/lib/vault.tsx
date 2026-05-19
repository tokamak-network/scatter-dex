"use client";

import { useMemo } from "react";
import { createVaultProvider } from "@zkscatter/sdk/react";
import {
  createFolderNoteAdapter,
  idForCommitment,
  type NoteStorageAdapter,
} from "@zkscatter/sdk/notes";
import { useActiveNetwork } from "./activeNetwork";

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
// TEMP DEBUG wrapper — logs every put/remove/loadAll so a stuck-
// UI report can be diagnosed against the actual adapter traffic.
// Remove once the vault-state-sync issue is root-caused.
function withDebugLog(inner: NoteStorageAdapter): NoteStorageAdapter {
  return {
    ready: inner.ready,
    async loadAll() {
      const out = await inner.loadAll();
      // eslint-disable-next-line no-console
      console.log(`[vault] loadAll → ${out.length} notes`, out.map((n) => ({ id: n.id, leafIndex: n.leafIndex, sym: n.symbol })));
      return out;
    },
    async put(note) {
      // eslint-disable-next-line no-console
      console.log(`[vault] put →`, { id: note.id, leafIndex: note.leafIndex, sym: note.symbol, amount: note.amount });
      try {
        await inner.put(note);
        // eslint-disable-next-line no-console
        console.log(`[vault] put ✓`, note.id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[vault] put ✗`, note.id, e);
        throw e;
      }
    },
    async remove(id) {
      // eslint-disable-next-line no-console
      console.log(`[vault] remove →`, id);
      try {
        await inner.remove(id);
        // eslint-disable-next-line no-console
        console.log(`[vault] remove ✓`, id);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[vault] remove ✗`, id, e);
        throw e;
      }
    },
    clear: inner.clear ? () => inner.clear!() : undefined,
  } as NoteStorageAdapter;
}

const { VaultProvider, useVault } = createVaultProvider({
  useChainId: () => useActiveNetwork().network.chainId,
  useAdapter: (chainId): NoteStorageAdapter =>
    useMemo(() => withDebugLog(createFolderNoteAdapter({ chainId })), [chainId]),
  makeId: ({ commitment }) => idForCommitment(commitment),
  // Belt-and-suspenders chainId filter: notes from older versions
  // (pre-keying) may still exist in the folder; filter at hydrate
  // so a note tagged with the wrong chainId can't re-enter the
  // active vault. Notes without a `chainId` tag are grandfathered.
  filterHydrated: (notes, chainId) =>
    notes.filter((n) => n.chainId === undefined || n.chainId === chainId),
});

export { VaultProvider, useVault };
