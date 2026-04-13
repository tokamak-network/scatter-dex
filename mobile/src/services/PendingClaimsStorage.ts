/**
 * PendingClaimsStorage — single source of truth for post-settlement claim data.
 *
 * Each stored entry is what ClaimScreen needs to build a claim proof later:
 * the claim `secret`, the recipient/token/amount/releaseTime, and the full
 * 16-leaf claims tree used to compute the Merkle proof. Without the secret
 * the user cannot withdraw, so writes here are load-bearing — callers must
 * propagate failures (do NOT swallow).
 *
 * Today the `secret` is stored in AsyncStorage (unencrypted). Migrating it
 * into SecureStore is tracked in #233 "Secrets in AsyncStorage"; routing
 * every reader/writer through this module is the first step so the
 * migration is a single edit.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const PENDING_CLAIMS_KEY = 'scatterdex_pending_claims';

export interface PendingClaim {
  secret: string;          // decimal string
  recipient: string;       // 0x-prefixed address
  token: string;           // 0x-prefixed address
  amount: string;          // wei string
  releaseTime: string;     // unix seconds string
  leafIndex: number;       // position in the 16-leaf claims tree
  allLeaves: string[];     // all 16 claim leaf hashes (decimal strings)
  txHash: string;          // settle / order tx hash (best-effort for display)
}

export const PendingClaimsStorage = {
  async list(): Promise<PendingClaim[]> {
    const raw = await AsyncStorage.getItem(PENDING_CLAIMS_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      // Corrupt blob — behave like empty but don't wipe (the user may be
      // able to recover manually). A separate repair flow can clean up.
      return [];
    }
  },

  /** Append entries. Throws on write failure — callers must NOT catch silently:
   *  losing a claim secret is a permanent fund-loss. */
  async append(entries: PendingClaim[]): Promise<void> {
    if (entries.length === 0) return;
    const existing = await this.list();
    const next = [...existing, ...entries];
    await AsyncStorage.setItem(PENDING_CLAIMS_KEY, JSON.stringify(next));
  },

  async replace(next: PendingClaim[]): Promise<void> {
    await AsyncStorage.setItem(PENDING_CLAIMS_KEY, JSON.stringify(next));
  },
};
