# Admin Wallets and Upgrade Policy

This document is the canonical reference for administrative
authority over ScatterDEX's on-chain contracts. It exists so an
exchange compliance team can answer two questions without reading
the source:

1. **Who can change a contract's logic, parameters, or owner — and
   under what process?**
2. **What happens during an incident (pause, upgrade, rollback)?**

Exchanges treat undeclared upgrade authority as a high-risk
indicator; this document is the answer to that question.

## Upgrade architecture

All upgradeable contracts use OpenZeppelin's
`TransparentUpgradeableProxy`. The proxy holds storage; the
implementation contract holds logic. Upgrades are performed by the
proxy admin replacing the implementation address.

Upgradeable contracts (PRs #659, #661, and the upgrade-track
follow-ons):

- `CommitmentPool`
- `PrivateSettlement`
- `FeeVault`
- `RelayerRegistry`
- `SanctionsList`
- `IdentityGate` (multi-CA aggregator — `Initializable +
  Ownable2StepUpgradeable + __gap`. Logic can be replaced via the
  proxy; `addRegistry` / `removeRegistry` add/remove child
  registries without an upgrade.)

Non-upgradeable (immutable bytecode):

- Per-tier Groth16 verifier contracts (`AuthorizeVerifier`,
  `ClaimVerifier`, `CancelVerifier`, `DepositVerifier`,
  `WithdrawVerifier`, `BatchAuthorizeVerifier`)
- `BatchExecutor` (ERC-7579 + EIP-7702 batch executor for the
  deposit one-shot flow)

When a circuit changes, the deploy of a new verifier is **not** an
upgrade — it's a new contract address that the relevant manager
registers via `PrivateSettlement.setAuthorizeVerifier(uint8 tier, address verifier)`
or `setClaimVerifier(uint8 tier, address verifier)`.

## Roles

| Role | Authority | Held by (target) |
|---|---|---|
| **Proxy admin** | Replaces a proxy's implementation. Cannot read or write contract storage directly. Cannot transfer ownership of the implementation's logic. | Dedicated `ProxyAdmin` contract owned by the multisig. Each upgradeable proxy has its own admin instance to limit blast radius. |
| **Owner** (per contract, `Ownable2Step` / `Ownable2StepUpgradeable`) | Calls owner-gated mutators on a specific contract: registry add/remove, **pause/unpause via `pause()` / `unpause()`** (OpenZeppelin `PausableUpgradeable` since PR #677), fee-collector update, per-tier verifier registration. The owner is the only role that can pause — there is no separate `Pauser` permission today. | Operations multisig. |
| **Identity registry CA** | Adds / removes individual zk-X509 registries inside `IdentityGate`. | `IdentityGate.owner`, set to the operations multisig. |
| **Sanctions list manager** | Adds / removes addresses from `SanctionsList`. | `SanctionsList.owner`, set to the operations multisig. |
| **Relayer registrar** | Self-service via the `RelayerRegistry` contract; operators bond, post fees, exit on cooldown. | Each relayer EOA, gated by the registry's own modifiers. No external admin role. |

The multisig threshold and signer set are published alongside the
deployment summary on the explorer once the production deployment
lands. See [CONTRACT-ADDRESSES.json](./CONTRACT-ADDRESSES.json) for
the per-network owner address; this file documents the role
**type**, that file documents the role **holder**.

## Upgrade procedure (steady state)

Routine, planned upgrade (e.g. add a feature, fix a non-critical
bug):

1. **Author the change** on a PR branch. Same `simplify` → test →
   bot-review → merge workflow as any other production code.
2. **Storage-layout check.** The contracts repo ships
   `script/storage-layout/check.sh` and reference snapshots under
   `contracts/storage-layouts/`. The CI workflow `Storage-Layout`
   runs this on every PR that touches an upgradeable contract.
   A storage drift fails the check and blocks the merge.
3. **Deploy the new implementation** from main. Use the network's
   dedicated deployer key; the deploy script publishes the
   implementation address and verifies it on the network's
   block explorer.
4. **Announce.** Post the upgrade plan to the operator channel
   (target proxy, new implementation address, ABI diff, expected
   on-chain timestamp). Minimum lead time: 48 hours for production.
5. **Schedule on the multisig.** The proxy admin (multisig-owned)
   queues `upgradeAndCall` (or `upgrade`) on the target proxy.
   Standard multisig threshold applies.
6. **Execute.** Multisig signers approve; the tx lands on-chain.
7. **Post-upgrade verification.** Confirm the proxy's
   `implementation()` matches the new address, source verification
   is green on the explorer, and an integration test against the
   live deployment passes.
8. **Update [`CONTRACT-ADDRESSES.json`](./CONTRACT-ADDRESSES.json)**
   in the same week, including the new implementation address in
   the `history` array.

## Upgrade procedure (incident)

Critical bug or active exploit:

1. **Pause first.** The owner multisig calls `pause()` on the
   affected contracts (each contract has its own owner-gated
   `pause()` / `unpause()` from OpenZeppelin `PausableUpgradeable`;
   there's no global pause). This freezes the relevant entry
   points immediately; no upgrade is needed to stop the bleed.
2. **Notify.** Post an incident notice (operator channel, the
   project's public status page, and the exchange contact list
   from this pack). Include: which contract is paused, what's
   blocked, expected unpause timestamp, and contact info for
   recovery questions.
3. **Author + verify the fix.** Same path as a routine upgrade,
   but parallel-tracked under the incident channel. Storage-layout
   check still applies — the fix doesn't waive integrity.
4. **Execute the upgrade.** Multisig deploys + upgrades on the
   compressed timeline. Document the deviation from the routine
   procedure in the incident post-mortem.
5. **Unpause and post-mortem.** Once monitoring confirms the fix
   on-chain, unpause. Publish the post-mortem within 7 days
   covering: timeline, root cause, what was at risk, what we
   changed, follow-ups. Filed under `docs/incidents/` and linked
   from this doc's history.

## What this policy does NOT do

- **Does not allow silent upgrades.** The proxy admin is held by a
  multisig; a single key cannot upgrade without quorum.
- **Does not allow storage drift.** The CI storage-layout check
  catches a layout that's incompatible with the live state before
  the proxy can be flipped.
- **Does not provide a global pause for the whole protocol.**
  Each pausable contract owns its own paused state through
  OpenZeppelin `PausableUpgradeable` and owner-gated `pause()` /
  `unpause()`; entry points use the `whenNotPaused` modifier (or
  an equivalent revert) to gate execution. The incident-response
  team targets only the affected surface — there's no single
  switch.
- **Does not permit ownership transfer outside the documented
  multisig.** `Ownable2Step` enforces a two-step accept; an
  accidental ownership transfer to an external EOA is not possible
  without the receiver also signing.
- **Does not provide backdoor read access to user secrets.** The
  contracts have no admin function that can read user `secret`,
  `balance`, `salt`, or `claimSecret`; those never reach on-chain
  state. The proxy admin can replace logic but cannot decrypt or
  redirect privately held witness values.

## Monitoring hooks for exchanges

What an exchange's compliance team should subscribe to:

| Event | Source | Triggered when |
|---|---|---|
| `Upgraded(address indexed implementation)` | Each upgradeable proxy | Implementation address changes. |
| `OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)` | Each `Ownable2Step` / `Ownable2StepUpgradeable` contract (`CommitmentPool`, `PrivateSettlement`, `IdentityGate`, etc.) | Owner transfer is queued (before the new owner accepts). **Not** emitted by OZ `ProxyAdmin`, which uses `Ownable`. |
| `OwnershipTransferred(address indexed previousOwner, address indexed newOwner)` | Every owned contract above, plus `ProxyAdmin` | Owner transfer is accepted (for `Ownable2Step*`) or transferred outright (for `Ownable`-only `ProxyAdmin`). |
| `Paused(address account)` / `Unpaused(address account)` | Every pausable contract (`CommitmentPool`, `PrivateSettlement`) via OZ `PausableUpgradeable` | Owner calls `pause()` or `unpause()`. The `account` is the caller (the owner multisig). Both contracts emit the same canonical OZ event shape; previously each had a custom event (`Paused(bool)` / `PausedUpdated(bool)`), which PR #677 replaced. |
| `AdminChanged(address previousAdmin, address newAdmin)` | Each `TransparentUpgradeableProxy` | Proxy admin transferred. Rare. |
| Sanctions list mutation | `SanctionsList` (event named per the contract) | Address added or removed. |
| `IdentityGate` registry mutation | `IdentityGate` (event named per the contract) | A child registry is added or removed from the aggregator. |

The address pack ([`CONTRACT-ADDRESSES.json`](./CONTRACT-ADDRESSES.json))
lists the per-network proxy and admin addresses for each of these
sources.

## History

- 2026-05-12 (initial) — Reflects the upgrade-track work landed in
  PRs #659 (TransparentUpgradeableProxy infra) and #661 (FeeVault
  converted). Subsequent upgrade-track PRs add other upgradeable
  contracts; this document is updated in the same PR whenever
  the set changes.
- 2026-05-12 (PR #677 follow-up) — Pause mechanism rewritten to
  match the `PausableUpgradeable` migration: roles row, incident
  procedure, and the monitoring events table now describe
  `pause()` / `unpause()` and the canonical OZ `Paused(address)` /
  `Unpaused(address)` events. The previous custom `Paused(bool)`
  / `PausedUpdated(bool)` events no longer exist.
