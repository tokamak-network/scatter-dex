import { describe, expect, it } from "vitest";
import {
  deriveSelfList,
  type EventRow,
} from "../app/sanctions/_components/SanctionsContext";

const ALICE = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BOB = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function add(address: string, block: number, logIndex = 0): EventRow {
  return {
    kind: "add",
    address,
    block,
    txIndex: 0,
    logIndex,
    txHash: `0x${block.toString(16).padStart(64, "0")}`,
  };
}
function remove(address: string, block: number, logIndex = 0): EventRow {
  return { ...add(address, block, logIndex), kind: "remove" };
}

describe("deriveSelfList", () => {
  it("empty input → empty set + empty map", () => {
    const { currentSet, activeAddBlock } = deriveSelfList([]);
    expect(currentSet.size).toBe(0);
    expect(activeAddBlock.size).toBe(0);
  });

  it("single add → address in set with that block", () => {
    const { currentSet, activeAddBlock } = deriveSelfList([add(ALICE, 1000)]);
    expect(currentSet.has(ALICE)).toBe(true);
    expect(activeAddBlock.get(ALICE)).toBe(1000);
  });

  it("add then remove → set empty, map empty", () => {
    const { currentSet, activeAddBlock } = deriveSelfList([
      add(ALICE, 1000),
      remove(ALICE, 1500),
    ]);
    expect(currentSet.has(ALICE)).toBe(false);
    expect(activeAddBlock.has(ALICE)).toBe(false);
  });

  it("REGRESSION: add → remove → re-add records the latest add block", () => {
    // This is the bug the simplify pass caught: the original
    // `firstAddBlock` retained the earliest add forever, so a
    // remove-and-re-add cycle credited the wrong tx in the UI.
    const { currentSet, activeAddBlock } = deriveSelfList([
      add(ALICE, 1000),
      remove(ALICE, 1500),
      add(ALICE, 9000),
    ]);
    expect(currentSet.has(ALICE)).toBe(true);
    expect(activeAddBlock.get(ALICE)).toBe(9000);
  });

  it("multiple adds on the same address overwrite to the latest block", () => {
    // The contract emits AddressSanctioned only when sanctioned[addr]
    // flips from false to true, so duplicate adds shouldn't happen
    // in production. But the replay must be idempotent under bad
    // logs / replays.
    const { activeAddBlock } = deriveSelfList([
      add(ALICE, 1000),
      add(ALICE, 1100),
      add(ALICE, 1200),
    ]);
    expect(activeAddBlock.get(ALICE)).toBe(1200);
  });

  it("remove without prior add is a no-op (set stays empty)", () => {
    const { currentSet } = deriveSelfList([remove(ALICE, 1000)]);
    expect(currentSet.size).toBe(0);
  });

  it("independent addresses tracked separately", () => {
    const { currentSet, activeAddBlock } = deriveSelfList([
      add(ALICE, 1000),
      add(BOB, 2000),
      remove(ALICE, 3000),
    ]);
    expect(currentSet.has(ALICE)).toBe(false);
    expect(currentSet.has(BOB)).toBe(true);
    expect(activeAddBlock.get(BOB)).toBe(2000);
    expect(activeAddBlock.has(ALICE)).toBe(false);
  });
});
