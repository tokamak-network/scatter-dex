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
const inFlight = new Map<string, Promise<number>>();
const leafCache = new Map<string, { at: number; leaves: string[] }>();

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
      const pool = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, readProvider);
      return await NoteStorageService.syncPendingNotes(address, null, async () => {
        const cached = leafCache.get(poolAddr);
        if (cached && Date.now() - cached.at < TTL_MS) return cached.leaves;
        const fromBlock = ConfigService.getDeployBlock();
        const events = await pool.queryFilter(pool.filters.CommitmentInserted(), fromBlock);
        const leaves = events.map((e) => {
          const parsed = pool.interface.parseLog({ topics: e.topics as string[], data: e.data });
          return parsed!.args.commitment.toString();
        });
        leafCache.set(poolAddr, { at: Date.now(), leaves });
        return leaves;
      });
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}
