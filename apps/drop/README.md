# Scatter Drop

Sybil-resistant private airdrops. Recipients claim gaslessly, amounts
are hidden on-chain, and zk-X509 enforces real 1-person-1-claim.

## Target

Token launch teams, DAOs running governance distributions, NFT
projects rewarding holders. Today they ship Merkle distributors that
are bot-farmed within minutes and dumped immediately.

## MVP scope (this scaffold)

- `/` — campaign list + "new campaign" CTA
- `/campaigns/new` — 4-step wizard: token & supply → recipients (CSV /
  snapshot import) → sybil policy → claim window
- `/claim/[campaign]` — recipient-facing claim page (gasless, optional
  stealth address)

All routes use mock data. No SDK calls yet.

## Run

```bash
npm install
npm run dev   # http://localhost:3002
```

## Domain (planned)

`drop.zkscatter.xyz`

## Pricing (planned)

- 0.5% of distributed value, OR
- $500–$5,000 flat per campaign (smaller drops)
- White-label: $10K+

## Differentiators vs Galxe / Layer3 / Merkle distributor

- Real anti-sybil via zk-X509 (not heuristics)
- Recipient amounts hidden on-chain — reduces immediate dump pressure
- Gasless claim — typical claim rate +30–40%
- Embeddable claim widget (project keeps users on their own site)
