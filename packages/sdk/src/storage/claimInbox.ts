/**
 * Claim inbox for EOA recipients. Persists to
 * `zkscatter-claim-inbox.json` in the user-picked folder. Each entry
 * records a claim payable to a wallet address: no ephemeral pubkey,
 * no pre-derived privkey hand-off — claims bind directly to the
 * recipient's EOA.
 */

import {
  decodeClaimPackage,
  isClaimPackage,
  type ClaimPackage,
} from "../notes";
import { hasFolder, loadFile, saveFile } from "./folder";

// Claim inboxes are scoped per app: each product (Pay, Pro, …) keeps
// its own file, so a claim saved in one app doesn't surface in another
// that merely shares the same workspace folder. `setClaimInboxApp` picks
// the namespace once at app init; until then — and for any consumer that
// never sets it — we fall back to the original shared filename.
//
// The pre-split shared file (`zkscatter-claim-inbox.json`) stays readable
// as a legacy fallback so existing entries don't vanish, and its entries
// stay mutable in place; only NEW entries land in the app-scoped file.
const LEGACY_CLAIM_INBOX_FILENAME = "zkscatter-claim-inbox.json";

let _appNamespace: string | null = null;

/** Scope this app's claim inbox to its own file
 *  (`zkscatter-<app>-claim-inbox.json`). Call once at app init (e.g. in
 *  the root providers). Pay passes `"pay"`, Pro passes `"pro"`. */
export function setClaimInboxApp(app: string): void {
  _appNamespace = app.trim() || null;
}

/** The app-scoped inbox filename, or null when no namespace is set (the
 *  legacy shared file is then the only store). */
function appInboxFilename(): string | null {
  return _appNamespace ? `zkscatter-${_appNamespace}-claim-inbox.json` : null;
}

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

/** Parse + validate one inbox file. Returns [] when absent. Throws
 *  `ClaimInboxCorruptError` (naming the file) on malformed content. */
async function readInboxFile(filename: string): Promise<ClaimInboxEntry[]> {
  const text = await loadFile(filename);
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ClaimInboxCorruptError(
      `${filename} is not valid JSON: ${
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
      `${filename} has an unsupported shape (expected { version: 1, entries: [...] })`,
    );
  }
  const entries = (parsed as { entries: unknown[] }).entries;
  if (!entries.every(isValidEntry)) {
    throw new ClaimInboxCorruptError(`${filename} contains invalid entries`);
  }
  return entries as ClaimInboxEntry[];
}

export async function loadClaimInbox(): Promise<ClaimInboxEntry[]> {
  if (!hasFolder()) return [];
  const appFile = appInboxFilename();
  if (!appFile) return readInboxFile(LEGACY_CLAIM_INBOX_FILENAME);
  // Read both files in parallel. `allSettled` (not `all`) so the second
  // read's rejection can't surface as an unhandled rejection; we re-throw
  // any corruption below so a bad file still reaches the UI rather than
  // being silently dropped.
  const [appR, legacyR] = await Promise.allSettled([
    readInboxFile(appFile),
    readInboxFile(LEGACY_CLAIM_INBOX_FILENAME),
  ]);
  if (appR.status === "rejected") throw appR.reason;
  if (legacyR.status === "rejected") throw legacyR.reason;
  // App file ∪ legacy (legacy shown as read fallback). Dedup by id —
  // ids are disjoint across files, so this is a defensive union with
  // the app file winning.
  const seen = new Set(appR.value.map((e) => e.id));
  return [...appR.value, ...legacyR.value.filter((e) => !seen.has(e.id))];
}

async function writeInboxFile(
  filename: string,
  entries: ClaimInboxEntry[],
): Promise<void> {
  const payload: ClaimInboxFile = { version: 1, entries };
  await saveFile(filename, JSON.stringify(payload, null, 2));
}

/** Locate an entry's home file AND return that file's parsed entries, so
 *  a mutation can rewrite it without a second read. App file first, then
 *  the legacy file (mutated in place rather than migrated); null when the
 *  entry is in neither. */
async function findInboxFileAndEntries(
  id: string,
): Promise<{ filename: string; entries: ClaimInboxEntry[] } | null> {
  const appFile = appInboxFilename();
  if (appFile) {
    const appEntries = await readInboxFile(appFile);
    if (appEntries.some((e) => e.id === id)) {
      return { filename: appFile, entries: appEntries };
    }
  }
  const legacy = await readInboxFile(LEGACY_CLAIM_INBOX_FILENAME);
  if (legacy.some((e) => e.id === id)) {
    return { filename: LEGACY_CLAIM_INBOX_FILENAME, entries: legacy };
  }
  return null;
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
  // Privkey+package hand-off (stealth-only) — detect early so the
  // user gets a clear pointer to the stealth inbox instead of an
  // opaque base64 decode error from a token concatenation.
  if (/[|\s]/.test(trimmed) && trimmed.split(/[|\s]+/).filter(Boolean).length > 1) {
    throw new Error(
      "This inbox accepts a single claim link or fragment. " +
        "Privkey + package hand-offs belong in the Stealth inbox.",
    );
  }
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

/** Insert one entry, deduping by `claimsRoot + leafIndex`. Always
 *  returns the entry that now represents the (root, leaf) pair so
 *  callers can mark it claimed regardless of whether they inserted
 *  fresh or hit a pre-saved row. `isNew` distinguishes the two for
 *  UI copy. */
export async function addClaimInboxEntry(input: {
  rawInput: string;
  pkg: ClaimPackage;
}): Promise<{ entry: ClaimInboxEntry; isNew: boolean }> {
  return withLock(async () => {
    const entries = await loadClaimInbox();
    const existing = entries.find(
      (e) =>
        e.pkg.claimsRoot === input.pkg.claimsRoot &&
        e.pkg.leafIndex === input.pkg.leafIndex,
    );
    if (existing) return { entry: existing, isNew: false };
    const entry: ClaimInboxEntry = {
      id: newId(),
      addedAt: Math.floor(Date.now() / 1000),
      rawInput: input.rawInput,
      pkg: input.pkg,
      status: "available",
    };
    // New entries always land in the app-scoped file (legacy stays
    // read-only). `entries` (the merged view) is only used for the
    // dedup above; write back the target file's own contents.
    const target = appInboxFilename() ?? LEGACY_CLAIM_INBOX_FILENAME;
    const targetEntries = await readInboxFile(target);
    await writeInboxFile(target, [...targetEntries, entry]);
    return { entry, isNew: true };
  });
}

export async function markClaimInboxEntryClaimed(
  id: string,
  txHash?: string,
): Promise<void> {
  return withLock(async () => {
    const found = await findInboxFileAndEntries(id);
    if (!found) return;
    const next = found.entries.map((e) =>
      e.id === id
        ? {
            ...e,
            status: "claimed" as const,
            claimedAt: Math.floor(Date.now() / 1000),
            ...(txHash ? { txHash } : {}),
          }
        : e,
    );
    await writeInboxFile(found.filename, next);
  });
}

export async function removeClaimInboxEntry(id: string): Promise<void> {
  return withLock(async () => {
    const found = await findInboxFileAndEntries(id);
    if (!found) return;
    await writeInboxFile(
      found.filename,
      found.entries.filter((e) => e.id !== id),
    );
  });
}

/** Inbox entries bucketed by the sender-provided run title. Link-saved
 *  claims carry `runLabel` inside the encoded package, so they fold
 *  into the same buckets as auto-saved ones; packages without a title
 *  share one untitled bucket (`label === null` — render it with the
 *  same "Private payout" fallback the row copy uses). Shared by Pay's
 *  /inbox and Pro's /claims so the two stay in lock-step. */
export interface ClaimInboxGroup {
  key: string;
  label: string | null;
  entries: ClaimInboxEntry[];
}

export function groupClaimInbox(entries: ClaimInboxEntry[]): ClaimInboxGroup[] {
  const byKey = new Map<string, ClaimInboxGroup>();
  for (const e of entries) {
    const label = e.pkg.runLabel?.trim() || null;
    // Prefix titled keys so a literal run title can never collide
    // with the untitled bucket's sentinel key.
    const key = label === null ? "untitled" : `t:${label}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, label, entries: [] };
      byKey.set(key, g);
    }
    g.entries.push(e);
  }
  // Callers pass entries sorted newest-first, so first-appearance
  // order ranks groups by their most recent claim — no extra sort.
  return [...byKey.values()];
}
