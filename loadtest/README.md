# Load tests (R-14)

[k6](https://k6.io)-based load tests for the **shared-orderbook** REST API.
Lives outside the npm workspaces because k6 scripts are loaded by the k6
binary (Goja runtime, not Node), and adding them to a workspace would
just confuse `npm install`.

## Scope

- IS — a stress on the server's **auth-verify** (`verifyMessage` +
  body-hash recompute) and **sqlite-read** code paths. Signed writes
  here all hit 401 because k6's runtime doesn't bundle secp256k1 —
  the load generator sends a zero signature on purpose. That still
  exercises the verify path, which is the cost-dominant step on
  production writes too.
- ISN'T — a functional test. No order/settlement rows are persisted
  in these runs. For functional coverage use the vitest suite in
  `shared-orderbook/test/`.

## What's covered

- `k6/orderbook-smoke.js` — 10 RPS for 30 s, walks every public read
  endpoint and slips in one signed-write probe per 6 iterations.
  Always runs at the same rate; doesn't honor `K6_PROFILE`.
- `k6/orderbook-orders.js` — 80/20 write/read burst on `/api/orders`.
- `k6/orderbook-settlements.js` — 50/50 write/read burst on
  `/api/settlements` + paired dashboard reads.
- `k6/orderbook-leaderboard.js` — read-only round-robin across the
  settlement-aggregate endpoints.

## Profiles

Set via `K6_PROFILE`. All three use the **constant-arrival-rate**
executor — `rate` is genuine requests-per-second, not a VU target.
`preAllocatedVUs` / `maxVUs` cap concurrency in pursuit of the rate;
a slow server doesn't artificially throttle the test.

| `K6_PROFILE` | Rate (RPS) | Duration | Pre-allocated VUs | Max VUs |
| --- | --- | --- | --- | --- |
| `smoke` | 10 | 30s | 20 | 50 |
| `load` (default) | 100 | 1m | 100 | 200 |
| `stress` | 1000 | 2m | 500 | 1000 |

The smoke *scenario* (`orderbook-smoke.js`) ignores `K6_PROFILE` and
runs its own fixed 10 RPS × 30 s shape; the other scenarios honor it.

## Thresholds

Tagged per request via `tags: { type: "read" | "write" }`:

- `http_req_duration{type:read}` — p95 < 200ms (`orderbook-leaderboard`
  tightens to 150ms since it's reads-only)
- `http_req_duration{type:write}` — p95 < 400ms (covers auth-verify
  cost on top of parsing)
- `http_req_failed` — < 1% real failures (5xx / transport). 4xx is
  retagged as expected via `markExpectedStatuses()` so the auth-
  reject doesn't poison the failure rate.

## Running locally

Install k6 (`brew install k6` on Mac; see <https://k6.io/docs/get-started/installation/>
for everything else). Then:

```sh
# In one terminal — start the orderbook against an empty DB.
cd shared-orderbook
ALLOW_PRIVATE_RELAYER_URLS=1 npm run dev

# In another terminal — point k6 at it.
cd loadtest
K6_TARGET=http://localhost:4000 K6_PROFILE=smoke k6 run k6/orderbook-smoke.js
```

## Running in CI

Manual `workflow_dispatch` on `.github/workflows/load-test.yml`. The
workflow expects an externally-reachable target URL — it does NOT
boot the orderbook itself (running the server inside the job would
need a registry-pushed image, which is out of scope here). Run it
against a deployed staging host or against a `gh-actions`-reachable
preview deploy.

## What this doesn't cover

- The on-chain settle path itself (gas, reorg, RPC throughput) — that
  belongs to a separate chain-side fork test.
- The zk-relayer ZK proof gen pipeline — separate suite, would need
  the WASM runtime.
- Long-duration soak tests (multi-hour). The CI runner times out
  well before useful soak data emerges; run those on a dedicated host.
- Real signed-write throughput. Add a companion Node script that
  pre-signs N nonces with a deterministic key, dumps them to JSON,
  and have the k6 scenarios read the pool via `SharedArray` at
  startup. Deliberately not in this PR.
