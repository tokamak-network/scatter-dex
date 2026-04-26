# Multi-Frontend Strategy

**One core, three personas.** ScatterDEX's contracts + ZK engine +
relayer network + shared orderbook are persona-agnostic; the UX layer
is not. We ship three distinct frontends rather than one
"do-everything" app.

## The three lines

| Line | App | Target | Channel | Revenue model |
| --- | --- | --- | --- | --- |
| **Pro** | `frontend/` (existing, to be repositioned) | Semi-pro / OTC traders, $20K–$1M positions | crypto-twitter, KOLs, OTC Telegram rooms | Per-trade fee 0.03–0.05% |
| **Pay** | `apps/pay/` (new) | Finance ops at small crypto-native companies & DAOs | DAO forums, Safe Apps directory, SEO vs Request Finance | MRR: $0 / $49 / $199 / Enterprise |
| **Drop** | `apps/drop/` (new) | Token launch teams, governance distributors | L2 partnerships, "anti-sybil airdrop tool" SEO | 0.5% of distributed value, or $500–$5K flat |

Mobile (`mobile/`) is a companion to **Pro** — same persona,
secondary device for monitoring + Quick Sign.

## Why split (not one product)

1. **CAC channels diverge.** Traders live on Twitter; finance ops live
   in Notion/Snapshot/Safe; project teams live in L2 ecosystem
   programs. One landing page can't speak all three.
2. **Compliance scope diverges.** Payouts (B2B), trading (KYC'd
   individual), airdrops (region-restricted) each need different
   policies. Frontend separation isolates regulatory blast radius.
3. **Pricing models diverge.** Per-trade vs MRR vs per-campaign — each
   needs its own checkout, billing, dashboards.
4. **Vocabulary diverges.** "Stealth address" reassures traders,
   confuses HR teams, excites token teams. Different words per app.

## What stays shared

- Contracts (PrivateSettlement, CommitmentPool, Registry, IdentityGate)
- ZK circuits & proofs (deposit / authorize / claim)
- Relayer network & shared orderbook
- (Future) `packages/sdk-ts` — typed TS client for the core
- (Future) `packages/ui` — design tokens & primitive components per
  brand theme

## Brand architecture

**Recommendation: master brand + sub-brand.**

- ScatterDEX as the master (trust anchor: ZK, regulator-ready, Tokamak)
- Sub-brands: ScatterDEX **Pro**, Scatter**Pay**, Scatter**Drop**
- Each gets its own subdomain (`pro.`, `pay.`, `drop.`) and visual
  treatment but shares logomark + footer trust signals (zk-X509,
  KISA-registered relayers, etc.)

Rationale: ZK + compliance is a hard story to retell. We pay that
once at the master brand and reuse it everywhere.

## Rollout order

1. **Foundation (3 weeks)** — extract `packages/sdk` + `packages/ui`.
   Without this, every app duplicates contract calls and styles.
2. **Pro reposition (2 weeks)** — workbench consolidation, copy
   rewrite, vs-Uniswap comparison metric. See `PRO_REPOSITION.md`.
3. **ScatterPay MVP (4 weeks)** — fastest path to MRR. Recurring
   payouts is the lock-in. See `SCATTERPAY_SPEC.md`.
4. **ScatterDrop MVP (4 weeks)** — biggest single-deal sizes (campaign
   fees in the $K–$10K range). Pair with one launch partner from
   week 1. See `SCATTERDROP_SPEC.md`.
5. **Mobile Quick Sign + ScatterPay recurring (4 weeks, parallel)**

Total: ~17 weeks from foundation → 3 frontends + mobile pairing
shipping.

## Decisions still open

- Do we white-label Drop for a marquee launch partner before public
  brand? (Tradeoff: faster validation vs. brand dilution.)
- Pay's free tier — true free or freemium with watermark on
  recipient claim page?
- Do all three apps require KYC, or only Pro? Drop probably does;
  Pay's recipients shouldn't.

These should be resolved before each app's launch sprint.
