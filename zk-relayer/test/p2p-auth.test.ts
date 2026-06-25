/**
 * Coverage for the peer-relayer auth wiring on
 * `zk-relayer/src/routes/p2p.ts`. Mirrors the shared-orderbook
 * `relayerAuth` middleware tests — same body-hash binding, same
 * fail-closed-by-default legacy handling (opt back in with
 * `ALLOW_LEGACY_RELAYER_SIG=1`) — applied to the P2P
 * `POST /api/p2p/orders` accept path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "crypto";
import express from "express";
import http from "http";
import { Wallet } from "ethers";
import { createP2PRoutes } from "../src/routes/p2p.js";
import type { OrderSummary } from "../src/types/order.js";

const PORT = 14620;

function bodyHash(raw: Buffer): string {
  return "0x" + createHash("sha256").update(raw).digest("hex");
}

const noopOrder = (_o: OrderSummary): void => {};
const noopCancel = (_id: string): void => {};

function startApp(): http.Server {
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use("/api/p2p", createP2PRoutes(noopOrder, noopCancel));
  return app.listen(PORT);
}

async function postOrder(payload: unknown, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`http://localhost:${PORT}/api/p2p/orders`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.status;
}

function sampleOrder(relayer: string): OrderSummary {
  return {
    id: "0x" + "11".repeat(32),
    relayer,
    relayerUrl: "https://r1.example.com",
    sellToken: "0x" + "aa".repeat(20),
    buyToken: "0x" + "bb".repeat(20),
    sellAmount: "1000",
    buyAmount: "2000",
    minFillAmount: "0",
    maxFee: 30,
    expiry: Math.floor(Date.now() / 1000) + 600,
    createdAt: Math.floor(Date.now() / 1000),
  } as OrderSummary;
}

describe("p2p verifyRelayerAuth: body-hash binding", () => {
  let server: http.Server;
  const wallet = new Wallet("0x" + "cc".repeat(32));

  beforeEach(() => {
    server = startApp();
    delete process.env.ALLOW_LEGACY_RELAYER_SIG;
  });
  afterEach(async () => {
    delete process.env.ALLOW_LEGACY_RELAYER_SIG;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("accepts a body-bound signed POST", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const url = `http://localhost:${PORT}`;
    const body = sampleOrder(wallet.address);
    const raw = Buffer.from(JSON.stringify(body));
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/p2p/orders:${url}:${bodyHash(raw)}`;
    const signature = await wallet.signMessage(message);

    const status = await postOrder(body, {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    });
    expect(status).toBe(200);
  });

  it("rejects when body bytes were tampered with after signing", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const url = `http://localhost:${PORT}`;
    const signed = Buffer.from(JSON.stringify(sampleOrder(wallet.address)));
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/p2p/orders:${url}:${bodyHash(signed)}`;
    const signature = await wallet.signMessage(message);

    // Send a different order than what was signed.
    const tampered = { ...sampleOrder(wallet.address), sellAmount: "999999" };
    const status = await postOrder(tampered, {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    });
    expect(status).toBe(401);
  });

  it("rejects the legacy (no-body-hash) signature by default", async () => {
    const ts = Math.floor(Date.now() / 1000).toString();
    const url = `http://localhost:${PORT}`;
    const body = sampleOrder(wallet.address);
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/p2p/orders:${url}`;
    const signature = await wallet.signMessage(message);

    const status = await postOrder(body, {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    });
    expect(status).toBe(401);
  });

  it("accepts the legacy signature only with ALLOW_LEGACY_RELAYER_SIG=1 and warns", async () => {
    process.env.ALLOW_LEGACY_RELAYER_SIG = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ts = Math.floor(Date.now() / 1000).toString();
    const url = `http://localhost:${PORT}`;
    const body = sampleOrder(wallet.address);
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/p2p/orders:${url}`;
    const signature = await wallet.signMessage(message);

    const status = await postOrder(body, {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    });
    expect(status).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[deprecated-body-hash]"));
    warn.mockRestore();
  });

  it("rejects when required headers are missing", async () => {
    const status = await postOrder(sampleOrder(wallet.address), {});
    expect(status).toBe(401);
  });

  it("rejects a timestamp outside the 5-minute window", async () => {
    const ts = (Math.floor(Date.now() / 1000) - 400).toString();
    const url = `http://localhost:${PORT}`;
    const body = sampleOrder(wallet.address);
    const raw = Buffer.from(JSON.stringify(body));
    const message = `zkScatter-relay:${wallet.address.toLowerCase()}:${ts}:POST:/api/p2p/orders:${url}:${bodyHash(raw)}`;
    const signature = await wallet.signMessage(message);

    const status = await postOrder(body, {
      "x-relayer-address": wallet.address,
      "x-relayer-signature": signature,
      "x-relayer-timestamp": ts,
      "x-relayer-url": url,
    });
    expect(status).toBe(401);
  });
});
