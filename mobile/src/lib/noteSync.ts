/**
 * noteSync — promote locally-pending notes to 'active' once their
 * commitment hash shows up in the on-chain tree.
 *
 * Four screens (Home/Trade/History/Claim-indirect) can fire this on
 * focus or note mutation, and a single trade submit can fan-out to
 * multiple listeners that each want to re-sync. To avoid N concurrent
 * full-range CommitmentInserted scans:
 *   - concurrent callers for the same address share one in-flight fetch
 *   - results are cached briefly so a burst of listener fan-out reuses
 *     the leaves array instead of re-querying per screen
 */
import { ethers } from 'ethers';
import { NoteStorageService } from '../services/NoteStorageService';
import { ConfigService } from '../services/ConfigService';
import { COMMITMENT_POOL_ABI } from './contracts';

const TTL_MS = 3_000;
// Per-address dedupe for the write path (syncPendingNotes mutates per-wallet
// storage — two concurrent runs for the same wallet would race on the
// note-status update).
const inFlight = new Map<string, Promise<number>>();
// Per-pool dedupe for the READ path (CommitmentInserted scan is pool-wide,
// identical across wallets). Caches the in-flight promise itself so a burst
// of callers for different wallets share one queryFilter instead of each
// racing their own — the previous per-resolution cache only helped after
// the first scan returned. Keyed by pool address.
const leafFetch = new Map<string, Promise<string[]>>();
const leafCache = new Map<string, { at: number; leaves: string[] }>();

/**
 * Fetch every `CommitmentInserted` leaf for the pool, dedupe'd across
 * concurrent callers and briefly cached. Exported so `OrderService`'s
 * Merkle-proof fallback path can share the same cache as `syncPending*`
 * — a sync that just ran on screen focus won't re-scan when the user
 * immediately submits an order.
 */
export function fetchCommitmentLeaves(
  poolAddr: string,
  readProvider: ethers.JsonRpcProvider,
): Promise<string[]> {
  // Normalize casing so checksummed vs lowercase callers share one cache
  // entry — an unnormalized key would bypass dedupe and fire a redundant
  // full-range queryFilter for the same pool.
  const key = poolAddr.toLowerCase();
  const cached = leafCache.get(key);
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.leaves);
  const existing = leafFetch.get(key);
  if (existing) return existing;

  const run = (async () => {
    try {
      const pool = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, readProvider);
      const fromBlock = ConfigService.getDeployBlock();
      const events = await pool.queryFilter(pool.filters.CommitmentInserted(), fromBlock);
      const leaves = events.map((e) => {
        const parsed = pool.interface.parseLog({ topics: e.topics as string[], data: e.data });
        return parsed!.args.commitment.toString();
      });
      leafCache.set(key, { at: Date.now(), leaves });
      return leaves;
    } finally {
      leafFetch.delete(key);
    }
  })();

  leafFetch.set(key, run);
  return run;
}

export async function syncPendingNotesForAccount(
  address: string,
  readProvider: ethers.JsonRpcProvider,
): Promise<number> {
  const poolAddr = ConfigService.getCommitmentPoolAddress();
  if (!poolAddr) return 0;
  const key = address.toLowerCase();
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = (async () => {
    try {
      return await NoteStorageService.syncPendingNotes(address, null, () =>
        fetchCommitmentLeaves(poolAddr, readProvider),
      );
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}
