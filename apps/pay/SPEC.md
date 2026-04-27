# Scatter Pay — Product Spec

A user-friendly payments wrapper on top of zkScatter (private DEX with
zk-X509 compliance). Reuses existing protocol primitives — does not
introduce new contracts or circuits.

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
- **Relayer = auto.** Round-robin from `loadActiveRelayers()`. Advanced
  users can override in Settings.
- **EdDSA / commitment / nullifier = invisible.** Generated and stored
  by `useWallet()` and the SDK note adapter.
- **zk-X509 = one-time onboarding.** First payout shows "Verify your
  organization to start sending" → reuses `frontend/app/identity` flow.
- **Pool balance = "Your USDC ready to send"**. Deposit step is framed
  as "Top up balance," not "deposit to commitment pool."

## 4. Sitemap

```
/                              Marketing landing
/onboarding                    First-run: connect wallet → verify org → top up
/dashboard                     Sender home: balance, recent runs, approvals
/payouts/new                   Wizard
/payouts/[id]                  Run detail
/payouts/[id]/payslip/[row]    Per-recipient PDF (printable)
/recipients                    Address book
/approvals                     Multisig / threshold approvals queue
/audit                         Activity log (immutable)
/settings/organization         Company name, logo, registration #
/settings/team                 Members & roles
/settings/templates            Payslip & email templates
/settings/notifications        Channels (email, Discord)
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
- Pool balance via SDK (TBD: confirm there's a balance helper; otherwise
  derive from notes adapter).

**Pay-only.** Category badges, tabs, filter, period picker (this/last
month, Q1, year), bulk export.

---

### 5.3 `/payouts/new` (Wizard, 5 steps)

**Step 1 — Template.**
Cards: Payroll · Grants · Bonus · Contractor. Picking one prefills label,
sample list, and which subsequent fields to show.

**Step 2 — Money.**
- Run label (editable from template default).
- Chain (read-only or selector if multi-chain).
- Token (default USDC).
- Source: pool balance card showing "$X available." If insufficient,
  inline "Deposit $Y more" CTA → triggers `ensureAllowance` + `callDeposit`
  without leaving the wizard.

**Step 3 — Recipients.**
- Source picker: CSV upload · Paste · Pick from address book · Import a
  group · Clone from a previous run.
- Live table with validation per row: address format, duplicates, amount
  parsing, total vs pool balance.
- Required columns: `name, address, amount`. Optional: `email, discord,
  memo, withholding`.
- Per-row "Available to claim from" override (default = today). Group
  override at the top.
- Toggles: Notify by email · Notify by Discord · Stealth on (default on).
- Reason / proposal-link / invoice-ref field appears for grants / bonus /
  contractor templates.

**Step 4 — Approvals (conditional).**
Shown if org policy requires N-of-M signers above a threshold. Lists
required signers, sends them a notification, blocks Step 5 until quorum.

**Step 5 — Review & sign.**
Summary table + estimated gas + Pay fee + the export note for the chosen
template. **Prominent "irreversible" notice**: once signed and settled,
the payout cannot be recalled — the recipient can claim forever. For
runs above an org-defined amount (default: $50k), require an extra
confirmation modal that re-shows the total, recipient count, and the
"cannot be reversed" warning. "Sign & submit" → opens MetaMask once.

**Primitives used.**
- For each recipient: derive a `secret` (auto, 32-byte random),
  compute `claimHash = hash(secret, recipientAddress, salt)` per
  DEV.md §6.
- Build the order proof (`frontend/app/trade/_shared/buildOrderProof.ts`).
- Submit through chosen relayer (`loadActiveRelayers` → pick one).
- After tx confirms: persist `(runId, recipient, secret, claimUrl)`
  off-chain so we can render `/claim/[id]#<secret>` later and send
  notifications. **The secret never goes on-chain — only `claimHash`
  goes on-chain via the order.**

**Pay-only.** Templates, CSV import, validation, payslip template choice,
notification channels.

**Failure modes handled.** Wallet disconnect, wrong chain, insufficient
balance (with inline deposit), relayer down (try next), order rejected,
user rejects signature.

---

### 5.4 `/payouts/[id]`
**Purpose.** Sender's run detail.

**Header.** Label, date, template badge, on-chain tx (link to explorer),
zk-X509 audit signature.

**Stats.** Total · Claimed (n/N) · Available now · Locked (claim-from in future).

**Recipient table.** Per row: name, masked address, amount, status,
claim-from date, claimed-at, last reminder sent. Row actions:
- Copy claim link
- Resend notification (actual email / Discord send via Pay's notification service)
- Edit memo
- **Print payslip** → `/payouts/[id]/payslip/[row]`
- **Email payslip** → triggers an actual email through Pay's notification service

**Bulk actions.** Remind unclaimed · Download all payslips (zip) ·
Export CSV/PDF/JSON · Run again next month.

**Primitives used.**
- `loadCommitmentInsertedHistory` (subscribe for live updates).

**Note on lifecycle.** Once a payout is settled, the recipient can claim
forever — there is no expiry. The sender cannot reclaim a settled
payout. `callCancel` only works on orders that haven't settled yet
(in the orderbook). Pay's UX must therefore make the Review step very
explicit ("once signed, this cannot be reversed").

**Pay-only.** Status simplification (claimed / available / locked-until-date),
payslip generation, bulk reminder + channel selection, signed export.

---

### 5.5 `/payouts/[id]/payslip/[row]` — **Individual statement (PDF)**

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

### 5.6 `/recipients` — **Address book**
- Table: name, address, email, discord, telegram, memo, tax id.
- Groups & tags: "Engineering team", "Q2 grantees", "Vendors".
- Bulk import (CSV/xlsx), bulk export, deactivate (preserves history).
- Test-send (`$0.01`) to verify a fresh address is live.
- Merge ENS / meta-address resolution.
- Activity per recipient (history of payouts received).

**No on-chain state.** All off-chain, scoped per organization.

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

---

### 5.9 `/audit`
Append-only activity log. Created / modified / approved / executed /
cancelled / claimed events with actor, time, target, payload diff.
Exportable as signed PDF for external audit.

---

### 5.10 `/settings/*`
- **Organization.** Name, logo, registration #, tax ID — used by payslips.
- **Team.** Roles (Admin / Approver / Accountant / Viewer), invites.
- **Templates.** Payslip layout, email subject/body, available languages.
- **Notifications.** Email sender (DKIM), Discord webhook, Slack app.
- **Billing.** Plan, invoices, usage meter.

---

### 5.11 `/inbox` — **Recipient home (NEW page)**

**Purpose.** A recipient who didn't receive (or lost) the email link can
log in with their own wallet and see everything addressed to their meta
address.

**Flow.**
1. Connect wallet.
2. Pay scans `subscribeCommitmentInserted` + the IndexedDB note adapter
   to derive which commitments the recipient's meta key can spend.
3. Tabs: Locked (claim-from in future) · Available now · Claimed.
4. Each row shows sender (verified org name from zk-X509), amount,
   claim-from date, "Claim" button.

**Primitives used.** `parseMetaAddress`, `deriveStealthPrivateKey`,
`subscribeCommitmentInserted`, `createIndexedDbNoteAdapter`,
`callClaimWithProof[Batch]`.

**Pay-only.** Sender display name from zk-X509 attestation, payslip
download, history search.

---

### 5.12 `/claim/[id]#<secret>` — **Recipient claim page**

**Purpose.** First impression for users who received an email/Discord link.

**Flow.**
1. Land on URL — secret is read from `window.location.hash` (never sent
   to a server).
2. Show: sender's verified name + zk-X509 ✓, amount, available-from
   date (or "Claim now" if past), payslip download.
   Display "**Claim anytime — no expiry**" so the recipient knows the link
   never goes stale.
3. "Connect wallet" if not connected. Then "Claim — gasless" button.
4. On click: `callClaimWithProof` via relayer (gasless).
5. After success: "Add USDC to wallet" + receipt link + tx explorer link.

**Trust signals.** Verified sender mark, domain banner, "If this looks
suspicious, contact <sender>".

**Languages.** ko / en / ja minimum at launch.

**Mobile-first.** Most claims happen on mobile.

**Edge cases.** Already claimed, claim-from date in future, wrong wallet
(different meta address), relayer down, network missing → all surfaced
explicitly.

---

## 6. Off-chain components Pay needs

| Component | Why | Notes |
|---|---|---|
| Claim record store | Persist `(runId, recipient, secret, claimUrl, status)` | Postgres or similar. Secret encrypted at rest. |
| Recipients DB | Address book per org | Same store. |
| Org / team / billing | Workspace state | Same store. |
| Email service | Notifications, payslip delivery, reminders | Postmark / SES. |
| Discord service | Bot for DM delivery | Optional v1. |
| PDF service | Payslips, signed exports | Puppeteer or React-PDF. |
| zk-X509 signer | Sign payslips and exports | Reuses identity infra. |

**Pay has no scheduler.** Each run is signed at the moment the sender
wants to send. "Run again" clones the previous run into a fresh wizard.

## 7. Build order

### Phase 0 — Repositioning (DONE)
- Landing copy and templates 1:N privacy. ✓
- Wizard template selector + 4-step flow. ✓
- Dashboard category tabs. ✓
- README scope. ✓

### Phase A — Connect & balance
- Layout: Connect Wallet button, account menu, chain badge, missing-wallet
  guidance.
- `/onboarding` first-run flow.
- Dashboard: real balance card driven by SDK.
- Wizard Step 2: inline "Deposit if insufficient" with `ensureAllowance` +
  `callDeposit`.

### Phase B — Recipient experience
- `/inbox` (stealth scan with `subscribeCommitmentInserted` +
  IndexedDB note adapter).
- `/claim/[id]#<secret>`: trust signals, real claim with
  `callClaimWithProof`, language switch, mobile pass.

### Phase C — Address book
- `/recipients`.
- Wizard Step 3: pick from address book, group import.
- Wizard "Available to claim from" per row + group default.
- "Run again from <previous>" 1-click clone on `/payouts/[id]`.

### Phase D — Run detail & payslips
- Status diversification + row actions on `/payouts/[id]`.
- `/payouts/[id]/payslip/[row]` — PDF service.
- Bulk reminder, run-again.

### Phase E — Org & audit
- `/settings/organization`, `/settings/team`, `/settings/templates`.
- `/audit` log.
- Signed CSV / PDF exports.

### Phase F — Approvals & multisig
- `/approvals` queue.
- Threshold rules.
- Safe integration.

## 8. Open questions

- Does `callSettleAuth` accept N recipients in one call, or do we issue N
  authorizations per run? Confirm before Phase A.
- Pool balance lookup: is there a `getBalance` helper, or must we derive
  from the note adapter? Confirm.
- Does the protocol support same-token (USDC→USDC) self-trade, or do we
  need to route through a stable pair? Confirm.
- zk-X509 org attestation surface — what fields are signed, and can the
  recipient claim page render them as "Verified sender"? Confirm with
  identity team.

## 9. Out of scope (handled by other apps)

- 1:1 vendor invoices (B2B AP). → separate app, e.g. **Bills**.
- Employee expense reimbursements with receipts. → separate app.
- Subscription / utility recurring 1:1. → separate app.
- Auto / scheduled / recurring execution of any kind. The protocol does
  not auto-execute; each run is a one-shot sender-signed transfer.
