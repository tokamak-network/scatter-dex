/** Process-wide cache for the on-chain token whitelist read.
 *
 *  The whitelist only changes when an owner calls `setTokenWhitelist`, so
 *  re-reading it on every component mount / page navigation is wasted RPC
 *  work. This wraps {@link fetchWhitelistedTokens} with:
 *   - a short-TTL in-memory cache keyed by `(pool, settlement)`, shared by
 *     every hook instance in the bundle,
 *   - in-flight de-duplication, so N components mounting at once share one
 *     network read instead of firing N identical ones,
 *   - optional `sessionStorage` persistence, so the list survives a hard
 *     reload within the tab.
 *
 *  The cached value is the raw on-chain list (the overlay's symbol labels
 *  are baked in). The cache key intentionally omits the overlay: within a
 *  bundle the overlay is the deterministic env list, so it's constant per
 *  `(pool, settlement)`. */

import type { ethers } from "ethers";
import {
  fetchWhitelistedTokens,
  type FetchWhitelistedTokensOptions,
} from "./whitelist";
import type { TokenInfo } from "./tokens";

/** Default freshness window. A minute is plenty to collapse the burst of
 *  reads from one screen while still picking up an admin whitelist change
 *  soon after (or instantly via {@link invalidateWhitelistCache}). */
export const DEFAULT_WHITELIST_TTL_MS = 60_000;

const SESSION_PREFIX = "zkscatter.whitelist.";

interface CacheEntry {
  tokens: TokenInfo[];
  /** Epoch ms after which the entry is stale. */
  expires: number;
}

const memory = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<TokenInfo[]>>();

function cacheKey(poolAddress: string, settlementAddress: string): string {
  return `${poolAddress.toLowerCase()}|${settlementAddress.toLowerCase()}`;
}

/** `sessionStorage`, or null when unavailable (SSR / Node / privacy mode
 *  where access throws). */
function getSession(): Storage | null {
  try {
    return typeof window !== "undefined" && window.sessionStorage
      ? window.sessionStorage
      : null;
  } catch {
    return null;
  }
}

function readSession(key: string, now: number): CacheEntry | undefined {
  const store = getSession();
  if (!store) return undefined;
  try {
    const raw = store.getItem(SESSION_PREFIX + key);
    if (!raw) return undefined;
    // Validate defensively: the value is untrusted (could be corrupt, or
    // from an older shape after a deploy) — treat anything off as a miss.
    const parsed = JSON.parse(raw) as CacheEntry;
    if (
      !parsed ||
      typeof parsed.expires !== "number" ||
      !Array.isArray(parsed.tokens) ||
      parsed.expires <= now
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function writeSession(key: string, entry: CacheEntry): void {
  const store = getSession();
  if (!store) return;
  try {
    store.setItem(SESSION_PREFIX + key, JSON.stringify(entry));
  } catch {
    // Quota / serialization errors are non-fatal — the in-memory tier
    // still serves the rest of the session.
  }
}

function clearSession(key?: string): void {
  const store = getSession();
  if (!store) return;
  try {
    if (key) {
      store.removeItem(SESSION_PREFIX + key);
      return;
    }
    for (let i = store.length - 1; i >= 0; i--) {
      const k = store.key(i);
      if (k && k.startsWith(SESSION_PREFIX)) store.removeItem(k);
    }
  } catch {
    // ignore
  }
}

/** Fresh cached list for `(pool, settlement)`, or `undefined` if there's
 *  no fresh entry. Checks the in-memory tier first, then sessionStorage
 *  (promoting a hit into memory). */
function peek(
  poolAddress: string,
  settlementAddress: string,
  now: number,
): TokenInfo[] | undefined {
  const key = cacheKey(poolAddress, settlementAddress);
  const mem = memory.get(key);
  if (mem && mem.expires > now) return mem.tokens;
  const sess = readSession(key, now);
  if (sess) {
    memory.set(key, sess); // promote into the faster tier
    return sess.tokens;
  }
  return undefined;
}

export interface CachedWhitelistOptions extends FetchWhitelistedTokensOptions {
  /** Freshness window in ms. Default {@link DEFAULT_WHITELIST_TTL_MS}. */
  ttlMs?: number;
  /** Bypass any cached / in-flight value and refetch, then repopulate. */
  force?: boolean;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** {@link fetchWhitelistedTokens} with the process-wide cache + in-flight
 *  de-duplication described in the module header. Pass `force: true` (or
 *  call {@link invalidateWhitelistCache}) to refetch after a whitelist
 *  write. */
export async function fetchWhitelistedTokensCached(
  provider: ethers.Provider,
  poolAddress: string,
  settlementAddress: string,
  options: CachedWhitelistOptions = {},
): Promise<TokenInfo[]> {
  const ttl = options.ttlMs ?? DEFAULT_WHITELIST_TTL_MS;
  const now = options.now ?? Date.now;
  const key = cacheKey(poolAddress, settlementAddress);

  if (options.force) {
    invalidateWhitelistCache(poolAddress, settlementAddress);
  } else {
    const cached = peek(poolAddress, settlementAddress, now());
    if (cached) return cached;
    const pending = inflight.get(key);
    if (pending) return pending;
  }

  const p = fetchWhitelistedTokens(provider, poolAddress, settlementAddress, options)
    .then((tokens) => {
      const entry: CacheEntry = { tokens, expires: now() + ttl };
      memory.set(key, entry);
      writeSession(key, entry);
      return tokens;
    })
    .finally(() => {
      inflight.delete(key);
    });
  inflight.set(key, p);
  return p;
}

/** Drop cached whitelist data so the next read refetches. With both
 *  addresses, clears just that pair; with no args, clears everything
 *  (e.g. on a network switch, or after an admin whitelist write). */
export function invalidateWhitelistCache(
  poolAddress?: string,
  settlementAddress?: string,
): void {
  if (poolAddress && settlementAddress) {
    const key = cacheKey(poolAddress, settlementAddress);
    memory.delete(key);
    inflight.delete(key);
    clearSession(key);
    return;
  }
  memory.clear();
  inflight.clear();
  clearSession();
}
