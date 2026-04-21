/**
 * NoteStorageService — 프라이빗 노트 암호화 저장 (per-wallet)
 *
 * 웹 프론트엔드의 File System API + localStorage 패턴을
 * expo-secure-store + AsyncStorage로 대체.
 *
 * 노트에는 secret + salt가 포함되므로 반드시 암호화 저장해야 한다.
 * - 개별 노트: expo-secure-store (2048 byte 제한 → JSON 직렬화)
 * - 노트 인덱스: AsyncStorage (목록 관리)
 *
 * Scope is **per active wallet address** — every public method takes an
 * `address` as its first argument and keys into a namespace unique to
 * that wallet. Two wallets on the same device cannot read each other's
 * notes (notes carry secret+salt, so cross-wallet leakage would let
 * the wrong wallet spend them).
 *
 * Legacy (single-wallet) shape used global keys `scatterdex_note_index`
 * and `scatterdex_note_<id>`. On the first per-address call whose
 * `address` matches the pre-upgrade built-in wallet (verified against
 * the legacy `scatterdex_wallet_address` SecureStore value that the
 * old KeySecurityService wrote), the legacy blob is rekeyed into the
 * per-address namespace, the migration marker is set BEFORE the legacy
 * delete, and the legacy rows are deleted best-effort. If the first
 * caller is NOT the legacy-wallet owner (e.g. a WalletConnect session
 * on a different address), the blob is left in place for a later
 * matching call to claim — auto-attributing to whichever wallet
 * connects first would silently hand wallet A's notes to wallet B.
 */
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const NOTE_INDEX_PREFIX = 'scatterdex_note_index_';
const NOTE_KEY_PREFIX = 'scatterdex_note_';

const LEGACY_NOTE_INDEX_KEY = 'scatterdex_note_index';
const LEGACY_NOTE_KEY_PREFIX = 'scatterdex_note_';
const MIGRATION_MARKER = 'scatterdex_migrated_notes_v2';

/**
 * SecureStore key the legacy single-wallet KeySecurityService writes
 * the wallet address to (mirrors `ADDRESS_KEY` there). Reading it lets
 * us verify a caller's `address` matches the wallet that produced the
 * legacy note blob, instead of blindly attributing to whichever wallet
 * happens to connect first after upgrade. Hardcoded rather than
 * imported from KeySecurityService so a future Phase 1 refactor to
 * that service can't silently change the value we compare against.
 */
const LEGACY_BUILTIN_ADDRESS_KEY = 'scatterdex_wallet_address';

const indexKeyFor = (address: string): string =>
  `${NOTE_INDEX_PREFIX}${address.toLowerCase()}`;
const noteKeyFor = (address: string, id: string): string =>
  `${NOTE_KEY_PREFIX}${address.toLowerCase()}_${id}`;
const legacyNoteKeyFor = (id: string): string =>
  `${LEGACY_NOTE_KEY_PREFIX}${id}`;

// Serialize index read-modify-write PER-ADDRESS so concurrent mutations
// on one wallet can't race each other, but two different wallets don't
// contend on a single queue.
const _indexMutationQueues = new Map<string, Promise<unknown>>();
function withIndexLock<T>(address: string, task: () => Promise<T>): Promise<T> {
  const key = address.toLowerCase();
  const prev = _indexMutationQueues.get(key) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(task);
  _indexMutationQueues.set(key, run.catch(() => {}));
  return run;
}

function requireAddress(address: string): string {
  if (!address) {
    throw new Error('NoteStorageService: address is required for per-wallet storage');
  }
  return address;
}

async function readIndex(address: string): Promise<string[]> {
  const raw = await AsyncStorage.getItem(indexKeyFor(address));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch {
    console.warn('NoteStorageService: corrupted note index, resetting');
    await AsyncStorage.removeItem(indexKeyFor(address));
    return [];
  }
}

/**
 * One-shot legacy rekey. Runs the first time any method is called per
 * install. The legacy blob is only copied when the caller's `address`
 * matches the pre-upgrade built-in wallet address — otherwise it's
 * left in place so a later matching call can claim it. The marker is
 * set only after an actual migration (or when there was nothing to
 * migrate), so deferred cases retry correctly.
 */
async function migrateLegacyIfNeeded(address: string): Promise<void> {
  const marker = await AsyncStorage.getItem(MIGRATION_MARKER);
  if (marker) return;

  const legacyIndexRaw = await AsyncStorage.getItem(LEGACY_NOTE_INDEX_KEY);
  if (!legacyIndexRaw) {
    // No legacy data ever existed on this device — skip the check on
    // subsequent calls by setting the marker.
    await AsyncStorage.setItem(MIGRATION_MARKER, 'done');
    return;
  }

  const legacyBuiltinAddress = await SecureStore.getItemAsync(LEGACY_BUILTIN_ADDRESS_KEY);
  if (
    !legacyBuiltinAddress
    || legacyBuiltinAddress.toLowerCase() !== address.toLowerCase()
  ) {
    // Caller is not the owner of the legacy blob (or the built-in
    // wallet record is missing). Leave the blob in place — a later
    // call with the matching wallet will pick it up.
    return;
  }

  let legacyIds: string[] = [];
  try {
    const parsed = JSON.parse(legacyIndexRaw);
    if (Array.isArray(parsed)) legacyIds = parsed;
  } catch {
    // Corrupted legacy index — drop it so we don't re-enter this
    // branch and so SecureStore doesn't hold an un-indexed blob
    // forever. Per-note data remains keyed by decimal id; any orphans
    // are unreachable without the index anyway.
    await AsyncStorage.removeItem(LEGACY_NOTE_INDEX_KEY);
    await AsyncStorage.setItem(MIGRATION_MARKER, 'done');
    return;
  }

  const lowerAddr = address.toLowerCase();
  const rekeyedLegacyIds: string[] = [];

  for (const id of legacyIds) {
    const legacyBlob = await SecureStore.getItemAsync(legacyNoteKeyFor(id));
    if (!legacyBlob) continue;
    // Only copy if the target slot is empty — a concurrent saveNote on
    // a fresh install could have already written per-address data,
    // and overwriting would destroy the user's newer note.
    const targetKey = noteKeyFor(lowerAddr, id);
    const existing = await SecureStore.getItemAsync(targetKey);
    if (!existing) {
      await SecureStore.setItemAsync(targetKey, legacyBlob);
    }
    rekeyedLegacyIds.push(id);
  }

  // Merge the legacy ids into the per-address index **through the same
  // lock** that saveNote / saveNotesBulk use — a blind `setItem` here
  // would race a concurrent saveNote's read-modify-write and clobber
  // its just-appended id.
  await withIndexLock(lowerAddr, async () => {
    const existing = await readIndex(lowerAddr);
    const existingSet = new Set(existing);
    const merged = existing.slice();
    for (const id of rekeyedLegacyIds) {
      if (!existingSet.has(id)) {
        merged.push(id);
        existingSet.add(id);
      }
    }
    await AsyncStorage.setItem(indexKeyFor(lowerAddr), JSON.stringify(merged));
  });
  // Set the marker BEFORE the legacy deletes so a crash between rekey
  // and delete turns re-runs into a no-op via the flag check.
  await AsyncStorage.setItem(MIGRATION_MARKER, 'done');
  for (const id of rekeyedLegacyIds) {
    await SecureStore.deleteItemAsync(legacyNoteKeyFor(id)).catch(() => {});
  }
  await AsyncStorage.removeItem(LEGACY_NOTE_INDEX_KEY).catch(() => {});
}

type WalletSwitchListener = (address: string | null) => void;
const _walletSwitchListeners = new Set<WalletSwitchListener>();

/**
 * Field elements here (`id`, `commitment`, `secret`, `salt`,
 * `pubKeyAx`, `pubKeyAy`) are stored as **base-10 decimal strings**,
 * matching what the WebView bridge returns (`F.toString(hash, 10)`
 * in `build-zk-webview.mjs`). This is the canonical on-device form;
 * convert to 0x-bytes32 via `toBytes32Hex` only at contract-call
 * boundaries. Previous revisions of this type labeled these "hex",
 * which was misleading — callers that assumed 0x-prefixed ids would
 * silently produce the wrong preimages.
 */
export interface StoredNote {
  /** commitment as decimal string — unique identifier */
  id: string;
  /** Poseidon hash as decimal string — same value as `id` */
  commitment: string;
  /** owner secret as decimal field element string */
  secret: string;
  /** random salt as decimal field element string */
  salt: string;
  /** EdDSA BabyJub pubkey x as decimal string */
  pubKeyAx: string;
  /** EdDSA BabyJub pubkey y as decimal string */
  pubKeyAy: string;
  /** token address (0x-prefixed checksummed hex) */
  token: string;
  tokenSymbol: string;     // e.g., "WETH"
  amount: string;          // wei string
  leafIndex: number;       // Merkle tree position (-1 = pending)
  txHash: string;          // deposit transaction hash
  status: 'active' | 'spent' | 'pending';
  createdAt: number;       // unix ms
}

export const NoteStorageService = {
  /**
   * Subscribe to wallet-switch events so screens keyed on notes
   * (HomeScreen balance, HistoryScreen, TradeScreen active list) can
   * reload when the active wallet changes. Listener receives the new
   * active address (or `null` on disconnect). Returns an unsubscribe
   * function.
   */
  subscribeWalletSwitch(listener: WalletSwitchListener): () => void {
    _walletSwitchListeners.add(listener);
    return () => {
      _walletSwitchListeners.delete(listener);
    };
  },

  /**
   * Fire the subscribed listeners. Called by WalletContext on
   * switchWallet / disconnect; screens respond by re-querying their
   * notes for the new address.
   */
  notifyWalletSwitch(address: string | null): void {
    for (const l of _walletSwitchListeners) {
      try { l(address); } catch { /* listener errors must not break switching */ }
    }
  },

  async getNoteIds(address: string): Promise<string[]> {
    requireAddress(address);
    await migrateLegacyIfNeeded(address);
    return readIndex(address);
  },

  async getNote(address: string, id: string): Promise<StoredNote | null> {
    requireAddress(address);
    const raw = await SecureStore.getItemAsync(noteKeyFor(address, id));
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      console.warn(`NoteStorageService: corrupted note data for ${id}`);
      return null;
    }
  },

  async getAllNotes(address: string): Promise<StoredNote[]> {
    const ids = await this.getNoteIds(address);
    const results = await Promise.all(ids.map((id) => this.getNote(address, id)));
    return results.filter((n): n is StoredNote => n !== null);
  },

  async saveNote(address: string, note: StoredNote): Promise<void> {
    requireAddress(address);
    await migrateLegacyIfNeeded(address);
    await SecureStore.setItemAsync(
      noteKeyFor(address, note.id),
      JSON.stringify(note),
    );
    await withIndexLock(address, async () => {
      const ids = await readIndex(address);
      if (!ids.includes(note.id)) {
        ids.push(note.id);
        await AsyncStorage.setItem(indexKeyFor(address), JSON.stringify(ids));
      }
    });
  },

  /**
   * Bulk save — chunked parallel per-key SecureStore writes, then a single
   * index update that runs through the shared `withIndexLock` serializer
   * so it can't race a concurrent `saveNote` / `deleteNote` from elsewhere
   * in the app (e.g. a deposit landing while a Settings restore is
   * in flight).
   *
   * Concurrency is capped at 32 to avoid pinning the JS bridge / saturating
   * the iOS Keychain queue when a user restores a large (thousand-note)
   * backup; SecureStore dispatches serially under the hood anyway, so
   * going wider buys nothing.
   */
  async saveNotesBulk(address: string, notes: StoredNote[]): Promise<Array<{ id: string; ok: boolean }>> {
    requireAddress(address);
    if (notes.length === 0) return [];
    await migrateLegacyIfNeeded(address);
    const results: Array<{ id: string; ok: boolean }> = new Array(notes.length);
    const CONCURRENCY = 32;
    for (let off = 0; off < notes.length; off += CONCURRENCY) {
      const chunk = notes.slice(off, off + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (note) => {
          try {
            await SecureStore.setItemAsync(
              noteKeyFor(address, note.id),
              JSON.stringify(note),
            );
            return { id: note.id, ok: true };
          } catch {
            return { id: note.id, ok: false };
          }
        }),
      );
      for (let i = 0; i < chunkResults.length; i++) results[off + i] = chunkResults[i];
    }
    const successIds = results.filter((r) => r.ok).map((r) => r.id);
    if (successIds.length > 0) {
      await withIndexLock(address, async () => {
        const existing = await readIndex(address);
        const existingSet = new Set(existing);
        const merged = existing.slice();
        for (const id of successIds) {
          if (!existingSet.has(id)) {
            merged.push(id);
            existingSet.add(id);
          }
        }
        await AsyncStorage.setItem(indexKeyFor(address), JSON.stringify(merged));
      });
    }
    return results;
  },

  async updateNoteStatus(address: string, id: string, status: StoredNote['status']): Promise<void> {
    requireAddress(address);
    const note = await this.getNote(address, id);
    if (!note) return;
    note.status = status;
    await SecureStore.setItemAsync(
      noteKeyFor(address, id),
      JSON.stringify(note),
    );
  },

  async deleteNote(address: string, id: string): Promise<void> {
    requireAddress(address);
    await SecureStore.deleteItemAsync(noteKeyFor(address, id));
    await withIndexLock(address, async () => {
      const ids = await readIndex(address);
      const updated = ids.filter((i) => i !== id);
      await AsyncStorage.setItem(indexKeyFor(address), JSON.stringify(updated));
    });
  },

  async getActiveNotes(address: string): Promise<StoredNote[]> {
    const all = await this.getAllNotes(address);
    return all.filter((n) => n.status === 'active');
  },

  async getActiveNotesByToken(address: string, tokenAddress: string): Promise<StoredNote[]> {
    return (await this.getActiveNotes(address)).filter(
      (n) => n.token.toLowerCase() === tokenAddress.toLowerCase(),
    );
  },

  async getPrivateBalances(address: string): Promise<Map<string, { symbol: string; total: bigint }>> {
    const notes = await this.getActiveNotes(address);
    const map = new Map<string, { symbol: string; total: bigint }>();

    for (const note of notes) {
      const key = note.token.toLowerCase();
      const existing = map.get(key);
      const amount = BigInt(note.amount);
      if (existing) {
        existing.total += amount;
      } else {
        map.set(key, { symbol: note.tokenSymbol, total: amount });
      }
    }

    return map;
  },
};
