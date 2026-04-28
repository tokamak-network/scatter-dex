"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createFolderNoteAdapter,
  createIndexedDbNoteAdapter,
  idForCommitment,
  type NoteStorageAdapter,
  type StoredNote,
} from "@zkscatter/sdk/notes";
import { useWallet } from "@zkscatter/sdk/react";
import { getNetworkConfig } from "./network";
import { useFolderStorage } from "./folderStorage";

/** A note in the user's local vault. The full `CommitmentNote` is
 *  carried so spending circuits (authorize / claim) can spend this
 *  note later without re-deriving its preimage from on-chain data.
 *
 *  Persisted via `@zkscatter/sdk/notes` IndexedDB adapter — survives
 *  page reload + browser restart. */
export type VaultNote = StoredNote;

interface VaultState {
  notes: VaultNote[];
  /** True once the storage adapter has loaded existing notes. UI
   *  surfaces a brief loading state to avoid flashing "vault empty"
   *  on a refresh of a page that actually has notes. */
  loaded: boolean;
  add(n: Omit<VaultNote, "id" | "createdAt" | "label" | "chainId" | "leafIndex">): Promise<VaultNote>;
  remove(id: string): Promise<void>;
}

const VaultCtx = createContext<VaultState | null>(null);

export function useVault(): VaultState {
  const ctx = useContext(VaultCtx);
  if (!ctx) throw new Error("useVault must be used inside <VaultProvider>");
  return ctx;
}

/** Pull the highest `lot-N` sequence number out of an existing note
 *  list so a new add never collides with a previously-persisted
 *  label. Falls back to 0 when no parseable label is found. */
function deriveLabelCounter(notes: readonly VaultNote[]): number {
  let max = 0;
  for (const n of notes) {
    const m = /^lot-(\d+)$/.exec(n.label);
    if (!m) continue;
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  // Pay is single-network — `getNetworkConfig()` reads NEXT_PUBLIC_PAY_*
  // envs at build time, so `chainId` is stable for the lifetime of the
  // bundle and we don't need an ActiveNetwork context.
  const chainId = getNetworkConfig().chainId;
  // Scope the IndexedDB by `account` too so two wallets sharing the
  // same browser don't read each other's notes.
  const { account } = useWallet();
  const accountKey = account?.toLowerCase() ?? "anon";
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Ref so two adds in the same tick get distinct sequence numbers.
  // Carries over across chain switches: hydration uses
  // `Math.max(current, deriveLabelCounter(loaded))` so labels are
  // monotonic per-provider lifetime — never resetting prevents a
  // duplicate-`lot-N` race when `add()` fires during the new
  // chain's hydrate window.
  const labelCounter = useRef(0);

  // Adapter selection: prefer the folder backend whenever the user
  // has picked one (so deposits land in the same notes folder
  // frontend uses); fall back to per-chain IndexedDB otherwise.
  //
  // When `folder.ready` toggles, `adapter` is rebuilt and the
  // hydrate effect below re-runs — picking up the on-disk notes for
  // the freshly-selected folder. Account / chain switches still
  // re-key the IDB DB so two wallets sharing the same browser don't
  // cross-pollute the no-folder fallback.
  const { ready: folderReady } = useFolderStorage();
  const adapter = useMemo<NoteStorageAdapter>(
    () =>
      folderReady
        ? createFolderNoteAdapter({ chainId })
        : createIndexedDbNoteAdapter({
            dbName: `zkscatter-pay-notes-${chainId}-${accountKey}`,
          }),
    [folderReady, chainId, accountKey],
  );

  // Hydrate on mount + on every chainId change. Cancellation guards
  // a fast unmount (HMR, route swap during initial fetch) and a
  // rapid network switch (user toggles twice before the first load
  // resolves) from setting state on a dead adapter.
  const isFirstHydrateRef = useRef(true);
  useEffect(() => {
    let cancelled = false;
    // On a real chainId change (not the initial mount) reset visible
    // state so the prior chain's notes don't bleed into the new
    // chain's "loading" view. Skip on first hydrate — the initial
    // values are already empty and a redundant set would flash.
    // labelCounter is intentionally NOT reset (see ref comment).
    if (!isFirstHydrateRef.current) {
      setNotes([]);
      setLoaded(false);
    }
    isFirstHydrateRef.current = false;
    void (async () => {
      try {
        const list = await adapter.loadAll();
        if (cancelled) return;
        // Adapter returns oldest → newest. `add()` prepends, so the
        // in-memory invariant is **newest-first**. Reverse hydrated
        // entries to match — without this, a refresh would visibly
        // flip the vault order and any pre-hydration `add()` would
        // straddle the boundary.
        // Adapters already filter by chainId (folder via opts, IDB
        // via per-chain DB name) so no second filter here.
        const filtered = list.slice().sort((a, b) => b.createdAt - a.createdAt);
        // Merge with anything `add()` may have inserted before
        // hydration completed. Without this, a deposit fired during
        // the initial async load would be visible in IDB but blown
        // away from in-memory state when the loaded list overwrites.
        setNotes((prev) => {
          if (prev.length === 0) return filtered;
          const seen = new Set(filtered.map((n) => n.id));
          const fresh = prev.filter((n) => !seen.has(n.id));
          if (fresh.length === 0) return filtered;
          // Both sides already newest-first; merge then re-sort to
          // restore the invariant when `prev` had a slightly older
          // createdAt than the most recent hydrated entry.
          return [...fresh, ...filtered].sort((a, b) => b.createdAt - a.createdAt);
        });
        labelCounter.current = Math.max(
          labelCounter.current,
          deriveLabelCounter(filtered),
        );
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, chainId]);

  const add = useCallback(
    async (n: Omit<VaultNote, "id" | "createdAt" | "label" | "chainId" | "leafIndex">) => {
      const seq = ++labelCounter.current;
      const note: VaultNote = {
        ...n,
        // Content-addressed id (matches the folder adapter's
        // identity rule) so a note added in-memory has the same id
        // it'll read back as after a folder reload, and the IDB
        // path stays consistent with what the folder path produces.
        id: idForCommitment(n.commitment),
        label: `lot-${seq}`,
        createdAt: Date.now(),
        chainId,
        // `-1` until the deposit's `CommitmentInserted` event is
        // reconciled. Spending paths that need a real index must
        // wait until then; the empty-tree shortcut treats it as 0.
        leafIndex: -1,
      };
      // Persist before flipping React state — a write failure is
      // logged inside the adapter and we still surface the note in
      // the UI (memory tier holds it), but the user wouldn't see a
      // confusing "added then disappeared on refresh" if the adapter
      // had thrown. `adapter` is closed-over from the memo; if
      // chainId flips mid-await, this still writes to the chain
      // the call started on.
      await adapter.put(note);
      setNotes((prev) => [note, ...prev]);
      return note;
    },
    [adapter, chainId],
  );

  const remove = useCallback(
    async (id: string) => {
      await adapter.remove(id);
      setNotes((prev) => (prev.some((n) => n.id === id) ? prev.filter((n) => n.id !== id) : prev));
    },
    [adapter],
  );

  const value = useMemo<VaultState>(
    () => ({ notes, loaded, add, remove }),
    [notes, loaded, add, remove],
  );

  return <VaultCtx.Provider value={value}>{children}</VaultCtx.Provider>;
}
