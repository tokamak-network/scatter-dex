import { describe, it, expect, vi, afterEach } from "vitest";
import { ethers } from "ethers";
import {
  getPoolNextIndex,
  isKnownPoolRoot,
  loadCommitmentInsertedHistory,
} from "../../src/core/pool";
import { COMMITMENT_POOL_IFACE } from "../../src/core/contracts";

const POOL_ADDR = "0x" + "44".repeat(20);

/** Minimal read-only provider: decodes the call selector and returns the
 *  ABI-encoded result for that function, exercising the real ethers
 *  encode/decode path without a live node. */
function readProvider(results: Record<string, unknown[]>): ethers.Provider {
  return {
    call: async (tx: { data?: string }) => {
      const data = tx.data ?? "0x";
      for (const name of Object.keys(results)) {
        const fn = COMMITMENT_POOL_IFACE.getFunction(name)!;
        if (data.startsWith(fn.selector)) {
          return COMMITMENT_POOL_IFACE.encodeFunctionResult(fn, results[name]);
        }
      }
      throw new Error(`unexpected call: ${data.slice(0, 10)}`);
    },
  } as unknown as ethers.Provider;
}

/** Spy on Contract.queryFilter so we can assert the [from,to] windows
 *  without a live provider. Each window returns one synthetic event
 *  whose leafIndex encodes its start block, so we can also check
 *  ordering. */
function stubQueryFilter() {
  const windows: Array<[number, number]> = [];
  const spy = vi
    .spyOn(ethers.Contract.prototype, "queryFilter")
    .mockImplementation(async (_filter, from, to) => {
      windows.push([from as number, to as number]);
      return [
        { args: { commitment: BigInt(from as number), leafIndex: from as number } },
      ] as unknown as ethers.EventLog[];
    });
  return { windows, spy };
}

function makeProvider(head: number) {
  return { getBlockNumber: async () => head } as unknown as ethers.Provider;
}

afterEach(() => vi.restoreAllMocks());

describe("loadCommitmentInsertedHistory", () => {
  it("splits a wide range into chunkSize windows starting at fromBlock", async () => {
    const { windows } = stubQueryFilter();
    await loadCommitmentInsertedHistory(makeProvider(0), POOL_ADDR, {
      fromBlock: 100,
      toBlock: 120_100,
      chunkSize: 50_000,
    });
    // [100,50099] [50100,100099] [100100,120100]
    expect(windows).toEqual([
      [100, 50_099],
      [50_100, 100_099],
      [100_100, 120_100],
    ]);
  });

  it("never queries below fromBlock (no genesis scan)", async () => {
    const { windows } = stubQueryFilter();
    await loadCommitmentInsertedHistory(makeProvider(0), POOL_ADDR, {
      fromBlock: 11_008_264,
      toBlock: 11_026_479,
    });
    expect(windows).toHaveLength(1); // 18 215 blocks < default 50 000
    expect(windows[0][0]).toBe(11_008_264);
  });

  it("accepts string / bigint block tags (env vars arrive as strings)", async () => {
    const { windows } = stubQueryFilter();
    // "11008264" must NOT silently fall back to 0 (would re-scan genesis).
    await loadCommitmentInsertedHistory(makeProvider(0), POOL_ADDR, {
      fromBlock: "11008264",
      toBlock: 11_026_479n,
    });
    expect(windows).toEqual([[11_008_264, 11_026_479]]);
  });

  it("hex-string block tags parse too", async () => {
    const { windows } = stubQueryFilter();
    await loadCommitmentInsertedHistory(makeProvider(0), POOL_ADDR, {
      fromBlock: "0x64", // 100
      toBlock: "0x64",
    });
    expect(windows).toEqual([[100, 100]]);
  });

  it("falls back to the default window for a non-finite chunkSize", async () => {
    const { windows } = stubQueryFilter();
    // Infinity must NOT collapse the scan to one full-range query.
    await loadCommitmentInsertedHistory(makeProvider(0), POOL_ADDR, {
      fromBlock: 0,
      toBlock: 120_100,
      chunkSize: Infinity,
    });
    expect(windows.length).toBe(3); // chunked at the 50 000 default
    expect(windows[0]).toEqual([0, 49_999]);
  });

  it("clamps a negative block tag to 0 (never forwards a negative to queryFilter)", async () => {
    const { windows } = stubQueryFilter();
    await loadCommitmentInsertedHistory(makeProvider(0), POOL_ADDR, {
      fromBlock: "-1",
      toBlock: 10,
    });
    expect(windows).toEqual([[0, 10]]);
  });

  it("defaults toBlock to the chain head", async () => {
    const { windows } = stubQueryFilter();
    await loadCommitmentInsertedHistory(makeProvider(42), POOL_ADDR, { fromBlock: 0 });
    expect(windows).toEqual([[0, 42]]);
  });

  it("returns rows sorted by leafIndex across windows", async () => {
    stubQueryFilter();
    const rows = await loadCommitmentInsertedHistory(makeProvider(0), POOL_ADDR, {
      fromBlock: 0,
      toBlock: 100_000,
      chunkSize: 50_000,
    });
    expect(rows.map((r) => r.leafIndex)).toEqual([0, 50_000, 100_000]);
  });
});

describe("on-chain tree verification helpers", () => {
  it("isKnownPoolRoot returns the contract's bool (root accepted)", async () => {
    expect(
      await isKnownPoolRoot(readProvider({ isKnownRoot: [true] }), POOL_ADDR, 123n),
    ).toBe(true);
  });

  it("isKnownPoolRoot surfaces a rejected root (incomplete/tampered set)", async () => {
    expect(
      await isKnownPoolRoot(readProvider({ isKnownRoot: [false] }), POOL_ADDR, 999n),
    ).toBe(false);
  });

  it("getPoolNextIndex returns the leaf count as a number", async () => {
    expect(await getPoolNextIndex(readProvider({ nextIndex: [42] }), POOL_ADDR)).toBe(42);
  });
});
