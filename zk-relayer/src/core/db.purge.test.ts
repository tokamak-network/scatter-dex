/**
 * Purge retention tests — guard the mobile polling contract that
 * terminal authorize_orders rows must stick around long enough for the
 * client to observe the final status before deletion.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync } from "fs";
import { randomUUID } from "crypto";
import { PrivateOrderDB } from "./db.js";

const ONE_HOUR_MS = 60 * 60 * 1000;

function makeOrderJson(expirySecs: number): string {
  return JSON.stringify({
    publicSignals: { expiry: String(expirySecs) },
  });
}

describe("PrivateOrderDB.purgeNonPendingAuthorizeOrdersDB", () => {
  let dbPath: string;
  let db: PrivateOrderDB;

  beforeEach(() => {
    dbPath = join(tmpdir(), `purge-test-${randomUUID()}.sqlite`);
    db = new PrivateOrderDB(dbPath);
  });

  afterEach(() => {
    db.close();
    try { rmSync(dbPath, { force: true }); } catch { /* noop */ }
  });

  it("retains terminal rows inside the 1h grace window", () => {
    const nullifier = "1";
    const expiryFuture = Math.floor(Date.now() / 1000) + 3600;
    db.insertAcceptedOrder({
      nullifier,
      submittedAt: Date.now(),
      orderJson: makeOrderJson(expiryFuture),
    });
    db.markAuthorizeOrderSettled(nullifier, "0xdeadbeef");

    const removed = db.purgeNonPendingAuthorizeOrdersDB();

    expect(removed).toBe(0);
    expect(db.getAuthorizeOrder(nullifier)?.status).toBe("settled");
  });

  it("deletes terminal rows once updated_at is older than the grace window", () => {
    const nullifier = "2";
    const expiryFuture = Math.floor(Date.now() / 1000) + 3600;
    db.insertAcceptedOrder({
      nullifier,
      submittedAt: Date.now(),
      orderJson: makeOrderJson(expiryFuture),
    });
    db.markAuthorizeOrderFailed(nullifier, "boom");

    // Rewind updated_at past the 1h retention window.
    (db as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } })
      .db.prepare("UPDATE authorize_orders SET updated_at = ? WHERE nullifier = ?")
      .run(Date.now() - (ONE_HOUR_MS + 60_000), nullifier);

    const removed = db.purgeNonPendingAuthorizeOrdersDB();

    expect(removed).toBe(1);
    expect(db.getAuthorizeOrder(nullifier)).toBeNull();
  });

  it("does NOT delete live rows whose circuit expiry has passed (sweeper owns that transition)", () => {
    const nullifier = "3";
    const expiryPast = Math.floor(Date.now() / 1000) - 60;
    db.insertAcceptedOrder({
      nullifier,
      submittedAt: Date.now(),
      orderJson: makeOrderJson(expiryPast),
    });
    // Row is still 'accepted'. The immediate-delete branch used to drop
    // this kind of row directly and race the sweeper; the new SQL leaves
    // it alone and waits for sweepExpiredAuth → 'expired' → grace window.

    const removed = db.purgeNonPendingAuthorizeOrdersDB();

    expect(removed).toBe(0);
    expect(db.getAuthorizeOrder(nullifier)?.status).toBe("accepted");
  });

  it("updateAuthorizeOrderStatus bumps updated_at so the grace window starts from the transition", () => {
    const nullifier = "4";
    const expiryFuture = Math.floor(Date.now() / 1000) + 3600;
    const longAgo = Date.now() - (ONE_HOUR_MS + 60_000);
    db.saveAuthorizeOrder(nullifier, "pending", longAgo, makeOrderJson(expiryFuture));

    // Legacy code path: mark settled via updateAuthorizeOrderStatus.
    db.updateAuthorizeOrderStatus(nullifier, "settled", "0xabc");

    // Even though saveAuthorizeOrder seeded updated_at=longAgo, the
    // status mutation must refresh it so the grace window starts NOW.
    const removed = db.purgeNonPendingAuthorizeOrdersDB();

    expect(removed).toBe(0);
    expect(db.getAuthorizeOrder(nullifier)?.status).toBe("settled");
  });
});
