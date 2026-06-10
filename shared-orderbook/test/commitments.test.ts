import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import express from "express";
import fs from "fs";
import { OrderbookDB } from "../src/core/db.js";
import { createCommitmentRoutes } from "../src/routes/commitments.js";
import {
  runCommitmentIndexPass,
  type CommitmentFetcher,
} from "../src/core/commitment-indexer.js";
import type { CommitmentLeaf } from "../src/types/commitment.js";

const TEST_DB = "/tmp/shared-orderbook-commitments-test.db";
const PORT = 14593;
const CHAIN = 11155111;
const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

function leaf(i: number, block = 1000 + i): CommitmentLeaf {
  return { leafIndex: i, commitment: "0x" + (i + 1).toString(16), blockNumber: block };
}

function cleanDbFiles() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
}

describe("commitments DB layer", () => {
  let db: OrderbookDB;
  beforeEach(() => {
    cleanDbFiles();
    db = new OrderbookDB(TEST_DB);
  });

  it("upserts idempotently on (chainId, leafIndex)", () => {
    db.upsertCommitments(CHAIN, [leaf(0), leaf(1), leaf(2)]);
    db.upsertCommitments(CHAIN, [leaf(1), leaf(2)]); // re-scan overlap
    expect(db.commitmentCount(CHAIN)).toBe(3); // no duplicates
  });

  it("lists from fromLeaf ascending, capped by limit", () => {
    db.upsertCommitments(CHAIN, [leaf(0), leaf(1), leaf(2), leaf(3)]);
    const page = db.listCommitments(CHAIN, 1, 2);
    expect(page.map((r) => r.leafIndex)).toEqual([1, 2]);
    const tail = db.listCommitments(CHAIN, 3, 100);
    expect(tail.map((r) => r.leafIndex)).toEqual([3]);
  });

  it("scopes rows by chainId", () => {
    db.upsertCommitments(CHAIN, [leaf(0), leaf(1)]);
    db.upsertCommitments(999, [leaf(0)]);
    expect(db.commitmentCount(CHAIN)).toBe(2);
    expect(db.commitmentCount(999)).toBe(1);
  });

  it("tracks the scan cursor per chain", () => {
    expect(db.getCommitmentCursor(CHAIN)).toBeNull();
    db.setCommitmentCursor(CHAIN, 11_020_000);
    expect(db.getCommitmentCursor(CHAIN)).toBe(11_020_000);
    db.setCommitmentCursor(CHAIN, 11_030_000); // upsert
    expect(db.getCommitmentCursor(CHAIN)).toBe(11_030_000);
  });

  afterAll(cleanDbFiles);
});

describe("runCommitmentIndexPass", () => {
  let db: OrderbookDB;
  beforeEach(() => {
    cleanDbFiles();
    db = new OrderbookDB(TEST_DB);
  });

  /** Fetcher that records its windows and returns one leaf per window,
   *  leafIndex derived from the window start so order is observable. */
  function recordingFetcher(): { fetcher: CommitmentFetcher; windows: Array<[number, number]> } {
    const windows: Array<[number, number]> = [];
    let nextLeaf = 0;
    const fetcher: CommitmentFetcher = async (from, to) => {
      windows.push([from, to]);
      return [leaf(nextLeaf++, from)];
    };
    return { fetcher, windows };
  }

  it("walks from deployBlock in chunkSize windows and advances the cursor", async () => {
    const { fetcher, windows } = recordingFetcher();
    const stats = await runCommitmentIndexPass(db, fetcher, {
      chainId: CHAIN,
      poolAddress: "0x" + "44".repeat(20),
      deployBlock: 100,
      toBlock: 100_100,
      chunkSize: 50_000,
    });
    expect(windows).toEqual([
      [100, 50_099],
      [50_100, 100_099],
      [100_100, 100_100],
    ]);
    expect(stats.indexed).toBe(3);
    expect(db.getCommitmentCursor(CHAIN)).toBe(100_100); // last window end
    expect(db.commitmentCount(CHAIN)).toBe(3);
  });

  it("resumes from cursor+1 on the next pass (no re-backfill)", async () => {
    db.setCommitmentCursor(CHAIN, 60_000);
    const { fetcher, windows } = recordingFetcher();
    await runCommitmentIndexPass(db, fetcher, {
      chainId: CHAIN,
      poolAddress: "0x" + "44".repeat(20),
      deployBlock: 100,
      toBlock: 70_000,
      chunkSize: 50_000,
    });
    // Starts at cursor+1 = 60_001, NOT deployBlock.
    expect(windows).toEqual([[60_001, 70_000]]);
  });

  it("does nothing when already caught up (from > to)", async () => {
    db.setCommitmentCursor(CHAIN, 70_000);
    const { fetcher, windows } = recordingFetcher();
    const stats = await runCommitmentIndexPass(db, fetcher, {
      chainId: CHAIN,
      poolAddress: "0x" + "44".repeat(20),
      deployBlock: 100,
      toBlock: 70_000,
      chunkSize: 50_000,
    });
    expect(windows).toEqual([]);
    expect(stats.indexed).toBe(0);
  });

  afterAll(cleanDbFiles);
});

describe("GET /api/commitments", () => {
  let server: http.Server;
  let db: OrderbookDB;

  beforeAll(async () => {
    cleanDbFiles();
    db = new OrderbookDB(TEST_DB);
    db.upsertCommitments(CHAIN, [leaf(0), leaf(1), leaf(2)]);
    const app = express();
    app.use("/api/commitments", createCommitmentRoutes(db, noopLimiter));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    cleanDbFiles();
  });

  it("returns leaves with total, defaulting chainId", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/commitments?chainId=${CHAIN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.commitments.map((c: CommitmentLeaf) => c.leafIndex)).toEqual([0, 1, 2]);
  });

  it("pages via fromLeaf", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/commitments?chainId=${CHAIN}&fromLeaf=2`);
    const body = await res.json();
    expect(body.fromLeaf).toBe(2);
    expect(body.commitments.map((c: CommitmentLeaf) => c.leafIndex)).toEqual([2]);
  });

  it("400s on a negative fromLeaf", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/commitments?chainId=${CHAIN}&fromLeaf=-1`);
    expect(res.status).toBe(400);
  });

  it("400s on an invalid chainId", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/commitments?chainId=abc`);
    expect(res.status).toBe(400);
  });
});
