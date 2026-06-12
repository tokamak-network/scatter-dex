# Upgradeable Contracts Migration — Plan & Tracking

## Goal
Convert scatter-dex's non-verifier core contracts to **TransparentUpgradeableProxy** so the same artifacts ship to dev and mainnet. Verifiers stay immutable (tier-registry already handles vkey rotation). Mainnet-grade safety nets included from day 1.

## Pattern Choice — Transparent (final)
- Lock-out risk: zero (vs UUPS where a bad `_authorizeUpgrade` bricks upgrades). Critical because dev = mainnet.
- ProxyAdmin owner is the single upgrade authority — easy to migrate `owner()` to a Safe / Timelock later.
- Gas overhead per call: ~50 — negligible vs the safety win.

## Scope (in / out)

| Contract | Convert? | Reason |
|---|---|---|
| `FeeVault` | ✅ | accumulates relayer balances + platform revenue |
| `SanctionsList` | ✅ | onlyOwner set/unset, may add new sanction-source logic |
| `IdentityGate` | ✅ | already has admin (`addRegistry`); upgrade for verifier-routing changes |
| `RelayerRegistry` | ✅ | relayer staking/registration logic |
| `CommitmentPool` | ✅ | Merkle tree + deposit/withdraw state; storage layout especially load-bearing |
| `PrivateSettlement` | ✅ | core protocol; most likely to need patches |
| `BatchExecutor` | ❌ | stateless utility — redeploy at new addr if changed |
| `StealthTransferAccount` | ❌ | EIP-7702 delegation target — users re-delegate to upgrade |
| `*Verifier.sol` | ❌ | already swappable per-tier via `claimVerifierByTier`, `authorizeVerifierByTier`, etc. |
| `MockIdentityRegistry`, mock tokens | ❌ | test-only |

## Per-Contract Change Checklist
For each contract:

- [ ] Replace `Ownable2Step` → `Ownable2StepUpgradeable`
- [ ] Replace `Ownable` (transitive) → `OwnableUpgradeable`
- [ ] Replace `ReentrancyGuard` → `ReentrancyGuardUpgradeable`
- [ ] Add `Initializable` to inheritance list
- [ ] Constructor → `initialize(address initialOwner, …)` with `initializer` modifier
- [ ] Implementation constructor calls `_disableInitializers()` + `@custom:oz-upgrades-unsafe-allow constructor`
- [ ] All `__X_init()` chained inside `initialize()` in the same order as inheritance
- [ ] Add `uint256[50] private __gap;` at end of state (decrement when new state added)
- [ ] `renounceOwnership` override uses `override(OwnableUpgradeable)` not the non-upgradeable parent
- [ ] All inline storage that previously used `immutable` becomes regular state vars (immutables themselves are accessible through a proxy — they live in the implementation's bytecode — but they can only be set in the constructor, and the proxy never runs the implementation's constructor; per-instance values must therefore move to regular state and be assigned inside `initialize()`)

## Deploy Script (`DeployLocal.s.sol`) Pattern
For each convertible contract `X`:
```solidity
X implX = new X();
bytes memory initData = abi.encodeCall(X.initialize, (UPGRADE_OWNER, …));
TransparentUpgradeableProxy proxyX = new TransparentUpgradeableProxy(
    address(implX),
    PROXY_ADMIN_OWNER, // admin of THIS proxy's auto-created ProxyAdmin
    initData
);
X x = X(address(proxyX));
```
- `UPGRADE_OWNER`: env-read, default to `msg.sender` (deployer). Mainnet → multisig address.
- `PROXY_ADMIN_OWNER`: same env (typically). Each proxy auto-creates its own ProxyAdmin owned by this address. (OZ v5 pattern — single ProxyAdmin per proxy is the recommended setup.)
- Update all downstream `new X(...)` references to `address(proxyX)`.

## Tests (~200 existing) — Migration Strategy
1. Centralise proxy boilerplate in `test/utils/Deployers.sol` so each test isn't a 10-line dance.
2. Replace each `X x = new X(...)` with `X x = _deployFeeVaultProxy(...)` helper.
3. Add invariant tests:
   - Re-init: calling `initialize()` twice reverts with `InvalidInitialization`.
   - `_disableInitializers`: implementation contract's `initialize()` reverts.

## Mainnet-Bound Safety Nets (Required Bonus Items)

### A. Storage Layout Snapshot CI ⚠️ critical
- Add `script/storage-layout/snapshot.sh` that runs `forge inspect <Contract> storage` for every upgradeable contract, writes JSON to `storage-layouts/<contract>.json`.
- Commit the v1 baseline.
- CI script `script/storage-layout/check.sh` re-runs and `git diff --exit-code` against baseline — block PRs that shift slots.
- Update baseline only as part of a deliberate upgrade PR.

### B. Initializer Guard ✅ in per-contract checklist
- `_disableInitializers()` in implementation constructor (already in checklist).
- Unit test asserting impl `initialize()` reverts confirms it.

### C. Upgrade Simulation Test ⚠️ critical
- Per contract: deploy V1 → write state → upgrade to V2 (a minimal V2 mock that adds a new var) → assert V1 state preserved + new V1 fields readable + new V2 fields writable.
- Live in `test/upgrade/<Contract>.upgrade.t.sol`.

### D. Pausable Layer (decide post-pilot)
- Add `PausableUpgradeable` to PrivateSettlement + CommitmentPool only (where attacker action lives).
- `pause()` `onlyOwner` — flip on right before upgrade to drain in-flight calls.
- Decide at end whether to ship as part of this PR series or follow-up.

### E. Timelock for Upgrade Authority (mainnet only)
- 48-72h delay on `proxyAdmin.upgrade()`.
- Implemented as: deploy `TimelockController` → transfer ProxyAdmin ownership to timelock → all upgrades flow through `schedule()` + `execute()`.
- Doable in a separate PR after this one merges.

### F. Multisig (mainnet only)
- Replace `UPGRADE_OWNER` env value with Safe deployment address.
- No code change needed if env-pattern works.

## PR Sequence

| # | PR title | Contents |
|---|---|---|
| 1 | `feat(contracts): add OZ-upgradeable dependency + remapping` | submodule + remappings + foundry skip filters |
| 2 | `feat(contracts): convert FeeVault to TransparentUpgradeableProxy (pilot)` | FeeVault + test fixture + storage snapshot baseline for FeeVault + re-init revert test |
| 3 | `feat(contracts): convert SanctionsList, IdentityGate, RelayerRegistry` | same pattern, three at once because of simplicity |
| 4 | `feat(contracts): convert CommitmentPool` | core; baseline snapshot |
| 5 | `feat(contracts): convert PrivateSettlement` | core; baseline snapshot |
| 6 | `feat(deploy): wire DeployLocal + UPGRADE_OWNER env + storage CI` | consolidate deploy + add CI step |
| 7 | `feat(contracts): upgrade-simulation tests for all 6` | per-contract V1→V2 test |
| 8 | `feat(contracts): PausableUpgradeable on protocol entry points` | optional; CommitmentPool + PrivateSettlement |

PR 1 must merge before any of 2-5. PR 6 must come after 2-5. PR 7+8 can run in parallel with 6.

## Migration Status (this branch)

- [x] PR 1: OZ-upgradeable installed at `lib/openzeppelin-contracts-upgradeable@v5.4.0`. Remapping added.
- [ ] PR 2: FeeVault pilot in flight; compile error to debug.
- [ ] PR 3-8: pending pilot validation.

## Open Questions / Decisions Recorded

- **Q: Single ProxyAdmin or one-per-proxy?**
  A: One-per-proxy (OZ v5 default). Simpler ownership model — transfer each ProxyAdmin to timelock individually. Slight storage overhead but isolates failure domain.

- **Q: `UPGRADE_OWNER` env default?**
  A: `msg.sender` (deployer) when unset — convenient for local. CI/mainnet must set explicitly. Will surface a warning when defaulted.

- **Q: Existing on-chain deployments?**
  A: TBD — confirm before any mainnet ship that there isn't user state on the immutable v0 contracts to migrate.
