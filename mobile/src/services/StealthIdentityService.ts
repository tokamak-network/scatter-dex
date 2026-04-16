/**
 * StealthIdentityService — persists the user's meta-address keys.
 *
 * `spendingKey` and `viewingKey` are sensitive (anyone with both can
 * derive every stealth-address private key the user ever receives), so
 * they live in SecureStore. The `metaAddress` itself is publishable and
 * kept alongside for convenience.
 *
 * Stored as a single JSON blob — there's only ever one identity per
 * device today; a future multi-identity flow can extend the shape.
 */
import * as SecureStore from 'expo-secure-store';
import { generateMetaAddress, MetaAddress } from '../lib/stealth';
import { STORAGE_NS } from '../constants';

const STORAGE_KEY = `${STORAGE_NS}_stealth_identity_v1`;

const persist = (identity: MetaAddress) =>
  SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(identity), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });

export const StealthIdentityService = {
  async load(): Promise<MetaAddress | null> {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.spendingKey === 'string'
        && typeof parsed?.viewingKey === 'string'
        && typeof parsed?.metaAddress === 'string'
      ) {
        return parsed as MetaAddress;
      }
      // Shape mismatch — drop and re-derive on next call (matches the
      // pattern in EdDSAKeyService.loadKey). Best-effort delete: a
      // transient keystore failure shouldn't make `load` throw and block
      // the caller from offering Generate.
      console.warn('StealthIdentityService.load: corrupted entry, dropping');
      try { await SecureStore.deleteItemAsync(STORAGE_KEY); } catch { /* best-effort */ }
      return null;
    } catch (err) {
      console.warn('StealthIdentityService.load: parse failed, dropping', err);
      try { await SecureStore.deleteItemAsync(STORAGE_KEY); } catch { /* best-effort */ }
      return null;
    }
  },

  /**
   * Generate a fresh meta-address. Returns the new identity AND throws
   * if one already exists, so callers explicitly choose to overwrite via
   * the regenerate path. (Overwriting silently would invalidate every
   * stealth claim already issued against the previous meta-address.)
   */
  async generate(): Promise<MetaAddress> {
    // Use `load()` so a corrupted-but-present blob doesn't permanently
    // block generation. `load()` drops the corrupted entry and returns
    // null, letting us proceed.
    const existing = await this.load();
    if (existing) {
      throw new Error('Stealth identity already exists. Use `regenerate` to replace.');
    }
    const identity = generateMetaAddress();
    await persist(identity);
    return identity;
  },

  /** Force-replace the stored identity. Returns the new one. */
  async regenerate(): Promise<MetaAddress> {
    const identity = generateMetaAddress();
    await persist(identity);
    return identity;
  },

  async wipe(): Promise<void> {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
  },
};
