# zkScatter

A privacy-preserving DEX with compliant identity gating. Trades are executed off-chain via ZK relayers; settlements use **ZK Private Settlement** — Groth16 proofs with commitment pools hide trader identities and claim structure on-chain, while zk-X509 identity gating ensures regulatory compliance.

> Privacy + Compliance — see [docs/research/PAPER.md](docs/research/PAPER.md) for the full research paper.

## Architecture

```
Frontend (Next.js)  →  ZK Relayer (Node.js)   →  Contracts (Solidity / Foundry)
     ↕                      ↕                            ↕
  MetaMask            Order matching             PrivateSettlement (ZK)
  EdDSA keys          ZK proof generation        CommitmentPool (incremental Merkle tree)
                      Gasless claims             RelayerRegistry
                                                 IdentityGate (multi-CA)

Circuits (Circom)
  authorize.circom   ~15K constraints — Half-proof per-side settlement authorization
  cancel.circom      ~8K  constraints — private order cancel
  claim.circom       ~1.5K constraints — claim with Merkle inclusion proof
  withdraw.circom    ~6K constraints — withdrawal from commitment pool
  deposit.circom     ~4K constraints — private deposit into commitment pool
```

## Project Structure

```
contracts/       Solidity contracts + Foundry tests
  src/             RelayerRegistry, IdentityGate (multi-CA)
  src/zk/          CommitmentPool, PrivateSettlement, IncrementalMerkleTree
  test/            Unit + E2E tests
  script/          DeployLocal
circuits/        Circom ZK circuits (settle, claim, withdraw)
  build/           Generated artifacts (WASM + zkeys, produced by scripts/build.sh)
frontend/        Next.js app (Secret Trade, Relayer dashboard, Identity verification)
  app/lib/zk/      EdDSA, commitment, incremental tree
zk-relayer/      ZK order matching + gasless claim relay
  src/core/        Orderbook, matcher, private-submitter, DB
  test/            E2E integration tests
scripts/         Dev & E2E test scripts
docs/            Research paper, design docs
```

## Quick Start

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, anvil, cast)
- Node.js >= 18
- [circom](https://docs.circom.io/getting-started/installation/) 2.x (for building ZK circuit artifacts — see below)

### ZK circuit artifacts

Generated zkeys, WASMs, and the six Groth16 `*Verifier.sol` files are not tracked in git — each phase-2 setup uses a fresh random beacon, so the only way to keep the on-chain Verifier consistent with the frontend's zkey is to build them together. Both `./scripts/dev.sh` and `./scripts/dev-fork.sh` run `npm run build` in `circuits/` before deploying contracts. First run is slow (Powers-of-Tau generation, several minutes); subsequent runs reuse `circuits/build/pot*_final.ptau`.

First-time setup (one-off `npm install` for circom toolchain):

```bash
cd circuits && npm install
```

Set `SKIP_CIRCUIT_BUILD=1` on the deploy script when you know nothing changed since the last build. See [docs/operations/local-setup.md](docs/operations/local-setup.md#prerequisite-zk-circuit-artifacts) for the full rationale and troubleshooting.

#### Deployed networks (Sepolia) — pinned artifacts, do NOT rebuild

The "build them together" rule above is for **local anvil only**. On a **deployed** network the Groth16 verifiers are already on-chain, each locked to one specific zkey build. **Never `npm run build` the circuits to "refresh" Sepolia assets** — a rebuild draws a fresh phase-2 beacon, producing a zkey that no longer pairs with the deployed verifier, so every proof reverts with `InvalidProof()` (custom-error selector `0x09bde339`).

The **canonical** set is pinned by the committed `circuits/zk-manifest.json` (sha256 per artifact), verified to pair with all Sepolia verifiers. The bytes themselves are **not** in git — `circuits/build` is generated/gitignored — because zkeys are large (~256 MB) and non-reproducible. They are distributed as fixed bytes via a public GCS bucket (`gs://zkscatter-zk-artifacts`, content-addressed by sha256). Frontends serve the prover assets from `apps/<app>/public/zk/` (gitignored; the browser fetches `/zk/<circuit>.{wasm,zkey}` at runtime); a fetch step (`predev`/`prebuild`/CI, `scripts/fetch-zk-assets.mjs`) downloads + checksum-verifies the manifest-pinned bytes into `public/zk`, so these always match the on-chain verifiers.

**Troubleshooting `InvalidProof()` (`execution reverted (unknown custom error) data=0x09bde339`):** the served zkey does not pair with the on-chain verifier. Either the frontend serves a stale zkey (re-fetch the canonical asset) **or** the on-chain verifier is stale (redeploy it from the canonical zkey and re-point via the admin **Verifier rotation** page, `/protocol/settlement`). Confirm pairing by exporting the zkey's verification key (`snarkjs zkey export verificationkey`) and checking its `alpha`/`IC` G1 constants appear in the verifier's on-chain bytecode (`cast code <verifier>`).

### Full Local Dev (with zk-X509)

zkScatter requires a **zk-X509 Identity Registry** for user verification (Dual-CA: User CA + Relayer CA). For the full setup with both systems on a shared anvil, see **[docs/operations/local-setup.md](docs/operations/local-setup.md)**.

```bash
# After zk-X509 is deployed on anvil:
IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x... ./scripts/dev.sh
```

### Quick Start (mock mode)

For rapid development without zk-X509 (identity verification bypassed):

```bash
./scripts/dev.sh --mock
```

Starts its own anvil with `MockIdentityRegistry`, deploys contracts, launches zk-relayer + frontend. Open http://localhost:3000.

### Run against Sepolia (live testnet)

Run the frontends **locally** against the shared **Sepolia (chainId 11155111)**
deployment so the whole team hits the same contracts, relayer, and orderbook.
Every address comes from the committed ledger `contracts/deployments/11155111.json`
— you configure nothing. **All you need is a browser wallet (MetaMask) on Sepolia
with a little test ETH.**

**1. Scatter frontends** — launch any app:

```bash
./scripts/run-scatter-web.sh <app> sepolia   # app = hub | pay | pro | operators | admin
```

| app       | dev URL                 | purpose                           |
|-----------|-------------------------|-----------------------------------|
| pay       | http://localhost:4001   | simple payments UI                |
| pro       | http://localhost:4003   | pro trading UI                    |
| operators | http://localhost:4004   | operator / KYC onboarding console |
| admin     | http://localhost:4005   | protocol + KYC review console     |
| hub       | http://localhost:4006   | navigation hub                    |

**2. zk-X509 identity website** — a **separate repo**; clone it once, then launch:

```bash
git clone https://github.com/tokamak-network/zk-X509.git "$HOME/src/zk-X509"
export ZK_X509_REPO="$HOME/src/zk-X509"     # default: ../zk-X509
./scripts/run-zkx509-web.sh sepolia         # → http://localhost:3000
```

No RPC key is needed for either: the scripts ship a keyless public-node default
and reads/writes go through your wallet. (Optionally set `SEPOLIA_RPC_URL` to your
own keyed endpoint — it's browser-exposed via `NEXT_PUBLIC_*`, so never share a
key.)

> 📖 **Full guide:** [docs/operations/sepolia-team-setup.md](docs/operations/sepolia-team-setup.md)
> — shared infra URLs, optional overrides, the backend/prover topology, and
> troubleshooting.

### Run Tests

```bash
cd contracts && forge test          # Contract tests
cd zk-relayer && npm test           # ZK relayer unit tests
cd zk-relayer && npx tsx test/e2e-private-flow.ts  # Full E2E (requires dev.sh --mock)
```

### Docker (ZK Relayer)

```bash
cd zk-relayer
PORT=3002 \
RPC_URL=https://your-rpc.example.com \
COMMITMENT_POOL_ADDRESS=0x... \
PRIVATE_SETTLEMENT_ADDRESS=0x... \
RELAYER_KEY_FILE=./relayer.key \
docker compose up -d
```

## Test Accounts (anvil defaults)

| Account | Address | Balance |
|---------|---------|---------|
| Alice | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | 1000 WETH, 1M USDC |
| Bob | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | 1000 WETH, 1M USDC |

## Security & audit

External auditors: start at [`docs/security/AUDIT.md`](docs/security/AUDIT.md)
for scope, in/out boundaries, and copy-pasteable reproduction commands. The
deeper *why* behind each safety-net layer lives in
[`docs/security/HARDENING.md`](docs/security/HARDENING.md).

## License

This project is provided under the [Business Source License 1.1](LICENSE) with additional patent provisions. Non-production use (research, auditing, contributions) is permitted. Production use requires a commercial license from Tokamak Network Pte. Ltd. Converts to GPLv2+ on the Change Date specified in LICENSE. See the LICENSE file for full terms. Contact legal@tokamak.network for licensing.
