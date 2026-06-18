"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { NoteStorageAdapter, StoredNote } from "../notes";

/** A note in the user's local vault. The full `CommitmentNote` is
 *  carried so spending circuits (authorize / claim) can spend this
 *  note later without re-deriving its preimage from on-chain data.
 *  Persisted via the supplied adapter — survives page reload. */
export type VaultNote = StoredNote;

export interface VaultState {
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
  /** Flag a note as a failed/phantom deposit (its tx reverted, so the
   *  commitment was never inserted). Persisted so the verdict survives
   *  reloads; the UI then filters it out instead of showing it as
   *  Pending forever. Idempotent: a note already `"failed"` is a no-op.
   *  Like `setLeafIndex`, guarded against the removed/chain-switch
   *  races so a stale write can't resurrect or cross-write a note. */
  markFailed(id: string): Promise<void>;
}

export interface CreateVaultProviderOpts {
  /** Hook returning the active chain id. Called once per render
   *  inside the provider; consumers can return a constant
   *  (env-driven, single-network apps) or thread an active-network
   *  context value (multi-network apps). */
  useChainId(): number;
  /** Hook returning the storage adapter for the active chainId.
   *  Called inside the provider as a hook — implementations are
   *  free to call any other hook (`useWallet`, `useMemo`, etc.) so
   *  long as the call order stays stable across renders. The
   *  returned reference's identity matters: the hydrate effect
   *  retriggers when it changes, so wrap creation in `useMemo`. */
  useAdapter(chainId: number): NoteStorageAdapter;
  /** Derive a stable id for a freshly-added note. Pay uses a
   *  content-addressed `idForCommitment(commitment)`; Pro uses a
   *  random UUID. The factory passes the new note's commitment so
   *  content-addressed callers don't need extra inputs. */
  makeId(input: { commitment: bigint }): string;
  /** Optional post-load filter applied to hydrated notes before
   *  they hit React state. Pay's adapters already filter by chainId
   *  internally (folder via opts, per-chain IDB DB name), so Pay
   *  omits this; Pro filters here because its single IDB DB is
   *  shared across chainIds. */
  filterHydrated?(notes: readonly VaultNote[], chainId: number): VaultNote[];
}

export interface CreateVaultProviderResult {
  VaultProvider: (props: { children: ReactNode }) => ReactNode;
  useVault(): VaultState;
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

/** Build a vault Provider + hook pair scoped to one app. The factory
 *  consolidates the race-safe vault primitives (notesRef mirror,
 *  removedIdsRef synchronous set, generationRef chain-switch guard,
 *  setLeafIndex with pre/post-await guards) so app-side vault.tsx
 *  files reduce to "wire chainId + adapter + id-maker, re-export". */
export function createVaultProvider(
  opts: CreateVaultProviderOpts,
): CreateVaultProviderResult {
  // Factory is expected to be called once at app module load — opts
  // are captured here and reused across every Provider render. Don't
  // recreate the factory per render; the resulting `VaultCtx` would
  // change identity and consumers would lose state.
  const { useChainId, useAdapter, makeId, filterHydrated } = opts;
  const VaultCtx = createContext<VaultState | null>(null);

  function useVault(): VaultState {
    const ctx = useContext(VaultCtx);
    if (!ctx) throw new Error("useVault must be used inside <VaultProvider>");
    return ctx;
  }

  function VaultProvider({ children }: { children: ReactNode }) {
    const chainId = useChainId();
    const adapter = useAdapter(chainId);

    const [notes, setNotes] = useState<VaultNote[]>([]);
    const notesRef = useRef<VaultNote[]>([]);
    useEffect(() => {
      notesRef.current = notes;
    }, [notes]);

    // Synchronously-updated set of ids `remove()` was called for —
    // catches the same-tick remove-vs-put race the useEffect-mirrored
    // `notesRef` would miss (one commit behind a queued setNotes).
    const removedIdsRef = useRef<Set<string>>(new Set());
    // Bumped on every (re)hydrate. Async writers capture the value
    // at call-start and bail post-await if it moved (chain/account
    // switch); without this, an in-flight setLeafIndex would post-
    // await against the new chain's empty notesRef and call
    // adapter.remove(id) on the OLD adapter, evicting a still-valid
    // note from the prior chain's IDB.
    const generationRef = useRef(0);

    const [loaded, setLoaded] = useState(false);
    // Carries over across chain switches: hydration uses
    // `Math.max(current, deriveLabelCounter(loaded))` so labels are
    // monotonic per-provider lifetime.
    const labelCounter = useRef(0);

    const isFirstHydrateRef = useRef(true);
    useEffect(() => {
      let cancelled = false;
      if (!isFirstHydrateRef.current) {
        setNotes([]);
        setLoaded(false);
      }
      isFirstHydrateRef.current = false;
      removedIdsRef.current = new Set();
      generationRef.current += 1;
      void (async () => {
        try {
          const list = await adapter.loadAll();
          if (cancelled) return;
          // NoteStorageAdapter.loadAll is documented to return rows
          // already ordered oldest → newest. `add()` prepends, so the
          // in-memory invariant is **newest-first** — reverse without
          // re-sorting (preserves stable order for equal createdAt).
          const reversed = list.slice().reverse();
          const filtered = filterHydrated ? filterHydrated(reversed, chainId) : reversed;
          // Merge with anything `add()` may have inserted before
          // hydration completed. Without this, a deposit fired
          // during the initial async load would be visible in IDB
          // but blown away from in-memory state.
          setNotes((prev) => {
            if (prev.length === 0) return filtered;
            const seen = new Set(filtered.map((n) => n.id));
            const fresh = prev.filter((n) => !seen.has(n.id));
            if (fresh.length === 0) return filtered;
            // `prev` is newest-first; concat keeps that order.
            // Use a final sort here only — fresh entries from
            // `add()` may have createdAt slightly older than the
            // most recent hydrated entry (clock skew).
            return [...fresh, ...filtered].sort((a, b) => b.createdAt - a.createdAt);
          });
          labelCounter.current = Math.max(
            labelCounter.current,
            deriveLabelCounter(filtered),
          );
        } catch (err) {
          // Folder-backed adapters can throw on permission revocation
          // / missing folder; IDB can throw on quota or schema
          // upgrade conflicts. Log and leave `notes` empty rather
          // than surfacing as an unhandled rejection — UI shows the
          // empty-vault state, and a refresh / re-mount retries.
          if (!cancelled) {
            console.warn("[vaultProvider] hydrate failed:", err);
          }
        } finally {
          if (!cancelled) setLoaded(true);
        }
      })();
      return () => {
        cancelled = true;
      };
    }, [adapter, chainId, filterHydrated]);

    const add = useCallback(
      async (
        n: Omit<VaultNote, "id" | "createdAt" | "label" | "chainId" | "leafIndex">,
      ) => {
        // Capture generation so a chain / account switch crossing
        // the put doesn't inject the prior chain's note into the
        // new chain's React state. The put itself lands on the OLD
        // adapter (correct for that note), but `setNotes` below
        // would otherwise prepend it to the new vault.
        const startGen = generationRef.current;
        const seq = ++labelCounter.current;
        const note: VaultNote = {
          ...n,
          id: makeId({ commitment: n.commitment }),
          label: `lot-${seq}`,
          createdAt: Date.now(),
          chainId,
          // `-1` until the deposit's `CommitmentInserted` event is
          // reconciled by the leafIndex reconciler.
          leafIndex: -1,
        };
        await adapter.put(note);
        if (generationRef.current !== startGen) return note;
        setNotes((prev) => [note, ...prev]);
        return note;
      },
      [adapter, chainId, makeId],
    );

    const remove = useCallback(
      async (id: string) => {
        // Mark removed BEFORE any await so a concurrent setLeafIndex
        // sees this synchronously, even if its `notesRef` mirror
        // hasn't ticked yet.
        removedIdsRef.current.add(id);
        await adapter.remove(id);
        setNotes((prev) =>
          prev.some((n) => n.id === id) ? prev.filter((n) => n.id !== id) : prev,
        );
      },
      [adapter],
    );

    const setLeafIndex = useCallback(
      async (id: string, leafIndex: number) => {
        const startGen = generationRef.current;
        if (removedIdsRef.current.has(id)) return;
        const target = notesRef.current.find((n) => n.id === id);
        if (!target || target.leafIndex === leafIndex) return;
        const next: VaultNote = { ...target, leafIndex };
        await adapter.put(next);
        // Generation moved → put landed on the OLD adapter (correct
        // for that note's chain), but the new chain's notesRef is
        // empty and would falsely trigger the resurrection-undo
        // path. Bail.
        if (generationRef.current !== startGen) return;
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

    const markFailed = useCallback(
      async (id: string) => {
        const startGen = generationRef.current;
        if (removedIdsRef.current.has(id)) return;
        const target = notesRef.current.find((n) => n.id === id);
        if (!target || target.status === "failed") return;
        const next: VaultNote = { ...target, status: "failed", failedAt: Date.now() };
        await adapter.put(next);
        if (generationRef.current !== startGen) return;
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
      () => ({ notes, loaded, add, remove, setLeafIndex, markFailed }),
      [notes, loaded, add, remove, setLeafIndex, markFailed],
    );

    return <VaultCtx.Provider value={value}>{children}</VaultCtx.Provider>;
  }

  return { VaultProvider, useVault };
}
