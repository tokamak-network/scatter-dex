/**
 * EscrowHiddenStorage — per-wallet local hide flags for escrow commitments.
 *
 * Notes themselves live in `NoteStorageService` keyed by status
 * (active/pending/spent). "Hidden" is a local-only view filter —
 * nothing changes on chain, the note is still spendable. Users who
 * want to declutter their EscrowList (e.g. dust notes, old settled
 * commitments) flip the hide flag; the row moves to the "Hidden"
 * tab without losing the underlying note data.
 *
 * Per-wallet keyed because a wallet's hide-list is part of that
 * wallet's UX preferences — switching wallets should not pick up the
 * other wallet's hidden rows. Matches the Phase 2.5 pattern used by
 * AddressBookService / PendingClaimsStorage / StealthIdentityService.
 *
 * Storage: AsyncStorage (non-sensitive — just note ids).
 *   scatterdex_escrow_hidden_<addr>: JSON `string[]` of note ids
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY_PREFIX = 'scatterdex_escrow_hidden_';

function keyFor(address: string): string {
  return `${KEY_PREFIX}${address.toLowerCase()}`;
}

export const EscrowHiddenStorage = {
  /** Returns the set of hidden note ids for `address`. Empty array on
   *  miss or corruption — callers must treat this as a best-effort
   *  view filter, not a source of truth. */
  async get(address: string): Promise<string[]> {
    const raw = await AsyncStorage.getItem(keyFor(address));
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((v): v is string => typeof v === 'string');
    } catch {
      // Drop corrupted blob so we don't re-parse the same error forever.
      try { await AsyncStorage.removeItem(keyFor(address)); } catch { /* best-effort */ }
      return [];
    }
  },

  /** Mark `id` hidden for `address`. Idempotent. */
  async hide(address: string, id: string): Promise<void> {
    const ids = await this.get(address);
    if (ids.includes(id)) return;
    ids.push(id);
    await AsyncStorage.setItem(keyFor(address), JSON.stringify(ids));
  },

  /** Unhide `id` for `address`. Idempotent. */
  async unhide(address: string, id: string): Promise<void> {
    const ids = await this.get(address);
    const next = ids.filter((x) => x !== id);
    if (next.length === ids.length) return;
    await AsyncStorage.setItem(keyFor(address), JSON.stringify(next));
  },

  /** Drop all hide flags for `address`. Used by Delete Wallet flow. */
  async wipe(address: string): Promise<void> {
    await AsyncStorage.removeItem(keyFor(address));
  },
};
