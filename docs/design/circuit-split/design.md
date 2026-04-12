# Half-proof: Client-Side Single-Side Proving

> **Status (2026-04 update)**: This document was originally drafted as a *circuit split* analysis (`maker_order.circom` + `taker_match.circom`). The actual implementation collapses both halves into a single per-side circuit, **`circuits/authorize.circom`**, used by both maker and taker. Two `authorize` proofs are matched by the relayer and submitted as `PrivateSettlement.settleAuth(makerProof, takerProof)`. Throughout this document, the terms "maker_order/taker_match" refer to the analysis-level decomposition; the realised primitive is simply called **Half-proof** and lives in `authorize.circom`.
>
> **Scope**: Replace the monolithic `circuits/settle.circom` with the Half-proof primitive — each user proves their own side in the browser, the relayer matches two proofs without ever seeing witness data, and a single `settleAuth` transaction settles the trade.
>
> **Design decisions referenced from this document** (see [../architecture-v2.md](../architecture-v2.md) §"Design decisions"):
> - **D1**: Self-trade is intentionally **not** prevented at the protocol layer. No per-trader-stable value is ever exposed as a public output of `authorize.circom`. The earlier `pubKeyHash` public output and any "compare maker/taker pubkey" check have been removed.
>
> **Related docs**:
> - [../architecture-v2.md](../architecture-v2.md) — entry point + design decisions
> - [../relayer-protocol/design.md](../relayer-protocol/design.md) — Waku-based relayer communication protocol that consumes the Half-proofs
> - [../dispute-registry/design.md](../dispute-registry/design.md) — dispute registry that records misbehavior detected via commit-reveal of Half-proofs
> - [../relayer-security.md](../relayer-security.md) — operational threat model — sections §1, §2, §3 become obsolete after Half-proof
> - [../design-shared-orderbook.md](../design-shared-orderbook.md) — current HTTP Trade Offer (deprecated by Half-proof)
> - [../../circuits/settle.circom](../../circuits/settle.circom) — legacy monolithic circuit (being replaced)
> - [../../circuits/authorize.circom](../../circuits/authorize.circom) — Half-proof primitive (current implementation target)
> - [../../contracts/src/zk/PrivateSettlement.sol](../../contracts/src/zk/PrivateSettlement.sol) — on-chain settlement target (`settleAuth` to be added)

## 1. Motivation

### 1.1 The current problem

The existing `circuits/settle.circom` is a **single monolithic circuit** (~30K constraints) that simultaneously proves facts about both maker and taker. Because both parties' witness data (`ownerSecret`, `salt`, `balance`, EdDSA keys, claim preimages) is needed to generate the proof, **somebody** must collect all of it in one place. In the current implementation, that "somebody" is the relayer.

This creates the root privacy problem documented in [../relayer-security.md](../relayer-security.md) §1-§3:

> | Data | Sensitivity | Location | Lifetime |
> | `ownerSecret` | **Critical** — proves commitment ownership | Memory + SQLite DB | Until settlement |
> | `salt` | **Critical** — needed for ZK proof | Memory + SQLite DB | Until settlement |
> | `balance` | **High** — reveals deposited amount | Memory + SQLite DB | Until settlement |
> | `claims` (secrets, recipients) | **High** — defines payout structure | Memory + SQLite DB | Until all claims processed |

Every zkScatter relayer must currently handle this sensitive data. The Trade Offer protocol ([../design-shared-orderbook.md](../design-shared-orderbook.md) Phase 2) even transmits it between relayers over HTTPS during cross-relayer matching. This is the single biggest source of trust that users place in relayer operators.

### 1.2 The architectural goal

**No relayer should ever see user witness data.** Specifically:

- Users generate proofs **in their browsers** (via `rapidsnark-wasm`) using only their own witness
- Relayers receive only the **public proof output** (Groth16 A/B/C + public signals)
- The relayer-to-relayer communication layer carries **proofs, not secrets**
- `ownerSecret`, `salt`, `balance`, `claimSecrets`, EdDSA signing keys, and commitment path data **never leave the user's device**

### 1.3 Why splitting is needed

A single 30K-constraint proof requires all witness in one place. If maker and taker are separate parties, each controlling half the witness, there are only three ways to produce the proof:

1. **Multi-party computation (MPC)** — both parties interact to jointly generate the proof. This is Renegade's approach. **Rejected**: requires both parties synchronously online, high complexity, mobile-hostile.
2. **Witness aggregation on one side** — one party sends their witness to the other. This is the *current* approach (via relayer). **Rejected**: defeats the privacy goal.
3. **Circuit split** — partition the proof into two halves such that each half uses only one party's witness, with shared public inputs binding them together. This is what this document specifies.

### 1.4 Why this is now possible

Two pre-existing architectural features make the split clean:

- **Trustless fee binding** ([../design-shared-orderbook.md](../design-shared-orderbook.md) §Phase 3.6): `makerRelayer` and `takerRelayer` are already separately bound in the ZK proof and in users' EdDSA signatures. The contract already treats them as independent parties.
- **Cross-party constraints are few and simple**: most of `settle.circom`'s constraints are per-party (commitment membership, nullifiers, signature verification, claims validation). The cross-party checks (token compatibility, price compatibility, balance/claim caps) are a small fraction and can be moved to the contract as arithmetic on public signals.

## 2. Current State Analysis

This section maps the actual constraints in [../../circuits/settle.circom](../../circuits/settle.circom) to establish which sections belong to which party and which are cross-party. References below are to specific line ranges in the current circuit.

### 2.1 Structural map of `settle.circom`

The circuit has 13 numbered sections. Summary of each:

| § | Section | Lines | Maker-only? | Taker-only? | Cross-party? | Notes |
|---|---|---|---|---|---|---|
| 1 | Commitment membership (maker) | 184-198 | ✅ | | | Poseidon(4) leaf + Merkle proof at `commitmentRoot` |
| 2 | Commitment membership (taker) | 200-215 | | ✅ | | Same structure as §1 |
| 3 | Nullifiers (4 total) | 217-239 | ▲ half | ▲ half | | 2 nullifiers per side (escrow + nonce) |
| 4 | Token compatibility | 241-247 | | | ✅ | `makerSellToken === tokenTaker`, `takerSellToken === tokenMaker` |
| 5 | Price compatibility | 249-275 | | | ✅ | Cross-multiply: `makerSell * takerSell ≥ makerBuy * takerBuy` |
| 6 | Expiry (both sides) | 277-288 | ▲ half | ▲ half | | Each party checks own expiry against `currentTimestamp` |
| 7 | Fee validation | 290-345 | ▲ half | ▲ half | | Per-party fee ≤ maxFee; fee computation uses both amounts |
| 8 | Balance sufficiency | 347-358 | ▲ half | ▲ half | | Per party: sellAmount ≤ balance |
| 8b | Minimum receive guarantee | 360-374 | | | ✅ | `totalLockedMaker ≥ makerBuyAmount`, `totalLockedTaker ≥ takerBuyAmount` |
| 8c | Claims + fees cap | 376-394 | | | ✅ | `totalLockedMaker + feeTokenMaker ≤ takerSellAmount` (uses both sides) |
| 9 | Claims validation | 396-475 | ▲ half | ▲ half | | Per party: compute leaf hashes, Merkle root, sum check |
| 10 | New commitments | 477-509 | ▲ half | ▲ half | | Per party: new balance = old − sellAmount |
| 11 | EdDSA signature | 511-557 | ▲ half | ▲ half | | Per party: order hash (9 fields) + signature verify |
| ~~12~~ | ~~Self-trade prevention~~ | ~~559-573~~ | | | ~~✅~~ | **Removed in Half-proof** — see §"D1: Self-trade is not prevented" below and `architecture-v2.md` §"Design decisions" |
| 13 | Relayer binding | 575-584 | ▲ half | ▲ half | | Just squared to ensure relayers appear in the proof |

### 2.2 Cross-party constraints inventory

The sections that **cannot** be done by one party alone are:

#### C1 — Token compatibility (§4)
```
makerSellToken === tokenTaker;
takerSellToken === tokenMaker;
```
Requires both parties' `sellToken` and the negotiated `tokenMaker`/`tokenTaker` to match.

#### C2 — Price compatibility (§5)
```
makerProduct = makerSellAmount * takerSellAmount;
takerProduct = makerBuyAmount * takerBuyAmount;
priceCheck: takerProduct ≤ makerProduct
```
Requires **all four amounts** simultaneously.

#### C3 — Minimum receive (§8b)
```
makerBuyAmount ≤ totalLockedMaker;
takerBuyAmount ≤ totalLockedTaker;
```
Each line is a mix: one party's `buyAmount` vs. the other party's provisioned claims total.

#### C4 — Claims cap (§8c)
```
totalLockedMaker + feeTokenMaker ≤ takerSellAmount;
totalLockedTaker + feeTokenTaker ≤ makerSellAmount;
```
Per line: one party's claim total vs. the other party's sell amount.

#### ~~C5 — Self-trade prevention~~ — **REMOVED**

The earlier design proposed comparing maker and taker public keys (or their Poseidon hashes) at the contract layer to reject same-party trades. **This check has been removed in the Half-proof realization** and is intentionally not present in `authorize.circom` or `settleAuth`.

The full rationale lives in [../architecture-v2.md](../architecture-v2.md) §"Design decisions / D1". Summary:

1. A rational user has no reason to self-trade — static fees + gas costs make it pure self-loss
2. A malicious user is economically penalised by the same fees and gas
3. A user who self-trades by mistake learns from it; the protocol does not babysit
4. Fund integrity is already guaranteed by the escrow + nonce nullifiers (§3) — double-spend is impossible regardless of who is on the other side
5. Wash-trading is a regulatory concern handled post-hoc by the dual-CA audit layer, not by on-chain enforcement

**Privacy invariant** (load-bearing reason): any on-chain self-trade check requires a per-trader-stable public output (`pubKeyHash`, link tag, identity nullifier, etc.). Such a value enables trade clustering by any observer and breaks trader anonymity. `authorize.circom` therefore exposes **no per-trader-stable public output** — only nullifiers (one-time use, unlinkable) and trade parameters.

**Cross-party checks reduce from C1-C5 to C1-C4.**

### 2.3 Shared context constraints

These are technically "shared" because both parties reference the same public inputs, but each party can verify them independently using public data:

- **S1 — `commitmentRoot`**: each party publishes its own Merkle root (the snapshot the prover used for membership). The two roots **need not be equal**. The contract independently checks each side against `pool.isKnownRoot()` (the existing Tornado-style ring buffer from `IncrementalMerkleTree`). Requiring equality would force both proofs to be generated against the same tree snapshot, which is incompatible with the asynchronous matching model — every new deposit advances the root, so a strict-equality rule would shrink the valid matching window to ~0 in any active pool. Double-spend safety is provided by the nullifiers (§3), not by root equality, so each side just needs its own root to be a recent (in-history) root.
- **S2 — `currentTimestamp`**: each party compares their own `expiry` against it. No cross-party dependency.
- **S3 — Relayer addresses (`makerRelayer`, `takerRelayer`)**: already separately bound per party in Phase 3.6. No change needed.

### 2.4 Per-party constraint inventory

Cleanly partitionable (already per-party or trivially partitionable):

- **P1 — Commitment membership** (§1 maker, §2 taker)
- **P2 — Nullifiers** (§3: `makerNullifier` and `makerNonceNullifier` from maker witness; `takerNullifier` and `takerNonceNullifier` from taker witness)
- **P3 — Expiry check** (§6: each party checks own expiry)
- **P4 — Balance sufficiency** (§8: each party's `sellAmount ≤ balance`)
- **P5 — Own fee range check** (§7 subset: `makerFee ≤ makerMaxFee`; taker symmetric)
- **P6 — Own claims Merkle root + sum** (§9: each side computes own `claimsRoot` and `totalLocked`)
- **P7 — Own new commitment** (§10: each side derives new balance commitment)
- **P8 — Own EdDSA signature** (§11: each party verifies own signature over own order hash)
- **P9 — Own relayer binding** (§13 half)

## 3. Split Target Identification

With §2 as the ground truth, the partition looks like:

### 3.1 Maker circuit responsibilities

`maker_order.circom` proves facts about **the maker only**:

- P1-maker, P2-maker, P3-maker, P4-maker, P5-maker, P6-maker, P7-maker, P8-maker, P9-maker
- Half of the fee computation in §7 (specifically `feeTokenTaker = floor(makerSellAmount * makerFee / 10000)`, which uses only maker's side)
- Publishes its half of the data needed for cross-party checks as **public inputs**

### 3.2 Taker circuit responsibilities

`taker_match.circom` proves facts about **the taker only**:

- P1-taker, P2-taker, P3-taker, P4-taker, P5-taker, P6-taker, P7-taker, P8-taker, P9-taker
- Half of the fee computation in §7 (specifically `feeTokenMaker = floor(takerSellAmount * takerFee / 10000)`)
- Publishes its half of the data needed for cross-party checks as **public inputs**
- **Additionally**: proves that the taker is matching against a specific maker order by referencing a shared `orderId` (see §5)

### 3.3 Cross-party checks moved to contract or binding proof

The cross-party checks C1-C4 (from §2.2 — C5 removed per D1) need to happen somewhere. Three options:

**Option A — In the contract (recommended for MVP)**
All cross-party checks are simple integer comparisons. They can be done in Solidity using the two proofs' public signals. This adds ~5-10k gas but removes an entire circuit from the hot path.

**Option B — In a third binding circuit**
A small `settle_bind.circom` consumes both sets of public signals as its own public inputs and verifies C1-C4. The relayer generates this proof. Adds a third proof, but keeps all verification in ZK.

**Option C — In the taker circuit**
The taker receives the maker's public signals as public inputs to its own circuit and verifies C1-C4 there. Makes taker's circuit bigger but avoids a third proof.

**Recommendation**: Option A for MVP. All four cross-party checks (C1-C4) are integer equalities and inequalities — they're the kind of thing Solidity does for 100s of gas each. Option B/C can be considered later if there's a reason to avoid contract-level arithmetic.

### 3.4 Shared public inputs (binding anchors)

The contract binds the two proofs together by checking equality on the shared trade anchors, while validating each proof's membership root **independently**:

- `commitmentRoot` — the Merkle root used for that proof's membership check. **The maker root and taker root need not be equal**; each is independently validated against `pool.isKnownRoot()` (the existing Tornado-style ring buffer in `IncrementalMerkleTree`). See §2.3 S1 for the full async-root rationale and `settlePrivateSplit` in §6 for the contract-side enforcement.
- `currentTimestamp` — trade timestamp (must match across maker/taker, both within `TIMESTAMP_TOLERANCE` of `block.timestamp`)
- `orderId` — the unique trade identifier derived from the agreed parameters (see §5; must match across maker/taker)
- `tradeBinding` — a Poseidon hash over the negotiated parameters (see §5)

These binding anchors make it possible to verify that the two independent proofs refer to **the same trade** without needing cross-circuit constraint sharing, while still allowing maker and taker to prove against asynchronous tree snapshots.

## 4. New Circuit Design

### 4.1 `maker_order.circom` sketch

```circom
pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/eddsaposeidon.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./node_modules/circomlib/circuits/mux1.circom";
include "./shared/PoseidonMerkleProof.circom";  // extracted from settle.circom
include "./shared/ComputeMerkleRoot.circom";     // extracted from settle.circom

template MakerOrder(commitTreeDepth, maxClaimsPerSide, claimsTreeDepth) {
    // ═══════════════════════════════════════════════════════════
    //  PUBLIC INPUTS (published to the relayer/peer)
    // ═══════════════════════════════════════════════════════════
    signal input commitmentRoot;         // shared anchor
    signal input currentTimestamp;       // shared anchor
    signal input orderId;                // shared anchor (see §5)
    signal input tradeBinding;           // shared anchor (see §5)

    // Maker-side public
    signal input makerNullifier;         // H(makerSecret, makerSalt)
    signal input makerNonceNullifier;    // H(makerSecret, makerNonce)
    signal input makerNewCommitment;     // new UTXO after balance deduction
    signal input claimsRootMaker;        // Merkle root of maker's claims
    signal input totalLockedMaker;       // sum of maker claim amounts
    signal input makerSellToken;         // == tokenTaker (contract checks)
    signal input tokenMaker;             // maker's buy token
    signal input makerSellAmount;        // maker's published sell amount
    signal input makerBuyAmount;         // maker's published buy amount
    signal input feeTokenTaker;          // fee from maker's sellAmount
    signal input makerRelayer;           // bound in proof
    // [REMOVED per D1] makerPubKeyAx / makerPubKeyAy used to be public
    // for self-trade detection. Half-proof keeps the BabyJub pubkey
    // strictly private (witness only) so that no per-trader-stable
    // value leaks into the on-chain trace. See architecture-v2.md §D1.

    // ═══════════════════════════════════════════════════════════
    //  PRIVATE INPUTS (stay in browser)
    // ═══════════════════════════════════════════════════════════
    signal input makerSecret;
    signal input makerPubKeyAx;          // private — used by EdDSA verifier and commitment binding only
    signal input makerPubKeyAy;          // private — never exposed as public output
    signal input makerBalance;
    signal input makerSalt;
    signal input makerPath[commitTreeDepth];
    signal input makerPathIdx[commitTreeDepth];

    signal input makerMaxFee;
    signal input makerExpiry;
    signal input makerNonce;
    signal input makerFee;
    signal input makerNewSalt;

    signal input makerSigS;
    signal input makerSigR8x;
    signal input makerSigR8y;

    signal input makerClaimSecrets[maxClaimsPerSide];
    signal input makerClaimRecipients[maxClaimsPerSide];
    signal input makerClaimTokens[maxClaimsPerSide];
    signal input makerClaimAmounts[maxClaimsPerSide];
    signal input makerClaimReleaseTimes[maxClaimsPerSide];
    signal input makerClaimCount;

    // ═══════════════════════════════════════════════════════════
    //  §1. COMMITMENT MEMBERSHIP (maker)
    // ═══════════════════════════════════════════════════════════
    component makerCommitHash = Poseidon(4);
    makerCommitHash.inputs[0] <== makerSecret;
    makerCommitHash.inputs[1] <== makerSellToken;
    makerCommitHash.inputs[2] <== makerBalance;
    makerCommitHash.inputs[3] <== makerSalt;

    component makerMerkle = PoseidonMerkleProof(commitTreeDepth);
    makerMerkle.leaf <== makerCommitHash.out;
    for (var i = 0; i < commitTreeDepth; i++) {
        makerMerkle.pathElements[i] <== makerPath[i];
        makerMerkle.pathIndices[i] <== makerPathIdx[i];
    }
    commitmentRoot === makerMerkle.root;

    // §3 nullifiers (maker half)
    component makerNullComp = Poseidon(2);
    makerNullComp.inputs[0] <== makerSecret;
    makerNullComp.inputs[1] <== makerSalt;
    makerNullifier === makerNullComp.out;

    component makerNonceNull = Poseidon(2);
    makerNonceNull.inputs[0] <== makerSecret;
    makerNonceNull.inputs[1] <== makerNonce;
    makerNonceNullifier === makerNonceNull.out;

    // §6 expiry (maker half)
    component makerExpiryCheck = LessEqThan(252);
    makerExpiryCheck.in[0] <== currentTimestamp;
    makerExpiryCheck.in[1] <== makerExpiry;
    makerExpiryCheck.out === 1;

    // §7 fee (maker half): feeTokenTaker = floor(makerSellAmount * makerFee / 10000)
    component rcMakerFee = Num2Bits(16);
    rcMakerFee.in <== makerFee;
    component makerFeeRange = LessEqThan(252);
    makerFeeRange.in[0] <== makerFee;
    makerFeeRange.in[1] <== makerMaxFee;
    makerFeeRange.out === 1;

    signal makerFeeProduct;
    makerFeeProduct <== makerSellAmount * makerFee;
    signal feeTokenTakerScaled;
    feeTokenTakerScaled <== feeTokenTaker * 10000;

    component feeTokenTakerLower = LessEqThan(252);
    feeTokenTakerLower.in[0] <== feeTokenTakerScaled;
    feeTokenTakerLower.in[1] <== makerFeeProduct;
    feeTokenTakerLower.out === 1;

    component feeTokenTakerUpper = LessEqThan(252);
    feeTokenTakerUpper.in[0] <== makerFeeProduct;
    feeTokenTakerUpper.in[1] <== feeTokenTakerScaled + 9999;
    feeTokenTakerUpper.out === 1;

    // §8 balance (maker)
    component rcMakerSell = Num2Bits(128);
    rcMakerSell.in <== makerSellAmount;
    component rcMakerBuy = Num2Bits(128);
    rcMakerBuy.in <== makerBuyAmount;

    component makerBalCheck = LessEqThan(252);
    makerBalCheck.in[0] <== makerSellAmount;
    makerBalCheck.in[1] <== makerBalance;
    makerBalCheck.out === 1;

    // §9 claims (maker side) — same structure as current settle.circom
    // ... [full claims logic copied from settle.circom §9 maker portion]

    // §10 new commitment (maker)
    signal makerNewBalance;
    makerNewBalance <== makerBalance - makerSellAmount;

    component makerNewCommitHash = Poseidon(4);
    makerNewCommitHash.inputs[0] <== makerSecret;
    makerNewCommitHash.inputs[1] <== makerSellToken;
    makerNewCommitHash.inputs[2] <== makerNewBalance;
    makerNewCommitHash.inputs[3] <== makerNewSalt;

    component makerNewIsZero = IsZero();
    makerNewIsZero.in <== makerNewBalance;
    signal expectedMakerNew;
    expectedMakerNew <== (1 - makerNewIsZero.out) * makerNewCommitHash.out;
    makerNewCommitment === expectedMakerNew;

    // §11 EdDSA (maker)
    component makerOrderHash = Poseidon(9);
    makerOrderHash.inputs[0] <== makerSellToken;
    makerOrderHash.inputs[1] <== tokenMaker;
    makerOrderHash.inputs[2] <== makerSellAmount;
    makerOrderHash.inputs[3] <== makerBuyAmount;
    makerOrderHash.inputs[4] <== makerMaxFee;
    makerOrderHash.inputs[5] <== makerExpiry;
    makerOrderHash.inputs[6] <== makerNonce;
    makerOrderHash.inputs[7] <== claimsRootMaker;
    makerOrderHash.inputs[8] <== makerRelayer;

    component makerSigVerify = EdDSAPoseidonVerifier();
    makerSigVerify.enabled <== 1;
    makerSigVerify.Ax <== makerPubKeyAx;
    makerSigVerify.Ay <== makerPubKeyAy;
    makerSigVerify.S <== makerSigS;
    makerSigVerify.R8x <== makerSigR8x;
    makerSigVerify.R8y <== makerSigR8y;
    makerSigVerify.M <== makerOrderHash.out;

    // NEW: §X. orderId derivation (see §5.2 of this doc — normative form)
    // Uses makerNonce (recommended in §5.2) so the taker can recompute
    // orderId from gossip without needing the maker's leaf hash.
    component orderIdHash = Poseidon(6);
    orderIdHash.inputs[0] <== makerSellToken;
    orderIdHash.inputs[1] <== tokenMaker;
    orderIdHash.inputs[2] <== makerSellAmount;
    orderIdHash.inputs[3] <== makerBuyAmount;
    orderIdHash.inputs[4] <== makerNonce;
    orderIdHash.inputs[5] <== makerRelayer;
    orderId === orderIdHash.out;

    // NEW: §Y. tradeBinding derivation
    component tradeBindingHash = Poseidon(4);
    tradeBindingHash.inputs[0] <== orderId;
    tradeBindingHash.inputs[1] <== commitmentRoot;
    tradeBindingHash.inputs[2] <== currentTimestamp;
    tradeBindingHash.inputs[3] <== makerRelayer;
    tradeBinding === tradeBindingHash.out;

    // §13 relayer binding
    signal makerRelayerSq;
    makerRelayerSq <== makerRelayer * makerRelayer;
}

component main {public [
    commitmentRoot,
    currentTimestamp,
    orderId,
    tradeBinding,
    makerNullifier,
    makerNonceNullifier,
    makerNewCommitment,
    claimsRootMaker,
    totalLockedMaker,
    makerSellToken,
    tokenMaker,
    makerSellAmount,
    makerBuyAmount,
    feeTokenTaker,
    makerRelayer
    // [D1] makerPubKeyAx / makerPubKeyAy are deliberately NOT exported.
    // The pubkey is bound into the v2 commitment hash (see §1 and
    // architecture-v2.md §"Design decisions / D1"). Exporting it as a
    // public signal would create a per-trader linkability oracle. The
    // pubkey stays private to the prover; merkle membership is the
    // mechanism that prevents pubkey-swap attacks.
]} = MakerOrder(20, 16, 4);
```

**Estimated constraint count**: ~15-17K (roughly half of monolithic 30K, plus ~1K for new binding hash)

### 4.2 `taker_match.circom` sketch

```circom
template TakerMatch(commitTreeDepth, maxClaimsPerSide, claimsTreeDepth) {
    // ═══════════════════════════════════════════════════════════
    //  PUBLIC INPUTS
    // ═══════════════════════════════════════════════════════════
    signal input commitmentRoot;         // shared anchor
    signal input currentTimestamp;       // shared anchor
    signal input orderId;                // shared anchor — matches maker's
    signal input tradeBinding;           // shared anchor — matches maker's

    // Taker-side public
    signal input takerNullifier;
    signal input takerNonceNullifier;
    signal input takerNewCommitment;
    signal input claimsRootTaker;
    signal input totalLockedTaker;
    signal input takerSellToken;         // should == tokenMaker
    signal input tokenTaker;             // taker's buy token
    signal input takerSellAmount;
    signal input takerBuyAmount;
    signal input feeTokenMaker;          // fee from taker's sellAmount
    signal input takerRelayer;
    signal input takerPubKeyAx;
    signal input takerPubKeyAy;

    // Echo of maker's key fields (for contract-side cross-party checks)
    // These are provided by the taker, NOT proven by taker's circuit.
    // The contract verifies they match the maker proof's public signals.
    signal input referencedMakerSellToken;
    signal input referencedTokenMaker;
    signal input referencedMakerSellAmount;
    signal input referencedMakerBuyAmount;
    signal input referencedMakerRelayer;
    signal input referencedMakerPubKeyAx;
    signal input referencedMakerPubKeyAy;

    // ═══════════════════════════════════════════════════════════
    //  PRIVATE INPUTS
    // ═══════════════════════════════════════════════════════════
    signal input takerSecret;
    signal input takerBalance;
    signal input takerSalt;
    signal input takerPath[commitTreeDepth];
    signal input takerPathIdx[commitTreeDepth];

    signal input takerMaxFee;
    signal input takerExpiry;
    signal input takerNonce;
    signal input takerFee;
    signal input takerNewSalt;

    signal input takerSigS;
    signal input takerSigR8x;
    signal input takerSigR8y;

    signal input takerClaimSecrets[maxClaimsPerSide];
    signal input takerClaimRecipients[maxClaimsPerSide];
    signal input takerClaimTokens[maxClaimsPerSide];
    signal input takerClaimAmounts[maxClaimsPerSide];
    signal input takerClaimReleaseTimes[maxClaimsPerSide];
    signal input takerClaimCount;

    // Maker nonce — published by the maker in ORDER_ANNOUNCE gossip so
    // the taker can recompute orderId. Bound here as a referenced public
    // input that the contract cross-checks against the maker proof's
    // makerNonce public output.
    signal input referencedMakerNonce;

    // ═══════════════════════════════════════════════════════════
    //  §1-§11 TAKER HALF (same structure as maker_order.circom)
    // ═══════════════════════════════════════════════════════════
    // ... [taker membership, nullifiers, expiry, fee, balance,
    //      claims, new commitment, signature verification]

    // ═══════════════════════════════════════════════════════════
    //  NEW: orderId must match the referenced maker order — uses the
    //  same Poseidon(6) form as maker_order.circom (see §5.2 normative
    //  derivation: sellToken, buyToken, sellAmount, buyAmount, nonce,
    //  relayer). All six inputs are fields the taker learns from gossip
    //  via ORDER_ANNOUNCE.
    // ═══════════════════════════════════════════════════════════
    component orderIdHash = Poseidon(6);
    orderIdHash.inputs[0] <== referencedMakerSellToken;
    orderIdHash.inputs[1] <== referencedTokenMaker;
    orderIdHash.inputs[2] <== referencedMakerSellAmount;
    orderIdHash.inputs[3] <== referencedMakerBuyAmount;
    orderIdHash.inputs[4] <== referencedMakerNonce;
    orderIdHash.inputs[5] <== referencedMakerRelayer;
    orderId === orderIdHash.out;

    // tradeBinding must match too
    component tradeBindingHash = Poseidon(4);
    tradeBindingHash.inputs[0] <== orderId;
    tradeBindingHash.inputs[1] <== commitmentRoot;
    tradeBindingHash.inputs[2] <== currentTimestamp;
    tradeBindingHash.inputs[3] <== referencedMakerRelayer;
    tradeBinding === tradeBindingHash.out;

    // Relayer binding
    signal takerRelayerSq;
    takerRelayerSq <== takerRelayer * takerRelayer;
}

component main {public [
    commitmentRoot,
    currentTimestamp,
    orderId,
    tradeBinding,
    takerNullifier,
    takerNonceNullifier,
    takerNewCommitment,
    claimsRootTaker,
    totalLockedTaker,
    takerSellToken,
    tokenTaker,
    takerSellAmount,
    takerBuyAmount,
    feeTokenMaker,
    takerRelayer,
    referencedMakerSellToken,
    referencedTokenMaker,
    referencedMakerSellAmount,
    referencedMakerBuyAmount,
    referencedMakerNonce,
    referencedMakerRelayer
    // [D1] takerPubKeyAx / takerPubKeyAy and referencedMakerPubKeyAx /
    // referencedMakerPubKeyAy are deliberately NOT exported. See the
    // matching note on the maker_order.circom main block above.
]} = TakerMatch(20, 16, 4);
```

**Estimated constraint count**: ~15-17K

### 4.3 Optional `settle_bind.circom`

Not needed if Option A (contract-side matching) is chosen. Only considered if we later decide to hide the maker/taker signals from public view — in that case, the contract receives only the binding proof plus a single aggregated commitment, and the binding proof verifies all cross-party checks in ZK.

**Decision for MVP**: skip this. Revisit only if there's a privacy reason to hide public signals.

### 4.4 Shared includes

Extract the generic utilities from `settle.circom` into a shared directory to avoid duplication:

```
circuits/
├── shared/
│   ├── PoseidonMerkleProof.circom     (from settle.circom lines 10-40)
│   ├── ComputeMerkleRoot.circom       (from settle.circom lines 42-87)
│   └── ClaimsValidator.circom         (from settle.circom §9, parameterized)
├── settle.circom                      (legacy, kept during migration)
├── maker_order.circom                 (new)
├── taker_match.circom                 (new)
├── deposit.circom                     (unchanged)
├── claim.circom                       (unchanged)
└── withdraw.circom                    (unchanged)
```

## 5. Public Input Binding

This is the critical section. The whole split hangs on whether two independently-generated proofs can reliably be shown to refer to the same trade.

### 5.1 Binding anchor design

Three layers of binding:

```
Layer 1: orderId
  Uniquely identifies a maker's order.
  Computed from fields the taker can learn from gossip.

Layer 2: tradeBinding
  Uniquely identifies a specific trade instance.
  Bound to orderId + root + timestamp + makerRelayer.

Layer 3: on-chain equality check
  Contract verifies both proofs have identical orderId + tradeBinding
  + other shared public signals.
```

### 5.2 `orderId` derivation

The `orderId` must be:
- **Computable by the maker** from their private witness (so the maker's circuit can output it)
- **Computable by the taker** from the gossiped order announcement (so the taker's circuit can verify it)
- **Unique** across the history of the relayer network (so it's not replayable)
- **Unforgeable** by the taker (so the taker can't fake matching a non-existent order)

**Normative derivation** (this is the form the maker_order.circom and taker_match.circom sketches in §4 implement):

```
orderId = Poseidon(
    makerSellToken,       // public in gossip
    tokenMaker,           // public in gossip (maker's buy token)
    makerSellAmount,      // public in gossip
    makerBuyAmount,       // public in gossip
    makerNonce,           // public in gossip — taker sees it in ORDER_ANNOUNCE
    makerRelayer          // public in gossip
)
```

`makerNonce` is the binding of choice. It is unpredictable to everyone except the maker (so the taker cannot fake a non-existent order), already part of the maker's existing order hash (so it's already part of the maker's signature), and is published in `ORDER_ANNOUNCE` exactly so the taker can recompute `orderId`. The gossip schema in [../relayer-protocol/design.md](../relayer-protocol/design.md) §4.2 carries `makerNonce` in `ORDER_ANNOUNCE` for this purpose.

**Why not the maker leaf commitment?** An earlier draft used `makerLeafCommitHash` as the binding. The leaf hash is also known to the maker privately and appears in the Merkle path, so a similar argument applies. But the leaf hash is **timing-correlated with on-chain deposits**: a chain analyst who sees an `ORDER_ANNOUNCE` carrying a leaf hash, then watches the corresponding deposit on-chain, can correlate the maker's wallet with the order before settlement. The nonce-based form has no such timing leak — the nonce is opaque to anyone outside the maker's circuit. Use the nonce form throughout.

### 5.3 `tradeBinding` derivation

The `tradeBinding` anchors a specific *instance* of a trade (not just the order). This prevents cross-trade confusion if the same order is re-matched later.

```
tradeBinding = Poseidon(
    orderId,
    commitmentRoot,     // state at time of trade
    currentTimestamp,   // block timestamp
    takerNullifier      // ensures a specific taker
)
```

Wait — `takerNullifier` is known only to the taker's circuit. How does the maker's circuit produce the same `tradeBinding`?

**Solution**: two-phase binding.
- Maker's circuit produces `makerSideBinding = Poseidon(orderId, makerCommitmentRoot, currentTimestamp, makerRelayer)`
- Taker's circuit produces `takerSideBinding = Poseidon(orderId, takerCommitmentRoot, currentTimestamp, takerRelayer)`
- Each side hashes its **own** commitment root into its own binding — the roots are not required to match, only to each be present in `pool.isKnownRoot()`
- Both circuits publish their side's binding
- Contract verifies: same `orderId`, same `currentTimestamp`, and `pool.isKnownRoot(makerCommitmentRoot) ∧ pool.isKnownRoot(takerCommitmentRoot)`

There is no single symmetric `tradeBinding`. Instead, binding is enforced by **equality checks in the contract** on the three shared fields.

**Revised design**: drop `tradeBinding` from the circuits. Rely on the contract checking `makerProof.orderId == takerProof.orderId` + other shared field equality.

### 5.4 Nullifier linkability

Current `settle.circom` computes `makerNullifier = Poseidon(makerSecret, makerSalt)`. This is fine — it's revealed only at settlement.

Splitting the proof doesn't change nullifier derivation. Each side computes their own.

**Caveat**: if a maker's proof is leaked to the relayer in Phase 1 (before matching), the nullifier becomes visible early. Is this a problem?

- The nullifier alone doesn't reveal the maker's identity
- It does allow linking multiple orders from the same commitment leaf (before settlement)
- Since each order uses a **fresh nonce**, the nonce nullifier (`Poseidon(secret, nonce)`) is fresh, which prevents cross-order linkability
- The escrow nullifier (`Poseidon(secret, salt)`) is the same across orders from the same leaf, but since a leaf is consumed once, this only matters if the maker submits multiple orders against the same leaf before settlement

**Mitigation**: the maker should use different leaves (or sub-leaves) for concurrent orders. This is a general advice for privacy, not specific to this design.

### 5.5 Taker reference to maker public signals

The taker's circuit needs some of the maker's data to correctly derive `orderId`. These are provided as **public inputs to the taker circuit**, and the contract verifies they match the maker proof's actual public signals.

In the taker circuit's public inputs:
- `referencedMakerSellToken`
- `referencedTokenMaker`
- `referencedMakerSellAmount`
- `referencedMakerBuyAmount`
- `referencedMakerNonce`
- `referencedMakerRelayer`

Contract check:
```solidity
require(makerProof.makerSellToken == takerProof.referencedMakerSellToken, "token mismatch");
require(makerProof.tokenMaker == takerProof.referencedTokenMaker, "token mismatch");
// ... etc
```

If all six match, and both circuits independently derived the same `orderId` from these fields, then the circuits are unambiguously bound to the same trade.

## 6. Contract Updates

### 6.1 New `settlePrivate` function

Add a new function alongside (not replacing) the existing `settlePrivate`. Existing `SettleParams` is kept for backward compatibility during migration.

```solidity
struct MakerProof {
    uint[2] proofA;
    uint[2][2] proofB;
    uint[2] proofC;
    uint256 commitmentRoot;
    uint256 currentTimestamp;
    bytes32 orderId;
    bytes32 makerNullifier;
    bytes32 makerNonceNullifier;
    bytes32 makerNewCommitment;
    bytes32 claimsRootMaker;
    uint96 totalLockedMaker;
    address makerSellToken;
    address tokenMaker;
    uint128 makerSellAmount;  // Circuit enforces ≤ 2^126 − 1 via Num2Bits(126). See docs/circuit-split/bit-width-audit.md §5.
    uint128 makerBuyAmount;   // Circuit enforces ≤ 2^126 − 1 via Num2Bits(126). See docs/circuit-split/bit-width-audit.md §5.
    uint96 feeTokenTaker;
    address makerRelayer;
    uint256 makerNonce;       // matched against TakerProof.refMakerNonce; bound into orderId
    // [D1] makerPubKeyAx / makerPubKeyAy intentionally NOT in this struct.
    // The Half-proof never exposes maker pubkey as a public output (see
    // §4.1 main block note and architecture-v2.md §"Design decisions / D1").
}

struct TakerProof {
    uint[2] proofA;
    uint[2][2] proofB;
    uint[2] proofC;
    uint256 commitmentRoot;          // independent — may differ from MakerProof.commitmentRoot, must each be in isKnownRoot()
    uint256 currentTimestamp;        // must equal MakerProof.currentTimestamp
    bytes32 orderId;                 // must equal MakerProof.orderId
    bytes32 takerNullifier;
    bytes32 takerNonceNullifier;
    bytes32 takerNewCommitment;
    bytes32 claimsRootTaker;
    uint96 totalLockedTaker;
    address takerSellToken;
    address tokenTaker;
    uint128 takerSellAmount;  // Circuit enforces ≤ 2^126 − 1 via Num2Bits(126). See docs/circuit-split/bit-width-audit.md §5.
    uint128 takerBuyAmount;   // Circuit enforces ≤ 2^126 − 1 via Num2Bits(126). See docs/circuit-split/bit-width-audit.md §5.
    uint96 feeTokenMaker;
    address takerRelayer;
    // References to maker side (for contract-level cross-party check)
    address refMakerSellToken;
    address refTokenMaker;
    uint128 refMakerSellAmount;
    uint128 refMakerBuyAmount;
    uint256 refMakerNonce;           // must equal MakerProof.makerNonce
    address refMakerRelayer;
    // [D1] takerPubKey* / refMakerPubKey* intentionally NOT in this struct.
}

function settlePrivateSplit(
    MakerProof calldata m,
    TakerProof calldata t
) external nonReentrant {
    // Caller must be one of the two relayers
    if (msg.sender != m.makerRelayer && msg.sender != t.takerRelayer)
        revert NotMakerOrTakerRelayer();
    if (paused) revert ContractPaused();

    // ─── Shared anchors must match ──────────────────────────
    // NOTE: commitmentRoot is intentionally NOT compared for equality.
    // Each side's root is independently validated against the rolling
    // history below (`pool.isKnownRoot`). Forcing equality would couple
    // both proofs to the same tree snapshot and collapse the matching
    // window in any active pool — breaking the asynchronous matching
    // model. Double-spend safety comes from the nullifiers, not from
    // root equality. Same pattern as Tornado Cash / Railgun / Semaphore.
    if (m.currentTimestamp != t.currentTimestamp) revert TimestampMismatch();
    if (m.orderId != t.orderId) revert OrderIdMismatch();

    // ─── Taker's maker-reference must match maker's public signals ──
    if (t.refMakerSellToken != m.makerSellToken) revert RefMismatch();
    if (t.refTokenMaker != m.tokenMaker) revert RefMismatch();
    if (t.refMakerSellAmount != m.makerSellAmount) revert RefMismatch();
    if (t.refMakerBuyAmount != m.makerBuyAmount) revert RefMismatch();
    if (t.refMakerNonce != m.makerNonce) revert RefMismatch();
    if (t.refMakerRelayer != m.makerRelayer) revert RefMismatch();
    // [REMOVED per D1] refMakerPubKeyAx / refMakerPubKeyAy reference checks
    // are gone — Half-proof never exposes maker pubkey as a public output.

    // ─── Cross-party check C1: token compatibility ──────────
    if (m.makerSellToken != t.tokenTaker) revert TokenMismatch();
    if (t.takerSellToken != m.tokenMaker) revert TokenMismatch();
    if (!whitelistedTokens[m.makerSellToken]) revert TokenNotWhitelisted();
    if (!whitelistedTokens[t.takerSellToken]) revert TokenNotWhitelisted();

    // ─── Cross-party check C2: price compatibility ──────────
    uint256 makerProduct = uint256(m.makerSellAmount) * uint256(t.takerSellAmount);
    uint256 takerProduct = uint256(m.makerBuyAmount) * uint256(t.takerBuyAmount);
    if (takerProduct > makerProduct) revert PriceMismatch();

    // ─── Cross-party check C3: minimum receive ──────────────
    if (uint256(m.makerBuyAmount) > uint256(m.totalLockedMaker)) revert InsufficientMakerReceive();
    if (uint256(t.takerBuyAmount) > uint256(t.totalLockedTaker)) revert InsufficientTakerReceive();

    // ─── Cross-party check C4: claims + fees cap ────────────
    if (uint256(m.totalLockedMaker) + uint256(m.feeTokenTaker) > uint256(t.takerSellAmount))
        revert ClaimsCapExceeded();
    if (uint256(t.totalLockedTaker) + uint256(t.feeTokenMaker) > uint256(m.makerSellAmount))
        revert ClaimsCapExceeded();

    // [REMOVED per D1] No C5 self-trade prevention. The check used to be:
    //   if (m.makerPubKeyAx == t.takerPubKeyAx && m.makerPubKeyAy == t.takerPubKeyAy)
    //       revert SelfTrade();
    // It is intentionally absent in Half-proof. See architecture-v2.md §"Design decisions / D1".

    // ─── Timestamp tolerance (reuse existing) ───────────────
    if (
        m.currentTimestamp > block.timestamp + TIMESTAMP_TOLERANCE ||
        m.currentTimestamp + TIMESTAMP_TOLERANCE < block.timestamp
    ) revert TimestampOutOfRange();

    // ─── Nullifier double-spend check (existing) ────────────
    if (nullifiers[m.makerNullifier]) revert NullifierAlreadySpent();
    if (nullifiers[t.takerNullifier]) revert NullifierAlreadySpent();
    if (nonceNullifiers[m.makerNonceNullifier]) revert NullifierAlreadySpent();
    if (nonceNullifiers[t.takerNonceNullifier]) revert NullifierAlreadySpent();

    // ─── Root recency (per side) ────────────────────────────
    // Each side's commitmentRoot must individually be a known historical
    // root in the IncrementalMerkleTree ring buffer. The two roots are
    // NOT required to be equal — see the note at the top of this function.
    if (!pool.isKnownRoot(m.commitmentRoot)) revert UnknownRoot();
    if (!pool.isKnownRoot(t.commitmentRoot)) revert UnknownRoot();

    // ─── Verify both proofs ─────────────────────────────────
    if (!makerVerifier.verifyProof(m.proofA, m.proofB, m.proofC, _packMakerPubSignals(m)))
        revert InvalidProof();
    if (!takerVerifier.verifyProof(t.proofA, t.proofB, t.proofC, _packTakerPubSignals(t)))
        revert InvalidProof();

    // ─── Relayer registry check (existing) ──────────────────
    if (address(relayerRegistry) != address(0)) {
        if (!relayerRegistry.isActiveRelayer(m.makerRelayer)) revert NotActiveRelayer();
        if (!relayerRegistry.isActiveRelayer(t.takerRelayer)) revert NotActiveRelayer();
    }

    // ─── Apply state changes (same as existing settlePrivate) ──
    nullifiers[m.makerNullifier] = true;
    nullifiers[t.takerNullifier] = true;
    nonceNullifiers[m.makerNonceNullifier] = true;
    nonceNullifiers[t.takerNonceNullifier] = true;

    if (m.makerNewCommitment != bytes32(0))
        pool.insertCommitment(uint256(m.makerNewCommitment));
    if (t.takerNewCommitment != bytes32(0))
        pool.insertCommitment(uint256(t.takerNewCommitment));

    // Fee routing via FeeVault + claims group creation unchanged from existing settlePrivate

    emit PrivateSettledSplit(
        m.makerNullifier,
        t.takerNullifier,
        m.orderId,
        m.makerRelayer,
        t.takerRelayer,
        m.feeTokenTaker,
        t.feeTokenMaker
    );
}
```

### 6.2 New errors
```solidity
// [REMOVED — see §2.3 S1 / settlePrivateSplit shared-anchor block]
// error RootMismatch();
//   The two sides' commitmentRoots are intentionally allowed to differ.
//   Per-side validation goes through `pool.isKnownRoot(...)` → UnknownRoot.
error TimestampMismatch();
error OrderIdMismatch();
error RefMismatch();
error PriceMismatch();
error InsufficientMakerReceive();
error InsufficientTakerReceive();
error ClaimsCapExceeded();
// [REMOVED per D1] error SelfTrade(); — see architecture-v2.md §"Design decisions"
```

### 6.3 New verifiers

Two new verifier contracts generated from `maker_order.circom` and `taker_match.circom`:

- `IMakerOrderVerifier` — interface matching the public signals of `maker_order.circom`
- `ITakerMatchVerifier` — interface matching `taker_match.circom`

These replace the single `ISettleVerifier` for the new function. The legacy `ISettleVerifier` remains for the existing `settlePrivate` during the migration window.

### 6.4 Gas cost estimate

| Component | Gas |
|---|---|
| Existing `settlePrivate` (single proof) | ~1,600k |
| New `settlePrivateSplit` (two proofs) | ~2,200k (estimated) |
| ↳ maker Groth16 verify | ~230k |
| ↳ taker Groth16 verify | ~230k |
| ↳ cross-party arithmetic checks | ~15k |
| ↳ state updates (same as legacy) | ~500k |
| ↳ fee routing (same) | ~250k |
| ↳ commitment inserts (same) | ~800k |
| ↳ calldata overhead (more signals) | ~50-100k |

**Net increase**: ~600k gas per settlement. On mainnet at 10-30 Gwei, this is $0.20-$0.60 extra per trade — acceptable given the privacy gain.

**Optimization opportunity**: Groth16 batch verification with pairing optimization can amortize the cost of two verifications. Consider after MVP.

### 6.5 Phase 3.6 fee binding compatibility

The existing trustless fee split (Phase 3.6) is preserved without change:
- `makerRelayer` is bound in the maker proof's EdDSA signature and in the maker's public inputs
- `takerRelayer` is bound in the taker proof's EdDSA signature and in the taker's public inputs
- `feeTokenTaker` (fee taken from maker's sell) goes to `makerRelayer`
- `feeTokenMaker` (fee taken from taker's sell) goes to `takerRelayer`
- Neither relayer can redirect the other's fee because they're bound in the counterparty's signature

No changes to `FeeVault.sol` are required.

## 7. Browser Proving Benchmarks

### 7.1 Target performance

| Metric | Current (monolithic) | Target (split, maker) | Target (split, taker) |
|---|---|---|---|
| Constraint count | ~30K | ~15-17K | ~15-17K |
| Witness generation (C++ WASM) | ~400 ms | ~200 ms | ~200 ms |
| Proving (`rapidsnark-wasm`, 4 cores, SIMD) | ~3-5 s | ~1-2 s | ~1-2 s |
| Memory peak | ~500 MB | ~250 MB | ~250 MB |
| `.zkey` size | ~20 MB | ~10-12 MB | ~10-12 MB |

### 7.2 Measurement methodology

1. **Baseline**: measure current `settle.circom` proving on a mid-tier laptop (Apple M1 / 16GB RAM / Chrome)
2. **Split measurement**: prove `maker_order.circom` and `taker_match.circom` independently on the same hardware
3. **Success criterion**: each split proof ≤ 2 s in typical user conditions
4. **Stretch goal**: ≤ 1 s via WebGPU MSM acceleration (post-MVP)

### 7.3 Required toolchain

- `rapidsnark-wasm` (rapidsnark compiled to WASM via Emscripten with SIMD + pthreads)
- `circom-witnesscalc` (Rust-based witness generator, faster than circom's default WASM)
- Web Workers for proving (avoid blocking the UI thread)
- `SharedArrayBuffer` + `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` for multithreading

### 7.4 Pre-proving strategy

Users can start proving **before** the trade is matched:

- **Maker**: generates the proof as soon as the order is signed. Stores it encrypted in IndexedDB. When matched, just reveals.
- **Taker**: proving is triggered when the user selects a maker order to match. This is latency-sensitive; target ≤ 2 s total from click to reveal.

This means maker proving is **never on the user's critical path** — the proof is ready before the user even sees the matched offer.

### 7.5 Memory constraints

For mobile browsers, memory pressure matters:
- `rapidsnark-wasm` with a 15K circuit should fit in ~250 MB RAM
- iOS Safari has stricter limits (~200 MB before OOM)
- Fallback: server-side proving service for mobile users who opt in (trade-off: loses the privacy benefit but regains UX)

## 8. Partial Fill Handling

### 8.1 MVP approach: order splitting

The simplest approach — the maker posts multiple orders at different sizes, each independently provable:

```
Maker wants to sell 100 WETH at 2000 USDC each.
Instead of 1 order(100 WETH), post 10 orders of 10 WETH each.
Each order has its own nonce, its own proof, its own leaf.
```

**Pros**:
- No circuit changes needed
- Each fill is a complete standalone trade
- Aligns with the "each order = one leaf consumption" model

**Cons**:
- More proofs to generate (each 10 WETH order is a full ~15K proof)
- Higher gas (each settlement is a full `settlePrivateSplit` call)
- Poor UX if the user wants to fill large orders quickly

### 8.2 Post-MVP: Nova folding for accumulated fills

If partial fills become a bottleneck, use a folding scheme to amortize the cost:

```
maker_order.circom runs once per (order, fill) pair:
  state_n = fold(state_{n-1}, fill_n)

After N fills:
  A single Groth16 wrap compresses state_N
  Submit one on-chain settlement covering all N fills
```

This is the Nova / HyperNova / ProtoStar model. **Deferred to Phase 2+** of the split rollout. See [../relayer-protocol/design.md](../relayer-protocol/design.md) OQ for folding opportunities.

## 9. Cancel and Expiry Handling

### 9.1 Order cancellation

**Problem**: a maker wants to cancel an order before it's matched. Under the current `settle.circom` architecture, this is implicit — the maker simply doesn't submit the order for settlement.

Under the split architecture, the order is gossiped to the federation, so cancellation needs to be explicit.

**Protocol**:
1. Maker's client sends `ORDER_CANCEL` gossip (see [../relayer-protocol/design.md](../relayer-protocol/design.md) §4.2)
2. Cancellation must be signed by the maker's relayer (proof that the cancel is authorized)
3. Other relayers remove the order from their local inventory
4. If the order is already in a `COMMITTED` state with a peer, cancellation is **not allowed** — the commit-reveal must complete or time out

**No circuit change needed** — cancellation is purely a gossip layer concern.

### 9.2 Nullifier timing

A subtle point: does cancelling an order burn the nullifier?

**Current `settle.circom`**: no, because the nullifier is only revealed at settlement, and a cancelled order never settles.

**Split architecture**: same, because the maker's proof is only revealed to the peer during commit-reveal. Before that, the proof lives in the maker's IndexedDB and the nullifier hasn't been published.

**Caveat**: once the maker reveals the proof during the commit-reveal phase, the nullifier is known to the counterparty (and eventually the chain). If the trade then aborts, the nullifier is still usable (the chain hasn't marked it spent). But the maker must now be careful not to generate a new proof for the same leaf + same nonce, because that would fail `NullifierAlreadySpent`.

**Best practice**: maker uses a fresh nonce for any new order against the same leaf. This is already the case in `settle.circom` — the order hash includes `makerNonce`.

### 9.3 Expiry-based auto-refund

The maker's proof includes `makerExpiry`. If the proof isn't consumed by `settlePrivate` before expiry, the on-chain state is unchanged and the maker can create a new order against the same leaf using a fresh nonce.

**Relayer behavior**: relayers automatically remove expired orders from their inventory. `ORDER_ANNOUNCE.expiry` is compared against the relayer's local clock.

**No refund is needed** because no fund movement happens until settlement. The "refund" is just the absence of a state change.

### 9.4 Fee escrow during pending match

If the maker or taker prepays fees to a relayer, what happens on cancel/expiry?

**Current model** (from [../design-shared-orderbook.md](../design-shared-orderbook.md)): fees are collected from the trade itself at settlement. No prepayment.

**Split architecture**: same. Fees remain part of the settle proof's public signals. Cancellation = no settlement = no fee transfer.

## 10. Migration Strategy

### 10.1 Phase A — parallel deployment

Deploy alongside existing `settle.circom` without touching the legacy path:

1. Create new `maker_order.circom` and `taker_match.circom` in `circuits/`
2. Extract shared components to `circuits/shared/`
3. Compile new circuits and generate new `.zkey` + verifier contracts
4. Deploy new verifiers (separate addresses)
5. Add `settlePrivateSplit` to `PrivateSettlement.sol` alongside existing `settlePrivate`
6. Both paths are active; relayers can choose which to use
7. Feature flag: `PRIVATE_SETTLE_USE_SPLIT = false` in relayer config

**Validation gate**:
- New circuits produce proofs that verify
- Gas cost of new path is within estimate
- Existing path still works (no regression)

### 10.2 Phase B — frontend and relayer migration

Enable the new path for real users:

1. Frontend: update browser proving to use new circuits
   - Load `maker_order.wasm` + `maker_order.zkey` for maker side
   - Load `taker_match.wasm` + `taker_match.zkey` for taker side
2. Relayer: handle incoming split proofs; call `settlePrivateSplit`
3. Feature flag: gradually flip to `true` per user opt-in, then per relayer default
4. Monitoring: compare gas usage, proof generation time, failure rates across paths

**Validation gate**:
- Split path proof generation ≤ 2s p95 in browser
- Cross-relayer matching works end-to-end with split proofs
- Dispute registry can record disputes against split-protocol relayers (requires [../dispute-registry/design.md](../dispute-registry/design.md) deployment first)

### 10.3 Phase C — legacy deprecation

Remove the old path:

1. Mark `settlePrivate` as deprecated in comments
2. Announce deprecation timeline to relayer operators (e.g., 60 days)
3. Stop generating new `.zkey` files for legacy circuit
4. Remove legacy path from new relayer deployments
5. Monitor on-chain usage of legacy `settlePrivate`; when < 1% of volume, deploy a new `PrivateSettlement` that reverts on the legacy path
6. Old circuit and verifier remain in git history for reference

### 10.4 Rollback plan

If a critical bug is found in the split circuits:
- Relayers flip `PRIVATE_SETTLE_USE_SPLIT` back to `false`
- All traffic reverts to the legacy circuit
- Fix the bug, re-audit, re-ceremony (if applicable)
- Resume rollout

**Ceremony note**: the new circuits will need a new trusted setup (Groth16). Coordinate with the existing ceremony process. Alternative: evaluate whether switching to Plonkish at the same time is worth the larger refactor.

## 11. Test Vectors and E2E Scenarios

### 11.1 Circuit unit tests (`circuits/test/`)

For each new circuit:

- **Positive test**: valid witness produces valid proof
- **Negative tests** (per assertion):
  - Wrong `commitmentRoot` → constraint violation
  - Wrong `nullifier` → constraint violation
  - Wrong signature → EdDSA verify fails
  - Wrong `orderId` derivation → binding check fails
  - Expired order → expiry check fails
  - Insufficient balance → balance check fails
  - Fee exceeds max → fee check fails
  - Malformed claims → claims root check fails
  - New balance underflow → range check fails

### 11.2 Contract unit tests (`contracts/test/`)

For `settleAuth`:

- **Positive**: valid maker + taker proofs → settlement succeeds
- **Mismatch tests**:
  - Different `orderId` between proofs → `OrderIdMismatch`
  - Different `currentTimestamp` → `TimestampMismatch`
- **Async-root invariant tests (positive)** — these lock in the S1 decision (see §2.3) so a self-trade-style equality check cannot regress in:
  - Maker and taker commitmentRoots are different but **both in `isKnownRoot()`** → settlement **succeeds**
  - Roots taken from any two valid positions in the ring buffer (e.g., `currentRootIndex - 0` and `currentRootIndex - (ROOT_HISTORY_SIZE - 1)`) → settlement **succeeds**
- **Cross-party tests**:
  - Incompatible tokens → `TokenMismatch`
  - Incompatible prices → `PriceMismatch`
  - Under-collateralized maker claims → `InsufficientMakerReceive`
- **D1 invariant test (positive)**: same-party trade (same EdDSA key on both sides) → settlement **succeeds** (intentional — see architecture-v2.md §"Design decisions / D1"). The test exists to lock in the decision and catch accidental re-introduction of a self-trade check.
- **Replay tests**:
  - Re-use spent nullifier → `NullifierAlreadySpent`
  - Maker side stale (root not in ring buffer) → `UnknownRoot`
  - Taker side stale (root not in ring buffer) → `UnknownRoot`
  - Both sides stale → `UnknownRoot`
- **Unauthorized caller**: caller != makerRelayer && != takerRelayer → `NotMakerOrTakerRelayer`

### 11.3 End-to-end scenarios (`zk-relayer/test/`)

Integration tests covering the full Waku → circuit → contract path:

**E2E-1**: Happy path — same relayer
- User A and User B both use Relayer X
- A submits maker proof, B submits taker proof
- Relayer X matches locally, calls `settlePrivateSplit`
- Assertion: `PrivateSettledSplit` event emitted with expected values

**E2E-2**: Happy path — cross-relayer
- User A on Relayer X, User B on Relayer Y
- Both relayers gossip orders via Waku
- Deterministic sharding picks Relayer X as primary
- Commit-reveal exchange between X and Y
- X calls `settlePrivateSplit`
- Assertion: both user balances updated correctly

**E2E-3**: Partial fill via order splitting
- Maker posts 10 × 10 WETH orders
- Taker fills 5 of them
- Assertion: 5 independent settlements, 5 leaves consumed

**E2E-4**: Cancellation before match
- Maker submits order
- Before any match, maker sends `ORDER_CANCEL`
- Assertion: no on-chain state change; nullifier not consumed

**E2E-5**: Expiry without match
- Maker submits order with short expiry (e.g., 10 s)
- No taker matches
- Assertion: order auto-removed from gossip; no on-chain state change

**E2E-6**: Abort during commit-reveal
- Relayer X commits to Relayer Y's maker order
- Relayer X fails to reveal
- Y records dispute via `DisputeRegistry.recordAbort` (record-only — no slash, no reward; reputation impact only)
- Assertion: dispute is permanently recorded with the corresponding event emitted; X's reputation accumulates the AbortAfterCommit record. No bond movement, no reward transfer — see [../dispute-registry/design.md](../dispute-registry/design.md) §"Why reputation works better than slashing here" for the rationale.

**E2E-7**: Browser proving benchmark
- Automated Playwright test running browser proof generation
- Measure: time, memory, proof size
- Assertion: within targets from §7.1

### 11.4 Test vector fixtures

For reproducibility, generate and commit test vectors:

```
circuits/test/fixtures/
  maker_order_valid.json       — canonical valid input
  taker_match_valid.json       — matching taker input
  settle_split_expected.json   — expected public signals + proof
```

These vectors are used for:
- Circuit regression tests
- Contract ABI validation
- Cross-language verification (e.g., Rust verifier tests)

## 12. Open Questions

### OQ-1: orderId derivation — nonce vs. leaf hash
§5.2 proposes using `makerNonce` as the binding field in `orderId`. Alternative: `makerLeafCommitHash`. Nonce is simpler but requires publishing it in `ORDER_ANNOUNCE` (minor linkability). Leaf hash is already implicit in the Merkle proof. **Decision needed**: probably nonce for simplicity. Revisit if privacy analysis shows nonce linkability matters.

### OQ-2: Contract-side vs. circuit-side cross-party checks
§3.3 recommends Option A (contract-side). The alternative (Option C: include cross-party checks in one of the circuits) would hide cross-party arithmetic from public view but add ~3-5K constraints to one circuit. **Decision needed**: keep Option A unless there's a privacy reason to hide the public signals.

### OQ-3: Should we compile the new circuits as Plonkish instead of Groth16?
This is a larger decision. Plonkish (Halo2) removes the trusted setup but has ~3-5× higher prover cost. Groth16 keeps trusted setup pain but is fastest. **Decision**: stay Groth16 for MVP; consider Plonkish migration as a separate project.

### OQ-4: How to handle the trusted setup ceremony for new circuits?
New circuits require a new Groth16 powers-of-tau ceremony. Options:
- Reuse existing ptau files if the new circuits fit within their size
- Run a new ceremony (expensive, high-profile)
- Defer to post-MVP and use a single-party setup for testing only

### OQ-5: Should `tradeBinding` be a single symmetric hash?
§5.3 discards the symmetric `tradeBinding` in favor of three separate equality checks. This is simpler but has 3 potential failure points instead of 1. **Decision**: keep the three-field check; the contract handles it cleanly.

### OQ-6: How to handle the `referencedMakerLeafCommit` leak?
§5.2 notes that publishing the maker's leaf hash has linkability implications. Using `makerNonce` avoids this but puts the binding field into the gossip layer. **Decision**: prefer nonce-based binding.

### OQ-7: Should the two new verifier contracts be merged into one?
One contract with both `verifyMaker()` and `verifyTaker()` functions vs. two separate contracts. Merging saves one deployment but creates a bigger contract. **Decision**: two separate contracts, matching the circuit file structure. Trivially deployable.

### OQ-8: Memory profiling for iOS Safari
§7.5 notes that mobile Safari has tight memory limits. **Decision needed**: actual profile must be run on real devices before committing to the target. If unfeasible, the mobile fallback (server-side proving) must be specified.

### OQ-9: Interaction with `IdentityGate` and zk-X509
Does the `IdentityGate` check happen at order submission, matching, or settlement? Currently the relayer gate checks at registration. The split architecture doesn't change this, but it's worth verifying the user identity check still fires at the right point. **Action**: read `IdentityGate.sol` interaction with the new flow.

### OQ-10: Relationship with Nova folding (future)
§8.2 hints at Nova for partial fills. The split circuits should be designed to be **foldable later** — i.e., the maker circuit should be expressible as a "state transition" function over a state that accumulates fills. This may affect how some intermediate values are structured. **Decision deferred**: MVP doesn't use folding, but keep the code structure folding-friendly (small, composable, stateless helpers).

## 13. References

### Internal
- [../../circuits/settle.circom](../../circuits/settle.circom) — current monolithic circuit (line numbers referenced throughout this doc)
- [../../circuits/deposit.circom](../../circuits/deposit.circom) — CommitmentPool insertion (unchanged)
- [../../circuits/withdraw.circom](../../circuits/withdraw.circom) — existing leaf consumption pattern (reference)
- [../../circuits/claim.circom](../../circuits/claim.circom) — claim proof (unchanged)
- [../../contracts/src/zk/PrivateSettlement.sol](../../contracts/src/zk/PrivateSettlement.sol) — current settlement (Phase 3.6 fee binding preserved)
- [../relayer-protocol/design.md](../relayer-protocol/design.md) — Waku protocol that transports the split proofs
- [../dispute-registry/design.md](../dispute-registry/design.md) — dispute registry that records misbehavior in the split-protocol commit-reveal layer
- [../relayer-security.md](../relayer-security.md) — threat model (sections §1-§3 become obsolete after this split)
- [../PAPER.md](../PAPER.md) — overall zkScatter architecture
- [../gas-cost-analysis.md](../gas-cost-analysis.md) — gas baseline for comparison

### External
- **rapidsnark-wasm**: fastest browser-capable Groth16 prover (https://github.com/iden3/rapidsnark)
- **circomlib**: Poseidon, EdDSA, comparators used by existing circuits
- **Nova**: folding scheme for IVC (https://github.com/microsoft/Nova)
- **Sonobe**: Circom-friendly folding framework (future reference)

---

*This document is a design reference. The actual circuit implementation must match this spec's public signal layout exactly, because the dispute resolver and relayer protocol both depend on signal positions. Any change here is a breaking protocol change.*
