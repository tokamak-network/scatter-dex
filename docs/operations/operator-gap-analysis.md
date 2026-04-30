# Operator Gap Analysis & Reinforcement Plan

_v1 audit: 2026-04-29 · v2 update: 2026-04-29 (Phase 1 + Phase 2 ship review) · v3 wrap-up: 2026-04-30 (Phase 3 + §2 close-out)_
_Scope: `apps/operators/` (Next.js operator console) + `zk-relayer/` (Node service) from a relayer operator's POV._

This document captures the gaps a real relayer operator would hit today and lays out a phased plan to close them. v2 marks the v1 plan against what shipped, retires items overtaken by other work, and lists the new gaps that surfaced once the operator console moved off mock data.

> **Status as of v3 (2026-04-30).** Phases 1, 2, and 3 are all on `main`. §2 (gaps surfaced after Phase 1+2) is **10 of 11 items shipped**; the lone open item is §2 #1 (historical performance view) which is now substantially covered by Phase 3 #9's SLA dashboard — see that row's note for what remains. The §1 status table is accurate against `main`; cross-links from §2 → §3 PRs are inline below.

---

## 1. v1 plan — status

### Phase 1 — "operate at all" — ✅ COMPLETE

| # | Item | Status | PRs |
|---|---|---|---|
| 1 | Persistent indexer + real-data dashboards | ✅ Shipped | #545 schema · #548 dashboard · #550 orders · #552 treasury |
| 2 | In-app setup wizard (`/onboarding`) | ✅ Shipped | #537 guide · #540 live status |
| 3 | Admin panel UI | ✅ Shipped (renamed `/runtime`) | #543 · #553 (shared `<AdminConnectBar>`) |
| 4 | Exit-flow polish | ✅ Shipped | #538 |

Notes:
- The admin panel landed at `/runtime` rather than `/admin` to avoid the protocol-admin connotation — it's the operator's own runtime knobs. Backend keeps `/api/admin/*` for historical reasons; UI eyebrow tags map each section to the route.
- All four Phase-1-#1 slices completed; the major operator pages (`/dashboard`, `/orders`, `/orders/detail`, `/treasury`) all read live data. The "stale stats helper" leftover (Status pulled from the retired `private_orders` table) is fixed — `db.getRelayerStats()` and `db.getSettledVolume()` now read from `settlement_history` so `/runtime` Status shows live counts/avg-settle-time instead of zeros.
- Auth is `x-admin-key` paste-and-verify, persisted in tab `sessionStorage`. Wallet-signature auth (deferred from v1) was not pursued — the header model has held up fine for single-operator scope.

### Phase 2 — "stable operations" — ✅ COMPLETE

| # | Item | Status | PRs |
|---|---|---|---|
| 5 | Real-time alerting (webhook) | ✅ Shipped | #555 backend · #559 UI · #561 settlement-failure + low-balance hooks |
| 6 | Order/transaction debug view | ✅ Shipped | #557 (`/orders/detail` `processing` join) |
| 7 | Auto-claim policy | ❌ **Retired** | See §4 |
| 8 | Structured logging + search | ✅ Shipped | #564 logger + `/api/admin/logs` + `/runtime` Logs section |

Notes:
- Webhook covers three signals: health transitions, consecutive-settlement-failure streaks, low-balance crossings. No retry queue; one POST per event with a 5 s timeout.
- `/orders/detail` joins `authorize_orders` on `settle_tx` so the per-order `attempt` / `last_error` / `next_retry_at` are visible without dropping into SQLite.
- Logger is a 130-line module with no dependencies — JSON-line stdout + 500-entry ring buffer. 117 `console.*` call sites migrated.

### Phase 3 — see §3.

---

## 2. New gaps surfaced by Phase 1 + 2

Things that became obvious *after* the operator could actually monitor their relayer end-to-end:

1. **No historical performance view.** ⚠️ Mostly addressed via Phase 3 #9 (SLA dashboard, PR #568) — operators have p50/p95/p99 latency, throughput time-series, and per-bucket settled/failed counts. What's *not* shipped: explicit week-over-week / month-over-month deltas as a single comparison view. The data is there in the bucket endpoint; only a UI tweak away if the need re-surfaces. Closing this item until that demand is concrete.
2. **`/leaderboard` is read-only.** ✅ Shipped (PR #586) — leaderboard table now includes Settled / Success / Avg-settle columns sourced from each peer's public `/api/relayer/stats`, plus a "You vs network median" panel that highlights the operator's standing.
3. **No fee-claim reminder.** ✅ Shipped (Phase 3 #13, PR #575) — per-token FeeVault threshold monitor + webhook alerts + `/runtime` UI; reuses the #555/#561 alerting infra as planned.
4. **`/help` doesn't exist.** ✅ Shipped (Phase 3 #10, PR #571) — `/docs?d=<slug>` viewer with 7 markdown guides served in-app; per-error-code anchors live for `last_error` deep-links.
5. **No CSV export.** ✅ Shipped (Phase 3 #12, PR #578) — `GET /api/admin/history.csv` streams via DB iterator + `Readable.from`; operators console exposes an "Export CSV" button on `/orders`. `sanctions-events.csv` deferred until sanctions events are persisted (currently in-memory only).
6. **`/orders/detail` shows internal state, not proof contents.** ✅ Shipped (Phase 3 #16, PR #579) — `GET /api/admin/orders/by-tx/:txHash/proof` decodes settleAuth / scatterDirectAuth calldata; `/orders/detail` renders a lazy-loaded "Proof inspection" section.
7. **`/runtime` does not show the relayer process's wallet address.** ✅ Shipped (PR #582) — Status panel now surfaces `relayerAddress` in a dedicated row above the stat grid.
8. **No webhook test history beyond 50 entries.** ✅ Shipped (PR #584) — Webhook section's recent-alerts table now has client-side severity chips (`all`/`info`/`warn`/`critical`) and a text-search input that matches `type` + `text` columns. Buffer cap is unchanged at 50; the filter sits on top of it so flapping conditions can be sliced without scrolling.
9. **Cross-relayer trade offers are persisted but not surfaced.** ✅ Shipped (Phase 3 #11, PR #569) — `/runtime` Cross-relayer section reads from the `trade_offers` audit trail with peer-stats roll-up.
10. **No Prometheus / metrics endpoint.** ✅ Shipped (Phase 3 #14, PR #576) — `GET /metrics` emits in-memory + DB stats in Prometheus exposition format; scrape with any compatible agent.
11. **`/runtime` Webhook section omits the alert thresholds.** ✅ Shipped (PR #582) — Webhook panel stat grid now also renders `balance.thresholdWei` (formatted as ETH), `balance.state`, and `settlementFailureStreak.consecutiveFailures of N`.

**Status:** 10 of 11 items closed; #1 collapsed into Phase 3 #9 with a follow-up note for explicit period-over-period comparisons if the demand returns.

---

## 3. Phase 3 — re-prioritised

The original Phase 3 list (#9–#13) folds in with the new gaps from §2. Re-ranked by operator value:

| New # | Theme | Source | Effort | Notes |
|---|---|---|---|---|
| **9** ✅ | **SLA / performance dashboard** | v1 #9 + new gap #1 | Large | Shipped (PR #568). Historical p50/p95/p99 latency, throughput time-series via the `/api/admin/history/buckets` endpoint, hand-rolled SVG charts on `/dashboard`. |
| 10 ✅ | **In-app docs (`/docs?d=<slug>`)** | v1 #13 + new gap #4 | Medium | Shipped (PR #571). Originally scoped as `/help`; landed at `/docs?d=<slug>` to fit the operators app's static-export convention (no `[param]` segments). 7 markdown guides served in-app, per-error-code anchors so `last_error` rows deep-link. |
| 11 ✅ | **Cross-relayer visibility** | v1 #11 + new gap #9 | Medium | Shipped (PR #569). `/runtime` Cross-relayer section surfaces the `trade_offers` audit trail + per-peer roll-up stats. (Originally scoped to also extend `/leaderboard`; ended up consolidated under `/runtime` since that's where operators already manage cross-relayer config.) |
| 12 ✅ (history) | **Compliance export (CSV)** | v1 #12 + new gap #5 | Small-medium | `GET /api/admin/history.csv` shipped (PR #578) — streamed via DB iterator + `Readable.from` for backpressure-safe export of arbitrary windows. Operators console exposes an "Export CSV" button on `/orders`. `sanctions-events.csv` deferred — sanctions events aren't persisted yet (in-memory only); will land alongside a sanctions-events table. |
| 13 ✅ | **Fee-claim reminder + threshold UI** | new gaps #3, #11 | Small | Shipped (PR #575). Per-token threshold persisted in `relayer_meta`, monitored once a minute, reuses #555/#561 webhook infra; `/runtime` UI lets operators set the threshold inline. |
| 14 ✅ | **Prometheus `/metrics` endpoint** | new gap #10 | Small | Shipped (PR #576). `GET /metrics` on the relayer emits in-memory + DB stats in Prometheus exposition format. Scrape with any Prometheus-compatible agent (Grafana Agent, Datadog, vmagent). |
| 15 | **Key rotation flow** *(security-critical)* | v1 #10 | Large + contract change | Defer until governance defines the rotation semantics on `RelayerRegistry`; documenting the gap, not pre-spec'ing. |
| 16 ✅ | **Proof inspection on `/orders/detail`** | new gap #6 | Small-medium | Shipped (PR #579). `GET /api/admin/orders/by-tx/:txHash/proof` decodes a settlement tx's calldata into its public signals (settleAuth maker+taker or scatterDirectAuth single proof). `/orders/detail` renders a lazy-loaded "Proof inspection" section with each public signal labelled, plus the raw calldata as a nested collapsible. |

### Phase 3 — done.

7 of 8 ranked items shipped (#9 #568, #10 #571, #11 #569, #12 #578, #13 #575, #14 #576, #16 #579). #15 (key rotation flow) remains explicitly deferred pending governance spec on `RelayerRegistry` — see the table row.

### What's next (when relevant)

The operator-console gap list is empty. Open follow-ups, sized small, that didn't make the §2 cut:
- **`sanctions-events.csv`** — needs a `sanctions_events` table first (events are in-memory today). Worth doing alongside the next sanctions-list change.
- **Period-over-period dashboard view** — week-over-week / month-over-month panels on top of the Phase 3 #9 bucket data, if the explicit comparison demand returns.
- **Wallet-signature admin auth (§4)** — only revisit if multi-operator (delegated keys) ships.

---

## 4. Retired items (and why)

### v1 #7 — Auto-claim policy

Originally proposed: a periodic worker that auto-calls `FeeVault.claim()` when accruals cross a per-token threshold.

**Retired** after Phase 2 review. Rationale:
- FeeVault has no expiry / slashing — un-claimed funds are not at risk.
- Manual claim from `/treasury` is one click, infrequent.
- Automation cost (in-process worker, lock, gas-vs-value comparison, failure handling) >> the manual-effort it removes.
- The same alerting infra now in place (#555/#561) covers the "you should claim soon" need via a much lighter reminder (Phase 3 #13).

### Wallet-signature admin auth

Originally proposed: replace `x-admin-key` paste with a wallet signature from the registered relayer owner.

**Deferred indefinitely**. The header-key model has worked through Phase 1 + 2 with zero operator pain reports. Touching the auth path adds risk for marginal benefit on a single-operator surface; revisit if multi-operator (delegated keys) ever ships.

---

## 5. v1 sections retained for archival

§4 Open planner decisions and §5 Recommended starting cut from v1 are no longer relevant — see the v1 commit history (`docs/operations/operator-gap-analysis.md` at `8197a8a`) for the original wording.

---

## Appendix — `apps/operators/` route map (current)

| Route | What | Live data source |
|---|---|---|
| `/` | Landing | static |
| `/onboarding` | Six-step Get Started + live status checks | wallet · `/health` |
| `/dashboard` | Operator overview | `/api/admin/status` + history |
| `/orders` | Settlement history list (filter, paginate) | `/api/admin/history` |
| `/orders/detail` | Single-tx debug view + proof inspection | `/api/admin/history/by-tx/:txHash` · `/api/admin/orders/by-tx/:txHash/proof` |
| `/treasury` | FeeVault balances + fee accrual | on-chain · `/api/admin/history/fees` |
| `/leaderboard` | All registered relayers + you-vs-network comparison | cross-relayer fetch (`/api/info` + `/api/relayer/stats`) |
| `/docs` | In-app operations guides (`?d=<slug>`) | static markdown |
| `/profile` | Update URL/fee, bond, exit | `RelayerRegistry` |
| `/register` | First-time registration | `RelayerRegistry` |
| `/runtime` | Pause/resume, fee, drain, sanctions, profile, webhook, claim reminders, cross-relayer, logs | `/api/admin/*` |
