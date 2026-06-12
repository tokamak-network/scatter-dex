# Pay Wizard — Categories & Per-Row Claim Time

Date: 2026-05-10
Branch: `feat/wizard-categories-and-per-row-claim` (merged)
Status: **부분 구현** — 카테고리 rename(§2)은 구현 완료
(`_categories.ts`, `BuildRunRecordInput.categoryId`; wizardDrafts 의
`templateId` 키는 의도적으로 유지). **Per-row claim time(§3)은 미구현**
— SDK 인프라는 준비됨(`RecipientRow.claimFrom`,
`packages/sdk/src/storage/runs.ts`)이나 위자드 UI(per-row 컬럼·토글·
Review 표시)는 아직 단일 `claimFrom` 입력만 노출.

## 1. Why

The wizard's Step 1 was framed as picking a "Template" with four entries
(payroll, grants, bonus, contractor). In practice the four entries only
differ by labels, placeholders, and an export-note string — the data
model, validation, and submit flow are identical. Calling them
"templates" oversells what is really a preset/category tag.

A second gap surfaced while reviewing the bonus and contractor flows:
real-world bonus/contractor/grants runs need different unlock times per
recipient (per-invoice net-30, milestone tranches, executive-vs-staff
release windows). The wizard exposes a single `claimFrom` for the whole
run; the underlying contract, circuit, and `ClaimPackage` already
support per-recipient `releaseTime`, so this is a UI gap, not an
infrastructure gap.

## 2. Decisions

### 2.1 Rename: Template → Category

- Step 1 becomes "Choose a category". Helper text and Review row labels
  follow.
- Code rename within the wizard:
  - `_templates.ts` → `_categories.ts`
  - `TemplateId / Template / TEMPLATES` → `CategoryId / Category / CATEGORIES`
  - `templateId / template / pickTemplate` → `categoryId / category / pickCategory`
- `BuildRunRecordInput.templateId` → `categoryId`.
- `WizardDraft.templateId` (persistent storage) keeps its field name to
  avoid migrating existing on-disk drafts. The wizard reads/writes
  through a one-line mapping at the boundary.
- Dashboard chip that displays the raw draft field stays as-is (no
  user-facing label change there).

This rename is already applied on the working branch.

### 2.2 Per-row claim time

#### Infrastructure check (done)

- `PrivateSettlement._executeClaim` (line 1050) gates on
  `block.timestamp < releaseTime` **per claim**, not per claimsRoot.
- `PayoutRecipient.releaseTime` (`splitPayout.ts:13`) and
  `ClaimEntry.releaseTime` (`claim.ts:25`) feed the per-leaf hash, so
  releaseTime is bound into the proof.
- `ClaimPackage.releaseTime` (`claimPackage.ts:32`) is per-recipient on
  the wire format.
- Conclusion: per-row claim time is enforceable end-to-end; only the
  wizard UI flattens it.

#### UX

- Wizard keeps the existing single "default claim time" input.
- Add an **"Individual claim time" toggle** next to it.
- Toggle OFF (default): single value applied to every recipient — current
  behavior unchanged.
- Toggle ON: SpreadsheetEditor exposes an extra **`claim_from`** column
  as the last field. Each row can edit its own datetime in the cell.
- Empty cells in the per-row column fall back to the wizard's default.
- Toggling OFF preserves the per-row values in wizard state — re-toggling
  ON restores them. (Don't punish users for experimenting with the
  toggle.)

#### Time format

- Cell input: local wall-clock entry (`2026-06-01 09:00`) — same UX as
  the existing datetime-local input.
- Display + CSV serialization: ISO 8601 with offset
  (`2026-06-01T09:00:00+09:00`).
- Internal: convert to Unix seconds at the wizard boundary so existing
  per-row `claimFrom` plumbing through `parseRecipientRows`,
  `_buildRunRecord`, and `RecipientRow.claimFrom` does not need a
  separate type.
- Column header shows the operator's browser timezone so a CSV exported
  from KST and imported in PST does not silently shift:
  `claim_from (Asia/Seoul, UTC+9)`.

#### Review step

- Per-row table gains a "Claim from" column rendered in the operator's
  local timezone.
- Rows that differ from the wizard default get an "Override" badge.
- Section header summarises:
  `Default 2026-06-01 09:00 KST · 3 overrides`.

#### Validation

- The `claimFromTooEarly` buffer rule applies to every per-row value
  individually.
- Empty rows inherit the wizard default; the default itself must still
  pass the buffer rule (existing behavior).
- A single invalid row closes the submit gate; the error message names
  the offending row index.

## 3. Implementation plan (next session)

1. Add `supportsPerRowClaim` flag to `_categories.ts` — start with `true`
   for all four categories.
2. Add the "Individual claim time" toggle to the Funds step, next to the
   existing default claim-from input.
3. Extend SpreadsheetEditor to render an optional last column when the
   toggle is on, with datetime-local cell editing.
4. Update CSV parser/serializer to round-trip ISO 8601 offsets.
5. Change `parseRecipientRows` to accept a per-row `claimFrom` instead
   of a single value; default-fill from the wizard input when the cell
   is empty.
6. Rewrite `_buildRunRecord.ts:87-114` so `isFutureClaim` and
   `RecipientRow.claimFrom` are computed per row.
7. Add the per-row "Claim from" column + Override badge to the Review
   step.
8. Apply per-row validation; surface offending row indexes in the
   submit-blocked banner.

## 4. Out of scope (for now)

- Group-level unlock presets (bonus tiers, milestone tranches): these
  imply 1:N row-to-tranche structures and a different data model. Treat
  as a follow-up once per-row is shipping.
- Splitting categories into actually-different templates with distinct
  data models: deliberately not pursued — categories stay as labels +
  placeholders only.
- Migrating `WizardDraft.templateId` to `categoryId`: cosmetic, would
  require a draft migration; deferred.

## 5. Open questions

None blocking; the eight implementation steps above can proceed as
written.
