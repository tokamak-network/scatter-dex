# ADR-001: zkScatter does not detect self-trade on-chain

> **Status**: Accepted (2026-04-10)
> **Decision date**: 2026-04-08 (during the Half-proof / `authorize.circom` design)
> **Author**: zkScatter team
> **Supersedes**: the earlier `settle.circom` design that exposed `pubKeyHash` as a public output and enforced `makerPubKeyHash != takerPubKeyHash` on-chain
> **Related docs**:
> - [../architecture-v2.md](../architecture-v2.md) §"Design decisions / D1" — the in-place rationale this ADR formalises
> - [../../design/circuit-split/design.md](../../design/circuit-split/design.md) §2.2 (C5 removed) — the design that landed the change
> - [../../../circuits/authorize.circom](../../../circuits/authorize.circom) — the realised primitive (see header comment, "issue #128 design correction")
> - [../../../developers/docs/whitepaper.mdx](../../../developers/docs/whitepaper.mdx) — the spec-level commitment (supersedes the removed PAPER.md §6 "Privacy Guarantees" / §8 "Compliance Model")
> - [../../design/relayer-protocol/design.md](../../design/relayer-protocol/design.md) §10.3 — the relayer-side threat alignment
> - [../../design/dispute-registry/design.md](../../design/dispute-registry/design.md) — the off-chain accountability layer that handles regulator-facing wash-trade questions

## Context

A "self-trade" is when the same trader is both the maker and the taker of a settled trade. CEX matching engines typically have logic to detect and either reject or ignore such trades (e.g. STP — Self-Trade Prevention). The natural question for any DEX is whether to mirror that behaviour on-chain.

zkScatter's earlier `settle.circom` did. It exposed a public signal `pubKeyHash = Poseidon(pubKeyAx, pubKeyAy)` for each side, and the on-chain settlement contract enforced `makerPubKeyHash != takerPubKeyHash`. The intent was twofold:

1. **Self-trade rejection** — refuse the trade if both sides come from the same EdDSA key.
2. **Defence-in-depth against pubkey-swap attacks** — give the contract a separate hash to compare so a swapped pubkey produces a visible mismatch.

When we redesigned the prover model into the **Half-proof primitive** (`authorize.circom` — each user proves their own side independently in the browser), both justifications fell apart on closer inspection. This ADR records why we removed the check and why no future change should re-introduce it without explicit replacement of the privacy property it would break.

## Decision

**zkScatter does not detect, prevent, or report self-trade at the protocol layer.**

> **Naming note:** `PrivateSettlement.settleAuth(...)` is the **Half-proof entrypoint** added in PR #133 and is now the sole ZK-settlement path on the contract — the legacy monolithic `settlePrivate(...)` function and `circuits/settle.circom` have since been removed. This ADR's commitment that "no self-trade detection" is realised by `circuits/authorize.circom` + `settleAuth(...)`. Future references to "the half-proof flow" or just "`settleAuth`" mean the post-#133 entrypoint specifically.

Concretely, this means:

1. **`circuits/authorize.circom` exposes no per-trader-stable public output.** The 15 public signals are: `pubKeyBind` (added post-ADR — `Poseidon(pubKeyAx, pubKeyAy, nullifier)`, per-trade unique so it preserves this invariant; see [ADR-002](002-pubkeybind-privacy-tradeoff.md)), `commitmentRoot`, `nullifier`, `nonceNullifier`, `newCommitment`, `sellToken`, `buyToken`, `sellAmount`, `buyAmount`, `maxFee`, `expiry`, `claimsRoot`, `totalLocked`, `relayer`, `orderHash`. None of these are tied to a specific trader identity across trades. Nullifiers are one-time use and unlinkable; the rest are trade parameters.
2. **`PrivateSettlement.settleAuth(...)` does not compare pubkeys.** It does not even know the pubkeys — they are private inputs to each `authorize.circom` proof. The only cross-side checks are token compatibility, price compatibility, and the claims+fees cap. There is no `MakerTakerSameKey` revert. (The legacy `settlePrivate(...)` entrypoint — which previously carried the same commitment after PR #129 removed `pubKeyHash` — has since been removed entirely, so `settleAuth` is the only ZK-settlement path.)
3. **The relayer is allowed to match a trader against themselves.** If the matching engine surfaces such a pairing, the protocol will settle it. The relayer's off-chain matching logic may filter self-matches at its own discretion (it has the user identity locally), but the protocol does not require it to.
4. **Compliance / wash-trading concerns are handled at the dual-CA layer**, not at the protocol layer. See §"Wash-trading is a compliance question, not a settlement question" below for the rationale.

## Rationale

Five reasons, in increasing order of how load-bearing they are.

### 1. There is no incentive to self-trade

zkScatter uses **static fees with no rebates**. The settlement transaction's gas is paid by the submitting relayer (`msg.sender` of `settleAuth`), and both legs pay the relayer fee bound in their `orderHash` — those fees are what economically compensate the relayer for the gas they spend submitting settlement. A trader who self-trades:

- Pays the relayer fee twice (once on each leg), which means **double** the fee burden of a normal trade.
- Causes the relayer to submit `settleAuth` and charge fees that cover the settlement gas, so the combined relayer-fee outflow includes the full settlement gas cost.
- Must use **two distinct escrow commitments** to settle successfully (PR #133 added an intra-transaction check that reverts if both sides share the same escrow nullifier, so the "spend the same commitment twice" path is not even available). A self-trade therefore consumes two escrow nullifiers and two nonce nullifiers — twice the on-chain state per "trade" — even though no economic transfer happens between distinct parties.
- Achieves nothing they could not have achieved with a `withdraw` to themselves at lower cost.

There is no market-making rebate, no fee discount, no rewards programme that would convert self-trading into a rational strategy. A rational trader who looks at the fee schedule and the per-leg cost being passed through via relayer fees will simply not do this. There is nothing for the protocol to defend against.

### 2. Accidental self-trade is structurally impossible (or near it)

In a CEX, a trader can accidentally cross their own resting orders because the matching engine sweeps the entire orderbook on every incoming order. A trader who has a buy at $100 and submits a sell at $99 will accidentally fill against themselves.

zkScatter's matching is different in two ways that close this off:

- **Each `authorize.circom` proof is bound to a specific trade** via the `orderHash` public output, which is the **Poseidon hash** of `(sellToken, buyToken, sellAmount, buyAmount, maxFee, expiry, nonce, claimsRoot, relayer)`, and the proof verifies an **EdDSA signature over that hash** inside the circuit. The trader has to *explicitly sign* each side of the trade with their EdDSA private key. Accidentally signing two opposing orders requires either malicious client software or extreme user error.
- **The relayer's off-chain matching engine has the trader's identity locally** (it generated or routed both proofs) and can trivially filter same-identity matches before constructing the `settleAuth` call. If a federation of cooperating relayers wants to filter self-matches, they can — it's an off-chain policy decision, not a protocol-layer enforcement.

The "I crossed my own order by mistake" failure mode that motivates STP on a CEX does not naturally occur on zkScatter. If it did occur (e.g. via a buggy client), the trader would notice on the very next trade and the cost is small (one round of fees + gas), not catastrophic.

### 3. Fund integrity is already cryptographically guaranteed

The single hardest constraint a settlement protocol must enforce is that **funds cannot be created or duplicated**. zkScatter enforces this via the four-nullifier model (`escrow_nullifier` and `nonce_nullifier` for each side, all 4 marked atomically in `settleAuth`). The double-spend impossibility holds **regardless of who is on the other side**:

- A self-trader who tries to use the same commitment on both sides will produce two `authorize.circom` proofs sharing the same escrow nullifier. PR #133 added an explicit intra-transaction check (`if (m.nullifier == t.nullifier) revert NullifierAlreadySpent;`) that catches this in `settleAuth(...)` before any state change, so the contract reverts. (Without that check, the per-mapping `nullifiers[...]` lookups would each see "not yet spent" and the contract would have drained `2 × totalLocked` from the pool — see the gemini security review on PR #133.)
- A self-trader who uses two different commitments will spend both legitimately, but the resulting "trade" is just a value-preserving rearrangement of their own UTXOs — funds are conserved by construction. Both `escrow_nullifier`s are marked, both new commitments are inserted, and the trader has paid two relayer fees for what is economically a no-op.

There is no fund-integrity argument for self-trade prevention. The nullifier check is the only thing that needs to hold, and it holds.

### 4. Wash-trading is a compliance question, not a settlement question

Wash-trading is a real concern for regulated venues, but it is handled by **post-hoc audit**, not by trade-time prevention. Every CEX in every regulated jurisdiction relies on:

- Trade reporting to a regulator-accessible ledger
- Periodic surveillance against trader clusters
- Subpoena-driven investigation when a specific trader is flagged

zkScatter has the same audit surface available via the **dual-CA identity layer**:

- Every relayer is registered in `RelayerRegistry` with a Dual-CA identity (privacy-preserving User CA + accountable Relayer CA).
- Authorised auditors can reconstruct the pseudonymous → real-world identity mapping for any specific trader through the User CA.
- Wash-trade clusters can be identified post-hoc by the same trader-clustering analysis a regulated venue would perform.

The privacy property zkScatter provides to honest users — that an arbitrary chain observer cannot link two of their trades — is **preserved** by this model. Only authorised auditors with a court-ordered request can perform the unlinking, just like at a regulated CEX.

This is the same approach Panther Protocol takes for KYC, and the same approach every regulated traditional finance venue takes for any privacy-sensitive trader behaviour. It is not a gap; it is the standard accountability model.

### 5. The privacy property is the load-bearing reason

This is the reason we *cannot* re-introduce self-trade detection later without breaking something else.

**Any on-chain mechanism for self-trade detection requires a per-trader-stable value visible to all observers.** Concretely:

| Mechanism | Per-trader-stable value | Privacy consequence |
|---|---|---|
| Compare `pubKeyHash` of both sides | `Poseidon(pubKeyAx, pubKeyAy)` exposed as public output | Every trade by the same trader carries the same hash → trivial cross-trade clustering by any observer |
| Link tag (e.g. Monero-style) | A linkable ring tag exposed as public signal | Same: every trade by the same trader produces a linkable tag |
| Identity nullifier | A nullifier derived from a long-term identity secret | Same: long-term identity nullifier reused across trades is by definition a cross-trade linker |
| Off-chain commitment to identity | An off-chain identity commitment that the contract checks | Either a trusted oracle (which becomes the privacy oracle the protocol claims not to need) or a public value, which is the previous row |

Every on-chain self-trade detection mechanism reduces to **publishing a per-trader-stable value with every trade**. Once such a value exists in the public signal set, any chain analyst (Chainalysis, Elliptic, Nansen, plus any open-source explorer) can group trades by that value. The trader's privacy reduces to "you can see all of my trades, you just can't yet tie them to my real-world identity" — which in turn reduces under any meaningful side-channel (timing, amount patterns, recipient overlap) to full deanonymisation.

This is the **exact failure mode** that breaks Tornado Cash's anonymity set under chain-analysis pressure: not the cryptography, but the linkability oracles that hover around it. zkScatter is explicitly designed to remove every per-trader-stable signal from the public path. Self-trade detection on-chain re-introduces one. We do not get to have both.

The Half-proof primitive in `circuits/authorize.circom` makes this commitment concrete: **no public signal exposed by `authorize.circom` is stable across trades by the same trader.** Every output is either a one-time-use nullifier, a per-trade newCommitment, or a trade parameter. This is the property the entire privacy story rests on. Self-trade detection on-chain would unwind it.

## Consequences

### What this enables

- **Full per-trader unlinkability for honest users.** Two trades by the same person look as unrelated as two trades by two different people, to anyone without authorised audit access through the User CA.
- **Smaller circuit, smaller verifier.** Removing the `pubKeyHash` public output saves a Poseidon hash and a public signal slot in `authorize.circom` and removes a comparison in `settleAuth`.
- **Cleaner trust model.** The contract has fewer cross-side checks and the privacy story has fewer asterisks.

### What this disallows

- **No protocol-level wash-trade rejection.** Wash trading is detectable post-hoc via the dual-CA layer; it is not blocked at trade-time. A relayer that wants to filter wash trades from its own surface can do so off-chain, but the protocol will not refuse to settle.
- **No on-chain accountability for self-trades.** A trader who self-trades does not generate a special on-chain marker. The settlement looks identical to a normal trade. (This is the property we wanted, not a limitation.)
- **No future "let me link my own trades for tax purposes" feature without separate, opt-in surface.** A trader who actually wants linkability for their own bookkeeping has to use a separate viewing-key-style mechanism (e.g. a self-issued identity proof) that does *not* leak to other observers. This is left for a future feature; it is not part of this ADR.

### What this leaves open for follow-up

- **Reputation / quality scoring (not identity).** Off-chain reputation indexers built on the `DisputeRegistry` event log can track *relayer* behaviour without ever needing trader identity. This is unaffected by this ADR.
- **Voluntary self-disclosure for compliance-sensitive users.** A user who *wants* to prove their identity (e.g. for a regulated counterparty) can do so via the User CA without changing the protocol. Out of scope for this ADR.
- **STP at the relayer matching layer.** A relayer that wants Self-Trade Prevention as a feature for its users can implement it locally — it has the trader identity and can refuse to construct `settleAuth` calls between two of its own users. This is off-chain policy, not protocol enforcement.

## Alternatives considered

### Alternative 1 — Keep the `pubKeyHash` public output and the `MakerTakerSameKey` check

**Rejected because** of the linkability oracle problem (rationale §5). This was the design we started with and removed as part of the Half-proof realisation.

### Alternative 2 — Use a private input to detect self-trade inside the circuit, with no public output

**Rejected because** the check is fundamentally cross-party. `authorize.circom` is a per-side circuit that only sees one user's witness; it cannot compare against the counterparty's pubkey. The cross-party check would have to live in either the contract (which requires a public signal — back to alternative 1) or a third "binding" circuit that takes both sides' pubkeys as private input — which requires both sides to share their pubkeys with a third party (the binding-proof generator), reintroducing exactly the witness-exposure problem the Half-proof primitive was designed to remove.

### Alternative 3 — Use a stealth-address scheme so each trade has a fresh "identity" that is not linked to the trader's long-term key

**Rejected because** stealth-address schemes provide *recipient* privacy, not *trader* privacy. The trader still needs a long-term key to *sign* orders; the stealth address is for the funds they receive. Self-trade detection still needs to compare the signing keys, which are still long-term. This alternative does not solve the problem.

### Alternative 4 — Detect self-trade off-chain in the relayer matching layer only

**Considered and partially adopted.** The protocol does not require it, but a relayer that wants to filter self-matches can do so locally. This is the "STP at the relayer matching layer" follow-up listed above. It is *additive* to this ADR — it does not change the protocol-layer commitment.

### Alternative 5 — Detect self-trade post-hoc via the dual-CA audit layer

**Adopted as the canonical approach.** This is the "wash-trading is a compliance question" rationale (§4 above). It is the same approach a regulated CEX uses and matches the dual-CA accountability model zkScatter is built around.

## Implementation status

- **Removed:** `pubKeyHash` public output from `authorize.circom`. See the long header comment in `circuits/authorize.circom` lines 42-92 ("issue #128 design correction") for the in-circuit explanation. This was landed in PR #129.
- **Removed:** `makerPubKeyAx` / `makerPubKeyAy` / `takerPubKeyAx` / `takerPubKeyAy` from the `MakerProof` / `TakerProof` Solidity structs in `docs/circuit-split/design.md` §6.1. Landed in PR #130 (and reaffirmed in PR #130 review-response cleanup, gemini comment #3061422541 / copilot #3061424280).
- **Removed:** `refMakerPubKeyAx` / `refMakerPubKeyAy` reference equality check from the sketched `settlePrivateSplit` function. Landed in PR #130.
- **Verified absent in `PrivateSettlement.settleAuth(...)`:** the function landed in PR #133 has no pubkey comparison and no reference to public-signal #12 (relayer) for any "is this the same trader as the other side" check. The relayer comparison that does happen is purely about authorisation (`msg.sender == m.relayer || msg.sender == t.relayer`), which is a different question.
- **Test:** `contracts/test/SettleAuth.t.sol` has no self-trade test, deliberately. There is no self-trade revert path to test. A future commit may add a *positive* test asserting that two `AuthorizeProof`s with the same maker/taker relayer (same identity) do not revert, to lock in the decision and catch any accidental re-introduction of a self-trade check.

## Future-change criteria

This decision is not permanent. It can be revisited if **all four** of the following become true at the same time:

1. A regulator with jurisdiction over the deployment formally requires on-chain self-trade prevention as a condition of operation, AND the dual-CA audit path is judged insufficient to satisfy that requirement.
2. A new privacy primitive is identified that enables on-chain self-trade detection **without** publishing a per-trader-stable public value visible to all observers (e.g. some form of accumulated proof of non-self-trade that only the contract can check). The privacy property §5 above must be preserved.
3. The community has clearly weighed the privacy cost and accepted it, in writing.
4. A migration path for existing pseudonymous users is specified that does not retroactively **link or deanonymize** their historical trades. (The previous wording said "unlink", which is the opposite of the intended guardrail — the concern is retroactive linking of trades to identities, not removal of links.)

If a future contributor proposes re-introducing self-trade detection without addressing all four criteria, point them at this ADR.

## Change log

- **2026-04-08** — Decision made during the `authorize.circom` design (issue #128 follow-up). Captured inline in `architecture-v2.md` §"Design decisions / D1".
- **2026-04-10** — This ADR formalises the decision and consolidates the rationale that was scattered across `architecture-v2.md`, `circuit-split/design.md` §2.2, and `authorize.circom`'s header comment. Provides a single link target for the "why don't you prevent self-trade?" question.
