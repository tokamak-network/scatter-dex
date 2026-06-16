import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import { PrivateOrderDB } from "../src/core/db.js";

const TEST_DB = "/tmp/zk-relayer-volume-buyleg-test.db";
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
  afterEach(cleanDbFiles);

  it("a WETH→USDC settle yields WETH sell volume AND USDC buy volume", () => {
    cleanDbFiles();
    const db = new PrivateOrderDB(TEST_DB);
    db.recordSettlementEvent({
      txHash: "0xabc",
      type: "settleAuth",
      status: "confirmed",
      sellToken: WETH,
      sellAmount: (5n * 10n ** 17n).toString(), // 0.5 WETH
      buyToken: USDC,
      buyAmount: (1800n * 10n ** 6n).toString(), // 1800 USDC
    });
    const totals = db.getVolumeTotals();
    const weth = totals.find((t) => t.token === WETH.toLowerCase());
    const usdc = totals.find((t) => t.token === USDC.toLowerCase());
    expect(weth?.sellFills).toBe(1);
    expect(weth?.totalSellWei).toBe((5n * 10n ** 17n).toString());
    // Regression guard for the dashboard bug: USDC is only ever the BUY leg
    // here, so it must surface as buy volume — not be missing (which happened
    // when the settle path left buy_token NULL).
    expect(usdc?.buyFills).toBe(1);
    expect(usdc?.totalBuyWei).toBe((1800n * 10n ** 6n).toString());
    db.close();
  });

  it("omitting buyToken records no buy-leg volume (documents the prior bug)", () => {
    cleanDbFiles();
    const db = new PrivateOrderDB(TEST_DB);
    db.recordSettlementEvent({
      txHash: "0xdef",
      type: "settleAuth",
      status: "confirmed",
      sellToken: WETH,
      sellAmount: "100",
      // no buyToken/buyAmount → buy_token stored NULL
    });
    const totals = db.getVolumeTotals();
    expect(totals.map((t) => t.token)).toEqual([WETH.toLowerCase()]); // no phantom buy token
    expect(totals[0]?.buyFills).toBe(0);
    db.close();
  });
});
