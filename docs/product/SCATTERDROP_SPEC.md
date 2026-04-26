# Scatter Drop — MVP Spec

`apps/drop/` · target persona: P3 "Marcus" (see `PERSONAS.md`)

## One-line product
> Sybil-resistant private airdrops. Recipients claim gaslessly,
> amounts are hidden on-chain, zk-X509 enforces 1-person-1-claim.

## MVP scope (4 weeks)

In:
- Campaign creation (4-step wizard)
- Recipient sources: CSV upload, Snapshot proposal voters, NFT
  collection holders (one of these is enough for MVP — pick Snapshot
  first, it's the most common ask)
- Sybil policy: zk-X509 required, min wallet activity threshold
- Stealth-address claim (default on)
- Gasless claim (default on)
- Live campaign dashboard (claim rate, sybil blocked count)
- Recipient claim page

Out (post-MVP):
- Embeddable widget (`<iframe>` for project's own site)
- Twitter/X live counter widget
- Multi-tier rewards (NFT holders × tier)
- Galxe / Layer3 import bridges
- White-label / custom domain

## Routes

| Route | Purpose | Notes |
| --- | --- | --- |
| `/` | Campaign list + stats | scaffold at `apps/drop/app/page.tsx` |
| `/campaigns/new` | 4-step wizard | scaffold at `apps/drop/app/campaigns/new/page.tsx` |
| `/campaigns/[id]` | Live dashboard, claim curve, sybil block log | post-MVP, currently linked to `/claim/[id]` |
| `/claim/[campaign]` | Recipient claim | scaffold at `apps/drop/app/claim/[campaign]/page.tsx` |
| `/widgets/[id]` | Embeddable iframe (post-MVP) | — |

## Data model (sketch)

```
Campaign {
  id: string
  project_name: string
  token: { address, symbol, decimals }
  total_supply: string
  source_type: 'snapshot' | 'nft' | 'csv'
  source_ref: string                  // proposal id / nft addr / csv hash
  eligibility_count: number
  sybil_policy: {
    require_zkX509: bool
    min_wallet_activity_months: number
  }
  privacy: {
    stealth_claim: bool
    gasless: bool
  }
  window: { starts_at, ends_at }
  recover_unclaimed: bool
  status: 'draft' | 'live' | 'window_closed' | 'swept'
  on_chain_root: bytes32              // merkle root of eligible set
}

ClaimAttempt {
  id: string
  campaign_id: string
  wallet: address
  zkX509_id_hash: bytes32 | null      // unique per real person
  result: 'success' | 'sybil_blocked' | 'ineligible' | 'expired'
  claimed_amount: string | null
  stealth_address: address | null
  tx: hash | null
  at: timestamp
}
```

`zkX509_id_hash` is the privacy-preserving 1-person fingerprint;
duplicates within the same campaign reject.

## Critical flows

### A. Project team creates campaign (`/campaigns/new`)

1. Token + supply
2. Recipients source (Snapshot proposal URL → fetch voters)
3. Sybil & privacy toggles (defaults: zk-X509 on, stealth on,
   gasless on, 3mo activity on)
4. Window + recovery
5. Sign & launch → SDK builds merkle root, stores campaign on-chain

### B. Recipient claims (`/claim/[campaign]`)

1. Land on page → connect wallet
2. SDK checks eligibility (merkle inclusion + activity threshold)
3. If `require_zkX509`: redirect to zk-X509 verify (prove not
   already claimed in this campaign)
4. Choose stealth toggle
5. Tap "Claim — gasless" → relayer-funded claim
6. Success

### C. Project team monitors (`/campaigns/[id]`)

- Live claim rate vs industry baseline (24%)
- Sybil blocked count (the headline metric to brag about on Twitter)
- Per-day claim curve
- Anomaly alerts (sudden spike in failed eligibility = potential bot
  scan)

## SDK surface needed

```ts
sdk.drop.createCampaign(spec): Promise<{ campaignId, claimUrl }>
sdk.drop.eligibility(campaignId, wallet): Promise<EligibilityResult>
sdk.drop.claim(campaignId, opts): Promise<ClaimResult>
sdk.drop.stats(campaignId): Promise<CampaignStats>
sdk.zkX509.proveUniquePerCampaign(campaignId): Promise<Proof>
```

Light backend:

```ts
POST /api/campaigns
GET  /api/campaigns/:id
GET  /api/campaigns/:id/eligibility?wallet=
POST /api/campaigns/:id/claim
GET  /api/campaigns/:id/stats
```

## Pricing

- **0.5% of distributed token value** on successful claims, OR
- **Flat $500 / $1.5K / $5K** by campaign size tier (small drops
  prefer flat)
- **White-label $10K+** (post-MVP)

## GTM

- **Anchor partner**: line up one Tokamak ecosystem token launch as
  the inaugural Scatter Drop campaign before public launch. Generates
  the case study.
- **Comparison content**: "How Arbitrum lost 7% of their drop to
  sybils — and what to do instead" → tool demo
- **L2 ecosystem program submissions**: Tokamak / Base / Optimism
  ecosystem fund pages
- **SEO**: "anti sybil airdrop", "private airdrop tool", "merkle
  distributor alternative"

## Differentiators (paste this in marketing copy)

| | Merkle distributor | Galxe / Layer3 | **Scatter Drop** |
| --- | --- | --- | --- |
| Anti-sybil | none | heuristics | **zk-X509 proof** |
| Recipient gas | recipient pays | recipient pays | **gasless** |
| Per-recipient amount privacy | public | public | **hidden on-chain** |
| Embeddable | no | partial | **yes (post-MVP)** |
| Audit export | manual | none | **zk-X509 signed PDF** |

## Risks

- **Recipient zk-X509 onboarding**: if recipient hasn't done zk-X509
  before, claim flow adds 30–60s. Solution: cache result across
  campaigns ("you're already verified"); accept higher friction on
  first claim.
- **Eligibility list size**: Snapshot voter sets can be 50K+. Merkle
  root is fine; UI for project team to preview a sample is needed.
- **Regional restrictions**: some jurisdictions treat airdrops as
  income / require KYC. Make geo-block optional per campaign.

## File map

```
apps/drop/
├── app/
│   ├── layout.tsx
│   ├── globals.css
│   ├── page.tsx                       # campaign list
│   ├── campaigns/
│   │   └── new/page.tsx               # 4-step wizard
│   └── claim/
│       └── [campaign]/page.tsx        # recipient claim
├── package.json
├── next.config.ts
├── tsconfig.json
└── README.md
```
