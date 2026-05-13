/* Shared helpers for the shared-orderbook k6 scenarios.
 *
 * The orderbook authenticates every write with an EIP-191 signature
 * (see `shared-orderbook/src/middleware/auth.ts`). k6's runtime
 * (Goja) doesn't bundle secp256k1, so we can't sign valid messages
 * inside the script — every signed write here ships an all-zero
 * signature and is therefore rejected at the auth middleware (401).
 * That's intentional: the auth path is the cost-dominant code on
 * the server (`verifyMessage` + body-hash recompute), so a stream
 * of 401s still saturates the same path that real writes would.
 *
 * What this scenario is and isn't:
 *   - IS: an upper-bound stress on the server's auth-verify +
 *     sqlite-read code paths. The numbers are the ceiling for
 *     signed-write throughput, since real writes pay the same
 *     `verifyMessage` cost on top of the same parsing.
 *   - ISN'T: a functional simulation. Order rows are not persisted,
 *     because auth rejects before insertion. For functional tests
 *     use the vitest suite in `shared-orderbook/test/`.
 *
 * If we ever ship a real signed harness, the path forward is a
 * companion Node script that pre-signs N nonces with a deterministic
 * key, dumps them to JSON, and the k6 script reads the pool via
 * `SharedArray` at startup. That's deliberately not in this PR.
 */
import http from "k6/http";
import { check } from "k6";

export const TEST_RELAYER_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const TEST_RELAYER_URL_LABEL = "https://loadtest.invalid";

export const TARGET = __ENV.K6_TARGET || "http://localhost:4000";
export const PROFILE = __ENV.K6_PROFILE || "load";

/** Tell k6 that 4xx responses are NOT failures. Without this every
 *  signed-write scenario would trip `http_req_failed` because the
 *  auth middleware (correctly) rejects our zero signature with 401.
 *  Call this in each scenario's `setup()` or top-level. */
export function markExpectedStatuses() {
  http.setResponseCallback(http.expectedStatuses(
    { min: 200, max: 299 },
    { min: 400, max: 499 },
  ));
}

/** Profile → executor config. Uses the **constant-arrival-rate**
 *  executor so the `rate` field is genuinely requests-per-second
 *  (not VUs). `preAllocatedVUs` caps the concurrency we permit in
 *  pursuit of the target rate — set generously so a slow server
 *  doesn't artificially cap RPS. */
export const PROFILES = {
  smoke: {
    executor: "constant-arrival-rate",
    rate: 10,
    timeUnit: "1s",
    duration: "30s",
    preAllocatedVUs: 20,
    maxVUs: 50,
  },
  load: {
    executor: "constant-arrival-rate",
    rate: 100,
    timeUnit: "1s",
    duration: "1m",
    preAllocatedVUs: 100,
    maxVUs: 200,
  },
  stress: {
    executor: "constant-arrival-rate",
    rate: 1000,
    timeUnit: "1s",
    duration: "2m",
    preAllocatedVUs: 500,
    maxVUs: 1000,
  },
};

export function selectProfile() {
  const p = PROFILES[PROFILE];
  if (!p) throw new Error(`Unknown K6_PROFILE=${PROFILE}; expected one of: ${Object.keys(PROFILES).join(", ")}`);
  return p;
}

/** Per-tag thresholds. Reads get a tighter p95 (sqlite-only) than
 *  writes (auth verify). 4xx no longer counts toward http_req_failed
 *  thanks to `markExpectedStatuses`, so the failure-rate threshold
 *  is just for actual transport errors / 5xx. Tags are applied via
 *  the `tags` option on each `http.*` call. */
export const THRESHOLDS = {
  "http_req_duration{type:read}": ["p(95)<200"],
  "http_req_duration{type:write}": ["p(95)<400"],
  http_req_failed: ["rate<0.01"],
};

/** Unique 32-byte hex from k6's built-in VU and iteration counters.
 *  Stable across the entire run, no collisions inside a single
 *  scenario (since (__VU, __ITER) is unique per request). */
export function uniqueHex32() {
  const vu = __VU.toString(16).padStart(8, "0");
  const iter = __ITER.toString(16).padStart(16, "0");
  const tail = "00".repeat(20);
  return `0x${vu}${iter}${tail.slice(0, 64 - vu.length - iter.length)}`;
}

/** Build the auth header set with a dummy zero signature. The server
 *  will reject with 401; we count that as exercising the auth path. */
function buildHeaders(method, path) {
  return {
    "x-relayer-address": TEST_RELAYER_ADDRESS,
    "x-relayer-signature": "0x" + "00".repeat(65),
    "x-relayer-timestamp": Math.floor(Date.now() / 1000).toString(),
    "x-relayer-url": TEST_RELAYER_URL_LABEL,
    "Content-Type": "application/json",
  };
}

/** GET helper — tagged as `read` so it lands in the read-side
 *  threshold bucket. */
export function getJson(path) {
  const res = http.get(`${TARGET}${path}`, { tags: { type: "read" } });
  check(res, { "status is 2xx or 4xx": (r) => r.status < 500 });
  return res;
}

/** POST helper — tagged as `write`. Expects 401 from auth verify;
 *  treats 5xx as a real failure. */
export function postSigned(path, body) {
  const payload = JSON.stringify(body);
  const res = http.post(`${TARGET}${path}`, payload, {
    headers: buildHeaders("POST", path),
    tags: { type: "write" },
  });
  check(res, { "auth path executed (status < 500)": (r) => r.status < 500 });
  return res;
}
