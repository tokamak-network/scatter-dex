// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { openIDB } from "../../src/util/idb";

// Fresh in-memory IDB per test so store contents and version state
// can't leak across cases. The fake-indexeddb package ships its own
// factory class — we install it on the global before each test and
// restore the (usually absent) original after.
let originalIDB: typeof globalThis.indexedDB | undefined;

beforeEach(() => {
  originalIDB = globalThis.indexedDB;
  Object.defineProperty(globalThis, "indexedDB", {
    value: new IDBFactory(),
    configurable: true,
  });
});

afterEach(() => {
  if (originalIDB === undefined) {
    // Restore to "unavailable" so the SSR-guard test downstream
    // still has a deterministic baseline if it overrides too.
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
  } else {
    Object.defineProperty(globalThis, "indexedDB", {
      value: originalIDB,
      configurable: true,
    });
  }
});

describe("openIDB", () => {
  it("opens a database and creates the requested object stores", async () => {
    const db = await openIDB({
      dbName: "test-db",
      version: 1,
      stores: [{ name: "notes", keyPath: "id" }],
    });
    expect(db).not.toBeNull();
    expect(db!.objectStoreNames.contains("notes")).toBe(true);
    db!.close();
  });

  it("creates multiple stores in one upgrade", async () => {
    const db = await openIDB({
      dbName: "multi-store-db",
      version: 1,
      stores: [
        { name: "notes", keyPath: "id" },
        { name: "claims", keyPath: "nullifier" },
      ],
    });
    expect(db!.objectStoreNames.contains("notes")).toBe(true);
    expect(db!.objectStoreNames.contains("claims")).toBe(true);
    db!.close();
  });

  it("is idempotent across same-version re-opens", async () => {
    const a = await openIDB({
      dbName: "idem-db",
      version: 1,
      stores: [{ name: "notes", keyPath: "id" }],
    });
    a!.close();

    const b = await openIDB({
      dbName: "idem-db",
      version: 1,
      stores: [{ name: "notes", keyPath: "id" }],
    });
    expect(b).not.toBeNull();
    expect(b!.objectStoreNames.contains("notes")).toBe(true);
    b!.close();
  });

  it("adds new stores on a version bump", async () => {
    const v1 = await openIDB({
      dbName: "bump-db",
      version: 1,
      stores: [{ name: "notes", keyPath: "id" }],
    });
    v1!.close();

    const v2 = await openIDB({
      dbName: "bump-db",
      version: 2,
      stores: [
        { name: "notes", keyPath: "id" },
        { name: "claims", keyPath: "nullifier" },
      ],
    });
    expect(v2!.objectStoreNames.contains("notes")).toBe(true);
    expect(v2!.objectStoreNames.contains("claims")).toBe(true);
    v2!.close();
  });

  it("returns null and calls onWarn when indexedDB is unavailable", async () => {
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    const onWarn = vi.fn();
    const db = await openIDB({
      dbName: "unavailable-db",
      version: 1,
      stores: [{ name: "notes", keyPath: "id" }],
      onWarn,
    });
    expect(db).toBeNull();
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringContaining("indexedDB unavailable"),
    );
  });

  it("returns null and calls onWarn when indexedDB.open synchronously throws", async () => {
    Object.defineProperty(globalThis, "indexedDB", {
      value: {
        open() {
          throw new Error("synchronous boom");
        },
      },
      configurable: true,
    });
    const onWarn = vi.fn();
    const db = await openIDB({
      dbName: "throw-db",
      version: 1,
      stores: [{ name: "notes", keyPath: "id" }],
      onWarn,
    });
    expect(db).toBeNull();
    expect(onWarn).toHaveBeenCalledWith(
      "indexedDB.open threw",
      expect.any(Error),
    );
  });

  it("returns null and calls onWarn when the open request errors asynchronously", async () => {
    // Stub a factory whose open() returns a request that fires onerror
    // after a microtask — exercises the async error path that the SSR
    // guard alone can't reach.
    const fakeReq: Partial<IDBOpenDBRequest> & {
      result: unknown;
      error: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onupgradeneeded: (() => void) | null;
      onblocked: (() => void) | null;
    } = {
      result: null,
      error: new Error("async open failure"),
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
      onblocked: null,
    };
    Object.defineProperty(globalThis, "indexedDB", {
      value: {
        open() {
          queueMicrotask(() => fakeReq.onerror?.());
          return fakeReq as IDBOpenDBRequest;
        },
      },
      configurable: true,
    });
    const onWarn = vi.fn();
    const db = await openIDB({
      dbName: "err-db",
      version: 1,
      stores: [{ name: "notes", keyPath: "id" }],
      onWarn,
    });
    expect(db).toBeNull();
    expect(onWarn).toHaveBeenCalledWith(
      "indexedDB.open errored",
      expect.any(Error),
    );
  });
});
