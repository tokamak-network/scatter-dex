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
  /** Set to `"failed"` once the deposit transaction is proven to have
   *  NOT landed on-chain — i.e. its receipt reverted (`status === 0`).
   *  Such a note's commitment was never inserted, so it can never
   *  reconcile to a leaf and no funds were escrowed for it; the UI
   *  filters it out instead of showing it as Pending forever. Only set
   *  on a *reverted* receipt — a merely-not-yet-mined or successfully-
   *  mined-but-unindexed deposit is left untouched (deleting those
   *  could strand a real, recoverable note). */
  status?: "failed";
  /** When `status` was set (ms epoch). */
  failedAt?: number;
  /** Deposit transaction hash, when known. */
  txHash?: string;
  /** Chain id this note belongs to — apps should only show notes for
   *  the active network. */
  chainId?: number;
  /** Wallet address (lowercased, 0x-prefixed) that deposited this
   *  note. Used so the escrow / vault UI only shows notes whose
   *  spendable secret the connected wallet plausibly holds — without
   *  it, every wallet sharing a workspace folder sees every other
   *  wallet's notes and gets misleadingly Pending / Available chips
   *  for funds it can't actually claim.
   *
   *  Optional: notes written before this field existed (and notes
   *  the user explicitly wants visible across wallets) leave it
   *  undefined and pass through any `accountKey` filter. */
  account?: string;
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
  /** Number of records present in the backing store that the last
   *  load could NOT recover — e.g. encrypted rows read by an adapter
   *  whose decryption key isn't available yet. Meaningful only after
   *  `loadAll()` resolves; adapters without a locked concept omit it
   *  (read as 0). The vault provider surfaces this so apps can raise
   *  an "unlock" affordance instead of silently under-reporting. */
  lockedCount?(): number;
}
