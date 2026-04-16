/**
 * One-time storage key migration: scatterdex_* → zkscatterdex_*
 *
 * Each service calls `migrateKeys` on first access. The migration is
 * idempotent — once the marker is set, subsequent calls are a no-op.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const MIGRATION_DONE_KEY = 'zkscatterdex_rename_migration_done';

let migrationPromise: Promise<void> | null = null;

interface KeyMapping {
  oldKey: string;
  newKey: string;
  store: 'async' | 'secure';
}

/**
 * Migrate a list of old→new key pairs. Reads from old, writes to new,
 * deletes old. Skips keys where old is absent or new already exists.
 */
async function migrateKeyPairs(mappings: KeyMapping[]): Promise<void> {
  await Promise.all(mappings.map(async ({ oldKey, newKey, store }) => {
    try {
      if (store === 'secure') {
        const existing = await SecureStore.getItemAsync(newKey);
        if (existing !== null) return; // already migrated
        const value = await SecureStore.getItemAsync(oldKey);
        if (value === null) return; // nothing to migrate
        await SecureStore.setItemAsync(newKey, value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        await SecureStore.deleteItemAsync(oldKey);
      } else {
        const existing = await AsyncStorage.getItem(newKey);
        if (existing !== null) return;
        const value = await AsyncStorage.getItem(oldKey);
        if (value === null) return;
        await AsyncStorage.setItem(newKey, value);
        await AsyncStorage.removeItem(oldKey);
      }
    } catch (err) {
      console.warn(`storage-migration: failed to migrate ${oldKey} → ${newKey}`, err);
    }
  }));
}

/**
 * Run the full rename migration for all services. Called once at app startup.
 * Safe to call multiple times — deduped via promise cache.
 */
export function ensureRenameMigration(): Promise<void> {
  if (migrationPromise) return migrationPromise;

  migrationPromise = (async () => {
    const done = await AsyncStorage.getItem(MIGRATION_DONE_KEY);
    if (done === '1') return;

    await migrateKeyPairs([
      // KeySecurityService
      { oldKey: 'scatterdex_wallet_pk', newKey: 'zkscatterdex_wallet_pk', store: 'secure' },
      { oldKey: 'scatterdex_wallet_mnemonic', newKey: 'zkscatterdex_wallet_mnemonic', store: 'secure' },
      { oldKey: 'scatterdex_wallet_address', newKey: 'zkscatterdex_wallet_address', store: 'secure' },
      { oldKey: 'scatterdex_biometric_enabled', newKey: 'zkscatterdex_biometric_enabled', store: 'secure' },

      // StealthIdentityService
      { oldKey: 'scatterdex_stealth_identity_v1', newKey: 'zkscatterdex_stealth_identity_v1', store: 'secure' },

      // NoteStorageService (index in AsyncStorage, notes in SecureStore — notes are per-id, handled below)
      { oldKey: 'scatterdex_note_index', newKey: 'zkscatterdex_note_index', store: 'async' },

      // PendingClaimsStorage
      { oldKey: 'scatterdex_pending_claim_ids', newKey: 'zkscatterdex_pending_claim_ids', store: 'async' },
      { oldKey: 'scatterdex_pending_claims', newKey: 'zkscatterdex_pending_claims', store: 'async' },
      { oldKey: 'scatterdex_pending_claims_migrated_v1', newKey: 'zkscatterdex_pending_claims_migrated_v1', store: 'async' },

      // AddressBookService
      { oldKey: 'scatterdex_wallet_book_v1', newKey: 'zkscatterdex_wallet_book_v1', store: 'async' },

      // NetworkService
      { oldKey: 'scatterdex_custom_networks', newKey: 'zkscatterdex_custom_networks', store: 'async' },
      { oldKey: 'scatterdex_selected_network', newKey: 'zkscatterdex_selected_network', store: 'async' },

      // ProviderService
      { oldKey: 'scatterdex_earliest_block', newKey: 'zkscatterdex_earliest_block', store: 'async' },
    ]);

    // Per-id keys: NoteStorageService notes, PendingClaimsStorage meta/secrets, EdDSAKeyService
    // These use dynamic suffixes so we migrate via the index.
    await migrateIndexedKeys();

    await AsyncStorage.setItem(MIGRATION_DONE_KEY, '1');
  })().catch((err) => {
    migrationPromise = null;
    throw err;
  });

  return migrationPromise;
}

/**
 * Migrate per-id keys that use a prefix + dynamic suffix.
 * Reads the (already-migrated) index to discover all IDs.
 */
async function migrateIndexedKeys(): Promise<void> {
  // --- NoteStorageService: scatterdex_note_<id> → zkscatterdex_note_<id> ---
  const noteIndexRaw = await AsyncStorage.getItem('zkscatterdex_note_index');
  if (noteIndexRaw) {
    try {
      const noteIds: string[] = JSON.parse(noteIndexRaw);
      await Promise.all(noteIds.map(async (id) => {
        const oldKey = `scatterdex_note_${id}`;
        const newKey = `zkscatterdex_note_${id}`;
        const existing = await SecureStore.getItemAsync(newKey);
        if (existing !== null) return;
        const value = await SecureStore.getItemAsync(oldKey);
        if (value === null) return;
        await SecureStore.setItemAsync(newKey, value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        await SecureStore.deleteItemAsync(oldKey);
      }));
    } catch { /* index parse failed — skip note migration */ }
  }

  // --- PendingClaimsStorage: per-id meta + secrets ---
  const claimIdsRaw = await AsyncStorage.getItem('zkscatterdex_pending_claim_ids');
  if (claimIdsRaw) {
    try {
      const claimIds: string[] = JSON.parse(claimIdsRaw);
      await Promise.all(claimIds.map(async (id) => {
        // meta (AsyncStorage)
        const oldMeta = `scatterdex_pending_claim_meta_${id}`;
        const newMeta = `zkscatterdex_pending_claim_meta_${id}`;
        const existingMeta = await AsyncStorage.getItem(newMeta);
        if (existingMeta === null) {
          const value = await AsyncStorage.getItem(oldMeta);
          if (value !== null) {
            await AsyncStorage.setItem(newMeta, value);
            await AsyncStorage.removeItem(oldMeta);
          }
        }
        // secret (SecureStore)
        const oldSecret = `scatterdex_pending_claim_secret_${id}`;
        const newSecret = `zkscatterdex_pending_claim_secret_${id}`;
        const existingSecret = await SecureStore.getItemAsync(newSecret);
        if (existingSecret === null) {
          const value = await SecureStore.getItemAsync(oldSecret);
          if (value !== null) {
            await SecureStore.setItemAsync(newSecret, value, {
              keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
            });
            await SecureStore.deleteItemAsync(oldSecret);
          }
        }
      }));
    } catch { /* parse failed — skip claims migration */ }
  }

  // --- EdDSAKeyService: scatterdex_eddsa_<account> → zkscatterdex_eddsa_<account> ---
  // EdDSA keys are per-account and there's no index. We check the wallet
  // address (already migrated) to discover the account.
  const walletAddr = await SecureStore.getItemAsync('zkscatterdex_wallet_address');
  if (walletAddr) {
    const account = walletAddr.toLowerCase();
    const oldKey = `scatterdex_eddsa_${account}`;
    const newKey = `zkscatterdex_eddsa_${account}`;
    const existing = await SecureStore.getItemAsync(newKey);
    if (existing === null) {
      const value = await SecureStore.getItemAsync(oldKey);
      if (value !== null) {
        await SecureStore.setItemAsync(newKey, value, {
          keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        });
        await SecureStore.deleteItemAsync(oldKey);
      }
    }
  }
}
