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

  it("skips encrypted records when no decrypt is configured (no crash)", async () => {
    const enc = createIndexedDbNoteAdapter({ dbName: "skip", ...codec });
    await enc.put(makeNote());

    // decrypt omitted — can't read the envelope, so it's skipped, not thrown.
    const noDecrypt = createIndexedDbNoteAdapter({ dbName: "skip", encrypt: codec.encrypt });
    const all = await noDecrypt.loadAll();
    expect(all).toHaveLength(0);
  });

  it("still writes plaintext when no encrypt is configured (back-compat)", async () => {
    const plain = createIndexedDbNoteAdapter({ dbName: "plain" });
    await plain.put(makeNote());
    const raw = await rawGetAll("plain");
    expect(raw[0].noteHex).toBeDefined();
    expect(raw[0].enc).toBeUndefined();
  });
});
