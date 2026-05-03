/**
 * Stealth-claim inbox persisted in the user-picked notes folder
 * (`zkscatter-stealth-inbox.json`). Receivers paste claim links the
 * sender delivered out-of-band (email / KakaoTalk / Telegram); each
 * pasted link becomes one inbox entry the user can later see, track
 * status of, and submit when ready.
 *
 * Two delivery shapes are accepted on the way in:
 *
 *   1. **Claim link** — the canonical sender output, e.g.
 *      `https://pay.zkscatter.app/claim?id=<runId_idx>#<base64(ClaimPackage)>`.
 *      Decoded into the structured `pkg` field; the receiver derives
 *      the stealth private key locally with their meta-address keys.
 *   2. **Pre-derived stealth private key + claim package** — for
 *      out-of-band delivery cases where the sender hands the receiver
 *      a derived key directly. The package still travels alongside
 *      because the on-chain claim path needs the merkle proof,
 *      secret, etc.
 *
 * Cross-tab safety mirrors the wallet-book module: mutations are
 * serialized through a single in-tab queue; cross-tab races degrade
 * to last-writer-wins.
 */

import { decodeClaimPackage, type ClaimPackage } from "../notes";
import { hasFolder, loadFile, saveFile } from "./folder";

const STEALTH_INBOX_FILENAME = "zkscatter-stealth-inbox.json";
/** 0x + 33 hex bytes = compressed secp256k1 point. Same shape used
 *  for `ClaimPackage.ephemeralPubKey` validation. */
const PUBKEY_RE = /^0x[0-9a-fA-F]{66}$/;
/** 0x + 32 hex bytes — raw secp256k1 scalar (no `0x04` prefix etc.).
 *  We persist private keys lower-case to match how `stealthWallet`
 *  emits them; the matcher tolerates either case on input but the
 *  on-disk normalization keeps re-imports byte-equivalent. */
const PRIVKEY_RE = /^0x[0-9a-fA-F]{64}$/;

export class StealthInboxCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StealthInboxCorruptError";
  }
}

/** Local-only claim status. `available` covers both "claimable now"
 *  and "locked until releaseTime" — the inbox UI splits them by
 *  comparing `pkg.releaseTime` to the wall clock without changing
 *  the persisted enum, so a future on-chain reconciler can flip
 *  `available → claimed` without us having to introduce a third
 *  intermediate state. */
export type StealthInboxStatus = "available" | "claimed";

export interface StealthInboxEntry {
  /** Stable random id; the inbox table keys off this so renames don't
   *  re-sort. */
  id: string;
  /** Unix seconds — when the user pasted the entry. */
  addedAt: number;
  /** Original input the user pasted. Kept verbatim so a future parser
   *  upgrade can re-derive structured fields without asking the user
   *  to paste again. */
  rawInput: string;
  /** What kind of input the parser recognized. `link` is the common
   *  case; `key` is reserved for the rare hand-off where the sender
   *  passes a derived stealth privkey (the package still has to come
   *  too, so a lone `key` paste is rejected at parse time). */
  source: "link" | "key";
  /** Decoded claim package — present for every entry the parser
   *  accepts. Receiver-side proof generation reads from this. */
  pkg: ClaimPackage;
  /** EIP-5564 ephemeral pubkey from the package or the URL query;
   *  required before the receiver can derive the stealth private key
   *  locally. Absent when the sender pre-derived and shipped the
   *  privkey instead. */
  ephemeralPubKey?: string;
  /** Pre-derived stealth privkey, populated when `source === "key"`.
   *  Lets the receiver claim without holding their meta-address keys
   *  on this device. Empty for `source === "link"` until the receiver
   *  derives + caches it themselves (we don't store the derived key
   *  here today — derivation is cheap and re-running keeps the
   *  on-disk surface smaller). */
  stealthPrivateKey?: string;
  /** Current local view of the claim's status. Updated by the inbox
   *  page after a successful submit — we don't reconcile against
   *  on-chain state automatically (yet), so a claim made on a
   *  different device shows here as `available` until the user
   *  refreshes. */
  status: StealthInboxStatus;
  /** Unix seconds; only set once `status === "claimed"`. */
  claimedAt?: number;
  /** Tx hash of the claim submission. Only set once
   *  `status === "claimed"`. */
  txHash?: string;
}

interface StealthInboxFile {
  version: 1;
  entries: StealthInboxEntry[];
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isValidEntry(e: unknown): e is StealthInboxEntry {
  if (!e || typeof e !== "object") return false;
  const v = e as Record<string, unknown>;
  if (typeof v.id !== "string") return false;
  if (typeof v.addedAt !== "number") return false;
  if (typeof v.rawInput !== "string") return false;
  if (v.source !== "link" && v.source !== "key") return false;
  if (v.status !== "available" && v.status !== "claimed") return false;
  // pkg is structurally validated by `decodeClaimPackage` at load
  // time; here we just confirm it's an object so the load doesn't
  // crash later when consumers dereference its fields.
  if (!v.pkg || typeof v.pkg !== "object") return false;
  if (
    v.ephemeralPubKey !== undefined &&
    !(typeof v.ephemeralPubKey === "string" && PUBKEY_RE.test(v.ephemeralPubKey))
  ) {
    return false;
  }
  if (
    v.stealthPrivateKey !== undefined &&
    !(typeof v.stealthPrivateKey === "string" && PRIVKEY_RE.test(v.stealthPrivateKey))
  ) {
    return false;
  }
  if (v.claimedAt !== undefined && typeof v.claimedAt !== "number") return false;
  if (v.txHash !== undefined && typeof v.txHash !== "string") return false;
  return true;
}

/** Read the inbox from the active folder. Returns `[]` when no
 *  folder is selected or the file doesn't exist yet. Throws
 *  {@link StealthInboxCorruptError} on a parseable-but-malformed
 *  file so the UI can offer a "wipe and start over" path rather
 *  than silently overwriting. */
export async function loadStealthInbox(): Promise<StealthInboxEntry[]> {
  if (!hasFolder()) return [];
  const text = await loadFile(STEALTH_INBOX_FILENAME);
  if (!text) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new StealthInboxCorruptError(
      `${STEALTH_INBOX_FILENAME} is not valid JSON: ${
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
    throw new StealthInboxCorruptError(
      `${STEALTH_INBOX_FILENAME} has an unsupported shape (expected { version: 1, entries: [...] })`,
    );
  }
  const entries = (parsed as { entries: unknown[] }).entries;
  if (!entries.every(isValidEntry)) {
    throw new StealthInboxCorruptError(
      `${STEALTH_INBOX_FILENAME} contains invalid entries`,
    );
  }
  return entries;
}

async function writeInbox(entries: StealthInboxEntry[]): Promise<void> {
  const payload: StealthInboxFile = { version: 1, entries };
  await saveFile(STEALTH_INBOX_FILENAME, JSON.stringify(payload, null, 2));
}

let _mutationQueue: Promise<unknown> = Promise.resolve();
function withLock<T>(task: () => Promise<T>): Promise<T> {
  const run = _mutationQueue.then(task, task);
  _mutationQueue = run.catch(() => {});
  return run;
}

/** Discriminated input describing what the parser pulled from the
 *  user's paste. Either a link (most common — full URL or just the
 *  fragment) or a privkey + already-decoded package (for the rare
 *  hand-off case). */
export type ParsedClaimInput =
  | {
      source: "link";
      rawInput: string;
      pkg: ClaimPackage;
      ephemeralPubKey?: string;
    }
  | {
      source: "key";
      rawInput: string;
      pkg: ClaimPackage;
      stealthPrivateKey: string;
      ephemeralPubKey?: string;
    };

/** Parse a free-form paste into a structured input. Accepts:
 *
 *   - a full claim URL (`https://…/claim?id=…&epk=…#<base64Package>`)
 *   - just the URL fragment (the base64-encoded ClaimPackage)
 *   - a privkey hex string **plus** a base64-encoded package, separated
 *     by whitespace or a `|` delimiter — used when the sender hands the
 *     receiver a pre-derived spending key
 *
 *  Throws with a human-readable error when neither shape parses.
 *  Stays a pure function so the inbox page can preview the parse
 *  without touching disk. */
export function parseClaimInput(rawInput: string): ParsedClaimInput {
  const trimmed = rawInput.trim();
  if (!trimmed) throw new Error("Empty input");

  // (1) Privkey + package shape — split on whitespace or `|`.
  const tokens = trimmed.split(/[|\s]+/).filter(Boolean);
  if (tokens.length === 2) {
    const [a, b] = tokens;
    const keyTok = PRIVKEY_RE.test(a) ? a : PRIVKEY_RE.test(b) ? b : null;
    const otherTok = keyTok === a ? b : keyTok === b ? a : null;
    if (keyTok && otherTok) {
      const { pkg, ephemeralPubKey } = decodePackageFromAnyForm(otherTok);
      return {
        source: "key",
        rawInput: trimmed,
        pkg,
        stealthPrivateKey: keyTok.toLowerCase(),
        ephemeralPubKey,
      };
    }
  }

  // (2) Single token / single line: link or fragment.
  const { pkg, ephemeralPubKey } = decodePackageFromAnyForm(trimmed);
  return { source: "link", rawInput: trimmed, pkg, ephemeralPubKey };
}

function decodePackageFromAnyForm(token: string): {
  pkg: ClaimPackage;
  ephemeralPubKey?: string;
} {
  // Full URL form — pull `#fragment` and `?epk=…` query.
  if (token.startsWith("http://") || token.startsWith("https://")) {
    let url: URL;
    try {
      url = new URL(token);
    } catch {
      throw new Error("Could not parse URL");
    }
    const hash = url.hash.replace(/^#/, "");
    if (!hash) throw new Error("Claim URL is missing the package fragment");
    const pkg = decodeClaimPackage(hash);
    const epk = pkg.ephemeralPubKey ?? url.searchParams.get("epk") ?? undefined;
    return { pkg, ephemeralPubKey: epk ?? undefined };
  }
  // Bare fragment / base64url payload.
  const stripped = token.replace(/^#/, "");
  const pkg = decodeClaimPackage(stripped);
  return { pkg, ephemeralPubKey: pkg.ephemeralPubKey };
}

/** Append a new entry. Refuses to insert a duplicate (same
 *  `claimsRoot + leafIndex` is the canonical claim identity, so two
 *  pastes of the same link collapse into one row). Returns the
 *  inserted entry, or `null` if it duplicated an existing one. */
export async function addStealthInboxEntry(
  parsed: ParsedClaimInput,
): Promise<StealthInboxEntry | null> {
  return withLock(async () => {
    const entries = await loadStealthInbox();
    const existing = entries.find(
      (e) =>
        e.pkg.claimsRoot === parsed.pkg.claimsRoot &&
        e.pkg.leafIndex === parsed.pkg.leafIndex,
    );
    if (existing) return null;
    const entry: StealthInboxEntry = {
      id: newId(),
      addedAt: Math.floor(Date.now() / 1000),
      rawInput: parsed.rawInput,
      source: parsed.source,
      pkg: parsed.pkg,
      ephemeralPubKey: parsed.ephemeralPubKey,
      stealthPrivateKey:
        parsed.source === "key" ? parsed.stealthPrivateKey : undefined,
      status: "available",
    };
    await writeInbox([...entries, entry]);
    return entry;
  });
}

/** Mark an entry as claimed. No-op when the id isn't in the inbox. */
export async function markStealthInboxEntryClaimed(
  id: string,
  txHash: string,
): Promise<void> {
  return withLock(async () => {
    const entries = await loadStealthInbox();
    const next = entries.map((e) =>
      e.id === id
        ? {
            ...e,
            status: "claimed" as const,
            claimedAt: Math.floor(Date.now() / 1000),
            txHash,
          }
        : e,
    );
    await writeInbox(next);
  });
}

/** Remove an entry by id. No-op when the id isn't in the inbox. */
export async function removeStealthInboxEntry(id: string): Promise<void> {
  return withLock(async () => {
    const entries = await loadStealthInbox();
    await writeInbox(entries.filter((e) => e.id !== id));
  });
}
