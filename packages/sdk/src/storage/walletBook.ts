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
import { isMetaAddress, parseMetaAddress } from "../zk/stealth";

/** Strict meta-address validator used at the user-input boundary
 *  (`addWallet` / `updateWallet`). Goes beyond the regex shape check
 *  in `isMetaAddress` by actually decoding both compressed secp256k1
 *  points — catches values that pass the prefix+length sniff but
 *  would later make `generateStealthAddress()` throw when it parses
 *  the points. Kept loose on the on-disk read path
 *  (`isValidEntry` keeps the regex check) so an existing entry that
 *  was once accepted doesn't fail to load if the strictness rule
 *  changes later. */
function isStrictMetaAddress(value: string): boolean {
  if (!isMetaAddress(value)) return false;
  try {
    parseMetaAddress(value);
    return true;
  } catch {
    return false;
  }
}

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
   *  chain is not in `addressByChain`. Validated on add. Optional —
   *  a stealth-only entry can omit it as long as `metaAddress` is
   *  set; the wizard ignores such entries on the regular CSV path. */
  address?: string;
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
  /** Recipient's stealth meta-address (`st:eth:0x…`). When set,
   *  Pay's wizard can route payouts to this recipient through a
   *  one-time stealth address derived per send (EIP-5564). The
   *  recipient mints this in their own Stealth wallet and shares
   *  the public string out-of-band; nothing about it is sensitive
   *  to publish. Optional — recipients without a meta-address get
   *  paid to their default `address` like before. */
  metaAddress?: string;
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
  const addressOk =
    v.address === undefined ||
    (typeof v.address === "string" &&
      ethers.isAddress(v.address) &&
      v.address === (v.address as string).toLowerCase());
  const metaOk =
    v.metaAddress === undefined ||
    (typeof v.metaAddress === "string" && isMetaAddress(v.metaAddress));
  // Schema rule: an entry must carry at least one routing target —
  // a default `address` for direct sends, or a `metaAddress` for
  // stealth-only entries. Allowing both empty would let an unsendable
  // record persist on disk.
  const hasTarget = v.address !== undefined || v.metaAddress !== undefined;
  return (
    typeof v.id === "string" &&
    typeof v.label === "string" &&
    addressOk &&
    metaOk &&
    hasTarget &&
    typeof v.createdAt === "number" &&
    (v.memo === undefined || typeof v.memo === "string") &&
    (v.email === undefined || typeof v.email === "string") &&
    (v.discordHandle === undefined || typeof v.discordHandle === "string") &&
    isValidAddressByChain(v.addressByChain)
  );
}

/** Resolve the address Pay should use for a run on `chainId`.
 *  Falls back to the entry's default `address` when no per-chain
 *  override is set. Returns `undefined` for stealth-only entries
 *  (no default address and no per-chain override). */
export function entryAddressForChain(
  entry: WalletEntry,
  chainId: number,
): string | undefined {
  return entry.addressByChain?.[chainId] ?? entry.address;
}

/** Type guard for entries reachable through the wizard's regular
 *  CSV/address path. Stealth-only entries (no default `address`)
 *  fail this guard so callers narrowing on it can safely use
 *  `entry.address` without `!` or `?.`. */
export function hasDefaultAddress(
  entry: WalletEntry,
): entry is WalletEntry & { address: string } {
  return Boolean(entry.address);
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

/** Add a new entry. Throws when the label is empty, neither
 *  `address` nor `metaAddress` is provided, the address is malformed
 *  or already in the book, or the meta-address is malformed. Either
 *  routing target is sufficient: stealth-only entries (metaAddress
 *  but no address) are accepted and the wizard skips them on the
 *  regular CSV path. */
export async function addWallet(input: {
  label: string;
  address?: string;
  memo?: string;
  email?: string;
  discordHandle?: string;
  metaAddress?: string;
  addressByChain?: Record<number, string>;
}): Promise<WalletEntry> {
  const label = input.label.trim();
  if (!label) throw new Error("Label is required");
  const trimmedAddress = input.address?.trim();
  const trimmedMeta = input.metaAddress?.trim();
  if (!trimmedAddress && !trimmedMeta) {
    throw new Error("Provide a default address or a stealth meta-address");
  }
  if (trimmedAddress && !ethers.isAddress(trimmedAddress)) {
    throw new Error("Invalid address");
  }
  if (trimmedMeta && !isStrictMetaAddress(trimmedMeta)) {
    throw new Error("Invalid meta-address (expected st:eth:0x… with two valid compressed pubkeys)");
  }
  const address = trimmedAddress ? trimmedAddress.toLowerCase() : undefined;
  const addressByChain = normaliseAddressByChain(input.addressByChain);

  return withLock(async () => {
    const entries = await loadWalletBook();
    if (address && entries.some((e) => e.address === address)) {
      throw new Error("Address already in book");
    }
    const entry: WalletEntry = {
      id: newId(),
      label,
      address,
      memo: input.memo?.trim() || undefined,
      email: input.email?.trim() || undefined,
      discordHandle: input.discordHandle?.trim() || undefined,
      metaAddress: trimmedMeta || undefined,
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
    Pick<WalletEntry, "label" | "memo" | "email" | "discordHandle" | "metaAddress"> & {
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
  if (patch.metaAddress !== undefined) {
    const trimmed = patch.metaAddress.trim();
    if (trimmed && !isStrictMetaAddress(trimmed)) {
      throw new Error("Invalid meta-address (expected st:eth:0x… with two valid compressed pubkeys)");
    }
  }

  return withLock(async () => {
    const entries = await loadWalletBook();
    const next = entries.map((e) => {
      if (e.id !== id) return e;
      const nextMeta =
        patch.metaAddress !== undefined
          ? patch.metaAddress.trim() || undefined
          : e.metaAddress;
      // Clearing the meta-address on a stealth-only entry would leave
      // it with no routing target and break the schema invariant
      // (address || metaAddress required). Reject the edit so the
      // user can decide whether to remove the entry instead.
      if (!e.address && !nextMeta) {
        throw new Error(
          "Stealth-only entry requires a meta-address. Remove the entry instead of clearing it.",
        );
      }
      return {
        ...e,
        label: patch.label !== undefined ? patch.label.trim() : e.label,
        memo: patch.memo !== undefined ? patch.memo.trim() || undefined : e.memo,
        email: patch.email !== undefined ? patch.email.trim() || undefined : e.email,
        discordHandle:
          patch.discordHandle !== undefined
            ? patch.discordHandle.trim() || undefined
            : e.discordHandle,
        metaAddress: nextMeta,
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
