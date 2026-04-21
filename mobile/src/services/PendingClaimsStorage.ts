/**
 * PendingClaimsStorage — post-settlement claim data, scoped per wallet
 * address and split across secure + non-secure storage.
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
 * Storage layout (v2, multi-wallet):
 *   scatterdex_pending_claim_ids_<addr>:         AsyncStorage — JSON `string[]`
 *   scatterdex_pending_claim_meta_<addr>_<id>:   AsyncStorage — JSON `MetaRow`
 *   scatterdex_pending_claim_secret_<addr>_<id>: SecureStore  — raw secret
 *   scatterdex_pending_claims_migrated_v1:       AsyncStorage — `'1'` once
 *     the v0 (unencrypted blob) → v1 (split) migration has run.
 *   scatterdex_pending_claims_migrated_v2:       AsyncStorage — `'1'` once
 *     the v1 (single-wallet) → v2 (per-wallet) migration has run for the
 *     pre-upgrade built-in wallet owner.
 *
 * Migration runs two tiers on first access:
 *   1. v0 → v1: split the legacy `scatterdex_pending_claims` blob
 *      (unencrypted secret + meta mashed together) into the v1 split shape.
 *      Mirrors what the previous revision of this service already did.
 *   2. v1 → v2: rekey the v1 single-wallet keyspace into the per-address
 *      keyspace, but *only* when the caller's `address` matches the
 *      pre-upgrade `scatterdex_wallet_address` value (the built-in
 *      KeySecurityService ADDRESS_KEY). Matching that way avoids silently
 *      attributing the v1 data to whichever wallet connects first after
 *      upgrade (e.g. a WalletConnect session that doesn't own the claims).
 *      If the caller isn't the legacy owner, the v1 data is left in place
 *      so a later call with the matching wallet can claim it.
 */
// Self-import the polyfill so `crypto.getRandomValues` is live even
// if this service loads before App.tsx wires it up (tests, headless
// tasks). The package itself is idempotent.
import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

const V1_IDS_KEY = 'scatterdex_pending_claim_ids';
const V1_META_PREFIX = 'scatterdex_pending_claim_meta_';
const V1_SECRET_PREFIX = 'scatterdex_pending_claim_secret_';
const V0_LEGACY_KEY = 'scatterdex_pending_claims';
const V1_MIGRATION_MARKER = 'scatterdex_pending_claims_migrated_v1';
const V2_MIGRATION_MARKER = 'scatterdex_pending_claims_migrated_v2';

/**
 * SecureStore key the legacy single-wallet KeySecurityService wrote the
 * wallet address to. Reading it lets us verify that a caller's `address`
 * owns the v1 data before copying it into their namespace. Hardcoded
 * rather than imported from KeySecurityService so a future Phase 1
 * refactor to that service can't silently change the value we compare
 * against.
 */
const LEGACY_BUILTIN_ADDRESS_KEY = 'scatterdex_wallet_address';

const SECURE_OPTS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

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

// ─── v2 per-address key helpers ────────────────────────────────────

function idsKey(address: string): string {
  return `${V1_IDS_KEY}_${address.toLowerCase()}`;
}

function metaKey(address: string, id: string): string {
  return `${V1_META_PREFIX}${address.toLowerCase()}_${id}`;
}

function secretKey(address: string, id: string): string {
  return `${V1_SECRET_PREFIX}${address.toLowerCase()}_${id}`;
}

// ─── v1 legacy key helpers (only used during migration) ────────────

function v1MetaKey(id: string): string { return `${V1_META_PREFIX}${id}`; }
function v1SecretKey(id: string): string { return `${V1_SECRET_PREFIX}${id}`; }

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

async function readIds(address: string): Promise<string[]> {
  const raw = await AsyncStorage.getItem(idsKey(address));
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

async function writeIds(address: string, ids: string[]): Promise<void> {
  await AsyncStorage.setItem(idsKey(address), JSON.stringify(ids));
}

async function readMeta(address: string, id: string): Promise<MetaRow | null> {
  const raw = await AsyncStorage.getItem(metaKey(address, id));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MetaRow;
  } catch {
    return null;
  }
}

// ─── Migration ─────────────────────────────────────────────────────

// Module-level latch so concurrent callers (different wallet addresses
// calling list/append around the same time) can't each enter
// `migrateV0ToV1` in parallel and clobber each other's V1_IDS_KEY
// read-modify-write — last-write-wins there would orphan migrated
// meta/secret rows, i.e. permanent claim-secret loss. Shared across
// all addresses because the v0→v1 migration reads/writes global keys,
// not per-address ones. Reset on failure so a transient SecureStore
// hiccup can retry.
let v0ToV1Promise: Promise<void> | null = null;
function ensureV0ToV1(): Promise<void> {
  if (!v0ToV1Promise) {
    v0ToV1Promise = migrateV0ToV1().catch((err) => {
      v0ToV1Promise = null;
      throw err;
    });
  }
  return v0ToV1Promise;
}

/**
 * v0 → v1 migration (reused unchanged from the pre-multi-wallet revision).
 * Splits the legacy `scatterdex_pending_claims` blob into the v1 split
 * shape (secret in SecureStore, meta in AsyncStorage, id index). Runs
 * once per install, then the marker prevents re-entry. Callers must go
 * through `ensureV0ToV1()` to honor the concurrency latch.
 */
async function migrateV0ToV1(): Promise<void> {
  if ((await AsyncStorage.getItem(V1_MIGRATION_MARKER)) === '1') {
    if ((await AsyncStorage.getItem(V0_LEGACY_KEY)) !== null) {
      await AsyncStorage.removeItem(V0_LEGACY_KEY);
    }
    return;
  }
  const legacy = await AsyncStorage.getItem(V0_LEGACY_KEY);
  if (!legacy) {
    await AsyncStorage.setItem(V1_MIGRATION_MARKER, '1');
    return;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(legacy); } catch { parsed = null; }
  if (!Array.isArray(parsed)) {
    await AsyncStorage.removeItem(V0_LEGACY_KEY);
    await AsyncStorage.setItem(V1_MIGRATION_MARKER, '1');
    return;
  }

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
      AsyncStorage.setItem(v1MetaKey(id), JSON.stringify(meta)),
      SecureStore.setItemAsync(v1SecretKey(id), e.secret, SECURE_OPTS),
    ]);
  }));

  // Append to v1 ids (legacy global index) so an in-progress v1→v2 migration
  // on another codepath observes the freshly-split entries.
  const existingV1Ids = await (async () => {
    const raw = await AsyncStorage.getItem(V1_IDS_KEY);
    if (!raw) return [] as string[];
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.filter((v) => typeof v === 'string') : [];
    } catch { return []; }
  })();
  await AsyncStorage.setItem(V1_IDS_KEY, JSON.stringify([...existingV1Ids, ...newIds]));
  await AsyncStorage.setItem(V1_MIGRATION_MARKER, '1');
  await AsyncStorage.removeItem(V0_LEGACY_KEY);
}

/**
 * v1 → v2 migration. Moves the single-wallet v1 keyspace into the
 * per-address keyspace of the pre-upgrade built-in wallet. Guarded so
 * only the legacy-wallet owner's `address` triggers the rekey — a
 * WalletConnect-first caller gets a no-op and the v1 blob stays put
 * for a later matching load().
 */
async function migrateV1ToV2IfNeeded(address: string): Promise<void> {
  if ((await AsyncStorage.getItem(V2_MIGRATION_MARKER)) === '1') return;

  // v1 must be in place before we can rekey it. If v0→v1 hasn't run
  // yet (pre-mobile-app install in the wild), this is the moment.
  // Routed through the module-level latch so two addresses entering
  // v1→v2 concurrently share a single v0→v1 attempt instead of racing
  // on the global V1_IDS_KEY read-modify-write.
  await ensureV0ToV1();

  const v1RawIds = await AsyncStorage.getItem(V1_IDS_KEY);
  const legacyBuiltinAddress = await SecureStore.getItemAsync(LEGACY_BUILTIN_ADDRESS_KEY);

  const v1Ids = (() => {
    if (!v1RawIds) return [] as string[];
    try {
      const p = JSON.parse(v1RawIds);
      return Array.isArray(p) ? p.filter((v) => typeof v === 'string') : [];
    } catch { return [] as string[]; }
  })();

  if (v1Ids.length === 0) {
    // Nothing to rekey on this device — set the marker so subsequent
    // calls skip the legacy lookup entirely.
    await AsyncStorage.setItem(V2_MIGRATION_MARKER, '1');
    return;
  }

  if (!legacyBuiltinAddress || legacyBuiltinAddress.toLowerCase() !== address.toLowerCase()) {
    // Caller is not the owner of the v1 data (or the owner is unknown
    // because the built-in wallet record is missing). Leave the v1
    // blob in place — a later matching load() call will claim it.
    // No marker set: deferred cases retry on the next matching call.
    return;
  }

  // Rekey each entry to the per-address namespace.
  await Promise.all(v1Ids.map(async (id) => {
    const [meta, secret] = await Promise.all([
      AsyncStorage.getItem(v1MetaKey(id)),
      SecureStore.getItemAsync(v1SecretKey(id)),
    ]);
    if (!meta || !secret) return; // orphan — skip; it'd fail v2 reads anyway
    await Promise.all([
      AsyncStorage.setItem(metaKey(address, id), meta),
      SecureStore.setItemAsync(secretKey(address, id), secret, SECURE_OPTS),
    ]);
  }));

  // Union with any v2 ids the caller may have already written (fresh
  // deposits post-upgrade before this migration ran on their first list()).
  const existingV2Ids = await readIds(address);
  const existingSet = new Set(existingV2Ids);
  const merged = [...existingV2Ids];
  for (const id of v1Ids) {
    if (!existingSet.has(id)) merged.push(id);
  }
  await writeIds(address, merged);

  // Marker BEFORE legacy delete so a crash between them turns the next
  // run into a flag-check no-op.
  await AsyncStorage.setItem(V2_MIGRATION_MARKER, '1');

  // Best-effort v1 cleanup. Leaving the v1 blob readable on a keystore
  // failure is undesirable but the marker prevents re-migration, so no
  // double-writes.
  await Promise.all(v1Ids.map(async (id) => {
    try { await AsyncStorage.removeItem(v1MetaKey(id)); } catch { /* best-effort */ }
    try { await SecureStore.deleteItemAsync(v1SecretKey(id)); } catch { /* best-effort */ }
  }));
  try { await AsyncStorage.removeItem(V1_IDS_KEY); } catch { /* best-effort */ }
}

// Per-address migration latch — concurrent `list()`/`append()` on the
// same wallet must share a single migration attempt. Reset on failure
// so a transient SecureStore hiccup doesn't permanently disable the
// migration path for that address.
const migrationPromises = new Map<string, Promise<void>>();

function ensureMigrated(address: string): Promise<void> {
  const key = address.toLowerCase();
  let p = migrationPromises.get(key);
  if (!p) {
    p = migrateV1ToV2IfNeeded(key).catch((err) => {
      migrationPromises.delete(key);
      throw err;
    });
    migrationPromises.set(key, p);
  }
  return p;
}

// ─── Public API ────────────────────────────────────────────────────

export const PendingClaimsStorage = {
  async list(address: string): Promise<PendingClaim[]> {
    await ensureMigrated(address);
    const ids = await readIds(address);
    // Parallel reads — sequential awaits across N entries adds up on
    // every ClaimScreen open.
    const rows = await Promise.all(ids.map(async (id) => {
      const [meta, secret] = await Promise.all([
        readMeta(address, id),
        SecureStore.getItemAsync(secretKey(address, id)),
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
      await writeIds(address, fresh);
    }
    return out;
  },

  /** Append entries for `address`. Throws on write failure — callers must NOT
   *  catch silently; losing a claim secret is a permanent fund-loss. */
  async append(address: string, entries: PendingClaimInput[]): Promise<void> {
    if (entries.length === 0) return;
    await ensureMigrated(address);

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
      await SecureStore.setItemAsync(secretKey(address, id), e.secret, SECURE_OPTS);
      await AsyncStorage.setItem(metaKey(address, id), JSON.stringify(meta));
    }));
    // Index update is the last write so a crash mid-append leaves orphans
    // (skipped by list()), never an indexed entry without payload.
    const existing = await readIds(address);
    await writeIds(address, [...existing, ...newIds]);
  },

  /** Remove entries for `address` by id (e.g. after a successful claim). */
  async removeByIds(address: string, idsToRemove: string[]): Promise<void> {
    if (idsToRemove.length === 0) return;

    // Crash-safety order: drop the secrets and meta FIRST, then update the
    // index. Doing it the other way around would mean a crash between the
    // two leaves the SecureStore secret intact alongside the meta key
    // (whose name still encodes the id), which is exactly the
    // recoverable-secret leak we're trying to avoid.
    await Promise.all(idsToRemove.map(async (id) => {
      try { await SecureStore.deleteItemAsync(secretKey(address, id)); } catch { /* missing is fine */ }
      await AsyncStorage.removeItem(metaKey(address, id));
    }));

    const set = new Set(idsToRemove);
    const remaining = (await readIds(address)).filter((id) => !set.has(id));
    await writeIds(address, remaining);
  },
};
