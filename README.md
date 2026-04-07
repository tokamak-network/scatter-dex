# ScatterDEX

A privacy-preserving DEX with compliant identity gating. Trades are executed off-chain via an order book; settlements use **Scatter Settlement** — a hash-lock scheme that splits, delays, and separates fund flows to achieve transaction unlinkability. For stronger on-chain privacy, **ZK Private Settlement** uses Groth16 proofs with commitment pools and stealth addresses to hide trader identities and claim structure, while aggregate settlement amounts and token information remain public on-chain.

> Privacy + Compliance + Efficiency — see [docs/PAPER.md](docs/PAPER.md) for the full research paper.

## Architecture

```
Frontend (Next.js)  →  Relayer (Node.js)      →  Contracts (Solidity / Foundry)
     ↕                      ↕                            ↕
  MetaMask            Order matching             ScatterSettlement (standard)
  EdDSA keys          EIP-712 signing            PrivateSettlement (ZK)
  Stealth addr        ZK proof generation        CommitmentPool (incremental Merkle tree)
                                                 RelayerRegistry
                      zk-relayer (gasless)       IdentityGate

Circuits (Circom)
  settle.circom      ~30K constraints — private settlement with EdDSA + fee validation
  claim.circom       ~1.5K constraints — claim with Merkle inclusion proof
  withdraw.circom    ~6K constraints — withdrawal from commitment pool
```

## Project Structure

```
contracts/       Solidity contracts + Foundry tests
  src/             ScatterSettlement, RelayerRegistry, IdentityGate, VaultSkills
  src/zk/          CommitmentPool, PrivateSettlement, IncrementalMerkleTree
  test/            Unit, E2E, gas benchmark tests (165+)
  script/          DeployLocal, DeploySettlement
circuits/        Circom ZK circuits (settle, claim, withdraw)
  build/           Generated artifacts (WASM + zkeys, produced by scripts/build.sh)
frontend/        Next.js app (trade, deposit, claim, private order, history)
  app/lib/zk/      EdDSA, commitment, stealth, incremental tree
relayer/         Off-chain order matching + settlement relay
  src/core/        Orderbook, matcher, submitter, private-submitter, DB
  test/            Unit tests (45+) + E2E integration (36)
zk-relayer/      Gasless ZK claim relay (proof submission)
scripts/         Dev & E2E test scripts
docs/            Research paper, design docs, ZK trading guide
```

## Quick Start

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, anvil, cast)
- Node.js >= 18

### Full Local Dev (with zk-X509)

ScatterDEX requires a **zk-X509 Identity Registry** for user verification. For the full setup with both systems on a shared anvil, see **[docs/local-setup.md](docs/local-setup.md)**.

```bash
# After zk-X509 is deployed on anvil:
IDENTITY_REGISTRY=0x... ./scripts/dev.sh
```

### Quick Start (mock mode)

For rapid development without zk-X509 (identity verification bypassed):

```bash
./scripts/dev.sh --mock
```

Starts its own anvil with `MockIdentityRegistry`, deploys contracts, launches relayer + frontend. Open http://localhost:3000.

### Run Tests

```bash
cd contracts && forge test          # 165+ tests (unit + E2E + gas benchmark)
cd relayer && npm test              # 45+ unit tests
cd relayer && npm run test:e2e      # 36+ E2E integration tests (requires anvil + deploy + relayer)
bash scripts/run-e2e.sh             # Full E2E: Foundry + relayer integration
```

### Docker

```bash
docker-compose up
```

## Test Accounts (anvil defaults)

| Account | Address | Balance |
|---------|---------|---------|
| Alice | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | 1000 WETH, 1M USDC |
| Bob | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | 1000 WETH, 1M USDC |

## License

This project is provided under the [Business Source License 1.1](LICENSE) with additional patent provisions. Non-production use (research, auditing, contributions) is permitted. Production use requires a commercial license from Tokamak Network Pte. Ltd. Converts to GPLv2+ on the Change Date specified in LICENSE. See the LICENSE file for full terms. Contact legal@tokamak.network for licensing.
