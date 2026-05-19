// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  createFolderOrdersAdapter,
  type OrderRecord,
} from "../app/lib/orders";

function fixture(overrides: Partial<OrderRecord> = {}): OrderRecord {
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
    claim: {
      secret: 0xc0ffee1234abcdefn,
      recipient: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      token: "0x8a791620dd6260079bf849dc5567adc3f2fdc318",
      amount: (10n ** 18n) * 4205n,
      releaseTime: 1747930000n,
      leafIndex: 0,
      claimsRoot: "0x0000000000000000000000000000000000000000000000000000000000000abc",
    },
    ...overrides,
  };
}

interface FakeFs {
  files: Map<string, string>;
  loadFile: (name: string) => Promise<string | null>;
  saveFile: (name: string, content: string) => Promise<void>;
  saveCalls: number;
  loadCalls: number;
}

function fakeFs(): FakeFs {
  const files = new Map<string, string>();
  const fs: FakeFs = {
    files,
    saveCalls: 0,
    loadCalls: 0,
    loadFile: async (name: string) => {
      fs.loadCalls++;
      return files.get(name) ?? null;
    },
    saveFile: async (name: string, content: string) => {
      fs.saveCalls++;
      files.set(name, content);
    },
  };
  return fs;
}

describe("createFolderOrdersAdapter", () => {
  it("writes the aggregate file under the per-chain name", async () => {
    const fs = fakeFs();
    const a = createFolderOrdersAdapter(31337, fs);
    await a.put(fixture());
    expect(Array.from(fs.files.keys())).toEqual([
      "zkscatter-pro-orders-31337.json",
    ]);
  });

  it("round-trips a fully populated order through JSON without precision loss", async () => {
    const fs = fakeFs();
    const writer = createFolderOrdersAdapter(31337, fs);
    const order = fixture();
    await writer.put(order);

    // Fresh adapter reads from the same backing file.
    const reader = createFolderOrdersAdapter(31337, fs);
    const loaded = await reader.loadAll();
    expect(loaded).toEqual([order]);
    expect(loaded[0]!.claim!.secret).toBe(order.claim!.secret);
    expect(loaded[0]!.claim!.amount).toBe(order.claim!.amount);
    expect(loaded[0]!.nonce).toBe(order.nonce);
  });

  it("upserts on put (same id replaces the existing row)", async () => {
    const fs = fakeFs();
    const a = createFolderOrdersAdapter(31337, fs);
    await a.put(fixture({ status: "matching" }));
    await a.put(fixture({ status: "claimed" }));
    const reloaded = await createFolderOrdersAdapter(31337, fs).loadAll();
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.status).toBe("claimed");
  });

  it("preserves multiple orders and returns them sorted by createdAt asc", async () => {
    const fs = fakeFs();
    const a = createFolderOrdersAdapter(31337, fs);
    await a.put(fixture({ id: "a", label: "ord-2", createdAt: 2000 }));
    await a.put(fixture({ id: "b", label: "ord-1", createdAt: 1000 }));
    await a.put(fixture({ id: "c", label: "ord-3", createdAt: 3000 }));
    const out = await createFolderOrdersAdapter(31337, fs).loadAll();
    expect(out.map((o) => o.id)).toEqual(["b", "a", "c"]);
  });

  it("isolates orders by chainId (different file per chain)", async () => {
    const fs = fakeFs();
    const main = createFolderOrdersAdapter(1, fs);
    const sepolia = createFolderOrdersAdapter(11155111, fs);
    await main.put(fixture({ id: "m", label: "ord-1" }));
    await sepolia.put(fixture({ id: "s", label: "ord-1" }));
    expect((await main.loadAll()).map((o) => o.id)).toEqual(["m"]);
    expect((await sepolia.loadAll()).map((o) => o.id)).toEqual(["s"]);
  });

  it("loadAll only hits the disk once per adapter instance (in-memory cache)", async () => {
    const fs = fakeFs();
    fs.files.set(
      "zkscatter-pro-orders-31337.json",
      JSON.stringify([
        {
          id: "x",
          label: "ord-1",
          side: "sell",
          pair: "ETH/USDC",
          price: "1",
          size: "1",
          status: "matching",
          createdAt: 1,
        },
      ]),
    );
    const a = createFolderOrdersAdapter(31337, fs);
    await a.loadAll();
    await a.loadAll();
    await a.loadAll();
    expect(fs.loadCalls).toBe(1);
  });

  it("returns an empty list when the file is missing", async () => {
    const fs = fakeFs();
    const out = await createFolderOrdersAdapter(31337, fs).loadAll();
    expect(out).toEqual([]);
  });

  it("skips a malformed row without throwing, keeps the valid ones", async () => {
    const fs = fakeFs();
    fs.files.set(
      "zkscatter-pro-orders-31337.json",
      JSON.stringify([
        {
          id: "good",
          label: "ord-1",
          side: "sell",
          pair: "ETH/USDC",
          price: "1",
          size: "1",
          status: "matching",
          createdAt: 1,
        },
        // missing required `id`
        {
          label: "ord-2",
          side: "buy",
          pair: "ETH/USDC",
          price: "2",
          size: "1",
          status: "matching",
          createdAt: 2,
        },
      ]),
    );
    const out = await createFolderOrdersAdapter(31337, fs).loadAll();
    expect(out.map((o) => o.id)).toEqual(["good"]);
  });

  it("does not throw when loadFile / saveFile reject (logs only)", async () => {
    const fs: FakeFs = {
      files: new Map(),
      saveCalls: 0,
      loadCalls: 0,
      loadFile: async () => {
        throw new Error("boom-load");
      },
      saveFile: async () => {
        throw new Error("boom-save");
      },
    };
    const a = createFolderOrdersAdapter(31337, fs);
    await expect(a.loadAll()).resolves.toEqual([]);
    await expect(a.put(fixture())).resolves.toBeUndefined();
  });
});
