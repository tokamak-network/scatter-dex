/**
 * Exercises the outbox FSM end-to-end against a real (in-memory)
 * SQLite DB so the prepared statements + backoff window are covered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { randomUUID } from "crypto";
import { PrivateOrderDB } from "./db.js";
import { SettlementPushWorker } from "./settlement-push-worker.js";

describe("SettlementPushWorker", () => {
  let dbPath: string;
  let db: PrivateOrderDB;

  beforeEach(() => {
    dbPath = join(tmpdir(), `push-worker-${randomUUID()}.db`);
    db = new PrivateOrderDB(dbPath);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  });

  function makePusher(impl: (payload: unknown) => Promise<boolean>) {
    return { pushSettlement: vi.fn(impl) };
  }

  it("pushes pending rows and marks them succeeded", async () => {
    db.enqueueSettlementPush("0xaaa", { txHash: "0xaaa", value: 1 });
    db.enqueueSettlementPush("0xbbb", { txHash: "0xbbb", value: 2 });
    const pusher = makePusher(async () => true);
    const worker = new SettlementPushWorker({ db, pusher, retryBackoffMs: 0 });

    const result = await worker.tick();

    expect(result).toEqual({ attempted: 2, pushed: 2, failed: 0 });
    expect(pusher.pushSettlement).toHaveBeenCalledTimes(2);
    const stats = db.getSettlementPushOutboxStats();
    expect(stats).toMatchObject({ total: 2, pending: 0, pushed: 2 });
  });

  it("leaves a failed row pending and bumps attempts", async () => {
    db.enqueueSettlementPush("0xccc", { txHash: "0xccc" });
    const pusher = makePusher(async () => false);
    const worker = new SettlementPushWorker({ db, pusher, retryBackoffMs: 0 });

    await worker.tick();

    const stats = db.getSettlementPushOutboxStats();
    expect(stats).toMatchObject({ total: 1, pending: 1, pushed: 0 });
    expect(stats.maxAttempts).toBe(1);
  });

  it("retries after the backoff window elapses", async () => {
    db.enqueueSettlementPush("0xddd", { txHash: "0xddd" });
    const pusher = makePusher(async () => false);
    const worker = new SettlementPushWorker({ db, pusher, retryBackoffMs: 60_000 });

    await worker.tick();
    // Within the backoff window — the row is still pending but should
    // not be re-attempted on the immediate next tick.
    await worker.tick();
    expect(pusher.pushSettlement).toHaveBeenCalledTimes(1);

    // Same worker with a zero backoff — simulates time having passed.
    const eager = new SettlementPushWorker({ db, pusher, retryBackoffMs: 0 });
    await eager.tick();
    expect(pusher.pushSettlement).toHaveBeenCalledTimes(2);
  });

  it("converts a thrown pusher into a recorded failure (worker survives)", async () => {
    db.enqueueSettlementPush("0xeee", { txHash: "0xeee" });
    const pusher = makePusher(async () => {
      throw new Error("connection refused");
    });
    const worker = new SettlementPushWorker({ db, pusher, retryBackoffMs: 0 });

    const result = await worker.tick();

    expect(result).toEqual({ attempted: 1, pushed: 0, failed: 1 });
    expect(db.getSettlementPushOutboxStats()).toMatchObject({ pending: 1, pushed: 0 });
  });

  it("enqueueSettlementPush is idempotent on tx_hash", async () => {
    db.enqueueSettlementPush("0xfff", { txHash: "0xfff", v: 1 });
    db.enqueueSettlementPush("0xfff", { txHash: "0xfff", v: 2 });
    const stats = db.getSettlementPushOutboxStats();
    expect(stats.total).toBe(1);
  });

  it("normalises tx_hash casing across enqueue + mark calls", async () => {
    db.enqueueSettlementPush("0xABC", { txHash: "0xABC" });
    db.markSettlementPushSucceeded("0xabc");
    expect(db.getSettlementPushOutboxStats()).toMatchObject({ pending: 0, pushed: 1 });
  });
});
