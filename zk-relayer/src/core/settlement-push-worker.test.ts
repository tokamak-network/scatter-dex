/**
 * Exercises the outbox FSM end-to-end against a real (in-memory)
 * SQLite DB so the prepared statements + backoff window are covered.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { randomUUID } from "crypto";
import { MAX_PUSH_ATTEMPTS, PrivateOrderDB } from "./db.js";
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

  it("prunes acknowledged rows older than the configured window", async () => {
    db.enqueueSettlementPush("0x111", { txHash: "0x111" });
    db.enqueueSettlementPush("0x222", { txHash: "0x222" });
    db.markSettlementPushSucceeded("0x111");
    // Pending row stays untouched even with a 0-ms retention window.
    const pruned = db.prunePushedSettlementPushes(0);
    expect(pruned).toBe(1);
    const stats = db.getSettlementPushOutboxStats();
    expect(stats).toMatchObject({ total: 1, pending: 1, pushed: 0 });
  });

  it("worker auto-prunes on the configured cadence", async () => {
    db.enqueueSettlementPush("0x333", { txHash: "0x333" });
    const pusher = makePusher(async () => true);
    const worker = new SettlementPushWorker({
      db,
      pusher,
      retryBackoffMs: 0,
      prunePushedAfterMs: 0,
      pruneEveryTicks: 1,
    });
    await worker.tick();
    // First tick pushed + then pruned immediately. Outbox is empty.
    expect(db.getSettlementPushOutboxStats()).toMatchObject({ total: 0, pending: 0, pushed: 0 });
  });

  it("excludes rows past MAX_PUSH_ATTEMPTS from the claim query", async () => {
    db.enqueueSettlementPush("0x444", { txHash: "0x444" });
    // Simulate the worker having burnt every retry. The row stays in
    // the table (visible in stats as `dead`) but no longer gets
    // claimed by getPendingSettlementPushes.
    for (let i = 0; i < MAX_PUSH_ATTEMPTS; i++) {
      db.markSettlementPushFailed("0x444", `attempt ${i}`);
    }
    const claimed = db.getPendingSettlementPushes(10, 0);
    expect(claimed).toHaveLength(0);
    expect(db.getSettlementPushOutboxStats()).toMatchObject({
      total: 1,
      pending: 0,
      dead: 1,
      pushed: 0,
    });
  });

  it("markSettlementPushDead immediately excludes the row", async () => {
    db.enqueueSettlementPush("0x555", { txHash: "0x555" });
    db.markSettlementPushDead("0x555", "schema mismatch");
    expect(db.getPendingSettlementPushes(10, 0)).toHaveLength(0);
    expect(db.getSettlementPushOutboxStats()).toMatchObject({ dead: 1, pending: 0 });
  });

  it("corrupt JSON in the outbox is marked dead, not retried each tick", async () => {
    db.enqueueSettlementPush("0x666", { txHash: "0x666" });
    // Surgically corrupt the row's payload to simulate disk bitrot.
    const raw = (db as unknown as { db: { exec: (sql: string) => void } }).db;
    raw.exec(`UPDATE settlement_push_outbox SET payload_json = 'not-json' WHERE tx_hash = '0x666'`);

    const pusher = makePusher(async () => true);
    const worker = new SettlementPushWorker({ db, pusher, retryBackoffMs: 0 });

    await worker.tick();
    await worker.tick();
    expect(pusher.pushSettlement).not.toHaveBeenCalled();
    expect(db.getSettlementPushOutboxStats()).toMatchObject({ dead: 1, pending: 0 });
  });

  it("normalises tx_hash casing across enqueue + mark calls", async () => {
    db.enqueueSettlementPush("0xABC", { txHash: "0xABC" });
    db.markSettlementPushSucceeded("0xabc");
    expect(db.getSettlementPushOutboxStats()).toMatchObject({ pending: 0, pushed: 1 });
  });
});
