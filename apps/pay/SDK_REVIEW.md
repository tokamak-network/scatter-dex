# Pay × zkScatter SDK — Coverage Audit

Maps Pay's spec (see `SPEC.md`) onto the SDK in `packages/sdk` and the
existing `frontend/` flows. The goal is to confirm Pay can be built as a
UX wrapper without forking the protocol, and to surface the few helpers
that should be added to the SDK rather than re-invented per app.

## 1. SDK surface today

The SDK ships these primitives Pay needs:

### Wallet & network
- `WalletProvider`, `useWallet` — `account`, `chainId`, `signer`,
  `provider`, `readProvider`, `connect`, `disconnect`, `connectError`.
- `NetworkConfig`, `ContractAddresses`, `chainName(chainId)`,
  `explorerLink(...)`, `getReadProvider(rpcUrl)`.
- `LAUNCH_TOKENS`, `LAUNCH_PAIRS`, `tokenMap`, `parseTokenList`,
  `withNativeEthAlias`, `eqAddr`.

### Pool & deposit
- `ensureAllowance(signer, token, spender, amount)` — handles USDT-style
  zero-then-approve resets.
- `callDeposit(signer, poolAddress, depositProof, token, amount)`.
- `generateDepositProof(...)` (in `zk/circuits/deposit`).
- `loadCommitmentInsertedHistory(...)`, `subscribeCommitmentInserted(...)`.

### Settle (1:N "send")
- `callSettleAuth(signer, settlementAddress, maker, taker, fees)`.
- `generateAuthorizeProof(input)` accepting up to
  `MAX_CLAIMS_PER_SIDE = 16` `ClaimEntry`s. Each entry:
  `{ secret, recipient, token, amount, releaseTime }`.
- `releaseTime` is unix seconds — the on-chain enforcement of "claim from
  this date" that Pay calls "Available to claim from."

### Claim (recipient)
- `generateClaimProof(input)` — needs `secret`, `recipient`, `token`,
  `amount`, `releaseTime`, `leafIndex`, and either `allClaimLeaves` or a
  `merkleProof`.
- `callClaimWithProof(signer, settlementAddress, inputs)`.
- `callClaimWithProofBatch(signer, settlementAddress, items)` — up to
  `MAX_CLAIM_BATCH_SIZE = 20` per tx.
- `singleClaimTree(entry, leafIndex)` helper for the simple case.

### Cancel order
- `callCancel(signer, settlementAddress, cancelProof)`.
- `generateCancelProof(...)`.

### Stealth (recipient privacy)
- `generateMetaAddress`, `parseMetaAddress`, `isMetaAddress`,
  `generateStealthAddress(metaAddress)`, `deriveStealthPrivateKey(...)`,
  `stealthWallet(...)`.

### Notes (local "wallet" of unspent commitments)
- `createMemoryNoteAdapter`, `createIndexedDbNoteAdapter`,
  `StoredNote`, `NoteStorageAdapter`.

### Relayers
- `loadActiveRelayers(...)`, `loadRelayersWithApiInfo(...)`,
  `sanitizeProfile`.
- `RelayerInfo`, `RelayerOnChain`, `RelayerProfile`, `RelayerOrder`.

### Crypto helpers
- `poseidonHash`, `computeCommitment`, `computeNullifier`,
  `computeNonceNullifier`, `computeClaimNullifier`, `computeTokenHash`,
  `randomFieldElement`, `generateNote`, `toBytes32Hex`.

## 2. Pay needs vs SDK

| Pay need | SDK status | Action |
|---|---|---|
| Connect / chain badge / wrong-chain prompt | ✅ `useWallet` | Use directly |
| Read tokens / chain name / explorer links | ✅ | Use directly |
| Deposit USDC into pool | ✅ | `ensureAllowance` + `generateDepositProof` + `callDeposit` |
| Show pool balance | ⚠️ Derive | Sum of unspent `StoredNote`s for `account`. Needs a small helper (proposed §3.1). |
| New payout (≤16 recipients, same-token USDC→USDC) | ✅ | `generateAuthorizeProof` with N `ClaimEntry`s, `callSettleAuth` |
| New payout (>16 recipients) | ⚠️ Manual chunking | Needs a Pay-or-SDK helper that batches multiple settles (proposed §3.2). |
| Claim-from date per recipient | ✅ | `ClaimEntry.releaseTime` |
| Per-recipient secret / claimHash | ✅ | `randomFieldElement()` for secret, `poseidonHash` already used inside the proofs |
| Cancel an unsettled order | ✅ | `generateCancelProof` + `callCancel` |
| Run detail (claim status per recipient) | ⚠️ Partial | We have settlement events; need a "list claims for this settlement and their status" helper (proposed §3.3). |
| Recipient inbox (find claims by my meta-address) | ⚠️ Partial | `subscribeCommitmentInserted` + stealth derivation. Needs a scan helper that takes `(metaAddress, fromBlock)` and returns matching `ClaimEntry`s (proposed §3.4). |
| Recipient claim from link | ✅ | `generateClaimProof` + `callClaimWithProof` |
| Verified sender mark on claim page | ❌ | Not in SDK. Lives in `frontend/identity` (User CA / Relayer CA). Needs an SDK shim that resolves `address → org display name + zk-X509 status` (proposed §3.5). |
| Auto-pick a relayer | ✅ | `loadActiveRelayers()`, Pay rotates / picks lowest fee |
| Per-recipient payslip PDF | ❌ off-chain | Pay's backend (Puppeteer / React-PDF), signed via `frontend/identity` |
| Email / Discord notifications | ❌ off-chain | Pay's backend (Postmark / SES / Discord webhook) |
| Address book / org / team / billing | ❌ off-chain | Pay's backend |
| Audit log | ❌ off-chain | Pay's backend |

✅ = use as-is. ⚠️ = SDK has the primitives but Pay needs a small wrapper.
❌ = out of SDK scope (off-chain).

## 3. Proposed SDK additions

These are the only items Pay can't cleanly build on top of today's SDK
without re-implementing core invariants. Each is small and belongs in
the SDK rather than in Pay's code so other apps benefit too.

### 3.1 `getAvailableBalance(account, opts)` — pool balance helper
Sum of unspent `StoredNote`s for an account, by token. Optional
`onChainNullifierCheck` to filter out notes that look unspent locally
but were spent in another session. Returns
`{ token, raw: bigint, formatted: string }[]`.

Reason: every app — Pay, Trade, future Bills — needs to render "you have
X USDC ready to spend." Re-deriving from notes adapter inline scatters
the same logic across apps.

Location: `packages/sdk/src/notes/balance.ts` (re-exported from
`@zkscatter/sdk`).

### 3.2 `splitPayout(recipients, opts)` — multi-settle batcher
Accepts a list >16 of `{ recipient, amount, releaseTime, secret? }` and
returns a sequence of `AuthorizeProofInput`s that fit the
`MAX_CLAIMS_PER_SIDE = 16` cap. Optional `onProgress` callback so the UI
can show "Signing 1 of 7…" while the user signs each batch.

Reason: 50-employee payroll otherwise demands either manual chunking or
silently dropping overflow. The split logic is uniform — bin-pack 16
per group; the residual change UTXO carries through.

Location: `packages/sdk/src/contracts/splitPayout.ts`.

### 3.3 `loadSettlementClaims(settlementAddress, settleTxOrId, readProvider)`
Pulls a settlement's full claims list (16 leaves), pairs each with its
on-chain claimed-or-not status (nullifier hit?). Used by Pay's run
detail page.

Reason: settlement events expose `claimsRoot` and `total`, but Pay needs
to display per-leaf state. Either the SDK reads the events + nullifier
mapping, or every UI duplicates that join.

Location: `packages/sdk/src/contracts/settle.ts` — add alongside
`callSettleAuth`.

### 3.4 `scanInbox(metaAddress, opts)` — recipient inbox scan
Given a recipient meta-address and a `fromBlock`, walk
`subscribeCommitmentInserted` (or the historical loader) and return the
`ClaimEntry`s whose `recipient` derives from the meta-address. Pairs
each with claim status (claimed / available / locked-until-date).

Reason: recipient inbox (`/inbox`) is the most-asked-for missing surface.
It needs both the stealth derivation and the settlement event scan in
one place; doing this in app code repeats stealth math.

Location: `packages/sdk/src/notes/scanInbox.ts`.

### 3.5 `resolveSenderIdentity(address, opts)` — zk-X509 org lookup
Returns `{ verified: boolean, orgName?: string, attestationUrl?: string }`
for a given address. Reads from the IdentityGate contract / User CA
registry. Used by Pay's claim page and inbox to display "Verified
sender."

Reason: identity flow already exists in `frontend/app/identity` but is
not exposed via the SDK. Other apps (Trade, Bills) will need the same
read path.

Location: `packages/sdk/src/identity/sender.ts` (new module).

## 4. Items Pay handles itself (off-chain)

These intentionally live outside the SDK because they're product
infrastructure, not protocol:

- Address book per organization (Postgres or similar).
- Org / team / billing state.
- Notification channels (email / Discord / Slack) and templating.
- Payslip PDF generation and signed export.
- Per-secret encrypted storage so we can re-render claim links to
  recipients who lost the original notification.
- Audit log.

## 5. Open questions to confirm before Phase A

These need the protocol team's confirmation; UX choices depend on the
answers.

1. **Self-pay (USDC → USDC).** ✅ **Confirmed allowed.** Maker = taker
   = same EOA with `sellToken == buyToken` and `sellAmount == buyAmount`
   is the supported "send to N recipients with scheduling" pattern.
   Pay's flow: sender deposits, signs both sides, claims distribute
   USDC to N recipients with per-recipient `releaseTime`.

2. **Single-side authorize.** ✅ Confirmed: when both sides specify the
   same token, the protocol effectively performs match-less distribution
   — i.e. self-pay (USDC → USDC) IS the match-less distribution path.
   Pay treats this as the canonical "send" call. Document the pattern
   in the SDK so future apps don't re-invent it.

3. **Relayer auto-pick policy.** ⏳ Deferred — will revisit. Pay
   defaults to round-robin from `loadActiveRelayers()` for now.

4. **`MAX_CLAIMS_PER_SIDE = 16`.** ⏳ Bump to consider, parallel track.
   Cost: re-compile `claims.circom` / `authorize.circom`, redo phase-2
   setup, redeploy verifiers, (possibly) migrate any in-flight
   unsettled orders. Sweet spot likely 32 (covers ~85% of typical
   payroll in 1 signature). Pay ships with `splitPayout` batching at
   16 and the bump is decided after observing real recipient-count
   distribution.

5. **`releaseTime` precision.** ✅ Confirmed: per-second is required.
   Pay's wizard exposes a datetime input (date + time + timezone),
   not a date-only picker.

## 6. Recommended order of work

1. **Confirm §5.1 + §5.2 with the protocol team** (15 min).
2. **Add §3.1 `getAvailableBalance`** to the SDK (small).
3. **Phase A** (Pay): wallet UX, dashboard balance card, wizard Step 2
   inline deposit, all on top of existing SDK + §3.1.
4. **Add §3.2 `splitPayout`** to the SDK before Phase A wizard ships,
   so >16-recipient runs are not blocked.
5. **Phase B** (Pay): inbox + claim page. Add §3.4 and §3.5 to the SDK
   ahead of these pages.
6. **Add §3.3 `loadSettlementClaims`** alongside Pay's run detail page
   (Phase D in the SPEC).

The SDK additions are scoped to thin helpers that wrap existing
primitives — they do not change protocol invariants and do not require
re-trusted-setup or new circuits.
