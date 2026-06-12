# `claimToPool` — **REMOVED**

> **This feature has been removed.** This page is kept as an audit-trail
> of the design and the reasons for removal.

## Status

`PrivateSettlement.claimToPool` and the accompanying `RedepositSplitModal`
in Pay were removed. The supported claim path is now `claimWithProof` /
`claimWithProofBatch` only. Users who want to deposit a claim into the
CommitmentPool call `pool.deposit(...)` as a separate transaction.

## Why it was removed

1. **Revert + churn**: Rev 1 was merged then reverted
   (`06b1a9fa Revert "Merge pull request #630 ... claim-to-pool"`); Rev 2
   shipped only after 5 follow-up review commits.
2. **Issue density**: the Rev 2 doc enumerated 11 distinct critical /
   high / medium / low issues addressed during development — slice
   front-running, recipient ↔ leaf mismatch, WETH unwrap routing,
   sanctions effectiveness, cross-flow grief, fee-on-transfer behaviour,
   commitment-scheme documentation, `insertCommitment(0)`, field-modulus
   checks, `uint256` sum overflow, `Panic(0x11)` preemption. The
   surface area was unusually large for a single user-facing function.
3. **Residual grief**: the cross-flow grief Copilot flagged was only
   partially closed. A mempool observer could still front-run a
   `claimToPool` broadcast with a plain `claimWithProof` consuming the
   same nullifier — funds reached the user but the pool-split intent
   was denied. Closing the residual hole would have required adding a
   `routingIntent` public signal to the claim circuit (full rebuild +
   phase-2 ceremony + vkey-tiered migration).
4. **Marginal benefit**: `claimWithProof` followed by `pool.deposit`
   delivers the same end state at the cost of one extra transaction.
   The privacy benefit of single-tx atomicity is small (timing-side-
   channel link still leaks via gas, address reuse), and recipients can
   already split into N pool commitments by calling `pool.deposit` N
   times.

The audit / maintenance cost was not justified by the user benefit.

## What replaces it

For users who want to deposit a stealth claim into the pool:

1. `claimWithProof(...)` — claim to the stealth EOA as usual.
2. `pool.deposit(...)` — submit a fresh deposit proof binding
   `commitment ↔ (token, amount)` for the desired commitment. Call N
   times for a split.

## Removed surface

- `PrivateSettlement.claimToPool` (function)
- `PrivateSettlement.ClaimToPoolSlice`, `ClaimToPoolParams` (structs)
- `PrivateSettlement.PrivateClaimToPool` (event)
- `MAX_CLAIM_TO_POOL_SLICES`, `CLAIM_TO_POOL_AUTH_TYPEHASH`,
  `_EIP712_DOMAIN_TYPEHASH`, `_EIP712_HASHED_NAME`, `_EIP712_HASHED_VERSION`
- Errors: `SumMismatch`, `TooManySlices`, `InvalidSlice`,
  `InvalidStealthSignature`
- Helpers: `_validateClaimToPoolPayload`, `_verifyStealthSignature`,
  `_verifyClaimProofToPool`, `_depositSlicesToPool`
- `contracts/test/ClaimToPool.t.sol`
- `packages/sdk/src/contracts/claimToPool.ts`
- `apps/pay/app/_components/RedepositSplitModal.tsx`,
  `apps/pay/app/_lib/redepositSubmit.ts`
- Redeposit buttons + state in `apps/pay/app/claim/page.tsx` and
  `apps/pay/app/stealth/inbox/page.tsx`

`claimWithProof` and `claimWithProofBatch` are unchanged — same proof
format, same nullifier slot, same recipient binding.
