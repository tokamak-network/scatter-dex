# Async Settlement Protocol

**Status:** Implemented — async settlement worker + 202 accept-then-settle (PR #391), cross-relayer matcher의 async-FSM 연동 포함
**Date:** 2026-04-23

## Motivation

The current `POST /api/authorize-orders` endpoint holds the HTTP connection
open for the full lifetime of an on-chain settlement:

1. Proof verification (fast)
2. `estimateGas` RPC round-trip
3. `tx-retry.sendAndWait`: broadcast → wait for receipt (up to `waitTimeoutMs =
   120_000ms`) → poll for receipt (up to `receiptPollRetries = 3` at
   `receiptPollIntervalMs = 10_000ms`)
4. DB updates

Anything past ~5 seconds already exceeds the mobile client's
`TIMEOUT_SUBMIT_MS = 30_000`. Observed failure mode on the mock stack (2026-04-23):
the relayer **does settle the tx successfully on-chain**, but the response is
too slow, the mobile fetch aborts, the user sees "Aborted" and a hung spinner,
and the order state is invisible until the user restarts the screen — despite
the underlying on-chain outcome being a success.

In production this risk multiplies:
- Mainnet / L2 RPCs are slower and less reliable than anvil.
- Blocks are non-instant (even 2 s block times push settlement past 10 s after
  a retry).
- Fee market spikes trigger replacement transactions, which can run long.
- Multiple concurrent orders serialise through `withTxLock`, stacking latency.

**The HTTP request lifetime of an order submission must not be coupled to the
on-chain settlement latency.**

## Goals

- Decouple "order accepted by relayer" from "order settled on-chain". The
  accept signal is fast and deterministic; the settlement signal is eventually
  consistent.
- Make order status discoverable from any client at any time via a single
  nullifier-keyed endpoint, so network hiccups, app restarts, and backgrounded
  apps don't strand an order.
- Make resubmission idempotent — a client that times out and retries gets the
  existing status, not a duplicate settlement or a rejection.
- Make settlement recoverable — transient on-chain failures enter a retry
  queue; permanent failures land in a dead-letter with enough context to
  re-drive manually.
- Keep the wire format backwards-compatible where possible so a frontend/CLI
  not on the new client can still submit.

Non-goals for this document:
- Mobile push-notification delivery (APNs/FCM). Addressed in a later sprint.
- Cross-relayer failover when the accepting relayer dies mid-settlement.
  Addressed alongside multi-relayer work.
- L1 reorg awareness beyond the single-confirmation model anvil exercises.
  Tuned per-chain at deploy time, not in the protocol.

## 1. Current state

### 1.1 Route: `POST /api/authorize-orders`

File: `zk-relayer/src/routes/authorize-orders.ts:181`

Synchronous flow:

```
verify proof → mark stored.pending → (if same-token) submitScatterDirectAuth
                                   → await sendAndWait (broadcast + receipt)
                                   → res.json({ status: "settled", txHash })
                                   → (else) shared-orderbook publish +
                                     findMatch + possibly await settleAuth
                                   → res.json(...)
```

The handler awaits on-chain settlement before responding. Two awaits are
long-lived:

- `estimateAndGuard` → `contract[method].estimateGas(...)` (1 RPC round-trip)
- `sendAndWait` → `tx.wait()` (up to 2 min) + `pollReceipt` (up to 30 s more)

### 1.2 Route: `GET /api/authorize-orders/:nullifier`

File: `zk-relayer/src/routes/authorize-orders.ts:403`

Already returns `{ status, submittedAt, settleTxHash }`. Status values today:
`pending | matched | settled | cancelled`. Reachable only from in-memory
`authorizeOrders` map — not durable across relayer restarts.

### 1.3 Mobile submission path

File: `mobile/src/services/OrderService.ts:365`

Calls `RelayerApiService.submitAuthorizeOrder(...)` which uses
`fetchWithTimeout` with `TIMEOUT_SUBMIT_MS = 30_000`. Expects the response
body to carry the final settlement status. No local persistence of in-flight
orders; on fetch abort, the order's fate is unknown to the client.

### 1.4 Concrete problems

- **P1 — HTTP lifetime ≅ settlement lifetime.** Any on-chain latency above
  the mobile timeout looks like failure to the user even when settlement
  succeeds.
- **P2 — Status is volatile.** `authorizeOrders` map is in-memory; relayer
  restart drops pending orders, breaking the status lookup.
- **P3 — No idempotency.** Resubmitting the same nullifier is either
  double-spent (if it already settled) or blocked via an ad-hoc check,
  neither of which is specified.
- **P4 — No retry semantics.** `sendAndWait` retries at the tx layer, but a
  permanent RPC outage kills the handler. There is no durable "finish this
  later" queue.
- **P5 — No mobile resume.** If the app is backgrounded mid-fetch, there is
  no local record that a settlement is in flight, so History cannot show it.

## 2. Proposal

### 2.1 Response model: accept-then-settle

The `POST /api/authorize-orders` handler performs only the fast, deterministic
steps before responding:

1. Validate request shape / public signals / rate limit.
2. Verify Groth16 proof locally.
3. Check idempotency (see §2.4).
4. Persist the order to the relayer DB with status `accepted`.
5. Enqueue a settlement job keyed by nullifier.
6. Respond `202 Accepted` with:

```jsonc
// 구현은 §2.3 의 상태 객체 전체에 nullifier/pollUrl 을 더해 반환한다
{
  "status": "accepted",
  "nullifier": "0x...",
  "submittedAt": 1714..., // ms epoch
  "updatedAt": 1714...,
  "attempt": 0,
  "settleTxHash": null,
  "error": null,
  "expiresAt": 1714...,   // unix seconds (from order.expiry)
  "pollUrl": "/api/authorize-orders/0x..." // convenience
}
```

Typical response time target: **< 500 ms** (dominated by proof verification;
no RPC calls).

### 2.2 Settlement worker

A single `SettlementWorker` per relayer process consumes the queue:

- Dequeue next `accepted` order → set status `settling` with `attempt = N`.
- For same-token orders: run `submitScatterDirectAuth(order, fee)`.
- For cross-token orders: participate in matching; on match, run
  `settleAuth(a, b, ...)`.
- On success: status `settled`, record `settleTxHash`, emit
  `settlement-completed` internal event (SSE/WS later).
- On transient failure (RPC error, timeout, replacement fee): backoff and
  re-enqueue with incremented `attempt`. Cap at `MAX_ATTEMPTS`, then route to
  dead-letter.
- On permanent failure (revert, nonce-too-low, invalid args): status
  `failed`, surface error to clients via the status endpoint, do not retry.

The queue lives in SQLite (`zk-relayer/zk-relayer.db`) — the same store that
already holds `authorize_orders`. Durable across restarts.

Concurrency: start with `WORKER_CONCURRENCY = 1` (matches today's
`withTxLock`). Increase once nonce management lands (§2.6).

### 2.3 Status model

Single flat FSM, persisted per nullifier:

```
accepted → settling → settled    (happy path)
        → settling → retrying → settling → settled   (transient RPC blip)
        → settling → failed    (revert / permanent)
        → settling → dead_letter (exhausted retries without a revert signal)
cancelled                       (explicit cancel, see §2.7)
expired                         (expiry time passed without settlement)
```

`GET /api/authorize-orders/:nullifier` returns:

```jsonc
{
  "status": "accepted" | "settling" | "retrying" | "settled" | "failed" | "dead_letter" | "cancelled" | "expired",
  "submittedAt": 1714...,
  "updatedAt": 1714...,
  "attempt": 0,            // number of settlement attempts so far
  "settleTxHash": "0x...", // present once broadcast, even if still unconfirmed
  "error": "...",          // present for failed / dead_letter, user-friendly
  "expiresAt": 1714...     // unix seconds (from order.expiry)
}
```

Backwards compatibility: the today-used values (`pending`, `matched`,
`settled`, `cancelled`) are kept as aliases for one release; new clients use
the new names.

> 구현 노트: `matched` 는 settlement worker 가 매칭~정산 사이에 쓰는
> **인메모리 중간 상태**로 남아 있다 (`settlement-worker.ts` — DB 상태는
> `settling` 유지, 클라이언트에 노출되지 않음). 멱등성 검사용
> `IN_FLIGHT_STATUSES` 는 `{matched, settling}` 이다
> (`types/authorize-order.ts`).

### 2.4 Idempotency

The nullifier is the idempotency key — it is globally unique per order by
construction (double-spend protection is already built on it).

`POST /api/authorize-orders` with a nullifier already present:

- **Status is terminal** (`settled | failed | expired | cancelled`):
  return `200 OK` with current status. Do not verify proof again.
- **Status is in progress** (`accepted | settling | retrying`):
  return `202 Accepted` with current status. Do not re-enqueue. Do not
  verify proof again (the old record has already been verified; re-running
  verification wastes CPU and opens a DoS vector).
- **Status is `dead_letter`**: return `409 Conflict` with the current status —
  client must surface to the user, as the relayer gave up. A human operator
  can manually retry via an admin endpoint.

Implementation: add a UNIQUE constraint on `authorize_orders.nullifier`
(likely already implicit — verify in migration); wrap insert in a `try/catch`
on the unique violation, then `SELECT` the existing row.

### 2.5 Retry policy

```
attempt 1:  retry after 2s
attempt 2:  retry after 8s
attempt 3:  retry after 30s
attempt 4:  retry after 120s
attempt 5:  retry after 300s
         →  dead_letter
```

Total retry budget ≈ 7 minutes. Tuned to cover:
- Transient RPC outages (typically < 1 min).
- Fee spikes requiring gas bump (detected via `sendAndWait`'s phase-1 retry).
- Mempool congestion (waits naturally resolve within a few blocks).

**Classification**:
- `permanentPatterns` from `tx-retry.ts` (revert, nonce too low, invalid
  argument, etc.) → go straight to `failed`, do not retry.
- `transientPatterns` (timeout, ECONNREFUSED, 5xx) → retry per schedule.
- Unknown errors → one retry as a safety net, then `failed`.

### 2.6 Nonce management

Today: `withTxLock` serialises all tx sends through the relayer signer. Works
at concurrency 1. To raise `WORKER_CONCURRENCY`, add a nonce manager:

- Maintain `nextNonce` in memory, initialised from
  `provider.getTransactionCount(address, 'pending')` at boot.
- Allocate on `sendFn` call; release on final success/failure; gap-aware:
  if a tx fails and its nonce was not consumed on-chain, rewind.
- Resync on boot and on any "nonce too low" error (a human may have sent a
  tx externally).

Defer full implementation to a follow-up PR; Sprint 1 ships `CONCURRENCY = 1`
with the nonce manager stubbed behind an interface so §2.6 doesn't block §2.2.

### 2.7 Cancel (out of scope for Sprint 1)

`DELETE /api/authorize-orders/:nullifier` is currently 501 because there is
no authenticated-cancel mechanism. Design exists (EdDSA sig over nullifier)
but belongs to its own PR. Expiry-based cancel is already implicit — expired
orders land in status `expired` via a periodic sweeper (new, §2.8).

### 2.8 Expiry sweeper

New periodic task on the relayer (every 60 s):

- `SELECT nullifier FROM authorize_orders WHERE status IN ('accepted', 'settling', 'retrying') AND expiry < now`
- Update each to `expired`, drop from queue.

Prevents the queue from retrying orders the circuit will reject on-chain
anyway.

## 3. Mobile client changes

### 3.1 Local pending queue

Persist each submitted order to AsyncStorage (or, better, `expo-sqlite`
alongside `scatterdex_trade_history.db`) with:

```ts
interface PendingOrder {
  nullifier: string;
  relayerUrl: string;
  submittedAt: number; // ms
  lastPolledStatus: StatusValue;
  lastPolledAt: number;
  orderSummary: {...}; // enough for History to render a row
}
```

Lifecycle:

1. Immediately after the relayer returns 202, write `PendingOrder` and
   notify the History screen to show a "Pending" row.
2. `setSubmitting(false)`, navigate to History, show toast "Submitted —
   settling…".
3. Poll `GET /api/authorize-orders/:nullifier` per §3.2.
4. On terminal status, remove from pending queue and update History.

### 3.2 Polling strategy

- While the app is foregrounded **and** the History screen is mounted:
  poll every 2 s for the first 30 s, then every 5 s, up to a max of 5 min.
- While backgrounded: stop polling. On resume, refresh all pending entries
  in a single batch (up to 50 at a time).
- Exponential backoff on consecutive network errors: 2 s → 5 s → 15 s → 60 s.
- **Never spin on a single order.** Move polling into a central `PendingOrdersService`
  so two screens don't double-poll.

### 3.3 UI surfaces

- **Trade screen**: on successful submit, close the submit state, show a
  non-blocking toast "Submitted — settling in the background", and offer a
  "View status" deep-link to History → Pending.
- **History / Pending tab**: list current pending orders with status text,
  attempt counter (if retrying), and an "Open tx" link once `settleTxHash`
  lands.
- **History / Failed**: terminal failures show the `error` string and a
  "Copy details" button for support.

### 3.4 Error UX

- `accepted` / `settling` / `retrying`: not errors — just status.
- `failed`: red row with user-friendly message.
- `dead_letter`: same as failed but with text suggesting "contact support".
- `expired`: neutral row "Expired before settling".
- Network error during polling: do not flip UI state; show a subtle
  offline indicator.

## 4. Data model

### 4.1 Relayer DB schema changes

Extend the existing `authorize_orders` table:

```sql
ALTER TABLE authorize_orders ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE authorize_orders ADD COLUMN next_retry_at INTEGER;          -- epoch ms; NULL when not scheduled
ALTER TABLE authorize_orders ADD COLUMN last_error TEXT;
ALTER TABLE authorize_orders ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_authorize_orders_queue
  ON authorize_orders (status, next_retry_at)
  WHERE status IN ('accepted', 'retrying');
```

The status column already exists — we add new values and keep the old ones
as aliases during the transition.

### 4.2 Mobile pending DB

New table in `scatterdex_trade_history.db` (avoid AsyncStorage for a queue —
we need atomic updates and indexed reads):

```sql
CREATE TABLE IF NOT EXISTS pending_orders (
  nullifier TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  relayer_url TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  last_polled_status TEXT,
  last_polled_at INTEGER,
  order_summary TEXT NOT NULL,   -- JSON blob
  UNIQUE (nullifier, wallet_address)
);
CREATE INDEX idx_pending_orders_wallet ON pending_orders (wallet_address);
```

## 5. Migration plan

- **Release 1** (this sprint): relayer implements async response + status FSM
  + idempotency + retry queue. Old clients keep working: they see the new
  statuses but already poll `GET /:nullifier`, so they can observe terminal
  status if they wait long enough. Response shape extends with new fields;
  existing fields unchanged.
- **Release 2**: mobile switches to the async flow + local pending queue.
  Old mobile builds still work against the new relayer (they block on the
  HTTP response, which now arrives immediately with `status: accepted`; the
  old client treats that as success and moves on, missing the settlement
  confirmation — acceptable for one release).
- **Release 3**: remove legacy status aliases; fully drop the synchronous
  response path.

## 6. Testing

- **Relayer**: unit tests for the FSM transitions, the retry classifier
  (extend `tx-retry.ts` tests), and the idempotency deduper. Integration
  test that simulates an RPC outage mid-settlement, verifies the order
  ends up `settled` after recovery, and a duplicate submission during the
  outage returns `202` with `status: retrying`.
- **Mobile**: unit tests for the pending-orders service (add/remove/poll);
  manual E2E in the mock env by pausing anvil mid-flow.
- **Chaos**: add a `FAIL_NEXT_TX=1` admin flag to force a single transient
  failure — lets us verify retry works in the dev env without real RPC
  outages.

## 7. Open questions

- **SSE vs polling.** SSE from the relayer would collapse poll traffic. Not
  in Sprint 1 because it adds a second transport to maintain, but worth
  prototyping before Release 3.
- **Proof caching.** Today proofs are stored alongside orders. For
  idempotent resubmission we can skip re-verification but the payload is
  still large. Consider a `proofHash` column so the client can confirm it's
  resubmitting the same proof, not a different one for the same nullifier
  (which would be a bug we want to reject loudly).
- **Mobile push.** When we add APNs/FCM, the poll loop can extend its
  backoff significantly (or be dropped entirely once the pending queue is
  small). Design leaves room for this without changing the relayer.
- **Rate limit scope.** Writes are currently limited per-IP (with the IPv6
  keyGenerator warning in the log). Should idempotent resubmits count
  against the limit, or only first-seen nullifiers? Leaning toward the
  latter to avoid punishing clients that legitimately retry.
