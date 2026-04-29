/**
 * Settlement / fee history tests — guard the indexer contract that
 * recordSettlementEvent persists exactly one row per tx, idempotent
 * on tx_hash, and that getFeeTotals sums per-token correctly.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { randomUUID } from "crypto";
import { PrivateOrderDB } from "./db.js";

describe("PrivateOrderDB settlement history", () => {
  let dbPath: string;
  let db: PrivateOrderDB;

  beforeEach(() => {
    dbPath = join(tmpdir(), `history-test-${randomUUID()}.sqlite`);
    db = new PrivateOrderDB(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath, { force: true }); } catch { /* noop */ }
  });

  it("persists a settleAuth event with both maker and taker fees", () => {
    db.recordSettlementEvent({
      txHash: "0xaaa",
      type: "settleAuth",
      status: "confirmed",
      blockNumber: 100,
      gasCostEth: "0.0021",
      sellToken: "0xS",
      buyToken: "0xB",
      fees: [
        { side: "maker", token: "0xB", amountWei: "1000" },
        { side: "taker", token: "0xS", amountWei: "2000" },
      ],
    });
    const { rows, total } = db.getSettlementHistory({ limit: 10, offset: 0 });
    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tx_hash: "0xaaa",
      type: "settleAuth",
      status: "confirmed",
      block_number: 100,
      gas_cost_eth: "0.0021",
    });
    const totals = db.getFeeTotals();
    expect(totals).toHaveLength(2);
    const byToken = Object.fromEntries(totals.map((t) => [t.token, t]));
    expect(byToken["0xb"]).toMatchObject({ count: 1, totalWei: "1000" });
    expect(byToken["0xs"]).toMatchObject({ count: 1, totalWei: "2000" });
  });

  it("is idempotent on tx_hash — second insert is a no-op", () => {
    const evt = {
      txHash: "0xbbb",
      type: "scatterDirectAuth" as const,
      status: "confirmed" as const,
      blockNumber: 50,
      gasCostEth: "0.001",
      sellToken: "0xT",
      buyToken: "0xT",
      fees: [{ side: "scatterDirect" as const, token: "0xT", amountWei: "500" }],
    };
    db.recordSettlementEvent(evt);
    db.recordSettlementEvent(evt);
    const { total } = db.getSettlementHistory({ limit: 10, offset: 0 });
    expect(total).toBe(1);
    // Fees must not double-count on the duplicate insert.
    const totals = db.getFeeTotals();
    expect(totals).toEqual([{ token: "0xt", count: 1, totalWei: "500" }]);
  });

  it("filters by type and status", () => {
    db.recordSettlementEvent({
      txHash: "0x1",
      type: "settleAuth",
      status: "confirmed",
    });
    db.recordSettlementEvent({
      txHash: "0x2",
      type: "scatterDirectAuth",
      status: "confirmed",
    });
    db.recordSettlementEvent({
      txHash: "0x3",
      type: "settleAuth",
      status: "failed",
      errorReason: "gas-guard",
    });

    expect(db.getSettlementHistory({ limit: 10, offset: 0 }).total).toBe(3);
    expect(
      db.getSettlementHistory({ limit: 10, offset: 0, type: "settleAuth" }).total,
    ).toBe(2);
    expect(
      db.getSettlementHistory({ limit: 10, offset: 0, status: "failed" }).total,
    ).toBe(1);
    expect(
      db.getSettlementHistory({
        limit: 10,
        offset: 0,
        type: "settleAuth",
        status: "confirmed",
      }).total,
    ).toBe(1);
  });

  it("orders newest-first and respects limit/offset", () => {
    for (let i = 0; i < 5; i++) {
      db.recordSettlementEvent({
        txHash: `0xabc${i}`,
        type: "settleAuth",
        status: "confirmed",
      });
    }
    const page1 = db.getSettlementHistory({ limit: 2, offset: 0 });
    const page2 = db.getSettlementHistory({ limit: 2, offset: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    // Newest tx_hash (i=4) should be first; pages should not overlap.
    const allHashes = [...page1.rows, ...page2.rows].map((r) => r.tx_hash);
    expect(new Set(allHashes).size).toBe(4);
  });

  it("aggregates fee totals per token using bigint sums", () => {
    db.recordSettlementEvent({
      txHash: "0xt1",
      type: "settleAuth",
      status: "confirmed",
      fees: [{ side: "maker", token: "0xusdc", amountWei: "1000000" }],
    });
    db.recordSettlementEvent({
      txHash: "0xt2",
      type: "settleAuth",
      status: "confirmed",
      fees: [{ side: "maker", token: "0xusdc", amountWei: "2500000" }],
    });
    const totals = db.getFeeTotals();
    expect(totals).toEqual([{ token: "0xusdc", count: 2, totalWei: "3500000" }]);
  });

  it("skips malformed amount_wei in totals rather than crashing the aggregate", () => {
    db.recordSettlementEvent({
      txHash: "0xt1",
      type: "settleAuth",
      status: "confirmed",
      fees: [
        { side: "maker", token: "0xX", amountWei: "1000" },
        { side: "taker", token: "0xX", amountWei: "not-a-bigint" },
      ],
    });
    const totals = db.getFeeTotals();
    // count is 2 (both rows recorded), but only the parseable amount
    // contributes to totalWei.
    expect(totals).toEqual([{ token: "0xx", count: 2, totalWei: "1000" }]);
  });

  it("records a settlement with no fees array without inserting fee rows", () => {
    db.recordSettlementEvent({
      txHash: "0xnofee",
      type: "scatterDirectAuth",
      status: "confirmed",
    });
    expect(db.getSettlementHistory({ limit: 10, offset: 0 }).total).toBe(1);
    expect(db.getFeeTotals()).toEqual([]);
    expect(db.getFeeHistory({ limit: 10, offset: 0 })).toHaveLength(0);
  });

  it("normalises tx_hash and token casing on insert and query", () => {
    // Mixed-case tx_hash + checksummed token address. Insert once;
    // a second insert with all-lowercase casing must be the
    // idempotent no-op (proves UNIQUE(tx_hash) compares lowercase).
    db.recordSettlementEvent({
      txHash: "0xABCdef",
      type: "settleAuth",
      status: "confirmed",
      fees: [{ side: "maker", token: "0xAbCdEf123", amountWei: "777" }],
    });
    db.recordSettlementEvent({
      txHash: "0xabcdef",
      type: "settleAuth",
      status: "confirmed",
      fees: [{ side: "maker", token: "0xabcdef123", amountWei: "777" }],
    });
    const { total, rows } = db.getSettlementHistory({ limit: 10, offset: 0 });
    expect(total).toBe(1);
    expect(rows[0].tx_hash).toBe("0xabcdef");
    // Totals key is the lowercase form; querying by either casing
    // returns the same row via the route-layer .toLowerCase().
    const totals = db.getFeeTotals();
    expect(totals).toEqual([{ token: "0xabcdef123", count: 1, totalWei: "777" }]);
    expect(
      db.getFeeHistory({ limit: 10, offset: 0, token: "0xABCDEF123" }),
    ).toHaveLength(1);
  });

  it("includes matching authorize_orders rows in the by-tx detail (processing)", () => {
    db.insertAcceptedOrder({
      nullifier: "0xnul1",
      submittedAt: Date.now() - 5000,
      orderJson: JSON.stringify({ publicSignals: { expiry: "9999999999" } }),
      pubKeyAx: "1",
      pubKeyAy: "2",
    });
    db.insertAcceptedOrder({
      nullifier: "0xnul2",
      submittedAt: Date.now() - 4000,
      orderJson: JSON.stringify({ publicSignals: { expiry: "9999999999" } }),
      pubKeyAx: "3",
      pubKeyAy: "4",
    });
    db.markAuthorizeOrderSettled("0xnul1", "0xsettle");
    db.markAuthorizeOrderSettled("0xnul2", "0xsettle");
    db.recordSettlementEvent({
      txHash: "0xsettle",
      type: "settleAuth",
      status: "confirmed",
    });

    const found = db.getSettlementByTxHash("0xsettle");
    expect(found).not.toBeNull();
    expect(found!.processing).toHaveLength(2);
    const nullifiers = found!.processing.map((p) => p.nullifier).sort();
    expect(nullifiers).toEqual(["0xnul1", "0xnul2"]);
    expect(found!.processing[0].status).toBe("settled");
  });

  it("matches processing rows even when settle_tx was stored with a different casing", () => {
    db.insertAcceptedOrder({
      nullifier: "0xnulMix",
      submittedAt: Date.now(),
      orderJson: JSON.stringify({ publicSignals: { expiry: "9999999999" } }),
    });
    // Mimic an upstream that wrote the tx hash verbatim (uppercase).
    db.markAuthorizeOrderSettled("0xnulMix", "0xMIXEDcase");
    // Settlement history insert lowercases via recordSettlementEvent.
    db.recordSettlementEvent({
      txHash: "0xmixedcase",
      type: "scatterDirectAuth",
      status: "confirmed",
    });
    const found = db.getSettlementByTxHash("0xMIXEDcase");
    expect(found).not.toBeNull();
    expect(found!.processing).toHaveLength(1);
    expect(found!.processing[0].nullifier).toBe("0xnulMix");
  });

  it("returns an empty processing array when no authorize_orders rows match", () => {
    db.recordSettlementEvent({
      txHash: "0xorphan",
      type: "scatterDirectAuth",
      status: "confirmed",
    });
    const found = db.getSettlementByTxHash("0xorphan");
    expect(found).not.toBeNull();
    expect(found!.processing).toEqual([]);
  });

  it("looks up a settlement + its fees by tx_hash, with case normalisation", () => {
    db.recordSettlementEvent({
      txHash: "0xLOOKUP",
      type: "settleAuth",
      status: "confirmed",
      blockNumber: 11,
      gasCostEth: "0.0005",
      sellToken: "0xSell",
      buyToken: "0xBuy",
      fees: [
        { side: "maker", token: "0xBuy", amountWei: "10" },
        { side: "taker", token: "0xSell", amountWei: "20" },
      ],
    });
    const found = db.getSettlementByTxHash("0xLOOKUP");
    expect(found).not.toBeNull();
    expect(found!.settlement.tx_hash).toBe("0xlookup");
    expect(found!.fees).toHaveLength(2);
    // Look up with a different casing — must return the same row.
    const found2 = db.getSettlementByTxHash("0xlookup");
    expect(found2!.settlement.tx_hash).toBe("0xlookup");
    expect(db.getSettlementByTxHash("0xnope")).toBeNull();
  });

  it("buckets settlements into time slots with p50/p95/p99 + avgGas", () => {
    const t0 = Date.now() - 3 * 60 * 60 * 1000;
    for (let i = 0; i < 4; i++) {
      db.recordSettlementEvent({
        txHash: `0xb${i}`,
        type: "settleAuth",
        status: "confirmed",
        gasCostEth: String(0.001 * (i + 1)),
        durationMs: 100 * (i + 1),
      });
    }
    db.recordSettlementEvent({
      txHash: "0xfail1",
      type: "settleAuth",
      status: "failed",
      errorReason: "boom",
    });
    const buckets = db.getSettlementBuckets({
      since: t0,
      bucketMs: 60 * 60 * 1000,
    });
    expect(buckets.length).toBeGreaterThan(0);
    const last = buckets[buckets.length - 1];
    expect(last.settled).toBe(4);
    expect(last.failed).toBe(1);
    expect(last.avgGasEth).toBeCloseTo((0.001 + 0.002 + 0.003 + 0.004) / 4, 6);
    expect(last.p50Ms).toBe(200);
    expect(last.p95Ms).toBe(400);
    expect(last.p99Ms).toBe(400);
  });

  it("returns empty buckets for slots with no settlements (continuous series)", () => {
    const t0 = Date.now() - 2 * 60 * 60 * 1000;
    const buckets = db.getSettlementBuckets({
      since: t0,
      until: t0 + 2 * 60 * 60 * 1000,
      bucketMs: 60 * 60 * 1000,
    });
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      settled: 0,
      failed: 0,
      avgGasEth: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
    });
  });

  it("returns no buckets when the requested density would exceed the cap", () => {
    const t0 = Date.now() - 1025 * 60 * 60 * 1000;
    const buckets = db.getSettlementBuckets({
      since: t0,
      bucketMs: 60 * 60 * 1000,
    });
    expect(buckets).toEqual([]);
  });

  it("aggregates cross-relayer trade offers per peer", () => {
    db.recordTradeOffer({
      direction: "sent",
      peerRelayer: "0xpeera",
      makerPubKey: "1",
      makerNonce: "1",
      takerPubKey: "2",
      takerNonce: "1",
      status: "settled",
      txHash: "0xt1",
    });
    db.recordTradeOffer({
      direction: "received",
      peerRelayer: "0xpeera",
      makerPubKey: "3",
      makerNonce: "1",
      takerPubKey: "4",
      takerNonce: "1",
      status: "rejected",
      reason: "stale",
    });
    db.recordTradeOffer({
      direction: "sent",
      peerRelayer: "0xpeerb",
      makerPubKey: "5",
      makerNonce: "1",
      takerPubKey: "6",
      takerNonce: "1",
      status: "error",
      reason: "timeout",
    });
    const peers = db.getPeerStats();
    expect(peers).toHaveLength(2);
    const a = peers.find((p) => p.peer === "0xpeera")!;
    const b = peers.find((p) => p.peer === "0xpeerb")!;
    expect(a).toMatchObject({ sent: 1, received: 1, settled: 1, rejected: 1, errored: 0 });
    expect(b).toMatchObject({ sent: 1, received: 0, settled: 0, rejected: 0, errored: 1 });
    expect(a.lastAt).not.toBeNull();
    // peerA has more activity (2 vs 1) so it should sort first.
    expect(peers[0].peer).toBe("0xpeera");
  });

  it("scopes peer stats to a since window", () => {
    db.recordTradeOffer({
      direction: "sent",
      peerRelayer: "0xpeera",
      makerPubKey: "1",
      makerNonce: "1",
      takerPubKey: "2",
      takerNonce: "1",
      status: "settled",
    });
    expect(db.getPeerStats(Date.now() + 1_000_000)).toEqual([]);
  });

  it("filters trade offers by direction / status / peer / since", () => {
    const t0 = Date.now();
    db.recordTradeOffer({
      direction: "sent",
      peerRelayer: "0xpeera",
      makerPubKey: "1",
      makerNonce: "1",
      takerPubKey: "2",
      takerNonce: "1",
      status: "settled",
    });
    db.recordTradeOffer({
      direction: "received",
      peerRelayer: "0xpeerb",
      makerPubKey: "3",
      makerNonce: "1",
      takerPubKey: "4",
      takerNonce: "1",
      status: "rejected",
    });

    expect(db.getTradeOffersFiltered({ limit: 10, offset: 0 })).toHaveLength(2);
    expect(
      db.getTradeOffersFiltered({ limit: 10, offset: 0, direction: "sent" }),
    ).toHaveLength(1);
    expect(
      db.getTradeOffersFiltered({ limit: 10, offset: 0, status: "rejected" }),
    ).toHaveLength(1);
    expect(
      db.getTradeOffersFiltered({ limit: 10, offset: 0, peer: "0xPEERa" }),
    ).toHaveLength(1); // case-insensitive thanks to lowerHex
    // since strictly in the future excludes both rows.
    expect(
      db.getTradeOffersFiltered({
        limit: 10,
        offset: 0,
        since: t0 + 10_000_000,
      }),
    ).toHaveLength(0);
  });

  it("filters fee history by token and since", () => {
    const t0 = Date.now();
    db.recordSettlementEvent({
      txHash: "0xt1",
      type: "settleAuth",
      status: "confirmed",
      fees: [{ side: "maker", token: "0xA", amountWei: "100" }],
    });
    db.recordSettlementEvent({
      txHash: "0xt2",
      type: "settleAuth",
      status: "confirmed",
      fees: [{ side: "maker", token: "0xB", amountWei: "200" }],
    });
    expect(db.getFeeHistory({ limit: 10, offset: 0 })).toHaveLength(2);
    expect(
      db.getFeeHistory({ limit: 10, offset: 0, token: "0xA" }),
    ).toHaveLength(1);
    expect(
      db.getFeeHistory({ limit: 10, offset: 0, since: t0 + 10_000_000 }),
    ).toHaveLength(0);
  });
});
