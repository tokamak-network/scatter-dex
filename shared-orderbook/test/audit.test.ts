import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { Wallet } from "ethers";
import { OrderbookDB } from "../src/core/db.js";
import { createKycRoutes } from "../src/routes/kyc.js";
import { createCaRoutes } from "../src/routes/ca.js";
import { createAdminRoutes } from "../src/routes/admin.js";
import { makeAdminAuth } from "../src/middleware/admin-auth.js";
import { makeAdminSiweFromAllowlist } from "../src/core/admin-siwe.js";
import { VerifyMonitor } from "../src/core/verify-runtime.js";
import { config } from "../src/config.js";

const TEST_DB = path.join(os.tmpdir(), "shared-orderbook-audit-test.db");
const UPLOAD_DIR = path.join(os.tmpdir(), "audit-test-uploads");
const STATIC_TOKEN = "audit-static-token";
const noop: express.RequestHandler = (_req, _res, next) => next();
const adminWallet = new Wallet("0x" + "ab".repeat(32));

// A self-signed Root CA (CA:TRUE), reused from the CA suite fixtures.
const CA_DER_B64 =
  "MIIDVzCCAj+gAwIBAgIUHvIvd1SS+rkKEnSsefjbEIw1jgEwDQYJKoZIhvcNAQELBQAwOzEaMBgGA1UEAwwRemtTY2F0dGVyIFJvb3QgQ0ExEDAOBgNVBAoMB1Rva2FtYWsxCzAJBgNVBAYTAktSMB4XDTI2MDYwMTA4NTIwOVoXDTM2MDUyOTA4NTIwOVowOzEaMBgGA1UEAwwRemtTY2F0dGVyIFJvb3QgQ0ExEDAOBgNVBAoMB1Rva2FtYWsxCzAJBgNVBAYTAktSMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAv59AJsLibY8yeUMn1uHdm6orEIhY3L34R7dQW00SC7BvKN+GV2xob8qPWFs6C3Da0yAUm3v1iNVrNFcafczuGByQqzRqk8l3PiqI0yo26KGnu9BCjfq+I+BeJLTBL2YLaU9VXYMk43KN8EvzLeUWPm91ULOyeMFNmf2d/818IhQhzgnk5ursV4kCrTpclCjhr6V5VteXY49Xhy1wh5GLtDkr/ByzprHtt8Htg4EHiili12ZKkRd13RXZnv/+p2zDCvsEhIXhQtjzMDJY9L/QxQFXfYHRmr4CiQcIl+KtMETj5/obUzzSx6ENBsD9co0sVHjr3lBIanqFB+dDFgWChwIDAQABo1MwUTAdBgNVHQ4EFgQUQvPsOizs16+K0hatFq8MWg52SVowHwYDVR0jBBgwFoAUQvPsOizs16+K0hatFq8MWg52SVowDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEACIX14fZtYNK3O0MgRwbd6dNj1J7g2VANOpB0FXPIMNrDWUh5SHGgIKPQh39zrLm95U/EC/yLSyrO94h8qSVM8gIRztHy4DrjJfSn42Xr4v3ubTiHaCnbCGuy34rPQspkTEuQcj8jMXBfS4KtZlkPd3U2p69Hkq0+VrxaTDgaXUKRyu6uoC1mHs//znwVqU3+vjna99G9m4yhyeCzGf0afeKMBCR9uuxnz3y5a7yUUIdG5Do77nlB4ZV+apUB8KWmXD7Y6UcDWJMgoNa9vBMrOFkharz0+86zFggux/iZ95wsl9eaeiEMBtp96d8pT0ys/gTnuH+V3SxMSfErQQ22Uw==";

function cleanDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
}

// ── DB-layer unit tests ──────────────────────────────────────────────────
describe("OrderbookDB — audit log", () => {
  let db: OrderbookDB;
  beforeEach(() => { cleanDb(); db = new OrderbookDB(TEST_DB); });
  afterEach(() => { db.close(); });
  afterAll(() => { cleanDb(); });

  it("appends and lists entries newest-first", () => {
    db.recordAudit({ ts: 100, actor: "0xa", action: "kyc.approved", targetType: "kyc", targetId: "s1" });
    db.recordAudit({ ts: 200, actor: null, action: "rootca.published", targetType: "root_ca", targetId: "fp" });
    const all = db.listAudit();
    expect(all.map((e) => e.action)).toEqual(["rootca.published", "kyc.approved"]);
    expect(all[1].actor).toBe("0xa");
    expect(all[0].actor).toBeNull();
  });

  it("filters by action / targetType / targetId", () => {
    db.recordAudit({ ts: 1, actor: "0xa", action: "kyc.approved", targetType: "kyc", targetId: "s1" });
    db.recordAudit({ ts: 2, actor: "0xa", action: "kyc.revoked", targetType: "kyc", targetId: "s1" });
    db.recordAudit({ ts: 3, actor: "0xa", action: "rootca.published", targetType: "root_ca", targetId: "fp" });
    expect(db.listAudit({ action: "kyc.revoked" })).toHaveLength(1);
    expect(db.listAudit({ targetType: "kyc" })).toHaveLength(2);
    expect(db.listAudit({ targetId: "fp" })).toHaveLength(1);
  });

  it("is append-only (no update/delete surface)", () => {
    const db2 = db as unknown as Record<string, unknown>;
    expect(typeof db2.recordAudit).toBe("function");
    expect(db2.updateAudit).toBeUndefined();
    expect(db2.deleteAudit).toBeUndefined();
  });
});

// ── HTTP integration ─────────────────────────────────────────────────────
describe("audit log wiring (KYC + Root CA → /api/admin/audit)", () => {
  let server: http.Server;
  let db: OrderbookDB;
  let port: number;

  function submitForm(wallet: string) {
    const form = new FormData();
    form.append("wallet", wallet);
    form.append("email", "op@example.com");
    form.append("video", new Blob([new Uint8Array([1, 2, 3])], { type: "video/webm" }), "v.webm");
    form.append("idDoc", new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }), "d.png");
    return fetch(`http://localhost:${port}/api/kyc/submit`, { method: "POST", body: form });
  }
  async function getSession(wallet: Wallet) {
    const ch = await (await fetch(`http://localhost:${port}/api/admin/challenge`)).json();
    const signature = await wallet.signMessage(ch.message);
    const res = await fetch(`http://localhost:${port}/api/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: ch.nonce, message: ch.message, signature }),
    });
    return (await res.json()).token as string;
  }

  beforeAll(async () => {
    cleanDb();
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    config.kycUploadDir = UPLOAD_DIR;
    db = new OrderbookDB(TEST_DB);
    const siwe = makeAdminSiweFromAllowlist([adminWallet.address])!;
    const adminAuth = makeAdminAuth({ siwe, staticToken: STATIC_TOKEN });
    const app = express();
    app.use(express.json());
    app.use("/api/admin", createAdminRoutes({ db, monitor: new VerifyMonitor(), adminAuth, siwe, writeLimiter: noop }));
    app.use("/api/kyc", createKycRoutes(db, noop, noop, adminAuth));
    app.use("/api/ca", createCaRoutes(db, adminAuth, noop, noop));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    cleanDb();
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  });

  it("records a KYC status decision with the SIWE admin as actor", async () => {
    const wallet = "0x" + "c1".repeat(20);
    const sub = await (await submitForm(wallet)).json();
    const token = await getSession(adminWallet);
    const res = await fetch(`http://localhost:${port}/api/kyc/submissions/${sub.id}/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "verified", notes: "ok" }),
    });
    expect(res.status).toBe(200);

    const audit = await (await fetch(`http://localhost:${port}/api/admin/audit?targetId=${sub.id}`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({ action: "kyc.verified", targetType: "kyc", targetId: sub.id });
    expect(audit.entries[0].actor).toBe(adminWallet.address.toLowerCase());
    expect(JSON.parse(audit.entries[0].detail)).toMatchObject({ from: "pending", to: "verified", notes: "ok" });
  });

  it("records a Root CA publication, and the static-token actor is null", async () => {
    // Publish via the static token → actor should be null.
    const res = await fetch(`http://localhost:${port}/api/ca/root`, {
      method: "POST",
      headers: { authorization: `Bearer ${STATIC_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ der: CA_DER_B64 }),
    });
    expect(res.status).toBe(201);
    const fp = (await res.json()).fingerprint;

    const audit = await (await fetch(`http://localhost:${port}/api/admin/audit?action=rootca.published`, {
      headers: { authorization: `Bearer ${STATIC_TOKEN}` },
    })).json();
    expect(audit.entries.length).toBeGreaterThanOrEqual(1);
    const entry = audit.entries.find((e: { targetId: string }) => e.targetId === fp);
    expect(entry).toBeTruthy();
    expect(entry.actor).toBeNull();
    expect(entry.targetType).toBe("root_ca");
  });

  it("GET /api/admin/audit requires admin auth (401)", async () => {
    expect((await fetch(`http://localhost:${port}/api/admin/audit`)).status).toBe(401);
  });
});
