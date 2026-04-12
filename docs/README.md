# zkScatter Documentation

Topic-organized docs. Start with [architecture/architecture-v2.md](architecture/architecture-v2.md) for the v2 system overview.

## architecture/
System-level architecture and decision records.
- [architecture-v2.md](architecture/architecture-v2.md) — v2 entry point (Half-proof + Relayer protocol + Dispute registry)
- [shared-orderbook.md](architecture/shared-orderbook.md) — current HTTP Trade Offer protocol
- [adr/](architecture/adr/) — Architecture Decision Records

## design/
Component design specs. Pre-implementation items are labeled in-document.
- [zk-escrow.md](design/zk-escrow.md), [zk-settle-stealth.md](design/zk-settle-stealth.md), [stealth-address-claim.md](design/stealth-address-claim.md)
- [circuit-split/](design/circuit-split/) — Half-proof circuit split (Phase 1, implemented)
- [relayer-protocol/](design/relayer-protocol/) — Waku gossip protocol (Phase 2, pre-implementation)
- [dispute-registry/](design/dispute-registry/) — Dispute + reputation (Phase 3, pre-implementation)
- [mobile/](design/mobile/) — Mobile proving fallback (pre-implementation)

## operations/
Deploy, run, and secure the system.
- [deployment.md](operations/deployment.md), [local-setup.md](operations/local-setup.md), [operations-guide.md](operations/operations-guide.md)
- [relayer-security.md](operations/relayer-security.md) — threat model (§1–§3 describe legacy v1 custodial model; Half-proof supersedes)
- [mev-protection.md](operations/mev-protection.md), [fee-architecture.md](operations/fee-architecture.md), [gas-cost-analysis.md](operations/gas-cost-analysis.md)

## guides/
User/developer walkthroughs.
- [zk-private-trading.md](guides/zk-private-trading.md) — user-facing flow
- [demo-script-en.md](guides/demo-script-en.md), [demo-script-ko.md](guides/demo-script-ko.md)
- [test-scenarios.md](guides/test-scenarios.md)

## research/
Whitepaper, patent draft, performance and archived analyses.
- [PAPER.md](research/PAPER.md), [PAPER-ko.md](research/PAPER-ko.md) — whitepaper (standard)
- [PAPER-academic.md](research/PAPER-academic.md), [PAPER-ko-academic.md](research/PAPER-ko-academic.md) — academic long-form
- [ids-draft.md](research/ids-draft.md) — patent disclosure draft
- [perf-proving-analysis.md](research/perf-proving-analysis.md)

---

## Known follow-ups
Internal cross-links inside moved docs may still reference old paths (e.g. `./architecture-v2.md`). Fix in-place as you encounter them. Removed: `papers/PAPER-v1-standard.md` (obsolete Split Hash-Lock design, replaced by zkScatter).
