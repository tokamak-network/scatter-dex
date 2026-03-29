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

### Local Dev (all-in-one)

```bash
./scripts/dev.sh
```

Starts anvil, deploys contracts, launches relayer + frontend. Open http://localhost:3000.

> **Note:** Local dev uses a `MockIdentityRegistry` that approves all users. In production, `IdentityGate` connects to an external **zk-X509 Identity Registry** for KYC/AML compliance. See `script/DeploySettlement.s.sol` for production deployment with a real registry address.

### Manual Setup

```bash
# 1. Start anvil
anvil

# 2. Deploy contracts
cd contracts
forge script script/DeployLocal.s.sol --rpc-url http://localhost:8545 \
  --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# 3. Start relayer
cd relayer && npm install && npm run dev

# 4. Start frontend
cd frontend && npm install && npm run dev
```

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

MIT
