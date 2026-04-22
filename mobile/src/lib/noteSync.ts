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

function fetchLeaves(
  poolAddr: string,
  readProvider: ethers.JsonRpcProvider,
): Promise<string[]> {
  const cached = leafCache.get(poolAddr);
  if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached.leaves);
  const existing = leafFetch.get(poolAddr);
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
      leafCache.set(poolAddr, { at: Date.now(), leaves });
      return leaves;
    } finally {
      leafFetch.delete(poolAddr);
    }
  })();

  leafFetch.set(poolAddr, run);
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
        fetchLeaves(poolAddr, readProvider),
      );
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}
