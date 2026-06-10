import { describe, it, expect, vi, afterEach } from "vitest";
import { ethers } from "ethers";
import { loadCommitmentInsertedHistory } from "../../src/core/pool";

const POOL_ADDR = "0x" + "44".repeat(20);

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
