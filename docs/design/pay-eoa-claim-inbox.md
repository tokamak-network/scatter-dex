# Pay — EOA Claim Inbox

Date: 2026-05-11
Branch: `feat/eoa-claim-inbox`
Status: Design + implementation

## 1. Why

Today only stealth claims have a persisted local history (`/stealth/inbox`).
Regular EOA claims — opened via a shared `/claim?id=...#secret` link —
leave no local trace: the recipient claims once, the link is consumed,
and the next session has no way to see what they received without
keeping the original message around.

`/stealth/inbox` is intentionally narrow: its storage shape carries
`ephemeralPubKey`, the optional pre-derived stealth privkey, and a
discriminated `source` field that only makes sense for stealth
hand-offs. Bolting EOA entries onto that file would either pollute the
shape with optional stealth fields on rows that don't need them, or
require a discriminated union and a migration of the on-disk file.

A separate, slimmer inbox sidesteps both problems for the first cut.

## 2. Decisions

### 2.1 Two separate inboxes, two separate files

- **Stealth inbox** stays at `/stealth/inbox`, file
  `zkscatter-stealth-inbox.json`, type `StealthInboxEntry`.
- **EOA claim inbox** lands at `/inbox`, file
  `zkscatter-claim-inbox.json`, type `ClaimInboxEntry`.

`ClaimInboxEntry` is a strict subset: `id`, `addedAt`, `rawInput`,
`pkg`, `status`, `claimedAt?`, `txHash?`. No `ephemeralPubKey`, no
`stealthPrivateKey`, no `source` discriminant.

A merge ("one inbox with tabs/filters") is intentionally deferred —
see §4.

### 2.2 Nav entry

`Claims` link added to the main nav between `New payout` and `Address
book`. Stealth Inbox stays reachable through the existing `Stealth`
dropdown.

### 2.3 Auto-save trigger on `/claim`

`doClaim` already mirrors successful stealth claims into the stealth
inbox. The non-stealth branch now mirrors into the EOA inbox in the
same `if (folder.ready) { ... }` block — single branch on `isStealth`
picks the right storage call.

### 2.4 Pre-claim Save button

A `Save to {Stealth|Claims} inbox` button surfaces on `/claim` while
`folder.ready` and the claim hasn't run yet (phase idle or error). Lets
a recipient register a link without claiming so the URL can be
discarded immediately. State: `idle` → `saving` → `saved` (or
`duplicate` when the same link is already in the inbox).

### 2.5 Inbox page UX

- Paste textarea accepts a full URL or a bare `#fragment`. Privkey +
  package hand-off is **not** accepted here — that path is stealth-only
  and lives in `/stealth/inbox`.
- Rows show amount/token/sender label/run label/available-from + a
  status chip (`Available` / `Locked` / `Claimed`). `Open` button jumps
  to `/claim?id=saved_<leafIndex>#<base64Package>`; the existing claim
  flow takes over from there. `Remove` deletes the entry.
- The "now" clock ticks once per minute so `Locked → Claimable` flips
  without a manual reload.

## 3. Implementation

| Change | File |
|---|---|
| New storage module + CRUD | `packages/sdk/src/storage/claimInbox.ts` |
| Re-export | `packages/sdk/src/storage/index.ts` |
| Inbox page | `apps/pay/app/inbox/page.tsx` |
| `Claims` nav link | `apps/pay/app/layout.tsx` |
| `/claim` auto-save branch + manual Save button + post-claim link | `apps/pay/app/claim/page.tsx` |
| Design doc | `docs/design/pay-eoa-claim-inbox.md` |

## 4. Out of scope

- **Cross-device history**: only claims made or saved on the current
  device land in the local file. An on-chain reconciler that scans
  `Claim` events for the user's EOA could backfill missing rows but
  needs an indexer or log-scan strategy and is deferred.
- **Inbox unification**: a single `/inbox` page that tabs/filters
  stealth vs EOA. Defer until the EOA flow has settled and we have
  signal on whether users want them merged.

## 5. Open questions

None blocking.
