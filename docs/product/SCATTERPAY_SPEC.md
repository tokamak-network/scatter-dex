# ScatterPay — MVP Spec

`apps/pay/` · target persona: P2 "Sora" (see `PERSONAS.md`)

## One-line product
> Send to many recipients in one private transaction. Recipients
> can't see each other's amounts.

## MVP scope (what ships in 4 weeks)

In:
- One-shot bulk payout (≤ 100 recipients)
- CSV paste / Safe import for recipient list
- Stealth-address claim (each recipient gets a unique link)
- Recipient claim page (gasless, 1-click)
- Payout status dashboard with claim tracking + reminders
- CSV / PDF accounting export

Out (post-MVP):
- Recurring payouts (week 5–6)
- Multi-token in one payout
- Email/Discord notification integrations (week 5–6)
- Multi-org / multi-team
- White-label

## Routes

| Route | Purpose | Notes |
| --- | --- | --- |
| `/` | Dashboard: stats + recurring + recent payouts | scaffold lives at `apps/pay/app/page.tsx` |
| `/payouts/new` | 3-step wizard: token → recipients → review | scaffold at `apps/pay/app/payouts/new/page.tsx` |
| `/payouts/[id]` | Payout status, recipient table, exports | scaffold at `apps/pay/app/payouts/[id]/page.tsx` |
| `/claim/[link]` | Recipient-facing 1-click claim | scaffold at `apps/pay/app/claim/[link]/page.tsx` |
| `/settings` | Source wallet, billing, team (post-MVP) | — |

## Data model (sketch)

```
Payout {
  id: string
  org_id: string
  token: { address, symbol, decimals }
  total_amount: string (uint256)
  source_wallet: address
  recipients: Recipient[]
  stealth: bool
  notify: { email: bool, discord: bool }
  created_at: timestamp
  on_chain_tx: hash | null
  status: 'draft' | 'submitted' | 'completed' | 'sweeping'
  fee_basis_points: number   // 10 = 0.1%
}

Recipient {
  id: string
  payout_id: string
  display_name: string
  email: string | null
  amount: string (uint256)
  // For stealth mode: each recipient gets a one-time stealth address
  stealth_address: address | null
  claim_link_token: string   // unique URL component for /claim/[link]
  claim_status: 'pending' | 'claimed' | 'expired'
  claimed_at: timestamp | null
  claim_tx: hash | null
}
```

## Critical flows

### A. Submitter creates payout (`/payouts/new`)

1. Pick token + source wallet
2. Paste CSV `name,address,amount` (validator runs live):
   - duplicate addresses → error
   - decimal mismatch (e.g. USDC has 6) → warning
   - sum vs declared total → must match
3. Choose options: stealth (default on), notification (default on)
4. Review screen with breakdown + fees
5. Sign once → core SDK calls deposit + multi-claim authorize
6. Server stores payout + recipient rows; generates claim links

### B. Recipient claims (`/claim/[link]`)

1. Land on page with their amount only
2. Connect wallet (or use existing session)
3. Choose stealth toggle (default on, recommended)
4. Tap "Claim — gasless"
5. SDK generates claim proof, relayer pays gas, funds land at chosen
   address
6. Success screen + tx hash

### C. Submitter monitors (`/payouts/[id]`)

- Live counts (claimed / pending)
- "Remind unclaimed" → triggers notification re-send
- "Export" → CSV (rows) + PDF (summary, zk-X509 signed for audit)

## SDK surface needed

Required from `packages/sdk` (extract from `frontend/app/lib/zk/*`):

```ts
sdk.payouts.deposit(token, total): Promise<{ commitmentId }>
sdk.payouts.authorizeMultiClaim({ recipients, stealth }): Promise<{ orderId }>
sdk.payouts.getStatus(orderId): Promise<PayoutStatus>
sdk.claim.byLink(linkToken, opts): Promise<ClaimResult>
sdk.export.signedAuditPdf(payoutId): Promise<Blob>
```

Server side (light backend):

```ts
POST /api/payouts                     // create draft + persist recipients
POST /api/payouts/:id/submit          // bind to on-chain commitment
GET  /api/payouts/:id                 // status + recipient list
POST /api/payouts/:id/remind          // re-send notifications
POST /api/claim/:link                 // claim handler (relayer-funded)
```

## Pricing (in spec because UI shows it)

- **Free** — 1 payout/mo, ≤ 10 recipients
- **Team $49/mo** — unlimited payouts, ≤ 100 recipients/run
- **Business $199/mo** — Safe integration, recurring, accounting
  export, ≤ 500 recipients/run
- **Enterprise** — talk to us

Per-payout fee: **0.1% of payout value** on top of plan, OR included
on Enterprise. Shown in the review step.

## GTM

**Week of launch:**
1. Submit to Safe Apps directory (lead time ~1 week, queue this in
   week 2)
2. Post in DAO ops Discords (Bankless, Llama, Karpatkey ops)
3. ProductHunt launch with "Mercury for crypto payroll" framing
4. Comparison post: "ScatterPay vs Request vs Sablier" (table)

**First-month metrics**
- 5 paying Team plan signups
- 1 Business plan signup with monthly recurring run
- ≥ $250K total payout volume processed

## Risks / open questions

- **KYC**: do submitters need KYC? Recipients should not (UX would
  break). Likely: submitters yes for ≥ $X/month.
- **Stealth UX gap**: recipients without an existing stealth keypair
  need a quick onboarding (one-click derive from wallet signature).
- **Safe import**: requires Safe Transaction Service API integration;
  add 1 week if Safe import lands in MVP.
- **Notification deliverability**: email is fine; Discord requires bot
  install per server. Push to post-MVP.

## File map

```
apps/pay/
├── app/
│   ├── layout.tsx
│   ├── globals.css
│   ├── page.tsx                    # dashboard
│   ├── payouts/
│   │   ├── new/page.tsx            # 3-step wizard
│   │   └── [id]/page.tsx           # payout detail
│   └── claim/
│       └── [link]/page.tsx         # recipient claim
├── package.json                    # next 16, react 19, tailwind 4
├── next.config.ts
├── tsconfig.json
└── README.md
```
