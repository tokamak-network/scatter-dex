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
  /** Lowercase 0x-prefixed address. Validated on add. */
  address: string;
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
    (v.memo === undefined || typeof v.memo === "string")
  );
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

  const book = parsed as WalletBookFile | null;
  if (
    !book ||
    typeof book !== "object" ||
    book.version !== 1 ||
    !Array.isArray(book.entries)
  ) {
    throw new WalletBookCorruptError(
      `${WALLET_BOOK_FILENAME} has an unsupported shape (expected { version: 1, entries: [...] })`,
    );
  }

  if (!book.entries.every(isValidEntry)) {
    throw new WalletBookCorruptError(`${WALLET_BOOK_FILENAME} contains invalid entries`);
  }
  return book.entries;
}

async function writeBook(entries: WalletEntry[]): Promise<void> {
  const payload: WalletBookFile = { version: 1, entries };
  await saveFile(WALLET_BOOK_FILENAME, JSON.stringify(payload, null, 2));
}

// Serialize every mutation through a single promise chain so concurrent
// add/update/remove calls can't race on read-modify-write. Each task
// runs load-modify-save end-to-end before the next begins.
let _mutationQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = _mutationQueue.then(task, task);
  _mutationQueue = run.catch(() => {});
  return run;
}

/** Add a new entry. Throws when the address is invalid, the label is
 *  empty, or the address already exists in the book. */
export async function addWallet(input: {
  label: string;
  address: string;
  memo?: string;
}): Promise<WalletEntry> {
  if (!ethers.isAddress(input.address)) throw new Error("Invalid address");
  const label = input.label.trim();
  if (!label) throw new Error("Label is required");
  const address = input.address.toLowerCase();

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
      createdAt: Math.floor(Date.now() / 1000),
    };
    await writeBook([...entries, entry]);
    return entry;
  });
}

/** Patch an existing entry's label or memo. The address is immutable
 *  (a different address means a different entry). */
export async function updateWallet(
  id: string,
  patch: Partial<Pick<WalletEntry, "label" | "memo">>,
): Promise<void> {
  if (patch.label !== undefined && !patch.label.trim()) {
    throw new Error("Label is required");
  }
  return withLock(async () => {
    const entries = await loadWalletBook();
    const next = entries.map((e) =>
      e.id === id
        ? {
            ...e,
            label: patch.label !== undefined ? patch.label.trim() : e.label,
            memo:
              patch.memo !== undefined ? patch.memo.trim() || undefined : e.memo,
          }
        : e,
    );
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
