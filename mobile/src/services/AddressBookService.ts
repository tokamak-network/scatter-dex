/**
 * AddressBookService — labelled recipient addresses for the trade flow,
 * scoped per owning wallet address.
 *
 * Mirrors the web `wallet-book.ts` (`frontend/app/lib/wallet-book.ts`)
 * one-for-one in shape (`{id, label, address, memo?, createdAt}`) and
 * lock semantics so the two stores can be cross-referenced in the future.
 *
 * Entries are not sensitive (labels + 0x addresses, no secrets) so
 * AsyncStorage is the right home. Each wallet gets its own blob —
 * `scatterdex_wallet_book_v1_<ownerAddr>` — so switching wallets in
 * the multi-wallet UI can't cross-leak the user's recipient labels.
 * Mutations for a given wallet are serialized through a promise chain
 * keyed on owner address so concurrent in-process callers on the same
 * wallet can't race on read-modify-write; different wallets run in
 * parallel since they touch disjoint keys.
 *
 * Legacy (`scatterdex_wallet_book_v1`, no owner suffix) is migrated on
 * first call by the pre-upgrade built-in wallet owner only — verified
 * against the hardcoded `scatterdex_wallet_address` SecureStore value
 * (the legacy `KeySecurityService.ADDRESS_KEY`). A non-owner caller
 * gets a no-op and the legacy blob stays put for a later matching call.
 */
// Self-import the polyfill so AddressBookService is safe to import from
// non-App entry points (tests, headless tasks). The package is idempotent
// — App.tsx already imports it and the second import is a no-op.
import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { ethers } from 'ethers';
import { eqAddr } from '../lib/address';

const BASE_KEY = 'scatterdex_wallet_book_v1';
const V2_MIGRATION_MARKER = 'scatterdex_wallet_book_migrated_v2';

/**
 * SecureStore key the legacy single-wallet KeySecurityService wrote the
 * wallet address to. Hardcoded rather than imported from KeySecurityService
 * so a future Phase 1 refactor can't silently change the value we gate on.
 */
const LEGACY_BUILTIN_ADDRESS_KEY = 'scatterdex_wallet_address';

function keyFor(address: string): string {
  return `${BASE_KEY}_${address.toLowerCase()}`;
}

export class WalletBookCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletBookCorruptError';
  }
}

export interface WalletEntry {
  id: string;
  label: string;
  /** Lowercase 0x EOA address. */
  address: string;
  memo?: string;
  createdAt: number;   // unix seconds
}

interface WalletBookFile {
  version: 1;
  entries: WalletEntry[];
}

function newId(): string {
  // Stable identifier the user references in the UI — avoid Math.random().
  // The polyfill self-imported above patches `crypto.getRandomValues` onto
  // the global, so using it directly (matching the rest of the mobile
  // codebase, e.g. OrderService) keeps the type clean.
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Single source of truth for address normalization — keep in sync with
// `readBook`'s map. If we ever want checksummed storage instead, this is
// the only line to change.
function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

export function isValidAddress(addr: unknown): boolean {
  if (typeof addr !== 'string') return false;
  return ethers.isAddress(addr);
}

function isValidEntry(e: unknown): e is WalletEntry {
  if (!e || typeof e !== 'object') return false;
  const v = e as Record<string, unknown>;
  return (
    typeof v.id === 'string'
    && typeof v.label === 'string'
    && isValidAddress(v.address)
    && typeof v.createdAt === 'number'
    && (v.memo === undefined || typeof v.memo === 'string')
  );
  // Note: lowercase normalization happens at write time in `add` and on
  // read via `readBook` below — be lenient at the boundary so a manually-
  // edited file or a sync from a tool that emits checksummed addresses
  // doesn't trip WalletBookCorruptError.
}

/**
 * Pre-migration check used by `readRawBook`: legacy entries that
 * carry a `kind === 'stealth'` (from the now-removed stealth mode)
 * or a `metaAddress` field were valid under the previous schema but
 * no longer satisfy `isValidEntry` (their `address` may be a stealth
 * meta-string, not a 0x EOA). Treat them as opportunistically-
 * droppable rather than reporting the whole book as corrupt — so a
 * user with one legacy stealth contact can still read / restore the
 * rest of their address book and its companion bundles.
 */
function isLegacyStealthEntry(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const v = e as Record<string, unknown>;
  return v.kind === 'stealth' || typeof v.metaAddress === 'string';
}

async function readRawBook(storageKey: string): Promise<WalletEntry[]> {
  const raw = await AsyncStorage.getItem(storageKey);
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new WalletBookCorruptError(
      `wallet book is not valid JSON: ${e instanceof Error ? e.message : 'parse error'}`,
    );
  }
  const book = parsed as WalletBookFile | null;
  if (!book || typeof book !== 'object' || book.version !== 1 || !Array.isArray(book.entries)) {
    throw new WalletBookCorruptError(
      'wallet book has an unsupported shape (expected { version: 1, entries: [...] })',
    );
  }
  // Drop legacy stealth/meta-address rows up front so a single
  // pre-Phase-2 stealth contact doesn't make the whole book
  // unreadable. After the filter, every surviving entry must satisfy
  // the current schema or the file is genuinely corrupt.
  const filtered = book.entries.filter((e) => !isLegacyStealthEntry(e));
  if (!filtered.every(isValidEntry)) {
    throw new WalletBookCorruptError('wallet book contains invalid entries');
  }
  // Normalize addresses on read so callers and the dedup check in `add`
  // don't have to think about casing. Strip any legacy `kind` field from
  // pre-removal entries so the in-memory shape matches WalletEntry.
  return filtered.map((e) => {
    const { kind: _drop, ...rest } = e as WalletEntry & { kind?: unknown };
    return { ...rest, address: normalizeAddress(rest.address) };
  });
}

async function readBook(ownerAddress: string): Promise<WalletEntry[]> {
  await migrateLegacyIfNeeded(ownerAddress);
  return readRawBook(keyFor(ownerAddress));
}

async function writeBook(ownerAddress: string, entries: WalletEntry[]): Promise<void> {
  const payload: WalletBookFile = { version: 1, entries };
  // Compact JSON — the file is machine-read; pretty-print wastes ~20% of
  // the AsyncStorage round-trip for a payload that grows linearly with
  // entry count.
  await AsyncStorage.setItem(keyFor(ownerAddress), JSON.stringify(payload));
}

// Serialize mutations per owning wallet so two rapid taps from the UI on
// the same wallet can't read-modify-write against stale entries. Different
// wallets get separate queues — they write to disjoint keys, so serializing
// across wallets would only add latency without preventing any race.
//
// Entries are deleted once the queued task settles AND no later task has
// chained onto it (guarded by the `tail === queued` identity check). Without
// this, long-running sessions — especially WalletConnect hopping between
// accounts — would accumulate one queue entry per distinct address ever
// seen and leak memory indefinitely.
const _mutationQueues = new Map<string, Promise<unknown>>();
function withLock<T>(ownerAddress: string, task: () => Promise<T>): Promise<T> {
  const key = ownerAddress.toLowerCase();
  const prev = _mutationQueues.get(key) ?? Promise.resolve();
  // `.catch(() => {})` first so a failed task can't wedge the queue;
  // then the next task always sees a settled chain.
  const run = prev.catch(() => {}).then(task);
  const tail = run.catch(() => {});
  _mutationQueues.set(key, tail);
  tail.finally(() => {
    // Only evict if no later task has chained onto this one — otherwise
    // we'd drop a still-running queue and allow a concurrent task to
    // race against it.
    if (_mutationQueues.get(key) === tail) {
      _mutationQueues.delete(key);
    }
  });
  return run;
}

// ─── Legacy (v1 single-wallet) → v2 per-wallet migration ──────────

/**
 * One-shot legacy-blob migration. Runs on first `list()`/mutation for
 * the wallet that owns the v1 data. The owner is identified by the
 * hardcoded `scatterdex_wallet_address` SecureStore value (the legacy
 * `KeySecurityService.ADDRESS_KEY`) — any other caller gets a no-op so
 * a WalletConnect-first caller can't silently adopt someone else's
 * address book. The marker is set before the legacy delete so a crash
 * between them turns the next run into a flag-check no-op.
 */
async function migrateLegacyIfNeeded(address: string): Promise<void> {
  const marker = await AsyncStorage.getItem(V2_MIGRATION_MARKER);
  if (marker === '1') return;

  const legacyRaw = await AsyncStorage.getItem(BASE_KEY);
  if (legacyRaw === null) {
    // Nothing to migrate — set marker so subsequent calls skip the check.
    await AsyncStorage.setItem(V2_MIGRATION_MARKER, '1');
    return;
  }

  const legacyBuiltinAddress = await SecureStore.getItemAsync(LEGACY_BUILTIN_ADDRESS_KEY);
  if (!eqAddr(legacyBuiltinAddress, address)) {
    // Defer migration — the blob stays in place until the correct
    // wallet connects. No marker set: retry on the next matching call.
    return;
  }

  const targetKey = keyFor(address);
  const existingTarget = await AsyncStorage.getItem(targetKey);
  if (existingTarget === null) {
    await AsyncStorage.setItem(targetKey, legacyRaw);
  }

  await AsyncStorage.setItem(V2_MIGRATION_MARKER, '1');

  // Legacy delete is best-effort — the flag prevents re-migration even
  // if this fails.
  try { await AsyncStorage.removeItem(BASE_KEY); } catch { /* best-effort */ }
}

/**
 * Shared input normalisation + validation for `add` and `addMany`. Keeps
 * them bit-for-bit consistent so a rule added to one can't silently skip
 * the other. The caller decides whether to throw (`add`) or collect the
 * failure reason (`addMany`).
 */
function prepareEntry(input: {
  label: string;
  address: string;
  memo?: string;
}):
  | { ok: true; entry: WalletEntry }
  | { ok: false; reason: 'invalid-address' | 'missing-label' } {
  // Trim the address once up front so callers (form submit,
  // BackupService.addMany, JSON-edited bundle import) all behave
  // consistently. Without this a UI that validates against
  // `formAddress.trim()` could mark a row as valid while the add
  // path rejects it because of trailing whitespace, or accept a
  // backup row whose JSON contains stray padding.
  const rawAddress: unknown = input.address;
  const trimmedAddress = typeof rawAddress === 'string' ? rawAddress.trim() : '';
  if (!isValidAddress(trimmedAddress)) {
    return { ok: false, reason: 'invalid-address' };
  }
  // Runtime-guard `label` / `memo` against non-string values — the
  // compile-time types say `string`, but BackupService hands bundle rows
  // straight through from user-edited JSON, where a number / null would
  // throw a TypeError inside `.trim()` and abort the whole `addMany`
  // batch. Fall through to `missing-label` so the entry is rejected
  // instead of crashing the transaction.
  const rawLabel: unknown = input.label;
  const label = typeof rawLabel === 'string' ? rawLabel.trim() : '';
  if (!label) return { ok: false, reason: 'missing-label' };
  const rawMemo: unknown = input.memo;
  const memo = typeof rawMemo === 'string' ? (rawMemo.trim() || undefined) : undefined;
  const entry: WalletEntry = {
    id: newId(),
    label,
    address: normalizeAddress(trimmedAddress),
    memo,
    createdAt: Math.floor(Date.now() / 1000),
  };
  return { ok: true, entry };
}

export const AddressBookService = {
  /** Throws WalletBookCorruptError if the stored blob is unreadable. */
  async list(ownerAddress: string): Promise<WalletEntry[]> {
    return readBook(ownerAddress);
  },

  async add(
    ownerAddress: string,
    input: { label: string; address: string; memo?: string },
  ): Promise<WalletEntry> {
    const prepared = prepareEntry(input);
    if (!prepared.ok) {
      throw new Error(prepared.reason === 'invalid-address' ? 'Invalid address' : 'Label is required');
    }

    return withLock(ownerAddress, async () => {
      const entries = await readBook(ownerAddress);
      if (entries.some((e) => e.address === prepared.entry.address)) {
        throw new Error('Address already in book');
      }
      await writeBook(ownerAddress, [...entries, prepared.entry]);
      return prepared.entry;
    });
  },

  /**
   * Bulk add — takes the mutation lock once and does a single
   * read-all / write-all round-trip instead of the O(N) locks and
   * O(N²) I/O cost of calling `add` in a loop (each call re-reads and
   * re-writes the entire book). Per-input result mirrors `add`'s
   * behaviour: `{ ok: true, entry }` on success, `{ ok: false, reason }`
   * for validation failure / duplicate.
   */
  async addMany(
    ownerAddress: string,
    inputs: Array<{ label: string; address: string; memo?: string }>,
  ): Promise<Array<
    | { ok: true; entry: WalletEntry }
    | { ok: false; reason: 'invalid' | 'duplicate' }
  >> {
    if (inputs.length === 0) return [];
    return withLock(ownerAddress, async () => {
      const entries = await readBook(ownerAddress);
      const taken = new Set(entries.map((e) => e.address));
      const out: Array<
        | { ok: true; entry: WalletEntry }
        | { ok: false; reason: 'invalid' | 'duplicate' }
      > = [];
      const toAppend: WalletEntry[] = [];
      for (const input of inputs) {
        const prepared = prepareEntry(input);
        if (!prepared.ok) {
          out.push({ ok: false, reason: 'invalid' });
          continue;
        }
        if (taken.has(prepared.entry.address)) {
          out.push({ ok: false, reason: 'duplicate' });
          continue;
        }
        taken.add(prepared.entry.address);
        toAppend.push(prepared.entry);
        out.push({ ok: true, entry: prepared.entry });
      }
      if (toAppend.length > 0) {
        await writeBook(ownerAddress, [...entries, ...toAppend]);
      }
      return out;
    });
  },

  async update(
    ownerAddress: string,
    id: string,
    patch: Partial<Pick<WalletEntry, 'label' | 'memo'>>,
  ): Promise<void> {
    if (patch.label !== undefined && !patch.label.trim()) {
      throw new Error('Label is required');
    }
    return withLock(ownerAddress, async () => {
      const entries = await readBook(ownerAddress);
      const idx = entries.findIndex((e) => e.id === id);
      // Throw on missing id — falling through would silently rewrite the
      // same blob (wasted I/O) and the caller would think the patch landed.
      if (idx === -1) throw new Error(`Entry not found: ${id}`);
      const next = [...entries];
      next[idx] = {
        ...next[idx],
        label: patch.label !== undefined ? patch.label.trim() : next[idx].label,
        memo: patch.memo !== undefined ? (patch.memo.trim() || undefined) : next[idx].memo,
      };
      await writeBook(ownerAddress, next);
    });
  },

  async remove(ownerAddress: string, id: string): Promise<void> {
    return withLock(ownerAddress, async () => {
      const entries = await readBook(ownerAddress);
      await writeBook(ownerAddress, entries.filter((e) => e.id !== id));
    });
  },

  /** Recover from corruption by wiping this wallet's book. The user loses
   *  labels but not any sensitive data — addresses are recoverable from
   *  on-chain history. Goes through `withLock` so a concurrent mutation
   *  queued before the reset can't re-create entries on top of the wiped
   *  store. Does not touch other wallets' books. */
  async wipe(ownerAddress: string): Promise<void> {
    return withLock(ownerAddress, async () => {
      await AsyncStorage.removeItem(keyFor(ownerAddress));
    });
  },
};
