/**
 * noteSync — promote locally-pending notes to 'active' once their
 * commitment hash shows up in the on-chain tree.
 *
 * Four screens (Home/Trade/History/Claim-indirect) can fire this on
 * focus or note mutation. The pool-wide event scan is delegated to
 * `commitmentScan` which handles chunking + persistent checkpointing;
 * the per-address dedupe below guards the write path (SecureStore note
 * mutations) from racing itself.
 */
import { ethers } from 'ethers';
import { NoteStorageService } from '../services/NoteStorageService';
import { ConfigService } from '../services/ConfigService';
import { getCommitmentLeaves } from './commitmentScan';

const inFlight = new Map<string, Promise<number>>();

export async function syncPendingNotesForAccount(
  address: string,
  readProvider: ethers.JsonRpcProvider,
): Promise<number> {
  const poolAddr = ConfigService.getCommitmentPoolAddress();
  if (!poolAddr) return 0;
  const chainId = ConfigService.getChainId();
  const key = address.toLowerCase();
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = (async () => {
    try {
      return await NoteStorageService.syncPendingNotes(address, null, () =>
        getCommitmentLeaves(poolAddr, readProvider, chainId),
      );
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, run);
  return run;
}
