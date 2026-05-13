/**
 * Coverage for the runtime wrapper around the pure verifier — the loop
 * scheduler, the abort-signal shutdown path, the in-process
 * `VerifyMonitor`, and the per-pass error-isolation behaviour.
 *
 * The ethers / provider integration in `makeEventFetcher` itself is
 * not unit-tested here (it's a thin call into a real RPC and would
 * need a mock provider that re-implements `queryFilter`); these tests
 * inject a fake fetcher + a minimal `getBlockNumber` provider, which
 * is the same surface the daemon entry depends on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import { OrderbookDB } from "../src/core/db.js";
import {
  runVerifyLoop,
  VerifyMonitor,
  type VerifyPassStats,
} from "../src/core/verify-runtime.js";
import type { EventFetcher } from "../src/core/verifier.js";
import type { SettlementInsert } from "../src/types/settlement.js";

const TEST_DB = "/tmp/shared-ob-verify-runtime.db";

function makeRow(over: Partial<SettlementInsert> = {}): SettlementInsert {
  return {
    txHash: "0x" + "a1".repeat(32),
    blockNumber: 100,
    makerRelayer: "0x" + "11".repeat(20),
    takerRelayer: "0x" + "22".repeat(20),
    makerNullifier: "0x" + "01".repeat(32),
    takerNullifier: "0x" + "02".repeat(32),
    feeMaker: "0",
    feeTaker: "0",
    userMaxFeeMaker: 30,
    userMaxFeeTaker: 30,
    sellToken: "0x" + "aa".repeat(20),
    buyToken: "0x" + "bb".repeat(20),
    sellAmount: "1000",
    buyAmount: "2000",
    ...over,
  };
}

describe("VerifyMonitor", () => {
  it("starts empty and records the latest pass", () => {
    const m = new VerifyMonitor();
    expect(m.snapshot()).toEqual({ lastPass: null, totalPasses: 0 });

    const stats: VerifyPassStats = {
      startedAt: 1,
      finishedAt: 2,
      scanned: 5,
      flipped: 5,
      unmatched: 0,
      unmatchedByReason: { "no-event": 0, "tx-mismatch": 0, "relayer-mismatch": 0 },
      maxBlock: 1000,
      error: null,
    };
    m.record(stats);
    expect(m.snapshot()).toEqual({ lastPass: stats, totalPasses: 1 });
  });

  it("overwrites lastPass and bumps totalPasses across multiple records", () => {
    const m = new VerifyMonitor();
    const base = {
      startedAt: 0,
      finishedAt: 0,
      scanned: 0,
      flipped: 0,
      unmatched: 0,
      unmatchedByReason: { "no-event": 0, "tx-mismatch": 0, "relayer-mismatch": 0 },
      maxBlock: 0,
      error: null,
    } as VerifyPassStats;
    m.record({ ...base, scanned: 1 });
    m.record({ ...base, scanned: 2 });
    m.record({ ...base, scanned: 3 });
    expect(m.snapshot().lastPass?.scanned).toBe(3);
    expect(m.snapshot().totalPasses).toBe(3);
  });
});

describe("runVerifyLoop", () => {
  let db: OrderbookDB;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = new OrderbookDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("runs a first pass immediately, then aborts cleanly on signal", async () => {
    db.insertSettlement(makeRow().makerRelayer, makeRow());

    const fetcher: EventFetcher = async () => [
      {
        txHash: "0x" + "a1".repeat(32),
        blockNumber: 100,
        blockTime: 1_750_000_000,
        makerNullifier: "0x" + "01".repeat(32),
        takerNullifier: "0x" + "02".repeat(32),
        makerRelayer: "0x" + "11".repeat(20),
        takerRelayer: "0x" + "22".repeat(20),
      },
    ];

    const ac = new AbortController();
    const monitor = new VerifyMonitor();
    const passes: VerifyPassStats[] = [];

    const loop = runVerifyLoop(db, fetcher, {
      intervalSec: 999, // would never tick on its own
      blockSafetyMargin: 0,
      limitPerPass: 100,
      provider: { getBlockNumber: async () => 200 },
      monitor,
      signal: ac.signal,
      onPass: (s) => {
        passes.push(s);
        ac.abort(); // stop after the first pass
      },
    });
    await loop;
    expect(passes).toHaveLength(1);
    expect(passes[0].scanned).toBe(1);
    expect(passes[0].flipped).toBe(1);
    expect(passes[0].error).toBeNull();
    expect(passes[0].maxBlock).toBe(200);
    expect(monitor.snapshot().totalPasses).toBe(1);
  });

  it("subtracts blockSafetyMargin from the latest block", async () => {
    db.insertSettlement(makeRow().makerRelayer, makeRow());

    const fetcher: EventFetcher = async () => [];
    const ac = new AbortController();
    let observedMaxBlock = -1;
    await runVerifyLoop(db, fetcher, {
      intervalSec: 999,
      blockSafetyMargin: 6,
      limitPerPass: 100,
      provider: { getBlockNumber: async () => 200 },
      signal: ac.signal,
      onPass: (s) => {
        observedMaxBlock = s.maxBlock;
        ac.abort();
      },
    });
    expect(observedMaxBlock).toBe(194); // 200 - 6
  });

  it("clamps a small chain (latest < margin) to maxBlock = 0", async () => {
    const fetcher: EventFetcher = async () => [];
    const ac = new AbortController();
    let observedMaxBlock = -1;
    await runVerifyLoop(db, fetcher, {
      intervalSec: 999,
      blockSafetyMargin: 100,
      limitPerPass: 100,
      provider: { getBlockNumber: async () => 3 },
      signal: ac.signal,
      onPass: (s) => {
        observedMaxBlock = s.maxBlock;
        ac.abort();
      },
    });
    expect(observedMaxBlock).toBe(0);
  });

  it("survives a pass-level error: records it and keeps looping", async () => {
    db.insertSettlement(makeRow().makerRelayer, makeRow());

    // First call throws (simulates RPC failure); second succeeds.
    let calls = 0;
    const fetcher: EventFetcher = async () => {
      calls += 1;
      if (calls === 1) throw new Error("rpc go boom");
      return [
        {
          txHash: "0x" + "a1".repeat(32),
          blockNumber: 100,
          blockTime: 1_750_000_000,
          makerNullifier: "0x" + "01".repeat(32),
          takerNullifier: "0x" + "02".repeat(32),
          makerRelayer: "0x" + "11".repeat(20),
          takerRelayer: "0x" + "22".repeat(20),
        },
      ];
    };

    // Silence the expected console.error from the runtime.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const ac = new AbortController();
    const passes: VerifyPassStats[] = [];
    await runVerifyLoop(db, fetcher, {
      intervalSec: 0, // back-to-back passes
      blockSafetyMargin: 0,
      limitPerPass: 100,
      provider: { getBlockNumber: async () => 200 },
      signal: ac.signal,
      onPass: (s) => {
        passes.push(s);
        if (passes.length >= 2) ac.abort();
      },
    });

    expect(passes).toHaveLength(2);
    expect(passes[0].error).toContain("rpc go boom");
    expect(passes[0].flipped).toBe(0);
    expect(passes[1].error).toBeNull();
    expect(passes[1].flipped).toBe(1);
    err.mockRestore();
  });

  it("counts unmatched reasons in the pass stats", async () => {
    db.insertSettlement(makeRow().makerRelayer, makeRow());

    const fetcher: EventFetcher = async () => [
      // Pair matches but tx_hash doesn't → tx-mismatch
      {
        txHash: "0x" + "ff".repeat(32),
        blockNumber: 100,
        blockTime: 1_750_000_000,
        makerNullifier: "0x" + "01".repeat(32),
        takerNullifier: "0x" + "02".repeat(32),
        makerRelayer: "0x" + "11".repeat(20),
        takerRelayer: "0x" + "22".repeat(20),
      },
    ];

    const ac = new AbortController();
    let stats: VerifyPassStats | null = null;
    await runVerifyLoop(db, fetcher, {
      intervalSec: 999,
      blockSafetyMargin: 0,
      limitPerPass: 100,
      provider: { getBlockNumber: async () => 200 },
      signal: ac.signal,
      onPass: (s) => {
        stats = s;
        ac.abort();
      },
    });
    expect(stats!.flipped).toBe(0);
    expect(stats!.unmatched).toBe(1);
    expect(stats!.unmatchedByReason["tx-mismatch"]).toBe(1);
  });
});
