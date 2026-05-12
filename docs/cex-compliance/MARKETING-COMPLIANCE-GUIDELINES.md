# Marketing Compliance Guidelines

External materials about ScatterDEX — landing pages, press releases,
GitHub READMEs, npm package descriptions, blog posts, sales decks —
are reviewed against this checklist before publication. The intent
is to describe what ScatterDEX does accurately, without language
that misleads users about untraceability or that signals
mixer-style functionality to regulators or exchange compliance
teams.

## Language we use

- "Private order matching" — describes the half-proof flow accurately.
- "Per-recipient amounts kept off the public log" — describes
  payout privacy without implying the recipient is hidden at claim.
- "Compliance-aware" / "KYC-aware" / "regulator-ready" — describes
  the optional `IdentityGate` + zk-X509 layer.
- "Self-custody" / "non-custodial" — the protocol does not hold
  user secrets.
- "Audited identity gate" — when the optional gate is configured.
- "Sanctions check at the contract boundary" — describes the
  `SanctionsList` hook present on state-transition functions.

## Language we do not use

The following phrases are not used in any external material. They
either misstate what the protocol does or invite a mixer
classification regardless of the technical reality.

- "Untraceable" / "untraceable transfers"
- "Anonymous cash-out" / "CEX off-ramp privacy"
- "Hide your funds" / "obscure the source"
- "Mixer" or "tumbler" — even as a comparison
- "Bypass / evade regulator" / "regulator-proof"
- "Exchange-undetectable" / "blockchain-analysis-proof"
- "Privacy coin" or "dark coin"
- "Anonymous airdrop" — drops use one-time per-recipient links, not
  anonymous claims; recipient address publishes at claim time
- "Mix your salary" — payroll amounts are private per recipient, but
  recipients are not anonymized at claim time

## Comparisons we use carefully

References to other privacy-preserving protocols are acceptable when
the comparison is precise about the structural similarity (e.g.
boundary transparency + optional private application state). They
are not used to argue regulatory equivalence ("this other project
got listed, so we will be fine"); each protocol's compliance
posture is judged on its own.

When comparing:

- Name the specific structural property being compared.
- Note where the projects differ in addition to where they overlap.
- Do not claim third-party regulatory blessing as our own.

## Required disclosures

Every user-facing app surface (landing page footer, app footer,
README) must include the standard prohibition notice. Wording in
README is canonical:

> *App name* is **not a mixer or anonymity tool**. Use is prohibited
> for money laundering, terrorist financing, sanctions evasion,
> evasion of statutory reporting (including Travel Rule), or any
> other illegal activity. [App-specific compliance feature note.]
> Operators may decline service and report suspicious activity as
> required by applicable law.

Equivalent localized wording is acceptable when the surface is
non-English, but the substance (named prohibition + operator
discretion) must be preserved.

## Review process

Public-facing changes that touch any of the following are reviewed
against this document before merge:

- Landing page hero / how-it-works / pricing / FAQ sections
- App READMEs
- Public docs site (`apps/docs`)
- npm package descriptions
- Press releases / blog drafts / sales decks
- CLI `--help` output

Suggested reviewers include at least one person who has read the
[Boundary Memo](./BOUNDARY-MEMO.md) and one person responsible for
the legal/compliance memo on file with external counsel.
