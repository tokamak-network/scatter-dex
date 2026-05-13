/** Settlement-write burst + paired dashboard reads. The shared-
 *  orderbook's auth middleware (`relayerAuth`) runs BEFORE the
 *  settlement payload parser, so every signed write here short-
 *  circuits at 401 — the body shape exists only to make the request
 *  reach the auth middleware in the first place (Content-Length,
 *  Content-Type, etc).
 *
 *  Run: K6_TARGET=http://localhost:4000 K6_PROFILE=load k6 run orderbook-settlements.js
 */
import { selectProfile, postSigned, getJson, uniqueHex32, markExpectedStatuses, THRESHOLDS } from "./helpers.js";

export const options = {
  scenarios: {
    settlements: selectProfile(),
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  markExpectedStatuses();
}

const READ_ENDPOINTS = [
  "/api/settlements?limit=50",
  "/api/leaderboard?limit=20",
  "/api/network/totals",
];

export default function () {
  if (__ITER % 2 === 0) {
    postSigned("/api/settlements", {
      txHash: uniqueHex32(),
      blockNumber: __VU * 1000 + __ITER,
      blockTime: Math.floor(Date.now() / 1000),
      makerRelayer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      takerRelayer: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
      makerNullifier: uniqueHex32(),
      takerNullifier: uniqueHex32(),
      feeMaker: "100",
      feeTaker: "100",
      userMaxFeeMaker: 30,
      userMaxFeeTaker: 30,
      sellToken: "0x" + "aa".repeat(20),
      buyToken: "0x" + "bb".repeat(20),
      sellAmount: "1000",
      buyAmount: "2000",
    });
  } else {
    getJson(READ_ENDPOINTS[__ITER % READ_ENDPOINTS.length]);
  }
}
