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
    //     Reject off-curve points and the identity (0, 1). Only runs in
    //     deposit, so this cost (~50 R1CS constraints) is paid once per
    //     escrow instead of per-spend.
    // ════════════════════════════════════════
    component pubKeyOnCurve = BabyCheck();
    pubKeyOnCurve.x <== pubKeyAx;
    pubKeyOnCurve.y <== pubKeyAy;

    // Identity point on BabyJub is (0, 1). Any on-curve point with x != 0
    // is non-identity, so a single `Ax != 0` check is sufficient.
    component axIsZero = IsZero();
    axIsZero.in <== pubKeyAx;
    axIsZero.out === 0;

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
