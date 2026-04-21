/**
 * StealthIdentityService — persists the user's meta-address keys, scoped
 * per wallet address.
 *
 * `spendingKey` and `viewingKey` are sensitive (anyone with both can
 * derive every stealth-address private key the user ever receives), so
 * they live in SecureStore. The `metaAddress` itself is publishable and
 * kept alongside for convenience.
 *
 * Storage layout (multi-wallet, v2):
 *   scatterdex_stealth_identity_v1_<addr>: SecureStore — JSON MetaAddress
 *                                          per wallet (addr = lowercase 0x hex).
 *   scatterdex_stealth_migrated_v2:        SecureStore — `'done'` once the
 *                                          legacy single-wallet blob has
 *                                          been rekeyed to the per-address
 *                                          shape.
 *
 * Legacy (v1, single-wallet) shape: `scatterdex_stealth_identity_v1`
 * stored the one identity for the single wallet. On first multi-wallet
 * load() with an address, that blob is copied to the per-address key
 * (if the target doesn't already have one) and the migration marker is
 * set BEFORE deleting the legacy blob — so a crash between the rekey
 * and the delete leaves re-runs as a flag-check no-op.
 */
import * as SecureStore from 'expo-secure-store';
import { generateMetaAddress, MetaAddress } from '../lib/stealth';

const BASE_KEY = 'scatterdex_stealth_identity_v1';
const MIGRATION_MARKER = 'scatterdex_stealth_migrated_v2';

/** Shared Alert copy for screens that need an active wallet before
 *  calling StealthIdentityService — keeps the message consistent
 *  across ClaimScreen / SettingsScreen. */
export const STEALTH_WALLET_REQUIRED_ALERT = {
  title: 'Wallet not connected',
  body: 'Connect your wallet first — stealth identities are scoped per wallet.',
} as const;

function keyFor(address: string): string {
  return `${BASE_KEY}_${address.toLowerCase()}`;
}

const persist = (address: string, identity: MetaAddress) =>
  SecureStore.setItemAsync(keyFor(address), JSON.stringify(identity), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });

/**
 * One-shot legacy-blob migration. Runs on the first load() call per
 * install. If the legacy key holds an identity, it is copied to the
 * per-address slot for the currently active wallet (the only wallet
 * that could have produced the legacy blob). The marker is set before
 * the legacy delete so a crash in between turns the next run into a
 * no-op via the flag check.
 */
async function migrateLegacyIfNeeded(address: string): Promise<void> {
  const marker = await SecureStore.getItemAsync(MIGRATION_MARKER);
  if (marker) return;

  const legacy = await SecureStore.getItemAsync(BASE_KEY);
  if (legacy) {
    // Only copy if the target slot is empty — a concurrent generate()
    // on a fresh install could have already written per-address data,
    // and overwriting would destroy the user's just-generated identity.
    const newKey = keyFor(address);
    const existing = await SecureStore.getItemAsync(newKey);
    if (!existing) {
      await SecureStore.setItemAsync(newKey, legacy, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    }
  }

  await SecureStore.setItemAsync(MIGRATION_MARKER, 'done');

  // Legacy delete is best-effort — the flag prevents re-migration even
  // if this fails. A transient keystore failure here would otherwise
  // leak the legacy blob on disk, but it'd never again be read.
  if (legacy) {
    try { await SecureStore.deleteItemAsync(BASE_KEY); } catch { /* best-effort */ }
  }
}

export const StealthIdentityService = {
  async load(address: string): Promise<MetaAddress | null> {
    await migrateLegacyIfNeeded(address);
    const raw = await SecureStore.getItemAsync(keyFor(address));
    if (!raw) return null;
    // Shape or parse failures both drop the entry so the next call can
    // re-derive cleanly — mirrors EdDSAKeyService.loadKey. Best-effort
    // delete: a transient keystore failure shouldn't make `load` throw
    // and block the caller from offering Generate.
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.spendingKey === 'string'
        && typeof parsed?.viewingKey === 'string'
        && typeof parsed?.metaAddress === 'string'
      ) {
        return parsed as MetaAddress;
      }
      console.warn('StealthIdentityService.load: corrupted entry, dropping');
    } catch (err) {
      console.warn('StealthIdentityService.load: parse failed, dropping', err);
    }
    try { await SecureStore.deleteItemAsync(keyFor(address)); } catch { /* best-effort */ }
    return null;
  },

  /**
   * Generate a fresh meta-address for `address`. Returns the new identity
   * AND throws if one already exists, so callers explicitly choose to
   * overwrite via the regenerate path. (Overwriting silently would
   * invalidate every stealth claim already issued against the previous
   * meta-address.)
   */
  async generate(address: string): Promise<MetaAddress> {
    // Use `load()` so a corrupted-but-present blob doesn't permanently
    // block generation. `load()` drops the corrupted entry and returns
    // null, letting us proceed.
    const existing = await this.load(address);
    if (existing) {
      throw new Error('Stealth identity already exists. Use `regenerate` to replace.');
    }
    const identity = generateMetaAddress();
    await persist(address, identity);
    return identity;
  },

  /** Force-replace the stored identity for `address`. Returns the new one. */
  async regenerate(address: string): Promise<MetaAddress> {
    // Run migration to absorb any legacy blob before we overwrite — the
    // marker-set-before-delete ordering means a crash here still leaves
    // the flag set, and a re-run finds per-address data (just-written).
    await migrateLegacyIfNeeded(address);
    const identity = generateMetaAddress();
    await persist(address, identity);
    return identity;
  },

  async wipe(address: string): Promise<void> {
    await SecureStore.deleteItemAsync(keyFor(address));
  },
};
