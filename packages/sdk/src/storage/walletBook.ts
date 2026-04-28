/**
 * Address book persisted in the user's notes folder (the same File
 * System Access API directory that holds deposit notes, claim
 * records, and EdDSA keys).
 *
 * Stored as a single JSON file `zkscatter-wallets.json`; entries are
 * keyed by a stable random `id` so labels can be renamed without
 * orphaning external references.
 *
 * Lifted from `frontend/app/lib/wallet-book.ts`. The frontend may
 * eventually re-import from this SDK module so both sides stay in
 * lockstep.
 */

import { ethers } from "ethers";
import { hasFolder, loadFile, saveFile } from "./folder";

const WALLET_BOOK_FILENAME = "zkscatter-wallets.json";

export class WalletBookCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalletBookCorruptError";
  }
}

export interface WalletEntry {
  id: string;
  label: string;
  /** Lowercase 0x-prefixed default address. Used when the run's
   *  chain is not in `addressByChain`. Validated on add. */
  address: string;
  /** Per-chain address override. Pay's wizard picks
   *  `addressByChain[run.chainId] ?? address` so the same recipient
   *  can be paid on Ethereum and a different L2 without two book
   *  entries. Keys are numeric chain ids; values are lowercase
   *  0x-prefixed addresses. Optional — most recipients use the same
   *  address everywhere. */
  addressByChain?: Record<number, string>;
  /** Email Pay copies into the run record at send time so the run
   *  stays valid even if the entry is later edited or removed. */
  email?: string;
  /** Discord handle for the same reason as `email`. */
  discordHandle?: string;
  /** Optional free-form note (e.g. "engineering team / Q2"). */
  memo?: string;
  /** Unix seconds. */
  createdAt: number;
}

interface WalletBookFile {
  version: 1;
  entries: WalletEntry[];
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Reject any key that is not the canonical decimal string of a
 *  positive integer. `"0x1"` / `"1.0"` / `"1e3"` would pass a loose
 *  `Number()` check but never match a numeric `chainId` lookup,
 *  leaving an unreachable entry on disk. Exported so UI forms can
 *  validate before they hit `addWallet` / `updateWallet` (which
 *  throw on invalid keys). */
export function isCanonicalChainKey(key: string): boolean {
  if (key.length === 0 || key.length > 12) return false;
  const n = Number(key);
  if (!Number.isInteger(n) || n <= 0) return false;
  return String(n) === key;
}

function isValidAddressByChain(v: unknown): boolean {
  if (v === undefined) return true;
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  for (const [chainKey, addr] of Object.entries(v as Record<string, unknown>)) {
    if (!isCanonicalChainKey(chainKey)) return false;
    if (typeof addr !== "string" || !ethers.isAddress(addr)) return false;
    if (addr !== addr.toLowerCase()) return false;
  }
  return true;
}

function isValidEntry(e: unknown): e is WalletEntry {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    typeof v.address === "string" &&
    ethers.isAddress(v.address) &&
    v.address === (v.address as string).toLowerCase() &&
    typeof v.createdAt === "number" &&
    (v.memo === undefined || typeof v.memo === "string") &&
    (v.email === undefined || typeof v.email === "string") &&
    (v.discordHandle === undefined || typeof v.discordHandle === "string") &&
    isValidAddressByChain(v.addressByChain)
  );
}

/** Resolve the address Pay should use for a run on `chainId`.
 *  Falls back to the entry's default `address` when no per-chain
 *  override is set. */
export function entryAddressForChain(entry: WalletEntry, chainId: number): string {
  return entry.addressByChain?.[chainId] ?? entry.address;
}

/** Load the wallet book from the selected folder. Returns an empty
 *  array when no folder is selected or the file doesn't exist yet.
 *  Throws {@link WalletBookCorruptError} if the file exists but is
 *  not parseable or has an unsupported shape — callers must catch
 *  and prompt the user rather than letting the next write silently
 *  overwrite the corrupt file. */
export async function loadWalletBook(): Promise<WalletEntry[]> {
  if (!hasFolder()) return [];
  const text = await loadFile(WALLET_BOOK_FILENAME);
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new WalletBookCorruptError(
      `${WALLET_BOOK_FILENAME} is not valid JSON: ${
        e instanceof Error ? e.message : "parse error"
      }`,
    );
  }

  // Don't pre-cast to `WalletBookFile` — the JSON shape is whatever
  // a previous Pay/frontend run wrote. Narrow on `unknown` so the
  // checks below are real type guards (a future shape change is
  // a TS error, not a silent miscast).
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new WalletBookCorruptError(
      `${WALLET_BOOK_FILENAME} has an unsupported shape (expected { version: 1, entries: [...] })`,
    );
  }

  const entries = (parsed as { entries: unknown[] }).entries;
  if (!entries.every(isValidEntry)) {
    throw new WalletBookCorruptError(`${WALLET_BOOK_FILENAME} contains invalid entries`);
  }
  return entries;
}

async function writeBook(entries: WalletEntry[]): Promise<void> {
  const payload: WalletBookFile = { version: 1, entries };
  await saveFile(WALLET_BOOK_FILENAME, JSON.stringify(payload, null, 2));
}

// Serialize every mutation through a single promise chain so concurrent
// add/update/remove calls in *this tab* can't race on read-modify-write.
// Cross-tab safety is **not** provided: two tabs racing on the same
// folder will produce a last-writer-wins outcome on
// `zkscatter-wallets.json`. The address book is single-tenant per
// folder and rarely mutated, so this is acceptable; consumers that
// need stronger guarantees should layer a `BroadcastChannel` on top.
let _mutationQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = _mutationQueue.then(task, task);
  _mutationQueue = run.catch(() => {});
  return run;
}

function normaliseAddressByChain(
  input: Record<number, string> | undefined,
): Record<number, string> | undefined {
  if (!input) return undefined;
  const out: Record<number, string> = {};
  for (const [chainKey, addr] of Object.entries(input)) {
    // Accept the JS-numeric form (`{ 1: "0x..." }` reads back as
    // `"1"`) but reject anything that wouldn't round-trip through a
    // numeric lookup. JSON serialisation always emits the canonical
    // form anyway — this guards hand-edited / programmatic input.
    if (!isCanonicalChainKey(chainKey)) {
      throw new Error(`Invalid chain id: ${chainKey}`);
    }
    if (!ethers.isAddress(addr)) {
      throw new Error(`Invalid address for chain ${chainKey}: ${addr}`);
    }
    out[Number(chainKey)] = addr.toLowerCase();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Add a new entry. Throws when the address is invalid, the label is
 *  empty, or the address already exists in the book. */
export async function addWallet(input: {
  label: string;
  address: string;
  memo?: string;
  email?: string;
  discordHandle?: string;
  addressByChain?: Record<number, string>;
}): Promise<WalletEntry> {
  if (!ethers.isAddress(input.address)) throw new Error("Invalid address");
  const label = input.label.trim();
  if (!label) throw new Error("Label is required");
  const address = input.address.toLowerCase();
  const addressByChain = normaliseAddressByChain(input.addressByChain);

  return withLock(async () => {
    const entries = await loadWalletBook();
    if (entries.some((e) => e.address === address)) {
      throw new Error("Address already in book");
    }
    const entry: WalletEntry = {
      id: newId(),
      label,
      address,
      memo: input.memo?.trim() || undefined,
      email: input.email?.trim() || undefined,
      discordHandle: input.discordHandle?.trim() || undefined,
      addressByChain,
      createdAt: Math.floor(Date.now() / 1000),
    };
    await writeBook([...entries, entry]);
    return entry;
  });
}

/** Patch an existing entry. The default `address` is immutable —
 *  different identities should be separate entries — but per-chain
 *  overrides, contact fields, label, and memo can all be updated. */
export async function updateWallet(
  id: string,
  patch: Partial<
    Pick<WalletEntry, "label" | "memo" | "email" | "discordHandle"> & {
      addressByChain?: Record<number, string>;
    }
  >,
): Promise<void> {
  if (patch.label !== undefined && !patch.label.trim()) {
    throw new Error("Label is required");
  }
  const nextAddressByChain =
    patch.addressByChain !== undefined
      ? normaliseAddressByChain(patch.addressByChain)
      : undefined;

  return withLock(async () => {
    const entries = await loadWalletBook();
    const next = entries.map((e) => {
      if (e.id !== id) return e;
      return {
        ...e,
        label: patch.label !== undefined ? patch.label.trim() : e.label,
        memo: patch.memo !== undefined ? patch.memo.trim() || undefined : e.memo,
        email: patch.email !== undefined ? patch.email.trim() || undefined : e.email,
        discordHandle:
          patch.discordHandle !== undefined
            ? patch.discordHandle.trim() || undefined
            : e.discordHandle,
        addressByChain:
          patch.addressByChain !== undefined ? nextAddressByChain : e.addressByChain,
      };
    });
    await writeBook(next);
  });
}

/** Remove an entry by id. No-op when the id isn't in the book. */
export async function removeWallet(id: string): Promise<void> {
  return withLock(async () => {
    const entries = await loadWalletBook();
    await writeBook(entries.filter((e) => e.id !== id));
  });
}
