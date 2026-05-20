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
 *  Acts as a belt-and-braces fallback when `NEXT_PUBLIC_ZK_ASSETS_VERSION`
 *  is unset — the version field on the cache row is the primary
 *  invalidation signal (see `ASSET_VERSION` below). */
const FRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Build-time snapshot of the deploy's asset version, read from
 *  `NEXT_PUBLIC_ZK_ASSETS_VERSION` (dev.sh + start-e2e-env.sh write
 *  this from the deposit zkey's content hash on every deploy). Used
 *  as a record-field invalidation marker on every cached entry: a
 *  row whose `assetVersion` doesn't match the current build is
 *  treated as a miss on read, the in-place `put` overwrites it with
 *  the fresh fetch, and the IndexedDB store stays bounded at one
 *  row per canonical URL. Without this the cache row could grow
 *  unbounded across deploys (each version-tagged URL would create a
 *  new row that nothing prunes). */
const ASSET_VERSION: string | null = (() => {
  const v = process.env.NEXT_PUBLIC_ZK_ASSETS_VERSION;
  return v && v.length > 0 ? v : null;
})();

/** Decorate the canonical URL with the current asset version for
 *  the actual network fetch — the IDB key stays canonical so a
 *  redeploy overwrites the same row, but the fetch URL changes so
 *  HTTP / CDN caches also bust. No-op when the version env isn't
 *  set or the caller already attached its own `v=` param. */
function fetchUrlWithVersion(url: string): string {
  if (!ASSET_VERSION) return url;
  if (/[?&]v=/.test(url)) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${ASSET_VERSION}`;
}

interface CachedEntry {
  url: string;
  bytes: ArrayBuffer;
  etag?: string;
  fetchedAt: number;
  /** Snapshot of `NEXT_PUBLIC_ZK_ASSETS_VERSION` at the time the
   *  bytes were stored. A mismatch with the current `ASSET_VERSION`
   *  causes the cache to treat the row as a miss, overwriting it
   *  on the next fetch — single row per canonical URL, bounded
   *  storage growth across deploys. Optional so existing rows
   *  written before this field shipped (already in real users'
   *  IDBs) still read cleanly as `undefined` → mismatch on a
   *  versioned build → graceful refetch. */
  assetVersion?: string | null;
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

async function fetchUncached(url: string): Promise<ArrayBuffer> {
  // Cache key is the canonical URL — one row per asset, no
  // unbounded growth across deploys. Version mismatch is handled
  // via the `assetVersion` field check below, not via key churn.
  const memHit = memCache.get(url);
  if (memHit) return memHit;

  const db = await openDb();
  const cached = db ? await idbGet(db, url) : null;

  const cacheFresh =
    cached !== null &&
    cached.assetVersion === ASSET_VERSION &&
    Date.now() - cached.fetchedAt < FRESH_TTL_MS;

  if (cached && cacheFresh) {
    memCache.set(url, cached.bytes);
    return cached.bytes;
  }

  // Append the version to the actual network fetch so HTTP / CDN
  // caches also see a fresh URL on a redeploy. The IDB key stays
  // canonical — `put` below overwrites the same row in place.
  const fetchUrl = fetchUrlWithVersion(url);

  let response: Response;
  try {
    response = await fetch(fetchUrl, {
      // Skip the ETag revalidation header when the cached row is
      // version-mismatched: the bytes on disk belong to a previous
      // deploy and ETag matching against them would return a 304
      // that points the cache back at stale bytes. Only allow ETag
      // when the version matches and the TTL alone is what made us
      // re-check.
      headers:
        cached?.etag && cached.assetVersion === ASSET_VERSION
          ? { "If-None-Match": cached.etag }
          : undefined,
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
    throw new Error(`zkeyCache: ${fetchUrl} -> ${response.status}`);
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
      assetVersion: ASSET_VERSION,
    });
  }
  return bytes;
}

function fetchCachedAssetBytes(url: string): Promise<ArrayBuffer> {
  const existing = inflight.get(url);
  if (existing) return existing;
  const promise = fetchUncached(url).finally(() => inflight.delete(url));
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
