"use client";

import { useMemo } from "react";
import { createVaultProvider } from "@zkscatter/sdk/react";
import { createIndexedDbNoteAdapter } from "@zkscatter/sdk/notes";
import { useActiveNetwork } from "./activeNetwork";

export type { VaultNote, VaultState } from "@zkscatter/sdk/react";

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Pro switches networks at runtime — chainId comes from the active-
// network context. The IDB DB is keyed per chain so notes from one
// network don't leak into another.
const { VaultProvider, useVault } = createVaultProvider({
  useChainId: () => useActiveNetwork().network.chainId,
  useAdapter: (chainId) =>
    useMemo(
      () => createIndexedDbNoteAdapter({ dbName: `zkscatter-notes-${chainId}` }),
      [chainId],
    ),
  // Random UUID — Pro's note storage is keyed on the in-memory id,
  // not the commitment, so collisions across deposits are fine.
  makeId: () => newId(),
  // Belt-and-suspenders chainId filter: even though the adapter is
  // already keyed per-chain via dbName, legacy v1 notes (pre-keying)
  // may have lived in the unkeyed DB. Filter at hydrate so a note
  // tagged with the wrong chainId can't re-enter the active vault.
  // Notes without a `chainId` tag are grandfathered through.
  filterHydrated: (notes, chainId) =>
    notes.filter((n) => n.chainId === undefined || n.chainId === chainId),
});

export { VaultProvider, useVault };
