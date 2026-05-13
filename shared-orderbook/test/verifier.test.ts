/**
 * Phase 2.5b verifier tests. Exercises both the pure matcher and the
 * `runVerifyPass` orchestrator against a real on-disk OrderbookDB with
 * a stubbed event fetcher.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import { OrderbookDB } from "../src/core/db.js";
import {
  matchSettlements,
  runVerifyPass,
  type SettledAuthEvent,
} from "../src/core/verifier.js";
import type { SettlementInsert } from "../src/types/settlement.js";

const TEST_DB = "/tmp/shared-ob-verifier-test.db";

function makeRow(over: Partial<SettlementInsert> = {}): SettlementInsert {
  return {
    txHash: "0x" + "a1".repeat(32),
    blockNumber: 100,
    blockTime: undefined,
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

function makeEvent(over: Partial<SettledAuthEvent> = {}): SettledAuthEvent {
  return {
    txHash: "0x" + "a1".repeat(32),
    blockNumber: 100,
    blockTime: 1_750_000_000,
    makerNullifier: "0x" + "01".repeat(32),
    takerNullifier: "0x" + "02".repeat(32),
    makerRelayer: "0x" + "11".repeat(20),
    takerRelayer: "0x" + "22".repeat(20),
    ...over,
  };
}

describe("matchSettlements (pure)", () => {
  it("matches by (makerNullifier, takerNullifier) pair", () => {
    const r = matchSettlements([makeRow()], [makeEvent()]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].blockTime).toBe(1_750_000_000);
    expect(r.unmatched).toHaveLength(0);
  });

  it("does NOT match when no event exists for the pair", () => {
    const r = matchSettlements([makeRow()], []);
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched).toEqual([{ txHash: makeRow().txHash, reason: "no-event" }]);
  });

  it("flags tx-mismatch when nullifier pair matches but tx_hash differs (tampering signal)", () => {
    const r = matchSettlements(
      [makeRow({ txHash: "0x" + "a1".repeat(32) })],
      [makeEvent({ txHash: "0x" + "ff".repeat(32) })],
    );
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched[0].reason).toBe("tx-mismatch");
  });

  it("flags relayer-mismatch when on-chain maker relayer differs from the reported one", () => {
    const r = matchSettlements(
      [makeRow()],
      [makeEvent({ makerRelayer: "0x" + "ee".repeat(20) })],
    );
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched[0].reason).toBe("relayer-mismatch");
  });

  it("flags relayer-mismatch when reported taker relayer disagrees with on-chain", () => {
    const r = matchSettlements(
      [makeRow()],
      [makeEvent({ takerRelayer: "0x" + "ee".repeat(20) })],
    );
    expect(r.matched).toHaveLength(0);
    expect(r.unmatched[0].reason).toBe("relayer-mismatch");
  });

  it("is case-insensitive on hex inputs", () => {
    const r = matchSettlements(
      [
        makeRow({
          txHash: "0x" + "A1".repeat(32),
          makerNullifier: "0x" + "01".repeat(32),
          makerRelayer: "0x" + "11".repeat(20).toUpperCase(),
        }),
      ],
      [makeEvent()],
    );
    expect(r.matched).toHaveLength(1);
  });
});

describe("runVerifyPass (DB-integrated)", () => {
  let db: OrderbookDB;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = new OrderbookDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("flips verified=1 and backfills block_time for matched rows", async () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);

    const fetched: SettledAuthEvent[] = [];
    const result = await runVerifyPass(
      db,
      async (from, to) => {
        // The orchestrator must scope to the window of unverified rows.
        expect(from).toBe(100);
        expect(to).toBe(100);
        return [makeEvent()];
      },
      { maxBlock: 1000 },
    );

    expect(result.scanned).toBe(1);
    expect(result.flipped).toBe(1);
    const stored = db.getSettlement(row.txHash);
    expect(stored?.verified).toBe(true);
    expect(stored?.blockTime).toBe(1_750_000_000);
    expect(fetched).toEqual([]); // sanity for the test wrapper
  });

  it("leaves verified=0 and reports the reason when the event is missing", async () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);
    const result = await runVerifyPass(db, async () => [], { maxBlock: 1000 });
    expect(result.flipped).toBe(0);
    expect(result.report.unmatched).toHaveLength(1);
    expect(result.report.unmatched[0].reason).toBe("no-event");
    expect(db.getSettlement(row.txHash)?.verified).toBe(false);
  });

  it("short-circuits with empty fetch when no unverified rows exist", async () => {
    let calls = 0;
    const result = await runVerifyPass(
      db,
      async () => {
        calls++;
        return [];
      },
      { maxBlock: 1000 },
    );
    expect(result.scanned).toBe(0);
    expect(result.flipped).toBe(0);
    expect(calls).toBe(0);
  });

  it("ignores already-verified rows on re-run (idempotent)", async () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);

    const fetcher = async () => [makeEvent()];
    const first = await runVerifyPass(db, fetcher, { maxBlock: 1000 });
    expect(first.flipped).toBe(1);

    const second = await runVerifyPass(db, fetcher, { maxBlock: 1000 });
    expect(second.scanned).toBe(0);
    expect(second.flipped).toBe(0);
  });

  it("respects the maxBlock cutoff so the chain tail isn't re-scanned every pass", async () => {
    db.insertSettlement(makeRow().makerRelayer, makeRow({ txHash: "0x" + "a1".repeat(32), blockNumber: 100 }));
    db.insertSettlement(makeRow().makerRelayer, makeRow({ txHash: "0x" + "a2".repeat(32), blockNumber: 500, makerNullifier: "0x" + "03".repeat(32), takerNullifier: "0x" + "04".repeat(32) }));

    const result = await runVerifyPass(
      db,
      async (from, to) => {
        // Only the row at block 100 should be in scope.
        expect(from).toBe(100);
        expect(to).toBe(100);
        return [makeEvent()];
      },
      { maxBlock: 200 },
    );
    expect(result.scanned).toBe(1);
    expect(result.flipped).toBe(1);

    // The block-500 row is still unverified.
    const stillOpen = db.listUnverifiedSettlements({ maxBlock: 1000 });
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0].blockNumber).toBe(500);
  });
});
