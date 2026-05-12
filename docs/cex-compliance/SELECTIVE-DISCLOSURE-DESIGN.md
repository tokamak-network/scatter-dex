# Selective Disclosure Design

This document captures what a user can prove about their own
ScatterDEX activity to a third party (an exchange, an auditor, a
counterparty) and what tooling exists or is planned to support it.

The principle is **user-controlled, non-custodial disclosure**:
ScatterDEX, its operators, and its relayers do not hold user
viewing keys or spending keys. A user who wants to demonstrate
that a specific on-chain settlement was theirs does so by
generating a proof or a signed attestation from their own
client.

## What the user can already prove today

The shipping primitives — Poseidon commitments, EdDSA-signed order
hashes, Merkle proofs, and Groth16 proofs — already produce enough
material for a user to demonstrate ownership of any specific
on-chain action they took. The disclosure tooling below packages
that material; the underlying cryptography does not change.

### A. "I own this on-chain commitment"

What it proves: a specific `commitment` value that lives in
`CommitmentPool`'s Merkle tree was inserted by **me**.

How:

1. The user opens the wallet that produced the commitment.
2. The wallet has the `secret`, `salt`, `pubKey`, and `token` /
   `amount` in local storage (or the user-picked notes folder).
3. The wallet computes
   `Poseidon(TAG_COMMITMENT_V2, secret, token, amount, salt, pubKeyAx, pubKeyAy)`
   and compares it against the on-chain `commitment`. The
   canonical preimage shape is defined in
   `packages/sdk/src/zk/commitment.ts`; the tag constant is
   `TAG_COMMITMENT_V2` (also from the SDK).
4. The wallet exports a signed JSON disclosure containing the
   commitment, the matching preimage fields, and an EdDSA
   signature over the bundle from the same pubKey baked into the
   commitment.

A verifier (the exchange or the auditor) re-computes the Poseidon
hash and verifies the EdDSA signature. No ZK proof is required —
the disclosure is a plain Poseidon preimage + signature pair.

### B. "I claimed this specific payout"

What it proves: a particular `PrivateClaim` event was produced by
**my** claim transaction.

How:

1. The user has the `secret` + `leafIndex` for the claim leaf
   that produced the `PrivateClaim`.
2. The user re-computes
   `nullifier = Poseidon(TAG_CLAIM_NULL, secret, leafIndex)` —
   note the tag is `TAG_CLAIM_NULL` (value `2`) per
   `circuits/tags.circom`, not `TAG_CLAIM_NULLIFIER` — and
   compares it to the event's `nullifier` field.
3. The user includes the leaf's `recipient`, `token`, `amount`
   (all three are emitted in `PrivateClaim`) and the leaf's
   `releaseTime` (visible in the original claim transaction's
   calldata but not in the event itself; the user has it from
   their own claim-link package) and signs the bundle with the
   EOA that received the payout (i.e. `recipient`).

A verifier recomputes the nullifier and validates the signature.
Same shape as (A) — no ZK proof needed because the secrets are
already paired with public on-chain values.

### C. "These N on-chain commitments are all mine"

What it proves: a list of commitments inserted across time were
all produced by the **same** user, without re-deriving each one
individually.

How:

1. The user concatenates the per-commitment proofs from (A).
2. The user EdDSA-signs the bundle with the master pubkey.

This is the disclosure path an exchange or auditor would request
for an account-history attestation.

## What's not yet built (roadmap)

### D. Account-level proof against a CA-issued attestation

A user demonstrates that the on-chain commitments and claims they
control today belong to a single legal-person account whose
identity is attested by an external CA (e.g. zk-X509-issued).

This requires:

- The user holds a zk-X509 identity cert (issued separately by a
  partner CA — out of scope of ScatterDEX).
- The wallet exports a Groth16 proof binding the user's master
  pubkey to the cert's attested identity without revealing the
  cert. Today's circuits don't have this binding — adding it is a
  follow-on roadmap item that landed in design discussion (Phase
  3 candidate) but has no shipping code yet.

Until then, the workflow for a user who needs CA-tied
attestation is:

1. Export the disclosure bundle from (A) / (B) / (C).
2. Submit it to the CA's verification path separately, attached
   to the user's existing zk-X509 cert.

### E. Bulk export tool

A single click in the wallet that produces (A) + (B) + (C) over
the user's full history and writes a portable
`scatterdex-disclosure.json` file. The pieces exist
individually — `payslip` flow in `apps/pay`, transaction history
in `apps/pro`, the EdDSA signer — but the consolidated export is
not yet wired.

ETA: tied to the `docs/cex-compliance/` graduation cadence;
unblocked once at least one CEX has signalled the JSON shape they
want consumed.

## What ScatterDEX explicitly does not disclose

- **It does not disclose other users' commitments.** The
  disclosure tool reads only the wallet's own secrets. There is
  no operator-side master viewing key.
- **It does not disclose the matching of two anonymous parties in
  `settleAuth`.** A user can prove they were one side of a match
  (because they have their own half-proof's witness) but cannot
  identify or doxx the counterparty.
- **It does not disclose anything about another user's claim
  schedule.** A claims-tree contains N entries; each recipient
  can only prove the leaf they hold, not the existence or
  contents of sibling leaves.

## What this means for an exchange's compliance request

When an exchange asks "where did this user's funds come from",
the expected workflow is:

1. The user opens their ScatterDEX wallet and runs the disclosure
   export against the deposit address the exchange flagged.
2. The export contains: matching `CommitmentInserted` event(s),
   their Poseidon preimage, the user's EdDSA signature, and the
   matching `PrivateClaim` event (when the funds came out of a
   settle / scatter / payout) or the matching pool withdrawal
   event.
3. The exchange's compliance tool verifies the EdDSA signature
   and recomputes the Poseidon hash against the event payload.

The user is the only party who can produce step 2; that's the
"user-controlled" half of the principle. The exchange is the only
party who can choose to accept it; that's the "non-custodial"
half — ScatterDEX is not in the loop.

## References

- `BOUNDARY-MEMO.md` — what is public vs. private at the protocol
  boundary.
- `OBSERVABILITY-MATRIX.md` — per-action visibility table the
  disclosure flow plugs into.
- ADR 0001 (`docs/architecture-decisions/0001-stealth-deprecation.md`)
  — context for why earlier "stealth viewing key" disclosure paths
  no longer apply.

## History

- 2026-05-12 — initial document. Captures the already-shipping
  primitives (A / B / C) and notes the (D) / (E) roadmap. Updated
  in the same PR whenever a new disclosure tool ships or the
  scope changes.
