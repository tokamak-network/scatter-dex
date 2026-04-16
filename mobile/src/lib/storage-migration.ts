/**
 * One-time storage key migration: scatterdex_* → zkscatterdex_*
 *
 * Runs on first launch after the rename. Each mapping is parallelised
 * per-key; per-mapping failures propagate so the `MIGRATION_DONE_KEY`
 * marker is only set if *all* mappings succeeded. On partial failure
 * the next launch re-runs the migration.
 *
 * Each SecureStore mapping carries the same `keychainAccessible` flag
 * the owning service uses on its own writes — mirroring the per-service
 * semantics (WHEN_UNLOCKED_THIS_DEVICE_ONLY for wallet/secret data,
 * default for non-sensitive metadata) so migration never accidentally
 * tightens or relaxes access.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { STORAGE_NS } from '../constants';

const LEGACY_NS = 'scatterdex';
const MIGRATION_DONE_KEY = `${STORAGE_NS}_rename_migration_done`;

let migrationPromise: Promise<void> | null = null;

type StoreKind = 'async' | 'secure';

interface KeyMapping {
  oldKey: string;
  newKey: string;
  store: StoreKind;
  /** SecureStore only — mirrors the owning service's write option. */
  keychainAccessible?: SecureStore.KeychainAccessibilityConstant;
}

/** Helper to build parallel mapping pairs from a shared suffix. */
function pair(
  suffix: string,
  store: StoreKind,
  keychainAccessible?: SecureStore.KeychainAccessibilityConstant,
): KeyMapping {
  return {
    oldKey: `${LEGACY_NS}_${suffix}`,
    newKey: `${STORAGE_NS}_${suffix}`,
    store,
    keychainAccessible,
  };
}

/**
 * Migrate a single old→new pair. Skips if old is absent or new already
 * exists. Throws on unexpected read/write failure so the caller can
 * decide whether to mark the migration complete.
 */
async function migrateOne(mapping: KeyMapping): Promise<void> {
  const { oldKey, newKey, store, keychainAccessible } = mapping;
  if (store === 'secure') {
    const existing = await SecureStore.getItemAsync(newKey);
    if (existing !== null) return;
    const value = await SecureStore.getItemAsync(oldKey);
    if (value === null) return;
    const opts = keychainAccessible ? { keychainAccessible } : undefined;
    await SecureStore.setItemAsync(newKey, value, opts);
    await SecureStore.deleteItemAsync(oldKey);
  } else {
    const existing = await AsyncStorage.getItem(newKey);
    if (existing !== null) return;
    const value = await AsyncStorage.getItem(oldKey);
    if (value === null) return;
    await AsyncStorage.setItem(newKey, value);
    await AsyncStorage.removeItem(oldKey);
  }
}

/**
 * Run all mappings in parallel. Returns true only if every mapping
 * succeeded — so the caller can skip the done-marker on partial failure
 * and retry next launch.
 */
async function migrateAll(mappings: KeyMapping[]): Promise<boolean> {
  const results = await Promise.all(mappings.map(async (m) => {
    try {
      await migrateOne(m);
      return true;
    } catch (err) {
      console.warn(`storage-migration: ${m.oldKey} → ${m.newKey} failed`, err);
      return false;
    }
  }));
  return results.every(Boolean);
}

/**
 * Run the full rename migration for all services. Safe to call
 * multiple times — deduped via promise cache, and a success marker
 * short-circuits future launches.
 */
export function ensureRenameMigration(): Promise<void> {
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    const done = await AsyncStorage.getItem(MIGRATION_DONE_KEY);
    if (done === '1') return;

    // Mirror each service's own write options so migration doesn't
    // silently change keychain accessibility. See file header.
    const UNLOCKED_THIS_DEVICE = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

    const mappings: KeyMapping[] = [
      // KeySecurityService
      pair('wallet_pk', 'secure', UNLOCKED_THIS_DEVICE),
      pair('wallet_mnemonic', 'secure', UNLOCKED_THIS_DEVICE),
      pair('wallet_address', 'secure'), // no options in original writer
      pair('biometric_enabled', 'secure'),

      // StealthIdentityService
      pair('stealth_identity_v1', 'secure', UNLOCKED_THIS_DEVICE),

      // NoteStorageService (notes are per-id, handled below after index move)
      pair('note_index', 'async'),

      // PendingClaimsStorage
      pair('pending_claim_ids', 'async'),
      pair('pending_claims', 'async'),
      pair('pending_claims_migrated_v1', 'async'),

      // AddressBookService
      pair('wallet_book_v1', 'async'),

      // NetworkService
      pair('custom_networks', 'async'),
      pair('selected_network', 'async'),

      // ProviderService
      pair('earliest_block', 'async'),
    ];

    const baseOk = await migrateAll(mappings);

    // Per-id keys need the migrated indexes above to discover ids.
    const indexedOk = await migrateIndexedKeys();

    if (baseOk && indexedOk) {
      await AsyncStorage.setItem(MIGRATION_DONE_KEY, '1');
    } else {
      console.warn('storage-migration: partial failure — will retry next launch');
    }
  })().catch((err) => {
    migrationPromise = null;
    throw err;
  });

  return migrationPromise;
}

/**
 * Per-id keys that use prefix + dynamic suffix. Reads the (already-
 * migrated) index to discover ids, then migrates each one.
 */
async function migrateIndexedKeys(): Promise<boolean> {
  const tasks: Array<Promise<boolean>> = [];

  // NoteStorageService — notes use SecureStore without explicit
  // keychainAccessible, so we preserve the default.
  const noteIndexRaw = await AsyncStorage.getItem(`${STORAGE_NS}_note_index`);
  if (noteIndexRaw) {
    try {
      const noteIds: string[] = JSON.parse(noteIndexRaw);
      for (const id of noteIds) {
        tasks.push(runOne({
          oldKey: `${LEGACY_NS}_note_${id}`,
          newKey: `${STORAGE_NS}_note_${id}`,
          store: 'secure',
        }));
      }
    } catch (err) {
      console.warn('storage-migration: note index parse failed', err);
      return false;
    }
  }

  // PendingClaimsStorage — per-id meta (AsyncStorage) + secret (SecureStore)
  const claimIdsRaw = await AsyncStorage.getItem(`${STORAGE_NS}_pending_claim_ids`);
  if (claimIdsRaw) {
    try {
      const claimIds: string[] = JSON.parse(claimIdsRaw);
      for (const id of claimIds) {
        tasks.push(runOne({
          oldKey: `${LEGACY_NS}_pending_claim_meta_${id}`,
          newKey: `${STORAGE_NS}_pending_claim_meta_${id}`,
          store: 'async',
        }));
        tasks.push(runOne({
          oldKey: `${LEGACY_NS}_pending_claim_secret_${id}`,
          newKey: `${STORAGE_NS}_pending_claim_secret_${id}`,
          store: 'secure',
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }));
      }
    } catch (err) {
      console.warn('storage-migration: claim index parse failed', err);
      return false;
    }
  }

  // EdDSAKeyService — keyed by wallet account; discover via migrated address.
  const walletAddr = await SecureStore.getItemAsync(`${STORAGE_NS}_wallet_address`);
  if (walletAddr) {
    const account = walletAddr.toLowerCase();
    tasks.push(runOne({
      oldKey: `${LEGACY_NS}_eddsa_${account}`,
      newKey: `${STORAGE_NS}_eddsa_${account}`,
      store: 'secure', // original writer passes no options
    }));
  }

  const results = await Promise.all(tasks);
  return results.every(Boolean);
}

async function runOne(mapping: KeyMapping): Promise<boolean> {
  try {
    await migrateOne(mapping);
    return true;
  } catch (err) {
    console.warn(`storage-migration: ${mapping.oldKey} → ${mapping.newKey} failed`, err);
    return false;
  }
}
