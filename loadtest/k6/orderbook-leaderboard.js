/** Read-heavy scenario. No writes — measures how the settlement-
 *  aggregate endpoints (leaderboard, network totals, per-relayer
 *  stats) scale under burst read. These hit the BigInt sum in
 *  `OrderbookDB.tokenAgg` / `getNetworkSettlementTotals` /
 *  `getLeaderboard` — all sqlite reads + Node-side aggregation.
 *
 *  Run: K6_TARGET=http://localhost:4000 K6_PROFILE=load k6 run orderbook-leaderboard.js
 */
import { selectStages, getJson, THRESHOLDS } from "./helpers.js";

export const options = {
  stages: selectStages(),
  // Reads should be much tighter than writes — drop p95 to 150ms.
  thresholds: {
    ...THRESHOLDS,
    http_req_duration: ["p(95)<150"],
  },
};

// Round-robin across the read endpoints so no single one dominates
// the report. Each is sampled roughly equally.
const ENDPOINTS = [
  "/api/leaderboard?limit=20",
  "/api/leaderboard?limit=20&metric=successRate",
  "/api/network/totals",
  "/api/network/totals?since=" + (Math.floor(Date.now() / 1000) - 86400),
  "/api/settlements?limit=50",
  "/api/relayers/0x70997970C51812dc3A010C7d01b50e0d17dc79C8/stats",
];

export default function () {
  const path = ENDPOINTS[Math.floor(Math.random() * ENDPOINTS.length)];
  getJson(path);
}
