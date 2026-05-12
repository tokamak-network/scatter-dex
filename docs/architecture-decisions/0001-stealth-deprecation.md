# ADR 0001 — Stealth address surface deprecation

**Status:** Accepted (2026-05-12)
**Phase:** 2 (in progress)
**Predecessor:** PR #660 (Phase 1 — user-facing surface)

## Context

Phase 1 removed stealth-address mentions from landing pages, app
navigation, README copy, and the user-facing portion of the docs
site. Phase 1 explicitly did **not** touch the SDK module surface,
the EIP-7702 stealth delegate (`StealthTransferAccount.sol`), the
app-level imports inside `apps/pay`, `apps/pro`, `mobile`, or the
SDK API code samples in `developers/docs/guides/*`.

The compliance posture documented in `docs/cex-compliance/` calls
for stealth-address functionality to be removed from the production
surface entirely. Carrying the surface forward in code, even
unlinked from the UI, leaves consumers who reach for the SDK
directly able to compose a mixer-adjacent flow, and creates an
ongoing maintenance burden as the rest of the protocol moves on
(EIP-7702 batch executor evolves, identity gate adds path-specific
checks, etc.).

The transparent-proxy upgrade infrastructure landed in PR #659.
That eliminates the storage-layout concern that previously argued
for keeping the stealth contract alongside the rest of the
production set: future upgrades can drop the stealth delegate
without breaking the rest of the deployment.

## Decision

Retire the stealth-address surface from the ScatterDEX SDK,
contracts, and app suites. Roll out across four PRs:

| PR | Scope | Files (approx) |
|---|---|---|
| **2.1** (this PR) | Add `@deprecated` JSDoc on the SDK stealth modules + write this ADR. Non-breaking. | 4 SDK files + this ADR |
| **2.2** | Remove `apps/pay` internal stealth dependencies (`relay7702.ts`, `walletBook.tsx`, `parseRecipientFile.ts`, `AddressBookPicker.tsx`, `_SendModal.tsx`, `address-book/page.tsx`, `payouts/new/page.tsx`, `payouts/detail/page.tsx`, `claim/page.tsx`, etc.). Delete the `/stealth/*` route tree. | ~10 files in `apps/pay` |
| **2.3** | Remove `apps/pro` internal stealth dependencies. Delete the `/stealth/*` route tree. | ~5 files in `apps/pro` |
| **2.4** | Remove mobile stealth modules (`mobile/src/lib/stealth.ts`, `mobile/src/services/StealthIdentityService.ts`). Clean up `frontend/` legacy references. Delete `contracts/src/StealthTransferAccount.sol` + its test file. Remove the SDK stealth modules and update `packages/sdk/src/zk/index.ts` / `packages/sdk/src/storage/index.ts` exports. Update remaining docs/guides code samples. | mobile + frontend + contracts + SDK final cleanup |

Each PR is independently mergeable; consumers between PRs continue
to see the `@deprecated` markers until 2.4 closes the surface.

## Consequences

### What this PR (2.1) does
- A file-level `@deprecated` JSDoc block at the top of each of
  `packages/sdk/src/zk/stealth.ts`,
  `packages/sdk/src/storage/stealthKeys.ts`,
  `packages/sdk/src/storage/stealthInbox.ts`, and
  `packages/sdk/src/react/metaAddress.tsx` for human readers.
- An additional **per-export `@deprecated` JSDoc** on every public
  export in those four files (functions, classes, interfaces, type
  aliases). This is what TypeScript / TypeScript-aware IDEs (VS
  Code, IntelliJ, WebStorm) actually consume to render the
  strikethrough on use sites — a file-level block on its own does
  not propagate to individual exports.
- No code paths are removed; no existing import breaks.
- CI is not configured to fail on `@deprecated`; builds continue
  green.
- This ADR is the canonical reference each PR cites in its commit
  message and PR body.

### What this PR (2.1) does NOT do
- No contract changes (`StealthTransferAccount.sol` remains
  deployable in `DeployLocal.s.sol`).
- No app changes — `apps/pay`, `apps/pro`, `mobile`, `frontend`
  continue to import and use the stealth modules. The user-facing
  surface stays as it was after PR #660 (UI hidden from navigation
  and from the marketing/docs surface).
- No SDK export changes — the modules remain in
  `packages/sdk/src/zk/index.ts` and
  `packages/sdk/src/storage/index.ts`.

### Migration guidance for SDK consumers
- Stop calling `generateMetaAddress`, `parseMetaAddress`,
  `generateStealthAddress`, `deriveStealthPrivateKey`,
  `stealthWallet`, and related helpers in new code.
- Replace stealth recipients with the user's plain wallet address
  in the `claim` payload. The on-chain `claim` circuit accepts both
  forms; the only difference is the derivation of the spending
  key. Plain EOAs need no derivation.
- For storage, stop reading from `stealthKeys.ts` /
  `stealthInbox.ts`; use `walletBook.ts` and `claimInbox.ts`
  instead.
- React consumers should drop the `<MetaAddressProvider>` wrapper.

### Reverting
PRs 2.2–2.4 each remove code paths; reverting them is mechanical
but takes commit-by-commit reverts (no schema migrations involved
since stealth state is not persisted on-chain). This PR itself is
trivially reversible — re-add or remove the `@deprecated` blocks.

## References

- PR #660 — Phase 1 marketing/docs removal
- PR #659 — Transparent-proxy upgrade infrastructure (unblocks
  Phase 2 by removing the storage-layout coordination concern)
- `docs/cex-compliance/BOUNDARY-MEMO.md` — the compliance posture
  this trajectory aligns with
- `docs/cex-compliance/MARKETING-COMPLIANCE-GUIDELINES.md` — the
  language guidelines that the deprecation supports
