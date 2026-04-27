import type { NoteStorageAdapter, StoredNote } from "./types";
import { openIDB } from "../util/idb";

const DEFAULT_DB_NAME = "zkscatter-notes";
const DEFAULT_STORE = "notes";
const DEFAULT_VERSION = 1;

export interface IndexedDbAdapterOpts {
  /** Database name. Apps that want to isolate notes per network /
   *  account should encode the discriminator into this name. */
  dbName?: string;
  storeName?: string;
  version?: number;
}

interface WireNote {
  id: string;
  label: string;
  symbol: string;
  amount: string;
  noteHex: {
    ownerSecret: string;
    token: string;
    amount: string;
    salt: string;
    pubKeyAx: string;
    pubKeyAy: string;
  };
  commitmentHex: string;
  leafIndex: number;
  txHash?: string;
  chainId?: number;
  createdAt: number;
}

function toHex(v: bigint): string {
  return "0x" + v.toString(16);
}

function serialize(n: StoredNote): WireNote {
  return {
    id: n.id,
    label: n.label,
    symbol: n.symbol,
    amount: n.amount,
    noteHex: {
      ownerSecret: toHex(n.note.ownerSecret),
      token: toHex(n.note.token),
      amount: toHex(n.note.amount),
      salt: toHex(n.note.salt),
      pubKeyAx: toHex(n.note.pubKeyAx),
      pubKeyAy: toHex(n.note.pubKeyAy),
    },
    commitmentHex: toHex(n.commitment),
    leafIndex: n.leafIndex,
    txHash: n.txHash,
    chainId: n.chainId,
    createdAt: n.createdAt,
  };
}

function deserialize(w: WireNote): StoredNote {
  return {
    id: w.id,
    label: w.label,
    symbol: w.symbol,
    amount: w.amount,
    note: {
      ownerSecret: BigInt(w.noteHex.ownerSecret),
      token: BigInt(w.noteHex.token),
      amount: BigInt(w.noteHex.amount),
      salt: BigInt(w.noteHex.salt),
      pubKeyAx: BigInt(w.noteHex.pubKeyAx),
      pubKeyAy: BigInt(w.noteHex.pubKeyAy),
    },
    commitment: BigInt(w.commitmentHex),
    leafIndex: w.leafIndex,
    txHash: w.txHash,
    chainId: w.chainId,
    createdAt: w.createdAt,
  };
}

/** IndexedDB-backed note storage. Uses a single object store keyed
 *  by `note.id`. Survives page reload + browser restart. Falls back
 *  to in-memory state on platforms without IDB (private-mode quotas,
 *  SSR, broken handles) — failures don't surface to the caller, but
 *  are logged once per session.
 *
 *  ## Security model (read before relying on this in production)
 *
 *  This adapter persists `note.ownerSecret`, `note.salt`, and
 *  `note.amount` **as plaintext hex** in the browser's IndexedDB.
 *  Any JavaScript that runs on the same origin (including
 *  cross-site-scripting, malicious extensions, dev-tools usage by
 *  anyone with physical device access) can read this material.
 *
 *  The protocol mitigates leak-only attacks via the v2 commitment
 *  binding: spending the note also requires the EdDSA private key
 *  bound into the commitment, which apps store **encrypted** under
 *  a wallet-derived passphrase. So an IDB read alone cannot move
 *  funds. But it does leak the link between the note and the
 *  user's other on-chain activity (defeating the privacy goal).
 *
 *  A future PR adds an optional `encrypt` / `decrypt` pair to the
 *  adapter opts (matching the existing EdDSA key encryption flow)
 *  so callers can opt into encryption-at-rest. Until then, treat
 *  IDB as semi-trusted storage and rely on the EdDSA key
 *  encryption + on-chain nullifier checks to prevent fund theft. */
export function createIndexedDbNoteAdapter(
  opts: IndexedDbAdapterOpts = {},
): NoteStorageAdapter {
  const dbName = opts.dbName ?? DEFAULT_DB_NAME;
  const storeName = opts.storeName ?? DEFAULT_STORE;
  const version = opts.version ?? DEFAULT_VERSION;

  // Memory tier mirrors IDB so reads after a write don't have to wait
  // for the read transaction. On boot we populate from IDB; from then
  // on each `put`/`remove` updates both tiers.
  const mem = new Map<string, StoredNote>();
  let warnedOnce = false;
  let dbPromise: Promise<IDBDatabase | null> | null = null;
  let readyPromise: Promise<void> | null = null;

  function warnOnce(reason: string, err?: unknown): void {
    if (warnedOnce) return;
    warnedOnce = true;
    // eslint-disable-next-line no-console
    console.warn(`[zkscatter notes] ${reason} — falling back to in-memory state`, err);
  }

  function openDb(): Promise<IDBDatabase | null> {
    if (dbPromise) return dbPromise;
    dbPromise = openIDB({
      dbName,
      version,
      stores: [{ name: storeName, keyPath: "id" }],
      onWarn: warnOnce,
    });
    return dbPromise;
  }

  async function loadIntoMem(db: IDBDatabase): Promise<void> {
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => {
        const wire = (req.result ?? []) as WireNote[];
        for (const w of wire) {
          try {
            const n = deserialize(w);
            mem.set(n.id, n);
          } catch (e) {
            warnOnce(`skipping malformed note ${w.id ?? "<no id>"}`, e);
          }
        }
        resolve();
      };
      req.onerror = () => {
        warnOnce("loadAll readonly tx errored", req.error);
        resolve();
      };
    });
  }

  function ready(): Promise<void> {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      const db = await openDb();
      if (db) await loadIntoMem(db);
    })();
    return readyPromise;
  }

  return {
    ready,

    async loadAll() {
      await ready();
      return Array.from(mem.values()).sort((a, b) => a.createdAt - b.createdAt);
    },

    async put(note) {
      await ready();
      mem.set(note.id, note);
      const db = await openDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(serialize(note));
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          warnOnce("put tx errored", tx.error);
          resolve();
        };
        tx.onabort = () => resolve();
      });
    },

    async remove(id) {
      await ready();
      mem.delete(id);
      const db = await openDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          warnOnce("remove tx errored", tx.error);
          resolve();
        };
        tx.onabort = () => resolve();
      });
    },

    async clear() {
      await ready();
      mem.clear();
      const db = await openDb();
      if (!db) return;
      await new Promise<void>((resolve) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => {
          warnOnce("clear tx errored", tx.error);
          resolve();
        };
        tx.onabort = () => resolve();
      });
    },
  };
}
