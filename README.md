# ScatterDEX

A privacy-preserving DEX with compliant identity gating. Trades are executed off-chain via an order book; settlements use **Scatter Settlement** — a hash-lock scheme that splits, delays, and separates fund flows to achieve transaction unlinkability without heavy ZK proofs.

> Privacy + Compliance + Efficiency — see [docs/PAPER.md](docs/PAPER.md) for the full research paper.

## Architecture

```
Frontend (Next.js)  →  Relayer (Node.js)  →  Contracts (Solidity / Foundry)
     ↕                      ↕                       ↕
  MetaMask            Order matching         ScatterSettlement
  Dashboard           EIP-712 signing        RelayerRegistry
                                             IdentityGate
```

## Project Structure

```
contracts/       Solidity contracts + Foundry tests
  src/             ScatterSettlement, RelayerRegistry, IdentityGate, VaultSkills
  test/            Unit, E2E, gas benchmark tests
  script/          DeployLocal, DeploySettlement
frontend/        Next.js dashboard (trade, deposit, claim, admin)
relayer/         Off-chain order matching + settlement relay
scripts/         Dev & E2E test scripts
docs/            Research paper
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
cd contracts && forge test        # 123 tests (unit + E2E + gas benchmark)
cd relayer && npm test            # Relayer unit tests
./scripts/e2e-test.sh             # On-chain E2E scenarios via cast
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

Licensed under the [Business Source License 1.1](LICENSE). Non-production use (research, auditing, contributions) is permitted. Production use requires a commercial license from Tokamak Network Pte. Ltd. Each version converts to GPLv2+ four years after release. Contact legal@tokamak.network for licensing.
