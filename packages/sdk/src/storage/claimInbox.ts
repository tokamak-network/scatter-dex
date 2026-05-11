/**
 * Claim inbox for non-stealth (regular EOA) recipients. Persists to
 * `zkscatter-claim-inbox.json` in the user-picked folder. Parallel to
 * `stealthInbox` but with a slimmer entry shape — no ephemeral pubkey,
 * no pre-derived privkey hand-off, no stealth-specific source kinds.
 *
 * The two inboxes intentionally don't share storage. A future pass can
 * merge them once we have a clearer view of cross-flow filters; for
 * now keeping them separate is the smallest change that lets EOA
 * recipients see their claim history without leaking stealth-only
 * fields into rows that don't need them.
 */

import {
  decodeClaimPackage,
  isClaimPackage,
  type ClaimPackage,
} from "../notes";
import { hasFolder, loadFile, saveFile } from "./folder";

const CLAIM_INBOX_FILENAME = "zkscatter-claim-inbox.json";

export class ClaimInboxCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimInboxCorruptError";
  }
}

export type ClaimInboxStatus = "available" | "claimed";

export interface ClaimInboxEntry {
  id: string;
  addedAt: number;
  rawInput: string;
  pkg: ClaimPackage;
  status: ClaimInboxStatus;
  claimedAt?: number;
  txHash?: string;
}

interface ClaimInboxFile {
  version: 1;
  entries: ClaimInboxEntry[];
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isValidEntry(e: unknown): e is ClaimInboxEntry {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  if (typeof v.id !== "string") return false;
  if (typeof v.addedAt !== "number") return false;
  if (typeof v.rawInput !== "string") return false;
  if (v.status !== "available" && v.status !== "claimed") return false;
  if (!isClaimPackage(v.pkg)) return false;
  if (v.claimedAt !== undefined && typeof v.claimedAt !== "number") return false;
  if (v.txHash !== undefined && typeof v.txHash !== "string") return false;
  return true;
}

export async function loadClaimInbox(): Promise<ClaimInboxEntry[]> {
  if (!hasFolder()) return [];
  const text = await loadFile(CLAIM_INBOX_FILENAME);
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ClaimInboxCorruptError(
      `${CLAIM_INBOX_FILENAME} is not valid JSON: ${
        e instanceof Error ? e.message : "parse error"
      }`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new ClaimInboxCorruptError(
      `${CLAIM_INBOX_FILENAME} has an unsupported shape (expected { version: 1, entries: [...] })`,
    );
  }
  const entries = (parsed as { entries: unknown[] }).entries;
  if (!entries.every(isValidEntry)) {
    throw new ClaimInboxCorruptError(
      `${CLAIM_INBOX_FILENAME} contains invalid entries`,
    );
  }
  return entries;
}

async function writeInbox(entries: ClaimInboxEntry[]): Promise<void> {
  const payload: ClaimInboxFile = { version: 1, entries };
  await saveFile(CLAIM_INBOX_FILENAME, JSON.stringify(payload, null, 2));
}

let _mutationQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = _mutationQueue.then(task, task);
  _mutationQueue = run.catch(() => {});
  return run;
}

/** Parse a free-form paste into a ClaimPackage. Accepts the canonical
 *  claim URL or a bare base64url payload (`#fragment`). EOA inbox
 *  never accepts the privkey+package hand-off shape — that path is
 *  stealth-only. */
export function parseClaimInboxInput(rawInput: string): {
  rawInput: string;
  pkg: ClaimPackage;
} {
  const trimmed = rawInput.trim();
  if (!trimmed) throw new Error("Empty input");
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new Error("Could not parse URL");
    }
    const hash = url.hash.replace(/^#/, "");
    if (!hash) throw new Error("Claim URL is missing the package fragment");
    return { rawInput: trimmed, pkg: decodeClaimPackage(hash) };
  }
  const stripped = trimmed.replace(/^#/, "");
  return { rawInput: trimmed, pkg: decodeClaimPackage(stripped) };
}

/** Insert one entry. Dedupes by `claimsRoot + leafIndex` so re-pasting
 *  the same link doesn't create duplicates. Returns the inserted
 *  entry or `null` when the entry already existed. */
export async function addClaimInboxEntry(input: {
  rawInput: string;
  pkg: ClaimPackage;
}): Promise<ClaimInboxEntry | null> {
  return withLock(async () => {
    const entries = await loadClaimInbox();
    const existing = entries.find(
      (e) =>
        e.pkg.claimsRoot === input.pkg.claimsRoot &&
        e.pkg.leafIndex === input.pkg.leafIndex,
    );
    if (existing) return null;
    const entry: ClaimInboxEntry = {
      id: newId(),
      addedAt: Math.floor(Date.now() / 1000),
      rawInput: input.rawInput,
      pkg: input.pkg,
      status: "available",
    };
    await writeInbox([...entries, entry]);
    return entry;
  });
}

export async function markClaimInboxEntryClaimed(
  id: string,
  txHash?: string,
): Promise<void> {
  return withLock(async () => {
    const entries = await loadClaimInbox();
    const next = entries.map((e) =>
      e.id === id
        ? {
            ...e,
            status: "claimed" as const,
            claimedAt: Math.floor(Date.now() / 1000),
            ...(txHash ? { txHash } : {}),
          }
        : e,
    );
    await writeInbox(next);
  });
}

export async function removeClaimInboxEntry(id: string): Promise<void> {
  return withLock(async () => {
    const entries = await loadClaimInbox();
    await writeInbox(entries.filter((e) => e.id !== id));
  });
}
