import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { OrderbookDB } from "../src/core/db.js";

const TEST_DB = path.join(os.tmpdir(), "shared-orderbook-cert-db-test.db");
const WALLET = "0x" + "a".repeat(40);

function cleanDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
}

describe("OrderbookDB — CSR + issued certs", () => {
  let db: OrderbookDB;
  beforeEach(() => { cleanDb(); db = new OrderbookDB(TEST_DB); });
  afterEach(() => { db.close(); });
  afterAll(() => { cleanDb(); });

  const insertCsr = (id: string, over: Partial<{ wallet: string; createdAt: number }> = {}) =>
    db.insertCsr({
      id,
      wallet: (over.wallet ?? WALLET).toLowerCase(),
      csrPem: "-----BEGIN CERTIFICATE REQUEST-----\n" + id + "\n-----END CERTIFICATE REQUEST-----",
      commonName: "op@example.com",
      organization: "Tokamak",
      country: "KR",
      createdAt: over.createdAt ?? 100,
    });

  it("inserts and reads a CSR by id and newest-by-wallet (case-insensitive)", () => {
    insertCsr("c1", { createdAt: 100 });
    insertCsr("c2", { createdAt: 200 });
    const byId = db.getCsrById("c1");
    expect(byId?.status).toBe("pending");
    expect(byId?.commonName).toBe("op@example.com");
    expect(byId?.reviewedAt).toBeNull();
    expect(db.getLatestCsrByWallet(WALLET.toUpperCase())?.id).toBe("c2");
  });

  it("setCsrStatus updates status + notes + reviewed_at; false on unknown id", () => {
    insertCsr("c1");
    expect(db.setCsrStatus("c1", "rejected", "subject mismatch", 500)).toBe(true);
    const row = db.getCsrById("c1");
    expect(row?.status).toBe("rejected");
    expect(row?.notes).toBe("subject mismatch");
    expect(row?.reviewedAt).toBe(500);
    expect(db.setCsrStatus("nope", "issued", null, 1)).toBe(false);
  });

  it("listCsr filters by status / wallet, newest-first", () => {
    insertCsr("c1", { wallet: WALLET, createdAt: 100 });
    insertCsr("c2", { wallet: "0x" + "b".repeat(40), createdAt: 200 });
    db.setCsrStatus("c1", "issued", null, 300);
    expect(db.listCsr().map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(db.listCsr({ status: "pending" }).map((c) => c.id)).toEqual(["c2"]);
    expect(db.listCsr({ wallet: WALLET }).map((c) => c.id)).toEqual(["c1"]);
  });

  it("recordIssuedCert stores the cert and flips its CSR to issued in one txn", () => {
    insertCsr("c1");
    db.recordIssuedCert(
      { id: "cert1", csrId: "c1", wallet: WALLET.toLowerCase(), certPem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----", serial: "0a1b", notAfter: 9999, issuedAt: 600 },
      600,
    );
    expect(db.getCsrById("c1")?.status).toBe("issued");
    const cert = db.getIssuedCertByWallet(WALLET.toUpperCase());
    expect(cert?.csrId).toBe("c1");
    expect(cert?.serial).toBe("0a1b");
    expect(cert?.notAfter).toBe(9999);
  });

  it("getIssuedCertByWallet returns the newest issued cert, or null when none", () => {
    expect(db.getIssuedCertByWallet(WALLET)).toBeNull();
    insertCsr("c1");
    insertCsr("c2", { createdAt: 200 });
    db.recordIssuedCert({ id: "e1", csrId: "c1", wallet: WALLET.toLowerCase(), certPem: "a", serial: null, notAfter: null, issuedAt: 100 }, 100);
    db.recordIssuedCert({ id: "e2", csrId: "c2", wallet: WALLET.toLowerCase(), certPem: "b", serial: null, notAfter: null, issuedAt: 200 }, 200);
    expect(db.getIssuedCertByWallet(WALLET)?.id).toBe("e2");
  });
});
