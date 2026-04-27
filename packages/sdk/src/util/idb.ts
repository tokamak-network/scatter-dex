/** Tiny IndexedDB open helper. Centralises the SSR / undefined-env
 *  guard, the open-call try/catch, and the success/error promise
 *  wiring that `zkeyCache` and `notes/indexedDbAdapter` had each
 *  rolled themselves. Returns `null` (not throws) when IDB isn't
 *  available — callers are expected to gracefully degrade to an
 *  in-memory tier. */

interface OpenIDBOptions {
  /** IDB database name. */
  dbName: string;
  /** Schema version. Bump when `objectStores` changes shape. */
  version: number;
  /** Object store schema applied inside `onupgradeneeded`. Each
   *  entry creates the store if missing (idempotent across versions
   *  that re-declare the same store). Removal or modification of
   *  existing stores is intentionally not supported here — bump
   *  `version` and handle the migration in a custom opener. */
  stores: ReadonlyArray<{
    name: string;
    /** Field on stored records used as the primary key. autoIncrement
     *  / secondary indexes / multi-field keys aren't covered — drop
     *  to a custom opener if you need them. */
    keyPath: string;
  }>;
  /** Optional sink for `console.warn` flavoured failure context.
   *  Invoked independently on each failure path (open threw,
   *  unavailable runtime, async error) — this helper does not
   *  dedupe. Callers that re-call `openIDB` need to wire their
   *  own one-shot wrapper if they want a single warning per
   *  process lifetime. */
  onWarn?: (reason: string, err?: unknown) => void;
}

/** Open (or create) an IndexedDB database. The returned promise
 *  resolves to `null` when:
 *    - `indexedDB` is undefined (SSR / older runtimes / Node)
 *    - `indexedDB.open()` synchronously throws (rare; some Safari
 *      private modes)
 *    - the open request errors asynchronously
 *  In all those cases the caller should fall back to whatever
 *  in-memory tier it carries instead of bubbling the failure. */
export function openIDB(opts: OpenIDBOptions): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      opts.onWarn?.("indexedDB unavailable in this runtime");
      resolve(null);
      return;
    }
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(opts.dbName, opts.version);
    } catch (e) {
      opts.onWarn?.("indexedDB.open threw", e);
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of opts.stores) {
        if (!db.objectStoreNames.contains(s.name)) {
          db.createObjectStore(s.name, { keyPath: s.keyPath });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opts.onWarn?.("indexedDB.open errored", req.error);
      resolve(null);
    };
  });
}
