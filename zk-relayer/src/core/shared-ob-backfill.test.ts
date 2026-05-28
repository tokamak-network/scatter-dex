/**
 * End-to-end coverage for the shared-OB → local-DB backfill against
 * a real SQLite (no mocking of the persistence layer). The shared-OB
 * client is faked because the network path is already exercised by
 * shared-orderbook-client.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { randomUUID } from "crypto";
import { PrivateOrderDB } from "./db.js";
import { backfillFromSharedOb } from "./shared-ob-backfill.js";

const OUR_ADDR = "0x7099797f5210a8d7a4d2cb5b73b1c8c8d5f7d79c8"; // 42 chars padded for realism

function fakeClient(pages: Array<Array<Record<string, unknown>>>) {
  let call = 0;
  const calls: Array<{ since?: number; limit?: number; offset?: number }> = [];
  return {
    calls,
    fetchSettlementsForAddress: async (
      _addr: string,
      opts: { since?: number; limit?: number; offset?: number },
    ) => {
      calls.push(opts);
      // Each call returns the next page; subsequent calls beyond the
      // provided pages return [] so the loop terminates.
      return pages[call++] ?? [];
    },
  };
}

describe("backfillFromSharedOb", () => {
  let dbPath: string;
  let db: PrivateOrderDB;

  beforeEach(() => {
    dbPath = join(tmpdir(), `backfill-${randomUUID()}.db`);
    db = new PrivateOrderDB(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  });

  it("inserts a cross-token maker-side settle (we're maker)", async () => {
    const sharedClient = fakeClient([
      [
        {
          txHash: "0xaaa",
          makerRelayer: OUR_ADDR,
          takerRelayer: "0xpeer",
          sellToken: "0xUSDC",
          buyToken: "0xWETH",
          sellAmount: "1000000",
          buyAmount: "5000000000000000000",
          feeMaker: "3000",
          feeTaker: "15000000000000000",
          blockNumber: 100,
        },
      ],
    ]);

    const r = await backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR });

    expect(r).toMatchObject({ scanned: 1, inserted: 1, skipped: 0, errors: 0 });
    expect(db.getSettlementByTxHash("0xaaa")).not.toBeNull();
    const fees = db.getFeeTotals();
    // Maker fee accrues in the buy token.
    expect(fees.find((f) => f.token === "0xweth")).toMatchObject({ totalWei: "3000" });
  });

  it("inserts a cross-token taker-side settle (peer submitted)", async () => {
    const sharedClient = fakeClient([
      [
        {
          txHash: "0xbbb",
          makerRelayer: "0xpeer",
          takerRelayer: OUR_ADDR,
          sellToken: "0xUSDC",
          buyToken: "0xWETH",
          sellAmount: "2000000",
          buyAmount: "1000000000000000000",
          feeMaker: "6000",
          feeTaker: "3000000000000000",
        },
      ],
    ]);

    const r = await backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR });

    expect(r).toMatchObject({ inserted: 1 });
    const fees = db.getFeeTotals();
    // Taker fee accrues in our buyToken = row.sellToken = USDC.
    expect(fees.find((f) => f.token === "0xusdc")).toMatchObject({ totalWei: "3000000000000000" });
    expect(fees.find((f) => f.token === "0xweth")).toBeUndefined();
  });

  it("inserts both maker + taker fees for a single-relayer match", async () => {
    const sharedClient = fakeClient([
      [
        {
          txHash: "0xccc",
          makerRelayer: OUR_ADDR,
          takerRelayer: OUR_ADDR,
          sellToken: "0xUSDC",
          buyToken: "0xWETH",
          feeMaker: "1000",
          feeTaker: "2000000000000",
        },
      ],
    ]);

    await backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR });

    const fees = db.getFeeTotals();
    expect(fees.find((f) => f.token === "0xweth")).toMatchObject({ totalWei: "1000" });
    expect(fees.find((f) => f.token === "0xusdc")).toMatchObject({ totalWei: "2000000000000" });
  });

  it("skips a row this DB already has", async () => {
    db.recordSettlementEvent({
      txHash: "0xddd",
      type: "settleAuth",
      status: "confirmed",
    });
    const sharedClient = fakeClient([
      [
        { txHash: "0xddd", makerRelayer: OUR_ADDR, feeMaker: "100", buyToken: "0xUSDC" },
      ],
    ]);

    const r = await backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR });

    expect(r).toMatchObject({ scanned: 1, inserted: 0, skipped: 1 });
  });

  it("skips a row where neither side is us", async () => {
    const sharedClient = fakeClient([
      [
        {
          txHash: "0xeee",
          makerRelayer: "0xpeerA",
          takerRelayer: "0xpeerB",
          sellToken: "0xUSDC",
          buyToken: "0xWETH",
          feeMaker: "100",
          feeTaker: "200",
        },
      ],
    ]);

    const r = await backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR });

    expect(r).toMatchObject({ scanned: 1, inserted: 0, skipped: 1 });
    expect(db.getSettlementByTxHash("0xeee")).toBeNull();
  });

  it("handles a scatterDirect row (taker null, single fee row)", async () => {
    const sharedClient = fakeClient([
      [
        {
          txHash: "0xfff",
          makerRelayer: OUR_ADDR,
          takerRelayer: null,
          sellToken: "0xUSDC",
          buyToken: "0xUSDC",
          sellAmount: "5000000",
          buyAmount: "5000000",
          feeMaker: "15000",
          feeTaker: "0",
        },
      ],
    ]);

    await backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR });

    const row = db.getSettlementByTxHash("0xfff");
    expect(row?.settlement.type).toBe("scatterDirectAuth");
    expect(db.getFeeTotals().find((f) => f.token === "0xusdc")).toMatchObject({
      totalWei: "15000",
    });
  });

  it("pages through multiple result pages until empty", async () => {
    const sharedClient = fakeClient([
      // Page 1: 200 rows → triggers another fetch
      Array.from({ length: 200 }, (_, i) => ({
        txHash: `0x${(i + 1).toString(16).padStart(8, "0")}`,
        makerRelayer: OUR_ADDR,
        buyToken: "0xUSDC",
        feeMaker: "100",
      })),
      // Page 2: 10 rows → less than PAGE_SIZE → loop ends after this page
      Array.from({ length: 10 }, (_, i) => ({
        txHash: `0x${(i + 201).toString(16).padStart(8, "0")}`,
        makerRelayer: OUR_ADDR,
        buyToken: "0xUSDC",
        feeMaker: "100",
      })),
    ]);

    const r = await backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR });

    expect(r.scanned).toBe(210);
    expect(r.inserted).toBe(210);
    expect(r.pages).toBe(2);
  });

  it("converts `since` from unix-ms to unix-seconds before calling shared-OB", async () => {
    const sharedClient = fakeClient([[]]);
    await backfillFromSharedOb(
      { db, sharedClient, ownAddress: OUR_ADDR },
      { since: 1_716_000_000_000 }, // 2024-05-18 in ms
    );
    expect(sharedClient.calls[0].since).toBe(1_716_000_000); // seconds
  });

  it("rejects a non-finite `since`", async () => {
    const sharedClient = fakeClient([]);
    await expect(
      backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR }, { since: NaN }),
    ).rejects.toThrow(/invalid 'since'/);
    await expect(
      backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR }, { since: -1 }),
    ).rejects.toThrow(/invalid 'since'/);
    expect(sharedClient.calls).toHaveLength(0);
  });

  it("matches addresses case-insensitively (mixed-case maker from shared-OB)", async () => {
    const sharedClient = fakeClient([
      [
        {
          txHash: "0xmixed",
          // Same address as OUR_ADDR but with mixed casing (EIP-55-ish).
          makerRelayer: OUR_ADDR.toUpperCase(),
          buyToken: "0xUSDC",
          feeMaker: "100",
        },
      ],
    ]);

    const r = await backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR });

    expect(r).toMatchObject({ inserted: 1 });
  });

  it("counts a corrupt row as an error without aborting the batch", async () => {
    const sharedClient = fakeClient([
      [
        { /* missing txHash */ makerRelayer: OUR_ADDR },
        { txHash: "0x123", makerRelayer: OUR_ADDR, buyToken: "0xUSDC", feeMaker: "1" },
      ],
    ]);

    const r = await backfillFromSharedOb({ db, sharedClient, ownAddress: OUR_ADDR });

    expect(r).toMatchObject({ scanned: 2, inserted: 1, errors: 1 });
  });
});
