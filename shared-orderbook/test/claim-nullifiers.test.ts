import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import express from "express";
import fs from "fs";
import { OrderbookDB } from "../src/core/db.js";
import { createClaimNullifierRoutes } from "../src/routes/claim-nullifiers.js";
import { Interface, id } from "ethers";
import {
  PRIVATE_CLAIM_ABI,
  runClaimIndexPass,
  type ClaimNullifierFetcher,
} from "../src/core/claim-indexer.js";
import type { ClaimNullifierRow } from "../src/types/claim.js";

const TEST_DB = "/tmp/shared-orderbook-claim-nullifiers-test.db";
const PORT = 14594;
const CHAIN = 11155111;
const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

/** Deterministic bytes32 nullifier from a small index. */
function nul(i: number): string {
  return "0x" + i.toString(16).padStart(64, "0");
}
function row(i: number, block = 1000 + i): ClaimNullifierRow {
  return { nullifier: nul(i), blockNumber: block };
}

function cleanDbFiles() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
}

describe("claim-nullifiers DB layer", () => {
  let db: OrderbookDB;
  beforeEach(() => {
    cleanDbFiles();
    db = new OrderbookDB(TEST_DB);
  });
  afterEach(() => db.close());

  it("upserts idempotently on (chainId, nullifier)", () => {
    db.upsertClaimNullifiers(CHAIN, [row(0), row(1), row(2)]);
    db.upsertClaimNullifiers(CHAIN, [row(1), row(2)]); // re-scan overlap
    const spent = db.getSpentClaimNullifiers(CHAIN, [nul(0), nul(1), nul(2)]);
    expect(spent.sort()).toEqual([nul(0), nul(1), nul(2)].sort());
  });

  it("returns only the spent subset of the queried nullifiers", () => {
    db.upsertClaimNullifiers(CHAIN, [row(0), row(2)]);
    const spent = db.getSpentClaimNullifiers(CHAIN, [nul(0), nul(1), nul(2), nul(3)]);
    expect(spent.sort()).toEqual([nul(0), nul(2)].sort());
  });

  it("matches case-insensitively (stored + queried are normalised to lowercase)", () => {
    db.upsertClaimNullifiers(CHAIN, [{ nullifier: nul(7).toUpperCase().replace("0X", "0x"), blockNumber: 5 }]);
    const spent = db.getSpentClaimNullifiers(CHAIN, [nul(7).toUpperCase().replace("0X", "0x")]);
    expect(spent).toEqual([nul(7)]);
  });

  it("returns [] for an empty query (no SQL)", () => {
    db.upsertClaimNullifiers(CHAIN, [row(0)]);
    expect(db.getSpentClaimNullifiers(CHAIN, [])).toEqual([]);
  });

  it("scopes rows by chainId", () => {
    db.upsertClaimNullifiers(CHAIN, [row(0), row(1)]);
    db.upsertClaimNullifiers(999, [row(0)]);
    expect(db.getSpentClaimNullifiers(CHAIN, [nul(1)])).toEqual([nul(1)]);
    expect(db.getSpentClaimNullifiers(999, [nul(1)])).toEqual([]);
  });

  it("tracks the scan cursor per chain", () => {
    expect(db.getClaimCursor(CHAIN)).toBeNull();
    db.setClaimCursor(CHAIN, 11_020_000);
    expect(db.getClaimCursor(CHAIN)).toBe(11_020_000);
    db.setClaimCursor(CHAIN, 11_030_000); // upsert
    expect(db.getClaimCursor(CHAIN)).toBe(11_030_000);
  });

  afterAll(cleanDbFiles);
});

describe("claim indexer event ABI", () => {
  it("matches the on-chain PrivateClaim topic0 (full signature)", () => {
    // A truncated fragment hashes to a different topic0, so queryFilter would
    // match no logs and the indexer would silently index nothing. Guard it.
    const topic = new Interface(PRIVATE_CLAIM_ABI).getEvent("PrivateClaim")!.topicHash;
    expect(topic).toBe(id("PrivateClaim(bytes32,bytes32,address,address,uint256)"));
  });
});

describe("runClaimIndexPass", () => {
  let db: OrderbookDB;
  beforeEach(() => {
    cleanDbFiles();
    db = new OrderbookDB(TEST_DB);
  });
  afterEach(() => db.close());

  /** Fetcher that records its windows and returns one nullifier per window,
   *  derived from the window start so order is observable. */
  function recordingFetcher(): { fetcher: ClaimNullifierFetcher; windows: Array<[number, number]> } {
    const windows: Array<[number, number]> = [];
    let next = 0;
    const fetcher: ClaimNullifierFetcher = async (from, to) => {
      windows.push([from, to]);
      return [row(next++, from)];
    };
    return { fetcher, windows };
  }

  it("walks from deployBlock in chunkSize windows and advances the cursor", async () => {
    const { fetcher, windows } = recordingFetcher();
    const stats = await runClaimIndexPass(db, fetcher, {
      chainId: CHAIN,
      settlementAddress: "0x" + "55".repeat(20),
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
    expect(db.getClaimCursor(CHAIN)).toBe(100_100); // last window end
    expect(db.getSpentClaimNullifiers(CHAIN, [nul(0), nul(1), nul(2)]).length).toBe(3);
  });

  it("resumes from cursor+1 on the next pass (no re-backfill)", async () => {
    db.setClaimCursor(CHAIN, 60_000);
    const { fetcher, windows } = recordingFetcher();
    await runClaimIndexPass(db, fetcher, {
      chainId: CHAIN,
      settlementAddress: "0x" + "55".repeat(20),
      deployBlock: 100,
      toBlock: 70_000,
      chunkSize: 50_000,
    });
    expect(windows).toEqual([[60_001, 70_000]]);
  });

  it("does nothing when already caught up (from > to)", async () => {
    db.setClaimCursor(CHAIN, 70_000);
    const { fetcher, windows } = recordingFetcher();
    const stats = await runClaimIndexPass(db, fetcher, {
      chainId: CHAIN,
      settlementAddress: "0x" + "55".repeat(20),
      deployBlock: 100,
      toBlock: 70_000,
      chunkSize: 50_000,
    });
    expect(windows).toEqual([]);
    expect(stats.indexed).toBe(0);
  });

  afterAll(cleanDbFiles);
});

describe("GET /api/claim-nullifiers", () => {
  let server: http.Server;
  let db: OrderbookDB;

  beforeAll(async () => {
    cleanDbFiles();
    db = new OrderbookDB(TEST_DB);
    db.upsertClaimNullifiers(CHAIN, [row(0), row(2)]);
    const app = express();
    app.use(express.json());
    app.use("/api/claim-nullifiers", createClaimNullifierRoutes(db, noopLimiter));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    cleanDbFiles();
  });

  it("returns only the spent subset", async () => {
    const q = [nul(0), nul(1), nul(2), nul(3)].join(",");
    const res = await fetch(`http://localhost:${PORT}/api/claim-nullifiers?chainId=${CHAIN}&nullifiers=${q}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chainId).toBe(CHAIN);
    expect(body.spent.sort()).toEqual([nul(0), nul(2)].sort());
  });

  it("400s when nullifiers is missing", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/claim-nullifiers?chainId=${CHAIN}`);
    expect(res.status).toBe(400);
  });

  it("400s on a malformed nullifier", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/claim-nullifiers?chainId=${CHAIN}&nullifiers=0xdeadbeef`);
    expect(res.status).toBe(400);
  });

  it("400s on an invalid chainId", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/claim-nullifiers?chainId=abc&nullifiers=${nul(0)}`);
    expect(res.status).toBe(400);
  });

  it("POST returns the spent subset for a JSON array (batch path)", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/claim-nullifiers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: CHAIN, nullifiers: [nul(0), nul(1), nul(2), nul(3)] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.spent.sort()).toEqual([nul(0), nul(2)].sort());
  });

  it("POST 400s when nullifiers is not an array", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/claim-nullifiers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: CHAIN, nullifiers: nul(0) }),
    });
    expect(res.status).toBe(400);
  });

  it("POST 400s on a malformed nullifier in the array", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/claim-nullifiers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chainId: CHAIN, nullifiers: [nul(0), "0xdeadbeef"] }),
    });
    expect(res.status).toBe(400);
  });
});
