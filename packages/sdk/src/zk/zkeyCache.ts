/** IndexedDB-backed cache for the static `.wasm` / `.zkey` assets that
 *  snarkjs loads via `groth16.fullProve(input, wasmUrl, zkeyUrl)`.
 *  The four production circuits total ~28 MB on the wire — too big to
 *  rely on the browser HTTP cache surviving across tab-lifetime
 *  evictions. Falls back to the canonical URL on any cache failure
 *  (no IDB in private browsing, quota exceeded, network error with
 *  no cache, etc.).
 *
 *  Ported from `frontend/app/lib/zk/zkey-cache.ts`. The behavior is
 *  identical; only the import path for `warmupPoseidon` changed (now
 *  resolved within the same package). */

import { warmupPoseidon } from "./commitment";
import { openIDB } from "../util/idb";

const DB_NAME = "zk-asset-cache";
const STORE = "blobs";
const DB_VERSION = 1;
/** Skip ETag revalidation while the cached entry is younger than this.
 *  When `NEXT_PUBLIC_ZK_ASSETS_VERSION` is set (dev.sh writes it from
 *  the deposit zkey's content hash on every deploy), the appended
 *  `?v=…` query string changes the cache key on every redeploy and
 *  the TTL is effectively bypassed — no more "stale zkey served
 *  against a fresh verifier → opaque `InvalidProof()`" after a
 *  contract redeploy. The 7-day TTL stays as a belt-and-braces
 *  fallback for the case where the env isn't set (production builds
 *  that ship content-hashed filenames already, or developer
 *  environments missing the wiring). */
const FRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Append the deploy's asset-version cache-buster to a canonical
 *  asset URL so a contract redeploy that ships fresh zkeys
 *  invalidates the IndexedDB cache automatically. Reads a literal
 *  `process.env.NEXT_PUBLIC_ZK_ASSETS_VERSION` access (literal so
 *  Next inlines the value at build time); returns the URL untouched
 *  when the env isn't configured or already contains a `?v=`. */
function withAssetVersion(url: string): string {
  const v = process.env.NEXT_PUBLIC_ZK_ASSETS_VERSION;
  if (!v) return url;
  // Avoid double-appending when a caller has already attached a
  // version (e.g. an explicit override at the call site). Query-key
  // match is conservative: only skip when the URL has its own `v=`
  // param, not when it has any other query string.
  if (/[?&]v=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(v)}`;
}

interface CachedEntry {
  url: string;
  bytes: ArrayBuffer;
  etag?: string;
  fetchedAt: number;
}

const memCache = new Map<string, ArrayBuffer>();
/** In-flight dedup: a second caller arriving before a first fetch
 *  settles awaits the same Promise instead of kicking a parallel
 *  network request or duplicate IDB read. Critical for the
 *  prefetch-then-prove race — the worker preload starts a fetch, the
 *  user clicks, and the prover's `cachedAssetUrl` would otherwise hit
 *  memCache empty and refetch. */
const inflight = new Map<string, Promise<ArrayBuffer>>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  // No `onWarn`: the asset cache silently degrades to memory-only +
  // canonical URL on any IDB failure — that's the documented
  // contract of this module, not a bug to surface to the console.
  dbPromise = openIDB({
    dbName: DB_NAME,
    version: DB_VERSION,
    stores: [{ name: STORE, keyPath: "url" }],
  });
  return dbPromise;
}

function idbGet(db: IDBDatabase, url: string): Promise<CachedEntry | null> {
  return new Promise((resolve) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(url);
    req.onsuccess = () => resolve((req.result as CachedEntry | undefined) ?? null);
    req.onerror = () => resolve(null);
  });
}

function idbPut(db: IDBDatabase, entry: CachedEntry): Promise<void> {
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function fetchUncached(rawUrl: string): Promise<ArrayBuffer> {
  // Cache key + fetch URL share the versioned form so a redeploy
  // invalidates both the IDB row and the network response in one
  // step. The raw URL is never the cache key — callers that pre-
  // versioned their URLs hit the same key the cache builds here.
  const url = withAssetVersion(rawUrl);
  const memHit = memCache.get(url);
  if (memHit) return memHit;

  const db = await openDb();
  const cached = db ? await idbGet(db, url) : null;

  if (cached && Date.now() - cached.fetchedAt < FRESH_TTL_MS) {
    memCache.set(url, cached.bytes);
    return cached.bytes;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      headers: cached?.etag ? { "If-None-Match": cached.etag } : undefined,
    });
  } catch (err) {
    if (cached) {
      memCache.set(url, cached.bytes);
      return cached.bytes;
    }
    throw err;
  }

  if (response.status === 304 && cached) {
    memCache.set(url, cached.bytes);
    if (db) {
      void idbPut(db, { ...cached, fetchedAt: Date.now() });
    }
    return cached.bytes;
  }

  if (!response.ok) {
    if (cached) {
      memCache.set(url, cached.bytes);
      return cached.bytes;
    }
    throw new Error(`zkeyCache: ${url} -> ${response.status}`);
  }

  const bytes = await response.arrayBuffer();
  memCache.set(url, bytes);
  if (db) {
    // `void` (not `await`): the prove path needs `bytes` returned now.
    // Awaiting the IDB write would block 5-50 ms desktop / 50-200 ms
    // mobile for an 18 MB blob — directly between "bytes resolved" and
    // "prove starts". Worst case (tab closed mid-tx) is one missed
    // warm-cache opportunity next session, never a correctness loss.
    void idbPut(db, {
      url,
      bytes,
      etag: response.headers.get("ETag") ?? undefined,
      fetchedAt: Date.now(),
    });
  }
  return bytes;
}

function fetchCachedAssetBytes(rawUrl: string): Promise<ArrayBuffer> {
  // Dedup against the versioned key, not the raw URL — otherwise a
  // re-version mid-session (e.g. hot-reload after a redeploy) would
  // de-dup against the previous version's in-flight Promise and
  // hand stale bytes to the new fetch.
  const url = withAssetVersion(rawUrl);
  const existing = inflight.get(url);
  if (existing) return existing;
  const promise = fetchUncached(rawUrl).finally(() => inflight.delete(url));
  inflight.set(url, promise);
  return promise;
}

interface ResolvedAsset {
  url: string;
  revoke: () => void;
}

/** Discriminated result + explicit revoke so callers don't have to do
 *  reference equality against the canonical URL to decide whether the
 *  returned URL is a Blob alias. `revoke` is a no-op on the fallback
 *  path. */
async function resolveAsset(canonicalUrl: string): Promise<ResolvedAsset> {
  try {
    const bytes = await fetchCachedAssetBytes(canonicalUrl);
    const blobUrl = URL.createObjectURL(new Blob([bytes]));
    return { url: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) };
  } catch {
    return { url: canonicalUrl, revoke: () => {} };
  }
}

/** Best-effort prefetch — never throws so callers can
 *  `void prefetchAssets(...)` from a fire-and-forget context. */
export async function prefetchAssets(urls: readonly string[]): Promise<void> {
  await Promise.all(urls.map((u) => fetchCachedAssetBytes(u).catch(() => {})));
}

/** Resolve wasm + zkey to Blob URLs (or fall back to canonical), hand
 *  them to `run`, and revoke when `run` settles. `resolveAsset` always
 *  fulfils (errors fall back to the canonical URL with a no-op
 *  revoke), so a plain `Promise.all` is equivalent to and clearer than
 *  `Promise.allSettled` here. */
export async function withCachedAssets<T>(
  paths: { wasm: string; zkey: string },
  run: (urls: { wasm: string; zkey: string }) => Promise<T>,
): Promise<T> {
  const [wasm, zkey] = await Promise.all([
    resolveAsset(paths.wasm),
    resolveAsset(paths.zkey),
  ]);
  try {
    return await run({ wasm: wasm.url, zkey: zkey.url });
  } finally {
    wasm.revoke();
    zkey.revoke();
  }
}

/** Worker preload one-liner: resolves snarkjs + warms Poseidon +
 *  prefetches the circuit's wasm/zkey in parallel. Replaces the four
 *  near-identical preload bodies that lived in `*-worker.ts`. */
export async function warmProverAssets(paths: { wasm: string; zkey: string }): Promise<void> {
  await Promise.all([
    import("snarkjs"),
    warmupPoseidon(),
    prefetchAssets([paths.wasm, paths.zkey]),
  ]);
}
