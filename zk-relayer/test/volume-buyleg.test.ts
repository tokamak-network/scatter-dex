import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { PrivateOrderDB } from "../src/core/db.js";

// os.tmpdir() over a hardcoded /tmp so the suite runs on non-POSIX CI too.
const TEST_DB = path.join(os.tmpdir(), "zk-relayer-volume-buyleg-test.db");
const WETH = "0x" + "11".repeat(20);
const USDC = "0x" + "22".repeat(20);

function cleanDbFiles(): void {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(TEST_DB + ext);
    } catch {
      /* ignore */
    }
  }
}

describe("getVolumeTotals counts both the sell AND buy leg", () => {
  let db: PrivateOrderDB | null = null;

  // beforeEach/afterEach own the DB lifecycle so a failing assertion can't
  // bypass db.close() and leave the SQLite handle open — an unclosed handle
  // would lock the file and break the cleanup (and the next test's open).
  beforeEach(() => {
    cleanDbFiles();
    db = new PrivateOrderDB(TEST_DB);
  });

  afterEach(() => {
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      db = null;
    }
    cleanDbFiles();
  });

  it("a WETH→USDC settle yields WETH sell volume AND USDC buy volume", () => {
    db!.recordSettlementEvent({
      txHash: "0xabc",
      type: "settleAuth",
      status: "confirmed",
      sellToken: WETH,
      sellAmount: (5n * 10n ** 17n).toString(), // 0.5 WETH
      buyToken: USDC,
      buyAmount: (1800n * 10n ** 6n).toString(), // 1800 USDC
    });
    const totals = db!.getVolumeTotals();
    const weth = totals.find((t) => t.token === WETH.toLowerCase());
    const usdc = totals.find((t) => t.token === USDC.toLowerCase());
    expect(weth?.sellFills).toBe(1);
    expect(weth?.totalSellWei).toBe((5n * 10n ** 17n).toString());
    // Regression guard for the dashboard bug: USDC is only ever the BUY leg
    // here, so it must surface as buy volume — not be missing (which happened
    // when the settle path left buy_token NULL).
    expect(usdc?.buyFills).toBe(1);
    expect(usdc?.totalBuyWei).toBe((1800n * 10n ** 6n).toString());
  });

  it("omitting buyToken records no buy-leg volume (documents the prior bug)", () => {
    db!.recordSettlementEvent({
      txHash: "0xdef",
      type: "settleAuth",
      status: "confirmed",
      sellToken: WETH,
      sellAmount: "100",
      // no buyToken/buyAmount → buy_token stored NULL
    });
    const totals = db!.getVolumeTotals();
    expect(totals.map((t) => t.token)).toEqual([WETH.toLowerCase()]); // no phantom buy token
    expect(totals[0]?.buyFills).toBe(0);
  });
});
