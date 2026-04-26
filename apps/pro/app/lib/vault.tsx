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
import type { CommitmentNote } from "@zkscatter/sdk/zk";
import { DEMO_NETWORK } from "./network";

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
  const [notes, setNotes] = useState<VaultNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  // Ref so two adds in the same tick get distinct sequence numbers.
  const labelCounter = useRef(0);
  // Single adapter instance per provider lifetime — closing the IDB
  // connection on every render would re-open it on every hook call.
  const adapterRef = useRef<NoteStorageAdapter | null>(null);
  if (adapterRef.current === null) {
    // Lazy-init guarded by ref so SSR doesn't trigger the IDB open
    // path (the adapter handles `typeof indexedDB === "undefined"`
    // internally, but skipping the call is cleaner).
    adapterRef.current = createIndexedDbNoteAdapter({
      // Per-chain DB so notes from one network don't leak into a
      // different one when the user switches.
      dbName: `zkscatter-notes-${DEMO_NETWORK.chainId}`,
    });
  }

  // Hydrate on mount. Cancellation guards a fast unmount (HMR, route
  // swap during initial fetch) from setting state on a dead provider.
  useEffect(() => {
    const adapter = adapterRef.current!;
    let cancelled = false;
    void (async () => {
      try {
        const list = await adapter.loadAll();
        if (cancelled) return;
        const filtered = list.filter(
          (n) => n.chainId === undefined || n.chainId === DEMO_NETWORK.chainId,
        );
        // Merge with anything `add()` may have inserted before
        // hydration completed. Without this, a deposit fired during
        // the initial async load would be visible in IDB but blown
        // away from in-memory state when the loaded list overwrites.
        setNotes((prev) => {
          if (prev.length === 0) return filtered;
          const seen = new Set(filtered.map((n) => n.id));
          const fresh = prev.filter((n) => !seen.has(n.id));
          return fresh.length === 0 ? filtered : [...fresh, ...filtered];
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
    // TODO(multi-chain): when a runtime network switcher lands,
    // re-create `adapterRef` keyed on chainId so the per-chain DB
    // name follows the active network. Today DEMO_NETWORK.chainId
    // is fixed at module-load.
  }, []);

  const add = useCallback(
    async (n: Omit<VaultNote, "id" | "createdAt" | "label" | "chainId" | "leafIndex">) => {
      const seq = ++labelCounter.current;
      const note: VaultNote = {
        ...n,
        id: newId(),
        label: `lot-${seq}`,
        createdAt: Date.now(),
        chainId: DEMO_NETWORK.chainId,
        // `-1` until the deposit's `CommitmentInserted` event is
        // reconciled. Spending paths that need a real index must
        // wait until then; the empty-tree shortcut treats it as 0.
        leafIndex: -1,
      };
      // Persist before flipping React state — a write failure is
      // logged inside the adapter and we still surface the note in
      // the UI (memory tier holds it), but the user wouldn't see a
      // confusing "added then disappeared on refresh" if the adapter
      // had thrown.
      await adapterRef.current!.put(note);
      setNotes((prev) => [note, ...prev]);
      return note;
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    await adapterRef.current!.remove(id);
    setNotes((prev) => (prev.some((n) => n.id === id) ? prev.filter((n) => n.id !== id) : prev));
  }, []);

  const value = useMemo<VaultState>(
    () => ({ notes, loaded, add, remove }),
    [notes, loaded, add, remove],
  );

  return <VaultCtx.Provider value={value}>{children}</VaultCtx.Provider>;
}
