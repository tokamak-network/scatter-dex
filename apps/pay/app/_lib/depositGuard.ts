import { isPendingDeposit } from "./sourceNotes";

/** The fields {@link assessDepositRetry} reads off a vault note. A
 *  `StoredNote` satisfies this structurally, so callers pass notes
 *  straight through. */
export interface PendingDepositNote {
  /** Poseidon commitment — looked up against the on-chain tree. */
  commitment: bigint;
  /** Deposit tx hash, when we broadcast it ourselves (sequential path).
   *  Empty/undefined for the atomic-batch path, where only a 5792
   *  bundle id exists and the per-tx hash isn't known until confirmed. */
  txHash?: string;
  /** `-1` while the deposit hasn't reconciled to a leaf yet. */
  leafIndex: number;
  /** Set once the deposit is proven to have reverted. */
  status?: "failed";
}

/** A tx receipt, reduced to the one field the guard needs. */
export interface MinimalReceipt {
  /** `1` mined-ok, `0` reverted, `null` for ethers' pre-confirmation
   *  shape. */
  status: number | null;
}

export interface RetryGuardDeps {
  /** Force one commitment-tree re-hydrate. Fire-and-forget (the SDK's
   *  `tree.refresh` returns void); the tree mutates its shared index in
   *  place, so we poll {@link RetryGuardDeps.findIndex} afterwards. */
  refreshTree: () => void;
  /** Synchronous lookup against the in-memory tree index. `>= 0` means
   *  the commitment has landed on-chain. The tree verifies its own
   *  hydration (rejecting forked / out-of-sync leaf sets), so a hit is
   *  trustworthy positive evidence. */
  findIndex: (commitment: bigint) => number;
  /** Fetch a tx receipt. `null` means *either* still-pending *or*
   *  dropped/unknown — ethers can't tell them apart from the receipt
   *  alone, so {@link RetryGuardDeps.getTransaction} disambiguates. Only
   *  called for notes that carry a `txHash`. Optional: when absent (no
   *  wallet provider), the guard falls back to tree-only evidence. */
  getReceipt?: (txHash: string) => Promise<MinimalReceipt | null>;
  /** Fetch the tx itself. `null` = the node doesn't know this hash —
   *  i.e. it was dropped from the mempool or never broadcast, so a retry
   *  must be *allowed* rather than blocked forever. A non-null result
   *  with a null receipt is a genuine mempool-pending tx → block.
   *  Optional; without it a null receipt is treated conservatively as
   *  pending (block). */
  getTransaction?: (txHash: string) => Promise<unknown | null>;
  /** Injectable sleep — overridden in tests to avoid real timers. */
  sleep?: (ms: number) => Promise<void>;
}

export interface RetryGuardResult {
  /** `true` when a retry would risk a duplicate deposit. */
  block: boolean;
  /** User-facing reason; set iff `block`. */
  message?: string;
}

/** Poll budget: 24 × 250 ms = 6 s. Sits inside the
 *  `getMerkleProofWithFallback` 7.5 s envelope — long enough to catch a
 *  just-mined commitment the in-memory index hasn't picked up, short
 *  enough not to stall a legitimate fresh deposit. */
const POLL_TRIES = 24;
const POLL_INTERVAL_MS = 250;

const DEPOSIT_LANDED_MSG =
  "Your previous deposit is already on-chain and still reconciling. " +
  "Wait for it to finish — re-depositing now would lock the funds in a " +
  "second, separate note.";
const DEPOSIT_PENDING_MSG =
  "Your previous deposit transaction is still pending (not yet mined). " +
  "Wait for it to confirm before depositing again.";

/**
 * On-chain recheck before allowing a deposit *retry*. Call this only for
 * pending notes that have already aged past the wall-clock confirming
 * window — the in-window block stays enforced separately and
 * unconditionally (see `hasConfirmingDeposit`). This closes the gap where
 * a deposit that genuinely landed (but whose confirmation/reconcile
 * lagged past the window) would otherwise let a confused user re-deposit
 * and lock 2× the funds.
 *
 * Conservative by construction: it only *adds* a block — it never trusts
 * a bare `findIndex < 0` to permit a retry. A retry is allowed (returns
 * `block: false`) only when no pending note shows positive landed/pending
 * evidence:
 *   - a commitment in the tree                    → block (landed)
 *   - a `status === 1` receipt                    → block (landed)
 *   - a `null` receipt for a broadcast tx         → block (mempool)
 *   - a `status === 0` receipt                    → reverted, ignored
 *   - no txHash + not in tree (atomic batch)      → ambiguous, ignored
 *     here; the caller's confirmation modal owns that last sliver.
 */
export async function assessDepositRetry(
  pending: readonly PendingDepositNote[],
  deps: RetryGuardDeps,
): Promise<RetryGuardResult> {
  const live = pending.filter(isPendingDeposit);
  if (live.length === 0) return { block: false };

  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  // One forced re-hydrate, then poll the shared index for *any* of the
  // live pending notes to surface on-chain. Polling all of them per tick
  // bounds the total wait to ~6 s regardless of how many are pending.
  // The first iteration checks before sleeping (catches an already-landed
  // commitment with zero wait).
  deps.refreshTree();
  const landed = () => live.some((n) => deps.findIndex(n.commitment) >= 0);
  for (let i = 0; i <= POLL_TRIES; i++) {
    if (i > 0) await sleep(POLL_INTERVAL_MS);
    if (landed()) return { block: true, message: DEPOSIT_LANDED_MSG };
  }

  // None landed in the tree. For notes we broadcast ourselves, the
  // receipt is authoritative: mined-ok or still-pending → block;
  // reverted → that note is dead, keep checking the rest.
  if (deps.getReceipt) {
    for (const n of live) {
      if (!n.txHash) continue;
      const receipt = await deps.getReceipt(n.txHash).catch(() => undefined);
      // Couldn't read it — don't manufacture a block from a transport
      // error; let the next note (or the caller's modal) decide.
      if (receipt === undefined) continue;
      if (receipt === null) {
        // No receipt = still pending OR dropped. ethers can't tell them
        // apart from the receipt, so ask for the tx: a known tx is a
        // genuine mempool-pending deposit (block); an unknown one was
        // dropped/never-broadcast (allow the retry rather than block it
        // forever — the phantom detector never fires on a tx with no
        // receipt at all).
        if (deps.getTransaction) {
          const tx = await deps.getTransaction(n.txHash).catch(() => undefined);
          if (tx === undefined) continue; // transport error → don't block
          if (tx === null) continue; // dropped/unknown → allow retry
        }
        return { block: true, message: DEPOSIT_PENDING_MSG };
      }
      if (receipt.status === 1) return { block: true, message: DEPOSIT_LANDED_MSG };
      // status === 0 → reverted; the phantom detector marks it failed.
    }
  }

  return { block: false };
}
