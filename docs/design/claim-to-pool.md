# `claimToPool` — claim a stealth payment directly into the commitment pool

**Status:** design draft (Revision 2)
**Author:** Zena
**Date:** 2026-05-08
**Related:** [`stealth-address-claim.md`](./stealth-address-claim.md), [`zk-escrow.md`](./zk-escrow.md)

> ⚠️ **Revision 2 supersedes the original interface and execution flow below.**
> The original design (sections "Proposed interface" through "Gas estimate")
> contained two critical security flaws caught in PR review:
>
> 1. The claim circuit hashes `recipient` into the leaf preimage, so setting
>    `pubSignals[4] = address(pool)` cannot verify against a leaf that was
>    written at settle-time with the recipient's stealth address.
> 2. With the slices unbound by the proof, a mempool observer can replace
>    them with their own commitments before the tx lands.
>
> The implementation attempt (PR #630) was reverted on `06b1a9fa`. See the
> **"Revision 2 — corrected design"** section at the end of this doc for
> the design that supersedes the broken parts. The earlier sections remain
> as a historical record of what was rejected and why.

## Motivation

A stealth payment claim today (`PrivateSettlement.claimWithProof`) settles the
escrowed tokens to a single EOA address — the recipient's stealth address.
That EOA balance is a single point of correlation: an on-chain observer who
sees the original payout's `claimsRoot` can also see the resulting transfer to
the stealth EOA, and any later movement from that EOA can be linked back.

We want a path that lets the recipient route the claim **directly into
`CommitmentPool` as one or more fresh, owner-bound commitments** — sized to
blend into the pool's anonymity set rather than telegraphing "this was a
single payout for amount X."

The recipient should not have to first pull funds to their stealth EOA, fund
that EOA with gas, deposit them back into the pool, and only then enjoy the
privacy benefit. Each of those intermediate states is observable.

## Goals

1. Atomic: one tx, no intermediate stealth-EOA balance.
2. Split: one claim → N commitments at recipient-chosen amounts (sum = claim
   amount).
3. Owner-bound: each new commitment binds to the **connected MetaMask
   account's EdDSA spending key** (not the stealth address). The user spends
   later via their normal `useEdDSAKey` derivation, same as any other pool
   note.
4. Reuse: prefer reusing existing circuits and existing nullifier sets over
   introducing new ones.
5. Same security guarantees as today's `claimWithProof`:
   - One claim per stealth payment (nullifier set protects against replay).
   - No cross-flow holes (e.g. claim-then-claimToPool double withdraw).

## Non-goals (this PR)

- Anonymous forwarding (commitments bound to a *third party's* pubkey rather
  than the claimer's).
- Atomic claim + redeposit *and* further actions (settle, withdraw) in the
  same tx.
- Frontend implementation. This doc is the contract-level design only.

## Current code touchpoints

- [`contracts/src/zk/PrivateSettlement.sol`](../../contracts/src/zk/PrivateSettlement.sol)
  - `_executeClaim(...)` (line ~975) — verifies claim ZK proof, marks
    `claimNullifiers[claimNullifier]`, transfers tokens to `recipient`, emits
    `PrivateClaim`.
  - State: `claimNullifiers` (used + write), `claimsGroups[claimsRoot]` (read +
    increment `totalClaimed`).
  - WETH unwrap path: claim of WETH auto-unwraps to native ETH for the
    recipient.

- [`contracts/src/zk/CommitmentPool.sol`](../../contracts/src/zk/CommitmentPool.sol)
  - `deposit(...)` (line ~193) — verifies a deposit proof, pulls tokens via
    `transferFrom`, inserts the commitment.
  - `insertCommitment(uint256)` (line ~251) — inserts a raw commitment with
    **no proof check**. Restricted to `msg.sender == authorizedSettlement`.
    Already used today for change commitments coming out of a settle path.
  - `transferToSettlement(token, amount)` (line ~268) — pool → settlement
    direction; we need the reverse for `claimToPool`.

The two contracts are already wired together via `authorizedSettlement` on the
pool side, so adding a new bidirectional call doesn't introduce new trust
boundaries — `claimToPool` lives behind the same trust assumption that
already lets settle insert change commitments.

## Proposed interface (PrivateSettlement.sol)

```solidity
struct ClaimToPoolSlice {
    /// New commitment to insert into CommitmentPool. The frontend
    /// constructs commitment = hash(secret, eddsaPubkey, token, sliceAmount)
    /// using the connected MetaMask's EdDSA pubkey, persists the secret
    /// note in the user's vault before the tx is sent, and includes the
    /// commitment hash here.
    uint256 commitment;
    /// Amount of `token` (= claim's token) routed into this commitment.
    uint256 amount;
}

/// @notice Claim a stealth payment and route the result as N new
///         commitments into CommitmentPool, atomically. The claim's
///         token + total amount equal the original claim package; the
///         caller decides how to split it across `slices`.
///
/// @dev    `claimNullifier` shares the same `claimNullifiers` mapping
///         used by `claimWithProof` — a payment claimed via either path
///         consumes the same single-use slot, so a stealth payment can
///         only be claimed once across both flows.
function claimToPool(
    uint[2] calldata proofA,
    uint[2][2] calldata proofB,
    uint[2] calldata proofC,
    bytes32 claimsRoot,
    bytes32 claimNullifier,
    uint256 amount,
    address token,
    uint256 releaseTime,
    ClaimToPoolSlice[] calldata slices
) external nonReentrant;
```

The `recipient` field is dropped — there is no EOA destination. The claim
ZK proof's `recipient` public signal is set to `address(pool)` so the
existing claim circuit can be reused unchanged: it still proves "this
stealth payment authorizes a transfer to the address provided," and we
provide `address(pool)` as that address.

(Alternative considered: introduce a new sentinel address constant for
"claim to pool" so the proof can be distinguished from a normal claim
targeting the pool address. Decision: not needed — the pool's address is
not a valid stealth recipient, so a proof verifying against `address(pool)`
is unambiguous, and the contract enforces which entry function is being
called regardless.)

## Execution flow

1. **Sanity checks**
   - `slices.length > 0` and ≤ a `MAX_CLAIM_TO_POOL_SLICES` (proposal: 8 — caps
     proof verifications + Merkle inserts per tx, leaves headroom under block
     gas limit).
   - `paused == false`.
   - `block.timestamp >= releaseTime`.
   - `token == claimsGroups[claimsRoot].token` (matches existing claim).

2. **Sum check**
   ```
   sum(slices[i].amount) == amount
   ```
   This is checked before any state mutation so a malformed payload doesn't
   even mark the nullifier.

3. **Claim ZK verification** — same as `_executeClaim`, with
   `recipient = address(pool)`. Pulls the tier-specific verifier from
   `claimVerifierByTier[group.tier]`. No verifier code or circuit changes.

4. **Mark nullifier** — `claimNullifiers[claimNullifier] = true` *and*
   `group.totalClaimed += uint128(amount)`, identical to `_executeClaim`.

5. **Token movement** — `PrivateSettlement` already holds the escrowed
   tokens. Two sub-options:

   - **(A) Trust-pool path:** `IERC20(token).safeTransfer(address(pool),
     amount)` once, then `pool.insertCommitment(slices[i].commitment)` per
     slice. The pool's `insertCommitment` already accepts raw commitments
     from `authorizedSettlement` (used by settle's change-commitment flow).

   - **(B) Verify-deposit path:** for each slice, generate + submit a deposit
     ZK proof bound to `(commitment, token, amount)` and call the existing
     `pool.deposit(...)`. Requires the pool to accept `transferFrom` from
     `PrivateSettlement` after a single approval, or re-architecting the
     deposit interface.

   **Decision: (A).** Justification:
   - The pool *already trusts* `PrivateSettlement` to insert un-proven
     commitments via the settle path. Adding `claimToPool`'s commitments to
     that same trust set doesn't widen the trust assumption.
   - Saves N × ~280–320k gas (deposit proof verifications) across the call.
   - A malformed commitment (e.g. one that doesn't bind to the correct
     `(amount, eddsaPubkey)`) only locks the **caller's own** allocation —
     they cannot later spend it because authorize-side proofs would fail.
     There is no way for a malformed commitment to drain other users'
     funds, since the pool's withdraw / authorize paths bind on
     `(secret, eddsaPubkey, leafIndex)` that the malicious caller doesn't
     control.

   This is the same security argument that already justifies trusting
   settle's change commitments without per-call deposit proofs.

6. **Insert commitments** — loop over `slices`, calling
   `pool.insertCommitment(commitment)` for each. The pool emits its existing
   `CommitmentInserted(commitment, leafIndex, block.timestamp)` event per
   slice; the reconciler that already powers `vault` (tracking
   `CommitmentInserted` to assign leafIndex) needs no changes.

7. **Emit `PrivateClaimToPool`**
   ```solidity
   event PrivateClaimToPool(
       bytes32 indexed claimsRoot,
       bytes32 indexed claimNullifier,
       address indexed token,
       uint256 amount,
       uint256 sliceCount
   );
   ```
   Distinct from `PrivateClaim` so off-chain indexers can tell the two
   apart. We deliberately **do not** include the per-slice commitment list
   in the event — the per-slice `CommitmentInserted` events already carry
   that info, and duplicating it bloats logs.

## What does *not* change

- **Storage layout.** No new state variables. Everything reuses
  `claimNullifiers` and `claimsGroups`. A `forge inspect storage-layout`
  diff against the prior version should be empty.
- **`_executeClaim` body.** Untouched — `claimWithProof` and
  `claimWithProofBatch` retain identical bytecode for the existing path.
- **Circuits.** Both the claim circuit and the deposit circuit are reused
  unchanged. No prover-side changes.
- **Pool contract.** Reuses existing `insertCommitment`. The `authorizedSettlement`
  guard already lets `PrivateSettlement` call it.
- **Nullifier domain.** A stealth payment claimed via `claimToPool` consumes
  the same `claimNullifiers[X]` slot as `claimWithProof` would. A subsequent
  `claimWithProof(..., X)` reverts with `NullifierAlreadySpent`, so a single
  stealth payment cannot be both pulled to an EOA *and* redeposited.

## Storage layout discipline

Even though this PR adds no new state, the convention going forward is:

- **Append-only.** Any future state added to `PrivateSettlement` goes after
  the last existing `mapping`. Never reorder, never change types of existing
  slots.
- **CI gate.** Add a `forge inspect storage-layout` snapshot check to CI so
  any PR that perturbs the layout fails loudly.
- **Audit-diff hygiene.** `claimToPool` is contained to one new external
  function and one new internal helper. The diff vs. current
  `PrivateSettlement.sol` should be reviewable in <100 lines, and the
  existing claim path's bytecode should be byte-identical.

## Gas estimate

Per slice (option A, no per-slice deposit proof):

| Step | Gas (cold cache) |
|------|------------------|
| Claim proof verify (one-time) | ~300k |
| Claim nullifier SSTORE | ~22k |
| `claimsGroups[claimsRoot].totalClaimed` update | ~5k (warm slot) |
| `safeTransfer` to pool (one-time) | ~50k |
| `insertCommitment` per slice — Merkle leaf insert + path update | ~50–80k |
| Event emission per slice | ~3k |

Round-numbers totals (cold cache):
- N=1: ~430k
- N=2: ~510k
- N=4: ~680k
- N=8: ~1.0M (still well under any reasonable block gas budget)

For comparison, `claimWithProof` today is ~380k. So `claimToPool` with N=4
adds roughly +300k gas vs. a plain claim, while saving the user N×~75k+
gas they'd otherwise pay calling `pool.deposit(...)` separately on each
slice from a stealth EOA — and saving the round-trip latency entirely.

## Security analysis

### 1. Nullifier replay

`claimNullifiers` is shared with `claimWithProof`. Once `claimToPool` writes
to it, any subsequent `claimWithProof` with the same nullifier reverts. The
reverse holds too. ✅

### 2. Sum mismatch

If the contract did not enforce `sum(slices[i].amount) == amount`, a caller
could send 100 tokens to the pool but mint commitments worth 200 — letting
them later withdraw more than they put in. The sum check is the load-bearing
invariant of this function. **Must be enforced before nullifier mutation**
so a botched payload doesn't burn a stealth payment.

### 3. Malformed commitments

A caller can submit a `commitment` value that doesn't actually correspond
to any valid `(secret, pubkey, token, amount)` tuple they know the secret
for — option (A) doesn't verify this. The result: a leaf in the tree that
no one can spend (a "dead leaf"), eating the slice's amount. **This is a
self-inflicted loss to the caller only.**

It cannot become a vector for stealing other users' funds because:
- Spend-side (authorize / withdraw) verifies a ZK proof binding
  `(secret, eddsaPubkey, leafIndex, commitment)` — the attacker would need
  a secret matching the commitment they planted.
- Cross-leaf binding: each leaf's spendability is private to the secret
  bound to it.

This is exactly the property that already justifies the existing trust
between PrivateSettlement and `pool.insertCommitment` for settle's change
commitments.

### 4. Reentrancy

`claimToPool` is `nonReentrant`. The only external call sequence is
`safeTransfer` (well-known reentrancy-safe with non-malicious tokens; same
assumption as everywhere else in the contract) and N × `insertCommitment`
(internal contract we control, no external calls within). No new reentrancy
surface. ✅

### 5. Sanctions

Unlike `_executeClaim`, there is no recipient EOA to sanctions-check. The
caller (`msg.sender`) can be sanctions-checked if the policy demands it,
but the natural place is the relayer who broadcasts the tx — same as
any other claim. Decision: gate `msg.sender` through the existing
`_requireNotSanctioned` so the surface matches `_executeClaim`'s spirit.

### 6. Pool authorizes raw commitment insertion

`pool.insertCommitment` can already be called from any
`PrivateSettlement` entry point — adding `claimToPool` doesn't widen this
authorization. The pool side stays unchanged. ✅

## Migration / deployment

`PrivateSettlement` is **not** upgradeable (`Ownable2Step`, no proxy). Adding
`claimToPool` requires a new deploy. Live escrow state (the
`claimsGroups` mapping + outstanding `claimNullifiers`) does not transfer
automatically. Operational options:

1. **Cutover with drain window.** Announce a cutover date; existing
   stealth-payment recipients call `claimWithProof` on the **old** contract
   before the cutover. Any uncollected escrow on the old contract becomes
   the responsibility of those recipients — same as any non-upgradable
   contract migration today.

2. **Owner-side migration.** Add a one-time `migrateClaimsGroup` call on
   the new contract callable by `owner` to copy `claimsGroup` entries from
   the old contract. Risk: owner trust assumption widens (could in
   principle migrate forged groups). Decision: only do this if a real,
   significant escrow value would otherwise be stranded — for the current
   stage (small testnet escrows + no mainnet deployment), option 1 is
   adequate.

3. **Parallel run.** Old + new live simultaneously, frontend defaults to
   new. Old stays for legacy claims indefinitely. Lowest risk; highest
   code surface to maintain.

Pre-mainnet: option 1 (drain + cutover) is sufficient and avoids any owner
escalation. Post-mainnet: revisit.

## Test plan (forge)

1. **Happy path: 1 slice.** Equivalent to `claimWithProof` but commitment
   instead of EOA destination. Verify nullifier is consumed, totalClaimed
   advances, pool's tree contains the new commitment, claim cannot be
   replayed.
2. **Happy path: N=4 split.** Sum equals claim amount. All 4 commitments
   land at consecutive leaf indices with `CommitmentInserted` events.
3. **Sum mismatch.** `sum(slices) != amount` reverts; nullifier
   **unmodified**, group's `totalClaimed` unchanged, caller's tokens
   untouched.
4. **Empty slices.** Reverts before nullifier mutation.
5. **Slices > MAX.** Reverts before nullifier mutation.
6. **Replay across paths.** `claimToPool` then `claimWithProof` with the
   same nullifier reverts. And vice versa.
7. **Token mismatch.** `slices[i].amount` summing to `amount` but
   `token != group.token` reverts.
8. **Pre-release.** `block.timestamp < releaseTime` reverts.
9. **Paused.** Contract paused → reverts.
10. **Storage-layout snapshot.** `forge inspect storage-layout` matches
    the prior version's snapshot byte-for-byte.

## Frontend implications (out of scope here, captured for completeness)

- New flow lives in `apps/pay`, parallel to the existing `Claim` button on
  inbox rows. Probably a `Redeposit (split)` action that opens a modal
  with preset (`1×/2×/4×`) and manual split modes — same UX shape as the
  closed PR #628, but the orchestration is one tx instead of two and there
  is no stealth-EOA gas requirement.
- For each slice, the frontend generates a note with the connected
  MetaMask's EdDSA pubkey, computes `commitment`, and persists the secret
  note to the user's vault **before** broadcasting (same crash-recovery
  contract as `realDeposit` already maintains).
- Vault reconciler picks up the per-slice `CommitmentInserted` events to
  assign `leafIndex` exactly as for any other deposit — no new client
  state machine.

## Open questions

1. **Per-slice deposit proofs anyway?** Option (A) is the recommendation,
   but if the audit prefers a uniform "every commitment-creating call
   carries a proof" rule, switching to option (B) is a contract-level
   change that doesn't affect the frontend. Decide before contract impl.

2. **`MAX_CLAIM_TO_POOL_SLICES`.** Proposal: 8. Higher values increase
   per-tx gas linearly. The frontend's UX caps anonymity-set value at
   diminishing returns past 4-ish anyway. Tune later if needed.

3. **WETH unwrap behavior.** Today's `_executeClaim` auto-unwraps WETH to
   native ETH on payout. For `claimToPool` we want the **opposite** — keep
   it as WETH so the pool holds an ERC20. The proposed function should
   skip the WETH-unwrap branch in `_executeClaim` for the
   `recipient = address(pool)` case. (Or, equivalently, lift the unwrap
   logic out of the shared helper and have only the EOA path do it.)

4. **Sanctions on `msg.sender` vs. claim's stealth address.** Today,
   `_executeClaim` checks the *recipient* (a stealth EOA). For
   `claimToPool`, recipient is the pool — sanctions-checking the pool is
   meaningless. The natural target is the EdDSA pubkey or the connected
   user's address that signed the tx. Default proposal: check
   `msg.sender` (consistent with the broader contract's pattern); revisit
   if compliance requires more.

---

## Revision 2 — corrected design (supersedes the above)

PR #629/#630 review surfaced two critical flaws in the original design that
make it unimplementable as written. This section is the corrected design.
Anything above this line is historical.

### The two flaws

**Flaw 1 — recipient is part of the leaf preimage.** The claim circuit
(`circuits/claim_template.circom`) computes
`leaf = Poseidon(secret, recipient, token, amount, releaseTime)`. At
settle-time, the leaf is written with the recipient's stealth address.
Setting `pubSignals[4] = address(pool)` in `claimToPool` cannot verify
against that leaf — the proof would fail in production. The mock
verifier in PR #630's test suite hid this because `MockClaimVerifier`
doesn't validate against an actual claim leaf. **Conclusion: the proof's
recipient public signal MUST remain the stealth address.**

**Flaw 2 — slices are not bound by the proof.** The claim ZK proof
constrains `(claimsRoot, claimNullifier, amount, token, recipient,
releaseTime)`. It does not see the `slices[]` array. Whoever broadcasts
the tx (the user themselves *or* any mempool observer who copies the
calldata into a competing tx with higher fees) can substitute their own
slice commitments. Funds end up under the front-runner's EdDSA pubkey;
the user's nullifier is consumed; the user's funds are gone.

### Corrected interface

```solidity
struct ClaimToPoolSlice {
    uint[2] proofA;
    uint[2][2] proofB;
    uint[2] proofC;
    uint256 commitment;
    uint256 amount;
}

/// @notice Stealth claim → split pool deposit, atomically. The proof
///         binds (..., recipient = stealthAddress) exactly like
///         `claimWithProof`. The redirect-to-pool intent + the slice
///         payload are authenticated by an EIP-712 signature from the
///         stealth privkey, so a mempool observer cannot substitute
///         their own slices and the proof cannot be replayed via
///         `claimWithProof` to grief the user.
function claimToPool(
    uint[2] calldata claimProofA,
    uint[2][2] calldata claimProofB,
    uint[2] calldata claimProofC,
    bytes32 claimsRoot,
    bytes32 claimNullifier,
    uint256 amount,
    address token,
    address stealthRecipient,
    uint256 releaseTime,
    ClaimToPoolSlice[] calldata slices,
    bytes calldata stealthSignature
) external nonReentrant;
```

`stealthRecipient` is the address baked into the claim leaf (typically
the user's stealth EOA). The proof verifies against it via signal #4.
`stealthSignature` is the user's authorization to redirect funds into
the pool with the specified slice layout.

### EIP-712 message

The frontend has the stealth privkey already (the inbox flow derives it
from the user's meta-keys + the package's ephemeral pubkey). It signs
the following typed-data message with that key:

```
TypedData ClaimToPoolAuth {
    bytes32 claimNullifier;
    uint256 amount;
    address token;
    bytes32 slicesHash;          // keccak256(abi.encode(slices))
    uint256 chainId;
    address verifyingContract;   // PrivateSettlement address
}
```

Including `slicesHash` binds the entire slice array — including each
slice's deposit proof, commitment, and amount — to the signature. Any
substitution invalidates the signature.

`chainId + verifyingContract` are the standard EIP-712 domain separator
fields and prevent the signature from being replayed against a different
deployment.

### Execution flow

1. **Validate payload before any mutation.** All of the original Rev 1
   guards — `slices.length` in `[1, MAX_CLAIM_TO_POOL_SLICES]`,
   `paused == false`, `block.timestamp >= releaseTime`,
   `token == claimsGroups[claimsRoot].token`,
   `amount <= type(uint128).max`, nullifier unused, `claimsGroup` exists,
   `group.totalClaimed + amount <= group.totalLocked` (in `uint256`
   arithmetic, per Gemini medium), per-slice
   `commitment != 0 && amount != 0 && amount <= total` — still apply.
   Fail before any state mutation so a botched payload doesn't burn the
   nullifier.

2. **Sanctions check the stealth recipient.** Mirror `_executeClaim`'s
   `_requireNotSanctioned(stealthRecipient)`. Checking `msg.sender` is
   ineffective when a relayer broadcasts (Gemini medium), and the
   stealth recipient is the right compliance target for parity with
   `claimWithProof`.

3. **Verify the claim ZK proof.** Public signals are
   `[claimsRoot, claimNullifier, amount, token, stealthRecipient,
   releaseTime]` — identical to `claimWithProof`. Reuses the existing
   tier verifier registry. No circuit changes.

4. **Verify the EIP-712 signature.** Recover the signer of
   `ClaimToPoolAuth` and require it to equal `stealthRecipient`. This
   cryptographically binds the slices to the stealth-key holder's
   intent. Front-running fails because the bot cannot produce a
   signature matching the user's stealth privkey. Cross-flow grief
   (Copilot) is also prevented: a `claimWithProof(...)` call with the
   same proof is harmless (it pays the user's stealth EOA, which is
   the normal flow).

5. **Mark nullifier and advance `group.totalClaimed`.** Identical to
   `_executeClaim`.

6. **Token movement: per-slice `pool.deposit`** with single bulk
   approval (Copilot fee-on-transfer concern). Each slice carries its
   own deposit ZK proof; `pool.deposit` enforces the
   `commitment ↔ (token, amount)` binding via the deposit verifier and
   does its own balance-delta check, so fee-on-transfer / rebasing
   tokens revert cleanly. Implementation:
   ```solidity
   IERC20(token).forceApprove(address(pool), amount);
   for each slice s:
       pool.deposit(s.proofA, s.proofB, s.proofC, s.commitment, token, s.amount);
   ```
   No WETH unwrap branch (Gemini medium): the pool wants the ERC20.
   The unwrap path in `_executeClaim` stays untouched for the EOA flow.

7. **Emit `PrivateClaimToPool`** as in Rev 1. Per-slice
   `CommitmentInserted` events come from `pool.deposit` automatically.

### Why this fixes each flagged issue

| Issue | Severity | Status in Rev 2 |
|-------|----------|-----------------|
| Slice front-running (Gemini #1) | Critical | Fixed by EIP-712 signature binding `slicesHash` |
| Recipient ↔ leaf mismatch (Gemini #2) | High | Fixed: proof keeps `recipient = stealthAddress` |
| WETH unwrap to pool (Gemini #3) | Medium | Fixed: `claimToPool` skips the unwrap branch |
| Sanctions effectiveness (Gemini #4) | Medium | Fixed: check `stealthRecipient`, not `msg.sender` |
| Cross-flow grief (Copilot #1) | High | Fixed: proof binds stealth EOA, not pool |
| Fee-on-transfer (Copilot #2) | Medium | Fixed: per-slice `pool.deposit` runs balance-delta |
| Commitment scheme doc (Copilot #3) | Low | Fixed: doc references v2 Poseidon scheme |
| `insertCommitment(0)` silent loss (Copilot #4) | Low | Fixed: per-slice `commitment != 0` rejected upfront |
| Field-modulus checks (Copilot #5) | Low | Fixed: `pool.deposit` enforces them |
| `uint256` sum overflow (Gemini PR #630 follow-up) | High | Fixed: `s.amount <= amount` bound + `amount <= uint128.max` |
| `Panic(0x11)` preempts custom error (Gemini PR #630) | Medium | Fixed: `uint256` arithmetic for the bounds check |

### What does *not* change vs. Rev 1

- **Storage layout.** Still no new state.
- **`_executeClaim` body.** Still byte-identical; `claimWithProof` /
  `claimWithProofBatch` paths untouched.
- **Circuits.** Both the claim circuit and the deposit circuit are
  reused unchanged. The only new cryptographic primitive is an EIP-712
  signature recovery, handled with OpenZeppelin's `ECDSA.recover`.
- **Pool contract.** No new functions. Reuses `pool.deposit`.
- **Nullifier domain.** Still shared with `claimWithProof`.

### Updated gas estimate

| N | Gas | Per-slice contributors |
|---|-----|------------------------|
| 1 | ~800k  | claim verify 300k + nullifier 22k + sig recover 5k + approve 46k + pool.deposit (verify 300k + transfer 30k + insert 50k + balance check 15k) = ~768k |
| 2 | ~1.20M | + 1×395k |
| 4 | ~1.99M | recommended for anonymity-set |
| 8 | ~3.16M | cap |

Higher than Rev 1's option A estimate because we (correctly) chose
option B with per-slice deposit proofs *and* added an EIP-712 signature
recovery. The signature recovery is ~5k gas — negligible compared to
the proof verifications.

### Updated test plan

In addition to the Rev 1 forge tests, add:

- `test_claimToPool_stealthSigInvalid_reverts` — wrong signer
- `test_claimToPool_slicesHashTampered_reverts` — same sig, different
  slices
- `test_claimToPool_chainIdMismatch_reverts` — replay across chains
- `test_claimToPool_verifyingContractMismatch_reverts` — replay across
  deployments
- Extend `MockClaimVerifier` to enforce `pubSignals[4] = stealthRecipient`
  (now varies per test rather than being pinned to `address(pool)`)

### Frontend implications

Frontend changes vs. Rev 1:

- Generate the `ClaimToPoolAuth` EIP-712 message and sign it with the
  stealth privkey (already available from the inbox derivation). One
  extra `eth_signTypedData_v4` step in the modal flow.
- The user's *connected MetaMask* still pays gas (broadcasts the tx)
  but does not sign anything beyond the standard tx submission. The
  stealth key is the cryptographic authority on the destination.
- Vault note generation is unchanged.
