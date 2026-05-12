# CEX Compliance Pack

This directory consolidates the materials a centralized exchange or
regulator needs to evaluate ScatterDEX without browsing the codebase
end-to-end. The goal is to make the public boundary (deposits,
withdrawals, settlements, identity gating) easy to monitor and to
state clearly what the protocol does and does not do.

## Documents

- **[Boundary Memo](./BOUNDARY-MEMO.md)** — what is public vs. private,
  what an exchange observer can see at each step, and how to read the
  on-chain footprint.
- **[Observability Matrix](./OBSERVABILITY-MATRIX.md)** — table form of
  the boundary memo: each user action mapped to "visible / partial /
  hidden" with the relevant event names.
- **[Marketing Compliance Guidelines](./MARKETING-COMPLIANCE-GUIDELINES.md)** —
  language we use, language we avoid, with rationale. Reviewed before
  every external announcement.
- **[Contract Addresses](./CONTRACT-ADDRESSES.json)** — canonical
  addresses per network with verification status, owner / proxy admin,
  and per-tier verifier registration. Mainnet block reserved; testnet
  placeholders track the current reference deployment.
- **[Admin Wallets and Upgrade Policy](./ADMIN-WALLETS-AND-UPGRADE-POLICY.md)** —
  who can change a contract's logic, parameters, or owner; the routine
  + incident upgrade procedures; the events exchanges can subscribe to.
- **[Selective Disclosure Design](./SELECTIVE-DISCLOSURE-DESIGN.md)** —
  what a user can prove about their own activity to a third party,
  what tooling ships today vs. what's roadmap.
- **[Security and Audit Status](./SECURITY-AND-AUDIT.md)** — current
  audit status (unaudited, pre-launch), known limitations and trust
  assumptions, vulnerability-disclosure channels, bug-bounty position.
- **[Sanctions Enforcement Model](./SANCTIONS-ENFORCEMENT-MODEL.md)** —
  which entry points check the sanctions list, retroactive
  enforcement behaviour, why the claim-time gate is the
  load-bearing piece of the compliance posture.

## What ScatterDEX is not

ScatterDEX is **not a mixer or anonymity tool**. The protocol
provides private order matching and private per-recipient payout
amounts, with KYC-aware identity gating available at the application
layer (`IdentityGate` + zk-X509). Deposits and withdrawals at the
`CommitmentPool` boundary are publicly observable on-chain. Use of
the protocol is prohibited for money laundering, terrorist financing,
sanctions evasion, evasion of statutory reporting (including Travel
Rule), or any other illegal activity.

## Owner / contact

Operational owner and incident contact will be listed alongside the
admin wallet pack once the production deployment is finalized.
