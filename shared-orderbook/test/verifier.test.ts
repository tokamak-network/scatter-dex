/**
 * Phase 2.5b verifier tests. Exercises both the pure matcher and the
 * `runVerifyPass` orchestrator against a real on-disk OrderbookDB with
 * a stubbed event fetcher.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import { OrderbookDB } from "../src/core/db.js";
import { config } from "../src/config.js";
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
      { chainId: 11155111, maxBlock: 1000 },
    );

    expect(result.scanned).toBe(1);
    expect(result.flipped).toBe(1);
    const stored = db.getSettlement(row.txHash);
    expect(stored?.verified).toBe(true);
    expect(stored?.blockTime).toBe(1_750_000_000);
    expect(fetched).toEqual([]); // sanity for the test wrapper
  });

  it("overwrites relayer-reported fees with the on-chain amounts on verify", async () => {
    // Relayer self-reports inflated fees; the on-chain event carries the real
    // amounts. After verify the stored fees must be the canonical on-chain
    // values, so a relayer can't pump its fee-revenue / avgFeeBps aggregates.
    const row = makeRow({ feeMaker: "999999999", feeTaker: "888888888" });
    db.insertSettlement(row.makerRelayer, row);

    const result = await runVerifyPass(
      db,
      async () => [makeEvent({ feeTokenMaker: "100", feeTokenTaker: "50" })],
      { chainId: 11155111, maxBlock: 1000 },
    );

    expect(result.flipped).toBe(1);
    const stored = db.getSettlement(row.txHash);
    expect(stored?.verified).toBe(true);
    expect(stored?.feeMaker).toBe("100");
    expect(stored?.feeTaker).toBe("50");
  });

  it("leaves fees as-reported when the event omits fee amounts", async () => {
    const row = makeRow({ feeMaker: "42", feeTaker: "7" });
    db.insertSettlement(row.makerRelayer, row);

    // makeEvent() has no feeToken* fields → decision carries no fees → columns
    // are left untouched (back-compat with fetchers that don't project them).
    const result = await runVerifyPass(db, async () => [makeEvent()], {
      chainId: 11155111,
      maxBlock: 1000,
    });

    expect(result.flipped).toBe(1);
    const stored = db.getSettlement(row.txHash);
    expect(stored?.feeMaker).toBe("42");
    expect(stored?.feeTaker).toBe("7");
  });

  it("leaves verified=0 and reports the reason when the event is missing", async () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);
    const result = await runVerifyPass(db, async () => [], { chainId: 11155111, maxBlock: 1000 });
    expect(result.flipped).toBe(0);
    expect(result.report.unmatched).toHaveLength(1);
    expect(result.report.unmatched[0].reason).toBe("no-event");
    expect(db.getSettlement(row.txHash)?.verified).toBe(false);
  });

  it("quarantines an impossible-future row so it can't pin the pending count, and still scans the legit row", async () => {
    // A legit row within the scan window + an injected row whose blockNumber is
    // far beyond head (never inside [.. <= maxBlock], so it'd never accrue
    // attempts without this guard).
    const legit = makeRow({ txHash: "0x" + "a1".repeat(32), blockNumber: 100 });
    const future = makeRow({
      txHash: "0x" + "ff".repeat(32),
      blockNumber: 9_007_199_254_740_000,
      makerNullifier: "0x" + "07".repeat(32),
      takerNullifier: "0x" + "08".repeat(32),
    });
    db.insertSettlement(legit.makerRelayer, legit);
    db.insertSettlement(future.makerRelayer, future);
    expect(db.countUnverifiedSettlements()).toBe(2);

    // futureBlockThreshold = head(1000) + buffer; the legit row's event is
    // missing here (async () => []) so it stays pending, the future row is
    // force-quarantined.
    const result = await runVerifyPass(db, async () => [], {
      chainId: 11155111,
      maxBlock: 1000,
      futureBlockThreshold: 1_000_000,
    });

    // Only the legit row entered the scan set — the future row was quarantined
    // before selection, so it's neither scanned nor counted as pending.
    expect(result.scanned).toBe(1);
    expect(db.countQuarantinedSettlements()).toBe(1);       // the future row
    expect(db.getSettlement(legit.txHash)?.verified).toBe(false); // legit still pending
    // The future row no longer counts as active/pending backlog.
    expect(db.countUnverifiedSettlements()).toBe(1);
  });

  it("short-circuits with empty fetch when no unverified rows exist", async () => {
    let calls = 0;
    const result = await runVerifyPass(
      db,
      async () => {
        calls++;
        return [];
      },
      { chainId: 11155111, maxBlock: 1000 },
    );
    expect(result.scanned).toBe(0);
    expect(result.flipped).toBe(0);
    expect(calls).toBe(0);
  });

  it("ignores already-verified rows on re-run (idempotent)", async () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);

    const fetcher = async () => [makeEvent()];
    const first = await runVerifyPass(db, fetcher, { chainId: 11155111, maxBlock: 1000 });
    expect(first.flipped).toBe(1);

    const second = await runVerifyPass(db, fetcher, { chainId: 11155111, maxBlock: 1000 });
    expect(second.scanned).toBe(0);
    expect(second.flipped).toBe(0);
  });

  it("OVERWRITES a relayer-supplied block_time with the on-chain value", async () => {
    // Relayer pushed a row with a (potentially stale or bogus) block_time.
    const row = makeRow({ blockTime: 1_700_000_000 });
    db.insertSettlement(row.makerRelayer, row);
    expect(db.getSettlement(row.txHash)?.blockTime).toBe(1_700_000_000);

    const result = await runVerifyPass(
      db,
      async () => [makeEvent({ blockTime: 1_750_000_000 })],
      { chainId: 11155111, maxBlock: 1000 },
    );
    expect(result.flipped).toBe(1);
    // The on-chain timestamp wins.
    expect(db.getSettlement(row.txHash)?.blockTime).toBe(1_750_000_000);
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
      { chainId: 11155111, maxBlock: 200 },
    );
    expect(result.scanned).toBe(1);
    expect(result.flipped).toBe(1);

    // The block-500 row is still unverified.
    const stillOpen = db.listUnverifiedSettlements({ maxBlock: 1000 });
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0].blockNumber).toBe(500);
  });
});

describe("event-attested attribution (verify-layer anti-squat)", () => {
  let db: OrderbookDB;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = new OrderbookDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  const squatter = "0x" + "ee".repeat(20);
  const honestMaker = "0x" + "11".repeat(20);
  const honestTaker = "0x" + "22".repeat(20);

  it("a verify pass records the event's true attribution on a relayer-mismatch row", async () => {
    // Squatter claims someone else's settlement as its own.
    const squat = makeRow({ makerRelayer: squatter, takerRelayer: undefined });
    db.insertSettlement(squatter, squat);

    const r = await runVerifyPass(db, async () => [makeEvent()], { chainId: 11155111, maxBlock: 1000 });
    expect(r.flipped).toBe(0);
    expect(r.report.unmatched[0]).toMatchObject({
      reason: "relayer-mismatch",
      eventMakerRelayer: honestMaker,
      eventTakerRelayer: honestTaker,
    });

    // Attestation persisted: the squatter's re-post (same attribution) is a
    // no-op, the honest maker's submit replaces the row.
    const rePost = db.insertSettlement(squatter, squat);
    expect(rePost).toBe(false);
    const honest = db.insertSettlement(honestMaker, makeRow());
    expect(honest).toBe(true);
    expect(db.getSettlement(makeRow().txHash)?.makerRelayer).toBe(honestMaker);
  });

  it("after attestation, a squatter can no longer re-evict the honest row (race closed)", async () => {
    const squat = makeRow({ makerRelayer: squatter, takerRelayer: undefined });
    db.insertSettlement(squatter, squat);
    await runVerifyPass(db, async () => [makeEvent()], { chainId: 11155111, maxBlock: 1000 });

    // Honest replacement inherits the attestation…
    db.insertSettlement(honestMaker, makeRow());
    // …so the squatter's differing re-post is rejected even though the fresh
    // row is still unverified (pre-attestation this would have evicted it).
    const reSquat = db.insertSettlement(squatter, squat);
    expect(reSquat).toBe(false);
    expect(db.getSettlement(makeRow().txHash)?.makerRelayer).toBe(honestMaker);

    // And the honest row verifies on the next pass.
    const r = await runVerifyPass(db, async () => [makeEvent()], { chainId: 11155111, maxBlock: 1000 });
    expect(r.flipped).toBe(1);
    expect(db.getSettlement(makeRow().txHash)?.verified).toBe(true);
  });

  it("recordEventAttribution never touches a verified row", () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);
    db.markSettlementsVerified([{ txHash: row.txHash }]);
    expect(
      db.recordEventAttribution([
        { txHash: row.txHash, eventMakerRelayer: squatter, eventTakerRelayer: squatter },
      ]),
    ).toBe(0);
  });

  it("a no-event row carries no attestation fields", async () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);
    const r = await runVerifyPass(db, async () => [], { chainId: 11155111, maxBlock: 1000 });
    expect(r.report.unmatched[0]).toEqual({ txHash: row.txHash, reason: "no-event" });
  });
});

describe("verify-attempt quarantine (A-5)", () => {
  let db: OrderbookDB;

  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    db = new OrderbookDB(TEST_DB);
  });
  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  const N = config.maxVerifyAttempts;

  it("quarantines a row the verifier repeatedly fails to match (no-event)", async () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);
    expect(db.countUnverifiedSettlements()).toBe(1);

    // Every pass returns no event → unmatched → verify_attempts++. After N
    // passes the row crosses the budget and leaves the active set.
    for (let i = 0; i < N; i++) {
      const r = await runVerifyPass(db, async () => [], { chainId: 11155111, maxBlock: 1000 });
      expect(r.scanned).toBe(1); // still scanned right up to the Nth failure
      expect(r.report.unmatched[0]?.reason).toBe("no-event");
    }

    // Now quarantined: dropped from the active unverified set + counters, but
    // still present (verified stays false) and counted separately.
    expect(db.countUnverifiedSettlements()).toBe(0);
    expect(db.countQuarantinedSettlements()).toBe(1);
    expect(db.listUnverifiedSettlements({ maxBlock: 1000 })).toHaveLength(0);
    expect(db.getSettlement(row.txHash)?.verified).toBe(false);
  });

  it("stops re-scanning a quarantined row on subsequent passes", async () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);
    for (let i = 0; i < N; i++) {
      await runVerifyPass(db, async () => [], { chainId: 11155111, maxBlock: 1000 });
    }
    // The fake row no longer consumes a scan slot — the pass short-circuits.
    let calls = 0;
    const after = await runVerifyPass(
      db,
      async () => { calls++; return []; },
      { chainId: 11155111, maxBlock: 1000 },
    );
    expect(after.scanned).toBe(0);
    expect(calls).toBe(0);
  });

  it("a transient miss still verifies once the event shows up (no premature quarantine)", async () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);

    // Fail a few times (below the budget), then the event appears.
    for (let i = 0; i < N - 1; i++) {
      await runVerifyPass(db, async () => [], { chainId: 11155111, maxBlock: 1000 });
    }
    expect(db.countUnverifiedSettlements()).toBe(1); // still active

    const r = await runVerifyPass(db, async () => [makeEvent()], { chainId: 11155111, maxBlock: 1000 });
    expect(r.flipped).toBe(1);
    expect(db.getSettlement(row.txHash)?.verified).toBe(true);
    expect(db.countQuarantinedSettlements()).toBe(0);
  });

  it("recordVerifyFailures does not bump an already-verified row", () => {
    const row = makeRow();
    db.insertSettlement(row.makerRelayer, row);
    db.markSettlementsVerified([{ txHash: row.txHash }]);
    expect(db.recordVerifyFailures([row.txHash])).toBe(0);
    expect(db.countQuarantinedSettlements()).toBe(0);
  });

  it("bounds the fetch window to maxBlockRange so a stuck low block can't stall the verifier", async () => {
    // A fake row at block 0 that never lands, plus a legit recent row far away.
    db.insertSettlement(makeRow().makerRelayer, makeRow({ txHash: "0x" + "a1".repeat(32), blockNumber: 0 }));
    db.insertSettlement(makeRow().makerRelayer, makeRow({
      txHash: "0x" + "a2".repeat(32), blockNumber: 5_000_000,
      makerNullifier: "0x" + "03".repeat(32), takerNullifier: "0x" + "04".repeat(32),
    }));

    let seenRange: [number, number] | null = null;
    const r = await runVerifyPass(
      db,
      async (from, to) => { seenRange = [from, to]; return []; },
      { chainId: 11155111, maxBlock: 9_000_000, limit: 500, maxBlockRange: 5000 },
    );
    // Only the block-0 row is in the capped window — the 5M row is deferred,
    // so the fetcher is never asked for a multi-million-block range.
    expect(seenRange).toEqual([0, 0]);
    expect(r.scanned).toBe(1);
    // The stuck row still accrues an attempt, so it progresses toward quarantine
    // instead of stalling the whole pass.
    expect(r.report.unmatched).toHaveLength(1);
  });
});
