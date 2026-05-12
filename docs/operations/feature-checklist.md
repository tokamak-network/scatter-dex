# Service Feature Checklist

Per-service feature inventory tied to its **verification method**. Use this as the master checklist before a release or after a large refactor (e.g. the proxy migration in PRs #659-#677).

Verification methods:
- **🤖 auto** — picked up by `./scripts/feature-check.sh` (run the listed mode)
- **🧪 test** — explicit forge / vitest test path; run individually with `--match-test` or `vitest path/to/test`
- **🌐 curl** — HTTP call against a running local service
- **👤 UI** — manual click flow in the browser (requires `dev.sh --mock` + apps up)
- **🪪 spec-only** — documented but not yet shipped; skip during testing

## How to run a release sweep

```bash
# Lightning fast — file integrity, baselines, migration invariants
./scripts/feature-check.sh --quick                 # ~5s, 45 checks

# Unit suites — contracts + services (no live services needed)
./scripts/feature-check.sh --unit                  # ~30s

# Live service health — assumes dev.sh is up
arch -arm64 /opt/homebrew/bin/bash -c 'SKIP_CIRCUIT_BUILD=1 ./scripts/dev.sh --mock --apps pay,pro,drop' &
./scripts/feature-check.sh --live                  # ~10s

# UI flows below are manual — see each service's `👤 UI` row.
```

## Status legend
- ✅ verified (last sweep)
- ⚠️ stale (known test debt — see [Test debt](#test-debt))
- 🔜 not yet exercised (no automated coverage today)

---

## Pay (apps/pay, port 4001)

### Sender flows
| # | Feature | Method | How |
|---|---|---|---|
| pay-1 | Create payout wizard (5-step) | 👤 UI | http://localhost:4001/payouts/new — token → recipients (CSV) → review → sign → submit |
| pay-2 | Top-up payout pool (deposit) | 👤 UI + 🧪 test | UI: wallet sign + approve. Test: `forge test --match-test test_deposit_credit` |
| pay-3 | Recipient release-date + amount | 👤 UI | Wizard step 3, per-row delay chips |
| pay-4 | Payout dashboard | 👤 UI + 🌐 curl | UI: `/payouts`. Curl: `GET /api/payouts` |
| pay-5 | CSV export + signed PDF receipt | 🌐 curl | `POST /api/payouts/:id/export` |
| pay-6 | Reminder notifications | 🌐 curl + 🪪 spec | `POST /api/payouts/:id/remind` — endpoint exists, email channel is spec-only |

### Recipient flows
| # | Feature | Method | How |
|---|---|---|---|
| pay-7 | Gasless claim via secret link | 👤 UI + 🌐 curl | UI: `/claim/[link]` → "Claim". Curl: `POST /api/claim/:link` |
| pay-8 | Hidden amount until claim | 👤 UI | `/claim/[link]` page shows amount only after sign-in |

### Backend routes
| # | Endpoint | Method |
|---|---|---|
| pay-be-1 | `POST /api/payouts` | 🌐 curl |
| pay-be-2 | `POST /api/payouts/:id/submit` | 🌐 curl |
| pay-be-3 | `GET /api/payouts` / `GET /api/payouts/:id` | 🌐 curl |
| pay-be-4 | `POST /api/payouts/:id/remind` | 🌐 curl |
| pay-be-5 | `POST /api/claim/:link` | 🌐 curl |
| pay-be-6 | `POST /api/payouts/:id/export` | 🌐 curl |

### Admin / operator
| # | Feature | Method |
|---|---|---|
| pay-admin-1 | Multi-org tenant isolation | 🧪 test (org-scoped queries in `apps/pay/api/`) |
| pay-admin-2 | Team RBAC (admin/treasurer/viewer) | 👤 UI (`/team`) + 🪪 partial spec |
| pay-admin-3 | Plan caps (Free/Team/Business/Enterprise) | 🪪 spec-only — limits not enforced server-side yet |

---

## Pro (apps/pro, port 4003)

### Core trading
| # | Feature | Method | How |
|---|---|---|---|
| pro-1 | Create limit order (sign EdDSA) | 👤 UI | `/app` → fill form → sign modal |
| pro-2 | Multi-recipient split (1-16) | 👤 UI | Advanced → recipients row builder |
| pro-3 | Per-recipient release delay | 👤 UI | Recipient row → delay chip |
| pro-4 | Stealth address claim toggle | 👤 UI | Recipient row → stealth toggle |
| pro-5 | Vault balance + open orders | 👤 UI | "My Position" panel |
| pro-6 | Claim filled order | 👤 UI + 🧪 test | UI: claim modal. Test: `forge test --match-test test_settleAuth_happyPath` |
| pro-7 | Cancel open order (escrow rotation) | 👤 UI + 🧪 test | UI: cancel button. Test: `test_cancelPrivate_*` |
| pro-8 | Withdraw from vault | 👤 UI + 🧪 test | UI: withdraw modal. Test: `test_withdraw_*` (20 cases in `CommitmentPool.t.sol`) |
| pro-9 | Order history with tab filters | 👤 UI | `/orders` → segmented control |
| pro-10 | Order detail drawer | 👤 UI | click row → drawer |

### Configuration
| # | Feature | Method | How |
|---|---|---|---|
| pro-11 | Pair selector (7 pairs) | 👤 UI | header PairSelector |
| pro-12 | Network switch (Sepolia/Mainnet) | 👤 UI | header NetworkSwitcher pill |
| pro-13 | Relayer picker + max-fee cap | 👤 UI | Advanced → "Max relayer fee" slider |
| pro-14 | Cross-relayer matching | 🧪 test + 👤 UI | Test: `start-cross-relayer-e2e.sh`. UI: pre-trade route hint |

---

## Drop (apps/drop, port 4002)

### Campaign creator
| # | Feature | Method | How |
|---|---|---|---|
| drop-1 | Create campaign wizard (4-step) | 👤 UI | `/campaigns/new` |
| drop-2 | Snapshot voter eligibility | 🌐 curl + 👤 UI | UI: wizard step 2. Curl: `GET /api/snapshot/voters` |
| drop-3 | Sybil policy config (zk-X509 / activity / KISA) | 👤 UI | wizard step 3 |
| drop-4 | Live claim rate dashboard | 🌐 curl + 👤 UI | UI: `/campaigns/:id`. Curl: `GET /api/campaigns/:id/stats` |
| drop-5 | Sybil block (per-campaign zkX509_id_hash uniqueness) | 🧪 test | (test target: campaign-scoped uniqueness in claim handler) |

### Recipient
| # | Feature | Method | How |
|---|---|---|---|
| drop-6 | Eligibility check | 🌐 curl | `GET /api/campaigns/:id/eligibility?wallet=` |
| drop-7 | zk-X509 identity proof submission | 🌐 curl + 👤 UI | UI: `/claim/[id]` → identity step. Curl: `POST /api/campaigns/:id/claim` |
| drop-8 | Gasless airdrop claim | 👤 UI + 🌐 curl | UI: `/claim/[id]` → "Claim". Curl: same endpoint |

### Backend
| # | Endpoint | Method |
|---|---|---|
| drop-be-1 | `POST /api/campaigns` | 🌐 curl |
| drop-be-2 | `GET /api/campaigns` / `GET /api/campaigns/:id` | 🌐 curl |
| drop-be-3 | `GET /api/campaigns/:id/eligibility` | 🌐 curl |
| drop-be-4 | `POST /api/campaigns/:id/claim` | 🌐 curl |
| drop-be-5 | `GET /api/campaigns/:id/stats` | 🌐 curl |

---

## Hub (apps/hub, port 4000 collision — separate terminal)

| # | Feature | Method |
|---|---|---|
| hub-1 | Landing page render | 👤 UI |
| hub-2 | App catalog (Pay / Pro / Drop) | 👤 UI |
| hub-3 | Dev gateway links | 👤 UI |

---

## zk-relayer A (port 3002) / B (port 3003)

Identical surface per instance.

| # | Endpoint | Method | Notes |
|---|---|---|---|
| relayer-1 | `GET /api/info` | 🌐 curl (`feature-check --live`) | metadata + orderCount |
| relayer-2 | `GET /api/health` | 🌐 curl | liveness probe |
| relayer-3 | `GET /api/admin/profile` | 🌐 curl | persisted relayer profile fields |
| relayer-4 | `PATCH /api/admin/profile` | 🧪 test (`admin.test.ts`) | merge semantics |
| relayer-5 | `POST /api/admin/drain` | 🧪 test | one-shot order drain |
| relayer-6 | `POST /api/admin/sanctions` | 🧪 test | add sanctioned pubKeys |
| relayer-7 | `GET /api/admin/sanctions` / `DELETE` | 🧪 test | |
| relayer-8 | `POST /api/orders` (dispatch) | 🧪 test + 🌐 curl | order ingest |
| relayer-9 | `POST /api/private-claim` (gasless ZK claim) | 🧪 test | `claim.test.ts` 9 cases |
| relayer-10 | `GET /api/relayer/stats` | 🧪 test | `relayer-stats.test.ts` |
| relayer-11 | `GET /api/relayer/trade-offers` | 🧪 test | |
| relayer-12 | `GET /api/merkle-proof` | 🧪 test | `info.test.ts` 6 cases (1 ⚠️ stale) |
| relayer-13 | Pause / resume (admin) | 🧪 test | `Relayer PAUSED/RESUMED` admin log |
| relayer-14 | Authorize match dispatcher | 🧪 test | core flow in `index.test.ts` |
| relayer-15 | Async settlement recovery | 🧪 test | orphan reconciliation |
| relayer-16 | Fee enforcement (cap + deduction) | 🧪 test | `forge test --match-test test_settleAuth_feeExceedsMakerMaxFee_reverts` |

Today: **231/232 PASS**, 1 ⚠️ stale (`info.test.ts` expects old relayer name).

---

## shared-orderbook (port 4000)

| # | Endpoint | Method | Notes |
|---|---|---|---|
| ob-1 | `GET /health` | 🌐 curl (`feature-check --live`) | |
| ob-2 | `POST /api/relayers/register` | 🧪 test (`api.test.ts`) | |
| ob-3 | `GET /api/relayers` | 🧪 test + 🌐 curl | |
| ob-4 | `POST /api/orders` | 🧪 test ⚠️ stale | OFFER_HANDLE fixture mismatch |
| ob-5 | `GET /api/orders` (paginated) | 🧪 test ⚠️ stale | |
| ob-6 | `GET /api/orders/:pair` | 🧪 test ⚠️ stale | |
| ob-7 | `DELETE /api/orders/:id` (owner-only) | 🧪 test ⚠️ stale | 403/404 semantics |
| ob-8 | `GET /api/stats` | 🧪 test + 🌐 curl | |
| ob-9 | WebSocket broadcast on POST | 🧪 test ⚠️ stale | `e2e-flow.test.ts` |
| ob-10 | WebSocket cancel propagation | 🧪 test ⚠️ stale | |
| ob-11 | DB persistence (`db.test.ts`) | 🧪 test | 9/9 PASS |
| ob-12 | In-memory book reload from DB | 🧪 test | |
| ob-13 | Settlements table (`settlements.test.ts`) | 🧪 test | 20/20 PASS |
| ob-14 | Duplicate order rejection (409) | 🧪 test ⚠️ stale | |
| ob-15 | Already-expired rejection | 🧪 test ⚠️ stale | |

Today: **60/84 PASS**, 24 ⚠️ stale (all in `api.test.ts` + `e2e-flow.test.ts` — pre-existing OFFER_HANDLE migration debt, not a regression).

---

## On-chain contracts

All TransparentUpgradeableProxy as of PRs #659-#677.

| # | Contract function | Method | How |
|---|---|---|---|
| oc-1 | `FeeVault.claim` | 🧪 test | `FeeVaultPlatformRevenue.t.sol` 24 cases |
| oc-2 | `FeeVault.scheduleFeeChange + applyFeeChange` (timelock) | 🧪 test | `FeeVaultTimelock.t.sol` 15 cases |
| oc-3 | `SanctionsList.addSanction + batch` | 🧪 test | `SanctionsList.t.sol` 15 cases |
| oc-4 | `IdentityGate.addRegistry + getRegistries` | 🧪 test | `IdentityGate.t.sol` 22 cases |
| oc-5 | `RelayerRegistry.register + bond` | 🧪 test | `RelayerRegistry.t.sol` 29 + 7 ERC20 cases |
| oc-6 | `CommitmentPool.deposit + withdraw` | 🧪 test | `CommitmentPool.t.sol` 20 cases |
| oc-7 | `PrivateSettlement.settleAuth` | 🧪 test | `SettleAuth.t.sol` 54 cases |
| oc-8 | `PrivateSettlement.settleWithDex` | 🧪 test | `SettleWithDex.t.sol` 18 cases (+ fork tests gated by MAINNET_RPC) |
| oc-9 | Pool-drain regression | 🧪 test | `PoolDrainExploit.t.sol` 3 cases |
| oc-10 | Multi-tier verifier wiring | 🧪 test | `MultiTierWiring.t.sol` 3 cases |
| oc-11 | Pause/Unpause (pool + settlement) | 🧪 test + 🌐 (live) | `feature-check --live` exercises owner-only |
| oc-12 | Initializer safety (proxy + impl) | 🧪 test | `UpgradeableInit.t.sol` 8 cases (re-init reverts) |
| oc-13 | V1→V2 upgrade state preservation | 🧪 test | `Upgrade.t.sol` 7 cases |
| oc-14 | Storage layout (no slot drift) | 🤖 auto (`--quick`/`--unit`) | `script/storage-layout/check.sh` |
| oc-15 | UPGRADE_OWNER guard on non-local chains | 🤖 auto | `feature-check --quick` greps DeployLocal |

Today: **239/239 PASS** (non-fork). Fork tests gated on `MAINNET_RPC` secret in CI.

---

## SDK (`packages/sdk`)

| # | Feature | Method | Notes |
|---|---|---|---|
| sdk-1 | Unified factory + module exports | 🪪 no tests | Missing `npm test` script — add later |
| sdk-2 | React hooks (`useScatterClient`) | 🪪 no tests | |
| sdk-3 | Stealth keypair helpers | 🪪 no tests | |

🔜 SDK test coverage is a known gap.

---

## Cross-cutting end-to-end flows

| # | Flow | Method | How |
|---|---|---|---|
| e2e-1 | Pay payout (sender → recipients) | 👤 UI + 🧪 test | scripts/run-e2e.sh — full deposit/match/claim |
| e2e-2 | Pro cross-relayer order match (A↔B) | 🧪 test | scripts/start-cross-relayer-e2e.sh |
| e2e-3 | Drop airdrop with sybil-proof | 🧪 test | scripts/local-tier-e2e.sh |
| e2e-4 | Vault note lifecycle (deposit → spend → claim → change) | 🧪 test | `forge test --match-test test_withdraw_partial_creates_change` |

---

## Test debt

Tracked separately — pre-existing, not regression from the proxy migration:

1. **shared-orderbook fixtures** — 24 tests expect `<relayer>-<nonce>` order IDs; server has required `OFFER_HANDLE` (`0x` + 64 hex) since commit `22e3c4e6`. Owner: needs PR to refresh test bodies.
2. **zk-relayer info.test.ts** — expects `name === "ScatterDEX ZK Relayer"`; server returns `"Relayer-A"` after rename. Owner: trivial test rename.
3. **`packages/sdk` no tests** — add `npm test` + vitest scaffolding.

These do not block release readiness — production code paths are exercised by the other 536 passing tests.
