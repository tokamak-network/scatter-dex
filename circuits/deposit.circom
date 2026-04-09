pragma circom 2.0.0;

include "./node_modules/circomlib/circuits/poseidon.circom";

// ════════════════════════════════════════════════════════════════════
//  Deposit Circuit
//
//  Proves that a commitment correctly encodes the deposit (token, amount)
//  pair, binding the on-chain `amount` parameter to the value hidden inside
//  the commitment hash.
//
//  Without this proof, a malicious user can deposit 1 wei while submitting
//  a commitment claiming an arbitrarily large balance, then drain the pool
//  via withdraw/settle proofs that only check `withdrawAmount <= balance`.
//  See: contracts/test/PoolDrainExploit.t.sol
//
//  Constraint: commitment === Poseidon(secret, token, amount, salt)
//
//  Public inputs (visible on-chain, bound to deposit tx):
//    - commitment : the leaf value being inserted into the Merkle tree
//    - token      : ERC20 address being deposited
//    - amount     : actual amount transferred via transferFrom
//
//  Private inputs (known only to the depositor):
//    - secret     : user's escrow secret
//    - salt       : per-commitment salt
// ════════════════════════════════════════════════════════════════════
template Deposit() {
    // ── Public ──
    signal input commitment;
    signal input token;
    signal input amount;

    // ── Private ──
    signal input secret;
    signal input salt;

    // ════════════════════════════════════════
    //  COMMITMENT BINDING
    //  commitment must equal Poseidon(secret, token, amount, salt)
    //  — same hash used in CommitmentPool / withdraw / settle.
    // ════════════════════════════════════════
    component h = Poseidon(4);
    h.inputs[0] <== secret;
    h.inputs[1] <== token;
    h.inputs[2] <== amount;
    h.inputs[3] <== salt;

    commitment === h.out;
}

component main {public [commitment, token, amount]} = Deposit();
