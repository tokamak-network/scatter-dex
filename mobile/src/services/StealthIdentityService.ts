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
 * stored the one identity for the single wallet. On a load() whose
 * `address` matches the pre-upgrade built-in wallet (the only wallet
 * that could have produced the legacy blob — verified against
 * KeySecurityService's ADDRESS_KEY value), the blob is copied to the
 * per-address key and the migration marker is set BEFORE deleting the
 * legacy blob so a crash between the rekey and the delete leaves
 * re-runs as a flag-check no-op. If the first caller is NOT the
 * legacy-wallet owner (e.g. a WalletConnect session on a different
 * address), the blob is left in place for a later matching load() to
 * claim — auto-attributing to whoever connects first would silently
 * hand the spending+viewing keys to the wrong wallet.
 */
import * as SecureStore from 'expo-secure-store';
import { generateMetaAddress, MetaAddress } from '../lib/stealth';
import { eqAddr } from '../lib/address';

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
 * SecureStore key the legacy single-wallet KeySecurityService writes the
 * wallet address to (mirrors `ADDRESS_KEY` there). Reading it lets us
 * verify that a caller's `address` matches the wallet that produced the
 * legacy stealth blob, instead of blindly attributing to whichever
 * wallet happens to connect first after upgrade (e.g. a WalletConnect
 * session that doesn't own the legacy keys). Hardcoded rather than
 * imported from KeySecurityService so a future Phase 1 refactor to that
 * service can't silently change the value we compare against.
 */
const LEGACY_BUILTIN_ADDRESS_KEY = 'scatterdex_wallet_address';

/**
 * One-shot legacy-blob migration. Runs on the first load() call per
 * install. The legacy blob is only copied when the caller's `address`
 * matches the pre-upgrade built-in wallet address — otherwise we leave
 * it in place so a later load() with the right wallet can claim it.
 * Auto-attributing to the first caller would silently hand wallet A's
 * spending+viewing keys to wallet B when a user connects WalletConnect
 * first after upgrade. The marker is only set once migration actually
 * completes (or there's nothing to migrate), so deferred cases get a
 * second chance.
 */
async function migrateLegacyIfNeeded(address: string): Promise<void> {
  const marker = await SecureStore.getItemAsync(MIGRATION_MARKER);
  if (marker) return;

  const legacy = await SecureStore.getItemAsync(BASE_KEY);
  if (!legacy) {
    // No legacy data ever existed on this device — skip the check on
    // subsequent loads by setting the marker.
    await SecureStore.setItemAsync(MIGRATION_MARKER, 'done');
    return;
  }

  const legacyBuiltinAddress = await SecureStore.getItemAsync(LEGACY_BUILTIN_ADDRESS_KEY);
  if (!eqAddr(legacyBuiltinAddress, address)) {
    // The caller is not the owner of the legacy blob (or the owner is
    // unknown because the built-in wallet record is missing). Leave the
    // blob in place — migration will retry on a later load() call that
    // does match, or the user can delete the built-in wallet to drop
    // the data entirely.
    return;
  }

  // Only copy if the target slot is empty — a concurrent generate()
  // racing this call could have already written per-address data, and
  // overwriting would destroy the user's just-generated identity.
  const newKey = keyFor(address);
  const existing = await SecureStore.getItemAsync(newKey);
  if (!existing) {
    await SecureStore.setItemAsync(newKey, legacy, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }

  await SecureStore.setItemAsync(MIGRATION_MARKER, 'done');

  // Legacy delete is best-effort — the flag prevents re-migration even
  // if this fails. A transient keystore failure here would otherwise
  // leak the legacy blob on disk, but it'd never again be read.
  try { await SecureStore.deleteItemAsync(BASE_KEY); } catch { /* best-effort */ }
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
    // Run migration first so a regenerate called before any load() on
    // the legacy-wallet owner still absorbs the old blob into the
    // address-scoped keyspace before the overwrite. If `address` isn't
    // the legacy owner, migration is a no-op and the overwrite lands
    // cleanly under keyFor(address) without touching the legacy blob.
    await migrateLegacyIfNeeded(address);
    const identity = generateMetaAddress();
    await persist(address, identity);
    return identity;
  },

  async wipe(address: string): Promise<void> {
    await SecureStore.deleteItemAsync(keyFor(address));
  },
};
