/** Read-only round-robin across the settlement-aggregate endpoints.
 *  No writes — measures how the BigInt sum / `tokenAgg` paths in
 *  `OrderbookDB` scale under burst read.
 *
 *  Run: K6_TARGET=http://localhost:4000 K6_PROFILE=load k6 run orderbook-leaderboard.js
 */
import { selectProfile, getJson, markExpectedStatuses, THRESHOLDS } from "./helpers.js";

export const options = {
  scenarios: {
    reads: selectProfile(),
  },
  // Reads-only scenario — tighten p95 to 150ms in the `read` bucket.
  thresholds: {
    ...THRESHOLDS,
    "http_req_duration{type:read}": ["p(95)<150"],
  },
};

export function setup() {
  markExpectedStatuses();
}

const SINCE_24H = Math.floor(Date.now() / 1000) - 86400;
const ENDPOINTS = [
  "/api/leaderboard?limit=20",
  "/api/leaderboard?limit=20&metric=successRate",
  "/api/network/totals",
  `/api/network/totals?since=${SINCE_24H}`,
  "/api/settlements?limit=50",
  "/api/relayers/0x70997970C51812dc3A010C7d01b50e0d17dc79C8/stats",
];

export default function () {
  getJson(ENDPOINTS[__ITER % ENDPOINTS.length]);
}
