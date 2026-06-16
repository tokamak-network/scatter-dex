import { describe, it, expect, vi } from "vitest";
import { ethers } from "ethers";
import { PRIVATE_SETTLEMENT_IFACE } from "../../src/core/contracts";
import {
  claimNullifierHex,
  fetchSpentClaimNullifiers,
  probeSpentClaimLeaves,
  resolveSpentClaimLeaves,
  resolveSpentClaimEntries,
  type ClaimLeafRef,
  type ClaimEntryRef,
} from "../../src/claim";

const SETTLEMENT = "0x" + "55".repeat(20);
const CHAIN = 11155111;

const entries: ClaimLeafRef[] = [
  { secret: 0x1111n, leafIndex: 0 },
  { secret: 0x2222n, leafIndex: 1 },
  { secret: 0x3333n, leafIndex: 2 },
];

/** Real ethers read-provider that answers `claimNullifiers(bytes32)` by
 *  decoding the queried nullifier and checking it against a spent set —
 *  exercises the genuine encode/decode path without a node. Throws if `call`
 *  is invoked while `tripwire` is set, so tests can assert "no RPC happened". */
function settlementProvider(spent: Set<string>, tripwire = false): ethers.Provider {
  const fn = PRIVATE_SETTLEMENT_IFACE.getFunction("claimNullifiers")!;
  return {
    call: async (tx: { data?: string }) => {
      if (tripwire) throw new Error("RPC must not be used when the indexer answers");
      const data = tx.data ?? "0x";
      if (!data.startsWith(fn.selector)) throw new Error(`unexpected call: ${data.slice(0, 10)}`);
      const [nullifier] = PRIVATE_SETTLEMENT_IFACE.decodeFunctionData(fn, data);
      const isSpent = spent.has(String(nullifier).toLowerCase());
      return PRIVATE_SETTLEMENT_IFACE.encodeFunctionResult(fn, [isSpent]);
    },
  } as unknown as ethers.Provider;
}

async function hexes(): Promise<string[]> {
  return Promise.all(entries.map((e) => claimNullifierHex(e.secret, e.leafIndex)));
}

describe("fetchSpentClaimNullifiers", () => {
  it("POSTs the nullifier list and returns the lowercased spent set", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(init?.method).toBe("POST");
      expect(body.chainId).toBe(CHAIN);
      expect(body.nullifiers).toEqual(["0xAA", "0xBB"]);
      return new Response(JSON.stringify({ spent: ["0xAA"] }), { status: 200 });
    }) as unknown as typeof fetch;
    const spent = await fetchSpentClaimNullifiers("http://idx/", CHAIN, ["0xAA", "0xBB"], { fetchImpl });
    expect(spent.has("0xaa")).toBe(true);
    expect(spent.has("0xbb")).toBe(false);
  });

  it("short-circuits on empty input (no request)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const spent = await fetchSpentClaimNullifiers("http://idx", CHAIN, [], { fetchImpl });
    expect(spent.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(fetchSpentClaimNullifiers("http://idx", CHAIN, ["0xAA"], { fetchImpl })).rejects.toThrow();
  });

  it("throws on a malformed payload", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ nope: 1 }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchSpentClaimNullifiers("http://idx", CHAIN, ["0xAA"], { fetchImpl })).rejects.toThrow();
  });

  it("throws when the response echoes a different chainId (misroute guard)", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ chainId: 1, spent: ["0xAA"] }), { status: 200 })) as unknown as typeof fetch;
    await expect(fetchSpentClaimNullifiers("http://idx", CHAIN, ["0xAA"], { fetchImpl })).rejects.toThrow(/chainId/);
  });

  it("drops non-string elements from spent before lowercasing", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ spent: ["0xAA", 42, null] }), { status: 200 })) as unknown as typeof fetch;
    const spent = await fetchSpentClaimNullifiers("http://idx", CHAIN, ["0xAA"], { fetchImpl });
    expect([...spent]).toEqual(["0xaa"]);
  });
});

describe("claimNullifierHex guard", () => {
  it("rejects a negative leafIndex", async () => {
    await expect(claimNullifierHex(0x1n, -1)).rejects.toThrow(/non-negative/);
  });
  it("rejects a fractional leafIndex", async () => {
    await expect(claimNullifierHex(0x1n, 1.5)).rejects.toThrow(/non-negative/);
  });
});

describe("probeSpentClaimLeaves (RPC fallback)", () => {
  it("returns the leaf indices whose nullifier is spent on-chain", async () => {
    const hs = await hexes();
    const provider = settlementProvider(new Set([hs[0], hs[2]])); // leaves 0 and 2 spent
    const out = await probeSpentClaimLeaves(provider, SETTLEMENT, entries);
    expect([...out].sort()).toEqual([0, 2]);
  });
});

describe("resolveSpentClaimLeaves", () => {
  it("uses the indexer batch and never touches RPC when the URL is set", async () => {
    const hs = await hexes();
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ spent: [hs[1]] }), { status: 200 }),
    ) as unknown as typeof fetch;
    const out = await resolveSpentClaimLeaves({
      entries,
      chainId: CHAIN,
      settlementAddress: SETTLEMENT,
      provider: settlementProvider(new Set(), true), // tripwire — RPC would throw
      sharedOrderbookUrl: "http://idx",
      fetchImpl,
    });
    expect([...out]).toEqual([1]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("falls back to RPC when no indexer URL is set", async () => {
    const hs = await hexes();
    const out = await resolveSpentClaimLeaves({
      entries,
      chainId: CHAIN,
      settlementAddress: SETTLEMENT,
      provider: settlementProvider(new Set([hs[0]])),
    });
    expect([...out]).toEqual([0]);
  });

  it("falls back to RPC when the indexer request fails", async () => {
    const hs = await hexes();
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const out = await resolveSpentClaimLeaves({
      entries,
      chainId: CHAIN,
      settlementAddress: SETTLEMENT,
      provider: settlementProvider(new Set([hs[2]])),
      sharedOrderbookUrl: "http://idx",
      fetchImpl,
    });
    expect([...out]).toEqual([2]);
  });

  it("returns empty for no entries, and when neither indexer nor provider can answer", async () => {
    expect((await resolveSpentClaimLeaves({ entries: [], chainId: CHAIN, settlementAddress: SETTLEMENT })).size).toBe(0);
    expect((await resolveSpentClaimLeaves({ entries, chainId: CHAIN, settlementAddress: SETTLEMENT })).size).toBe(0);
  });
});

describe("resolveSpentClaimEntries (inbox — nullifier-hash keyed, heterogeneous settlements)", () => {
  // Two entries that share leafIndex 0 but live under DIFFERENT settlements —
  // exactly the case leafIndex-keying can't disambiguate, so we key on the
  // nullifier instead.
  const SETTLEMENT_A = "0x" + "aa".repeat(20);
  const SETTLEMENT_B = "0x" + "bb".repeat(20);
  const inbox: ClaimEntryRef[] = [
    { key: "entry-A", secret: 0x1111n, leafIndex: 0, settlementAddress: SETTLEMENT_A },
    { key: "entry-B", secret: 0x2222n, leafIndex: 0, settlementAddress: SETTLEMENT_B },
    { key: "entry-C", secret: 0x3333n, leafIndex: 1, settlementAddress: SETTLEMENT_A },
  ];
  const inboxHexes = (): Promise<string[]> =>
    Promise.all(inbox.map((e) => claimNullifierHex(e.secret, e.leafIndex)));

  it("batches all entries into one indexer call and maps spent hashes back to keys", async () => {
    const hs = await inboxHexes();
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      // All three entries' nullifiers go in one request, regardless of settlement.
      expect(body.nullifiers.sort()).toEqual([...hs].sort());
      return new Response(JSON.stringify({ spent: [hs[0], hs[2]] }), { status: 200 });
    }) as unknown as typeof fetch;
    const out = await resolveSpentClaimEntries({
      entries: inbox,
      chainId: CHAIN,
      provider: settlementProvider(new Set(), true), // tripwire — RPC must not run
      sharedOrderbookUrl: "http://idx",
      fetchImpl,
    });
    expect([...out].sort()).toEqual(["entry-A", "entry-C"]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("falls back to per-entry RPC (each against its own settlement) when no indexer URL", async () => {
    const hs = await inboxHexes();
    const out = await resolveSpentClaimEntries({
      entries: inbox,
      chainId: CHAIN,
      provider: settlementProvider(new Set([hs[1]])), // entry-B spent
    });
    expect([...out]).toEqual(["entry-B"]);
  });

  it("falls back to RPC when the indexer request fails", async () => {
    const hs = await inboxHexes();
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const out = await resolveSpentClaimEntries({
      entries: inbox,
      chainId: CHAIN,
      provider: settlementProvider(new Set([hs[0]])),
      sharedOrderbookUrl: "http://idx",
      fetchImpl,
    });
    expect([...out]).toEqual(["entry-A"]);
  });

  it("returns empty for no entries, and when neither indexer nor provider can answer", async () => {
    expect((await resolveSpentClaimEntries({ entries: [], chainId: CHAIN })).size).toBe(0);
    expect((await resolveSpentClaimEntries({ entries: inbox, chainId: CHAIN })).size).toBe(0);
  });
});
