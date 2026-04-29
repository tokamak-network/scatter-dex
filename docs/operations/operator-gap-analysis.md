# Operator Gap Analysis & Reinforcement Plan

_Audit date: 2026-04-29_
_Scope: `apps/operators/` (Next.js operator console) + `zk-relayer/` (Node service) from a relayer operator's POV._

This document captures the gaps a real relayer operator would hit today and lays out a phased plan to close them. It is the working spec for the `feat/operator-ops-*` branch series.

---

## 1. What exists today

### `apps/operators/` routes
| Route | Purpose | State |
|---|---|---|
| `/` | Landing / personas / CTA | Live |
| `/register` | On-chain `RelayerRegistry.register()` flow | Live |
| `/profile` | Update URL/fee, top-up bond, request/execute exit | Live (UX minimal) |
| `/dashboard` | On-chain bond/fee + ops stats (24h revenue, latency, recent settlements) | **Mock data** |
| `/orders` | Live order feed, settled/pending/expired/cancelled filter | **Mock data** |
| `/leaderboard` | All registered relayers, ranked by bond | Live (cross-relayer fetch) |
| `/treasury` | FeeVault balances, claim UI, withdrawals table | **Partially mock** |

### `zk-relayer/` HTTP surface (≈35 endpoints, 11 groups)
- **Admin** (`/api/admin/*`) — `pause/resume`, `drain`, `fee` update, `sanctions` CRUD, `profile` metadata. Header-auth via `x-admin-key`.
- **Public** — `/api/info`, `/api/authorize-orders`, `/api/private-claim`, `/api/vault`, `/api/relayer/stats`, `/api/p2p`, `/health`.
- **Metrics** — in-memory rolling window only (no Prometheus, no persistence).
- **Logs** — stdout only, unstructured.

### Operator-facing docs
- `docs/operations/{deployment, operations-guide, fee-architecture, gas-cost-analysis, local-setup, mev-protection, relayer-security}.md`
- Not surfaced inside the operators app.

---

## 2. Operator-journey gap map

| Stage | What the operator does | Today | Critical gap |
|---|---|---|---|
| **Day 0 — onboarding** | Understand requirements (key, RPC, bond, hardware) | Marketing landing only | No Getting Started checklist |
| **Day 1 — registration** | Post bond, set URL/fee | `/register` works | No pre-flight gas/bond simulation |
| **Day 2 — bring-up** | Fill `.env`, run process | Docs only, not in app | No in-app setup wizard / `.env` validator |
| **Day 3 — monitoring** | "Are orders flowing? Are they settling? Gas spend?" | `/dashboard`, `/orders` mocked | **No persistent indexer → biggest hole** |
| **Week 1 — earnings** | Track per-token fee accrual, claim | Backend `/api/vault` works; UI mocked | No real-time accrual, no auto-claim policy |
| **Week 2+ — incidents** | Diagnose settlement failures, RPC drops, gas spikes | `/health` 200/503; stdout logs | No alerting, no log search, no tx-retry visibility |
| **Month 1 — operational tweaks** | Adjust fee, sanctions list, pause | Admin API exists, UI absent | Admin actions only via curl |
| **Exit** | Recover bond | `requestExit`/`executeExit` work | No cooldown countdown, no warning about pending orders |
| **Security** | Rotate keys after suspected compromise | Not supported | **Zero key-rotation flow** |

---

## 3. Reinforcement plan

### Phase 1 — "operate at all" (must-have, 2–3 weeks)

1. **Persistent indexer + real-data dashboards** *(highest impact)*
   - Persist settlement events, fee accruals, gas spend in `zk-relayer` SQLite.
   - New endpoint: `GET /api/relayer/history` (paginated, filterable).
   - Replace mocks in `/dashboard`, `/orders`, `/treasury` with this feed.
   - Deliverable: 24h settle count, avg gas, per-token fee accrual, recent settlements.

2. **In-app setup wizard (`/onboarding`)**
   - Per-field `.env` checklist with OK/FAIL signals.
   - RPC ping, contract-address validation, bond balance + approval check, ADMIN_API_KEY presence.
   - Single-screen "ready to start" status.

3. **Admin panel UI (`/admin`)**
   - Surfaces existing `/api/admin/*` endpoints in the app:
     - `pause/resume`, `drain`, fee update, sanctions add/remove, profile metadata.
   - Auth: paste ADMIN_API_KEY (Phase 2: signature-based via owner address).

4. **Exit-flow polish**
   - `/profile` shows cooldown countdown, warns about unsettled in-flight orders, surfaces re-registration guidance.

### Phase 2 — "stable operations" (3–4 weeks)

5. **Real-time alerting**
   - `/health` polling + slashing-event subscription → in-app toast + optional webhook (Slack/Discord/Telegram).
   - Triggers: RPC down, consecutive settlement failures, low bond, gas-cap breach.

6. **Order/transaction debug view**
   - `/orders/[id]` shows proof state, public signals, settlement tx hash, failure reason, retry history.
   - Wire the existing `tx-recovery` module's data into the UI.

7. **Auto-claim policy for fees**
   - On `/treasury`: per-token threshold ("auto-claim when ≥ X").
   - Compare expected gas vs. claim value automatically.

8. **Structured logging + search**
   - Replace stdout logs with JSON-line logging (`pino` or similar).
   - `/admin/logs` page with level/module/text filter.

### Phase 3 — "compete and optimise" (4 weeks+)

9. **SLA / performance dashboard** — settlement latency p50/p95/p99, throughput trend, peer comparison via extended leaderboard.

10. **Key rotation flow** *(security-critical)* — new key registration → dual-sign window → revoke old key. Likely needs a contract change; spec separately before building.

11. **P2P / cross-relayer visibility** — trade-offer negotiation history, peer connection state, shared-orderbook sync indicators.

12. **Compliance / audit export** — sanctions-match logs CSV, settlement history export, regulator-ready report.

13. **In-app docs** — embed `docs/operations/*.md` under `/help`; per-error-code troubleshooting linked from inline failures.

---

## 4. Open planner decisions

- **Indexer placement** — Single-process SQLite inside `zk-relayer` (Phase 1 default; matches single-operator topology) vs. separate service (multi-instance future). Defaulting to in-process unless we hit a clustering need.
- **Admin auth model** — Keep `x-admin-key` header for Phase 1 simplicity; upgrade to wallet-signature (registered owner address) in Phase 2. Wallet-sig requires a small backend change.
- **Alert channels** — Webhook-first (operators usually want Slack/Discord pings) vs. in-app only (no extra infra). Start with webhook because operators don't keep the console open.

---

## 5. Recommended starting cut

Begin with **Phase 1 #1 (persistent indexer + real data)** and **Phase 1 #3 (admin panel UI)**:

- No contract changes, no spec churn.
- Removes the largest UX hole (mock dashboards) and the most awkward operational gap (curl-only admin).
- Each ships as its own PR; can run in parallel after the SQLite schema lands.

Subsequent PR sequence (suggested):
1. `feat/operator-indexer-schema` — SQLite schema + writer for settle/fee/gas events.
2. `feat/operator-history-api` — `GET /api/relayer/history` + `/api/vault/history`.
3. `feat/operator-dashboard-live` — `/dashboard` consumes real data; remove mocks.
4. `feat/operator-orders-live` — `/orders` + `/orders/[id]` consume real data.
5. `feat/operator-treasury-live` — `/treasury` consumes real fee accrual.
6. `feat/operator-admin-panel` — `/admin` UI for existing admin API.
7. `feat/operator-onboarding-wizard` — `/onboarding` setup checklist.
8. `feat/operator-exit-polish` — cooldown countdown + pending-orders warning on `/profile`.
