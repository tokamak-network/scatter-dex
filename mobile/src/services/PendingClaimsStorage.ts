/**
 * PendingClaimsStorage — post-settlement claim data split across secure +
 * non-secure storage.
 *
 * The claim `secret` is the only piece that grants withdrawal authority —
 * if it leaks, funds can be drained by anyone with the corresponding
 * public metadata. The rest of the payload (`recipient`, `token`,
 * `amount`, `releaseTime`, `leafIndex`, `allLeaves`, `txHash`) is all
 * already on-chain or otherwise low-sensitivity, so we keep only the
 * secret in SecureStore (Keychain on iOS, Keystore on Android) and leave
 * the metadata in AsyncStorage — SecureStore's per-entry size limit
 * (~2 KB on Android) wouldn't fit `allLeaves` comfortably anyway.
 *
 * Storage layout:
 *   scatterdex_pending_claim_ids:          AsyncStorage — JSON `string[]`
 *   scatterdex_pending_claim_meta_<id>:    AsyncStorage — JSON `MetaRow`
 *   scatterdex_pending_claim_secret_<id>:  SecureStore  — raw decimal string
 *
 * First load also migrates the legacy `scatterdex_pending_claims` blob
 * (unencrypted array that held `secret` + meta together) into the split
 * shape, then deletes it. Existing users keep their claims without a
 * manual re-import step.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const IDS_KEY = 'scatterdex_pending_claim_ids';
const META_PREFIX = 'scatterdex_pending_claim_meta_';
const SECRET_PREFIX = 'scatterdex_pending_claim_secret_';
const LEGACY_KEY = 'scatterdex_pending_claims';

export interface PendingClaim {
  id: string;              // stable, locally-generated
  secret: string;          // decimal string — sensitive
  recipient: string;       // 0x-prefixed address
  token: string;           // 0x-prefixed address
  amount: string;          // wei string
  releaseTime: string;     // unix seconds string
  leafIndex: number;       // position in the 16-leaf claims tree
  allLeaves: string[];     // all 16 claim leaf hashes (decimal strings)
  txHash: string;          // settle / order tx hash (best-effort for display)
}

// Input shape for callers that shouldn't have to generate ids. Matches the
// pre-SecureStore payload 1:1 so migration from existing writers is a no-op.
export type PendingClaimInput = Omit<PendingClaim, 'id'>;

type MetaRow = Omit<PendingClaim, 'secret' | 'id'>;

function metaKey(id: string): string { return `${META_PREFIX}${id}`; }
function secretKey(id: string): string { return `${SECRET_PREFIX}${id}`; }

function newId(): string {
  // Random enough to avoid collisions across the 1–100 claims a user will
  // realistically accumulate. SecureStore keys must be alphanumeric + [._-]
  // so we stay in [0-9a-z_].
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function readIds(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(IDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

async function writeIds(ids: string[]): Promise<void> {
  await AsyncStorage.setItem(IDS_KEY, JSON.stringify(ids));
}

async function readMeta(id: string): Promise<MetaRow | null> {
  const raw = await AsyncStorage.getItem(metaKey(id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MetaRow;
  } catch {
    return null;
  }
}

async function migrateLegacyIfPresent(): Promise<void> {
  const legacy = await AsyncStorage.getItem(LEGACY_KEY);
  if (!legacy) return;
  let parsed: unknown;
  try { parsed = JSON.parse(legacy); } catch { parsed = null; }
  if (!Array.isArray(parsed)) {
    // Corrupt legacy blob — clear it so we don't migrate on every call.
    await AsyncStorage.removeItem(LEGACY_KEY);
    return;
  }

  const ids: string[] = await readIds();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Partial<PendingClaimInput>;
    if (typeof e.secret !== 'string') continue;
    const id = newId();
    ids.push(id);
    const meta: MetaRow = {
      recipient: String(e.recipient ?? ''),
      token: String(e.token ?? ''),
      amount: String(e.amount ?? '0'),
      releaseTime: String(e.releaseTime ?? '0'),
      leafIndex: Number(e.leafIndex ?? 0),
      allLeaves: Array.isArray(e.allLeaves) ? e.allLeaves.map(String) : [],
      txHash: String(e.txHash ?? ''),
    };
    await AsyncStorage.setItem(metaKey(id), JSON.stringify(meta));
    await SecureStore.setItemAsync(secretKey(id), e.secret, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
  }
  await writeIds(ids);
  await AsyncStorage.removeItem(LEGACY_KEY);
}

export const PendingClaimsStorage = {
  async list(): Promise<PendingClaim[]> {
    await migrateLegacyIfPresent();
    const ids = await readIds();
    const out: PendingClaim[] = [];
    for (const id of ids) {
      const meta = await readMeta(id);
      if (!meta) continue; // stale index entry — skip, don't throw
      const secret = await SecureStore.getItemAsync(secretKey(id));
      if (secret === null) continue; // secret missing — can't produce a claim
      out.push({ id, secret, ...meta });
    }
    return out;
  },

  /** Append entries. Throws on write failure — callers must NOT catch silently;
   *  losing a claim secret is a permanent fund-loss. */
  async append(entries: PendingClaimInput[]): Promise<void> {
    if (entries.length === 0) return;
    await migrateLegacyIfPresent();
    const ids = await readIds();
    for (const e of entries) {
      const id = newId();
      ids.push(id);
      const meta: MetaRow = {
        recipient: e.recipient,
        token: e.token,
        amount: e.amount,
        releaseTime: e.releaseTime,
        leafIndex: e.leafIndex,
        allLeaves: e.allLeaves,
        txHash: e.txHash,
      };
      // Write secret first — on partial failure we'd rather have an orphaned
      // secret (harmless without the leaf/amount context) than a stranded
      // meta entry whose secret can never be recovered.
      await SecureStore.setItemAsync(secretKey(id), e.secret, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      await AsyncStorage.setItem(metaKey(id), JSON.stringify(meta));
    }
    await writeIds(ids);
  },

  /** Remove entries by id (e.g. after a successful claim). */
  async removeByIds(idsToRemove: string[]): Promise<void> {
    if (idsToRemove.length === 0) return;
    const set = new Set(idsToRemove);
    const remaining = (await readIds()).filter((id) => !set.has(id));
    await writeIds(remaining);
    await Promise.all(idsToRemove.map(async (id) => {
      await AsyncStorage.removeItem(metaKey(id));
      try { await SecureStore.deleteItemAsync(secretKey(id)); } catch { /* missing is fine */ }
    }));
  },
};
