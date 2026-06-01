import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "http";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { OrderbookDB } from "../src/core/db.js";
import { createKycRoutes } from "../src/routes/kyc.js";
import { config } from "../src/config.js";

const PORT = 14622;
const TEST_DB = "/tmp/shared-orderbook-kyc-test.db";
const UPLOAD_DIR = path.join(os.tmpdir(), "kyc-test-uploads");
const ADMIN_TOKEN = "test-admin-token";

const WALLET_A = "0x" + "a".repeat(40);
const WALLET_B = "0x" + "b".repeat(40);

const noopLimiter: express.RequestHandler = (_req, _res, next) => next();

function cleanDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
}

// ── DB-layer unit tests ──────────────────────────────────────────────────
describe("OrderbookDB — KYC submissions", () => {
  let db: OrderbookDB;

  beforeEach(() => {
    cleanDb();
    db = new OrderbookDB(TEST_DB);
  });

  afterAll(() => { db.close(); cleanDb(); });

  it("inserts and reads back a submission by id and wallet", () => {
    db.insertKycSubmission({
      id: "sub-1", wallet: WALLET_A.toLowerCase(), email: "a@example.com",
      videoPath: "/x/video.webm", idDocPath: "/x/id-doc.png", createdAt: 100,
    });
    const byId = db.getKycById("sub-1");
    expect(byId?.status).toBe("pending");
    expect(byId?.email).toBe("a@example.com");
    expect(byId?.reviewedAt).toBeNull();

    // wallet lookup is case-insensitive
    const byWallet = db.getKycByWallet(WALLET_A.toUpperCase());
    expect(byWallet?.id).toBe("sub-1");
  });

  it("getKycByWallet returns the newest row", () => {
    db.insertKycSubmission({ id: "s1", wallet: WALLET_A.toLowerCase(), email: null, videoPath: null, idDocPath: null, createdAt: 100 });
    db.insertKycSubmission({ id: "s2", wallet: WALLET_A.toLowerCase(), email: null, videoPath: null, idDocPath: null, createdAt: 200 });
    expect(db.getKycByWallet(WALLET_A)?.id).toBe("s2");
  });

  it("updateKycFiles refreshes a pending row without changing status", () => {
    db.insertKycSubmission({ id: "s1", wallet: WALLET_A.toLowerCase(), email: "old@x.com", videoPath: "/old/v", idDocPath: "/old/d", createdAt: 100 });
    db.updateKycFiles("s1", { email: "new@x.com", videoPath: "/new/v", idDocPath: "/new/d" }, 300);
    const row = db.getKycById("s1");
    expect(row?.email).toBe("new@x.com");
    expect(row?.videoPath).toBe("/new/v");
    expect(row?.createdAt).toBe(300);
    expect(row?.status).toBe("pending");
  });

  it("updateKycStatus sets status, notes and reviewed_at", () => {
    db.insertKycSubmission({ id: "s1", wallet: WALLET_A.toLowerCase(), email: null, videoPath: null, idDocPath: null, createdAt: 100 });
    const ok = db.updateKycStatus("s1", "rejected", "blurry video", 500);
    expect(ok).toBe(true);
    const row = db.getKycById("s1");
    expect(row?.status).toBe("rejected");
    expect(row?.notes).toBe("blurry video");
    expect(row?.reviewedAt).toBe(500);
    // unknown id → no rows changed
    expect(db.updateKycStatus("nope", "approved", null, 600)).toBe(false);
  });

  it("listKycSubmissions filters by status, newest-first", () => {
    db.insertKycSubmission({ id: "s1", wallet: WALLET_A.toLowerCase(), email: null, videoPath: null, idDocPath: null, createdAt: 100 });
    db.insertKycSubmission({ id: "s2", wallet: WALLET_B.toLowerCase(), email: null, videoPath: null, idDocPath: null, createdAt: 200 });
    db.updateKycStatus("s1", "approved", null, 300);
    expect(db.listKycSubmissions().map((r) => r.id)).toEqual(["s2", "s1"]);
    expect(db.listKycSubmissions({ status: "pending" }).map((r) => r.id)).toEqual(["s2"]);
    expect(db.listKycSubmissions({ status: "approved" }).map((r) => r.id)).toEqual(["s1"]);
  });
});

// ── HTTP integration tests ───────────────────────────────────────────────
describe("KYC routes", () => {
  let server: http.Server;
  let db: OrderbookDB;

  function submitForm(opts: { wallet?: string; email?: string; video?: boolean; idDoc?: boolean; videoType?: string }) {
    const form = new FormData();
    if (opts.wallet !== undefined) form.append("wallet", opts.wallet);
    if (opts.email !== undefined) form.append("email", opts.email);
    if (opts.video) form.append("video", new Blob([new Uint8Array([1, 2, 3])], { type: opts.videoType ?? "video/webm" }), "v.webm");
    if (opts.idDoc) form.append("idDoc", new Blob([new Uint8Array([4, 5, 6])], { type: "image/png" }), "d.png");
    return fetch(`http://localhost:${PORT}/api/kyc/submit`, { method: "POST", body: form });
  }

  beforeAll(async () => {
    cleanDb();
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
    config.kycUploadDir = UPLOAD_DIR; // override before router creation
    db = new OrderbookDB(TEST_DB);

    const app = express();
    app.use(express.json());
    app.use("/api/kyc", createKycRoutes(db, noopLimiter, noopLimiter, ADMIN_TOKEN));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(PORT, resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    cleanDb();
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  });

  it("POST /submit — stores a submission and the uploaded files", async () => {
    const res = await submitForm({ wallet: WALLET_A, email: "op@example.com", video: true, idDoc: true });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe("pending");
    expect(typeof body.id).toBe("string");

    // DB row exists, files landed on disk
    const row = db.getKycById(body.id);
    expect(row?.wallet).toBe(WALLET_A.toLowerCase());
    expect(fs.existsSync(row!.videoPath!)).toBe(true);
    expect(fs.existsSync(row!.idDocPath!)).toBe(true);
    expect(row!.videoPath!.endsWith("/video.webm")).toBe(true);
    expect(row!.idDocPath!.endsWith("/id-doc.png")).toBe(true);
  });

  it("GET /status — reflects the submission, 'none' when absent", async () => {
    const present = await (await fetch(`http://localhost:${PORT}/api/kyc/status?wallet=${WALLET_A}`)).json();
    expect(present.status).toBe("pending");
    const absent = await (await fetch(`http://localhost:${PORT}/api/kyc/status?wallet=${WALLET_B}`)).json();
    expect(absent.status).toBe("none");
  });

  it("POST /submit — re-submission updates the existing pending row (200, same id)", async () => {
    const first = await (await submitForm({ wallet: WALLET_B, email: "b@example.com", video: true, idDoc: true })).json();
    const res2 = await submitForm({ wallet: WALLET_B, email: "b2@example.com", video: true, idDoc: true });
    expect(res2.status).toBe(200);
    const second = await res2.json();
    expect(second.id).toBe(first.id); // folded into the same row
    expect(db.getKycById(first.id)?.email).toBe("b2@example.com");
    // exactly one row for the wallet
    expect(db.listKycSubmissions().filter((r) => r.wallet === WALLET_B.toLowerCase())).toHaveLength(1);
  });

  it("POST /submit — rejects bad wallet, missing email, missing files, bad type", async () => {
    expect((await submitForm({ wallet: "nope", email: "x@y.com", video: true, idDoc: true })).status).toBe(400);
    expect((await submitForm({ wallet: WALLET_A, email: "not-an-email", video: true, idDoc: true })).status).toBe(400);
    expect((await submitForm({ wallet: WALLET_A, email: "x@y.com", video: true, idDoc: false })).status).toBe(400);
    expect((await submitForm({ wallet: WALLET_A, email: "x@y.com", video: true, idDoc: true, videoType: "text/plain" })).status).toBe(400);
  });

  it("GET /status — rejects a malformed wallet", async () => {
    const res = await fetch(`http://localhost:${PORT}/api/kyc/status?wallet=nope`);
    expect(res.status).toBe(400);
  });

  it("admin stubs require a bearer token and return 501 once authed (PR2)", async () => {
    const noAuth = await fetch(`http://localhost:${PORT}/api/kyc/submissions`);
    expect(noAuth.status).toBe(401);
    const authed = await fetch(`http://localhost:${PORT}/api/kyc/submissions`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(authed.status).toBe(501);
  });
});
