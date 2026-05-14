# Smart-contract hardening

What an external auditor should know before reading the contracts. This page is
the single source of truth for the CI safety-net layers (see the `Triggered by`
column for each layer's exact trigger); if you change one of them, update the
corresponding section here.

> Looking for scope + reproduction commands? See [`AUDIT.md`](./AUDIT.md).

## Layers in place

| Layer | Gate | Triggered by | Scope |
| --- | --- | --- | --- |
| Foundry unit + branch tests + gas snapshot drift | `forge snapshot --check --no-match-contract "Fork\|Invariant"` in CI | every PR | 388 unit + branch tests against `contracts/.gas-snapshot` baseline (invariants split into the parallel job below) |
| Storage layout drift | `script/storage-layout/check.sh` in CI | every PR | every upgradeable contract |
| Slither static analysis | `crytic/slither-action@v0.4.0` in CI | every PR | `contracts/src/`, 0-findings baseline |
| Foundry **invariant suite** | parallel `contracts / invariant` CI job (default 256 runs × 500 calls) | PRs touching `contracts/**` or `ci.yml`; always on `push` to `main` | 31 invariants across 8 suites |
| **Deep fuzz / invariant** | `forge test` w/ `FOUNDRY_PROFILE=deep` | nightly cron @ 02:00 UTC + manual dispatch | 10000 fuzz runs, 1024×2000 invariant |
| Mainnet fork tests | `forge test --match-contract Fork` | manual dispatch | Uniswap V3 + Curve real-router checks |

CI workflows live in `.github/workflows/ci.yml` (per-PR) and
`.github/workflows/deep-fuzz.yml` (nightly).

## Invariant catalog

Every contract under `contracts/src/` (except the auto-generated `*Verifier*.sol`
and `IncrementalMerkleTree.sol`) has at least one invariant suite. Default
profile: **256 runs × 500 calls per invariant ≈ 128 k state transitions** per
PR. Deep profile bumps this to 1024 × 2000.

| Contract | Suite | # invariants | Key properties |
| --- | --- | --- | --- |
| `FeeVault` | `FeeVaultInvariant.t.sol` | 5 | solvency, `totalTracked == Σbalances`, platform-revenue mirror, treasury receipts, fee bps ≤ cap |
| `RelayerRegistry` | `RelayerRegistryInvariant.t.sol` | 3 | bonds covered, active relayers respect `MAX_FEE`, `relayerList` uniqueness |
| `PrivateSettlement.cancelPrivate` | `PrivateSettlementCancelInvariant.t.sol` | 3 | nullifier monotonicity (escrow + nonce), claim mapping isolation, leaf count ≥ cancel count |
| `PrivateSettlement.scatterDirect + claimWithProof` | `ScatterClaimInvariant.t.sol` | 6 | **`totalClaimed ≤ totalLocked`**, group mirror, claim nullifier monotonicity, settlement escrow coverage, per-recipient balance ledger, adversarial claim attempts never inflate claimed |
| `PrivateSettlement.settleAuth + settleWithDex + scatterDirectAuth + claimWithProof` | `PrivateSettlementSettleInvariant.t.sol` | 4 | **`totalClaimed ≤ totalLocked`**, group mirror (incl. token), escrow + nonce + claim nullifier monotonicity, per-token settlement escrow coverage |
| `CommitmentPool` | `CommitmentPoolInvariant.t.sol` | 5 | solvency, withdraw-nullifier monotonicity, leaf-count floor, whitelist stability, `insertCommitment` access control |
| `SanctionsList` | `SanctionsListInvariant.t.sol` | 2 | self-managed map mirror, `isSanctioned` ≡ `sanctioned` when no oracle wired |
| `IdentityGate` | `IdentityGateInvariant.t.sol` | 3 | `length ≤ MAX_REGISTRIES`, at-least-one registry, array uniqueness ↔ `registryExists` mirror (both directions) |

The harness uses `Mock*Verifier` contracts that accept any proof. This
deliberately moves the harness above the proof layer so the runner stresses the
**on-chain accounting**, not the proof system — drift in `totalLocked /
totalClaimed`, nullifier mappings, leaf counts, balance flows.

## Static analysis

Slither runs on every PR with `fail-on: low`, against a committed
`contracts/slither.config.json`. The baseline is **0 findings**:

- `filter_paths` excludes `lib/`, `test/`, `script/`, auto-generated verifier
  files (`src/zk/*Verifier*.sol`), and `IncrementalMerkleTree.sol`. The
  verifiers are circom-generated — findings there are artifacts of the
  generator, not hand-written bugs. `IncrementalMerkleTree.sol` is
  hand-written but adapted near-verbatim from Tornado Cash (well-audited
  upstream); we exclude it to keep noise out of the hand-written diff
  budget. Any change to it should be diffed against the Tornado original.
- `detectors_to_exclude` strips known-noise detectors only
  (`naming-convention`, `solc-version`, `too-many-digits`, `similar-names`,
  `immutable-states`, `uninitialized-local`, `calls-loop`, `timestamp`,
  `constable-states`). The
  intentionally **kept** detectors — `assembly`, `low-level-calls`,
  `arbitrary-send-eth`, all reentrancy detectors — make any new occurrence
  in hand-written code fail CI.
- Where a real low-level call or reentrancy-shaped pattern is necessary, an
  inline `slither-disable-next-line` directive sits directly above the call
  with the justification on the line above (greppable):
  - `src/RelayerRegistry.sol`: native bond push to the original bond owner.
  - `src/zk/PrivateSettlement.sol`: balance-before/after around the DEX
    router call in `settleWithDex` (guarded by `nonReentrant`).
  - `src/zk/PrivateSettlement.sol`: nullifier write after `pool.withdrawFor`
    in `scatterDirect` (guarded by `nonReentrant`, pool is trusted).
  - `src/zk/PrivateSettlement.sol` and `src/zk/SettleVerifyLib.sol`:
    `insertCommitment` return value (leaf index) consumed via the
    `CommitmentInserted` event, not the return value.

Aderyn was evaluated but currently panics on `evm_version: prague` and
unrelated internal asserts (Aderyn 0.1.9 vs Foundry 1.5.1). Re-evaluate when
Aderyn catches up to the current Foundry release.

## Gas + storage drift

- `contracts/.gas-snapshot` is the committed gas baseline (396+ entries).
  `forge snapshot --check` runs on every PR and **fails the build on any
  drift**. To intentionally bump it: `cd contracts && forge snapshot
  --no-match-contract Fork`, then commit. The same recipe is documented
  inline in `.github/workflows/ci.yml`.
- `contracts/storage-layouts/` holds a per-contract storage-layout
  snapshot. `script/storage-layout/check.sh` diffs the current layout
  against the committed JSON (slot, offset, type) for every upgradeable
  contract — a shifted slot fails CI. This is the safety net against
  storage-layout corruption during proxy upgrades.

## Foundry version

Pinned to `v1.5.1` in `.github/workflows/ci.yml` (and the same in
`deep-fuzz.yml`). The pin was originally added to dodge the `version:
stable` GitHub API 403 (see commit `8cbab7e8`) but is now load-bearing —
gas measurements differ across Foundry releases (a ~+2500-gas drift
between `v1.0.0` and `v1.5.1`), so the committed snapshot is only valid
under the pinned toolchain.

## Manual verification recommendations (auditor checklist)

The automated gates above catch a lot. The things they don't, and an
auditor still should verify:

1. **Circuit ↔ on-chain public-signal binding.** Mock verifiers accept any
   proof. `SettleVerifyLib`, `PrivateSettlement._executeClaim`, and the
   tier-specific claim verifiers each construct a `pubSignals` array in a
   specific order. Walk each `pubSignals` constructor and confirm the
   circuit's signal order matches.
2. **Tier dispatch** (`claimVerifierByTier`). Tiers 16 / 64 / 128 are wired
   to distinct verifier binaries. Confirm that each verifier expects the
   `claimsTreeDepth` advertised by its tier (otherwise `verifyProof` will
   accept stale or out-of-tier proofs).
3. **Slippage on `settleWithDex`.** The balance-before/after pattern around
   the DEX router is the only enforcement of "received ≥ totalLocked". If
   the router has a callback that lets the caller pre-credit the buyToken
   balance, the check can be bypassed. Whitelisted routers are owner-set,
   so this is operational hardening rather than code hardening — confirm
   the whitelisted set never includes a callback-supporting router.
4. **`authorizedSettlement` timelock vs immediate setter.**
   `CommitmentPool.setAuthorizedSettlement` is *immediate* and one-shot
   (errors if already set). After deployment, all changes must route
   through `queueSetAuthorizedSettlement` → 24-hour timelock →
   `activateAuthorizedSettlement`. Confirm the deploy script never wires a
   second `setAuthorizedSettlement` after the first.
5. **External oracle DoS surface.** `SanctionsList.isSanctioned` wraps the
   external oracle call in `try/catch` so a misbehaving oracle returns
   `false` instead of reverting. Confirm this is desirable policy: a
   silenced oracle effectively whitelists everyone the local map doesn't
   flag. The legal/compliance write-up is in
   `docs/cex-compliance/SANCTIONS-ENFORCEMENT-MODEL.md`.

## How to extend

- **New invariant suite.** Place `*Handler.sol` (actor-based) + `*Invariant.t.sol`
  (assertions) under `contracts/test/invariant/`. Run `forge test --match-path
  "test/invariant/<name>*"`. Then `cd contracts && forge snapshot
  --no-match-contract Fork` and commit the new entries in
  `contracts/.gas-snapshot`.
- **Tighten an existing one.** Prefer adding a new `invariant_*` function over
  bolting more assertions onto an existing one — surfacing a single failure
  reason is more useful at audit time than a polyglot block.
- **Suppress a Slither finding.** First check that `filter_paths` / detector
  exclusion in `slither.config.json` is the right tool. Otherwise add an
  inline `slither-disable-next-line <detector>` directly above the offending
  statement with the WHY on the line above (greppable rationale).
