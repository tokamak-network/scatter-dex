// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createIndexedDbNoteAdapter } from "../../src/notes/indexedDbAdapter";
import { openIDB } from "../../src/util/idb";
import type { StoredNote } from "../../src/notes/types";

// Fresh in-memory IDB per test (same pattern as util/idb.test.ts).
let originalIDB: typeof globalThis.indexedDB | undefined;
beforeEach(() => {
  originalIDB = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", { value: new IDBFactory(), configurable: true });
});
afterEach(() => {
  if (originalIDB === undefined) delete (globalThis as { indexedDB?: unknown }).indexedDB;
  else Object.defineProperty(globalThis, "indexedDB", { value: originalIDB, configurable: true });
});

function makeNote(over: Partial<StoredNote> = {}): StoredNote {
  return {
    id: "note-1",
    label: "lot-1",
    symbol: "USDC",
    amount: "1000000",
    note: { ownerSecret: 111n, token: 222n, amount: 1000000n, salt: 333n, pubKeyAx: 444n, pubKeyAy: 555n },
    commitment: 999n,
    leafIndex: 7,
    createdAt: 1,
    ...over,
  };
}

// Trivial reversible codec standing in for the app's real crypto.
const codec = {
  encrypt: async (s: string) => "b64:" + Buffer.from(s, "utf8").toString("base64"),
  decrypt: async (s: string) => Buffer.from(s.replace(/^b64:/, ""), "base64").toString("utf8"),
};

/** Read the raw on-disk records, bypassing the adapter's decrypt. */
async function rawGetAll(dbName: string): Promise<Record<string, unknown>[]> {
  const db = await openIDB({ dbName, version: 1, stores: [{ name: "notes", keyPath: "id" }] });
  if (!db) return [];
  return new Promise((resolve) => {
    const req = db.transaction("notes", "readonly").objectStore("notes").getAll();
    req.onsuccess = () => resolve((req.result ?? []) as Record<string, unknown>[]);
    req.onerror = () => resolve([]);
  });
}

/** Write a raw record straight into the store (to plant a tampered row). */
async function rawPut(dbName: string, rec: Record<string, unknown>): Promise<void> {
  const db = await openIDB({ dbName, version: 1, stores: [{ name: "notes", keyPath: "id" }] });
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction("notes", "readwrite");
    tx.objectStore("notes").put(rec);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

describe("IndexedDbNoteAdapter encryption-at-rest", () => {
  it("stores only ciphertext at rest and round-trips through decrypt", async () => {
    const a = createIndexedDbNoteAdapter({ dbName: "enc", ...codec });
    await a.put(makeNote());

    // A fresh adapter on the same DB reads the note back, decrypted.
    const b = createIndexedDbNoteAdapter({ dbName: "enc", ...codec });
    const all = await b.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0].note.ownerSecret).toBe(111n);
    expect(all[0].note.salt).toBe(333n);
    expect(all[0].amount).toBe("1000000");

    // At rest: no plaintext note fields — only id + opaque envelope.
    const raw = await rawGetAll("enc");
    expect(raw).toHaveLength(1);
    expect(Object.keys(raw[0]).sort()).toEqual(["enc", "id", "v"]);
    expect(raw[0].enc as string).toMatch(/^b64:/);
    // The preimage hex must not appear anywhere in the stored record.
    expect(JSON.stringify(raw[0])).not.toContain("noteHex");
  });

  it("transparently reads legacy plaintext records and re-encrypts on next put", async () => {
    // Write a plaintext record via a no-encrypt adapter (pre-encryption state).
    const legacy = createIndexedDbNoteAdapter({ dbName: "mig" });
    await legacy.put(makeNote());
    const rawBefore = await rawGetAll("mig");
    expect(rawBefore[0].noteHex).toBeDefined(); // plaintext preimage present

    // Open with encryption enabled — the legacy record still loads.
    const enc = createIndexedDbNoteAdapter({ dbName: "mig", ...codec });
    const loaded = await enc.loadAll();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].note.ownerSecret).toBe(111n);

    // Re-put migrates it to the encrypted envelope.
    await enc.put(loaded[0]);
    const rawAfter = await rawGetAll("mig");
    expect(Object.keys(rawAfter[0]).sort()).toEqual(["enc", "id", "v"]);
  });

  it("skips encrypted records when the reader has no decrypt (no crash)", async () => {
    // Written encrypted by a properly-configured adapter...
    const enc = createIndexedDbNoteAdapter({ dbName: "skip", ...codec });
    await enc.put(makeNote());
    expect(Object.keys((await rawGetAll("skip"))[0]).sort()).toEqual(["enc", "id", "v"]);

    // ...then opened by an adapter with no decrypt — it skips them, no throw.
    const noDecrypt = createIndexedDbNoteAdapter({ dbName: "skip" });
    const all = await noDecrypt.loadAll();
    expect(all).toHaveLength(0);
  });

  it("skips a record whose decrypted id doesn't match the key path (tamper/corruption)", async () => {
    // Plant an envelope keyed "note-1" whose ciphertext decrypts to id "evil".
    const wire = {
      id: "evil", label: "l", symbol: "S", amount: "1",
      noteHex: {} as unknown, commitmentHex: "0x0", leafIndex: 0, createdAt: 1,
    };
    const enc = await codec.encrypt(JSON.stringify(wire));
    await rawPut("tamper", { id: "note-1", enc, v: 1 });

    const a = createIndexedDbNoteAdapter({ dbName: "tamper", ...codec });
    const all = await a.loadAll();
    expect(all).toHaveLength(0); // id mismatch → skipped, not trusted
  });

  it("refuses to encrypt when only encrypt (no decrypt) is configured — avoids write-only records", async () => {
    // encrypt without decrypt would be a footgun (write-only); the adapter
    // falls back to plaintext so the note stays readable.
    const encOnly = createIndexedDbNoteAdapter({ dbName: "enc-only", encrypt: codec.encrypt });
    await encOnly.put(makeNote());
    const raw = await rawGetAll("enc-only");
    expect(raw[0].noteHex).toBeDefined();
    expect(raw[0].enc).toBeUndefined();
  });

  it("still writes plaintext when no encrypt is configured (back-compat)", async () => {
    const plain = createIndexedDbNoteAdapter({ dbName: "plain" });
    await plain.put(makeNote());
    const raw = await rawGetAll("plain");
    expect(raw[0].noteHex).toBeDefined();
    expect(raw[0].enc).toBeUndefined();
  });
});
