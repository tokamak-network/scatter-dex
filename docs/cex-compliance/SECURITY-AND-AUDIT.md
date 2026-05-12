# Security and Audit Status

This document captures the security posture of the ScatterDEX
codebase: what's been audited, what assumptions the design rests
on, what's known to be limited, and how to report a vulnerability.

It exists so an exchange compliance team — or a researcher
evaluating the protocol — can answer "is it safe?" without
guessing at the gap between "code shipped" and "code reviewed."

## Current audit status

**Unaudited / experimental** as of 2026-05-12.

The codebase has not yet been reviewed by an external security
firm. This is the explicit position for the current public
deployments (testnet only) and any pre-launch CEX evaluations.
A formal audit precedes mainnet activation; this document is
updated in the same PR as the audit publication.

Practical consequences:
- The contracts behind the `TransparentUpgradeableProxy` deployments
  are upgradeable. A critical finding is mitigable by an upgrade
  through the documented procedure (see
  [`ADMIN-WALLETS-AND-UPGRADE-POLICY.md`](./ADMIN-WALLETS-AND-UPGRADE-POLICY.md)).
- The on-chain `pause()` / `unpause()` mechanism (since PR #677)
  is the immediate incident response, owner-gated.
- The `IdentityGate` and `SanctionsList` hooks let operators
  refuse interactions with disclosed risks, even when those risks
  predate the audit.

## Known limitations and trust assumptions

These are the design-level assumptions an auditor will be expected
to confirm. They are documented up-front so an exchange's
compliance review doesn't run into them mid-evaluation.

### Cryptographic
- **Groth16 trusted setup.** Each circuit (`authorize`, `claim`,
  `cancel`, `deposit`, `withdraw`, `splitPayout`) has its own
  Powers-of-Tau-derived proving / verifying key pair. The
  ceremony's transcript will be published alongside the audit
  report so external parties can audit-verify the setup
  contributions. Until then, trust the public PoT phase 1 and the
  documented phase 2 contributors.
- **Soundness of the verifier contracts.** The on-chain Groth16
  verifier contracts are emitted by `snarkjs` from the
  circuit-specific `.zkey`. Their soundness rests on (a) the
  trusted setup above and (b) the verifier emitter producing a
  correct BN254 pairing check. Mismatches between the deployed
  verifier and the circuit it should verify would let invalid
  proofs through. The CI workflow at
  `.github/workflows/zk-asset-drift.yml` compares the SHA-256 of
  the circuit artefacts shipped in `apps/*/public/zk/` against
  the canonical `circuits/build/` outputs to catch
  deployer-side drift.
- **Poseidon constants.** The hash uses the canonical iden3
  Poseidon parameters over BN254. Substituting different round
  constants would break circuit verification without invalidating
  the on-chain bytecode — the constants are baked into the
  `circuits/lib/poseidon_constants.circom` source and into the
  SDK's `commitment.ts` / `merkle.ts` for off-chain parity.
- **EdDSA on Baby Jubjub.** Order-of-operations decisions
  (compressed encoding, scalar reduction) follow the iden3
  reference. The auditor is expected to verify on-chain and
  off-chain parity end-to-end.

### Operational
- **Owner authority is load-bearing.** The operations multisig
  can register or revoke verifiers, identity registries, fee
  collectors, sanctions list entries, and (per the upgrade
  policy) replace contract implementations. A compromise of the
  multisig is a full-protocol compromise. The multisig threshold
  and signer set are published alongside the production deploy.
- **Relayer trust is bounded but real.** Witness-free relaying
  means the relayer cannot read user secrets, but a hostile
  relayer can still refuse to broadcast a valid order, censor
  specific senders, or front-run with their own settlement. The
  on-chain `orderHash` binds `relayer` so a third party can't
  hijack the routing — but the user must still pick a relayer
  they're willing to trust with availability.
- **Indexer / observer trust.** Apps/pay's settle-side reconciler
  and the public observer (when it ships) read events from a
  user-configured RPC. A malicious RPC can withhold events;
  apps/pay's existing reconciler is best-effort, not adversarial.
  Production deployments are expected to use a redundant RPC
  set.
- **Fee-on-transfer tokens.** `CommitmentPool.deposit` uses a
  `balanceAfter − balanceBefore` delta check to refuse tokens
  whose ERC-20 transfer amount diverges from the requested
  amount. Tokens that change behavior post-deploy (e.g. a
  whitelisted token that later turns on a transfer fee) would be
  caught at the next deposit but could leave already-deposited
  state ambiguous; the whitelist is conservative.

### Application
- **Apps/pay (run record) is user-side persistence.** The run
  record lives in the user-picked notes folder; a user who loses
  the folder loses their claim links and recipient metadata.
  On-chain state is recoverable; off-chain metadata is not.
- **Apps/pro (private orders) and mobile (note-prover) execute
  the prover on the user's device.** A compromised device leaks
  the user's `secret` / `salt` / EdDSA private key just like any
  other wallet. The protocol's privacy guarantee is *relative to
  on-chain observers*, not *relative to a compromised endpoint*.
- **zk-X509 attestations** rely on out-of-band CA infrastructure
  (operated by partners). Their soundness — that a presented
  attestation matches a real-world identity — is the CA's
  responsibility, not ScatterDEX's.

## Exact-transfer canonical token assumption

The protocol assumes the deployed ERC-20 implementations transfer
the exact requested amount (modulo fee-on-transfer detection). If
a token's implementation is later upgraded to deduct fees,
ScatterDEX's accounting can lag the on-chain reality. The
`whenNotPaused` modifier and the deposit balance-delta check
together mitigate this, but operators publishing a token to the
whitelist should treat the whitelist as a recurring review item
rather than a one-time decision.

## Reporting a vulnerability

Use one of:

1. **Email** — security@tokamak.network (encrypted with the PGP
   key linked from the project's main README).
2. **GitHub Security Advisories** — file a private advisory on
   the `tokamak-network/scatter-dex` repository. This is the
   preferred channel for issues that need a coordinated public
   disclosure.

**Do not** open a public issue, file a public PR with a fix, or
post to the operator chat. A coordinated-disclosure window
applies: the project commits to acknowledge within 24 hours,
triage within 72 hours, and publish a fix within 30 days of
acknowledgement (or sooner if the issue is actively exploited).

## Bug bounty

A formal bug bounty is **not yet active**. The intent is to
launch one alongside the production deploy + audit publication.
Until then, the channels above are the only routes; severity is
acknowledged in writing but no monetary reward is pre-committed.

## What this document does NOT do

- Does not assert audit-clean status. The current position is
  "unaudited"; any contrary representation (in marketing, in
  press, in CEX submissions) would be incorrect until the audit
  report is published and linked here.
- Does not provide a security guarantee against compromise of
  user devices or out-of-band CA infrastructure. The trust
  assumptions section above is the canonical scope.
- Does not enumerate every potential class of vulnerability.
  Auditors are expected to review the codebase end-to-end; this
  document captures the design-level assumptions they should
  scrutinise.

## History

- 2026-05-12 — initial document. Captures the pre-audit
  position: known limitations, trust assumptions, disclosure
  channels, and the absence of a bug bounty. Updated in the
  same PR as the audit publication, as a bounty launches, or
  whenever a trust assumption changes.
