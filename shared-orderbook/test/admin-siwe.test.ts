import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "http";
import express from "express";
import fs from "fs";
import { Wallet } from "ethers";
import {
  makeAdminSiweFromAllowlist,
  AdminSiweAuth,
  formatChallengeMessage,
} from "../src/core/admin-siwe.js";
import { makeAdminAuth } from "../src/middleware/admin-auth.js";
import { createAdminRoutes } from "../src/routes/admin.js";
import { createKycRoutes } from "../src/routes/kyc.js";
import { OrderbookDB } from "../src/core/db.js";
import { VerifyMonitor } from "../src/core/verify-runtime.js";

const TEST_DB = "/tmp/shared-orderbook-siwe-test.db";
const STATIC_TOKEN = "static-fallback-token";
const noop: express.RequestHandler = (_req, _res, next) => next();

const adminWallet = new Wallet("0x" + "11".repeat(32));
const outsiderWallet = new Wallet("0x" + "22".repeat(32));

function cleanDb() {
  for (const ext of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TEST_DB + ext); } catch { /* ignore */ }
  }
}

// ── Core unit tests ──────────────────────────────────────────────────────
describe("AdminSiweAuth", () => {
  it("makeAdminSiweFromAllowlist returns null for an empty allowlist", () => {
    expect(makeAdminSiweFromAllowlist([])).toBeNull();
    expect(makeAdminSiweFromAllowlist(["", "  "])).toBeNull();
  });

  it("issues a challenge whose message is the canonical format bound to the nonce", () => {
    const siwe = makeAdminSiweFromAllowlist([adminWallet.address])!;
    const ch = siwe.issueChallenge();
    expect(ch.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(ch.expiresAt).toBeGreaterThan(0);
    expect(ch.message).toBe(formatChallengeMessage({ nonce: ch.nonce, issuedAt: ch.issuedAt }));
    expect(ch.message).toContain(ch.nonce);
  });

  it("mints a session for an allowlisted signer and verifies the token", async () => {
    const siwe = makeAdminSiweFromAllowlist([adminWallet.address])!;
    const ch = siwe.issueChallenge();
    const signature = await adminWallet.signMessage(ch.message);
    const session = await siwe.createSession({ nonce: ch.nonce, message: ch.message, signature });
    expect(session.address.toLowerCase()).toBe(adminWallet.address.toLowerCase());
    expect(siwe.verifySession(session.token)).toBe(adminWallet.address.toLowerCase());

    siwe.revokeSession(session.token);
    expect(siwe.verifySession(session.token)).toBeNull();
    expect(siwe.verifySession("deadbeef")).toBeNull();
  });

  it("rejects a signer that is not on the allowlist", async () => {
    const siwe = makeAdminSiweFromAllowlist([adminWallet.address])!;
    const ch = siwe.issueChallenge();
    const signature = await outsiderWallet.signMessage(ch.message);
    await expect(siwe.createSession({ nonce: ch.nonce, message: ch.message, signature })).rejects.toThrow(
      /not an authorized admin/i,
    );
  });

  it("burns the nonce — a second use of the same challenge fails", async () => {
    const siwe = makeAdminSiweFromAllowlist([adminWallet.address])!;
    const ch = siwe.issueChallenge();
    const signature = await adminWallet.signMessage(ch.message);
    await siwe.createSession({ nonce: ch.nonce, message: ch.message, signature });
    await expect(siwe.createSession({ nonce: ch.nonce, message: ch.message, signature })).rejects.toThrow(
      /unknown or expired/i,
    );
  });

  it("rejects a message that doesn't match the issued challenge", async () => {
    const siwe = makeAdminSiweFromAllowlist([adminWallet.address])!;
    const ch = siwe.issueChallenge();
    const tampered = ch.message + "\nGimme admin";
    const signature = await adminWallet.signMessage(tampered);
    await expect(siwe.createSession({ nonce: ch.nonce, message: tampered, signature })).rejects.toThrow(
      /does not match/i,
    );
  });

  it("is case-insensitive on allowlist membership", async () => {
    const siwe = new AdminSiweAuth((addr) => addr.toLowerCase() === adminWallet.address.toLowerCase());
    const ch = siwe.issueChallenge();
    const signature = await adminWallet.signMessage(ch.message);
    const session = await siwe.createSession({ nonce: ch.nonce, message: ch.message, signature });
    expect(session.token).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── HTTP integration tests ───────────────────────────────────────────────
describe("admin SIWE routes + gate", () => {
  let server: http.Server;
  let db: OrderbookDB;
  let port: number;

  async function getSession(wallet: Wallet) {
    const ch = await (await fetch(`http://localhost:${port}/api/admin/challenge`)).json();
    const signature = await wallet.signMessage(ch.message);
    const res = await fetch(`http://localhost:${port}/api/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: ch.nonce, message: ch.message, signature }),
    });
    return { status: res.status, body: await res.json(), nonce: ch.nonce, message: ch.message, signature };
  }

  beforeAll(async () => {
    cleanDb();
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    cleanDb();
  });

  it("GET /api/admin/challenge returns a nonce + signable message", async () => {
    const ch = await (await fetch(`http://localhost:${port}/api/admin/challenge`)).json();
    expect(ch.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof ch.message).toBe("string");
    expect(ch.expiresAt).toBeGreaterThan(0);
  });

  it("an allowlisted wallet's session token authorizes admin + KYC routes", async () => {
    const { status, body } = await getSession(adminWallet);
    expect(status).toBe(200);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/);
    expect(body.address.toLowerCase()).toBe(adminWallet.address.toLowerCase());

    const bearer = { authorization: `Bearer ${body.token}` };
    expect((await fetch(`http://localhost:${port}/api/kyc/submissions`, { headers: bearer })).status).toBe(200);
    expect((await fetch(`http://localhost:${port}/api/admin/verify-stats`, { headers: bearer })).status).toBe(200);
  });

  it("POST /api/admin/session rejects a non-allowlisted signer (401)", async () => {
    const { status, body } = await getSession(outsiderWallet);
    expect(status).toBe(401);
    expect(body.error).toMatch(/not an authorized admin/i);
  });

  it("POST /api/admin/session validates the body shape (400)", async () => {
    const res = await fetch(`http://localhost:${port}/api/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("the static ADMIN_TOKEN bearer still authorizes (fallback)", async () => {
    const res = await fetch(`http://localhost:${port}/api/kyc/submissions`, {
      headers: { authorization: `Bearer ${STATIC_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  it("rejects a missing / garbage bearer (401)", async () => {
    expect((await fetch(`http://localhost:${port}/api/kyc/submissions`)).status).toBe(401);
    expect(
      (await fetch(`http://localhost:${port}/api/kyc/submissions`, { headers: { authorization: "Bearer nope" } })).status,
    ).toBe(401);
  });

  it("session/revoke invalidates the token", async () => {
    const { body } = await getSession(adminWallet);
    const bearer = { authorization: `Bearer ${body.token}` };
    expect((await fetch(`http://localhost:${port}/api/kyc/submissions`, { headers: bearer })).status).toBe(200);

    const revoke = await fetch(`http://localhost:${port}/api/admin/session/revoke`, { method: "POST", headers: bearer });
    expect(revoke.status).toBe(204);
    expect((await fetch(`http://localhost:${port}/api/kyc/submissions`, { headers: bearer })).status).toBe(401);
  });

  it("a reused challenge nonce is rejected (replay protection)", async () => {
    const first = await getSession(adminWallet);
    expect(first.status).toBe(200);
    const replay = await fetch(`http://localhost:${port}/api/admin/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nonce: first.nonce, message: first.message, signature: first.signature }),
    });
    expect(replay.status).toBe(401);
  });
});

// ── SIWE disabled (no ADMIN_ADDRESSES) ───────────────────────────────────
describe("admin routes with SIWE disabled", () => {
  let server: http.Server;
  let db: OrderbookDB;
  let port: number;

  beforeAll(async () => {
    cleanDb();
    db = new OrderbookDB(TEST_DB);
    // No allowlist → SIWE off, only the static token works.
    const adminAuth = makeAdminAuth({ siwe: null, staticToken: STATIC_TOKEN });
    const app = express();
    app.use(express.json());
    app.use("/api/admin", createAdminRoutes({ db, monitor: new VerifyMonitor(), adminAuth, siwe: null, writeLimiter: noop }));
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    cleanDb();
  });

  it("the SIWE challenge endpoint is not mounted (404)", async () => {
    expect((await fetch(`http://localhost:${port}/api/admin/challenge`)).status).toBe(404);
  });

  it("the static token still authorizes verify-stats", async () => {
    const res = await fetch(`http://localhost:${port}/api/admin/verify-stats`, {
      headers: { authorization: `Bearer ${STATIC_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});
