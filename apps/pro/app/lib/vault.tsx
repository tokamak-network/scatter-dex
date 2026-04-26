"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

/** A note in the user's local vault. Phase 2b-ii uses an in-memory
 *  React state store; Phase 6 swaps in a real storage adapter
 *  (filesystem on web, SQLite on mobile) from `@zkscatter/sdk/notes`. */
export interface VaultNote {
  /** Display id (e.g. `lot-3`). Stable per-session. */
  id: string;
  /** Token symbol shown in the UI. */
  symbol: string;
  /** Display amount (already formatted). */
  amount: string;
  /** Poseidon commitment from `generateDepositProof`. Truncated for
   *  display; the full value is needed by the spending circuits. */
  commitment: bigint;
  /** When the note was added (ms epoch). */
  createdAt: number;
}

interface VaultState {
  notes: VaultNote[];
  add(n: Omit<VaultNote, "id" | "createdAt">): VaultNote;
}

const VaultCtx = createContext<VaultState | null>(null);

export function useVault(): VaultState {
  const ctx = useContext(VaultCtx);
  if (!ctx) throw new Error("useVault must be used inside <VaultProvider>");
  return ctx;
}

const SEED_NOTES: VaultNote[] = [
  { id: "lot-3", symbol: "ETH", amount: "8.40", commitment: 0n, createdAt: 0 },
  { id: "lot-5", symbol: "USDC", amount: "12,500", commitment: 0n, createdAt: 0 },
];

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [notes, setNotes] = useState<VaultNote[]>(SEED_NOTES);

  const add = useCallback((n: Omit<VaultNote, "id" | "createdAt">) => {
    const note: VaultNote = {
      ...n,
      id: `lot-${Math.floor(Math.random() * 9000 + 1000)}`,
      createdAt: Date.now(),
    };
    setNotes((prev) => [note, ...prev]);
    return note;
  }, []);

  const value = useMemo<VaultState>(() => ({ notes, add }), [notes, add]);

  return <VaultCtx.Provider value={value}>{children}</VaultCtx.Provider>;
}
