# zkScatter Documentation

Topic-organized docs. Start with [architecture/architecture-v2.md](architecture/architecture-v2.md) for the v2 system overview.

## architecture/
System-level architecture and decision records.
- [architecture-v2.md](architecture/architecture-v2.md) — v2 entry point (Half-proof + Relayer protocol + Dispute registry)
- [shared-orderbook.md](architecture/shared-orderbook.md) — current HTTP Trade Offer protocol
- [adr/](architecture/adr/) — Architecture Decision Records

## design/
Component design specs. Status is labeled in-document.
- [circuit-split/](design/circuit-split/) — Half-proof primitive (implemented)
- [contracts/](design/contracts/) — 컨트랙트 설계 (한글, current)
- [proof-system/](design/proof-system/) — ZK 증명 시스템 설계 (한글, current)
- [relayer-kyc-onboarding/](design/relayer-kyc-onboarding/) — 2-gate operator onboarding (implemented)
- [async-settlement-protocol.md](design/async-settlement-protocol.md), [commitment-history-indexer.md](design/commitment-history-indexer.md), [relayer-claim-fee-policy.md](design/relayer-claim-fee-policy.md) — implemented protocol/infra specs
- [pay-eoa-claim-inbox.md](design/pay-eoa-claim-inbox.md), [pay-wizard-categories-and-per-row-claim.md](design/pay-wizard-categories-and-per-row-claim.md) — Pay app specs (latter: WIP)
- [relayer-protocol/](design/relayer-protocol/) — Waku gossip protocol (Phase 2, pre-implementation)
- [dispute-registry/](design/dispute-registry/) — Dispute + reputation (Phase 3, pre-implementation)
- [mobile/](design/mobile/) — Mobile proving fallback (pre-implementation)
- [archive/](design/archive/) — superseded/completed designs (stealth, legacy settle, finished migrations)

## operations/
Deploy, run, and secure the system.
- [deployment.md](operations/deployment.md), [local-setup.md](operations/local-setup.md) (native) / [local-setup-docker.md](operations/local-setup-docker.md) (Docker), [ai-bringup-prompt.md](operations/ai-bringup-prompt.md) (AI one-shot bring-up), [operations-guide.md](operations/operations-guide.md)
- [relayer-security.md](operations/relayer-security.md) — threat model (§1–§3 describe legacy v1 custodial model; Half-proof supersedes)
- [mev-protection.md](operations/mev-protection.md), [fee-architecture.md](operations/fee-architecture.md), [gas-cost-analysis.md](operations/gas-cost-analysis.md)

## guides/
User/developer walkthroughs.
- [zk-private-trading.md](guides/zk-private-trading.md) — user-facing flow
- [demo-script-en.md](guides/demo-script-en.md), [demo-script-ko.md](guides/demo-script-ko.md)
- [test-scenarios.md](guides/test-scenarios.md)

## security/
Smart-contract hardening notes for external audit onboarding.
- [HARDENING.md](security/HARDENING.md) — invariant suites, Slither config, gas/storage gates, manual verification checklist

## research/
Patent draft, performance and archived analyses.
- Whitepaper: [../developers/docs/whitepaper.mdx](../developers/docs/whitepaper.mdx) — replaces the removed `PAPER*.md` drafts (see Known follow-ups)
- [ids-draft.md](research/ids-draft.md) — patent disclosure draft
- [perf-proving-analysis.md](research/perf-proving-analysis.md)

---

## Known follow-ups
Internal cross-links inside moved docs may still reference old paths (e.g. `./architecture-v2.md`). Fix in-place as you encounter them. Removed: `papers/PAPER-v1-standard.md` (obsolete Split Hash-Lock design, replaced by zkScatter); `research/PAPER*.md` whitepaper drafts (described the deprecated monolithic `settle.circom` path — superseded by [../developers/docs/whitepaper.mdx](../developers/docs/whitepaper.mdx), but some docs still cite `PAPER.md` sections, e.g. `security/AUDIT.md`, `design/*/design.md`, `research/ids-draft.md`).
