/**
 * noteSync — promote locally-pending notes to 'active' once their
 * commitment hash shows up in the on-chain tree.
 *
 * Change UTXOs are saved during order submit with `leafIndex=-1` /
 * `status='pending'` because the relayer's scatterDirectAuth /
 * settleAuth hasn't executed yet. Home / History call this on focus
 * so the user doesn't have to reload the app to see the transition.
 */
import { ethers } from 'ethers';
import { NoteStorageService } from '../services/NoteStorageService';
import { ConfigService } from '../services/ConfigService';
import { COMMITMENT_POOL_ABI } from './contracts';

export async function syncPendingNotesForAccount(
  address: string,
  readProvider: ethers.JsonRpcProvider,
): Promise<number> {
  const poolAddr = ConfigService.getCommitmentPoolAddress();
  if (!poolAddr) return 0;
  const pool = new ethers.Contract(poolAddr, COMMITMENT_POOL_ABI, readProvider);
  return NoteStorageService.syncPendingNotes(address, null, async () => {
    const fromBlock = ConfigService.getDeployBlock();
    const events = await pool.queryFilter(pool.filters.CommitmentInserted(), fromBlock);
    return events.map((e) => {
      const parsed = pool.interface.parseLog({ topics: e.topics as string[], data: e.data });
      return parsed!.args.commitment.toString();
    });
  });
}
