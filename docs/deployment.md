# Deployment Guide

## Architecture

```
                    ┌──────────────────┐
                    │  Shared Orderbook │ :4000
                    │    (bulletin)     │
                    └────┬────────┬────┘
                         │        │
              WS/REST    │        │    WS/REST
                         │        │
              ┌──────────┴─┐  ┌───┴──────────┐
              │  Relayer A  │  │  Relayer B    │
              │    :3002    │  │    :3003      │
              └──────┬──────┘  └──────┬───────┘
                     │     P2P        │
                     └───────────────┘
                     │                │
              ┌──────┴────────────────┴──────┐
              │      Ethereum / Testnet       │
              │  CommitmentPool, Settlement   │
              └──────────────────────────────┘
```

## Quick Start (Local Development)

### Single Relayer (default)

```bash
# Start anvil + deploy contracts + 1 relayer + shared orderbook + frontend
docker compose --profile mock up -d
```

### Multi-Relayer (cross-relayer matching)

```bash
# Start everything including Relayer B
docker compose --profile mock --profile multi-relayer up -d
```

### Verify

```bash
curl http://localhost:4000/health          # Shared Orderbook
curl http://localhost:3002/api/info        # Relayer A
curl http://localhost:3003/api/info        # Relayer B (multi-relayer only)
curl http://localhost:3000                 # Frontend
```

### Stop

```bash
docker compose --profile mock --profile multi-relayer down
```

## Testnet Deployment

### 1. Configure

```bash
cp .env.testnet.example .env
# Edit .env with real values:
#   - RPC_URL (Sepolia, Holesky, etc.)
#   - DEPLOYER_KEY
#   - RELAYER_A_KEY, RELAYER_B_KEY
#   - Public URLs for relayers
```

### 2. Deploy Contracts

```bash
cd contracts
forge script script/DeployLocal.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --private-key $DEPLOYER_KEY
```

Copy the deployed addresses into `.env`:
- `COMMITMENT_POOL_ADDRESS`
- `PRIVATE_SETTLEMENT_ADDRESS`
- `FEE_VAULT_ADDRESS`

### 3. Start Services

Contract addresses from step 2 are passed via `.env` environment variables.
The `deployer` service only runs in `mock` profile — testnet mode skips it.

```bash
# Single relayer (testnet — no deployer, no anvil)
# shared-orderbook starts automatically as a dependency
docker compose up -d zk-relayer

# Multi-relayer (shared-orderbook starts automatically)
docker compose --profile multi-relayer up -d zk-relayer zk-relayer-b
```

### 4. Register Relayers

Relayers auto-register with the shared orderbook server on startup. For on-chain registration in `RelayerRegistry` (if required by your deployment):

```bash
# register(string url, uint256 fee) — check your contract's exact signature
cast send $RELAYER_REGISTRY "register(string,uint256)" \
  "https://relayer-a.yourdomain.com" 30 \
  --rpc-url $RPC_URL --private-key $RELAYER_A_KEY

cast send $RELAYER_REGISTRY "register(string,uint256)" \
  "https://relayer-b.yourdomain.com" 30 \
  --rpc-url $RPC_URL --private-key $RELAYER_B_KEY
```

## Docker Services

| Service | Port | Description |
|---------|------|-------------|
| `anvil` | 8545 | Local Ethereum node (mock profile only) |
| `deployer` | — | Contract deployment (runs once and exits) |
| `shared-orderbook` | 4000 | Bulletin board + WebSocket broadcast |
| `zk-relayer` | 3002 | Primary relayer (Relayer A) |
| `zk-relayer-b` | 3003 | Secondary relayer (multi-relayer profile) |
| `frontend` | 3000 | Web UI |

## Environment Variables

### Shared Orderbook

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | HTTP/WS port |
| `DB_PATH` | `shared-orderbook.db` | SQLite database path |

### Relayer

| Variable | Default | Description |
|----------|---------|-------------|
| `RPC_URL` | `http://localhost:8545` | Ethereum RPC endpoint |
| `RELAYER_PRIVATE_KEY` | — | Relayer wallet private key |
| `COMMITMENT_POOL_ADDRESS` | — | CommitmentPool contract (auto-loaded from deployer in Docker) |
| `PRIVATE_SETTLEMENT_ADDRESS` | — | PrivateSettlement contract (auto-loaded from deployer in Docker) |
| `FEE_VAULT_ADDRESS` | — | FeeVault contract (auto-loaded from deployer in Docker) |
| `PORT` | `3002` | API port |
| `RELAYER_FEE` | `30` | Fee in basis points (0.3%) |
| `SHARED_ORDERBOOK_URL` | — | Shared orderbook server URL (optional) |
| `RELAYER_PUBLIC_URL` | — | This relayer's public URL for P2P |
| `RELAYER_NAME` | — | Human-readable name |
| `DB_PATH` | `zk-relayer.db` | SQLite database path |

### Testnet-Specific

| Variable | Description |
|----------|-------------|
| `DEPLOYER_KEY` | Contract deployer private key |
| `RELAYER_A_KEY` | Relayer A private key |
| `RELAYER_B_KEY` | Relayer B private key |
| `RELAYER_A_PUBLIC_URL` | Relayer A's public URL (for Trade Offers) |
| `RELAYER_B_PUBLIC_URL` | Relayer B's public URL |

## Monitoring

### Health Checks

All services expose health endpoints that Docker uses for dependency ordering:

```bash
# Service health status
docker compose ps

# Detailed health
docker inspect --format='{{.State.Health.Status}}' scatter-dex-zk-relayer-1
```

### Logs

```bash
docker compose logs -f zk-relayer          # Relayer A logs
docker compose logs -f zk-relayer-b        # Relayer B logs
docker compose logs -f shared-orderbook    # Shared orderbook logs
```

### Shared Orderbook Stats

```bash
curl http://localhost:4000/api/stats
# {"totalOrders":5,"pairs":2,"relayers":2}

curl http://localhost:4000/api/relayers
# Lists registered relayers with heartbeat status
```

## Security Notes

See [docs/relayer-security.md](./relayer-security.md) for the full security guide.

**Key points for deployment:**
- Use `RELAYER_PRIVATE_KEY_FILE` with Docker secrets (not env vars) in production
- Enable HTTPS for all public endpoints
- Set `CORS_ORIGINS` to restrict frontend access
- Use separate wallets for each relayer with minimal gas balance
- Encrypt database volumes
