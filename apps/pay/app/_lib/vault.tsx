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
  /** Patch the leafIndex on a stored note. Used by the reconciler
   *  to back-fill the tree position once the deposit's
   *  `CommitmentInserted` event lands. Idempotent: if the note is
   *  already at the supplied index, returns immediately with zero
   *  IDB writes and no re-render; otherwise persists via
   *  `adapter.put` and triggers one re-render of vault consumers. */
  setLeafIndex(id: string, leafIndex: number): Promise<void>;
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
  const notesRef = useRef<VaultNote[]>([]);
  // Mirror `notes` into a ref so async callbacks (setLeafIndex below)
  // can read the current vault without taking `notes` as a dep —
  // putting it in the dep would re-create the callback on every
  // mutation and trip the reconciler's effect on every change.
  useEffect(() => {
    notesRef.current = notes;
  }, [notes]);
  // Synchronously-updated set of ids `remove()` was called for. The
  // useEffect-mirrored `notesRef` is one tick behind a setNotes
  // queued by `remove`; setLeafIndex's remove-race guard reads this
  // ref to detect a same-tick removal and undo the IDB resurrection.
  const removedIdsRef = useRef<Set<string>>(new Set());
  // Bumped on every (re)hydrate. Async vault writers (setLeafIndex)
  // capture the current value at call-start and bail if it's
  // changed by post-await time — without this, an in-flight write
  // crossing a chain / account switch would see the new chain's
  // empty `notesRef` and erroneously call `adapter.remove(id)` on
  // the OLD adapter, evicting a still-valid note from the prior
  // chain's IDB.
  const generationRef = useRef(0);
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
    // Reset on every (re)hydrate so a stale id from the previous
    // chain doesn't block a re-loaded note that happens to share it.
    removedIdsRef.current = new Set();
    // Bump the generation so any in-flight async write captured a
    // pre-switch value sees the change and bails on post-await
    // checks. Bumped synchronously inside the effect body — the
    // async hydrate IIFE below runs against the new generation.
    generationRef.current += 1;
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
      // Mark removed BEFORE any await so a concurrent setLeafIndex
      // sees this synchronously, even if its `notesRef` mirror
      // hasn't ticked yet. Without this, the put-after-remove race
      // would resurrect the IDB row.
      removedIdsRef.current.add(id);
      await adapter.remove(id);
      setNotes((prev) => (prev.some((n) => n.id === id) ? prev.filter((n) => n.id !== id) : prev));
    },
    [adapter],
  );

  const setLeafIndex = useCallback(
    async (id: string, leafIndex: number) => {
      // Capture the generation at call-start so a chain/account
      // switch landing during the put resolves to "different chain,
      // bail" rather than "note removed, undo resurrection".
      const startGen = generationRef.current;
      // Bail synchronously if remove(id) was called this tick or
      // earlier — notesRef is one commit behind, so we need the
      // synchronous removedIdsRef set to catch the race.
      if (removedIdsRef.current.has(id)) return;
      const target = notesRef.current.find((n) => n.id === id);
      if (!target || target.leafIndex === leafIndex) return;
      const next: VaultNote = { ...target, leafIndex };
      await adapter.put(next);
      // Generation moved → we crossed a chain/account switch. Don't
      // touch the new chain's state and don't re-evict; the put
      // landed on the OLD adapter, which is still the correct file
      // for that note's chain. Leave it.
      if (generationRef.current !== startGen) return;
      // Re-check post-await: a remove() that landed during the put
      // would have added the id to the set. Undo the resurrection.
      if (
        removedIdsRef.current.has(id) ||
        !notesRef.current.some((n) => n.id === id)
      ) {
        await adapter.remove(id);
        return;
      }
      setNotes((prev) =>
        prev.some((n) => n.id === id) ? prev.map((n) => (n.id === id ? next : n)) : prev,
      );
    },
    [adapter],
  );

  const value = useMemo<VaultState>(
    () => ({ notes, loaded, add, remove, setLeafIndex }),
    [notes, loaded, add, remove, setLeafIndex],
  );

  return <VaultCtx.Provider value={value}>{children}</VaultCtx.Provider>;
}
