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

## License

This project is provided under the [Business Source License 1.1](LICENSE) with additional patent provisions. Non-production use (research, auditing, contributions) is permitted. Production use requires a commercial license from Tokamak Network Pte. Ltd. Converts to GPLv2+ on the Change Date specified in LICENSE. See the LICENSE file for full terms. Contact legal@tokamak.network for licensing.
