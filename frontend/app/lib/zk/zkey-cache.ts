// IndexedDB-backed cache for the static `.wasm` / `.zkey` assets snarkjs
// loads via `groth16.fullProve(input, wasmUrl, zkeyUrl)`. The four
// circuits total ~28 MB on the wire — too big to rely on the browser
// HTTP cache surviving across tab-lifetime evictions. Falls back to the
// canonical URL on any cache failure (no IDB in private browsing,
// quota exceeded, network error with no cache, etc.).

const DB_NAME = "zk-asset-cache";
const STORE = "blobs";
const DB_VERSION = 1;
// Skip ETag revalidation while the cached entry is younger than this.
// Asset paths are not content-hashed, but a redeploy that ships new
// circuits in practice changes the filename (e.g. `_final.zkey` →
// `_v2.zkey`) so the staleness floor is effectively the deploy cadence.
const FRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface CachedEntry {
  url: string;
  bytes: ArrayBuffer;
  etag?: string;
  fetchedAt: number;
}

const memCache = new Map<string, ArrayBuffer>();
// In-flight dedup: a second caller arriving before a first fetch settles
// awaits the same Promise instead of kicking a parallel network request
// or duplicate IDB read. Critical for the prefetch-then-prove race —
// the worker preload starts a fetch, the user clicks, and the prover's
// `cachedAssetUrl` would otherwise hit memCache empty and refetch.
const inflight = new Map<string, Promise<ArrayBuffer>>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "url" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
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
  const memHit = memCache.get(url);
  if (memHit) return memHit;

  const db = await openDb();
  const cached = db ? await idbGet(db, url) : null;

  // Fast path: cached entry is fresh enough that revalidation would be
  // pure RTT waste.
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
    throw new Error(`zkey-cache: ${url} -> ${response.status}`);
  }

  const bytes = await response.arrayBuffer();
  memCache.set(url, bytes);
  if (db) {
    void idbPut(db, {
      url,
      bytes,
      etag: response.headers.get("ETag") ?? undefined,
      fetchedAt: Date.now(),
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

// Discriminated result + explicit revoke so callers don't have to do
// reference equality against the canonical URL to decide whether the
// returned URL is a Blob alias. `revoke` is a no-op on the fallback path.
async function resolveAsset(canonicalUrl: string): Promise<ResolvedAsset> {
  try {
    const bytes = await fetchCachedAssetBytes(canonicalUrl);
    const blobUrl = URL.createObjectURL(new Blob([bytes]));
    return { url: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) };
  } catch {
    return { url: canonicalUrl, revoke: () => {} };
  }
}

// Best-effort prefetch — never throws so callers can `void prefetchAssets(...)`.
export async function prefetchAssets(urls: readonly string[]): Promise<void> {
  await Promise.all(urls.map((u) => fetchCachedAssetBytes(u).catch(() => {})));
}

// Resolve wasm + zkey to Blob URLs (or fall back to canonical), hand
// them to `run`, and revoke when `run` settles.
export async function withCachedAssets<T>(
  paths: { wasm: string; zkey: string },
  run: (urls: { wasm: string; zkey: string }) => Promise<T>,
): Promise<T> {
  // Resolve in parallel but track each independently so a mid-Promise.all
  // throw on one side still lets us revoke the other.
  const results = await Promise.allSettled([
    resolveAsset(paths.wasm),
    resolveAsset(paths.zkey),
  ]);
  const settled = results.map((r) => (r.status === "fulfilled" ? r.value : null));
  const wasm = settled[0] ?? { url: paths.wasm, revoke: () => {} };
  const zkey = settled[1] ?? { url: paths.zkey, revoke: () => {} };
  try {
    return await run({ wasm: wasm.url, zkey: zkey.url });
  } finally {
    wasm.revoke();
    zkey.revoke();
  }
}

// Worker preload one-liner: resolves snarkjs + warms Poseidon + prefetches
// the circuit's wasm/zkey in parallel. Replaces the four near-identical
// preload bodies that lived in `*-worker.ts`.
export async function warmProverAssets(paths: { wasm: string; zkey: string }): Promise<void> {
  const { warmupPoseidon } = await import("./commitment");
  await Promise.all([
    import("snarkjs"),
    warmupPoseidon(),
    prefetchAssets([paths.wasm, paths.zkey]),
  ]);
}
