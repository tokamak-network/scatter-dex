# Local Development Setup

zkScatter requires a **zk-X509 Identity Registry** for user verification (Dual-CA architecture). This guide covers how to run the full stack locally.

## Quick Start (Mock Mode)

```bash
./scripts/dev.sh --mock
```

This starts anvil, deploys all contracts (MockIdentityRegistry for both User CA and Relayer CA), mock tokens, zk-relayer, and frontend in one terminal. Press `Ctrl+C` to stop all services.

Services started:
| Service | Port | Description |
|---------|------|-------------|
| Anvil | 8545 | Local Ethereum node |
| ZK Relayer | 3002 | ZK private orders + gasless claims |
| Frontend | 3000 | Next.js web app |

## Manual Setup (step by step)

**1. Start anvil:**

```bash
anvil
```

**2. Deploy contracts:**

```bash
cd contracts
forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url http://localhost:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

Note the addresses from the output:

| Variable | Output label |
|----------|-------------|
| `<RELAYER_REGISTRY>` | RelayerRegistry |
| `<WETH>` | WETH |
| `<USDC>` | USDC |
| `<COMMITMENT_POOL>` | CommitmentPool |
| `<PRIVATE_SETTLEMENT>` | PrivateSettlement |
| `<IDENTITY_GATE>` | IdentityGate |
| `<FEE_VAULT>` | FeeVault |

**3. Start zk-relayer:**

```bash
cd zk-relayer
cat > .env <<EOF
RPC_URL=http://localhost:8545
RELAYER_PRIVATE_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
COMMITMENT_POOL_ADDRESS=<COMMITMENT_POOL>
PRIVATE_SETTLEMENT_ADDRESS=<PRIVATE_SETTLEMENT>
FEE_VAULT_ADDRESS=<FEE_VAULT>
TOKEN_LIST=<WETH>:WETH:18,<USDC>:USDC:18
ADMIN_API_KEY=<YOUR_ADMIN_API_KEY>
RELAYER_FEE=30
PORT=3002
EOF
npm run dev
```

**4. Start frontend:**

The deploy script prints a `LOCAL DEPLOYMENT SUMMARY` block that you can copy directly into `.env.local`:

```bash
cd frontend
cat > .env.local <<EOF
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=<RELAYER_REGISTRY>
NEXT_PUBLIC_WETH_ADDRESS=<WETH>
NEXT_PUBLIC_TOKENS=<WETH>:WETH:18,<USDC>:USDC:18
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=<COMMITMENT_POOL>
NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=<PRIVATE_SETTLEMENT>
NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=<IDENTITY_GATE>
NEXT_PUBLIC_FEE_VAULT_ADDRESS=<FEE_VAULT>
NEXT_PUBLIC_RPC_URL=http://localhost:8545
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002
EOF
npm run dev
```

## Integration Mode (with zk-X509)

**Step 1:** Start anvil:

```bash
anvil
```

**Step 2:** Deploy zk-X509 by following the [zk-X509 Local Setup Guide](https://github.com/tokamak-network/zk-X509/blob/main/docs/local-setup.md).

**Step 3:** Start zkScatter:

```bash
IDENTITY_REGISTRY=0x... \
RELAYER_IDENTITY_REGISTRY=0x... \
./scripts/dev.sh
```

The script will:
1. Detect the running anvil (does **not** start its own)
2. Deploy zkScatter contracts with real `IdentityGate` (User CA) and `RelayerRegistry` (Relayer CA)
3. Register Account #1 as zk-relayer
4. Start zk-relayer on http://localhost:3002
5. Start frontend on http://localhost:3000

## Docker (ZK Relayer)

```bash
cd zk-relayer

# Create key file
echo "0xYOUR_RELAYER_PRIVATE_KEY" > relayer.key

# Run
PORT=3002 \
RPC_URL=https://your-rpc.example.com \
COMMITMENT_POOL_ADDRESS=0x... \
PRIVATE_SETTLEMENT_ADDRESS=0x... \
RELAYER_KEY_FILE=./relayer.key \
docker compose up -d
```

## Redeployment / Reset

When redeploying contracts (e.g., after code changes), reset the relayer database and notes:

```bash
# 1. Stop all services (Ctrl+C if using dev.sh)

# 2. Delete relayer database (old orders reference stale contracts)
rm -f zk-relayer/zk-relayer.db

# 3. Clear notes folder (old commitment notes are invalid after redeploy)
#    Delete zkscatter-note-*.json and zkscatter-claims-*.json from your notes folder

# 4. Restart everything
./scripts/dev.sh --mock
```

## Cross-Relayer Setup (Shared Orderbook)

Single-relayer `dev.sh` does **not** start the shared orderbook or a second relayer. To exercise cross-relayer matching (S-M15), run the cross-relayer script in a separate terminal after `dev.sh --mock` is up:

```bash
# Terminal 1
./scripts/dev.sh --mock

# Terminal 2 (after deployment completes)
./scripts/start-cross-relayer-e2e.sh
```

| Service | Port | Notes |
|---|---|---|
| Shared Orderbook | 4000 | `shared-orderbook/` |
| Relayer A | 3002 | restarted with `SHARED_ORDERBOOK_URL` |
| Relayer B | 3003 | Anvil Account #2 key, separate DB (`zk-relayer-b.db`) |

Status checks:

```bash
curl http://localhost:3002/api/info
curl http://localhost:3003/api/info
curl http://localhost:4000/health
```

Run the end-to-end cross-relayer scenario:

```bash
cd zk-relayer && npx tsx test/e2e-cross-relayer.ts
```

**Frontend with two relayers:** `dev.sh` only writes `NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002`. For a full 2-relayer local setup, append the following to `frontend/.env.local` and restart `npm run dev`:

```
NEXT_PUBLIC_SHARED_ORDERBOOK_URL=http://localhost:4000
ALLOWED_RELAYER_ORIGINS=http://localhost:3002,http://localhost:3003
```

- `NEXT_PUBLIC_SHARED_ORDERBOOK_URL` lets the UI query the shared orderbook for cross-relayer order discovery.
- `ALLOWED_RELAYER_ORIGINS` is the server-side allowlist consulted by `/api/relay` before forwarding claims to a non-default relayer. Keep `NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002` as the default relayer.

## Market Orders (Fork Mode)

`settleWithDex` requires a whitelisted DEX router. The default plain anvil chain has none deployed, so `DeployLocal` prints `1inch Router not deployed on this chain (skipped)` and market orders will not execute end-to-end.

To exercise market orders locally, start anvil in **fork mode** against mainnet (or a chain where the 1inch Aggregation Router V6 and Uniswap V3 SwapRouter02 are deployed), and connect with `dev.sh` in **integration mode** (not `--mock`):

```bash
# Terminal 1 — start your own forked anvil on 8545
anvil --fork-url https://eth.llamarpc.com
# or Alchemy / Infura / your own RPC

# Terminal 2 — integration mode reuses the running anvil
IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x... ./scripts/dev.sh
```

> **Note:** `dev.sh --mock` always starts its own anvil (and exits if port 8545 is already in use via `check_port 8545`), so it cannot be combined with a pre-started forked anvil. Use integration mode with zk-X509 as above. If you need mock identity against a fork, run `anvil --fork-url` then deploy manually via `forge script script/DeployLocal.s.sol:DeployLocal --rpc-url http://localhost:8545 --broadcast --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` and start the relayer/frontend by hand (see **Manual Setup** above).

When fork mode is used, `DeployLocal` will whitelist:
- 1inch Aggregation Router V6 — `0x111111125421cA6dc452d289314280a0f8842A65`
- Uniswap V3 SwapRouter02 — `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45`

**1inch Swap API key:** the frontend route `/api/swap` requires `ONEINCH_API_KEY` in `frontend/.env.local`. Without it the UI falls back to Uniswap quoting.

## E2E Test Runbook

| Scenario | Command | Prereqs |
|---|---|---|
| Full limit-order flow (single relayer) | open `http://localhost:3000`, deposit → order → claim | `dev.sh --mock` |
| Cross-relayer matching | `cd zk-relayer && npx tsx test/e2e-cross-relayer.ts` | `dev.sh --mock` + `start-cross-relayer-e2e.sh` |
| Market order (settleWithDex) Foundry fork | `cd contracts && forge test --match-contract SettleWithDex --fork-url <MAINNET_RPC>` | mainnet RPC URL |
| Relayer HTTP route tests | `cd zk-relayer && npm test` | none (hermetic) |
| Contract tests | `cd contracts && forge test` | none |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `NotVerified` when depositing | Register the user wallet via zk-X509 (User CA) |
| `NotVerified` when registering relayer | Register the relayer via zk-X509 (Relayer CA) |
| `TokenNotWhitelisted` | Tokens are auto-whitelisted by `dev.sh`; check the correct addresses |
| `ClaimsGroupNotFound` | Order was not settled yet, or DB has stale data — see Redeployment section |
| `Restored N pending orders from DB` | Old orders from previous deployment — delete `zk-relayer.db` and restart |
