# Personas

These three personas drive the three frontends. Treat each as a
single named person when building screens — generic "users" produce
generic UX.

---

## P1 — "Jihwan" (Pro / mobile)

**Role**: Semi-pro / OTC trader. Day job in tech or finance, trades
on the side or full-time.

**Numbers**
- Position size: $20K–$1M per trade
- Frequency: 5–30 trades/month
- Tools today: MetaMask + Ledger, Uniswap, 1inch, CowSwap, Hyperliquid

**Pains (in order)**
1. **Front-running on size**: 1–3% lost to MEV on big swaps
2. **Public balance**: large wallets get watched, tracked, copy-traded
3. **Fear of Tornado-style mixers**: regulatory taint risk

**Decision criteria**
- Slippage ≤ Uniswap (provable, not just claimed)
- Wallet balance not exposed after a trade
- Provably legal — registered counterparties, audit trail
- Works on mobile (signs from phone while away from desk)

**One-line need**
> "Big trades, quietly — no front-running, no balance exposure, fully
> legal."

**Pricing willingness**: 0.03–0.05% per trade if slippage stays
better than Uniswap. Monthly volume tier discount earns loyalty.

**Channels to reach them**
- Crypto Twitter (KOLs in MEV/private trading space)
- OTC Telegram/Signal rooms (Korea, Hong Kong, Singapore)
- Discord servers focused on private DEX / privacy

---

## P2 — "Sora" (Pay)

**Role**: Finance lead / ops at a 5–50 person crypto-native company,
NFT studio, or DAO.

**Numbers**
- Recipients per run: 10–100 (employees, contractors, vendors)
- Frequency: monthly payroll + ad-hoc vendor settlement (~3x/month)
- Tools today: Safe (Gnosis) + Google Sheets + manual signing /
  Request Finance / Sablier streams / Toku for payroll

**Pains (in order)**
1. **Salaries leak on-chain**: every Safe batch reveals every
   employee's pay to the public — hurts retention and culture
2. **CSV → tx is manual and error-prone**: address typos, decimal
   mistakes
3. **Vendors see other vendors**: revealing one vendor's invoice to
   another harms negotiating power
4. **Tax / accounting export is a separate manual job**

**Decision criteria**
- Doesn't break their existing Safe workflow
- Recipients don't see each other's amounts
- Audit-grade export (signed, importable to QuickBooks / Xero)
- Reasonable monthly cost for a small team

**One-line need**
> "Pay everyone at once, privately, with an audit trail my CFO will
> sign off on."

**Pricing willingness**: $49–$199/month is in the small-SaaS impulse
zone. $500+/month requires CFO sign-off → longer sales cycle. Stay
under $200 for self-serve.

**Channels to reach them**
- Safe Apps directory (the single biggest channel — already in
  their workflow)
- DAO forums (Snapshot discussions, governance posts)
- Comparison content vs Request / Sablier / Toku
- Notion templates ("Crypto company payroll template" → linkbait)

---

## P3 — "Marcus" (Drop)

**Role**: Founder, growth lead, or token PM at a project shipping a
governance / community / NFT-utility token.

**Numbers**
- Distribution size: 10K–500K wallets per drop, $100K–$10M in token
  value
- Frequency: 1–4 campaigns / year
- Tools today: Merkle distributor + Galxe + Layer3 + Twitter

**Pains (in order)**
1. **Sybil farms**: a single farmer takes 5–30% of the drop with
   thousands of throwaway wallets
2. **Immediate dump**: public per-recipient amounts on-chain → bots
   pile into sells in the first hour
3. **Low claim rate**: 25–40% typical because recipients won't pay
   gas for unknown tokens
4. **Sybil heuristics are unfalsifiable**: Galxe / Layer3 score
   wallets but can't *prove* uniqueness

**Decision criteria**
- Real anti-sybil (1 person = 1 claim, provable)
- Claim rate uplift (gasless = +30–40% measured)
- Reduce immediate dump pressure (private amounts)
- Embeddable on the project's own site

**One-line need**
> "Get my token to real humans, not bot farms, without sparking an
> instant dump."

**Pricing willingness**: 0.5% of distributed value is fine for drops
≥ $100K. Flat-fee tier ($500–$5K) for smaller drops. White-label tier
($10K+) for big launches.

**Channels to reach them**
- L2 ecosystem partnerships (Tokamak, Optimism, Base)
- "Anti-sybil airdrop" SEO (high-intent keyword)
- Post-mortem content on famous sybil failures (Arbitrum, Jupiter)
- Twitter, since airdrop news is always Twitter-native

---

## Anti-personas (do NOT build for these in v1)

- **Casual retail trader** — Uniswap is fine for them; CAC too high
- **Institutional desk / fund** — wants OTC quotes, white-glove
  service; needs separate `apps/desk` later (P4)
- **Mixer-curious user** — wrong fit; we're regulator-ready by design
