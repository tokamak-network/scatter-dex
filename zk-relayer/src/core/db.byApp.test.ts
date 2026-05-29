/**
 * Pay/Pro (byApp) split — guards the [All / Pay / Pro] leaderboard
 * surface so a flow-type tagging regression breaks here instead of in
 * the operators UI. The split discriminator is settlement_history.type:
 *   - 'settleAuth'        → Pro
 *   - 'scatterDirectAuth' → Pay
 * Other types are ignored (no third bucket).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { randomUUID } from "crypto";
import { PrivateOrderDB } from "./db.js";

describe("PrivateOrderDB.getStatsByApp", () => {
  let dbPath: string;
  let db: PrivateOrderDB;

  beforeEach(() => {
    dbPath = join(tmpdir(), `byapp-test-${randomUUID()}.sqlite`);
    db = new PrivateOrderDB(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath, { force: true }); } catch { /* noop */ }
  });

  it("splits counts, volume, and fees by settlement type", () => {
    // Pay (scatterDirectAuth) — 1 confirmed payroll-style payout.
    db.recordSettlementEvent({
      txHash: "0xpay1",
      type: "scatterDirectAuth",
      status: "confirmed",
      sellToken: "0xusdc",
      sellAmount: "11200000",
      fees: [{ side: "scatterDirect", token: "0xusdc", amountWei: "33750" }],
    });
    // Pro (settleAuth) — 1 confirmed half-proof match.
    db.recordSettlementEvent({
      txHash: "0xpro1",
      type: "settleAuth",
      status: "confirmed",
      sellToken: "0xweth",
      sellAmount: "1000000000000000000",
      fees: [
        { side: "maker", token: "0xweth", amountWei: "5000" },
        { side: "taker", token: "0xweth", amountWei: "5000" },
      ],
    });
    // Pro (settleAuth) — 1 failed attempt; counts toward totalOrders
    // but not settledOrders / volume / fees.
    db.recordSettlementEvent({
      txHash: "0xpro2",
      type: "settleAuth",
      status: "failed",
      sellToken: "0xweth",
      sellAmount: "500000000000000000",
    });

    const out = db.getStatsByApp();

    expect(out.pay).toEqual({
      totalOrders: 1,
      settledOrders: 1,
      settledVolume: [
        { sellToken: "0xusdc", count: 1, totalVolume: "11200000" },
      ],
      feeTotals: [
        { token: "0xusdc", count: 1, totalWei: "33750" },
      ],
    });

    expect(out.pro.totalOrders).toBe(2);
    expect(out.pro.settledOrders).toBe(1);
    expect(out.pro.settledVolume).toEqual([
      { sellToken: "0xweth", count: 1, totalVolume: "1000000000000000000" },
    ]);
    // Maker + taker fee rows sum into one per-token entry.
    expect(out.pro.feeTotals).toEqual([
      { token: "0xweth", count: 2, totalWei: "10000" },
    ]);
  });

  it("returns zeroed buckets when no settlements exist", () => {
    const out = db.getStatsByApp();
    expect(out.pay).toEqual({
      totalOrders: 0,
      settledOrders: 0,
      settledVolume: [],
      feeTotals: [],
    });
    expect(out.pro).toEqual({
      totalOrders: 0,
      settledOrders: 0,
      settledVolume: [],
      feeTotals: [],
    });
  });
});
