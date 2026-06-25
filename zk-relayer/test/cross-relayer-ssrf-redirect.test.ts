/**
 * Regression coverage for the SSRF redirect bypass on the cross-relayer
 * outbound path. `assertSafeOutboundUrl` only vets the initial URL, so a
 * peer that registered a benign public host could 30x-redirect the
 * trade-offer POST to a private IP / metadata endpoint. The fix passes
 * `redirect: "error"` to `fetch`, so any redirect aborts before the
 * second request leaves the box.
 *
 * The test disables the IP guard (`ALLOW_PRIVATE_RELAYER_URLS=1`) on
 * purpose so localhost URLs pass the guard — this isolates the redirect
 * mitigation as the only thing standing between the offer and the
 * "internal" target.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import http from "http";
import { AuthorizeCrossRelayerMatchService } from "../src/core/authorize-cross-relayer-matcher.js";
import type { SharedOrderbookClient } from "../src/core/shared-orderbook-client.js";
import type { AuthorizeSubmitter } from "../src/core/authorize-submitter.js";
import type { AuthorizeOrderFile } from "../src/types/authorize-order.js";
import type { OrderSummary } from "../src/types/order.js";

const PEER_PORT = 14640;   // "public" peer that 307-redirects
const INTERNAL_PORT = 14641; // stand-in for a private / metadata target

describe("cross-relayer SSRF: outbound fetch does not follow redirects", () => {
  let peer: http.Server;
  let internal: http.Server;
  let internalHit = false;

  beforeEach(() => {
    process.env.ALLOW_PRIVATE_RELAYER_URLS = "1";
    internalHit = false;

    const internalApp = express();
    internalApp.all("*", (_req, res) => {
      internalHit = true;
      res.json({ status: "settled" });
    });
    internal = internalApp.listen(INTERNAL_PORT);

    const peerApp = express();
    peerApp.all("*", (_req, res) => {
      res.redirect(307, `http://localhost:${INTERNAL_PORT}/api/p2p/authorize-trade-offer`);
    });
    peer = peerApp.listen(PEER_PORT);
  });

  afterEach(async () => {
    delete process.env.ALLOW_PRIVATE_RELAYER_URLS;
    await new Promise<void>((r) => peer.close(() => r()));
    await new Promise<void>((r) => internal.close(() => r()));
  });

  it("aborts on a 307 redirect to an internal target", async () => {
    const sharedClient = {
      authHeaders: async () => ({}),
    } as unknown as SharedOrderbookClient;

    const svc = new AuthorizeCrossRelayerMatchService(
      new Map(),
      sharedClient,
      {} as unknown as AuthorizeSubmitter,
      "0x" + "dd".repeat(20),
      null,
      () => [],
    );

    const remoteMaker = {
      id: "0x" + "11".repeat(32),
      relayerUrl: `http://localhost:${PEER_PORT}`,
    } as unknown as OrderSummary;

    const res = await svc.sendTradeOffer({} as unknown as AuthorizeOrderFile, remoteMaker);

    // The redirect must abort the request, surfacing as an error status…
    expect(res.status).toBe("error");
    // …and crucially the internal target must never be reached.
    expect(internalHit).toBe(false);
  });
});
