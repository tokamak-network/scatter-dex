import { describe, it, expect, vi } from "vitest";
import type { ethers } from "ethers";
import { queryFilterChunked } from "./chunked-query.js";

/** Mock contract whose queryFilter records each (from,to) window it's asked
 *  for and returns one synthetic log per window tagged with its bounds, so a
 *  test can assert both the windowing math and that results concatenate in
 *  call order. */
function mockContract() {
  const calls: Array<[number, number]> = [];
  const queryFilter = vi.fn(async (_filter: unknown, from: number, to: number) => {
    calls.push([from, to]);
    return [{ blockNumber: from, _window: [from, to] }] as unknown as ethers.EventLog[];
  });
  return { calls, contract: { queryFilter } as unknown as ethers.Contract };
}

const FILTER = {} as ethers.ContractEventName;

describe("queryFilterChunked", () => {
  it("returns nothing and makes no call when fromBlock > toBlock", async () => {
    const { calls, contract } = mockContract();
    const out = await queryFilterChunked(contract, FILTER, 100, 99, 10);
    expect(out).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("uses a single window when the range fits in one chunk", async () => {
    const { calls, contract } = mockContract();
    await queryFilterChunked(contract, FILTER, 1000, 1500, 10000);
    expect(calls).toEqual([[1000, 1500]]);
  });

  it("splits a wide range into inclusive, gapless, non-overlapping windows", async () => {
    const { calls, contract } = mockContract();
    // 0..25 with chunkSize 10 → [0,9] [10,19] [20,25]
    await queryFilterChunked(contract, FILTER, 0, 25, 10);
    expect(calls).toEqual([
      [0, 9],
      [10, 19],
      [20, 25],
    ]);
  });

  it("preserves ascending order of concatenated logs across windows", async () => {
    const { contract } = mockContract();
    const out = await queryFilterChunked(contract, FILTER, 0, 25, 10);
    expect(out.map((l) => (l as unknown as { blockNumber: number }).blockNumber)).toEqual([
      0, 10, 20,
    ]);
  });

  it("handles an exact multiple (no trailing partial window)", async () => {
    const { calls, contract } = mockContract();
    await queryFilterChunked(contract, FILTER, 100, 119, 10);
    expect(calls).toEqual([
      [100, 109],
      [110, 119],
    ]);
  });

  it("supports a tiny cap (e.g. Alchemy free = 10 blocks)", async () => {
    const { calls, contract } = mockContract();
    await queryFilterChunked(contract, FILTER, 0, 5, 2);
    expect(calls).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
  });

  it("clamps a non-positive or fractional chunkSize to at least 1 block", async () => {
    const { calls, contract } = mockContract();
    await queryFilterChunked(contract, FILTER, 0, 2, 0);
    expect(calls).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });
});
