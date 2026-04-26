/** Placeholder EdDSA pubkey for the demo deposit flow.
 *
 *  Phase 2b-ii doesn't yet ship the EdDSA key derivation
 *  (`signMessage` → BabyJub keypair); Phase 3 brings the real one
 *  to `@zkscatter/sdk/zk`. Until then, this stub returns a
 *  deterministic non-zero point so `CommitmentNote` has well-formed
 *  fields and the mock prover doesn't choke.
 *
 *  **Funds bound to this pubkey are unspendable** — the matching
 *  private key doesn't exist. The deposit modal warns about this
 *  via the "demo mode" banner. */
export function demoEddsaPubKey(): readonly [bigint, bigint] {
  // Two arbitrary non-zero field elements. Real BabyJub points have
  // pubKeyAx/pubKeyAy on the curve; the mock prover ignores that
  // since it doesn't actually run BabyCheck.
  return [
    0x1f0e_2c9b_88d4_5a31_7e23_99c6_ba01_2f53n,
    0x0d3a_6471_28e9_5fb2_dc88_4490_a65f_e017n,
  ];
}
