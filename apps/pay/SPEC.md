# Scatter Pay — Product Spec

> **Historical note (Phase 2.4d, 2026-05-12).** The original spec
> described a stealth-address recipient model. The stealth surface
> has since been retired (see ADR 0001); recipients are now
> identified by their regular wallet address and the `scanInbox`
> helper / "stealth" references below are historical context only.

A user-friendly payments wrapper on top of zkScatter (private DEX with
zk-X509 compliance). Reuses existing protocol primitives — does not
introduce new contracts or circuits.

## Table of contents

1. [Positioning](#1-positioning)
2. [Why this fits zkScatter](#2-why-this-fits-zkscatter)
3. [Hiding protocol jargon](#3-hiding-protocol-jargon)
4. [Sitemap](#4-sitemap)
5. [Per-page spec](#5-per-page-spec)
6. [Off-chain components](#6-off-chain-components-pay-needs)
7. [Sender end-to-end journey](#7-sender-end-to-end-journey)
8. [Recipient end-to-end journey](#8-recipient-end-to-end-journey)
9. [Notification system](#9-notification-system)
10. [Source notes & funding](#10-source-notes--funding)
11. [Pay backend API surface](#11-pay-backend-api-surface)
12. [Auth & multi-tenant](#12-auth--multi-tenant)
13. [Data model summary](#13-data-model-summary)
14. [Build order](#14-build-order)
15. [Open questions](#15-open-questions)
16. [Out of scope](#16-out-of-scope-handled-by-other-apps)

## 1. Positioning

**Target users.** Finance / ops at 5–50 person crypto companies and DAOs.
They run payroll, grants, bonuses, and contractor batches today using
Safe + spreadsheets. Each run leaks every recipient's amount on-chain.

**One-liner.** "Send payroll, grants, and bonuses without leaking who got
what — one signature, recipients claim privately."

**Scope.** One-to-many payouts where the per-recipient amount is sensitive.
Vendor 1:1 invoices and employee expense reimbursements live in separate
apps and are out of scope here.

**Templates inside scope.**
- Payroll — monthly salaries to employees
- Grants — DAO grants from a Snapshot result or working group
- Bonus — one-off bonus rounds
- Contractor batch — settling a wave of freelancers

## 2. Why this fits zkScatter

zkScatter already supports the entire mechanism we need — Pay just
re-labels it for finance ops:

| Pay UX term | zkScatter mechanism |
|---|---|
| Pool balance | 에스크로 자산 (CommitmentPool) |
| New payout | Self-trade order (USDC → USDC), 1:N split |
| Recipients | "받을 주소 1~N개" |
| Per-recipient amount | "주소별 금액" |
| Available to claim from | "주소별 시간차 (delay)" |
| Claim link (URL with secret) | "주소별 비밀번호" delivered off-chain |
| Sign & submit | "주문 서명 → 릴레이어 전달" |
| Recipient claim | claim with `secret` + Merkle inclusion proof |
| Cancel order (pre-settlement only) | `cancelPrivate` (`callCancel`) |
| Identity verification | zk-X509 (one-time, then hidden) |
| Relayer selection | Auto-pick default; expose only in Advanced |
| Gasless claim | 릴레이어 통한 claim |

**Same-token payment.** USDC → USDC (1:1) self-trade is the payment shape.
The order semantics are unchanged; the "buy side" is the same address set
the sender controls behind stealth claim hashes for the recipients.

## 3. Hiding protocol jargon

The protocol exposes claimHashes, secrets, delays, relayers, EdDSA keys,
zk-X509. Finance ops should never see those words. UX rules:

- **Secret = URL fragment.** Auto-generated per recipient. Embedded in the
  claim link (`/claim/<id>#<secret>`) so the recipient never types it.
  The sender never types it either. Pay's notification email/Discord DM
  carries the link.
- **Delay = "Available to claim from: <date>"**. UX default is a **date
  picker** (org timezone, 00:00 of that day). Advanced toggle exposes
  a date + time field for cases that need hour-precision. The protocol
  stores this as `releaseTime` (unix seconds). Default = now. There is
  **no expiry** — the recipient can claim any time after this date,
  forever.
- **Relayer = auto.** Round-robin from `loadActiveRelayers()`. The Funds
  wizard step exposes the selected relayer + max-fee cap; advanced users
  can override.
- **EdDSA / commitment / nullifier = invisible.** Generated and stored
  by `useWallet()` and the SDK note adapter.
- **zk-X509 = one-time onboarding.** First payout shows "Verify your
  organization to start sending" → reuses `frontend/app/identity` flow.
- **Pool balance = "Your USDC ready to send"**. Top up step is framed
  as "Top up balance," not "deposit to commitment pool."
- **Notes = "Source funds (lots)"**. Plural escrowed lots are surfaced
  in the Funds step as a list ("lot-3 · 50 USDC · deposited Apr 5") so
  finance ops can audit which lot funded which run, but the word
  "commitment" never appears in the UX.

## 4. Sitemap

```
/                              Marketing landing
/onboarding                    First-run: connect wallet → verify org → top up
/dashboard                     Sender home: balance, recent runs, approvals
/payouts/new                   Wizard (5 steps)
/payouts/[id]                  Run detail (manual notification trigger)
/payouts/[id]/payslip/[row]    Per-recipient PDF (printable)
/recipients                    Address book — name, address, email, preferredChannel
/approvals                     Multisig / threshold approvals queue
/audit                         Activity log (immutable)
/settings/organization         Company name, logo, registration #
/settings/team                 Members & roles
/settings/templates            Payslip & email templates
/settings/notifications        Channels (email, Discord) + per-template subject/body
/settings/billing              Plan, invoices, usage
/inbox                         Recipient home: pending claims (stealth scan)
/claim/[id]#<secret>           Recipient claim page
```

## 5. Per-page spec

For each page: **purpose · flow · primitives used · Pay-only additions**.

### 5.1 `/onboarding`
**Purpose.** First-run flow.

**Flow.**
1. Connect wallet (`useWallet`).
2. Verify organization (zk-X509) — reuses `frontend/app/identity`.
3. Top up balance — `ensureAllowance` + `callDeposit`.
4. Land on `/dashboard`.

**Pay-only.** Org profile capture (company name, logo) — fed into payslips.

---

### 5.2 `/dashboard`
**Purpose.** Sender home.

**Sections.**
- **Balance card.** Available USDC in pool. CTAs: Top up, Withdraw.
- **Stats.** This month total · Pending claims · Saved on gas (with
  hover explaining the calculation).
- **Approvals (if multisig).** Items waiting for the current user's signature.
- **Recent runs.** Tabs: All / Payroll / Grants / Bonus / Contractor.
  Each row shows label, category badge, total, claim progress.

**Primitives used.**
- `loadCommitmentInsertedHistory` for sender's runs.
- Pool balance via `getAvailableBalance` from `@zkscatter/sdk/notes`
  (added in PR #473) reading the local `useVault().notes`.

**Pay-only.** Category badges, tabs, filter, period picker (this/last
month, Q1, year), bulk export.

---

### 5.3 `/payouts/new` — Wizard, 5 steps

The wizard is structured as 5 steps (Stepper at top, Back/Next nav at
the bottom). Validation gates the Next button.

#### Step 1 — Template
- 4 template cards: Payroll · Grants · Bonus · Contractor.
- Picking a card pre-fills:
  - `label` (e.g. "April payroll")
  - `defaultToken` (USDC for stable templates, configurable per template)
  - `identifierLabel` ("Employee", "Recipient", "Contractor")
  - `reasonLabel` (optional — proposal link / approver / invoice ref)
  - `sampleCsv` (4–5 rows of demo data)
  - `exportNote` (template-specific footer for the audit export)
- Sender can change anything later in subsequent steps.

#### Step 2 — Token
**Fields.**
- **Run label** (string, required) — defaults to template default; also
  surfaces in the audit log and payslip subject.
- **Chain** — read-only, derived from the connected wallet's `chainId`.
  Pay is single-network per build today; a multi-chain registry
  (`PAY_NETWORKS`) is a follow-up. Wrong-chain warning in the header
  pill stays visible.
- **Token** — `USDC / USDT / ETH / TON` from `LAUNCH_TOKENS`.

**Display.**
- **Pool balance card** for the selected token: "Available X USDC across
  N notes." Hint surfaces the existence of multiple lots; the Funds step
  shows the per-lot breakdown.
- Helper copy: *"Sender = the wallet connected in the header. Pay spends
  your already-deposited notes — the wallet only signs the proof, no
  transfer-from happens at sign time. Top up the source notes in the
  Funds step."*

**No recipient input here. No Required / Shortfall.** Step 2 is purely
about scoping the token + label so subsequent steps know what currency
to operate in.

#### Step 3 — Recipients
**Header actions.**
- **+ Add from address book** → opens picker (multi-select with group
  filter; selected rows fill the CSV).
- **Upload CSV** → file picker; parses `name,address,amount[,email]`.
- **Import from Safe** → reads pending Safe txs and pre-fills.

**Body.**
- CSV textarea — `<identifier>,address,amount` one per line.
- Reason input (only when template has `reasonLabel`).
- Preview table — read-only, validation surfaced inline.
- Validation list — max 5 issues shown:
  - Invalid address (regex `/^0x[a-fA-F0-9]{40}$/`)
  - Duplicate address
  - Invalid amount (rejects non-numeric, non-positive, separators
    auto-stripped)
  - Empty row guards
- **Claim schedule** box:
  - "Available from" date picker (single global date, all rows share)
  - Helper text: "Recipients can claim any time after this date — there
    is no expiry."
  - Phase C+: per-row override (CSV column 4)
- **Privacy toggles** (Phase B+):
  - "Send via stealth address" (default on)
  - "Notify recipients by email / Discord" (default on — gate on
    address book entries having contact info)

**Validation.** Step 3 cannot advance to Step 4 until:
- ≥ 1 row
- Every row passes address + amount validation
- No duplicates
- Total > 0
- `claimFrom` is set (post-mount effect populates default)

#### Step 4 — Funds
**Purpose.** Confirm the **escrow source** for this run. Splits into
three concerns: relayer, fee, source notes.

**Relayer.**
- Selected relayer (auto-picked = first online from
  `loadActiveRelayers()`): name, address (mono short), online indicator.
- Override link → dropdown of online relayers; manual selection
  surfaces relayer-specific fee.
- When `registryConfigured === false`: show "No relayer registry
  configured — set NEXT_PUBLIC_PAY_RELAYER_REGISTRY" and disable Sign.

**Max relayer fee.**
- Numeric input, basis points. Default `30` (0.3%). Org default lives
  in `/settings/organization` (Phase E).
- Relayers can charge ≤ this; the wizard uses the cap for all
  shortfall math so "Required to escrow" never under-counts.

**Required & fee math.**
- `Required (recipients) = Σ row.amount`
- `Fee at max = Required × maxFeeBps / 10_000`
- `Total to escrow = Required + Fee at max`

**Source notes (auto-pick).**
- Available pool: "X USDC across N notes."
- Auto-pick algorithm — see [§10](#10-source-notes--funding):
  - Largest-first greedy; the last picked note covers the partial
    spend so change is returned as a new note via
    `AuthorizeProofInput.newSalt`.
- Selected source notes list:
  ```
  • lot-3 · 50 USDC · deposited Apr 5
  • lot-1 · 30 USDC · deposited Mar 12
                       ─────────
                       80 USDC
  Change after run:    12 USDC (new note)
  ```
- "**Change selection**" link → modal with checkboxes (Phase E manual
  override).

**Shortfall handling.**
- If `Total to escrow > Available`: red banner + "Top up X USDC" CTA.
- CTA opens an in-wizard Deposit dialog:
  - Amount input (pre-filled to shortfall, editable).
  - Token (locked to current selection).
  - "Confirm" → `ensureAllowance` + `generateDepositProof` +
    `callDeposit` via the connected wallet.
  - On success: vault adds the new note → wizard re-evaluates → CTA
    disappears once shortfall is 0.

**No on-chain calls happen here in Phase A.** The wizard fires
[`dryRunDeposit`](./app/payouts/new/page.tsx) which logs the inputs
to console. Phase B replaces the body with the real calls.

#### Step 5 — Review & sign
**Summary.** Definition list of every input from steps 1–4:
- Template, label, chain, token
- Recipient count + total
- Selected relayer + max fee + total to escrow
- Source notes + change
- Available-from date (and per-row schedule overrides if any)
- Reason / proposal link (template-dependent)
- Stealth on/off · notify on/off
- Estimated gas, Pay fee, signing-plan summary

**Irreversible warning.**
- Bold "This cannot be reversed" callout above Sign.
- For `total ≥ LARGE_AMOUNT_THRESHOLD` (default $50k, org override in
  `/settings/organization`): an extra confirmation modal that re-shows
  the total, recipient count, and the warning. User must type the
  number to confirm (Phase E hardening).

**Signing plan.**
- When `batches.length > 1` (recipients > 16), show:
  - "X recipients exceed the per-settlement cap of 16 — Pay will split
    into N batches, requiring N signatures."
  - List per-batch claim count + total.
  - Progress UI during signing: "Signing 2 of 3…" driven by the
    proving / signing layer (e.g. `generateAuthorizeProof` prove
    options) — `splitPayout` itself only chunks the recipient list.

**Sign & submit.**
- Derives the EdDSA key via `useEdDSAKey().derive()` once per session.
- For each batch:
  1. Build `AuthorizeProofInput` (note + leafIndex + merkleProof from
     CommitmentTreeProvider, claims, relayer, eddsaPrivateKey, etc.).
  2. `generateAuthorizeProof(input)` — opens the prove worker.
  3. `callSettleAuth(signer, settlementAddress, ...)` — submits to
     relayer.
  4. Add residual change note to vault.
- On success: redirect to `/payouts/[id]` (the new run record).
- On failure: surface error inline with a retry per batch (e.g.
  "Relayer rejected: maxFee too low → bump to 50 bps and retry batch
  2/3").

**Failure modes handled.** Wallet disconnect, wrong chain, insufficient
balance (with inline deposit), relayer down (try next), order rejected,
user rejects signature, mid-batch failure (retry just that batch).

---

### 5.4 `/payouts/[id]` — Run detail
**Purpose.** Sender's run detail + post-send notification & ops console.

**Header.** Label, date, template badge, on-chain tx (link to
explorer), zk-X509 audit signature, run status (settled / partially
settled / failed).

**Stats.** Total · Claimed (n/N) · Available now · Locked (claim-from
in future) · Notified (n/N).

**Top action bar (post-settle).**
- **📧 Send claim emails to all recipients** — primary CTA when 0/N
  notifications have been sent. Sends one email per recipient with
  their unique claim link. After the first batch fires, this becomes
  "Resend to unclaimed (N pending)."
- **📥 Download all payslips (zip)** (Phase D).
- **🔁 Run again** — clones the recipient list + amounts into a fresh
  wizard.
- **📤 Export** — CSV / PDF / signed JSON (Phase E).

**Recipient table.** Per row: name, masked address, amount, status,
claim-from date, notification status, claimed-at.

| Notification status | Meaning | Trigger |
|---|---|---|
| ⏳ Queued | sender hit "Send" but provider hasn't acked | API call in flight |
| ✉ Sent | Postmark/SES accepted | provider response |
| 📬 Delivered | recipient inbox ack (webhook) | provider webhook |
| 👁 Opened | tracking pixel hit | provider webhook |
| 🖱 Clicked | tokenized claim-link redirect hit | Pay backend |
| ✓ Claimed | settle nullifier seen on-chain | event listener |
| ⚠ Bounced | hard bounce | provider webhook |

**Per-row actions (kebab menu).**
- Copy claim link
- **Send email** (visible if not yet sent for this row) /
  **Resend email** (if already sent)
- **Send Discord DM** (if recipient has `discordHandle`)
- Edit memo / add reason
- Print payslip → `/payouts/[id]/payslip/[row]`
- Email payslip (separate from claim notification — sends the
  PDF after claim is confirmed)

**Bulk row actions.**
- Select rows → bulk Send / Resend / Print / Export.
- "Remind unclaimed" only includes rows with `Sent` but not `Claimed`
  for ≥ 24h.

**Recipient address rotation.**
- If a recipient claims using a different wallet, the row updates
  "Claimed by 0x... (sub-address)" — the protocol's stealth derivation
  handles the binding.

**Primitives used.**
- `loadCommitmentInsertedHistory` (subscribe for live claim updates).
- Notification dispatch — see [§9](#9-notification-system).

**Note on lifecycle.** Once a payout is settled, the recipient can
claim forever — there is no expiry. The sender cannot reclaim a
settled payout. `callCancel` only works on orders that haven't settled
yet (in the orderbook). Pay's UX must therefore make the Review step
very explicit ("once signed, this cannot be reversed").

**Pay-only.** Status simplification (claimed / available / locked-until-date),
payslip generation, manual notification trigger, bulk reminder + channel
selection, signed export.

---

### 5.5 `/payouts/[id]/payslip/[row]` — Individual statement (PDF)

A printable, single-recipient document. Templates per category:

- **Payroll**: Company name + reg #, period, gross, deductions
  (withholding %), net, claim-by date, employer signature line.
- **Grants**: DAO name, proposal link, grant amount, period,
  zk-X509 attestation footer.
- **Contractor**: Invoice reference, gross, sole-proprietor tax line.
- **Bonus**: Reason, approver, gross, net.

Render server-side (Node + Puppeteer or React-PDF) so the same artifact
is downloadable by both the sender (for accounting) and the recipient
(for personal records). **Both copies are signed with the org's
zk-X509 key** so any third party can verify authenticity.

---

### 5.6 `/recipients` — Address book

**Purpose.** Single source of truth for who the org pays. Replaces the
spreadsheet finance teams use today.

#### Data model
```ts
interface Recipient {
  id: string;                     // uuid (Pay backend)
  orgId: string;                  // tenant scope
  name: string;                   // required
  walletAddress: string;          // 0x40-hex, required, may rotate
  walletHistory?: string[];       // prior addresses (for audit)
  email?: string;                 // optional but required for email channel
  discordHandle?: string;         // e.g. `alice#1234` or DiscordID
  slackHandle?: string;           // `@alice` or Slack memberId
  preferredChannel?: "email" | "discord" | "slack";
  role?: string;                  // free-form, e.g. "Engineer", "Vendor"
  groups?: string[];              // tags, e.g. ["engineering", "Q2-grants"]
  taxId?: string;                 // for payslips (encrypted at rest)
  notes?: string;                 // internal memo
  createdAt: number;              // ms epoch
  updatedAt: number;
  archivedAt?: number;            // soft delete
}
```

#### Page UI
- **Table:** name, address (mono short), email, discord, role, groups,
  last paid (date + amount), # of runs.
- **Search:** by name / address / email / group.
- **Filters:** by group, by role, by "has email" flag.
- **+ Add Recipient** — modal form with the fields above; address
  validates as a checksummed 0x40-hex.
- **Bulk import** — CSV with header row. Maps unknown columns to
  `notes`. Conflict resolution:
  - same wallet, different name → "merge" (keeps latest name) or
    "create duplicate" (rare — surfaces an alert).
  - same name, different wallet → creates a new Recipient and asks
    "Replace existing 'Alice'? (keeps her wallet history)".
- **Bulk export** — signed CSV (org's zk-X509).
- **Test-send** ($0.01) to verify a fresh address is live (Phase E).
- **Per-recipient detail page** — shows the full payment history, all
  prior claim links + statuses, and a "Send arbitrary message"
  console (for ad-hoc reminders outside a run).

#### Wizard integration
- Step 3 "Recipients": **+ Add from address book** opens a multi-select
  modal scoped to the current org.
- Selecting a **group** fills the CSV with all that group's members
  (one row per member, amount blank — sender fills).
- Per-row edit allowed before sending.
- Address-book lookups happen client-side (cached in IndexedDB);
  initial fetch from Pay backend on first open.

#### Privacy
- Address book is **off-chain** (Pay backend only). Recipient PII
  never touches the protocol or any block explorer.
- Stealth send still applies — a recipient's *address* on-chain may
  rotate per run; the address book stores the canonical "current"
  address but per-run stealth derivation is independent.
- Storage MVP: localStorage (single device) → upgrade to Pay backend
  in Phase E.

#### Validation rules
- name: required, ≤ 64 chars, non-empty after trim.
- walletAddress: required, valid 0x40-hex, EIP-55 checksum tolerated.
- email: optional, RFC-compliant.
- groups: free-form tags, suggested set populated from existing tags
  in the org's recipients.

---

### 5.7 No scheduling page

Pay does **not** schedule, recur, or auto-execute runs. Each payout is a
one-shot multi-transfer the sender signs at the time they want to send.
Convenience is provided via the **"Run again from <previous run>"**
button on `/payouts/[id]`, which opens the wizard pre-filled with the
prior recipient list and amounts. The sender reviews and signs.

---

### 5.8 `/approvals`
- Queue of items requiring this user's signature (Safe / threshold).
- Approve, reject, comment.
- Slack/email/Discord push for new approval requests.
- See [§12](#12-auth--multi-tenant) for role definitions.

---

### 5.9 `/audit`
Append-only activity log. Created / modified / approved / executed /
cancelled / claimed / notified / bounced events with actor, time,
target, payload diff. Exportable as signed PDF for external audit.

Each event entry:
```ts
interface AuditEvent {
  id: string;
  orgId: string;
  actorWallet: string;
  actorName?: string;
  type: "run.signed" | "run.notified" | "claim.success" | …;
  target: { kind: "run" | "recipient" | "settings"; id: string };
  payloadHash: string;        // hash of the payload diff
  signature: string;          // signed by the actor's wallet
  timestamp: number;
}
```

---

### 5.10 `/settings/*`
- **Organization.** Name, logo, registration #, tax ID — used by
  payslips. Default `LARGE_AMOUNT_THRESHOLD` and default `maxFeeBps`.
- **Team.** Roles (Owner / Admin / Sender / Viewer), invites.
- **Templates.** Payslip layout, email subject/body, available
  languages, preview button.
- **Notifications.** Email sender (DKIM-verified domain), Discord bot
  install, Slack app, per-template default channel.
- **Billing.** Plan, invoices, usage meter (Phase F).

---

### 5.11 `/inbox` — Recipient home (NEW page)

**Purpose.** A recipient who didn't receive (or lost) the email link
can log in with their own wallet and see everything addressed to their
meta address.

**Flow.**
1. Connect wallet.
2. Pay scans `subscribeCommitmentInserted` + the IndexedDB note
   adapter to derive which commitments the recipient's meta key can
   spend. SDK helper `scanInbox(metaAddress, opts)` — proposed
   `SDK_REVIEW.md §3.4`.
3. Tabs: Locked (claim-from in future) · Available now · Claimed.
4. Each row shows sender (verified org name from zk-X509), amount,
   claim-from date, "Claim" button.

**Primitives used.** `parseMetaAddress`, `deriveStealthPrivateKey`,
`subscribeCommitmentInserted`, `createIndexedDbNoteAdapter`,
`callClaimWithProof[Batch]`, `scanInbox`.

**Pay-only.** Sender display name from zk-X509 attestation, payslip
download, history search.

---

### 5.12 `/claim/[id]#<secret>` — Recipient claim page

**Purpose.** First impression for users who received an email/Discord
link.

**Flow.**
1. Land on URL — secret is read from `window.location.hash` (never
   sent to a server).
2. Show: sender's verified name + zk-X509 ✓, amount, available-from
   date (or "Claim now" if past), payslip download. Display "**Claim
   anytime — no expiry**" so the recipient knows the link never goes
   stale.
3. "Connect wallet" if not connected. Then "Claim — gasless" button.
4. On click: `callClaimWithProof` via relayer (gasless).
5. After success: "Add USDC to wallet" + receipt link + tx explorer
   link.

**Trust signals.** Verified sender mark, domain banner, "If this looks
suspicious, contact <sender>".

**Languages.** ko / en / ja minimum at launch.

**Mobile-first.** Most claims happen on mobile.

**Edge cases.** Already claimed, claim-from date in future, wrong
wallet (different meta address), relayer down, network missing → all
surfaced explicitly.

---

## 6. Off-chain components Pay needs

| Component | Why | Notes |
|---|---|---|
| Address book DB | Recipient name/email/Discord/role/groups + run history | Postgres in production; localStorage MVP. PII encrypted at rest. |
| Run record DB | `(runId, recipient, secret, claimUrl, status, notification log)` | Same store. Secret encrypted; only render to /claim/. |
| Notification queue + log | Email/Discord dispatch with retry, bounce tracking, status webhooks | See [§9](#9-notification-system). |
| Org / team / billing DB | Multi-tenant workspace state | Same store. |
| Email service | Notifications, payslip delivery, reminders | Postmark / SES. DKIM domain per org. |
| Discord service | Bot for DM delivery | Optional Phase F. |
| Slack service | App for DM delivery | Optional Phase F. |
| PDF service | Payslips, signed exports | Puppeteer or React-PDF. |
| zk-X509 signer | Sign payslips and exports | Reuses identity infra. |
| Auth service | SIWE login, session, role check | See [§12](#12-auth--multi-tenant). |
| Audit log writer | Immutable append-only log | Postgres + per-event signature. |

**Pay has no scheduler.** Each run is signed at the moment the sender
wants to send. "Run again" clones the previous run into a fresh wizard.

---

## 7. Sender end-to-end journey

Walking through "April payroll, 23 employees, USDC" as a concrete
sequence so every interface above ties together.

### 7.1 Onboarding (one-time)
1. Finance ops at Acme connects their wallet → SIWE → land on
   `/dashboard`.
2. First-run banner: "Verify Acme to unlock sending" → zk-X509 flow.
3. After verification, banner becomes "Top up USDC to start sending"
   → `/onboarding` deposit step.
4. After first deposit lands (note in vault), banner clears.

### 7.2 Build the address book (once, then maintained)
1. `/recipients` → "+ Add Recipient" or "Bulk import" CSV.
2. CSV columns: `name,walletAddress,email,discord,role,groups`.
3. Pay backend deduplicates by `walletAddress`; conflicts surface a
   merge dialog.
4. After import, finance ops tags employees vs contractors via
   `groups`.

### 7.3 Sign the run
1. `/payouts/new` → pick **Payroll** template.
2. **Step 2 (Token)**: label "April payroll", chain "Sepolia", token
   USDC. Pool balance card shows "92,000 USDC across 3 notes."
3. **Step 3 (Recipients)**: click **+ Add from address book**, select
   group "engineering" → 23 rows fill in. Sender enters per-row
   amounts in the CSV column. Claim schedule: today.
4. **Step 4 (Funds)**:
   - Required: 84,500 USDC.
   - Max relayer fee: 30 bps → fee at max 253.50 USDC.
   - Total to escrow: 84,753.50 USDC.
   - Available: 92,000 across 3 notes.
   - Auto-pick: lot-3 (50,000) + lot-1 (30,000) + lot-2 (5,000) =
     85,000. Change: 246.50 USDC.
   - Relayer: "Relayer-A" auto-selected.
   - No shortfall → Next enabled.
5. **Step 5 (Review)**: "84,500 USDC to 23 recipients. Above $50k
   threshold." → confirmation modal → finance types "84500" → Sign.
6. Wallet prompts once for EdDSA key derivation (cached for the
   session). Then prompts once per batch (1 batch here, ≤ 16 not
   triggered).
7. Settlement tx confirms → redirected to `/payouts/[id]`.

### 7.4 Send notifications (manual)
1. `/payouts/[id]` shows the new run with **0/23 notified**.
2. Top action bar shows "📧 Send claim emails to all recipients
   (23 pending)."
3. Finance clicks → progress UI "Sending 5 of 23…" → 23/23 ✉ Sent.
4. As recipients click their links: rows update 🖱 Clicked → ✓ Claimed.
5. After 48h, finance clicks "Remind unclaimed (3)" → reminder email
   to the 3 outstanding rows.
6. After all claim, run row in `/dashboard` shows "All claimed."

### 7.5 Audit
- `/audit` shows events: `run.signed (Acme.cfo, 2026-04-28 09:12)`,
  `run.notified (Acme.cfo, 2026-04-28 09:13)`,
  `claim.success (recipient: 0x...)`, etc.
- Finance exports a signed PDF for the year-end audit.

---

## 8. Recipient end-to-end journey

### 8.1 Email path (default)
1. Alice receives email:
   ```
   Subject: Acme paid you · April payroll
   From:    Acme <pay@acme.example>  [DKIM verified]
   Body:    $3,500 USDC is ready to claim. Click to receive: <link>
   Footer:  zk-X509 verified sender · Powered by zkScatter
   ```
2. Alice clicks → `/claim/<id>#<secret>`.
3. Page shows:
   - Sender mark: "Acme · ✓ Verified"
   - Amount: 3,500 USDC
   - Available from: today
   - Payslip download
4. Alice connects MetaMask → "Claim — gasless".
5. Pay generates `claim` proof, sends to relayer, settle on-chain.
6. Alice sees "Claimed · 3,500 USDC received." with Add-to-Wallet CTA.

### 8.2 Lost-link path
1. Alice loses the email; no bookmark.
2. Alice connects to `pay.acme.example/inbox` with her own wallet.
3. Pay scans her stealth meta address → finds the unclaimed run.
4. Same claim flow as above.

### 8.3 Wrong-wallet path
1. Alice clicks the link from the wrong wallet.
2. Page shows "This claim is bound to a different recipient meta
   address. Connect the wallet you sent to <sender>."
3. Alice switches wallet → continues.

### 8.4 Re-send path
1. Alice's company changed her email; old inbox is dead.
2. Alice emails `finance@acme` asking for a re-send.
3. Finance opens `/payouts/[id]`, finds Alice's row, clicks **Send
   email** with the new address (after updating address book first).
4. New email goes out — same `secret` (so the link is the same
   underlying claim; just delivered to a new inbox).

### 8.5 Discord/Slack path (Phase F)
- Recipients with `preferredChannel = "discord"` get a DM via Pay's
  Discord bot. Click tracking via tokenized link.
- Slack: same model.

---

## 9. Notification system

### 9.1 Trigger model — sender-initiated, not auto

After each settle, recipients are **not** auto-notified. Instead:
- The run page shows "0/N notified."
- A prominent "Send claim emails to all recipients" button.
- Sender clicks → emails dispatch.

**Why manual:** Phase A doesn't need a settlement-event listener
queue. The button-based trigger is reliable, transparent (sender
knows exactly when notifications go out), and survives operational
incidents (sender retries; no lost queue jobs). When a settlement
event listener is added later (Phase F), auto-trigger becomes a
toggle in `/settings/notifications`.

### 9.2 Channels

| Channel | Stack | Phase |
|---|---|---|
| Email | Postmark / SES + per-org DKIM domain | A |
| Discord | Bot + DM via webhook | F |
| Slack | App + DM via Slack API | F |
| SMS | Twilio (regulated regions only) | future |
| In-app push | Web push for `/inbox` users | future |

### 9.3 Message templates

Each template has:
- **Subject** (email only): `${senderName} paid you · ${runLabel}`
- **Body** (Markdown): rendered via the recipient's preferred
  language.
- **Variables:** `{senderName, senderLogo, amount, token, runLabel,
  claimLink, availableFrom, payslipLink, supportEmail}`.

Default templates (English) ship with Pay. Org override in
`/settings/templates`. Per-template channel preference also stored.

### 9.4 Status tracking

```ts
interface NotificationLog {
  id: string;
  runId: string;
  recipientId: string;
  rowIndex: number;            // index into the run's recipient list
  channel: "email" | "discord" | "slack";
  toAddress: string;           // for email this is the rendered email
  sentAt?: number;
  deliveredAt?: number;
  openedAt?: number;
  clickedAt?: number;
  claimedAt?: number;
  error?: string;
  bounceKind?: "hard" | "soft";
  retryCount: number;
  lastRetryAt?: number;
}
```

Status surfaced in `/payouts/[id]` per row with the icon table from
[§5.4](#54-payoutsid--run-detail).

### 9.5 Retry policy

- **Email hard bounce** → mark `recipient.email` invalid in the
  address book; alert sender; do not retry.
- **Email soft bounce / temp failure** → 3 retries with exponential
  backoff (5min, 30min, 4h).
- **Discord 429/5xx** → 1 retry after 60s.
- After max retries: `notification.status = "failed"`, surfaced in
  `/audit`.

### 9.6 Webhooks

```
POST /api/webhooks/email/postmark   delivery / open / bounce events
POST /api/webhooks/email/ses        delivery / open / bounce events
GET  /n/<token>                     tokenized claim-link redirect (records click)
```

Open tracking via 1×1 pixel; can be disabled per-org in
`/settings/notifications` for privacy-sensitive flows (regulated
recipients).

### 9.7 Privacy considerations

- The claim secret IS the link's hash fragment (`#<secret>`) — never
  sent to the server in normal browsing. But when the email body
  contains the full link, that link traverses SMTP relays and may be
  cached by upstream providers. Mitigations:
  - **Tokenized redirect:** email contains
    `https://pay.acme/n/<opaque-token>` → Pay backend looks up the
    token → 302 to `/claim/<id>#<secret>`. The secret never leaves
    Pay's servers in plaintext until the recipient's browser receives
    the redirect.
  - **TTL on redirect token:** invalidate after first click + 7
    days.
- Recipient can opt out of open-tracking via unsubscribe link.

### 9.8 What Phase A ships

- Manual trigger button on `/payouts/[id]` ✓
- Email channel only ✓
- Postmark integration (server-side route in Pay backend) ✓
- Status: Sent / Bounced (no open/click tracking yet)
- No retry policy yet — failures are surfaced and the user can
  manually re-send.

---

## 10. Source notes & funding

### 10.1 The note model

A user's pool balance for a given token is the sum of one or more
**escrowed notes** (`StoredNote` from `@zkscatter/sdk/notes`). Each
note has:
- A fixed `amount` (set at deposit time).
- A `commitment` (Poseidon hash of the preimage).
- A `leafIndex` once the on-chain `CommitmentInserted` event is
  reconciled.
- A `chainId` so multi-chain UX doesn't bleed across networks.

Spending a note in a settle creates:
- N output `claimEntry`s for the recipients.
- 1 residual change note for the sender (when `sellAmount <
  note.amount`).

### 10.2 Auto-pick algorithm (default)

```
1. Filter notes for selected token + current chainId.
2. Sort descending by amount.
3. greedy pick: while picked.sum < totalEscrow:
     take the next-largest note.
4. Last note becomes the partial-spend (its leftover becomes
   the change UTXO).
```

Properties:
- Always covers `totalEscrow` if `availableSum >= totalEscrow`.
- Minimizes the number of notes used (largest-first).
- The change note's salt is generated locally; the
  `expectedChangeCommitment` is precomputed and matches the on-chain
  `newCommitment` so the in-vault note stays spendable without
  re-derivation.

### 10.3 Manual selection (Phase E)

`/payouts/new` step 4 → "Change selection" link → modal:
- Checkbox per note (`lot-N`, amount, deposit date, source tx).
- Live "Selected sum / Required" indicator.
- "Use selection" disabled while sum < required.
- Excess shown as "Change after run."

### 10.4 Open question — single settle, multiple input notes

The current settle-auth circuit accepts ONE input note per call. For
runs that need multiple notes, Pay must split into multiple settles
(one per input note × ≤ 16 recipients). This compounds with
`splitPayout`'s 16-recipient cap to give a worst-case `M × N` matrix
of signatures, where M = input notes and N = recipient batches.

**Confirm with protocol team:** is multi-input support planned? If
not, Pay's auto-pick should *prefer single-note coverage* even if it
means a larger change UTXO.

---

## 11. Pay backend API surface

Sketch — to be refined per phase. All endpoints scoped to the calling
session's `orgId`. Auth via SIWE bearer token (see [§12](#12-auth--multi-tenant)).

### 11.1 Sessions
```
POST /api/sessions           SIWE login → session bearer token
DELETE /api/sessions         logout
GET  /api/me                 current user/org membership
```

### 11.2 Address book
```
GET    /api/recipients              list (paginated, filter by group)
GET    /api/recipients/:id          detail + run history
POST   /api/recipients              add
PATCH  /api/recipients/:id          edit
DELETE /api/recipients/:id          archive (soft delete)
POST   /api/recipients/import       bulk CSV → returns conflicts
GET    /api/recipients/export       signed CSV
```

### 11.3 Runs
```
GET  /api/runs                      list (filter by template, period)
GET  /api/runs/:id                  detail with notification statuses
POST /api/runs                      record a new run after on-chain settle
                                    (idempotent on settlement tx hash)
POST /api/runs/:id/notify           dispatch notifications to all recipients
POST /api/runs/:id/resend/:rowId    resend single recipient
POST /api/runs/:id/clone            return a new wizard pre-fill payload
```

### 11.4 Notifications
```
GET  /api/notifications/:runId       run's notification log
GET  /n/<token>                      tokenized claim-link redirect
POST /api/webhooks/email/postmark    delivery state from Postmark
POST /api/webhooks/email/ses         delivery state from SES
```

### 11.5 Audit
```
GET  /api/audit                      list (filter by actor, type, period)
GET  /api/audit/export               signed PDF
```

### 11.6 Templates / settings / billing (Phase E+)
```
GET/POST/PATCH/DELETE /api/templates
GET/POST/PATCH        /api/settings/organization
GET/POST/DELETE       /api/settings/team
GET/POST              /api/settings/notifications
GET                   /api/billing
```

### 11.7 Approvals (Phase G)
```
GET  /api/approvals                  queue
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject
```

---

## 12. Auth & multi-tenant

### 12.1 Auth
- **SIWE** (Sign-In With Ethereum) for org members.
- Session token in `httpOnly` secure cookie.
- One wallet can belong to multiple orgs (consultant managing several
  DAOs); session header `X-Org-Id` selects the active org.

### 12.2 Tenants
- `Org` is the tenant. Address book / runs / templates / audit /
  settings are all scoped to `orgId`.
- Org creation via SIWE → `/onboarding` flow (collects company name,
  registration #, logo).
- Org domain verification (DNS TXT record) unlocks DKIM-signed
  outbound email under `pay@<org-domain>`.

### 12.3 Roles

| Role | Address book | Runs | Templates | Settings | Billing |
|---|---|---|---|---|---|
| **Owner** | RW | RW | RW | RW | RW |
| **Admin** | RW | RW | RW | RW | R |
| **Sender** | R | RW (subject to multisig) | R | R | — |
| **Viewer** | R | R | R | R | — |

### 12.4 Multisig / approvals (Phase G)
- Org rule: "runs ≥ $X require N-of-M approvals."
- The wizard step 5 transitions to "Awaiting approvals" status; the
  `AuthorizeProofInput` is built once and stored encrypted; each
  approver signs the same proof's `nonce` (Safe-style pattern) →
  threshold reached → settle fires.

---

## 13. Data model summary

A bird's-eye view of every persistent record. Frontend stores
(localStorage / IndexedDB) and backend stores both noted.

| Record | Where | Notes |
|---|---|---|
| `StoredNote` | IndexedDB (browser) | per-`(chainId, account)`. SDK-managed. |
| `Recipient` | localStorage MVP → backend | address book entries. |
| `Run` | backend | sender's run metadata + per-recipient claim state. |
| `NotificationLog` | backend | dispatch + delivery state per recipient. |
| `AuditEvent` | backend | append-only signed log. |
| `Org` | backend | tenant. |
| `OrgMember` | backend | wallet ↔ org ↔ role. |
| `Template` | backend | per-org email/payslip template overrides. |
| `RelayerInfo` | on-chain registry + cache | from `loadActiveRelayers`. |

Secret material:
- Per-recipient claim `secret` — encrypted at rest (Pay backend),
  decrypt only to render `/claim/...#<secret>` links.
- EdDSA private key — derived per-session from wallet signature, never
  persisted.
- zk-X509 org private key — HSM (Phase F).

---

## 14. Build order

(Replaces the prior 6-phase list. Phases stay independently shippable.)

### Phase 0 — Repositioning **DONE** (PR #473)
- Marketing landing 1:N privacy.
- Wizard template selector + 4-step skeleton.
- Dashboard category tabs.
- README scope.

### Phase A — Wallet + balance + dry-run wizard **DONE** (PR #479)
- Layout: Connect Wallet pill, account menu, chain badge.
- VaultProvider, EdDSAKeyProvider, RelayersProvider mirrored.
- Dashboard: real `PoolBalanceCard` from vault notes.
- Wizard step 4 dry-run plumbing (`splitPayout` + AuthorizeProofInput
  builder + console-log dispatch).
- `splitPayout` SDK helper (PR #478).

### Phase B — Wizard 5-step layout **NEXT**
- Add the dedicated **Funds step** (relayer + fee + source notes
  + deposit CTA).
- Manual note selection placeholder (auto-pick only; "Change
  selection" disabled until Phase E).
- Wizard navigation 4 → 5 steps; Stepper labels updated.
- Real `ensureAllowance + generateDepositProof + callDeposit` for
  the deposit CTA (replace `dryRunDeposit`).
- Real `generateAuthorizeProof + callSettleAuth` per batch (replace
  `dryRunSettle`).
- CommitmentTreeProvider mirror (needed for `merkleProof`).

### Phase C — Address book MVP
- `/recipients` page with localStorage backing.
- + Add / Edit / Archive recipient.
- CSV import (no backend conflict resolution yet — last-write-wins).
- Wizard "Add from address book" + group import.
- "Run again from <previous>" 1-click clone.

### Phase D — Run detail & notifications (manual trigger)
- `/payouts/[id]` real run records (read from backend `/api/runs/:id`).
- Top action bar: **Send claim emails to all** + per-row Send/Resend.
- NotificationLog status icons in the recipient table.
- Pay backend: minimal Express/Hono server with Postmark integration.
- `/n/<token>` tokenized redirect.
- `/payouts/[id]/payslip/[row]` PDF (server-side render).
- Bulk reminder.

### Phase E — Settings, audit, manual note selection
- `/settings/organization`, `/settings/team`, `/settings/templates`,
  `/settings/notifications`, `/settings/billing`.
- `/audit` log + signed PDF export.
- Wizard step 4: manual source-notes selection modal.
- Org-level DKIM domain verification.

### Phase F — Recipient inbox + secondary channels
- `/inbox` with `scanInbox(metaAddress)` SDK helper (proposed
  `SDK_REVIEW.md §3.4`).
- `/claim/[link]` real `callClaimWithProof` (replace demo).
- Discord / Slack notification channels.
- Settlement-event auto-trigger toggle.

### Phase G — Approvals & multisig
- `/approvals` queue.
- Threshold rules in `/settings/organization`.
- Safe integration (re-uses existing Safe SDK).
- AuthorizeProofInput stored encrypted between approvals.

### Phase H — Auth, multi-tenant, billing
- SIWE auth + session.
- Org switching for users in multiple orgs.
- Role-based access control end-to-end.
- Billing meter + invoicing (Stripe).

### Phase I — Templates editor + i18n
- `/settings/templates` rich editor (Markdown + variable picker).
- Per-org language packs for /claim and emails.

---

## 15. Open questions

### Protocol-level (need answers before Phase B)
1. **Does `callSettleAuth` accept multiple input notes per call?**
   See [§10.4](#104-open-question--single-settle-multiple-input-notes).
   If not, Pay's auto-pick must prefer single-note coverage to avoid
   M × N signature explosion.
2. **`releaseTime` precision.** ✓ Confirmed: per-second. Pay's wizard
   exposes a date picker (00:00 of org timezone) by default; Advanced
   exposes datetime.
3. **Self-pay (USDC → USDC).** ✓ Confirmed: maker = taker = same EOA
   with `sellToken == buyToken` and `sellAmount == buyAmount` is the
   supported pattern. Pay's flow: sender deposits, signs both sides,
   claims distribute USDC to N recipients with per-recipient
   `releaseTime`.
4. **Recipient address rotation.** Does the protocol support binding a
   claim to a meta address that the recipient can rotate, or is the
   `recipient` field final at sign time? If final, an off-chain
   secondary "redirect to my new wallet" flow must exist.
5. **zk-X509 org attestation surface.** What fields are signed? Can
   the recipient claim page render them as "Verified sender"?
   Confirm with identity team — needed for /claim/ trust signals.

### Product-level (need answers before Phase D)
6. **Email tracking opt-in default.** Is open/click tracking on by
   default, or off? Compliance (GDPR / CCPA) implications.
7. **Default `maxFeeBps`.** 30 bps (0.3%) chosen as the ship-default.
   Confirm with relayer ops + finance ops user research.
8. **Approval flow UX (Phase G).** Does the proof get built once and
   N approvers sign the same proof's nonce, or does each approver
   re-derive? (Affects whether `AuthorizeProofInput` is encrypted at
   rest between approvals.)
9. **Address book conflict resolution.** When a CSV import has the
   same wallet with a different name, default to merge or duplicate?

### Infrastructure-level (Phase D+)
10. **Pay backend stack.** Hono on Cloudflare Workers vs. Fastify on
    a node.js host. Latency profile favors Workers; queue retries
    favor a more traditional host. Decide before Phase D ships.
11. **DB choice.** Postgres (Neon / Supabase) for relational data +
    KV for queue. Confirm with infra team.
12. **Email provider.** Postmark for transactional reliability vs.
    SES for cost. Default Postmark for Phase D, switchable per org
    in Phase E.

---

## 16. Out of scope (handled by other apps)

- 1:1 vendor invoices (B2B AP). → separate app, e.g. **Bills**.
- Employee expense reimbursements with receipts. → separate app.
- Subscription / utility recurring 1:1. → separate app.
- Auto / scheduled / recurring execution of any kind. The protocol
  does not auto-execute; each run is a one-shot sender-signed
  transfer.
- Tax filing or withholding remittance. Pay produces signed payslips;
  remittance is a downstream accounting tool's job.
- Fiat on/off ramps. Out of Pay's surface — settle is always in
  pool tokens.
