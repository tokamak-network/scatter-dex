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
 *   zkscatterdex_pending_claim_ids:          AsyncStorage — JSON `string[]`
 *   zkscatterdex_pending_claim_meta_<id>:    AsyncStorage — JSON `MetaRow`
 *   zkscatterdex_pending_claim_secret_<id>:  SecureStore  — raw secret string
 *   zkscatterdex_pending_claims_migrated_v1: AsyncStorage — `'1'` once the
 *     legacy blob has been split (idempotency marker — see `migrateLegacy`).
 *
 * First load also migrates the legacy `zkscatterdex_pending_claims` blob
 * (unencrypted array that held `secret` + meta together) into the split
 * shape, then deletes it. Existing users keep their claims without a
 * manual re-import step.
 */
// Self-import the polyfill so `crypto.getRandomValues` is live even
// if this service loads before App.tsx wires it up (tests, headless
// tasks). The package itself is idempotent.
import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const IDS_KEY = 'zkscatterdex_pending_claim_ids';
const META_PREFIX = 'zkscatterdex_pending_claim_meta_';
const SECRET_PREFIX = 'zkscatterdex_pending_claim_secret_';
const LEGACY_KEY = 'zkscatterdex_pending_claims';
const MIGRATION_MARKER = 'zkscatterdex_pending_claims_migrated_v1';

export interface PendingClaim {
  id: string;              // stable, locally-generated
  secret: string;          // sensitive
  recipient: string;       // 0x-prefixed address
  token: string;           // 0x-prefixed address
  amount: string;          // wei string
  releaseTime: string;     // unix seconds string
  leafIndex: number;       // position in the 16-leaf claims tree
  allLeaves: string[];     // all 16 claim leaf hashes (decimal strings)
  txHash: string;          // settle / order tx hash (best-effort for display)
  /** Relayer-assigned order id for the settlement that produced this claim.
   *  Historically OrderService stuffed this into `txHash`; the two are now
   *  distinct. Old entries may still carry the orderId in `txHash` with no
   *  `orderId` set — BackupService dedup accounts for both shapes. */
  orderId?: string;
  /** Set when `recipient` is a stealth address — required to derive the
   *  recipient's private key. Absent on standard (non-stealth) claims. */
  ephemeralPubKey?: string; // 0x-prefixed compressed secp256k1 hex
}

// Input shape for callers that shouldn't have to generate ids. Matches the
// pre-SecureStore payload 1:1 so migration from existing writers is a no-op.
export type PendingClaimInput = Omit<PendingClaim, 'id'>;

type MetaRow = Omit<PendingClaim, 'secret' | 'id'>;

function metaKey(id: string): string { return `${META_PREFIX}${id}`; }
function secretKey(id: string): string { return `${SECRET_PREFIX}${id}`; }

function newId(): string {
  // SecureStore keys must be alphanumeric + [._-]; hex stays in [0-9a-f].
  // Use crypto.getRandomValues — Math.random is not collision-safe
  // enough when a user batch-imports many claims in the same tick
  // (same Date.now() millisecond + weak entropy = collision risk).
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${Date.now().toString(36)}_${hex}`;
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

/**
 * Crash-safe legacy migration.
 *
 * Two failure modes the previous version had:
 *  - **Re-migration**: a crash between `writeIds(...)` and the legacy
 *    `removeItem(...)` would, on next launch, run the migration again
 *    against the still-present legacy blob and duplicate every entry.
 *  - **Thundering herd**: concurrent callers (e.g. parallel `list()` +
 *    `append()`) would each run the full migration in parallel.
 *
 * Fixes: a `MIGRATION_MARKER` written *before* deleting the legacy blob
 * means a re-run sees the marker and immediately deletes the legacy
 * blob without re-importing. A module-level `migrationPromise` cache
 * dedupes concurrent callers onto a single migration attempt.
 */
let migrationPromise: Promise<void> | null = null;

async function migrateLegacy(): Promise<void> {
  // Already migrated in a prior session? Just sweep the legacy blob.
  if ((await AsyncStorage.getItem(MIGRATION_MARKER)) === '1') {
    if ((await AsyncStorage.getItem(LEGACY_KEY)) !== null) {
      await AsyncStorage.removeItem(LEGACY_KEY);
    }
    return;
  }
  const legacy = await AsyncStorage.getItem(LEGACY_KEY);
  if (!legacy) {
    // Nothing to migrate. Mark anyway so we never re-enter this path.
    await AsyncStorage.setItem(MIGRATION_MARKER, '1');
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(legacy); } catch { parsed = null; }
  if (!Array.isArray(parsed)) {
    await AsyncStorage.removeItem(LEGACY_KEY);
    await AsyncStorage.setItem(MIGRATION_MARKER, '1');
    return;
  }

  // Build the new entries in parallel (each is independent — no shared writes).
  const newIds: string[] = [];
  await Promise.all(parsed.map(async (entry) => {
    if (!entry || typeof entry !== 'object') return;
    const e = entry as Partial<PendingClaimInput>;
    if (typeof e.secret !== 'string') return;
    const id = newId();
    newIds.push(id);
    const meta: MetaRow = {
      recipient: String(e.recipient ?? ''),
      token: String(e.token ?? ''),
      amount: String(e.amount ?? '0'),
      releaseTime: String(e.releaseTime ?? '0'),
      leafIndex: Number(e.leafIndex ?? 0),
      allLeaves: Array.isArray(e.allLeaves) ? e.allLeaves.map(String) : [],
      txHash: String(e.txHash ?? ''),
      ...(typeof e.orderId === 'string' && e.orderId ? { orderId: e.orderId } : {}),
      ...(typeof e.ephemeralPubKey === 'string' && e.ephemeralPubKey
        ? { ephemeralPubKey: e.ephemeralPubKey } : {}),
    };
    await Promise.all([
      AsyncStorage.setItem(metaKey(id), JSON.stringify(meta)),
      SecureStore.setItemAsync(secretKey(id), e.secret, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    ]);
  }));

  const existingIds = await readIds();
  await writeIds([...existingIds, ...newIds]);
  // Marker BEFORE removing the legacy blob so a crash here doesn't
  // re-migrate next launch. Even if the marker write succeeds and the
  // remove fails, the next entry into this function takes the
  // already-migrated branch above.
  await AsyncStorage.setItem(MIGRATION_MARKER, '1');
  await AsyncStorage.removeItem(LEGACY_KEY);
}

function ensureMigrated(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = migrateLegacy().catch((err) => {
      // Reset on failure so the next call retries; otherwise a transient
      // SecureStore hiccup would permanently disable the migration path.
      migrationPromise = null;
      throw err;
    });
  }
  return migrationPromise;
}

export const PendingClaimsStorage = {
  async list(): Promise<PendingClaim[]> {
    await ensureMigrated();
    const ids = await readIds();
    // Parallel reads — sequential awaits across N entries adds up on
    // every ClaimScreen open.
    const rows = await Promise.all(ids.map(async (id) => {
      const [meta, secret] = await Promise.all([
        readMeta(id),
        SecureStore.getItemAsync(secretKey(id)),
      ]);
      if (!meta || secret === null) return { id, claim: null as PendingClaim | null };
      return { id, claim: { id, secret, ...meta } };
    }));

    const out: PendingClaim[] = [];
    const staleIds: string[] = [];
    for (const r of rows) {
      if (r.claim) out.push(r.claim);
      else staleIds.push(r.id);
    }
    // Prune stale ids — without this, an interrupted append/remove can leave
    // an id in the index forever and we'd re-pay the dual-store read on
    // every load.
    if (staleIds.length > 0) {
      const fresh = ids.filter((id) => !staleIds.includes(id));
      await writeIds(fresh);
    }
    return out;
  },

  /** Append entries. Throws on write failure — callers must NOT catch silently;
   *  losing a claim secret is a permanent fund-loss. */
  async append(entries: PendingClaimInput[]): Promise<void> {
    if (entries.length === 0) return;
    await ensureMigrated();

    // Build all entries in parallel; each pair (meta + secret) is independent.
    const newIds: string[] = [];
    await Promise.all(entries.map(async (e) => {
      const id = newId();
      newIds.push(id);
      const meta: MetaRow = {
        recipient: e.recipient,
        token: e.token,
        amount: e.amount,
        releaseTime: e.releaseTime,
        leafIndex: e.leafIndex,
        allLeaves: e.allLeaves,
        txHash: e.txHash,
        ...(e.orderId ? { orderId: e.orderId } : {}),
        ...(e.ephemeralPubKey ? { ephemeralPubKey: e.ephemeralPubKey } : {}),
      };
      // Write secret first — on partial failure we'd rather have an orphaned
      // secret (no meta = invisible to list()) than a stranded meta entry
      // whose secret can never be recovered.
      await SecureStore.setItemAsync(secretKey(id), e.secret, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      await AsyncStorage.setItem(metaKey(id), JSON.stringify(meta));
    }));
    // Index update is the last write so a crash mid-append leaves orphans
    // (skipped by list()), never an indexed entry without payload.
    const existing = await readIds();
    await writeIds([...existing, ...newIds]);
  },

  /** Remove entries by id (e.g. after a successful claim). */
  async removeByIds(idsToRemove: string[]): Promise<void> {
    if (idsToRemove.length === 0) return;

    // Crash-safety order: drop the secrets and meta FIRST, then update the
    // index. Doing it the other way around would mean a crash between the
    // two leaves the SecureStore secret intact alongside the meta key
    // (whose name still encodes the id), which is exactly the
    // recoverable-secret leak we're trying to avoid.
    await Promise.all(idsToRemove.map(async (id) => {
      try { await SecureStore.deleteItemAsync(secretKey(id)); } catch { /* missing is fine */ }
      await AsyncStorage.removeItem(metaKey(id));
    }));

    const set = new Set(idsToRemove);
    const remaining = (await readIds()).filter((id) => !set.has(id));
    await writeIds(remaining);
  },
};
