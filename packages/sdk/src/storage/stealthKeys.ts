/**
 * @deprecated Phase 2 stealth removal — see
 * `docs/architecture-decisions/0001-stealth-deprecation.md`. The
 * persisted meta-address keypair will be retired from the SDK
 * once consumers stop reading from this module; the file remains
 * for backward compatibility during the deprecation window.
 *
 * Stealth meta-address keypair persisted in the user's notes folder
 * — the same File System Access API directory that backs the wallet
 * book and run records.
 *
 * Stored as a single JSON file `zkscatter-stealth-keys.json`. Holds
 * the `MetaAddress` shape from `@zkscatter/sdk/zk` (spending +
 * viewing private keys + the public meta-address string). Losing
 * this file means losing the ability to derive spending keys for
 * any stealth address sent to that meta-address — back it up like
 * any other secret.
 *
 * The previous home for these keys was `localStorage` (apps/pro
 * `metaAddress.tsx`). One-shot migration helper `migrateFromLocalStorage`
 * reads the legacy key and writes to the folder so existing pro
 * users don't have to re-mint.
 */

import type { MetaAddress } from "../zk/stealth";
import { isMetaAddress } from "../zk/stealth";
import { loadFile, saveFile, removeFile } from "./folder";

export const STEALTH_KEYS_FILENAME = "zkscatter-stealth-keys.json";

/** Legacy localStorage key — only read once during migration. */
export const LEGACY_LOCAL_STORAGE_KEY = "zkscatter-pro-meta-address-v1";

/** Accept both `0x`-prefixed and bare 64-hex strings. The SDK's
 *  stealth helpers (`deriveStealthPrivateKey` etc.) tolerate either,
 *  so the storage validator should too — refusing only the prefix
 *  trips legitimate import flows from external wallets. */
const HEX_64_RE = /^(?:0x)?[0-9a-fA-F]{64}$/;

interface StealthKeysFile {
  version: 1;
  keys: MetaAddress;
}

export class StealthKeysCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StealthKeysCorruptError";
  }
}

/** Validate the shape of a `MetaAddress` payload before persisting it.
 *  Throws on malformed input so callers don't silently store garbage
 *  that fails later inside `stealthWallet` / `deriveStealthPrivateKey`. */
export function assertValidStealthKeys(keys: MetaAddress): void {
  if (!HEX_64_RE.test(keys.spendingKey)) {
    throw new StealthKeysCorruptError("spendingKey must be 64 hex characters");
  }
  if (!HEX_64_RE.test(keys.viewingKey)) {
    throw new StealthKeysCorruptError("viewingKey must be 64 hex characters");
  }
  if (!isMetaAddress(keys.metaAddress)) {
    throw new StealthKeysCorruptError("metaAddress is not a well-formed st:eth:0x… string");
  }
}

/** Read the stored keypair from the active folder. Returns null when
 *  no file exists. Throws `StealthKeysCorruptError` when the file
 *  exists but JSON-parses to an unexpected shape — surfacing this as
 *  a thrown error lets the UI offer a "wipe and start over" path
 *  rather than silently treating the user as un-keyed. */
export async function loadStealthKeys(): Promise<MetaAddress | null> {
  const raw = await loadFile(STEALTH_KEYS_FILENAME);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StealthKeysCorruptError(
      `Failed to parse ${STEALTH_KEYS_FILENAME}: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1
  ) {
    throw new StealthKeysCorruptError(`${STEALTH_KEYS_FILENAME} has an unexpected shape`);
  }
  // `typeof null === "object"` so we have to reject it explicitly,
  // otherwise the spendingKey field access below throws TypeError
  // and bypasses the StealthKeysCorruptError path callers expect.
  const candidateKeys = (parsed as { keys?: unknown }).keys;
  if (!candidateKeys || typeof candidateKeys !== "object") {
    throw new StealthKeysCorruptError(`${STEALTH_KEYS_FILENAME} has an unexpected shape`);
  }
  const keys = candidateKeys as MetaAddress;
  assertValidStealthKeys(keys);
  return keys;
}

/** Persist the keypair to the active folder. Throws when no folder
 *  is selected (callers should gate the UI on `hasFolder()` first)
 *  or when the input is malformed. */
export async function saveStealthKeys(keys: MetaAddress): Promise<void> {
  assertValidStealthKeys(keys);
  const file: StealthKeysFile = { version: 1, keys };
  await saveFile(STEALTH_KEYS_FILENAME, JSON.stringify(file, null, 2));
}

/** Wipe the stored file. Stealth funds already sent to the cleared
 *  keys become unrecoverable from this device unless the user has
 *  exported the spending/viewing keys elsewhere. */
export async function clearStealthKeys(): Promise<void> {
  await removeFile(STEALTH_KEYS_FILENAME);
}

/** One-shot migration: read the legacy `localStorage` entry that
 *  apps/pro used pre-folder-storage and copy it into the active
 *  folder. Returns the migrated keypair on success, or null when
 *  there's nothing to migrate / the legacy data was malformed.
 *
 *  Safe to call on every app start: a no-op once the folder file
 *  already exists. The legacy `localStorage` entry is removed only
 *  on a successful folder write so a permission revocation mid-
 *  migration leaves the legacy copy intact. */
export async function migrateFromLocalStorage(): Promise<MetaAddress | null> {
  if (typeof window === "undefined") return null;
  // Don't clobber an existing folder copy — that's the canonical one.
  const existing = await loadFile(STEALTH_KEYS_FILENAME).catch(() => null);
  if (existing !== null) return null;

  // `localStorage` access throws `SecurityError` in some private /
  // sandboxed contexts (Safari ITP, iframes with restricted cookie
  // policy, etc). Treat any read failure as "nothing to migrate"
  // rather than letting it bubble up and stall provider hydration.
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as { spendingKey?: unknown }).spendingKey !== "string" ||
    typeof (parsed as { viewingKey?: unknown }).viewingKey !== "string" ||
    typeof (parsed as { metaAddress?: unknown }).metaAddress !== "string"
  ) {
    return null;
  }
  const candidate = parsed as MetaAddress;
  try {
    assertValidStealthKeys(candidate);
  } catch {
    return null;
  }
  await saveStealthKeys(candidate);
  // Only after the folder write succeeded — survives a mid-flight
  // permission revoke. Wrapped in try/catch for the same SecurityError
  // reason as the read above; a failed remove leaves the legacy
  // entry, but the folder copy is canonical so subsequent loads skip
  // the migration anyway.
  try {
    window.localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
  } catch {
    /* swallow */
  }
  return candidate;
}
