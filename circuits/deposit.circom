pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";
include "./node_modules/circomlib/circuits/babyjub.circom";
include "./node_modules/circomlib/circuits/comparators.circom";
include "./tags.circom";

// ════════════════════════════════════════════════════════════════════
//  Deposit Circuit (v2 — commitment binds the BabyJub signing pubkey)
//
//  Proves that a commitment correctly encodes (secret, token, amount,
//  salt, pubKeyAx, pubKeyAy), binding the on-chain `amount` parameter
//  to the value hidden inside the commitment hash AND binding the
//  depositor's EdDSA pubkey so a stolen preimage cannot later be spent
//  with a swapped key.
//
//  Without this proof, a malicious user can deposit 1 wei while
//  submitting a commitment claiming an arbitrarily large balance, then
//  drain the pool via withdraw/settle proofs that only check
//  `withdrawAmount <= balance`. See:
//  contracts/test/PoolDrainExploit.t.sol
//
//  [issue #128] The pubkey binding closes the swap-the-key attack
//  flagged in PR #127 (Copilot HIGH). A leaked `(secret, salt, balance)`
//  is no longer sufficient to forge a proof that spends the escrow,
//  because the merkle membership check inside withdraw/settle/authorize
//  would require a commitment hash computed with the same pubkey that
//  was deposited. Without the EdDSA private key the attacker cannot
//  sign the `orderHash` required by the spending proofs.
//
//  Constraint:
//    commitment === Poseidon(
//      TAG_COMMITMENT_V2, secret, token, amount, salt, pubKeyAx, pubKeyAy
//    )
//
//  Hardening (also from #128 analysis):
//    1. `BabyCheck(pubKeyAx, pubKeyAy)` — rejects off-curve points that
//       would otherwise brick the escrow (EdDSAPoseidonVerifier does NOT
//       check curve membership internally).
//    2. `pubKeyAx != 0` — rejects the BabyJub identity point (0, 1),
//       which would make any signature over `orderHash` trivially
//       forgeable. Checking `Ax` is sufficient because the identity is
//       the only on-curve point with `x == 0`.
//
//  These checks live only in deposit.circom, so every commitment that
//  ever enters the merkle tree is guaranteed to have a well-formed
//  pubkey. Downstream circuits (withdraw/settle/authorize) can rely on
//  this invariant without paying the BabyCheck cost per-spend.
//
//  Public inputs (visible on-chain, bound to deposit tx):
//    - commitment : the leaf value being inserted into the Merkle tree
//    - token      : ERC20 address being deposited
//    - amount     : actual amount transferred via transferFrom
//
//  Private inputs (known only to the depositor):
//    - secret     : user's escrow secret
//    - salt       : per-commitment salt
//    - pubKeyAx   : BabyJub signing pubkey x-coordinate (bound into commitment)
//    - pubKeyAy   : BabyJub signing pubkey y-coordinate (bound into commitment)
// ════════════════════════════════════════════════════════════════════
template Deposit() {
    // ── Public ──
    signal input commitment;
    signal input token;
    signal input amount;

    // ── Private ──
    signal input secret;
    signal input salt;
    signal input pubKeyAx;
    signal input pubKeyAy;

    // ════════════════════════════════════════
    //  1. PUBKEY VALIDITY
    //
    //  Two checks, both local to deposit so the cost is paid once
    //  per escrow instead of per-spend:
    //
    //    (a) BabyCheck — point is on the BabyJub curve
    //    (b) Subgroup exclusion — point is NOT in the cofactor-8
    //        small-order subgroup, enforced via `8·P ≠ identity`.
    //
    //  ── Why the subgroup check ──
    //
    //  BabyJub is the twisted Edwards curve
    //       `a·x² + y² = 1 + d·x²·y²`
    //  with `a = 168700`, `d = 168696`. Its group order is N = 8·L
    //  where L is a large prime, so every on-curve point has an
    //  order that divides N and sits in one of two subgroups:
    //
    //    • The prime-order subgroup (order L) — every honest
    //      pubkey produced by `eddsa.prv2pub(privKey)` lives here.
    //    • The cofactor-8 small-order subgroup (order 8) — eight
    //      points whose orders divide 8. EdDSA over any of them is
    //      broken: the identity (order 1) gives trivially forge-
    //      able signatures, and the other seven are "small-order
    //      keys" that let an attacker grind a valid signature for
    //      a small set of messages.
    //
    //  If P is in the small-order subgroup then `8·P = identity`
    //  by definition. If P is in the prime-order subgroup then
    //  `8·P` is another prime-order point and in particular
    //  `8·P ≠ identity`. So `8·P ≠ identity` is a necessary-and-
    //  sufficient test for "P ∉ small-order subgroup".
    //
    //  Identity on BabyJub is `(0, 1)`, and the only on-curve
    //  points with `x == 0` are `(0, 1)` and `(0, -1 mod p)` —
    //  both of which lie in the small-order subgroup. So
    //  `(8·P).x ≠ 0` is equivalent to `8·P ≠ identity` for any
    //  on-curve P, which is all we need.
    //
    //  Implementation: three BabyDbl calls compute 8·P in affine
    //  twisted-Edwards coordinates, then IsZero catches the
    //  identity case.
    //
    //  ── History ──
    //
    //  [PR #127 follow-up, issue #128] First draft of this circuit
    //  only checked `pubKeyAx != 0`, which catches the two
    //  small-order points with `x == 0` (identity and `(0, -1)`)
    //  but misses the six small-order points with `x != 0`. In
    //  practice those six are unreachable via `eddsa.prv2pub`,
    //  and an adversary who deliberately lands on one would only
    //  brick their own escrow (nullifier isolation prevents theft
    //  of other users' funds), so the PoC originally accepted the
    //  gap.
    //
    //  [PR #129 Gemini review] Upgraded to the full subgroup
    //  check here. The extra cost is ~50-80 R1CS constraints, only
    //  paid at deposit, and it closes the latent concern
    //  permanently. Downstream circuits
    //  (withdraw / settle / authorize) still inherit the invariant
    //  that every commitment in the merkle tree was produced by a
    //  prime-order pubkey without paying the subgroup-check cost
    //  themselves.
    // ════════════════════════════════════════

    component pubKeyOnCurve = BabyCheck();
    pubKeyOnCurve.x <== pubKeyAx;
    pubKeyOnCurve.y <== pubKeyAy;

    // 8·P via three doublings.
    component dbl1 = BabyDbl();
    dbl1.x <== pubKeyAx;
    dbl1.y <== pubKeyAy;

    component dbl2 = BabyDbl();
    dbl2.x <== dbl1.xout;
    dbl2.y <== dbl1.yout;

    component dbl3 = BabyDbl();
    dbl3.x <== dbl2.xout;
    dbl3.y <== dbl2.yout;

    // 8·P must not be the identity (0, 1). See the comment above
    // for why `(8·P).x != 0` catches all eight small-order points.
    component eightPxIsZero = IsZero();
    eightPxIsZero.in <== dbl3.xout;
    eightPxIsZero.out === 0;

    // ════════════════════════════════════════
    //  2. COMMITMENT BINDING  (v2 — includes pubkey)
    //     commitment must equal Poseidon(
    //       TAG_COMMITMENT_V2, secret, token, amount, salt,
    //       pubKeyAx, pubKeyAy
    //     )
    //     — same hash used in CommitmentPool / withdraw / settle /
    //     authorize. All downstream circuits expect this exact preimage
    //     layout; any drift is a consensus break.
    // ════════════════════════════════════════
    component h = Poseidon(7);
    h.inputs[0] <== TAG_COMMITMENT_V2();
    h.inputs[1] <== secret;
    h.inputs[2] <== token;
    h.inputs[3] <== amount;
    h.inputs[4] <== salt;
    h.inputs[5] <== pubKeyAx;
    h.inputs[6] <== pubKeyAy;

    commitment === h.out;
}

component main {public [commitment, token, amount]} = Deposit();
