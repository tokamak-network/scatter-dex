/**
 * SettlementWorker tests — exercise the FSM + retry classifier against a
 * real (in-memory) SQLite DB so the queue SQL is covered too.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { randomUUID } from "crypto";
import { PrivateOrderDB } from "./db.js";
import {
  SettlementWorker,
  classifySettleError,
  SETTLEMENT_RETRY_SCHEDULE_MS,
  MAX_SETTLEMENT_ATTEMPTS,
  NO_MATCH_REPOLL_MS,
} from "./settlement-worker.js";
import type {
  AuthorizeOrderFile,
  StoredAuthorizeOrder,
} from "../types/authorize-order.js";

// ─── Test fixtures ──────────────────────────────────────────────

function makeOrder(opts: { nullifier: string; sellToken: string; buyToken: string; sellAmount?: string; buyAmount?: string; maxFee?: string; expiry?: number }): AuthorizeOrderFile {
  const ps = {
    nullifier: opts.nullifier,
    pubKeyBind: "1",
    commitmentRoot: "1",
    nonceNullifier: "1",
    newCommitment: "1",
    sellToken: opts.sellToken,
    buyToken: opts.buyToken,
    sellAmount: opts.sellAmount ?? "1000",
    buyAmount: opts.buyAmount ?? "1000",
    maxFee: opts.maxFee ?? "30",
    expiry: String(opts.expiry ?? Math.floor(Date.now() / 1000) + 3600),
    claimsRoot: "1",
    totalLocked: "1000",
    relayer: "1",
    orderHash: "1",
  };
  return {
    proof: { a: ["1", "2"], b: [["1", "2"], ["3", "4"]], c: ["1", "2"] } as any,
    publicSignals: ps as any,
    publicSignalsArray: Array(14).fill("0"),
  };
}

function makeStored(order: AuthorizeOrderFile, overrides: Partial<StoredAuthorizeOrder> = {}): StoredAuthorizeOrder {
  return {
    order,
    status: "pending",
    submittedAt: Date.now(),
    pubKeyAx: "1",
    pubKeyAy: "2",
    ...overrides,
  };
}

function makeSubmitter(overrides: Partial<{ scatter: any; settle: any }> = {}) {
  return {
    submitScatterDirectAuth: vi.fn(overrides.scatter ?? (async () => "0xSCATTERTX")),
    submitAuthSettle: vi.fn(overrides.settle ?? (async () => "0xSETTLETX")),
    getAddress: () => "0xrelayer",
  } as any;
}

// ─── Test harness ───────────────────────────────────────────────

describe("SettlementWorker", () => {
  let dbPath: string;
  let db: PrivateOrderDB;
  let authorizeOrders: Map<string, StoredAuthorizeOrder>;
  let decPubKeyCount: ReturnType<typeof vi.fn>;
  let findMatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dbPath = join(tmpdir(), `settlement-worker-${randomUUID()}.db`);
    db = new PrivateOrderDB(dbPath);
    authorizeOrders = new Map();
    decPubKeyCount = vi.fn();
    findMatch = vi.fn(() => null);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try { rmSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  });

  function build(submitter: any) {
    return new SettlementWorker({
      db,
      submitter,
      authorizeOrders,
      findMatch: (s) => findMatch(s),
      decPubKeyCount: (ax, ay) => decPubKeyCount(ax, ay),
      nullifierToOfferHandle: (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`,
      getFeeBps: () => 10n,
      pollIntervalMs: 10_000, // tests call tick() directly
    });
  }

  function seed(order: AuthorizeOrderFile, opts: { stored?: boolean } = { stored: true }): void {
    const nullifier = order.publicSignals.nullifier;
    db.insertAcceptedOrder({
      nullifier,
      submittedAt: Date.now(),
      orderJson: JSON.stringify(order),
      pubKeyAx: "1",
      pubKeyAy: "2",
    });
    if (opts.stored) {
      authorizeOrders.set(nullifier, makeStored(order));
    }
  }

  // ─── classifySettleError ──

  describe("classifySettleError", () => {
    it("classifies revert as permanent", () => {
      expect(classifySettleError(new Error("execution reverted: bad nullifier"))).toBe("permanent");
    });
    it("classifies timeout as transient", () => {
      expect(classifySettleError(new Error("operation timeout"))).toBe("transient");
    });
    it("classifies unknown errors", () => {
      expect(classifySettleError(new Error("what the heck"))).toBe("unknown");
    });
    it("handles non-Error throws", () => {
      expect(classifySettleError("plain string")).toBe("unknown");
    });
  });

  // ─── Same-token happy path ──

  it("settles a same-token order and decrements pubKey count", async () => {
    const order = makeOrder({ nullifier: "101", sellToken: "1", buyToken: "1" });
    seed(order);
    const submitter = makeSubmitter();

    await build(submitter).tick();

    expect(submitter.submitScatterDirectAuth).toHaveBeenCalledOnce();
    const row = db.getAuthorizeOrder("101")!;
    expect(row.status).toBe("settled");
    expect(row.settleTx).toBe("0xSCATTERTX");
    expect(decPubKeyCount).toHaveBeenCalledWith("1", "2");
    expect(authorizeOrders.get("101")!.status).toBe("settled");
  });

  // ─── Cross-token paths ──

  it("cross-token with no counterparty defers without bumping attempt", async () => {
    const order = makeOrder({ nullifier: "201", sellToken: "1", buyToken: "2" });
    seed(order);
    findMatch.mockReturnValue(null);
    const submitter = makeSubmitter();

    await build(submitter).tick();

    expect(submitter.submitAuthSettle).not.toHaveBeenCalled();
    const row = db.getAuthorizeOrder("201")!;
    expect(row.status).toBe("accepted");
    expect(row.attempt).toBe(0);
    expect(row.nextRetryAt).not.toBeNull();
    expect(row.nextRetryAt!).toBeGreaterThan(Date.now() + NO_MATCH_REPOLL_MS - 1_000);
    expect(decPubKeyCount).not.toHaveBeenCalled();
  });

  it("cross-token match settles both ends and cancels shared-OB listings", async () => {
    const makerOrder = makeOrder({ nullifier: "301", sellToken: "1", buyToken: "2" });
    const takerOrder = makeOrder({ nullifier: "302", sellToken: "2", buyToken: "1" });
    seed(makerOrder);
    seed(takerOrder);
    const makerStored = authorizeOrders.get("301")!;
    const takerStored = authorizeOrders.get("302")!;
    findMatch.mockReturnValue({ maker: makerStored, taker: takerStored });

    const cancelOrder = vi.fn().mockResolvedValue(undefined);
    const submitter = makeSubmitter();

    const worker = new SettlementWorker({
      db,
      submitter,
      authorizeOrders,
      findMatch: (s) => findMatch(s),
      decPubKeyCount: (ax, ay) => decPubKeyCount(ax, ay),
      sharedClient: { cancelOrder } as any,
      nullifierToOfferHandle: (n) => `0x${BigInt(n).toString(16).padStart(64, "0")}`,
      getFeeBps: () => 10n,
      pollIntervalMs: 10_000,
    });
    // Only the first claimed job drives settlement; the second will be
    // already-settled by then, so tick() is safe either way.
    await worker.tick();

    expect(submitter.submitAuthSettle).toHaveBeenCalledOnce();
    expect(db.getAuthorizeOrder("301")!.status).toBe("settled");
    expect(db.getAuthorizeOrder("302")!.status).toBe("settled");
    expect(makerStored.status).toBe("settled");
    expect(takerStored.status).toBe("settled");
    expect(decPubKeyCount).toHaveBeenCalledTimes(2);
    expect(cancelOrder).toHaveBeenCalledTimes(2);
  });

  // ─── Retry policy ──

  it("transient error schedules retry with backoff and leaves row in retrying", async () => {
    const order = makeOrder({ nullifier: "401", sellToken: "1", buyToken: "1" });
    seed(order);
    const submitter = makeSubmitter({
      scatter: async () => { throw new Error("socket hang up"); },
    });

    const before = Date.now();
    await build(submitter).tick();

    const row = db.getAuthorizeOrder("401")!;
    expect(row.status).toBe("retrying");
    expect(row.attempt).toBe(1);
    expect(row.lastError).toContain("socket hang up");
    expect(row.nextRetryAt!).toBeGreaterThanOrEqual(before + SETTLEMENT_RETRY_SCHEDULE_MS[0] - 100);
  });

  it("exhausted transient retries land in dead_letter", async () => {
    const order = makeOrder({ nullifier: "402", sellToken: "1", buyToken: "1" });
    seed(order);
    // Manually set the row to the last-attempt state so one more failure
    // blows the budget. Going through the retry schedule naturally would
    // require waiting real time.
    db.scheduleAuthorizeOrderRetry({
      nullifier: "402",
      attempt: MAX_SETTLEMENT_ATTEMPTS,
      nextRetryAt: Date.now() - 1,
      error: "prev",
    });

    const submitter = makeSubmitter({
      scatter: async () => { throw new Error("ETIMEDOUT: network timeout"); },
    });
    await build(submitter).tick();

    const row = db.getAuthorizeOrder("402")!;
    expect(row.status).toBe("dead_letter");
    expect(row.lastError).toContain("timeout");
    expect(decPubKeyCount).toHaveBeenCalledWith("1", "2");
  });

  it("permanent error marks failed with no retry", async () => {
    const order = makeOrder({ nullifier: "403", sellToken: "1", buyToken: "1" });
    seed(order);
    const submitter = makeSubmitter({
      scatter: async () => { throw new Error("execution reverted: bad proof"); },
    });

    await build(submitter).tick();

    const row = db.getAuthorizeOrder("403")!;
    expect(row.status).toBe("failed");
    expect(row.attempt).toBe(0); // not bumped
    expect(row.lastError).toContain("reverted");
    expect(decPubKeyCount).toHaveBeenCalledWith("1", "2");
  });

  it("unknown error gets one safety retry then fails", async () => {
    const order = makeOrder({ nullifier: "404", sellToken: "1", buyToken: "1" });
    seed(order);
    const submitter = makeSubmitter({
      scatter: async () => { throw new Error("mystery meat"); },
    });

    const worker = build(submitter);
    // First tick: unknown → retry #1
    await worker.tick();
    let row = db.getAuthorizeOrder("404")!;
    expect(row.status).toBe("retrying");
    expect(row.attempt).toBe(1);

    // Move the retry window to "now" and try again — this time it blows the
    // 1-attempt budget and lands in failed.
    db.scheduleAuthorizeOrderRetry({
      nullifier: "404",
      attempt: 1,
      nextRetryAt: Date.now() - 1,
      error: "mystery meat",
    });
    await worker.tick();
    row = db.getAuthorizeOrder("404")!;
    expect(row.status).toBe("failed");
  });

  // ─── Queue selection ──

  it("only claims rows past their next_retry_at", async () => {
    const readyOrder = makeOrder({ nullifier: "501", sellToken: "1", buyToken: "1" });
    const futureOrder = makeOrder({ nullifier: "502", sellToken: "1", buyToken: "1" });
    seed(readyOrder);
    seed(futureOrder);
    db.scheduleAuthorizeOrderRetry({
      nullifier: "502",
      attempt: 1,
      nextRetryAt: Date.now() + 60_000,
      error: "not yet",
    });

    const submitter = makeSubmitter();
    await build(submitter).tick();

    expect(submitter.submitScatterDirectAuth).toHaveBeenCalledOnce();
    expect(db.getAuthorizeOrder("501")!.status).toBe("settled");
    expect(db.getAuthorizeOrder("502")!.status).toBe("retrying");
  });

  it("handles corrupt order_json by marking the row failed", async () => {
    const order = makeOrder({ nullifier: "601", sellToken: "1", buyToken: "1" });
    db.insertAcceptedOrder({
      nullifier: "601",
      submittedAt: Date.now(),
      orderJson: "{not valid json",
      pubKeyAx: "1",
      pubKeyAy: "2",
    });

    const submitter = makeSubmitter();
    await build(submitter).tick();

    expect(submitter.submitScatterDirectAuth).not.toHaveBeenCalled();
    expect(db.getAuthorizeOrder("601")!.status).toBe("failed");
    void order;
  });
});
