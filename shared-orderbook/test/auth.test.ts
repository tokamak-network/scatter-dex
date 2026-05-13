/**
 * Unit coverage for the EIP-191 relayer auth middleware, in particular
 * the body-hash binding introduced in PR #693 and the
 * `REQUIRE_BODY_HASH=1` fail-closed mode that ends the legacy fallback.
 *
 * The middleware is exercised through a minimal express app so the
 * test mirrors what the real router does — `express.json({ verify })`
 * captures `rawBody`, then `relayerAuth` reads it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import express from "express";
import http from "http";
import { Wallet } from "ethers";
import { relayerAuth } from "../src/middleware/auth.js";

const PORT = 14600;

function bodyHash(raw: Buffer): string {
  return "0x" + createHash("sha256").update(raw).digest("hex");
}

const EMPTY_BODY_SHA256 = "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function startApp(): http.Server {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.post("/api/secret", relayerAuth, (_req, res) => res.json({ ok: true }));
  app.get("/api/secret", relayerAuth, (_req, res) => res.json({ ok: true }));
  return app.listen(PORT);
}

async function callPost(path: string, headers: Record<string, string>, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${PORT}${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function callGet(path: string, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`http://localhost:${PORT}${path}`, { method: "GET", headers });
  return { status: res.status, json: await res.json() };
}

describe("relayerAuth: body-hash binding", () => {
  let server: http.Server;
  const wallet = new Wallet("0x" + "aa".repeat(32));

  beforeEach(() => {
    server = startApp();
    delete process.env.REQUIRE_BODY_HASH;
  });
  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("accepts a body-bound signed POST", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const url = `http://localhost:${PORT}`;
    const body = { foo: "bar" };
    const rawBody = Buffer.from(JSON.stringify(body));
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/secret:${url}:${bodyHash(rawBody)}`;
    const signature = await wallet.signMessage(message);

    const r = await callPost("/api/secret", {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    }, body);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
  });

  it("accepts a body-bound signed GET (empty body hash)", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const url = `http://localhost:${PORT}`;
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:GET:/api/secret:${url}:${EMPTY_BODY_SHA256}`;
    const signature = await wallet.signMessage(message);

    const r = await callGet("/api/secret", {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    });
    expect(r.status).toBe(200);
  });

  it("rejects when the request body bytes differ from what was signed", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const url = `http://localhost:${PORT}`;
    const signed = Buffer.from(JSON.stringify({ foo: "bar" }));
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/secret:${url}:${bodyHash(signed)}`;
    const signature = await wallet.signMessage(message);

    // Send a different body than what was signed.
    const r = await callPost("/api/secret", {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    }, { foo: "tampered" });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("signature mismatch");
  });

  it("falls back to legacy (no body hash) and emits a deprecation warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ts = Math.floor(Date.now() / 1000).toString();
    const url = `http://localhost:${PORT}`;
    const body = { foo: "bar" };
    // Sign the legacy form (no body hash trailer).
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/secret:${url}`;
    const signature = await wallet.signMessage(message);

    const r = await callPost("/api/secret", {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    }, body);

    expect(r.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[deprecated-body-hash]"));
    warn.mockRestore();
  });

  it("REQUIRE_BODY_HASH=1 rejects the legacy signature shape", async () => {
    process.env.REQUIRE_BODY_HASH = "1";
    const ts = Math.floor(Date.now() / 1000).toString();
    const url = `http://localhost:${PORT}`;
    const body = { foo: "bar" };
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/secret:${url}`;
    const signature = await wallet.signMessage(message);

    const r = await callPost("/api/secret", {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    }, body);
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("signature mismatch");
  });

  it("rejects when the timestamp is older than the 5-minute window", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 400).toString(); // 6m40s ago
    const url = `http://localhost:${PORT}`;
    const body = { foo: "bar" };
    const rawBody = Buffer.from(JSON.stringify(body));
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/secret:${url}:${bodyHash(rawBody)}`;
    const signature = await wallet.signMessage(message);

    const r = await callPost("/api/secret", {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    }, body);
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("signature expired or clock skew too large");
  });

  it("rejects when required auth headers are missing", async () => {
    const r = await callPost("/api/secret", {}, { foo: "bar" });
    expect(r.status).toBe(401);
    expect(r.json.error).toBe("missing relayer auth headers");
  });
});
