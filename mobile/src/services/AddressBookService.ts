/**
 * AddressBookService — labelled recipient addresses for the trade flow.
 *
 * Mirrors the web `wallet-book.ts` (`frontend/app/lib/wallet-book.ts`) one-
 * for-one in shape (`{id, label, address, memo?, createdAt}`) and lock
 * semantics so the two stores can be cross-referenced in the future.
 *
 * On mobile we don't have the File System Access API the web uses, and
 * the entries are not sensitive (labels + 0x addresses, no secrets), so
 * AsyncStorage is the right home — single JSON blob keyed by
 * `scatterdex_wallet_book_v1`. Mutations are serialized through a
 * promise chain so concurrent in-process callers can't race on
 * read-modify-write. Note this is in-process only: a backgrounded app
 * killed mid-write can still lose an entry on the next launch's first
 * write — acceptable for a single-device address book.
 */
// Self-import the polyfill so AddressBookService is safe to import from
// non-App entry points (tests, headless tasks). The package is idempotent
// — App.tsx already imports it and the second import is a no-op.
import 'react-native-get-random-values';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ethers } from 'ethers';

const STORAGE_KEY = 'scatterdex_wallet_book_v1';

export class WalletBookCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletBookCorruptError';
  }
}

export interface WalletEntry {
  id: string;
  label: string;
  address: string;     // lowercase 0x-prefixed
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

function isValidEntry(e: unknown): e is WalletEntry {
  if (!e || typeof e !== 'object') return false;
  const v = e as Record<string, unknown>;
  return (
    typeof v.id === 'string'
    && typeof v.label === 'string'
    && typeof v.address === 'string'
    && ethers.isAddress(v.address as string)
    && typeof v.createdAt === 'number'
    && (v.memo === undefined || typeof v.memo === 'string')
  );
  // Note: lowercase normalization happens at write time in `add` and on
  // read via `readBook` below — be lenient at the boundary so a manually-
  // edited file or a sync from a tool that emits checksummed addresses
  // doesn't trip WalletBookCorruptError.
}

async function readBook(): Promise<WalletEntry[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
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
  if (!book.entries.every(isValidEntry)) {
    throw new WalletBookCorruptError('wallet book contains invalid entries');
  }
  // Normalize addresses on read so callers and the dedup check in `add`
  // don't have to think about casing.
  return book.entries.map((e) => ({ ...e, address: normalizeAddress(e.address) }));
}

async function writeBook(entries: WalletEntry[]): Promise<void> {
  const payload: WalletBookFile = { version: 1, entries };
  // Compact JSON — the file is machine-read; pretty-print wastes ~20% of
  // the AsyncStorage round-trip for a payload that grows linearly with
  // entry count.
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

// Serialize mutations so two rapid taps from the UI can't read-modify-write
// against stale entries.
let _mutationQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(task: () => Promise<T>): Promise<T> {
  // `.catch(() => {})` first so a failed task can't wedge the queue;
  // then the next task always sees a settled chain.
  const run = _mutationQueue.catch(() => {}).then(task);
  _mutationQueue = run.catch(() => {});
  return run;
}

export const AddressBookService = {
  /** Throws WalletBookCorruptError if the stored blob is unreadable. */
  async list(): Promise<WalletEntry[]> {
    return readBook();
  },

  async add(input: { label: string; address: string; memo?: string }): Promise<WalletEntry> {
    if (!ethers.isAddress(input.address)) throw new Error('Invalid address');
    const label = input.label.trim();
    if (!label) throw new Error('Label is required');
    const address = normalizeAddress(input.address);

    return withLock(async () => {
      const entries = await readBook();
      if (entries.some((e) => e.address === address)) {
        throw new Error('Address already in book');
      }
      const entry: WalletEntry = {
        id: newId(),
        label,
        address,
        memo: input.memo?.trim() || undefined,
        createdAt: Math.floor(Date.now() / 1000),
      };
      await writeBook([...entries, entry]);
      return entry;
    });
  },

  async update(id: string, patch: Partial<Pick<WalletEntry, 'label' | 'memo'>>): Promise<void> {
    if (patch.label !== undefined && !patch.label.trim()) {
      throw new Error('Label is required');
    }
    return withLock(async () => {
      const entries = await readBook();
      const next = entries.map((e) =>
        e.id === id
          ? {
              ...e,
              label: patch.label !== undefined ? patch.label.trim() : e.label,
              memo: patch.memo !== undefined ? (patch.memo.trim() || undefined) : e.memo,
            }
          : e,
      );
      await writeBook(next);
    });
  },

  async remove(id: string): Promise<void> {
    return withLock(async () => {
      const entries = await readBook();
      await writeBook(entries.filter((e) => e.id !== id));
    });
  },

  /** Recover from corruption by wiping. The user will lose labels but not
   *  any sensitive data — addresses are recoverable from on-chain history.
   *  Goes through `withLock` so a concurrent `add`/`update`/`remove` queued
   *  before the reset can't re-create entries on top of the wiped store. */
  async wipe(): Promise<void> {
    return withLock(async () => {
      await AsyncStorage.removeItem(STORAGE_KEY);
    });
  },
};
