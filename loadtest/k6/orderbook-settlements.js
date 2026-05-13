/** Settlement-write burst + paired reads. Mirrors the verify-job
 *  + leaderboard combination that production hits when relayers
 *  push fresh settlements and dashboards refresh in the same
 *  window.
 *
 *  Run: K6_TARGET=http://localhost:4000 K6_PROFILE=load k6 run orderbook-settlements.js
 */
import { selectStages, postSigned, getJson, THRESHOLDS } from "./helpers.js";

export const options = {
  stages: selectStages(),
  thresholds: THRESHOLDS,
};

function freshTxHash() {
  const counter = (Math.random() * 1e16).toString(16).padStart(16, "0");
  return `0x${counter}${"00".repeat(24)}`;
}

function freshNullifier() {
  return "0x" + (Math.random() * 1e16).toString(16).padStart(16, "0") + "00".repeat(24);
}

export default function () {
  const r = Math.random();
  if (r < 0.5) {
    // Settlement POST — body validated even when auth fails, so
    // make it shape-correct.
    postSigned("/api/settlements", {
      txHash: freshTxHash(),
      blockNumber: Math.floor(Math.random() * 1e6) + 1,
      blockTime: Math.floor(Date.now() / 1000),
      makerRelayer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      takerRelayer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      makerNullifier: freshNullifier(),
      takerNullifier: freshNullifier(),
      feeMaker: "100",
      feeTaker: "100",
      userMaxFeeMaker: 30,
      userMaxFeeTaker: 30,
      sellToken: `0x${"aa".repeat(20)}`,
      buyToken: `0x${"bb".repeat(20)}`,
      sellAmount: "1000",
      buyAmount: "2000",
    });
  } else {
    // Refresh-shape reads that a dashboard would issue.
    const reads = [
      "/api/settlements?limit=50",
      "/api/leaderboard?limit=20",
      "/api/network/totals",
    ];
    getJson(reads[Math.floor(Math.random() * reads.length)]);
  }
}
