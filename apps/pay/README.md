# Scatter Pay

One-to-many private payouts for crypto-native companies and DAOs.
Send payroll, grants, and bonuses without leaking who got what.

## Scope

Pay covers **one-to-many payouts where the per-recipient amount is sensitive**:

- **Payroll** — monthly salaries to employees
- **Grants** — DAO grants from a Snapshot result or working group
- **Bonuses** — one-off bonus rounds where size differences matter
- **Contractor batch** — settling a wave of freelancers at once

One-to-one vendor invoices (B2B AP) and employee expense reimbursements are
handled by separate apps in this repo, not here.

## Target

Finance / ops people at 5–50 person crypto companies, DAOs, and agencies.
Today they juggle Safe + spreadsheets + manual transfers, and every payout
run leaks every recipient's amount on-chain.

## MVP scope (this scaffold)

- `/` — landing (positioning, use cases, how it works, pricing)
- `/dashboard` — pool balance, recent payouts, category tabs
- `/payouts/new` — 4-step wizard:
  1. Choose template (payroll / grants / bonus / contractor)
  2. Token & total (label, chain, token, source wallet)
  3. Recipients (CSV with live validation)
  4. Review & sign
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

- Free — 3 payouts/mo, ≤ 20 recipients
- Team $19/mo — unlimited payouts, ≤ 100 recipients/run
- Business $79/mo — Safe deep integration, multi-sig approvals, audit-grade PDF export

Plus 0.05% of payout value per run, capped at $20. Free until Dec 31, 2026.

## Differentiators vs Request Finance / Sablier / Toku

- Recipients can't see each other's amounts (per-recipient claim links)
- Single on-chain transaction for N recipients
- Templates for payroll / grants / bonuses with the right export per case
- zk-X509 signed accounting export for tax/audit

## Compliance

Scatter Pay is **not a mixer or anonymity tool**. Use is prohibited
for money laundering, terrorist financing, sanctions evasion, evasion
of statutory reporting (including Travel Rule), or any other illegal
activity. The protocol is designed to support compliant payroll,
grants, and bonus payouts with private per-recipient amounts and
optional zk-X509 identity gating. Operators may decline service and
report suspicious activity as required by applicable law.
