/**
 * EscrowNullifierSync — reconcile local `StoredNote.status` with
 * on-chain nullifier state.
 *
 * Local status is written by the mobile app when it issues
 * deposit/trade/cancel transactions, but it can drift if the user
 * settles a trade from a different device, or if a relayer settled
 * the order in the background. This service walks every active note
 * in `NoteStorageService` for a given wallet, computes the escrow
 * nullifier (`computeNullifier('0', secret, salt)`), and asks
 * `PrivateSettlement.nullifiers(n)` whether it's been spent. Any hit
 * gets `updateNoteStatus('spent')`.
 *
 * Per-wallet: the caller passes `address`, and only that wallet's
 * notes are queried. Matches the Phase 2.5 per-address keying.
 *
 * Cheap on the hot path: this is a read-only probe, no gas. One
 * `nullifiers()` call per active note, fanned out in parallel — for
 * the typical user with <20 active notes that's a single RPC roundtrip
 * from a batched provider. The cost is bounded by N (active notes),
 * not M (all events ever), which was the alternative (log filter on
 * nullifier events from earliestBlock).
 */
import { ethers } from 'ethers';
import { NoteStorageService } from './NoteStorageService';
import { ZKBridgeService } from './ZKBridgeService';
import { ConfigService } from './ConfigService';
import { PRIVATE_SETTLEMENT_ABI } from '../lib/contracts';
import { toBytes32Hex } from '../lib/format';

export interface NullifierSyncResult {
  /** How many active notes were checked. */
  checked: number;
  /** How many were re-marked spent. */
  marked: number;
}

export const EscrowNullifierSync = {
  /**
   * Walk `address`'s active notes and flip any whose escrow nullifier
   * is already burnt on-chain to `spent`. Safe to call on a hot path:
   * all work is read-only RPC, and a failure at any step short-circuits
   * to a no-op return rather than mutating local state.
   */
  async sync(address: string, readProvider: ethers.Provider): Promise<NullifierSyncResult> {
    const settlementAddr = ConfigService.getPrivateSettlementAddress();
    if (!settlementAddr) return { checked: 0, marked: 0 };

    const active = await NoteStorageService.getActiveNotes(address);
    if (active.length === 0) return { checked: 0, marked: 0 };

    const pool = new ethers.Contract(settlementAddr, PRIVATE_SETTLEMENT_ABI, readProvider);

    // Compute the nullifier for every active note in parallel. `tag='0'`
    // matches the escrow-spend nullifier (vs `'1'` for the nonce-spend
    // side used by Cancel / relayer flows).
    const probes = await Promise.all(active.map(async (note) => {
      try {
        const decimal = await ZKBridgeService.computeNullifier('0', note.secret, note.salt);
        const hex = toBytes32Hex(decimal);
        const spent: boolean = await pool.nullifiers(hex);
        return { noteId: note.id, spent };
      } catch {
        // Per-note probe failure shouldn't poison the whole sync. Leave
        // the local status as-is — next sync will retry.
        return { noteId: note.id, spent: false };
      }
    }));

    const spentIds = probes.filter((p) => p.spent).map((p) => p.noteId);
    if (spentIds.length === 0) return { checked: active.length, marked: 0 };

    await Promise.all(spentIds.map((id) => NoteStorageService.updateNoteStatus(address, id, 'spent')));
    return { checked: active.length, marked: spentIds.length };
  },
};
