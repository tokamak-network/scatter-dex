import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { Wallet } from "ethers";
import { OrderbookDB } from "../src/core/db.js";
import { createKycRoutes } from "../src/routes/kyc.js";
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
    db.recordAudit({ ts: 200, actor: null, action: "kyc.rejected", targetType: "kyc", targetId: "s2" });
    const all = db.listAudit();
    expect(all.map((e) => e.action)).toEqual(["kyc.rejected", "kyc.approved"]);
    expect(all[1].actor).toBe("0xa");
    expect(all[0].actor).toBeNull();
  });

  it("filters by action / targetType / targetId", () => {
    db.recordAudit({ ts: 1, actor: "0xa", action: "kyc.approved", targetType: "kyc", targetId: "s1" });
    db.recordAudit({ ts: 2, actor: "0xa", action: "kyc.revoked", targetType: "kyc", targetId: "s1" });
    db.recordAudit({ ts: 3, actor: "0xa", action: "kyc.verified", targetType: "kyc", targetId: "s2" });
    expect(db.listAudit({ action: "kyc.revoked" })).toHaveLength(1);
    expect(db.listAudit({ targetType: "kyc" })).toHaveLength(3);
    expect(db.listAudit({ targetId: "s2" })).toHaveLength(1);
  });

  it("is append-only (no update/delete surface)", () => {
    const db2 = db as unknown as Record<string, unknown>;
    expect(typeof db2.recordAudit).toBe("function");
    expect(db2.updateAudit).toBeUndefined();
    expect(db2.deleteAudit).toBeUndefined();
  });
});

// ── HTTP integration ─────────────────────────────────────────────────────
describe("audit log wiring (KYC → /api/admin/audit)", () => {
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
    // This suite exercises audit-log WIRING (a KYC status decision → an audit
    // entry); the KYC submit here is just setup. The wallet-ownership gate
    // (A-6) is covered by kyc.test.ts, and these tests use fixture addresses
    // with no signing key, so opt the gate off for the setup submits.
    config.kycRequireWalletSig = false;
    db = new OrderbookDB(TEST_DB);
    const siwe = makeAdminSiweFromAllowlist([adminWallet.address])!;
    const adminAuth = makeAdminAuth({ siwe, staticToken: STATIC_TOKEN });
    const app = express();
    app.use(express.json());
    app.use("/api/admin", createAdminRoutes({ db, monitor: new VerifyMonitor(), adminAuth, siwe, writeLimiter: noop }));
    app.use("/api/kyc", createKycRoutes(db, noop, noop, adminAuth));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });
  afterAll(async () => {
    config.kycRequireWalletSig = true; // restore default; don't leak to other suites
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

  it("records a post-approval revoke as kyc.revoked", async () => {
    const wallet = "0x" + "d2".repeat(20);
    const sub = await (await submitForm(wallet)).json();
    const token = await getSession(adminWallet);
    const hdr = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const post = (body: unknown) =>
      fetch(`http://localhost:${port}/api/kyc/submissions/${sub.id}/status`, { method: "POST", headers: hdr, body: JSON.stringify(body) });

    await post({ status: "verified" });
    await post({ status: "approved" });
    expect((await post({ status: "revoked", notes: "compromised" })).status).toBe(200);

    const audit = await (await fetch(`http://localhost:${port}/api/admin/audit?action=kyc.revoked&targetId=${sub.id}`, {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    expect(audit.entries).toHaveLength(1);
    expect(JSON.parse(audit.entries[0].detail)).toMatchObject({ from: "approved", to: "revoked", notes: "compromised" });
  });

  it("records a status decision via the static token with a null actor", async () => {
    const wallet = "0x" + "e3".repeat(20);
    const sub = await (await submitForm(wallet)).json();
    // Decide via the static token → actor should be null (no SIWE address).
    const res = await fetch(`http://localhost:${port}/api/kyc/submissions/${sub.id}/status`, {
      method: "POST",
      headers: { authorization: `Bearer ${STATIC_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ status: "verified" }),
    });
    expect(res.status).toBe(200);

    const audit = await (await fetch(`http://localhost:${port}/api/admin/audit?targetId=${sub.id}`, {
      headers: { authorization: `Bearer ${STATIC_TOKEN}` },
    })).json();
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].actor).toBeNull();
    expect(audit.entries[0].targetType).toBe("kyc");
  });

  it("GET /api/admin/audit requires admin auth (401)", async () => {
    expect((await fetch(`http://localhost:${port}/api/admin/audit`)).status).toBe(401);
  });
});
