/** Smoke: low-rate walk through every public read endpoint plus a
 *  representative signed write. Runs at 10 RPS for 30 s regardless
 *  of the K6_PROFILE selection — the other profiles target the
 *  burst scenarios.
 *
 *  Run: K6_TARGET=http://localhost:4000 k6 run orderbook-smoke.js
 */
import { getJson, postSigned, uniqueHex32, markExpectedStatuses, TARGET, THRESHOLDS } from "./helpers.js";

export const options = {
  // Smoke is intentionally fixed-shape: 10 RPS, 30s. It doesn't
  // honor K6_PROFILE so the runner gets a consistent baseline.
  scenarios: {
    smoke: {
      executor: "constant-arrival-rate",
      rate: 10,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 20,
      maxVUs: 50,
    },
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  markExpectedStatuses();
  console.log(`smoke target=${TARGET}`);
}

const READ_ENDPOINTS = [
  "/health",
  "/api/orders",
  "/api/network/totals",
  "/api/leaderboard?limit=20",
  "/api/relayers/0x0000000000000000000000000000000000000000/stats",
];

export default function () {
  // 5 in 6 iterations are reads; the 6th is the signed-write probe
  // so the auth path still gets exercised under the smoke profile.
  if (__ITER % 6 === 0) {
    const now = Math.floor(Date.now() / 1000);
    postSigned("/api/orders", {
      id: uniqueHex32(),
      relayer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      relayerUrl: "https://loadtest.invalid",
      sellToken: "0x" + "aa".repeat(20),
      buyToken: "0x" + "bb".repeat(20),
      sellAmount: "1000",
      buyAmount: "2000",
      minFillAmount: "0",
      maxFee: 30,
      expiry: now + 600,
      createdAt: now,
    });
  } else {
    getJson(READ_ENDPOINTS[__ITER % READ_ENDPOINTS.length]);
  }
}
