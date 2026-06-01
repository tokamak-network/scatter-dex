import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "http";
import express from "express";
import fs from "fs";
import path from "path";
import os from "os";
import { OrderbookDB } from "../src/core/db.js";
import { createKycRoutes } from "../src/routes/kyc.js";
import { makeAdminAuth } from "../src/middleware/admin-auth.js";
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

  // Close the handle after every test so cleanDb() never races an open
  // connection and SQLite file handles don't leak across cases.
  afterEach(() => { db.close(); });
  afterAll(() => { cleanDb(); });

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
    app.use("/api/kyc", createKycRoutes(db, noopLimiter, noopLimiter, makeAdminAuth({ staticToken: ADMIN_TOKEN })));
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

  it("POST /submit — re-record with a different extension removes the orphaned file", async () => {
    const wallet = "0x" + "c".repeat(40);
    const first = await (await submitForm({ wallet, email: "c@example.com", video: true, idDoc: true })).json();
    const oldVideo = db.getKycById(first.id)!.videoPath!;
    expect(oldVideo.endsWith("/video.webm")).toBe(true);

    await submitForm({ wallet, email: "c@example.com", video: true, idDoc: true, videoType: "video/mp4" });
    const newVideo = db.getKycById(first.id)!.videoPath!;
    expect(newVideo.endsWith("/video.mp4")).toBe(true);
    expect(fs.existsSync(newVideo)).toBe(true);
    expect(fs.existsSync(oldVideo)).toBe(false); // orphan cleaned up
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

  // ── Admin review surface (PR2-A) ─────────────────────────────────────────
  const base = `http://localhost:${PORT}`;
  const adminAuth = { authorization: `Bearer ${ADMIN_TOKEN}` };
  const postStatus = (id: string, body: unknown) =>
    fetch(`${base}/api/kyc/submissions/${id}/status`, {
      method: "POST",
      headers: { ...adminAuth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("admin GET /submissions — 401 without token, PII-minimal list with token", async () => {
    expect((await fetch(`${base}/api/kyc/submissions`)).status).toBe(401);
    const res = await fetch(`${base}/api/kyc/submissions`, { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.submissions)).toBe(true);
    expect(body.submissions.length).toBeGreaterThan(0);
    const row = body.submissions[0];
    expect(row).toHaveProperty("wallet");
    expect(row).toHaveProperty("status");
    expect(row).not.toHaveProperty("videoPath"); // no raw paths leaked
    expect(row).not.toHaveProperty("idDocPath");
    expect(row).not.toHaveProperty("notes"); // notes are detail-only
  });

  it("admin GET /submissions?status= — filters; rejects an unknown status", async () => {
    const pending = await (await fetch(`${base}/api/kyc/submissions?status=pending`, { headers: adminAuth })).json();
    expect(pending.submissions.every((r: { status: string }) => r.status === "pending")).toBe(true);
    expect((await fetch(`${base}/api/kyc/submissions?status=bogus`, { headers: adminAuth })).status).toBe(400);
  });

  it("admin GET /submissions/:id — 404 missing; meta + file availability, no paths", async () => {
    expect((await fetch(`${base}/api/kyc/submissions/nope`, { headers: adminAuth })).status).toBe(404);
    const sub = await (await submitForm({ wallet: "0x" + "d".repeat(40), email: "d@example.com", video: true, idDoc: true })).json();
    const res = await fetch(`${base}/api/kyc/submissions/${sub.id}`, { headers: adminAuth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.wallet).toBe("0x" + "d".repeat(40));
    expect(body.files.video).toEqual({ present: true, contentType: "video/webm", sizeBytes: 3 });
    expect(body.files.idDoc.present).toBe(true);
    expect(body.files.idDoc.contentType).toBe("image/png");
    expect(body).not.toHaveProperty("videoPath");
  });

  it("admin GET /submissions/:id/file/:kind — streams correct bytes + Content-Type; rejects bad kind / no auth", async () => {
    const sub = await (await submitForm({ wallet: "0x" + "e".repeat(40), email: "e@example.com", video: true, idDoc: true })).json();
    expect((await fetch(`${base}/api/kyc/submissions/${sub.id}/file/bogus`, { headers: adminAuth })).status).toBe(400);
    expect((await fetch(`${base}/api/kyc/submissions/${sub.id}/file/video`)).status).toBe(401);

    const vres = await fetch(`${base}/api/kyc/submissions/${sub.id}/file/video`, { headers: adminAuth });
    expect(vres.status).toBe(200);
    expect(vres.headers.get("content-type")).toBe("video/webm");
    expect(new Uint8Array(await vres.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));

    const dres = await fetch(`${base}/api/kyc/submissions/${sub.id}/file/idDoc`, { headers: adminAuth });
    expect(dres.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await dres.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("admin file routes treat a missing-on-disk document as absent (present:false / 404)", async () => {
    const sub = await (await submitForm({ wallet: "0x" + "9".repeat(40), email: "9@example.com", video: true, idDoc: true })).json();
    const row = db.getKycById(sub.id)!;
    fs.rmSync(row.videoPath!, { force: true }); // file vanishes after submission

    const detail = await (await fetch(`${base}/api/kyc/submissions/${sub.id}`, { headers: adminAuth })).json();
    expect(detail.files.video.present).toBe(false);
    expect(detail.files.idDoc.present).toBe(true); // the other file is intact

    expect((await fetch(`${base}/api/kyc/submissions/${sub.id}/file/video`, { headers: adminAuth })).status).toBe(404);
    expect((await fetch(`${base}/api/kyc/submissions/${sub.id}/file/idDoc`, { headers: adminAuth })).status).toBe(200);
  });

  it("admin POST /submissions/:id/status — auth, validation, and the two-step transition", async () => {
    const wallet = "0x" + "f".repeat(40);
    const sub = await (await submitForm({ wallet, email: "f@example.com", video: true, idDoc: true })).json();

    // no auth
    const noAuth = await fetch(`${base}/api/kyc/submissions/${sub.id}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "verified" }),
    });
    expect(noAuth.status).toBe(401);

    // bad targets: pending isn't a review target; unknown status; bad transition
    expect((await postStatus(sub.id, { status: "pending" })).status).toBe(400);
    expect((await postStatus(sub.id, { status: "bogus" })).status).toBe(400);
    expect((await postStatus(sub.id, { status: "approved" })).status).toBe(400); // pending→approved skips verify

    // valid pending → verified (with notes)
    const verified = await postStatus(sub.id, { status: "verified", notes: "docs look good" });
    expect(verified.status).toBe(200);
    const vbody = await verified.json();
    expect(vbody.status).toBe("verified");
    expect(vbody.notes).toBe("docs look good");
    expect(vbody.reviewedAt).toBeGreaterThan(0);

    // verified → approved, then approved is terminal
    expect((await (await postStatus(sub.id, { status: "approved" })).json()).status).toBe("approved");
    expect((await postStatus(sub.id, { status: "rejected" })).status).toBe(400);

    // unknown id
    expect((await postStatus("nope", { status: "verified" })).status).toBe(404);

    // public status endpoint reflects the final decision
    const pub = await (await fetch(`${base}/api/kyc/status?wallet=${wallet}`)).json();
    expect(pub.status).toBe("approved");
  });

  it("admin routes are disabled (503) when ADMIN_TOKEN is unset", async () => {
    // A second app with no admin token — the shared auth should 503, not 401.
    const noTokenApp = express();
    noTokenApp.use(express.json());
    noTokenApp.use("/api/kyc", createKycRoutes(db, noopLimiter, noopLimiter, makeAdminAuth({})));
    const srv = http.createServer(noTokenApp);
    // Bind an ephemeral port (listen(0)) to avoid collisions on CI runners.
    await new Promise<void>((resolve) => srv.listen(0, resolve));
    const addr = srv.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    try {
      const res = await fetch(`http://localhost:${port}/api/kyc/submissions`, { headers: adminAuth });
      expect(res.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });
});
