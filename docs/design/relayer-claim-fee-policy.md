# Relayer fee redesign — including claim gasless cost

Status: **Option B1 implemented** (PR #644) — per-recipient claim reserve added off-chain by stretching the existing `maxFee` bps signal to cover service + reserve. Contract & circuit unchanged. Sections 1–4 are background; section 5 (Option B1) describes the shipped design. Future-tier options (full Option B with circuit changes) remain analysis-only.

## 1. Background

### 1.1 Today's fee model

- `RELAYER_FEE_BPS` (default 30 bps, env-configurable per relayer) — the only fee parameter today.
- At settle (`scatterDirectAuth`), the operator's escrow includes `escrow + fee`, where `fee` is bps of `sellAmount`.
- The fee is bound into the **authorize ZK proof**'s public signal `maxFee` (bps). The contract validates `fee × 10000 ≤ sellAmount × maxFee` (`SettleVerifyLib.validateScatterAuth`, `PrivateSettlement.sol:929`).
- The fee is routed from the pool to the FeeVault (or directly to the relayer). Relayer later claims revenue from FeeVault.

### 1.2 Claim flow today

- Recipient claims via `claimWithProof`. Contract transfers **the full `amount`** to recipient (`_executeClaim` in `PrivateSettlement.sol:1074-1077`).
- The relayer pays the **claim transaction gas out of its own ETH wallet**. No on-chain fee deduction.
- Relayer eligibility check: relayer only pays for claims belonging to settles it itself processed (`zk-relayer/src/routes/claim.ts:67-71`).

### 1.3 Implicit subsidy

The 30 bps settle fee is the relayer's only revenue. It must cover:

1. The relayer's service cost (running infrastructure, profit margin).
2. **All future claim gas** for every recipient on the run.

This bundling is invisible to operators — they see only "30 bps."

## 2. Problem

Settle fee `escrow × bps` and claim cost `N × gasPerClaim × gasPrice` scale on different axes. Mismatches:

| Scenario | Fee revenue | Claim cost (mainnet 0.35 gwei) | Net |
|---|---|---|---|
| 1,000 USDC, N=16 | 3.00 USDC | $0.008 | +$2.99 |
| 160 USDC, N=16 | 0.48 USDC | $0.008 | +$0.47 |
| 6,400 USDC, N=64 (TIER_64) | 19.2 USDC | $0.032 | +$19.17 |
| 1,000 USDC, N=16 @ 100 gwei | 3.00 USDC | $2.24 | +$0.76 |
| 160 USDC, N=16 @ 100 gwei | 0.48 USDC | $2.24 | **−$1.76** |
| 1,000 USDC, N=128 @ 30 gwei | 3.00 USDC | $5.38 | **−$2.38** |

Loss conditions:
- High N + low total amount (small batch payroll)
- Mainnet gas spike (NFT mint, MEV war)
- Future TIER_128 runs on mainnet

Today these losses are absorbed by the relayer or handled out-of-band (relayer refuses to settle, manual operator follow-up). Neither is good operationally.

Operator UX gaps:
- No visibility into per-recipient cost dimension
- No control beyond bps cap
- Can't compare relayers on "true cost"

## 3. Goals & non-goals

### Goals

- Make claim gas cost **explicit** in the fee model.
- Operator sees one combined "relayer fee" line, internally decomposed into service + claim reserve.
- Platform (Tokamak) controls the per-recipient claim fee policy (consistent across relayers).
- Relayer can never lose money on claims for a settle they accepted.
- Recipient still receives the **full promised amount** at claim time.

### Non-goals (this iteration)

- **External price oracles** (Chainlink, Uniswap, CoinGecko). External dependencies = manipulation surface, downtime risk. Reject for system stability.
- **Real-time gas pricing in operator order**. Operator's signed maxFee must be stable through the proof's lifetime; querying current gas mid-flow introduces races.
- **Per-relayer fee competition** on claim gas. Single platform policy keeps operator decisions simple.

### Constraints

- ZK circuit is the load-bearing trusted component. Changes require new trusted setup ceremony — **expensive, slow, mainnet-blocking**.
- Contracts are upgradeable in principle but costly to change in practice (audit + redeploy + state migration).
- Relayer-side off-chain logic is the cheapest layer to change.

## 4. Design space

Three axes:

### Axis A — Where is the per-recipient fee value defined?

| Option | Source of truth | Tradeoff |
|---|---|---|
| **A1** Per-relayer (`/api/info`) | Each relayer publishes own `claim_fees` | Market-driven but inconsistent; operator must compare |
| **A2** Per-platform (env / shared config) | Platform sets `claim_fees`, all relayers honor | Single source of truth, predictable for operators |
| **A3** Per-platform on-chain | New `platformClaimFees` mapping in a contract, updateable by governance | Trustless enforcement, but requires contract change + governance design |

→ **A2** for v1. Migrate to **A3** if/when relayers misbehave.

### Axis B — How does the contract validate the new fee?

| Option | Cost | Strength |
|---|---|---|
| **B1** No contract change. The existing `maxFee × sellAmount` check absorbs the inflated total. Operator computes `effectiveBps = ceil((service + N×claimReserve) × 10000 / sellAmount)` and signs maxFee with that. | Zero (no circuit, no contract) | Cap-only — contract checks total ≤ cap, doesn't decompose. Operator self-validates. |
| **B2** Contract validates decomposition: add `maxClaimFeeWei` to circuit public signals + `recipientCount`. Contract checks `fee == sellAmount × bps + N × maxClaimFeeWei` (within cap). | **Heavy** — new circuit, new ceremony, new contract, full SDK plumbing | Trustless decomposition. |
| **B3** Hybrid — contract reads platform's `claimFeePerRecipient[token]` from a new on-chain registry, validates decomposition without changing the circuit. | Medium — contract change but circuit untouched | Decomposes on-chain. Platform sets values via governance. |

Notes:
- **B1** is a "stretch" of existing semantics. Current `maxFee` was conceptually "max bps fee" — the operator now uses it as "max total fee converted to bps." Mathematically equivalent for cap purposes; semantically narrower.
- **B2** is the cleanest correctness story but the most expensive (mainnet ceremony alone is weeks of coordination).
- **B3** is the middle ground but introduces a new on-chain dependency (`platformClaimFees`) that the operator's wizard must read.

### Axis C — Who absorbs the fee?

| Option | Recipient gets | Operator pays |
|---|---|---|
| **C1** Operator pre-pays into escrow, recipient receives full | full `amount` | `amount + service + N × claimReserve` |
| **C2** Recipient's claim is reduced | `amount − claimReserve` | `amount + service` |

→ **C1** preserves the payouts UX guarantee ("you get exactly what was promised"). C2 contradicts the product's value prop.

## 5. Recommended starting design

**Combination: A2 + B1 + C1.**

- **Platform defines** per-token claim fee (e.g., `claim_fees: { USDC: "0.05", TON: "0.5", ETH: "0.0001" }`). Source of truth: a single config the relayer reads (env or shared file). All relayers in the platform honor the same numbers.
- **No circuit change**. Operator's wizard computes `relayerFee = service + N × claim_fees[token]`, then `effectiveMaxBps = ceil(relayerFee × 10000 / sellAmount)`, signs the proof with that maxBps.
- **No contract change**. Existing `maxFee × sellAmount` cap absorbs the inflated total. Contract stays correct (doesn't validate decomposition, but that's acceptable when policy is platform-set).
- **Operator UX**: one combined "Relayer fee" line, expandable to show service / claim reserve breakdown.
- **Recipient UX**: unchanged — full `amount` at claim.
- **Relayer**: receives the combined fee in token at FeeVault. Off-chain, the relayer's claim service bills its own gas against the reserve portion of that bucket. Excess service bps is profit; deficit is loss (rare under platform-set policy).

### Why start here

- Zero circuit/contract risk
- Smallest implementation surface (off-chain only)
- Fully reversible if the model needs to change
- Lets us measure real-world fee adequacy before committing to circuit-level enforcement (B2/B3)

### Migration to B3 / B2

If empirical data shows relayer abuse (charging maxBps without honoring claim reserve), upgrade path:
1. Deploy `PlatformFeeRegistry` contract storing `claimFeePerRecipient[token]` (B3).
2. Add `recipientCount` and `maxClaimFee` to the authorize circuit public signals (B2). Run trusted setup. Redeploy verifier + settlement.
3. Operator wizard reads from registry instead of `/api/info`.

Each step is independent: B3 alone gives on-chain policy without circuit change; B2 adds decomposition enforcement.

## 6. Affected components (recommended design)

### Relayer (zk-relayer)

- `config.ts`: read per-token `CLAIM_FEE_<SYMBOL>` env vars (e.g. `CLAIM_FEE_USDC=0.05`) → `claimFees: { USDC: "0.05", ... }`. Mirrors the existing `GASLESS_FEE_<SYMBOL>` pattern; both share the `parsePerTokenDecimalEnv` helper.
- `routes/info.ts`: publish `claim_fees` alongside `gasless_fees`.
- `routes/admin.ts` (optional): admin endpoint to update `claim_fees` at runtime (mirrors existing `relayerFee` runtime override).
- (optional) `core/gas-estimator.ts`: background sampler publishing `gasEstimate.perClaimWei` for **admin reference only** — not consumed by operator wizard.

### SDK

- `RelayerApiInfo` type: add `claim_fees?: Record<string, string>` and `gasEstimate?: { perClaimWei, sampledAtBlock, sampledAtMs }`.

### Pay wizard (apps/pay)

- Funds step: query selected relayer's `/api/info`, read `claim_fees[tokenSymbol]`.
- Compute:
  ```
  serviceFee   = lockedAmount × bps / 10000   // lockedAmount = 수령액 합(required); 구현 apps/pay/app/_lib/payoutFees.ts
  claimReserve = N × claim_fees[token]
  relayerFee   = serviceFee + claimReserve
  // The on-chain check is `fee × 10000 ≤ sellAmount × maxFee`,
  // where `sellAmount` is the order's sell field and *includes* the
  // fee (escrow = required + fee). To match the implementation, the
  // bps stretch divides by `sellAmount = required + relayerFee`,
  // not by `required` alone.
  effectiveMaxBps = ceil(relayerFee × 10000 / (required + relayerFee))
  ```
- Display single combined "Relayer fee" line; expandable detail on hover.
- Pass `effectiveMaxBps` to authorize prover as the `maxFee` signal.

### Admin (apps/operators)

- New `/policies` page: shows `claim_fees` (current platform setting), `gasless_fees`, `gasEstimate` (current gas cost per claim) side by side. Admin uses `gasEstimate` as reference when tuning `claim_fees`.

### Contracts / circuits

- **No changes.**

## 7. Open questions

1. **Platform config delivery** — how does the platform-set `claim_fees` reach all relayers? Options: (a) every relayer hardcodes the same env values via an ops runbook; (b) shared config repo/file each relayer pulls; (c) admin endpoint that platform broadcasts to via signed message. Pick before PR 2.
2. **ETH-denominated runs** — operator sends ETH; relayer's claim gas is also in ETH. Two equivalent options: (a) use the same per-token claim fee (consistent UX) or (b) skip claim reserve and increase service bps for ETH runs (simpler but inconsistent).
3. **Fee floor and ceiling** — should the wizard refuse to compute when `claim_fees[token]` is missing, or fall back to 0? Fail-closed protects relayers; fail-open lets new tokens transit the system.
4. **`effectiveMaxBps` precision** — `ceil` vs `floor`. ceil ensures cap covers the computed fee but lets relayer charge slightly more than service+reserve (rounding up to next bps). Acceptable for stables; non-stable tokens with low decimals could see noticeable rounding.
5. **Migration timing** — current 30 bps fee model is shipped. Day-1 of new model should match current totals for typical runs (1000 USDC × 16 recipients × $0.05 = $0.80 reserve, so equivalent flat fee ≈ 8 bps service + 0.8 reserve = ~38 bps total). Need a tuning pass before announcing.

## 8. Option B deep-dive — circuit + contract decomposition

### 8.1 What "decomposition enforcement" means

The contract should reject any settle whose `fee` doesn't decompose into:

```
fee == ceil(sellAmount × bps / 10000) + N × maxClaimFeeWei
```

For the contract to validate this, both `bps` (existing `maxFee`) and `N × maxClaimFeeWei` need to be bound by the ZK proof — otherwise the relayer or operator could lie about either.

`bps` is already a public signal (`maxFee`).
`N` is a private input today (`claimCount` in `authorize_template.circom:207`).
`maxClaimFeeWei` doesn't exist anywhere in the proof.

So Option B's circuit work is:
- Promote `claimCount` from private input → public input.
- Add new public input `maxClaimFeeWei` (or equivalent).

Both are mechanically simple — no new constraint logic needed (the values are already computed implicitly inside the circuit when validating the claims tree). They just become exposed.

### 8.2 Circuit change shape

`circuits/authorize.circom` (and the TIER_64 / TIER_128 wrappers):

```circom
component main {public [
    commitmentRoot,
    nullifier,
    nonceNullifier,
    newCommitment,
    sellToken,
    buyToken,
    sellAmount,
    buyAmount,
    maxFee,
    expiry,
    claimsRoot,
    totalLocked,
    relayer,
    orderHash,
    claimCount,        // ← was private
    maxClaimFeeWei     // ← new
]} = Authorize(20, 16, 4);
```

Range check on `maxClaimFeeWei`: 96 bits (uint96, matches `fee` field's existing type in `ScatterDirectAuthParams`).

Public signal count: 14 → 16. Verifier ABI changes correspondingly.

### 8.3 Contract changes

`SettleVerifyLib.validateScatterAuth` becomes:

```solidity
function validateScatterAuth(
    AuthorizeProof calldata ap,
    address sender,
    uint96 fee,
    uint96 claimCount,            // new — bound to ap public signal
    uint96 maxClaimFeeWei,        // new — bound to ap public signal
    mapping(address => bool) storage whitelistedTokens
) external view {
    // ...existing checks...

    // Old bps-only cap → new bps + per-recipient cap
    uint256 bpsAllowed = uint256(ap.sellAmount) * uint256(ap.maxFee);
    uint256 reserveAllowed = uint256(claimCount) * uint256(maxClaimFeeWei) * FEE_BPS_DENOMINATOR;
    if (uint256(fee) * FEE_BPS_DENOMINATOR > bpsAllowed + reserveAllowed) {
        revert FeeExceedsMax();
    }

    // ...existing checks...
}
```

`PrivateSettlement.scatterDirectAuth` reads the two new fields from the proof's public signals via `SettleVerifyLib.packAuthSignals` — that helper's array length grows from 14 to 16, and the contract that consumes those signals (`PrivateSettlement.sol:945`) follows.

### 8.4 Verifier change

`AuthorizeVerifier.sol` is auto-generated from the zkey. New circuit → new zkey → new verifier. Three verifiers need regeneration: `AuthorizeVerifier`, `AuthorizeVerifier64`, `AuthorizeVerifier128`.

The hand-written batched verifiers (`BatchAuthorizeVerifier{,_64,_128}.sol`, the 8→5 pairing optimisation) share each tier's verifying key, so they must be re-synced in lock-step on every circuit recompile. `circuits/scripts/build.sh` calls `sync-batch-verifier-vk.mjs` to patch all three from the new zkeys; `sync-batch-verifier-vk.mjs --check` is the drift gate. Forgetting this reverts every same-tier `settleAuth` with `InvalidProof()` once the batch verifier is wired (the PR #708 drift class).

Hot-swap path: `PrivateSettlement.setAuthorizeVerifier(tier, newVerifierAddr)` (+ `setBatchAuthorizeVerifier(tier, addr)` if the batch path is enabled). Existing setters exist — admin/governance call.

### 8.5 Trusted setup ceremony

Each tier (`authorize`, `authorize_64`, `authorize_128`) needs its own phase-2 ceremony:

1. New circuit compiles to new R1CS.
2. Phase 2 contribution rounds (multi-party computation, each contributor adds entropy).
3. Final zkey deployed.

Per tier costs:
- Compute: `authorize_128` is the heaviest — `circuits/build/authorize_final.zkey` is ~95 MB today; phase-2 takes 30-60 minutes per contributor × N contributors.
- Coordination: announcing the ceremony, recruiting contributors (typical 5-10 for credible security), publishing contribution hashes / videos.
- Calendar time: 1-2 weeks per tier in practice, runnable in parallel.

The ceremony itself is the expensive operational overhead, not the code change.

Risk: weak ceremony (too few contributors, insufficient entropy verification) leaves the production system more vulnerable to a forged-proof attack. The existing v1 ceremony's contribution log is the precedent — Option B requires meeting or exceeding it.

### 8.6 SDK + frontend changes

Authorize prover input (`packages/sdk/src/zk/circuits/authorize.ts`):

```ts
export interface AuthorizeProofInput {
    // ...existing fields...
    claimCount: bigint;      // already required as private — now also public signal
    maxClaimFeeWei: bigint;  // new
}
```

Pay wizard (`apps/pay/app/payouts/new/page.tsx`):

```ts
const claimFeePerRecipient = await readPlatformClaimFee(token);  // PR 4 reads from on-chain registry, OR from /api/info in pure-A2
const N                    = recipients.length;
const serviceFee           = sellAmount * BigInt(maxFeeBps) / 10000n;
const claimReserve         = BigInt(N) * claimFeePerRecipient;
const totalFee             = serviceFee + claimReserve;
// Pass new public signals to prover
authorizeInput.claimCount      = BigInt(N);
authorizeInput.maxClaimFeeWei  = claimFeePerRecipient;
```

Display:
```
Relayer fee (incl. claim gasless):  1.106 USDC
  ├─ Service fee (30 bps):             0.306 USDC
  └─ Claim reserve (16 × 0.05):        0.800 USDC
```

### 8.7 Migration

Two parallel deploys live during the transition:

| Component | v1 (current) | v2 (Option B) |
|---|---|---|
| `AuthorizeVerifier` (per tier) | deployed | deployed at new address |
| `PrivateSettlement.authorizeVerifierByTier` | points at v1 | flipped to v2 once ready |
| Outstanding signed orders (signed against v1 maxFee) | settle against v1 verifier | rejected — must re-sign |
| Pay wizard | binds 14-signal proof | binds 16-signal proof |

Coordination:
1. Audit + ceremony for v2 verifiers.
2. Deploy v2 verifiers.
3. Roll wizard / SDK with v2 prover input.
4. Set `setAuthorizeVerifier(tier, v2)` on production settlement contract.
5. Operators with stale signed proofs (pre-deploy) must regenerate.

Failure mode: an operator pre-signed a proof and submits after the verifier flip — proof rejects. Mitigation: announce the flip with sufficient lead time; existing draft expiry windows (`OrderExpired` after `expiry` block timestamp) bound the staleness anyway.

### 8.8 Cost summary

| Workstream | Complexity | Calendar |
|---|---|---|
| Circuit edits (3 wrappers + range check) | Low | 2-3 days |
| Phase-2 ceremony per tier × 3 | High operational, low engineering | 2-4 weeks total (parallelisable) |
| Verifier regen + on-chain deploy | Medium | 2-3 days |
| `SettleVerifyLib.validateScatterAuth` change | Low | 1 day |
| `packAuthSignals` + `scatterDirectAuth` plumbing | Low | 1 day |
| SDK prover input | Low | 1 day |
| Pay wizard fee compute | Low | 2 days |
| Audit (circuit + contract delta) | High | 1-2 weeks |
| Migration ops + announcement | Medium | 1 week |
| **Total** | — | **6-9 weeks** |

Compare: Option B1 (off-chain only) ≈ 2-3 days end-to-end.

### 8.9 What Option B buys

- **Trustless decomposition.** Contract guarantees `fee = serviceFee + N × claimReserve` — neither operator nor relayer can over- or under-charge.
- **No "honor system."** The platform's per-token claim fee policy becomes hard-enforced via the per-proof `maxClaimFeeWei` check.
- **Cleaner audit story.** Future regulatory or accounting reviews see the fee decomposition in Solidity, not just in TypeScript.
- **Foundation for charge-by-claim** (charging recipient at claim time, model C2): once the contract knows `claimCount` and `maxClaimFeeWei`, extending claim-time deduction is small.

### 8.10 What Option B doesn't buy

- **Real-time gas tracking.** `maxClaimFeeWei` is still a fixed per-token number set off-chain (whether by platform env or on-chain governance registry). Gas spikes still affect relayer profit; the on-chain enforcement just guarantees the operator can't be charged more than the published policy.
- **Per-relayer competition on claim fees.** Same as B1 — platform sets one number; relayers all use it.
- **Cross-token fee.** Can't denominate the claim fee in ETH for an ERC-20 settle without bringing in oracles (the original rejected dependency).

### 8.11 Recommendation when to pick B

Pick Option B (over B1) if any of:
- A relayer is observed undercharging or overcharging in production (B1's honor system fails empirically).
- A regulator / auditor demands on-chain proof of fee decomposition.
- The platform expects to add charge-by-claim (model C2) within 6 months — Option B is a prerequisite either way.

Pick B1 (defer Option B) if:
- The fee model is still being tuned (platform unsure what `claim_fees[token]` should be) — iterating on a config value is much cheaper than iterating on a circuit.
- Mainnet ceremony coordination capacity is constrained for the next quarter.
- Time-to-launch matters more than enforcement strength.

### 8.12 Hybrid path: B3 (contract-only enforcement, circuit untouched)

Mid-ground: contract reads platform-set `claimFeePerRecipient[token]` from a new on-chain `PlatformFeeRegistry`. Validates `fee == sellAmount × bps + N × registry[token]` without `maxClaimFeeWei` being in the proof.

- Removes ceremony cost (no circuit change).
- Operator can't lie about `N` because it's already validated by `totalLocked` and `claimCount` constraints inside the circuit (private but tied to the public claims root). The contract doesn't see `N` directly though — it would need a separate on-chain way to learn the recipient count.

Inspecting the existing circuit: `claimCount` is private, but `claimsRoot` is public and is computed from the padded recipient array. Without `claimCount` exposed, the contract can't bound `N × registry[token]`.

So B3 isn't actually feasible without **at minimum** promoting `claimCount` to public — which is half of B's circuit change. Once that's done, adding `maxClaimFeeWei` as a public input is marginal extra work, and it provides the trust-minimised value-binding that pure B3 lacks.

→ B3 doesn't materially shorten the path versus B. If we're touching the circuit, do B properly.

## 9. Decision needed

Before implementation:

- [ ] Pick **B1** (off-chain only), **B** (full circuit + contract enforcement), or **B1 → B migration plan** (ship B1 first, plan B for v2.x).
- [ ] If B: budget mainnet ceremony coordination (3 tiers × ~1-2 weeks).
- [ ] If B1: resolve open question 1 (config delivery — env vs shared file vs admin endpoint).
- [ ] Confirm scope of admin viewing surface (`apps/operators/policies`).

Recommended starting position: **B1 first, plan B for the next major release.** B1 unblocks operator UX and protects relayers economically; B hardens the trust model when there's empirical demand.

After sign-off, work splits cleanly into:
1. **PR 1** — gas-estimator (admin reference)
2. **PR 2** — relayer publishes `claim_fees` via `/api/info` (B1 only)
3. **PR 3** — Pay wizard fee computation + UI (B1 only)
4. **PR 4** — `apps/operators/policies` viewing page (both B1 and B)
5. **PR 5+** (B only) — circuit edits, ceremony, verifier deploy, contract validateScatterAuth update, SDK plumbing

Each PR is mergeable independently.
