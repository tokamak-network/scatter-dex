import type { CommitmentNote } from "../zk/commitment";

/** Persistent note record. Carries everything an app needs to spend
 *  (`note` preimage), display (`symbol`, `amount`, `label`), and
 *  reconcile against chain state (`leafIndex`, `txHash`, `chainId`).
 *
 *  BigInts are kept native here; adapters handle wire-format
 *  serialization (hex strings) at the storage boundary. */
export interface StoredNote {
  /** Stable per-record id (uuid). */
  id: string;
  /** Display label, e.g. `lot-1`. */
  label: string;
  /** Token symbol shown in the UI. */
  symbol: string;
  /** Display amount string (already formatted for the UI). Not used
   *  for math — `note.amount` is the canonical raw value. */
  amount: string;
  /** Full commitment-note preimage. The secret material that lets
   *  the holder spend the deposit. */
  note: CommitmentNote;
  /** Poseidon commitment derived from `note`. Cached so callers
   *  don't recompute on every render. */
  commitment: bigint;
  /** On-chain leaf index. `-1` when the deposit's
   *  `CommitmentInserted` event hasn't been reconciled yet. */
  leafIndex: number;
  /** Deposit transaction hash, when known. */
  txHash?: string;
  /** Chain id this note belongs to — apps should only show notes for
   *  the active network. */
  chainId?: number;
  /** When the note was added (ms epoch). */
  createdAt: number;
}

/** Storage adapter contract. Implementations: in-memory (tests / SSR),
 *  IndexedDB (browser), and (future) AsyncStorage / SQLite for RN. */
export interface NoteStorageAdapter {
  /** Resolve once the adapter is ready (e.g. IDB open completed).
   *  Idempotent: subsequent calls return the same promise. */
  ready(): Promise<void>;
  /** Load all notes, ordered oldest → newest by `createdAt`. */
  loadAll(): Promise<StoredNote[]>;
  /** Insert or update a note by id. */
  put(note: StoredNote): Promise<void>;
  /** Remove by id. Idempotent — a missing id is a no-op. */
  remove(id: string): Promise<void>;
  /** Remove every note. Used for "reset wallet" / "switch account". */
  clear(): Promise<void>;
}
