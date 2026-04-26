"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CommitmentNote } from "@zkscatter/sdk/zk";

/** A note in the user's local vault. The full `CommitmentNote` is
 *  carried so spending circuits (authorize / claim) can spend this
 *  note later without re-deriving its preimage from on-chain data.
 *
 *  Phase 3e-i uses an in-memory React state store; Phase 6 swaps in
 *  a real storage adapter (filesystem on web, SQLite on mobile)
 *  from `@zkscatter/sdk/notes`. */
export interface VaultNote {
  /** Stable per-session id used as the React key. Generated with
   *  `crypto.randomUUID()` so two deposits in the same tick can't
   *  collide and a React key warning never fires. */
  id: string;
  /** Display label (e.g. `lot-1`). */
  label: string;
  /** Token symbol shown in the UI. */
  symbol: string;
  /** Display amount (already formatted; not used for math). */
  amount: string;
  /** Full commitment note — the secret material that lets us spend
   *  this entry. Storage adapters in Phase 6 will encrypt before
   *  persisting; today it lives in React state and dies on refresh. */
  note: CommitmentNote;
  /** Poseidon commitment derived from `note`. Cached so the order
   *  flow doesn't have to recompute it on every render. */
  commitment: bigint;
  /** When the note was added (ms epoch). */
  createdAt: number;
}

interface VaultState {
  notes: VaultNote[];
  add(n: Omit<VaultNote, "id" | "createdAt" | "label">): VaultNote;
  /** Remove a note by id (e.g. after a successful withdraw).
   *  Idempotent — a missing id is a no-op so double-fire from a
   *  modal's success handler doesn't blow up. */
  remove(id: string): void;
}

const VaultCtx = createContext<VaultState | null>(null);

export function useVault(): VaultState {
  const ctx = useContext(VaultCtx);
  if (!ctx) throw new Error("useVault must be used inside <VaultProvider>");
  return ctx;
}

function newId(): string {
  // crypto.randomUUID is available in modern browsers + Node 19+.
  // Fallback to a timestamp+random hex string for the rare host
  // that's missing it.
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  // Default to empty so the new empty-state UI is reachable on a
  // fresh load and "deposit adds a row" is visually verifiable.
  const [notes, setNotes] = useState<VaultNote[]>([]);
  // Ref instead of useState so two adds in the same tick get
  // distinct sequence numbers — same fix as OrdersProvider.
  const labelCounter = useRef(0);

  const add = useCallback(
    (n: Omit<VaultNote, "id" | "createdAt" | "label">) => {
      const seq = ++labelCounter.current;
      const note: VaultNote = {
        ...n,
        id: newId(),
        label: `lot-${seq}`,
        createdAt: Date.now(),
      };
      setNotes((prev) => [note, ...prev]);
      return note;
    },
    [],
  );

  const remove = useCallback((id: string) => {
    setNotes((prev) => (prev.some((n) => n.id === id) ? prev.filter((n) => n.id !== id) : prev));
  }, []);

  const value = useMemo<VaultState>(
    () => ({ notes, add, remove }),
    [notes, add, remove],
  );

  return <VaultCtx.Provider value={value}>{children}</VaultCtx.Provider>;
}
