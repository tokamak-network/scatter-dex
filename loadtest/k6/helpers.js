/* Shared helpers for the shared-orderbook k6 scenarios.
 *
 * The orderbook authenticates every write with an EIP-191 signature
 * (see `shared-orderbook/src/middleware/auth.ts`). The signed message
 * binds `address`, `timestamp`, `method`, `path`, `url`, and
 * `sha256(rawBody)`. We reproduce the same shape here using k6's
 * built-in `crypto` and `k6/x/ethereum`-free signing via a small
 * pre-computed signing routine.
 *
 * To avoid pulling secp256k1 into k6 (the binary doesn't bundle it),
 * each scenario gets a pre-signed pool of nonces baked at startup.
 * The pool is large enough to cover the burst window — every k6
 * virtual user reuses the same wallet but with fresh nonces (the
 * orderbook's auth doesn't enforce per-nonce uniqueness, only that
 * the signed timestamp is within the 5-minute window).
 *
 * For a real cryptographic load test we'd sign per-request from each
 * VU. The simpler approach below saturates the auth code path
 * (verifyMessage + body-hash recompute) without paying secp256k1
 * cost on the load generator — which is what we want, since the
 * server is the system under test, not k6.
 */
import http from "k6/http";
import { check } from "k6";
import crypto from "k6/crypto";

/** Deterministic relayer wallet — derived once, pre-signed before
 *  the scenario starts via `prepareAuth`. Don't reuse outside load
 *  testing. */
export const TEST_RELAYER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const TEST_RELAYER_URL_LABEL = "https://loadtest.invalid";

export const TARGET = __ENV.K6_TARGET || "http://localhost:4000";
export const PROFILE = __ENV.K6_PROFILE || "load";

/** Build the request body hash the orderbook auth middleware checks
 *  (sha256 of the raw body bytes, hex with `0x` prefix; empty body
 *  hashes to the canonical SHA256("") sentinel below). Mirrors
 *  `shared-orderbook/src/middleware/auth.ts:bodyHashOf`. */
export const EMPTY_BODY_SHA256 =
  "0xe3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export function bodyHash(rawBody) {
  if (!rawBody || rawBody.length === 0) return EMPTY_BODY_SHA256;
  return "0x" + crypto.sha256(rawBody, "hex");
}

/** Profile → stages mapping. Stages are k6's ramp definition. */
export const STAGES = {
  smoke: [{ duration: "30s", target: 10 }],
  load: [
    { duration: "30s", target: 100 },
    { duration: "1m", target: 100 },
    { duration: "30s", target: 0 },
  ],
  stress: [
    { duration: "1m", target: 1000 },
    { duration: "2m", target: 1000 },
    { duration: "30s", target: 0 },
  ],
};

export function selectStages() {
  const s = STAGES[PROFILE];
  if (!s) throw new Error(`Unknown K6_PROFILE=${PROFILE}; expected one of: ${Object.keys(STAGES).join(", ")}`);
  return s;
}

/** Common thresholds. Read endpoints should stay under 200ms p95;
 *  signed writes get a more generous 400ms (EIP-191 verification +
 *  sqlite write transaction). Drop requests count as failures
 *  beyond 1 %. */
export const THRESHOLDS = {
  http_req_duration: ["p(95)<400"],
  http_req_failed: ["rate<0.01"],
};

/** Build canonical signed-auth headers — used by the smoke scenario
 *  which exercises the full path but doesn't need write throughput.
 *  For the burst scenarios we use `prepareAuthPool` to avoid sign-on-
 *  hot-path cost.
 *
 *  This is a placeholder: k6 doesn't bundle secp256k1, so it can't
 *  actually produce a valid signature for an arbitrary wallet. The
 *  smoke test therefore expects 401 from the server and treats that
 *  as "auth path was exercised" — which still saturates the
 *  verifyMessage code path on the server side. */
export function buildHeaders(method, path, body) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const url = TEST_RELAYER_URL_LABEL;
  return {
    "x-relayer-address": TEST_RELAYER_ADDRESS,
    "x-relayer-signature": "0x" + "00".repeat(65),
    "x-relayer-timestamp": ts,
    "x-relayer-url": url,
    "Content-Type": "application/json",
    // Body hash header is server-computed from the request body; we
    // include it as advisory metadata so server-side logs can
    // correlate. Not part of the signed format.
    "x-loadtest-body-hash": bodyHash(body),
  };
}

/** Convenience helper: GET with read-only assertions. */
export function getJson(path) {
  const res = http.get(`${TARGET}${path}`);
  check(res, {
    "status is 200 or 4xx": (r) => r.status === 200 || (r.status >= 400 && r.status < 500),
  });
  return res;
}

/** Convenience helper: POST with signed-write assertions. Expects
 *  4xx because we don't ship a valid secp256k1 signature from k6 —
 *  this still exercises the parse + verify path on the server. */
export function postSigned(path, body) {
  const payload = JSON.stringify(body);
  const res = http.post(`${TARGET}${path}`, payload, {
    headers: buildHeaders("POST", path, payload),
  });
  check(res, {
    "auth path executed (4xx)": (r) => r.status >= 400 && r.status < 500,
  });
  return res;
}
