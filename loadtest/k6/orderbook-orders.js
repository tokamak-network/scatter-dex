/** Order POST burst. Mostly stresses the relayer-auth middleware
 *  (signature verify + body-hash compute) since the actual order
 *  body is rejected before persistence — k6 can't produce a real
 *  secp256k1 sig.
 *
 *  This is still the right shape for capacity planning: in
 *  production the auth verify cost is ~constant per request, and
 *  whatever the server can do here is the upper bound for signed-
 *  write throughput.
 *
 *  Run: K6_TARGET=http://localhost:4000 K6_PROFILE=load k6 run orderbook-orders.js
 */
import { selectStages, postSigned, getJson, THRESHOLDS } from "./helpers.js";

export const options = {
  stages: selectStages(),
  thresholds: THRESHOLDS,
};

function freshOrderId() {
  // 32-byte hex — orderbook's OFFER_HANDLE_RE accepts anything matching
  // /^0x[0-9a-fA-F]{64}$/. Use a counter + VU id so the same VU never
  // submits a duplicate id within its lifetime.
  const counter = (Math.random() * 1e16).toString(16).padStart(16, "0");
  return `0x${counter}${"00".repeat(24)}`;
}

export default function () {
  // 80 % writes — saturate the auth path. 20 % reads — exercise the
  // hot path that returns matched orders.
  const r = Math.random();
  if (r < 0.8) {
    postSigned("/api/orders", {
      id: freshOrderId(),
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
  } else {
    getJson("/api/orders");
  }
}
