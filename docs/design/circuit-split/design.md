# Half-proof: Client-Side Single-Side Proving

> **Status**: **Implemented and live.** This document describes the Half-proof
> system as shipped — the `authorize.circom` circuit family and the
> `PrivateSettlement.settleAuth` settlement path.
>
> **History**: this file was originally a pre-implementation *circuit split*
> analysis (`maker_order.circom` + `taker_match.circom`, `orderId` /
> `tradeBinding` shared anchors, a `settlePrivateSplit` entrypoint, and a
> three-phase migration plan off the monolithic `settle.circom`). The
> implementation collapsed both halves into one symmetric per-side circuit and
> dropped the in-circuit trade anchors entirely (see §4 for what replaced
> them). The legacy `settle.circom` / `settlePrivate` path was deleted on
> 2026-04-14. The original analysis is preserved in this file's git history.
>
> **Design decisions referenced from this document** (see
> [architecture-v2.md](../../architecture/architecture-v2.md) §"Design decisions"):
> - **D1**: Self-trade is intentionally **not** prevented at the protocol
>   layer. No per-trader-stable value is exposed as a public output of
>   `authorize.circom`. See §6 and
>   [ADR-001](../../architecture/adr/001-no-self-trade-detection.md).
> - **pubKeyBind**: the one compliance-oriented public output, per-trade
>   unique. See §3.6 and
>   [ADR-002](../../architecture/adr/002-pubkeybind-privacy-tradeoff.md).
>
> **Related docs / code**:
> - [architecture-v2.md](../../architecture/architecture-v2.md) — entry point + design decisions
> - [relayer-protocol/design.md](../relayer-protocol/design.md) — Waku-based relayer protocol that transports Half-proofs (pre-implementation)
> - [dispute-registry/design.md](../dispute-registry/design.md) — dispute registry for the commit-reveal layer (pre-implementation)
> - [relayer-security.md](../../operations/relayer-security.md) — threat model (§1–§3 describe the legacy custodial model that Half-proof removed)
> - [circuits/authorize_template.circom](../../../circuits/authorize_template.circom) — the Half-proof circuit (shared template)
> - [circuits/authorize.circom](../../../circuits/authorize.circom) — tier-16 wrapper ([_64](../../../circuits/authorize_64.circom) / [_128](../../../circuits/authorize_128.circom) for higher tiers)
> - [circuits/cancel.circom](../../../circuits/cancel.circom) — escrow-rotation cancel circuit
> - [circuits/tags.circom](../../../circuits/tags.circom) — shared Poseidon domain-separation tags
> - [contracts/src/zk/PrivateSettlement.sol](../../../contracts/src/zk/PrivateSettlement.sol) — settlement contract (`settleAuth` and friends)
> - [contracts/src/zk/SettleVerifyLib.sol](../../../contracts/src/zk/SettleVerifyLib.sol) — `AuthorizeProof` struct, signal packing, cross-side validators

## 1. Motivation

A monolithic settlement circuit proves facts about both maker and taker
simultaneously, so **somebody** must collect both parties' witness data
(`secret`, `salt`, `balance`, EdDSA keys, claim preimages) in one place. In
the legacy implementation that somebody was the relayer — the root privacy
problem documented in
[relayer-security.md](../../operations/relayer-security.md) §1–§3.

The Half-proof architecture removes it:

- Users generate proofs **in their browsers** using only their own witness
- Relayers receive only the public proof output (Groth16 A/B/C + public signals)
- `secret`, `salt`, `balance`, claim secrets, EdDSA signing keys, and Merkle
  path data **never leave the user's device**

Of the three ways to produce a two-party proof without witness aggregation —
MPC (Renegade's approach; synchronous, mobile-hostile), witness hand-over
(defeats the goal), and splitting — zkScatter ships the split: each party
proves their own side, and the few cross-party checks become plain integer
comparisons on public signals in the contract (§5).

## 2. The shipped shape: one symmetric circuit, not two

The original analysis planned distinct `maker_order.circom` and
`taker_match.circom` circuits. The implementation collapsed them into a single
**`Authorize` template** used identically by both sides:

> *"I authorise spending `sellAmount` of `sellToken` out of my escrow, in
> exchange for at least `buyAmount` of `buyToken` distributed to these
> claims."*

"Maker" and "taker" are roles assigned at settlement time, not circuit-level
concepts. The relayer matches two `authorize` proofs off-chain and submits
them as one `settleAuth(maker, taker)` transaction.

### 2.1 Tier wrappers

`authorize_template.circom` contains the template only (no `component main`).
Per-tier wrappers instantiate `Authorize(commitTreeDepth, maxClaimsPerSide,
claimsTreeDepth)`:

| Wrapper | Tier (max claims/side) | Params | `.zkey` size |
|---|---|---|---|
| `authorize.circom` | 16 (default/live) | `(20, 16, 4)` | ~19 MB |
| `authorize_64.circom` | 64 | `(20, 64, 6)` | ~51 MB |
| `authorize_128.circom` | 128 | `(20, 128, 7)` | ~94 MB |

`commitTreeDepth = 20` (~1M commitments) is shared across tiers. Each tier
compiles to its own r1cs/wasm/zkey under `circuits/build/`; artifact hashes
are pinned in [circuits/zk-manifest.json](../../../circuits/zk-manifest.json).
Adding a tier = one more wrapper file + owner calls
`setAuthorizeVerifier(tier, addr)` / `setClaimVerifier(tier, addr)` (§5.4).

## 3. Circuit specification (`Authorize`)

### 3.1 Public signals

The Groth16 verifier sees **15 public signals**. `pubKeyBind` is a circuit
*output* and therefore appears first; the remaining 14 are declared public
inputs (order matters — `SettleVerifyLib.packAuthSignals` must match):

| # | Signal | Meaning |
|---|---|---|
| 0 | `pubKeyBind` | `Poseidon(pubKeyAx, pubKeyAy, nullifier)` — compliance binding (§3.6) |
| 1 | `commitmentRoot` | Merkle root the membership proof was generated against |
| 2 | `nullifier` | escrow nullifier `Poseidon(TAG_ESCROW_NULL, secret, salt)` |
| 3 | `nonceNullifier` | nonce nullifier `Poseidon(TAG_NONCE_NULL, secret, nonce)` |
| 4 | `newCommitment` | residual escrow commitment (0 if fully spent) |
| 5 | `sellToken` | token being sold |
| 6 | `buyToken` | token being bought |
| 7 | `sellAmount` | limit-order sell amount |
| 8 | `buyAmount` | limit-order minimum buy amount |
| 9 | `maxFee` | fee ceiling in bps, user-signed |
| 10 | `expiry` | order expiry (unix timestamp) |
| 11 | `claimsRoot` | Merkle root of this user's claim leaves |
| 12 | `totalLocked` | sum of claim amounts (what this user's recipients receive) |
| 13 | `relayer` | relayer address bound into the proof |
| 14 | `orderHash` | EdDSA-signed order hash (§3.5) |

Private inputs: `secret`, `balance`, `salt`, Merkle path, `nonce`, `newSalt`,
EdDSA pubkey + signature, and the padded per-claim arrays
(`claimSecrets/Recipients/Tokens/Amounts/ReleaseTimes`, `claimCount`).

### 3.2 Domain-separated hashes

All Poseidon preimages are domain-separated via
[tags.circom](../../../circuits/tags.circom) (mirrored in
`zk-relayer/src/core/tags.ts` and `frontend/app/lib/zk/tags.ts` — changing a
tag is a consensus break):

| Tag | Value | Hash |
|---|---|---|
| `TAG_ESCROW_NULL` | 0 | escrow nullifier = `Poseidon(0, secret, salt)` |
| `TAG_NONCE_NULL` | 1 | nonce nullifier = `Poseidon(1, secret, nonce)` |
| `TAG_CLAIM_NULL` | 2 | claim nullifier = `Poseidon(2, secret, leafIndex)` |
| `TAG_COMMITMENT_V2` | 3 | commitment = `Poseidon(3, secret, token, balance, salt, pubKeyAx, pubKeyAy)` |

The **v2 commitment binds the BabyJub signing pubkey** into the preimage
(issue #128): a leaked `(secret, token, balance, salt)` is not enough to forge
a proof, because a swapped pubkey produces a different leaf and fails Merkle
membership, and the attacker cannot re-sign `orderHash` without the EdDSA
private key. `deposit.circom` is the canonical place where the pubkey is
validated (BabyCheck + identity-point rejection); downstream circuits
(authorize/cancel/withdraw/claim) rely on the invariant that every commitment
in the tree was produced by a well-formed pubkey.

### 3.3 Constraint walkthrough

In template order:

1. **Range checks** — `sellAmount`/`buyAmount` to **126 bits**,
   `balance`/`totalLocked`/each claim amount to 128 bits, `maxFee` to 16 bits
   **and ≤ 10000** (without the 10000 cap, `10000 − maxFee` would wrap the
   field in step 7), `claimCount` to 8 bits and ≤ `maxClaimsPerSide`.
   The 126-bit cap on trade amounts is a hard correctness boundary for the
   in-circuit `LessEqThan` comparisons on price products — do not widen it
   without re-auditing every consumer (`settleAuth`, `settleWithDex`,
   `scatterDirectAuth`).
2. **Commitment membership** — v2 commitment (table above) ∈ `commitmentRoot`
   via a depth-20 Poseidon Merkle proof.
3. **Nullifiers** — escrow + nonce nullifiers recomputed and constrained to
   the public signals.
4. **Balance sufficiency** — `sellAmount ≤ balance`.
5. **Residual commitment** — `newBalance = balance − sellAmount`;
   `newCommitment` is the v2 hash over `(secret, sellToken, newBalance,
   newSalt, pubKeyAx, pubKeyAy)`, or **0 when fully spent** (`IsZero` mux).
   Same pubkey, so the residual is spendable with the same key.
6. **Claims validation** — each leaf =
   `Poseidon(claimSecret, recipient, token, amount, releaseTime)`; unused
   slots (`i ≥ claimCount`) must have `amount = 0`; **every used claim must be
   denominated in `buyToken`** (PR #127 — otherwise a malicious client could
   sign for USDC but distribute leaves in a worthless token);
   `Σ amounts === totalLocked`; the padded leaf array Merkle-hashes to
   `claimsRoot`.
7. **Minimum receive guarantee** —
   `totalLocked × 10000 ≥ buyAmount × (10000 − maxFee)`.
   The user's relayer fee is drawn from their own receive side (§5.2), so
   recipients are guaranteed at least the worst-case net. This constraint is
   the in-circuit replacement for the old cross-party "minimum receive" check
   (C3) — it no longer needs the counterparty's signals.
8. **Order hash + EdDSA** — `orderHash = Poseidon(sellToken, buyToken,
   sellAmount, buyAmount, maxFee, expiry, nonce, claimsRoot, relayer)`,
   verified against the user's BabyJub signature. This is what makes a proof
   an *authorisation*: every economically meaningful public signal is either
   in the signed hash or derived from signed material.
9. **Relayer binding** — `relayer²` referenced so the optimizer keeps the
   signal in the witness.
10. **pubKeyBind output** — §3.6.

### 3.4 What is deliberately absent

- **No `orderId` / `tradeBinding` / `currentTimestamp` anchors.** The
  original design bound the two proofs together with shared in-circuit
  anchors. Shipped binding works differently — see §4.
- **No pubkey public output** (D1). An earlier draft exposed
  `pubKeyHash = Poseidon(Ax, Ay)` for self-trade detection and
  defence-in-depth. Both justifications fail: the v2 commitment binding makes
  the defence redundant, and a per-trader-stable public signal is a
  linkability oracle — chain analysis could cluster every trade sharing the
  hash and join it with plaintext `claimRecipients` to reconstruct wallet
  graphs. The pubkey stays witness-only.
- **No self-trade check** (D1, §6).
- **No per-side fee signal.** The circuit binds only `maxFee`; the actual fee
  is relayer-chosen at settlement and bounded by the contract (§5.2).

### 3.5 Order hash as the off-chain matching object

Relayers match orders entirely off-chain. The user hands the relayer the
proof + public signals; `orderHash` (EdDSA-signed, includes the relayer
address) is the unforgeable identity of an order. A relayer cannot alter any
trade parameter, re-route the order to another relayer, or splice claim sets
— any mutation breaks either the signature check or the Groth16 proof.

### 3.6 `pubKeyBind` (compliance binding)

`pubKeyBind = Poseidon(pubKeyAx, pubKeyAy, nullifier)` lets a relayer verify
a user's *claimed* pubkey off-chain (recompute and compare) without the
pubkey appearing on-chain. Because the nullifier differs per trade,
`pubKeyBind` is per-trade unique: observers without the pubkey cannot link
trades, while a relayer who knows the user's pubkey can — intentionally, for
the compliance chain (relayer logs wallet ↔ pubkey ↔ trade; law enforcement
traces via subpoena). Full trade-off analysis in
[ADR-002](../../architecture/adr/002-pubkeybind-privacy-tradeoff.md).

## 4. Binding two proofs without shared anchors

The original design made both circuits derive a shared `orderId` /
`tradeBinding`, with the taker echoing `referencedMaker*` fields for the
contract to cross-check. None of that shipped. The realised binding model:

- **Each proof is a self-contained, signed limit order.** All binding-relevant
  fields are public signals backed by the EdDSA-signed `orderHash`.
- **Compatibility is checked, identity is not.** `settleAuth` verifies the two
  orders are *compatible* (tokens cross, price crosses, claims+fees fit —
  §5.1). It does not care *which* counterparty order it is: any pair of
  compatible signed orders is a valid match. Matching choice is the relayer's
  off-chain concern; users are protected by their own signed limits, not by
  naming a specific counterparty.
- **Replay is impossible** regardless: each side's escrow and nonce
  nullifiers burn on settlement.

### 4.1 Async roots (S1)

Each side's `commitmentRoot` is validated **independently** against
`pool.isKnownRoot()` (the Tornado-style ring buffer in
`IncrementalMerkleTree`, `ROOT_HISTORY_SIZE = 30`). The two roots are **not**
required to be equal: every deposit advances the root, so a strict-equality
rule would shrink the valid matching window to ~0 in any active pool —
incompatible with asynchronous matching. Double-spend safety comes from the
nullifiers, not root equality. Same pattern as Tornado Cash / Railgun /
Semaphore. Regression-locked by tests that settle with two *different*
in-history roots (`SettleAuth.t.sol`).

### 4.2 Time: `expiry` vs the old `currentTimestamp`

The old design carried a shared `currentTimestamp` public input plus a
`TIMESTAMP_TOLERANCE` contract constant. Shipped: the circuit binds only the
user-signed `expiry`, and the contract checks `block.timestamp ≤ expiry` per
side at settlement. No tolerance constant, no cross-side timestamp equality.

## 5. Contract: `PrivateSettlement.settleAuth`

### 5.1 Call shape and check order

```solidity
struct SettleAuthParams {
    SettleVerifyLib.AuthorizeProof maker;
    SettleVerifyLib.AuthorizeProof taker;
    uint96 feeTokenMaker;   // relayer-chosen, capped by maker's signed maxFee
    uint96 feeTokenTaker;   // relayer-chosen, capped by taker's signed maxFee
}
function settleAuth(SettleAuthParams calldata p) external nonReentrant whenNotPaused;
```

`AuthorizeProof` carries the Groth16 points, the 15 public signals (§3.1) and
a `tier` byte that selects the verifier; `packAuthSignals` flattens it for
verification. The checks, in execution order (cheap → expensive):

1. **Submitter binding** — `msg.sender` must be `maker.relayer` or
   `taker.relayer` (`NotMakerOrTakerRelayer`); sanctions screen on submitter.
2. **Tier resolution** — `authorizeVerifierByTier[tier]` per side; reverts
   `TierNotConfigured(tier)` if unset. Mixed-tier settlements (e.g. 16 ↔ 64)
   are supported — each side gets its own verifier.
3. **Cross-side invariants** (`SettleVerifyLib.validateCrossSide`):
   - non-zero sell/buy amounts (`ZeroSellAmount` / `ZeroBuyAmount`)
   - sell-token whitelist (buy tokens covered transitively by C1)
   - **C1 token compatibility**: `maker.sellToken == taker.buyToken` and
     vice versa (`TokenSidesMismatch`)
   - **C2 price**: `maker.buyAmount × taker.buyAmount ≤
     maker.sellAmount × taker.sellAmount` (`PriceMismatch`)
   - **C4 claims+fee cap**: `side.totalLocked + side fee ≤ counterparty
     sellAmount` (`ClaimsCapExceeded`)
   - **fee bound**: `feeTokenX × 10000 ≤ X.buyAmount × X.maxFee`
     (`FeeExceedsMax`) — see §5.2
   - per-side `block.timestamp ≤ expiry` (`OrderExpired`)

   (Of the original cross-party inventory: C1, C2, C4 live here; C3 moved
   into the circuit as the minimum-receive guarantee §3.3-7; C5 was removed
   per D1.)
4. **Intra-tx nullifier equality guards** — `maker.nullifier !=
   taker.nullifier` and same for nonce nullifiers. Load-bearing (PR #133):
   without them, two proofs against the *same* commitment would each pass the
   "not yet spent" mapping reads within one tx and drain `2 × totalLocked`
   from the pool. Regression test: `PoolDrainExploit.t.sol`.
5. **Stored nullifier checks** — 4 mappings (escrow + nonce per side),
   ordered before root recency because 4 flat SLOADs are far cheaper than the
   ring-buffer scan and replays dominate reverting calls.
6. **Per-side root recency** — `pool.isKnownRoot` each side (§4.1).
7. **Groth16 verification** — if both sides share a tier and a
   `batchAuthorizeVerifierByTier[tier]` is registered, one 5-pairing batched
   check verifies both proofs (~70–100K gas saved); otherwise two independent
   verifications. Mixed tiers always verify per side.
8. **Relayer registry gating** — both relayers must be active if a registry
   is configured.
9. **Effects** — mark 4 nullifiers; insert non-zero residual commitments;
   `pool.transferToSettlement(side.buyToken, side.totalLocked)` per side;
   route fees (§5.2); register one claims group per side (`claimsRoot` must
   be distinct when both sides lock funds — `DuplicateClaimsRoot`); emit
   `PrivateSettledAuth(makerNullifier, takerNullifier, claimsRootMaker,
   claimsRootTaker, makerRelayer, takerRelayer, submitter, feeTokenMaker,
   feeTokenTaker)`.

### 5.2 Fee semantics (2026-04-14 redesign)

Each user's signed `maxFee` (bps) caps the fee drawn **from their own receive
side** — the counterparty's `maxFee` cannot inflate what a user pays:

```
feeTokenMaker · 10000 ≤ maker.buyAmount · maker.maxFee   // paid to maker.relayer
feeTokenTaker · 10000 ≤ taker.buyAmount · taker.maxFee   // paid to taker.relayer
```

`feeTokenMaker` is denominated in `maker.buyToken` (= `taker.sellToken`).
The actual fee is relayer-chosen at submission, in token units — the circuit
binds only the ceiling. Fees route through `FeeVault` when configured
(`feeVault.deposit(relayer, token, amount)`), else directly to the relayer.
The minimum-receive constraint (§3.3-7) guarantees recipients their
worst-case net even at `fee = maxFee`.

### 5.3 Other consumers of the authorize proof

The same circuit serves three more entrypoints — the proof is a generic
"spend authorisation", not settlement-specific:

| Entrypoint | Shape | Notes |
|---|---|---|
| `settleWithDex` | 1 proof + whitelisted DEX router + calldata | Permissionless market order — user submits directly (`relayer = self`), no registry gating. Requires `sellToken != buyToken`, a `deadline`, and `amountOut ≥ totalLocked`; optional platform fee (`dexPlatformFeeBps ≤ 500`) and positive slippage accrue to `FeeVault.platformRevenue`. |
| `scatterDirectAuth` | 1 proof + relayer fee | Same-token scatter (`sellToken == buyToken` enforced). Fee capped by `sellAmount × maxFee`; claims + fee ≤ `sellAmount`. |
| `scatterDirect` | withdraw-proof variant | Legacy single-party scatter routed through `pool.withdrawFor`; registers claims at tier 16. |

### 5.4 Verifier registries and tiers

All verifiers are owner-settable registries on `PrivateSettlement`:

- `authorizeVerifierByTier[tier]` — Groth16 verifier per authorize tier
- `claimVerifierByTier[tier]` — per-tier claim verifiers (each tier has its
  own `claimsTreeDepth`, so one claim circuit cannot serve all tiers); the
  tier is stored on each `ClaimsGroup` so recipients never need to know it
- `batchAuthorizeVerifierByTier[tier]` — optional 5-pairing batch verifier
- `cancelVerifier` — single (cancel is tier-independent)

Setting any entry to `address(0)` disables that path
(`TierNotConfigured(tier)` / `CancelVerifierNotSet`). Wiring is covered by
`MultiTierWiring.t.sol`.

## 6. Self-trade (D1) — intentionally not prevented

Unchanged decision, full rationale in
[ADR-001](../../architecture/adr/001-no-self-trade-detection.md):

1. Self-trading is pure self-loss (fees + gas); rational users won't, and
   malicious users pay the same costs.
2. Fund integrity is already guaranteed by the nullifiers — double-spend is
   impossible regardless of who is on the other side (and the intra-tx
   equality guards of §5.1-4 close the same-commitment variant).
3. Wash-trading is a regulatory concern handled post-hoc via the compliance
   layer (`pubKeyBind` + relayer logs), not by on-chain enforcement.
4. **Privacy invariant (load-bearing)**: any on-chain self-trade check needs a
   per-trader-stable public output, which is a trade-clustering oracle. The
   circuit therefore exposes none.

A positive test locks the decision in: same-key-both-sides settlement
**succeeds** (`SettleAuth.t.sol`), so an accidental re-introduction of a
self-trade check fails CI.

## 7. Cancellation: `cancel.circom` + `cancelPrivate`

The original design claimed cancellation needed no circuit ("purely a gossip
concern"). That was wrong for the shipped trust model: **the relayer holds
the user's authorize proof and can submit it at any time**, and has no
economic incentive to honor a soft cancel. Trust-minimized cancel requires an
on-chain nullifier burn.

[cancel.circom](../../../circuits/cancel.circom) (~8K constraints) proves
ownership of the escrow commitment and EdDSA-authorises an **escrow
rotation**:

- burns the escrow nullifier and the order's nonce nullifier
- creates a new commitment with the **same balance and a new salt** (no
  tokens move; the balance stays in `CommitmentPool` under a fresh leaf)
- 5 public signals: `commitmentRoot`, `oldNullifier`, `oldNonceNullifier`,
  `newCommitment`, submitter (= `msg.sender`, bound in the proof)
- pubkey stays private (D1 applies to cancel too)

`cancelPrivate` is permissionless — the user submits from their own wallet;
the Groth16 proof is the access control. The contract requires
`newCommitment != 0` (otherwise the balance would be bricked), burns both
nullifiers, inserts the rotated commitment, and emits `PrivateCancel` —
relayers listen for the indexed `nonceNullifier` to drop the order from their
books. After it mines, any `settleAuth` against the old escrow reverts
`NullifierAlreadySpent`, and the user can immediately place new orders from
the rotated leaf.

Expiry needs no transaction at all: an expired order fails `OrderExpired` at
settlement, and since no funds move before settlement there is nothing to
refund.

## 8. Claims

Settlement registers a `ClaimsGroup{totalLocked, totalClaimed, token, tier}`
per side, keyed by `claimsRoot`. Recipients later call `claimWithProof` (or
`claimWithProofBatch`, ≤ 20 per tx) with a `claim.circom` proof of leaf
membership — revealing nothing about which settlement, who else was paid, or
the order parameters. Guards: claim nullifier, `totalClaimed ≤ totalLocked`,
`releaseTime`, token match, optional sanctions + zk-X509 identity gate on the
recipient, WETH auto-unwrap to ETH. Claims never expire.

## 9. Test map

| Concern | Where |
|---|---|
| Circuit positive/negative vectors | `circuits/test/authorize.test.js` |
| Full deposit → authorize → settle → claim flow | `circuits/test/e2e.test.js` |
| `settleAuth` happy path, cross-side reverts, async-root positives, D1 positive | `contracts/test/SettleAuth.t.sol` |
| Same-commitment drain regression | `contracts/test/PoolDrainExploit.t.sol` |
| Cross-side validator unit tests | `contracts/test/SettleVerifyLib.t.sol` |
| DEX path (incl. fork tests) | `contracts/test/SettleWithDex*.t.sol` |
| Tier registry wiring | `contracts/test/MultiTierWiring.t.sol` |
| Invariant suites | `contracts/test/invariant/` (see [HARDENING.md](../../security/HARDENING.md)) |

## 10. Open questions that remain open

Most of the original open questions were settled by implementation (orderId:
dropped entirely; contract-side cross-checks: yes; Groth16: kept; merged
verifiers: per-tier registries). Still genuinely open:

- **Trusted setup ceremony** — current `.zkey`s are dev-grade; a public
  ceremony (or a Plonkish migration that removes the need) is required before
  mainnet value at risk.
- **Partial fills** — unimplemented. The fallback remains order splitting
  (N smaller orders, one leaf each); a folding-scheme accumulator (Nova et
  al.) stays a post-MVP idea.
- **Mobile proving memory** — tier-16 proving fits desktop browsers
  comfortably; tier-128 (~94 MB zkey) needs real-device profiling before
  being offered on mobile (`mobile/native-prover/` is the active fallback
  work).

---

*This document describes the implemented protocol. The circuit's public
signal layout (§3.1) and the Poseidon tags (§3.2) are consensus surfaces —
any change is a breaking protocol change and must be coordinated across
`circuits/`, `contracts/`, `zk-relayer/`, and `frontend/` in lock-step.*
