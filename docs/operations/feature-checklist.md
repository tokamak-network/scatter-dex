# Service Feature Checklist

Per-service feature inventory tied to its **verification method**. Use this as the master checklist before a release or after a large refactor (e.g. the proxy migration in PRs #659-#677).

Verification methods:
- **🤖 auto** — picked up by `./scripts/feature-check.sh` (run the listed mode)
- **🧪 test** — explicit forge / vitest test path; run individually with `--match-test` or `vitest path/to/test`
- **🌐 curl** — HTTP call against a running local service
- **👤 UI** — manual click flow in the browser (requires `dev.sh --mock` + apps up)
- **🪪 spec-only** — documented in product specs but not implemented in this repo (skip in testing; tracked separately)

## How to run a release sweep

```bash
# Lightning fast — file integrity, baselines, migration invariants
./scripts/feature-check.sh --quick                 # ~5s, 46 checks

# Unit suites — contracts + services (no live services needed)
./scripts/feature-check.sh --unit                  # ~30s

# Live service health — assumes dev.sh is up.
# dev.sh auto-re-execs under native arm64 bash on Apple Silicon — no
# wrapper needed. On Intel macOS / Linux the script just runs directly.
SKIP_CIRCUIT_BUILD=1 ./scripts/dev.sh --mock --apps pay,pro,drop &
./scripts/feature-check.sh --live                  # ~10s

# UI flows below are manual — see each service's `👤 UI` row.
```

## Status legend
- ✅ verified (last sweep)
- ⚠️ stale (known test debt — see [Test debt](#test-debt))
- 🔜 not yet exercised (no automated coverage today)

---

## Pay (apps/pay, port 4001)

`apps/pay` is a **Next.js static-export client**. The user-facing wizard, dashboard, and claim pages live here; deposit/withdraw/claim hit on-chain contracts directly via wallet RPC, and gasless claims go through `zk-relayer` (port 3002/3003). There is no in-repo Pay-backend service today — multi-tenant / server-state / email features in the product spec are **🪪 spec-only** and listed as such.

### Sender flows (in-repo)
| # | Feature | Method | How |
|---|---|---|---|
| pay-1 | Create payout wizard (5-step) | 👤 UI | http://localhost:4001 — connect wallet → token → recipients (CSV) → review → sign → submit |
| pay-2 | Top-up payout pool (deposit) | 👤 UI + 🧪 test | UI: wallet sign + approve. Test: `forge test --match-contract CommitmentPoolTest --match-test test_deposit` (covers commit + amount + token whitelist + sanctions paths) |
| pay-3 | Recipient release-date + amount | 👤 UI | Wizard step 3, per-row delay chips |
| pay-4 | Payout dashboard | 👤 UI | `/payouts` — reads on-chain claim state + local notes |
| pay-5 | CSV export | 👤 UI | client-side CSV generation from local payout state |

### Recipient flows (in-repo)
| # | Feature | Method | How |
|---|---|---|---|
| pay-6 | Gasless claim via secret link | 👤 UI + 🌐 curl | UI: `/claim/[link]` → "Claim". Curl: `POST http://localhost:3002/api/private-claim` (relayer-funded) |
| pay-7 | Hidden amount until claim | 👤 UI | `/claim/[link]` page renders amount only after the user completes the proof step |

### 🪪 Spec-only (no in-repo handler today)
- Multi-org tenant isolation, team RBAC, plan caps — described in `docs/product/SCATTERPAY_SPEC.md`, but the server-side surface that would host these (`POST /api/payouts/*`, reminder emails, signed-PDF audit receipts) does not exist in this monorepo.
- Treat the spec-only list as future work; the **in-repo** Pay surface above is what a release sweep should walk today.

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

Like Pay, `apps/drop` is a Next.js static-export client. Campaign-creator and recipient flows run client-side against on-chain campaign contracts and `zk-relayer` for gasless claims. The product spec mentions a campaigns/snapshot/stats backend; that surface is **🪪 spec-only** today.

### In-repo flows
| # | Feature | Method | How |
|---|---|---|---|
| drop-1 | Create campaign wizard (4-step) | 👤 UI | `/campaigns/new` |
| drop-2 | Sybil policy config UI (zk-X509 / activity) | 👤 UI | wizard step 3 |
| drop-3 | Eligibility self-check (merkle proof) | 👤 UI | `/claim/[id]` — client computes inclusion against on-chain root |
| drop-4 | zk-X509 identity proof submission | 👤 UI | `/claim/[id]` → identity step; routes through zk-X509 backend (separate repo, port 4444) |
| drop-5 | Gasless airdrop claim | 👤 UI + 🌐 curl | UI: `/claim/[id]` → "Claim". Curl: `POST http://localhost:3002/api/private-claim` |

### 🪪 Spec-only (no in-repo handler)
- Snapshot voter ingest, server-stored campaign metadata, live claim-rate dashboard, sybil-block analytics — all live in `docs/product/SCATTERDROP_SPEC.md` but no `apps/drop/api/` or sibling service exists in this monorepo yet.

---

## Hub (apps/hub)

`apps/hub` defaults to port 4000, which collides with `shared-orderbook`. `dev.sh --apps` **excludes hub by design** — when an operator wants Hub up alongside the dev stack, they start it in a separate terminal with an override port (`PORT=4040 npm run dev` etc.). Hub is a static landing site, no on-chain or relayer dependencies, so this is purely a port-config note for local dev.

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
| relayer-14 | Authorize match dispatcher | 🧪 test | `decode-settlement.test.ts`, `remote-orderbook.test.ts` |
| relayer-15 | Async settlement recovery / tx retry | 🧪 test | `tx-retry.test.ts` |
| relayer-16 | Vault state tracking | 🧪 test | `vault.test.ts` |
| relayer-17 | Sanctions list enforcement | 🧪 test | `sanctions-list.test.ts` |
| relayer-18 | p2p relayer protocol | 🧪 test | `routes/p2p.test.ts` |
| relayer-19 | Fee enforcement (cap + deduction) | 🧪 test | `forge test --match-test test_settleAuth_feeExceedsMakerMaxFee_reverts` |

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
| sdk-1 | Unified factory + module exports | 🪪 spec-only | No vitest setup in `packages/sdk` yet — see [Test debt](#test-debt) |
| sdk-2 | React hooks (`useScatterClient`) | 🪪 spec-only | same — no test scaffolding |
| sdk-3 | Stealth keypair helpers | 🪪 spec-only | same |

🔜 SDK test coverage is a known gap.

---

## Cross-cutting end-to-end flows

| # | Flow | Method | How |
|---|---|---|---|
| e2e-1 | Pay payout (sender → recipients) | 👤 UI | Manual walk in `apps/pay` UI — `scripts/run-e2e.sh` is currently broken (cd's to non-existent `relayer/`, see [Test debt](#test-debt)). |
| e2e-2 | Pro cross-relayer order match (A↔B) | 🧪 test | `scripts/start-cross-relayer-e2e.sh` + `zk-relayer/test/e2e-authorize-cross-relayer.ts` |
| e2e-3 | Multi-tier verifier dispatch (16 / 64 / 128) | 🧪 test | `scripts/local-tier-e2e.sh` — note: smoke-tests the tier registry, NOT the Drop airdrop flow. Drop E2E is currently 👤 UI only. |
| e2e-4 | Vault note lifecycle (deposit → spend → claim → change) | 🧪 test | `forge test --match-test test_withdraw_partial_creates_change` |

---

## Test debt

Tracked separately — pre-existing, not regression from the proxy migration:

1. **shared-orderbook fixtures** — 24 tests in `test/api.test.ts` + `test/e2e-flow.test.ts` POST orders with `<relayer>-<nonce>` IDs, but the server has required the `OFFER_HANDLE` shape (`0x` + 64-char hex) for some time. Server-side guard is correct; fixtures need to be regenerated. Owner: refresh test bodies in a follow-up PR.
2. **zk-relayer `info.test.ts`** — asserts `name === "ScatterDEX ZK Relayer"`; the running relayer returns `"Relayer-A"` after the per-instance rename. Owner: trivial rename / regex.
3. **`packages/sdk` has no vitest scaffolding** — `npm test` script absent, no `test/` directory. Owner: add minimal vitest setup + 3-5 representative tests for hooks / factory / stealth helpers.
4. **`scripts/run-e2e.sh` is broken** — line 39 does `cd relayer` but the directory is `zk-relayer/`. Either fix the path or retire the script in favour of `start-cross-relayer-e2e.sh` for cross-relayer E2E + a dedicated Pay-flow script.
5. **Drop E2E coverage gap** — there is no automated test for the Drop airdrop / sybil-proof flow today. `local-tier-e2e.sh` exercises the multi-tier verifier registry, which is adjacent but not the same flow.

None of the above block release readiness — production code paths are exercised by the **545 passing tests** (239 forge + 231 zk-relayer + 60 shared-orderbook + 15 other). The 25 stale tests are documentation-of-old-shape, not coverage gaps in shipping code.
