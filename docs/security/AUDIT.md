# External audit package

One-stop entry for an external auditor reviewing the on-chain contracts. For
the *why* behind each safety-net layer, read
[`HARDENING.md`](./HARDENING.md) — this page is the *what* and *how to
reproduce*.

## In scope

Hand-written Solidity under `contracts/src/`:

| Contract | Path | Notes |
| --- | --- | --- |
| `PrivateSettlement` | `src/zk/PrivateSettlement.sol` | Half-proof + DEX-route + scatter entry points |
| `SettleVerifyLib` | `src/zk/SettleVerifyLib.sol` | Linked library — cross-side validators |
| `CommitmentPool` | `src/zk/CommitmentPool.sol` | Deposit/withdraw + incremental Merkle tree |
| `FeeVault` | `src/FeeVault.sol` | Relayer + platform fee accounting |
| `RelayerRegistry` | `src/RelayerRegistry.sol` | Bond-gated relayer set |
| `IdentityGate` | `src/IdentityGate.sol` | Multi-CA identity proof gating |
| `SanctionsList` | `src/SanctionsList.sol` | OFAC + KoFIU oracle composition |
| `BatchExecutor` | `src/BatchExecutor.sol` | EIP-7702-style batch tx executor |

All upgradeable contracts sit behind OpenZeppelin's
`TransparentUpgradeableProxy`. Each proxy spawns its own `ProxyAdmin` at
deploy time (see `contracts/script/DeployLocal.s.sol` and the helpers in
`contracts/test/utils/ProxyDeployer.sol`); the proxy-admin owner — set via
the `UPGRADE_OWNER` env, falling back to the deployer in local — is the
upgrade authority. Auditors should confirm the production
`UPGRADE_OWNER` is a multisig and that the storage baselines under
`contracts/storage-layouts/` match the deployed implementations.

## Out of scope

- `src/zk/*Verifier*.sol` — auto-generated Groth16 verifiers (snarkjs output).
  Findings here are circom-generator artifacts, not hand-written bugs.
- `src/zk/IncrementalMerkleTree.sol` — near-verbatim port of the Tornado Cash
  upstream (well-audited). Diff against the original if it changes.
- `frontend/`, `zk-relayer/`, `circuits/` — off-chain. The contract audit
  treats anything that crosses the contract ABI as untrusted input.
- `apps/*` — production frontends; off-chain.

## Reproduce the safety-net checks

All commands run from the repo root unless noted.

### Foundry — unit + branch + invariant suites

```bash
cd contracts

# 417 unit/branch tests + 29 invariants across 8 suites (~6 min).
# Skips fork tests (which need a live RPC).
forge test --no-match-contract Fork

# Gas snapshot drift check against committed baseline:
forge snapshot --check --no-match-contract Fork

# Deep profile: 10000 fuzz runs, 1024 × 2000 invariant calls (~hours).
# Same code, just more samples.
FOUNDRY_PROFILE=deep forge test --no-match-contract Fork
```

The deep profile is what the nightly CI in
`.github/workflows/deep-fuzz.yml` runs at 02:00 UTC.

### Slither — 0-findings baseline

```bash
cd contracts
slither . --config-file slither.config.json
```

Config excludes auto-generated verifiers + the IncrementalMerkleTree port,
plus 9 known-noise detectors. Reentrancy / arbitrary-send-eth / assembly /
low-level-call detectors are intentionally kept — see
[`HARDENING.md`](./HARDENING.md#static-analysis) for the rationale.

### Storage layout drift

```bash
cd contracts
./script/storage-layout/check.sh
```

Compares `forge inspect`-emitted layouts against
`contracts/storage-layouts/*.json`. Drift = upgrade-unsafe slot shift.

### Fork tests (manual / opt-in)

```bash
cd contracts
ETH_MAINNET_RPC_URL=<rpc> forge test --match-contract Fork
```

Runs the Uniswap V3 + Curve real-router settlement paths against a
pinned-block mainnet fork.

## Artifact manifest

| Artifact | Location | What it tells you |
| --- | --- | --- |
| Hardening overview | [`docs/security/HARDENING.md`](./HARDENING.md) | Full description of every safety-net layer |
| Invariant catalog | [`HARDENING.md#invariant-catalog`](./HARDENING.md#invariant-catalog) | 29 invariants, what each one asserts |
| Manual-verification checklist | [`HARDENING.md#manual-verification-recommendations-auditor-checklist`](./HARDENING.md#manual-verification-recommendations-auditor-checklist) | 5 items the safety net cannot mechanise |
| Gas baseline | `contracts/.gas-snapshot` | 400-test gas baseline; CI fails on drift |
| Slither config | `contracts/slither.config.json` | Detector + path filters, with inline rationale |
| Storage baselines | `contracts/storage-layouts/*.json` | One JSON per upgradeable contract |
| Compliance write-ups | [`docs/cex-compliance/`](../cex-compliance/) | KoFIU / OFAC enforcement model |
| Whitepaper | [`developers/docs/whitepaper.mdx`](../../developers/docs/whitepaper.mdx) | End-to-end protocol design + threat model (supersedes the removed `docs/research/PAPER.md`) |
| CI workflows | [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml), [`deep-fuzz.yml`](../../.github/workflows/deep-fuzz.yml) | What runs on every PR vs. nightly |

## Toolchain pins

| Tool | Version | Pinned by |
| --- | --- | --- |
| `forge` / `cast` | 1.5.1 | `foundry.lock` |
| `solc` | 0.8.28 | `foundry.toml` |
| `slither` | bundled with `crytic/slither-action@v0.4.0` | CI |

`foundry.lock` is the source of truth for local reproduction; CI installs the
same version via `foundryup --version` in the workflow.

## Reporting

File findings via GitHub's [private security
advisory](https://github.com/tokamak-network/scatter-dex/security/advisories/new)
flow on this repository — one advisory per finding, with a minimal repro
or a failing forge test where applicable. For the live tracker of
already-known items, see `SECURITY_ISSUES.md` at the repo root.
