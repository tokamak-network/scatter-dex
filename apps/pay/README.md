# Scatter Pay

Private bulk payouts for small crypto-native companies and DAOs.
One transaction, N recipients, zero leaks between recipients.

## Target

Finance / ops people at 5–50 person crypto companies, DAOs, agencies.
Today they juggle Safe + spreadsheets + manual transfers, and every
payroll run leaks every employee's salary on-chain.

## MVP scope (this scaffold)

- `/` — dashboard (recurring payouts, recent runs, "new payout" CTA)
- `/payouts/new` — 3-step wizard: token & total → recipient list (CSV
  paste) → review & sign
- `/payouts/[id]` — payout status, per-recipient claim state, reminders
- `/claim/[link]` — recipient-facing 1-click claim page

All routes use mock data. No SDK calls yet.

## Run

```bash
npm install
npm run dev   # http://localhost:4001
```

## Domain (planned)

`pay.zkscatter.xyz`

## Pricing (planned)

- Free — 1 payout/mo, ≤ 10 recipients
- Team $49/mo — unlimited payouts, ≤ 100 recipients/run
- Business $199/mo — Safe integration, recurring, accounting export

## Differentiators vs Request Finance / Sablier / Toku

- Recipients can't see each other's amounts (stealth claim links)
- Single on-chain transaction for N recipients
- zk-X509 signed accounting export for tax/audit
