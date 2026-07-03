import type { NoteStorageAdapter, StoredNote } from "./types";
import { openIDB } from "../util/idb";
import {
  bigintToHex,
  notePreimageFromHex,
  notePreimageToHex,
  type NotePreimageHex,
} from "../util/format";

const DEFAULT_DB_NAME = "zkscatter-notes";
const DEFAULT_STORE = "notes";
const DEFAULT_VERSION = 1;

export interface IndexedDbAdapterOpts {
  /** Database name. Apps that want to isolate notes per network /
   *  account should encode the discriminator into this name. */
  dbName?: string;
  storeName?: string;
  version?: number;
  /** Optional encryption-at-rest. When BOTH are provided, each note's
   *  sensitive payload (the preimage — `ownerSecret` + `salt` — plus
   *  `amount` and metadata) is encrypted before it is written to IndexedDB
   *  and decrypted on load; only the record `id` (the key path) stays in
   *  clear. A same-origin XSS / malicious extension / device-access read of
   *  IDB then yields ciphertext instead of spendable-linkable secrets.
   *
   *  The app supplies the crypto — e.g. WebCrypto AES-GCM under a key derived
   *  from a wallet signature — so the SDK stays crypto-agnostic and the key
   *  lives in the app's control (mirroring the EdDSA-key encryption flow).
   *  Must round-trip: `await decrypt(await encrypt(s))` deep-equals `s`.
   *
   *  Back-compat / migration: with no `encrypt`, records are written as
   *  plaintext (previous behaviour). Legacy plaintext records already in IDB
   *  are read transparently and re-written encrypted on their next `put`.
   *  If `decrypt` is absent but encrypted records exist, they are skipped
   *  (logged once) rather than crashing the load. */
  encrypt?: (plaintext: string) => Promise<string>;
  decrypt?: (ciphertext: string) => Promise<string>;
}

/** On-disk shape when encryption is enabled: everything except the key path
 *  is opaque. `v` marks the envelope version for forward migration. */
interface EncryptedRecord {
  id: string;
  enc: string;
  v: 1;
}

function isEncryptedRecord(rec: unknown): rec is EncryptedRecord {
  if (typeof rec !== "object" || rec === null) return false;
  const r = rec as { id?: unknown; enc?: unknown; v?: unknown };
  // Require the full envelope (id + enc + v===1) so an arbitrary object with
  // an `enc` field isn't misclassified, and the version gate stays meaningful
  // for forward migration.
  return typeof r.id === "string" && typeof r.enc === "string" && r.v === 1;
}

interface WireNote {
  id: string;
  label: string;
  symbol: string;
  amount: string;
  noteHex: NotePreimageHex;
  commitmentHex: string;
  leafIndex: number;
  status?: "failed";
  failedAt?: number;
  txHash?: string;
  chainId?: number;
  /** Mirrors the folder adapter so a record migrated between the two
   *  backends round-trips its wallet attribution. The IDB DB-name is
   *  already per-account so reads stay isolated regardless. */
  account?: string;
  createdAt: number;
}

function serialize(n: StoredNote): WireNote {
  return {
    id: n.id,
    label: n.label,
    symbol: n.symbol,
    amount: n.amount,
    noteHex: notePreimageToHex(n.note),
    commitmentHex: bigintToHex(n.commitment),
    leafIndex: n.leafIndex,
    status: n.status,
    failedAt: n.failedAt,
    txHash: n.txHash,
    chainId: n.chainId,
    account: n.account,
    createdAt: n.createdAt,
  };
}

function deserialize(w: WireNote): StoredNote {
  return {
    id: w.id,
    label: w.label,
    symbol: w.symbol,
    amount: w.amount,
    note: notePreimageFromHex(w.noteHex),
    commitment: BigInt(w.commitmentHex),
    leafIndex: w.leafIndex,
    status: w.status,
    failedAt: w.failedAt,
    txHash: w.txHash,
    chainId: w.chainId,
    account: w.account,
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
 *  By default this adapter persists `note.ownerSecret`, `note.salt`, and
 *  `note.amount` **as plaintext hex** in the browser's IndexedDB. Any
 *  JavaScript on the same origin (stored XSS, malicious extensions, dev-tools
 *  by anyone with device access) can then read this material. It does not
 *  move funds on its own — spending also requires the EdDSA private key bound
 *  into the v2 commitment (which apps store encrypted) — but it DOES leak the
 *  link between the note and the user's other on-chain activity, defeating
 *  the privacy goal.
 *
 *  Pass `encrypt` / `decrypt` in {@link IndexedDbAdapterOpts} to opt into
 *  encryption-at-rest: the sensitive payload is stored as ciphertext and only
 *  the record `id` remains in clear. The app owns the crypto + key (e.g.
 *  WebCrypto AES-GCM under a wallet-signature-derived key), matching the
 *  EdDSA-key encryption flow. With encryption enabled, an IDB read yields no
 *  preimage/amount. Without it, treat IDB as semi-trusted storage. */
export function createIndexedDbNoteAdapter(
  opts: IndexedDbAdapterOpts = {},
): NoteStorageAdapter {
  const dbName = opts.dbName ?? DEFAULT_DB_NAME;
  const storeName = opts.storeName ?? DEFAULT_STORE;
  const version = opts.version ?? DEFAULT_VERSION;
  const { encrypt, decrypt } = opts;

  /** Serialize a note to the on-disk record — encrypted envelope when
   *  `encrypt` is configured, plaintext WireNote otherwise. */
  async function toRecord(note: StoredNote): Promise<WireNote | EncryptedRecord> {
    const wire = serialize(note);
    // Require BOTH halves to encrypt: writing encrypted with no `decrypt`
    // configured would create a write-only record that can never be read back.
    if (!encrypt || !decrypt) return wire;
    return { id: note.id, enc: await encrypt(JSON.stringify(wire)), v: 1 };
  }

  // Separate one-shot flag for the benign "encrypted rows but this adapter
  // has no decrypt" case — it's expected (a decrypt-less reader), not a
  // fallback, so it must NOT consume the `warnOnce` budget or claim we fell
  // back to in-memory state.
  let warnedNoDecrypt = false;
  function warnNoDecryptOnce(): void {
    if (warnedNoDecrypt) return;
    warnedNoDecrypt = true;
    // eslint-disable-next-line no-console
    console.warn("[zkscatter notes] encrypted note(s) present but no decrypt configured — skipping them (not an error)");
  }

  /** Recover a WireNote from an on-disk record. Returns null (skipping the
   *  record) when it's encrypted but unreadable/tampered. */
  async function recordToWire(rec: unknown): Promise<WireNote | null> {
    if (isEncryptedRecord(rec)) {
      if (!decrypt) {
        warnNoDecryptOnce();
        return null;
      }
      const wire = JSON.parse(await decrypt(rec.enc)) as WireNote;
      // Bind the ciphertext to its key path: a decrypted `id` that doesn't
      // match the record's `id` means a corrupted or swapped/tampered blob —
      // skip rather than trust it.
      if (wire.id !== rec.id) {
        warnOnce(`decrypted note id mismatch (key ${rec.id}) — skipping possibly-tampered record`);
        return null;
      }
      return wire;
    }
    return rec as WireNote;
  }

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

  function getAllRecords(db: IDBDatabase): Promise<unknown[]> {
    return new Promise((resolve) => {
      const tx = db.transaction(storeName, "readonly");
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve((req.result ?? []) as unknown[]);
      req.onerror = () => {
        warnOnce("loadAll readonly tx errored", req.error);
        resolve([]);
      };
    });
  }

  async function loadIntoMem(db: IDBDatabase): Promise<void> {
    // Read all rows in one IDB tx, THEN decrypt/deserialize outside it —
    // per-record `await decrypt(...)` can't run inside an IDB transaction
    // (the tx auto-commits on the first microtask that yields).
    const records = await getAllRecords(db);
    for (const rec of records) {
      const id = (rec as { id?: unknown } | null)?.id;
      try {
        const wire = await recordToWire(rec);
        if (!wire) continue; // encrypted record but no decrypt configured
        const n = deserialize(wire);
        mem.set(n.id, n);
      } catch (e) {
        warnOnce(`skipping malformed note ${typeof id === "string" ? id : "<no id>"}`, e);
      }
    }
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
      // Encrypt (if configured) BEFORE opening the write tx — an `await`
      // inside the tx would auto-commit it before the put lands.
      const record = await toRecord(note);
      await new Promise<void>((resolve) => {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(record);
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
