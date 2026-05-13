/** Order POST/GET burst. Mostly stresses the relayer-auth middleware
 *  (signature verify + body-hash compute) — k6 ships an all-zero
 *  signature so writes always hit 401, but the cost-dominant
 *  `verifyMessage` + parse + body-hash recompute path runs on every
 *  request and that's the actual SUT.
 *
 *  Run: K6_TARGET=http://localhost:4000 K6_PROFILE=load k6 run orderbook-orders.js
 */
import { selectProfile, postSigned, getJson, uniqueHex32, markExpectedStatuses, THRESHOLDS } from "./helpers.js";

export const options = {
  scenarios: {
    orders: selectProfile(),
  },
  thresholds: THRESHOLDS,
};

export function setup() {
  markExpectedStatuses();
}

export default function () {
  // 80 % writes — saturate the auth path. 20 % reads — exercise the
  // open-orders listing that frontends poll.
  if (__ITER % 5 !== 0) {
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
    getJson("/api/orders");
  }
}
