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
  createIndexedDbNoteAdapter,
  type NoteStorageAdapter,
  type StoredNote,
} from "@zkscatter/sdk/notes";
import { useActiveNetwork } from "./activeNetwork";

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

function newId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
  const { network } = useActiveNetwork();
  const chainId = network.chainId;
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Ref so two adds in the same tick get distinct sequence numbers.
  // Carries over across chain switches: hydration uses
  // `Math.max(current, deriveLabelCounter(loaded))` so labels are
  // monotonic per-provider lifetime — never resetting prevents a
  // duplicate-`lot-N` race when `add()` fires during the new
  // chain's hydrate window.
  const labelCounter = useRef(0);

  // Adapter is keyed on the active chainId — per-chain DB so notes
  // from one network don't leak into another when the user switches.
  // `useMemo` (not `useRef`) so each chainId gets its own stable
  // instance and `add` / `remove` callbacks close over the correct
  // one. An in-flight `add()` started under chain A keeps writing
  // to chain A's adapter even if chainId flips mid-await — without
  // this binding, the dereference `adapterRef.current` would land
  // on chain B's IDB after the swap. The SDK adapter is SSR-safe
  // (no IDB call until the first method invocation).
  const adapter = useMemo<NoteStorageAdapter>(
    () => createIndexedDbNoteAdapter({ dbName: `zkscatter-notes-${chainId}` }),
    [chainId],
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
        const filtered = list
          .filter((n) => n.chainId === undefined || n.chainId === chainId)
          .sort((a, b) => b.createdAt - a.createdAt);
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
        id: newId(),
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
