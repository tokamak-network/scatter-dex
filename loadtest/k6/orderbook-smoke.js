/** Smoke: one VU walks through every public read endpoint + tries
 *  one signed write. The write is expected to fail at auth (we don't
 *  ship secp256k1 in k6) — that's intentional. Reaching the auth
 *  failure means the server parsed headers, computed the body hash,
 *  and ran verifyMessage, which is the codepath we actually want
 *  load coverage on.
 *
 *  Run: K6_TARGET=http://localhost:4000 k6 run orderbook-smoke.js
 */
import { sleep } from "k6";
import { getJson, postSigned, TARGET, PROFILE, selectStages, THRESHOLDS } from "./helpers.js";

export const options = {
  // Smoke ignores `PROFILE` ramps — always one VU for 30s.
  vus: 1,
  duration: PROFILE === "smoke" ? "30s" : selectStages()[0].duration,
  thresholds: THRESHOLDS,
};

export default function () {
  // Health
  getJson("/health");

  // Open orders (likely empty in a fresh DB)
  getJson("/api/orders");

  // Network-level reads
  getJson("/api/network/totals");
  getJson("/api/leaderboard?limit=20");

  // Per-relayer stats (zero address — should return zeros, not 4xx)
  getJson("/api/relayers/0x0000000000000000000000000000000000000000/stats");

  // Signed write — expected to 401 because the smoke harness can't
  // produce a real secp256k1 signature. Still saturates the
  // auth-middleware verify path.
  postSigned("/api/orders", {
    id: `0x${"11".repeat(32)}`,
    relayer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    relayerUrl: "https://loadtest.invalid",
    sellToken: `0x${"aa".repeat(20)}`,
    buyToken: `0x${"bb".repeat(20)}`,
    sellAmount: "1000",
    buyAmount: "2000",
    minFillAmount: "0",
    maxFee: 30,
    expiry: Math.floor(Date.now() / 1000) + 600,
    createdAt: Math.floor(Date.now() / 1000),
  });

  sleep(1);
}
