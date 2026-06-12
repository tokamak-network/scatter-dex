# Relayer Pages Redesign

**Status:** Draft
**Branch:** `design/relayer-page-redesign`
**Date:** 2026-04-15

## Motivation

The current `/relayer/*` pages mix three audiences (traders, operators, observers) on a
single dashboard, hide non-ZK relayers via a brittle name filter, embed an
orderbook section that duplicates `/trade/orderbook`, and show no comparable
metrics that would actually help a trader pick a relayer. Operators have no
UI to set their display name, withdraw bond, or change their fee. Platform
revenue accumulated in the FeeVault is invisible.

This doc proposes a phased restructure that splits pages by audience, adds a
trust-grade comparison table backed by a shared-orderbook indexer, exposes
fee/earnings/treasury data, and adds an editable relayer profile (name /
description / logo).

## 1. Current state

### 1.1 Pages

| Page                              | Lines | Audience            | State                                                                          |
|-----------------------------------|-------|---------------------|--------------------------------------------------------------------------------|
| `/relayer`                        | 649   | trader + operator   | overloaded — list + orderbook + FeeVault claim + per-relayer ops monitoring    |
| `/relayer/profile?address=0x...`      | 406   | trader              | ok; `PrivateSettledAuth` indexed only by `makerRelayer` so taker side missing  |
| `/relayer/ops`                    | 350   | operator            | clean and focused                                                              |
| `/relayer/register`               | 303   | new operator        | onboarding only — no bond unstake / fee change / name edit                     |

### 1.2 Concrete problems

- **P1 — Audience confusion.** Dashboard mixes "find a relayer" (trader) with
  "monitor my relayer" (operator).
- **P2 — Duplicated semantics.** `orderCount` is *pending* on the dashboard
  (`r.api?.orderCount`) but *cumulative* on profile (`stats.totalOrders`); UI
  labels are the same.
- **P3 — Orderbook section in dashboard duplicates `/trade/orderbook`.** Per-relayer
  slicing is not a meaningful trader use case.
- **P4 — Silent ZK filter.** `page.tsx:156` drops relayers whose `api.name`
  doesn't include "ZK". Brittle and undocumented.
- **P5 — Card list is not comparable.** No sort/filter; trader can't tell at a
  glance which relayer has the best success rate or lowest take ratio.
- **P6 — Operator lifecycle UX gaps.** No UI to unstake bond, change fee,
  rotate display name, view earnings history.
- **P7 — Trader-relevant signals missing.** No median/P95 latency, no actual
  take-ratio (only stated rate), no 24h volume, no per-pair coverage.
- **P8 — Half-indexed event.** `PrivateSettledAuth.takerRelayer` is not
  `indexed`, so operator profiles only see settlements where they were the
  maker side. Needs contract change.

## 2. Fee model recap (sets the trader picking heuristic)

- User signs each order with `maxFee` (bps), bound into the circuit.
- Relayer chooses the **actual** fee at submission, capped on-chain by
  `feeToken * 10000 ≤ buyAmount * maxFee`.
- `/api/info.fee` is the relayer's **stated** preference, not enforcement.
- A relayer that always takes the full `maxFee` is honest-but-greedy; one that
  takes less than max is the better counterparty.

**Implication:** the strongest trust signal is **actual take ratio**
(median fee bps / user's signed maxFee bps) over recent settlements, not the
relayer's stated fee.

## 3. Audience-driven page restructure

```
/relayer                  Find a Relayer (trader)
    Sortable table + network stats + filters

/relayer/[address]        Single-relayer deep dive
    Tabs: Overview | Settlements | Earnings (operator-only when own)

/relayer/leaderboard      Network ranking (observer + trader)
    Tabs: Volume | Trade Count | Best Take Rate | Reliability

/relayer/treasury         Platform revenue board (observer)
    Per-token accumulated + lifetime withdrawn + source breakdown

/relayer/ops              Operator monitor (operator)
    Existing + Profile editor + Earnings + Lifecycle

/relayer/register         Onboard a new relayer (new operator)
    Existing
```

Existing `/relayer/profile?address=0x...` collapses into `/relayer/[address]`.

## 4. Dashboard (`/relayer`) — sortable comparison table

```
┌─ Network stats ───────────────────────────────────────┐
│ 5 relayers online · 142 open orders · 12 active pairs │
│ 24h: 1.2k settlements · $12.4M volume                 │
└───────────────────────────────────────────────────────┘
┌─ Filter / Sort ───────────────────────────────────────┐
│ [Pair ▾] [Min bond ◯] [Max take ratio ◯] [Sort ▾]    │
└───────────────────────────────────────────────────────┘
┌─ Comparison table ────────────────────────────────────┐
│ Relayer | Status | Stated | Avg Take | Success | P50  │
│         |        | Rate   | (last 100│ Rate    | ms   │
│         |        |        | trades)  |         |      │
│ Pending | 24h Vol | Lifetime | Bond | Action          │
└───────────────────────────────────────────────────────┘
```

| Column          | Source                                                        | Why it matters                                |
|-----------------|---------------------------------------------------------------|-----------------------------------------------|
| Relayer         | `name` from profile + short address                           | Identity                                      |
| Status          | `/api/info` reachable                                         | Liveness                                      |
| Stated rate     | `r.api?.fee`                                                  | Posted preference (advertising)               |
| **Avg take**    | settlements indexer: median `fee_bps / user_maxfee_bps`       | **Actual generosity — strongest trust signal**|
| Success rate    | `/api/relayer/stats` + cross-checked with on-chain settlements| Reliability                                   |
| P50 latency     | settlements indexer: median submit→confirm                    | UX speed                                      |
| Pending         | `r.api?.orderCount` (label clearly "pending")                 | Current load                                  |
| 24h volume      | settlements indexer: USD-equiv sum                            | Activity                                      |
| Lifetime earned | FeeVault `FeeDeposited` event sum (USD-equiv)                 | Track record                                  |
| Bond            | `RelayerRegistry` on-chain                                    | Slashing collateral                           |
| Action          | deeplink to `/trade/private-order?relayer=<addr>`             | Conversion                                    |

**Removed from current dashboard:**
- Per-relayer orderbook section (already at `/trade/orderbook`)
- Connected-wallet FeeVault claim (move to `/relayer/ops`)
- Silent `name?.includes("ZK")` filter (show all registered relayers; mark
  unreachable explicitly)

## 5. `/relayer/[address]` — per-relayer deep dive

Three tabs:

### 5.1 Overview
Avatar (logo or jazzicon), name, address, online status, badges, bond, registration date,
contact links (X, website, email if profile filled).

### 5.2 Settlements
Recent on-chain `PrivateSettledAuth` events involving this relayer (both maker
and taker side once the contract change in §11 lands; until then maker side
only with a banner). Columns: tx, block, pair, volume, fee taken, take ratio.

### 5.3 Earnings (visible only when viewer === relayer address)
Per-token table:

| Token | Unclaimed       | Lifetime earned | Lifetime claimed | Last activity |
|-------|-----------------|-----------------|------------------|---------------|
| WETH  | 0.0123 ETH      | 1.456 ETH       | 1.444 ETH        | 2 m ago       |
| USDC  | 142.50 USDC     | 8 235 USDC      | 8 093 USDC       | 7 m ago       |

Plus a recent activity timeline (deposits + claims). Claim button per token.

## 6. `/relayer/leaderboard`

Tabs cycle the metric; the window selector cycles 24h / 7d / 30d / lifetime.

```
┌─ Volume — 24h ────────────────────────────────────────┐
│ Rank │ Relayer   │ Volume (USD) │ Δ vs 7d avg │ Pairs │
│  1   │ Relayer-X │ $4.2M        │ +12%        │   8   │
│  2   │ Relayer-A │ $1.2M        │  −3%        │   5   │
│  3   │ Relayer-B │ $0.8M        │ new ↑       │   3   │
└───────────────────────────────────────────────────────┘
```

Other metrics: Trade Count, Best Take Rate (low is good), Reliability
(success rate × uptime), Avg Latency.

## 7. Settlements indexer (shared-orderbook extension)

The shared OB is the right home — it already has DB, signed-by-relayer auth,
and stores the OrderSummary objects we need to join with each settlement.

### 7.1 Schema (sqlite)

```sql
CREATE TABLE settlements (
  tx_hash          TEXT PRIMARY KEY,
  block_number     INTEGER,
  block_time       INTEGER,
  submitter        TEXT,                         -- relayer that sent the tx
  maker_relayer    TEXT,
  taker_relayer    TEXT,
  maker_order_id   TEXT,                         -- soft reference to orders(id) — no FK
  taker_order_id   TEXT,                         -- so matched orders can be pruned
  -- nullifiers required for matching the verify job to the on-chain
  -- `PrivateSettledAuth` event (which keys trades by nullifier, not order id)
  -- and for keeping the row linkable after order pruning:
  maker_nullifier  TEXT,
  taker_nullifier  TEXT,
  -- joined from orders for fast queries (snapshotted at push time):
  sell_token       TEXT, buy_token TEXT,         -- maker side
  sell_amount      TEXT, buy_amount TEXT,
  fee_maker        TEXT, fee_taker TEXT,
  user_maxfee_maker  INTEGER,                    -- bps, for take-ratio
  user_maxfee_taker  INTEGER,
  verified         INTEGER DEFAULT 0,            -- on-chain receipt confirmed
  created_at       INTEGER
);

CREATE INDEX idx_settle_relayer_m   ON settlements(maker_relayer, block_time);
CREATE INDEX idx_settle_relayer_t   ON settlements(taker_relayer, block_time);
CREATE INDEX idx_settle_pair        ON settlements(sell_token, buy_token, block_time);
CREATE INDEX idx_settle_block       ON settlements(block_number);
CREATE INDEX idx_settle_nullifier_m ON settlements(maker_nullifier);
CREATE INDEX idx_settle_nullifier_t ON settlements(taker_nullifier);
```

### 7.2 Write paths

1. **Push (relayer self-report).** Right after a successful `settleAuth` /
   `scatterDirectAuth` / `settleWithDex` tx, the relayer posts
   `POST /api/settlements` with `{ txHash, blockNumber, makerOrderId,
   takerOrderId, makerNullifier, takerNullifier, userMaxFeeMaker,
   userMaxFeeTaker, feeTokenMaker, feeTokenTaker }` signed with its
   registered key. Nullifiers are required so the verify job can link the
   row to the on-chain `PrivateSettledAuth` event (keyed by nullifier, not
   order id) and so the row stays linkable even after the matched
   OrderSummary rows are pruned. The user-signed `maxFee` values are
   carried in the payload — not derived later — so the take-ratio
   calculation (`fee_bps / user_maxfee_bps`) is always available without a
   separate join. Shared OB does a best-effort join with still-present
   OrderSummary records to snapshot token / amount, writes a row with
   `verified=0`.

2. **Verify (background job).** Every N seconds the shared OB picks the
   oldest unverified rows and calls `eth_getTransactionReceipt`. If status=1
   and the tx emits a matching `PrivateSettledAuth`, mark `verified=1`.
   Otherwise drop or flag.

This is "fast UI + eventual trustlessness." A second indexer that scans
`PrivateSettledAuth` events directly (without relying on relayer push) can
backfill any rows the push missed; treat the on-chain scan as authoritative
and the push as a latency optimisation.

### 7.3 Read APIs

```
GET /api/settlements?limit&offset&relayer&pair&since
GET /api/relayers/:addr/stats          → { txCount{lifetime,d24h,d7d},
                                          volumeByToken[],
                                          avgTakeRatioBps,
                                          successRate,
                                          pairs[] }
GET /api/leaderboard?metric&window     → ranked rows
GET /api/network/totals                → { txCount, volumeByToken[],
                                          activePairs, lastSettleAt }
```

## 8. `/relayer/treasury` — platform revenue board

Reads `FeeVault` directly. No new infra.

```
Treasury:        0xabcd…1234
Platform fee:    5% (of relayer fees)

Token | Accumulated | Lifetime withdrawn
WETH  | 0.42 ETH    | 12.3 ETH
USDC  | 1 250 USDC  | 45 000 USDC

Source breakdown (lifetime, USD-equiv):
  ●●●  Relayer-fee skim          50%
  ●●   DEX market platform fee   30%
  ●    DEX positive slippage     20%

Last withdrawal: 2026-04-13 14:22 by treasury (tx 0x…)
```

Data sources:
- `vault.platformRevenue(token)` — current per-token balance (DEX-side
  accruals only — relayer-fee skim is treasury-direct, never accumulates here)
- `PlatformFeeFromDex(indexed token, amount)` events — lifetime DEX
  market platform fee
- `PlatformSurplusFromDex(indexed token, amount)` events — lifetime DEX
  positive slippage
- `PlatformFeeFromRelayerClaim(indexed token, amount, indexed relayer)`
  events — lifetime skim from relayer claim flow (also visible on the
  `FeeClaimed.platformFee` field)
- `PlatformRevenueWithdrawn` events — last withdrawal

## 9. Editable relayer profile (name / description / logo)

Three layers:

| Layer        | Fields                  | Mutability                       | Trust   |
|--------------|-------------------------|----------------------------------|---------|
| Identity     | address                 | immutable                        | absolute|
| On-chain     | url, fee, bond          | relayer owner via registry       | strong  |
| **Profile**  | name, description, logoUrl, contact, x, website | relayer's admin endpoint | weak (self-reported) |

### 9.1 Backend

- `zk-relayer` adds `relayer_meta.profile_json` column; new endpoint
  `PATCH /api/admin/profile` writes it (admin auth).
- `/api/info` response gains a `profile` object so the frontend gets it in
  one round-trip.
- Heartbeat to shared OB carries the current profile snapshot; shared OB
  caches it on the relayer record.

### 9.2 Constraints

- Length: name ≤ 64, description ≤ 280, urls ≤ 256.
- Plain-text rendering on the frontend (no HTML / script).
- `logoUrl` allowlist: `https://` + `ipfs://` only. Browsers don't load
  `ipfs://` natively in `<img>`, so the frontend rewrites it to a configured
  HTTPS gateway (default `https://ipfs.io/ipfs/<cid>`, overridable via
  `NEXT_PUBLIC_IPFS_GATEWAY`) before render. Tagged with
  `loading="lazy" referrerPolicy="no-referrer"`.
- No uniqueness enforcement on name — always show address alongside.

### 9.3 Frontend

- `/relayer/ops` gains a "Profile" card with editable fields and a "Save"
  button that calls the admin endpoint.
- Dashboard / `/relayer/[address]` / leaderboard render `name` (fallback:
  `Relayer 0x7099…79C8`), with the short address always visible to deter
  impersonation.

## 10. Operator lifecycle (`/relayer/register` extension)

The register page becomes the lifecycle hub for an authenticated relayer
operator. Sections:

- **Status** — currently registered? bond, fee, url.
- **Update fee** — schedule + activate (matches the existing FeeVault timelock pattern if applied to RelayerRegistry).
- **Top-up bond** — `register(...)` allows additional deposit; expose as a button.
- **Unstake bond** — only after `unregister` + cooldown; needs contract review.
- **Unregister** — exit flow with confirmation.

(Any contract gaps surfaced here go into a separate contract PR.)

## 11. Data layer

### 11.1 New / changed hooks

| Hook                         | Returns                                                    |
|------------------------------|------------------------------------------------------------|
| `useNetworkStats()`          | totals from shared OB + active relayer count               |
| `useRelayerStats(address)`   | merged `/api/info` + `/api/relayer/stats` + indexer stats  |
| `useRelayerEarnings(addr)`   | per-token unclaimed + lifetime + recent activity           |
| `usePlatformRevenue()`       | per-token accumulated + lifetime + last withdrawal         |
| `useLeaderboard(metric,win)` | ranked rows                                                |

### 11.2 Contract change (separate PR)

`PrivateSettlement.PrivateSettledAuth.takerRelayer` → `indexed`. Required so
`/relayer/[address]` settlement queries return both sides without a
separate index. Backfill via the shared-OB indexer covers the gap.

## 12. Trust model summary

| Surface                          | Source                  | Trust            |
|----------------------------------|-------------------------|------------------|
| Identity (address)               | RelayerRegistry         | trustless        |
| Bond / fee / url                 | RelayerRegistry         | trustless        |
| Profile (name/desc/logo)         | self-reported via API   | weak             |
| Stated fee                       | `/api/info`             | weak             |
| Pending order count              | `/api/info`             | medium (testable)|
| Settlement count / volume        | indexer push + verify   | strong once verified|
| Take ratio                       | indexer (verified rows) | strong           |
| Earnings (unclaimed/lifetime)    | FeeVault on-chain       | trustless        |
| Platform revenue                 | FeeVault on-chain       | trustless        |

## 13. Phased rollout

| Phase | Scope                                                                                              | Dependency        |
|-------|----------------------------------------------------------------------------------------------------|-------------------|
| 1a    | Dashboard cleanup: drop ZK filter, drop orderbook section, relabel `orderCount`, move FeeVault claim to `/relayer/ops` | none              |
| 1b    | New comparison table layout (existing data only)                                                   | 1a                |
| 2     | `useNetworkStats` + `useRelayerEarnings` + earnings tab on `/relayer/[address]`                    | none              |
| 2.5   | Shared OB `settlements` table + push API + verify job                                              | shared-OB change  |
| 2.7   | Editable Profile (name / description / logo) — backend + ops UI + display integration              | none              |
| 3a    | `/relayer/leaderboard` + `/api/leaderboard`                                                        | 2.5               |
| 3b    | "Trade Stats" tab on `/relayer/[address]`                                                          | 2.5               |
| 4     | `/relayer/treasury`                                                                                | none              |
| 5     | Operator lifecycle (bond / fee / unstake) on `/relayer/register`                                   | contract review   |
| 6     | `PrivateSettledAuth.takerRelayer` indexed                                                          | contract migration|

## 14. Open questions

1. **Indexer ownership.** Is the shared-OB process the right home for
   settlement indexing, or should it be a separate worker so the OB stays
   focused on order publication? Current preference: keep in shared OB until
   load justifies a split.
2. **Reorg handling.** The verify job needs to mark rows back to
   `verified=0` if a finalised block is later reorged out. With ~12s
   confirmation and a 50-block confirmation depth, this is rare on mainnet
   but must be explicit on the fork environment.
3. **USD-equiv pricing.** Volume figures need a price source. Reuse
   `useDexPrices` for client-side conversion, or have the indexer cache USD
   prices server-side at settlement time? Server-side is more consistent
   across viewers but adds a price-feed dependency.
4. **Profile abuse vectors.** Malicious `description` (phishing links),
   misleading `name` ("Coinbase Relayer"). Mitigations: address always shown,
   plain-text rendering, optional verified badge in a future phase.
5. **Take-ratio gaming.** A relayer could submit fake low-take-ratio
   settlements to itself to inflate its score. Mitigation: only count
   settlements between distinct relayer pairs, or weight by counterparty
   bond.

## 15. Out of scope (future)

- Verified-relayer badge (DNS / X attestation)
- Geographic latency hints
- Per-pair recommended relayer (auto-routing)
- Multi-relayer broadcast for traders (already supported by
  cross-relayer matching but no UI yet)
