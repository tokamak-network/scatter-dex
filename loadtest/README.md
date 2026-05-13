# Load tests (R-14)

[k6](https://k6.io)-based load tests for the **shared-orderbook** REST API.
Lives outside the npm workspaces because k6 scripts are loaded by the k6
binary (Goja runtime, not Node), and adding them to a workspace would
just confuse `npm install`.

## What's covered

- `k6/orderbook-smoke.js` — single-VU health check + 1 order POST + 1
  leaderboard read. Used to confirm the server is reachable and signed
  requests pass auth before kicking off heavier scenarios.
- `k6/orderbook-orders.js` — concurrent order POST/GET burst. Exercises
  the relayer-auth body-hash path under load.
- `k6/orderbook-settlements.js` — settlement POST + settlement reads
  (per-relayer stats, network totals, leaderboard).
- `k6/orderbook-leaderboard.js` — read-heavy scenario. No writes — useful
  for measuring how the read-side aggregates scale.

Each scenario defines its own ramp profile via k6 `stages`. Defaults
match the "load" tier (100 RPS sustained for 1 minute). Override via
env:

```
K6_PROFILE=smoke    # 10 RPS, 30s    — quick sanity
K6_PROFILE=load     # 100 RPS, 1min  — default
K6_PROFILE=stress   # 1000 RPS, 2min — push past expected ceiling
```

## Running locally

Install k6 (`brew install k6` on Mac, see <https://k6.io/docs/get-started/installation/>
for everything else). Then:

```sh
# In one terminal — start the orderbook against an empty DB.
cd shared-orderbook
ALLOW_PRIVATE_RELAYER_URLS=1 npm run dev

# In another terminal — point k6 at it.
cd loadtest
K6_TARGET=http://localhost:4000 K6_PROFILE=smoke k6 run k6/orderbook-smoke.js
```

The relayer auth fixtures are derived from deterministic private keys
in `k6/helpers.js` — fine for load testing because every request still
exercises the real EIP-191 verification path; just don't reuse those
keys for anything else.

## Running in CI

Manual `workflow_dispatch` on `.github/workflows/load-test.yml`. Not
scheduled because k6 against a real environment is bursty and noisy —
trigger it before a release cut, or when investigating a perf
regression, or after a code-path change in the orderbook server.

## Thresholds

Defined inside each script's `options.thresholds`. The general baseline
is `http_req_duration p(95) < 200ms` for read endpoints and `< 400ms`
for signed writes. Tightening these will gate CI failures; loosening
them lets noisy runs slip past — calibrate based on what the deploy's
SLO promises.

## What this doesn't cover

- The on-chain settle path itself (gas, reorg, RPC throughput) — that
  belongs to a separate chain-side fork test.
- The zk-relayer ZK proof gen pipeline — separate suite, would need
  the WASM runtime.
- Long-duration soak tests (multi-hour). The CI runner times out
  well before useful soak data emerges; run those on a dedicated host.
