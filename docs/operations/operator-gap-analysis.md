# Operator Gap Analysis & Reinforcement Plan

_v1 audit: 2026-04-29 · v2 update: 2026-04-29 (Phase 1 + Phase 2 ship review)_
_Scope: `apps/operators/` (Next.js operator console) + `zk-relayer/` (Node service) from a relayer operator's POV._

This document captures the gaps a real relayer operator would hit today and lays out a phased plan to close them. v2 marks the v1 plan against what shipped, retires items overtaken by other work, and lists the new gaps that surfaced once the operator console moved off mock data.

> **In-flight when v2 was written.** PR #564 (Phase 2 #8 — structured logging + `/api/admin/logs` + `/runtime` Logs section) is open as of this writing. The §1 status table reflects what's expected on `main` once #564 merges; if you're reading this earlier, the logger module / `/admin/logs` route may not exist yet. Other "✅ shipped" items are already on `main` at the time of this commit.

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

1. **No historical performance view.** `/dashboard` shows the last 24 h. There's no week-over-week or month-over-month trend, and no p50/p95/p99 latency. Operators comparing relayers (or tuning fees) need historical aggregates.
2. **`/leaderboard` is read-only.** Operators see the bond/fee landscape but can't compare *their* settle latency / volume against peers — the data isn't aggregated cross-relayer in any one place.
3. **No fee-claim reminder.** With auto-claim retired (§4), operators still benefit from a "USDC claimable: 124 — /treasury" nudge once accruals cross a threshold. Lighter than auto-claim, same alerting infra (#555/#561).
4. **`/help` doesn't exist.** Every "common error → fix" lookup forces an SSH+grep cycle. The `docs/operations/*.md` files are fine source material.
5. **No CSV export.** Compliance/finance often want "give me all settlements from <date> to <date>" in CSV. Currently the only path is to query the DB by hand.
6. **`/orders/detail` shows internal state, not proof contents.** When a settlement reverts, the operator sees `last_error` but can't inspect the proof's public signals or the calldata. Useful for nullifier / commitment debugging.
7. **`/runtime` does not show the relayer process's wallet address.** ✅ Shipped — Status panel now surfaces `relayerAddress` in a dedicated row above the stat grid.
8. **No webhook test history beyond 50 entries.** ✅ Shipped — Webhook section's recent-alerts table now has client-side severity chips (`all`/`info`/`warn`/`critical`) and a text-search input that matches `type` + `text` columns. Buffer cap is unchanged at 50 (which is fine for triage); the filter sits on top of it so flapping conditions can be sliced without scrolling.
9. **Cross-relayer trade offers are persisted but not surfaced.** `trade_offers` table exists; no operator UI reads it.
10. **No Prometheus / metrics endpoint.** External monitoring stacks (Grafana, Datadog) currently have nothing to scrape — operators relying on them get no signal.
11. **`/runtime` Webhook section omits the alert thresholds.** ✅ Shipped — Webhook panel stat grid now also renders `balance.thresholdWei` (formatted as ETH), `balance.state`, and `settlementFailureStreak.consecutiveFailures of N`. Operators see thresholds directly without grepping `.env`.

Items 1–2 are the most operator-visible. Items 3, 5, 11 are small and stackable.

---

## 3. Phase 3 — re-prioritised

The original Phase 3 list (#9–#13) folds in with the new gaps from §2. Re-ranked by operator value:

| New # | Theme | Source | Effort | Notes |
|---|---|---|---|---|
| **9** | **SLA / performance dashboard** | v1 #9 + new gap #1 | Large | Historical p50/p95/p99 latency, throughput time-series, optional cross-relayer comparison. Backend needs a time-bucket aggregate over `settlement_history`; frontend needs a chart lib (or hand-rolled SVG). |
| 10 | **In-app docs (`/help`)** | v1 #13 + new gap #4 | Medium | Embed `docs/operations/*.md` via MDX or a server-rendered list. Per-error-code anchors so `last_error` rows can deep-link. |
| 11 | **Cross-relayer visibility** | v1 #11 + new gap #9 | Medium | Surface `trade_offers` (audit trail of cross-relayer matches) under `/runtime` or an extended `/leaderboard`. Schema already exists. |
| 12 | **Compliance export (CSV)** ✅ (history) | v1 #12 + new gap #5 | Small-medium | `GET /api/admin/history.csv` shipped — streamed via DB iterator + `Readable.from` for backpressure-safe export of arbitrary windows. Operators console exposes an "Export CSV" button on `/orders`. `sanctions-events.csv` deferred — sanctions events aren't persisted yet (in-memory only); will land alongside a sanctions-events table. |
| 13 | **Fee-claim reminder + threshold UI** | new gaps #3, #11 | Small | `/runtime` Webhook section already shows recent alerts; add per-token claim threshold setting (persisted in `relayer_meta`) and a corresponding monitor. Reuses #555/#561 alerting infra. |
| 14 | **Prometheus `/metrics` endpoint** ✅ | new gap #10 | Small | Shipped — `GET /metrics` on the relayer emits in-memory + DB stats in Prometheus exposition format. Scrape with any Prometheus-compatible agent (Grafana Agent, Datadog, vmagent). |
| 15 | **Key rotation flow** *(security-critical)* | v1 #10 | Large + contract change | Defer until governance defines the rotation semantics on `RelayerRegistry`; documenting the gap, not pre-spec'ing. |
| 16 | **Proof inspection on `/orders/detail`** ✅ | new gap #6 | Small-medium | Shipped — `GET /api/admin/orders/by-tx/:txHash/proof` decodes a settlement tx's calldata into its public signals (settleAuth maker+taker or scatterDirectAuth single proof). `/orders/detail` renders a lazy-loaded "Proof inspection" section with each public signal labelled, plus the raw calldata as a nested collapsible. |

### Recommended next big PR: **#9 SLA / performance dashboard**

Why:
- Highest operator value of the unshipped items. Operators tuning fees / monitoring competition need this.
- All upstream data already exists — `settlement_history` has timestamps, types, and gas. No schema change.
- Naturally large PR (backend aggregate endpoint + chart-bearing UI page) — fits the "prefer big PR" preference.
- Independent of #564 (logging) — can run in parallel with that PR's review/merge.

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
| `/orders/detail` | Single-tx debug view | `/api/admin/history/by-tx/:txHash` |
| `/treasury` | FeeVault balances + fee accrual | on-chain · `/api/admin/history/fees` |
| `/leaderboard` | All registered relayers | cross-relayer fetch |
| `/profile` | Update URL/fee, bond, exit | `RelayerRegistry` |
| `/register` | First-time registration | `RelayerRegistry` |
| `/runtime` | Pause/resume, fee, drain, sanctions, profile, webhook, logs | `/api/admin/*` |
