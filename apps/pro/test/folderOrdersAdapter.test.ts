// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createFolderOrdersAdapter,
  type OrderRecord,
  type OrdersAdapterIO,
} from "../app/lib/orders";

function fixture(overrides: Partial<OrderRecord> = {}): OrderRecord {
  const claim = {
    secret: 0xc0ffee1234abcdefn,
    recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    token: "0x8a791620dd6260079bf849dc5567adc3f2fdc318",
    amount: (10n ** 18n) * 4205n,
    releaseTime: 1747930000n,
    leafIndex: 0,
    claimsRoot: "0x0000000000000000000000000000000000000000000000000000000000000abc",
  };
  return {
    id: "ord-id-1",
    label: "ord-3",
    side: "sell",
    pair: "ETH/USDC",
    price: "4,205",
    size: "1.0",
    status: "matching",
    nonce: 0xdeadbeefn,
    noteId: "note-abc",
    createdAt: 1747929600_000,
    claim,
    claims: [claim],
    ...overrides,
  };
}

interface FakeFs extends OrdersAdapterIO {
  files: Map<string, string>;
  listCalls: number;
  loadCalls: number;
  saveCalls: number;
  removeCalls: number;
}

function fakeFs(): FakeFs {
  const files = new Map<string, string>();
  const fs: FakeFs = {
    files,
    listCalls: 0,
    loadCalls: 0,
    saveCalls: 0,
    removeCalls: 0,
    listFiles: async (matches) => {
      fs.listCalls++;
      return Array.from(files.entries())
        .filter(([name]) => matches(name))
        .map(([name, content]) => ({
          filename: name,
          read: async () => content,
        }));
    },
    loadFile: async (name) => {
      fs.loadCalls++;
      return files.get(name) ?? null;
    },
    saveFile: async (name, content) => {
      fs.saveCalls++;
      files.set(name, content);
    },
    removeFile: async (name) => {
      fs.removeCalls++;
      files.delete(name);
    },
  };
  return fs;
}

const ACCT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("createFolderOrdersAdapter", () => {
  it("writes one file per order under the (chain, account, id) name", async () => {
    const fs = fakeFs();
    const a = createFolderOrdersAdapter(31337, ACCT, fs);
    await a.put(fixture({ id: "alpha" }));
    await a.put(fixture({ id: "beta", label: "ord-4" }));
    expect(Array.from(fs.files.keys()).sort()).toEqual([
      `zkscatter-pro-order-31337-${ACCT}-alpha.json`,
      `zkscatter-pro-order-31337-${ACCT}-beta.json`,
    ]);
  });

  it("round-trips a fully populated order through JSON without precision loss", async () => {
    const fs = fakeFs();
    const writer = createFolderOrdersAdapter(31337, ACCT, fs);
    const order = fixture();
    await writer.put(order);

    const reader = createFolderOrdersAdapter(31337, ACCT, fs);
    const loaded = await reader.loadAll();
    expect(loaded).toEqual([order]);
    expect(loaded[0]!.claim!.secret).toBe(order.claim!.secret);
    expect(loaded[0]!.claim!.amount).toBe(order.claim!.amount);
    expect(loaded[0]!.nonce).toBe(order.nonce);
  });

  it("put with an existing id replaces just that file (no rewrite of siblings)", async () => {
    const fs = fakeFs();
    const a = createFolderOrdersAdapter(31337, ACCT, fs);
    await a.put(fixture({ id: "alpha", status: "matching" }));
    await a.put(fixture({ id: "beta", status: "matching" }));
    fs.saveCalls = 0;
    await a.put(fixture({ id: "alpha", status: "claimed" }));
    expect(fs.saveCalls).toBe(1);

    const reloaded = await createFolderOrdersAdapter(31337, ACCT, fs).loadAll();
    const byId = new Map(reloaded.map((o) => [o.id, o]));
    expect(byId.get("alpha")!.status).toBe("claimed");
    expect(byId.get("beta")!.status).toBe("matching");
  });

  it("loadAll returns orders sorted by createdAt asc", async () => {
    const fs = fakeFs();
    const a = createFolderOrdersAdapter(31337, ACCT, fs);
    await a.put(fixture({ id: "a", createdAt: 2000 }));
    await a.put(fixture({ id: "b", createdAt: 1000 }));
    await a.put(fixture({ id: "c", createdAt: 3000 }));
    const out = await createFolderOrdersAdapter(31337, ACCT, fs).loadAll();
    expect(out.map((o) => o.id)).toEqual(["b", "a", "c"]);
  });

  it("isolates orders by chainId (different filename prefix)", async () => {
    const fs = fakeFs();
    const main = createFolderOrdersAdapter(1, ACCT, fs);
    const sepolia = createFolderOrdersAdapter(11155111, ACCT, fs);
    await main.put(fixture({ id: "m" }));
    await sepolia.put(fixture({ id: "s" }));
    expect((await main.loadAll()).map((o) => o.id)).toEqual(["m"]);
    expect((await sepolia.loadAll()).map((o) => o.id)).toEqual(["s"]);
  });

  it("isolates orders by accountKey — a sibling account's files are invisible", async () => {
    const fs = fakeFs();
    const me = createFolderOrdersAdapter(31337, ACCT, fs);
    const them = createFolderOrdersAdapter(31337, OTHER, fs);
    await me.put(fixture({ id: "mine" }));
    await them.put(fixture({ id: "theirs" }));
    // Both files coexist in the folder, but each adapter only sees
    // its own — closes the cross-account privacy leak the
    // chain-only-keyed aggregate had.
    expect((await me.loadAll()).map((o) => o.id)).toEqual(["mine"]);
    expect((await them.loadAll()).map((o) => o.id)).toEqual(["theirs"]);
  });

  it("loadAll only walks the directory once per adapter instance", async () => {
    const fs = fakeFs();
    fs.files.set(
      `zkscatter-pro-order-31337-${ACCT}-x.json`,
      JSON.stringify({
        id: "x",
        label: "ord-1",
        side: "sell",
        pair: "ETH/USDC",
        price: "1",
        size: "1",
        status: "matching",
        createdAt: 1,
      }),
    );
    const a = createFolderOrdersAdapter(31337, ACCT, fs);
    await a.loadAll();
    await a.loadAll();
    await a.loadAll();
    expect(fs.listCalls).toBe(1);
  });

  it("returns an empty list when no matching files exist", async () => {
    const fs = fakeFs();
    const out = await createFolderOrdersAdapter(31337, ACCT, fs).loadAll();
    expect(out).toEqual([]);
  });

  it("skips a corrupt single file and keeps the rest", async () => {
    const fs = fakeFs();
    fs.files.set(
      `zkscatter-pro-order-31337-${ACCT}-good.json`,
      JSON.stringify({
        id: "good",
        label: "ord-1",
        side: "sell",
        pair: "ETH/USDC",
        price: "1",
        size: "1",
        status: "matching",
        createdAt: 1,
      }),
    );
    fs.files.set(
      `zkscatter-pro-order-31337-${ACCT}-bad.json`,
      "{ not valid JSON",
    );
    fs.files.set(
      `zkscatter-pro-order-31337-${ACCT}-noid.json`,
      JSON.stringify({ label: "missing id", createdAt: 2 }),
    );
    const out = await createFolderOrdersAdapter(31337, ACCT, fs).loadAll();
    expect(out.map((o) => o.id)).toEqual(["good"]);
  });

  it("a write to a sibling order does not touch the corrupt neighbour's file", async () => {
    const fs = fakeFs();
    const bad = `zkscatter-pro-order-31337-${ACCT}-bad.json`;
    fs.files.set(bad, "{ corrupt");
    const a = createFolderOrdersAdapter(31337, ACCT, fs);
    expect(await a.loadAll()).toEqual([]);
    await a.put(fixture({ id: "new" }));
    // Per-file model: the corrupt file is untouched, the new one
    // lands cleanly alongside it.
    expect(fs.files.get(bad)).toBe("{ corrupt");
    expect(fs.files.get(`zkscatter-pro-order-31337-${ACCT}-new.json`)).toBeDefined();
  });

  it("remove deletes the per-order file and is idempotent", async () => {
    const fs = fakeFs();
    const a = createFolderOrdersAdapter(31337, ACCT, fs);
    await a.put(fixture({ id: "doomed" }));
    expect(fs.files.has(`zkscatter-pro-order-31337-${ACCT}-doomed.json`)).toBe(true);

    await a.remove("doomed");
    expect(fs.files.has(`zkscatter-pro-order-31337-${ACCT}-doomed.json`)).toBe(false);

    // Idempotent: removing a missing id doesn't throw and doesn't
    // generate a second removeFile call's failure path.
    await expect(a.remove("doomed")).resolves.toBeUndefined();

    expect((await a.loadAll()).map((o) => o.id)).toEqual([]);
  });

  it("does not throw when listFiles / saveFile / removeFile reject (logs only)", async () => {
    const fs: OrdersAdapterIO = {
      listFiles: async () => {
        throw new Error("boom-list");
      },
      loadFile: async () => null,
      saveFile: async () => {
        throw new Error("boom-save");
      },
      removeFile: async () => {
        throw new Error("boom-remove");
      },
    };
    const a = createFolderOrdersAdapter(31337, ACCT, fs);
    await expect(a.loadAll()).resolves.toEqual([]);
    await expect(a.put(fixture())).resolves.toBeUndefined();
    await expect(a.remove("anything")).resolves.toBeUndefined();
  });
});
