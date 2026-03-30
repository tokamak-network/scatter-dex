# Local Development Setup

ScatterDEX requires a **zk-X509 Identity Registry** for user verification (Dual-CA architecture). This guide covers two ways to run the full stack locally.

## Option A: Docker (Recommended)

### Prerequisites

- Docker Desktop

### Mock Mode (standalone, no zk-X509)

Uses `MockIdentityRegistry` that approves all users and relayers (Dual-CA mock).

```bash
make up          # start (background)
make ps          # check status
make logs        # follow logs
make down        # stop
make clean       # stop + remove volumes
```

Or without Makefile:

```bash
docker compose --profile mock up -d
```

### Integration Mode (with zk-X509)

Connects to the zk-X509 Docker environment already running on your machine.

**Step 1:** Start zk-X509 by following the [zk-X509 Local Setup Guide](https://github.com/tokamak-network/zk-X509/blob/main/docs/local-setup.md).

**Step 2:** Start ScatterDEX:

```bash
make up-integration \
  IDENTITY_REGISTRY=0x... \
  RELAYER_IDENTITY_REGISTRY=0x...
```

Or without Makefile:

```bash
IDENTITY_REGISTRY=0x...           \
RELAYER_IDENTITY_REGISTRY=0x...   \
RPC_URL=http://host.docker.internal:8545 \
NEXT_PUBLIC_RPC_URL=http://localhost:8545 \
docker compose up -d
```

> - `IDENTITY_REGISTRY` — User CA registry (max masking, `minDisclosureMask=0x00`)
> - `RELAYER_IDENTITY_REGISTRY` — Relayer CA registry (min masking, `minDisclosureMask=0x0F`)

---

## Option B: Native (without Docker)

### Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (forge, anvil, cast)
- Node.js >= 18
- [zk-X509](https://github.com/tokamak-network/zk-X509) repo (for integration mode)

### Mock Mode

```bash
./scripts/dev.sh --mock
```

This starts anvil, deploys all contracts (MockIdentityRegistry for both User CA and Relayer CA), mock tokens, relayer, and frontend in one terminal. Press `Ctrl+C` to stop all services.

### Integration Mode

**Step 1:** Start anvil:

```bash
anvil
```

**Step 2:** Deploy zk-X509 by following the [zk-X509 Local Setup Guide](https://github.com/tokamak-network/zk-X509/blob/main/docs/local-setup.md). Deploy contracts and register test users/CAs on the anvil instance.

**Step 3:** Start ScatterDEX:

```bash
IDENTITY_REGISTRY=0x... \
RELAYER_IDENTITY_REGISTRY=0x... \
./scripts/dev.sh
```

The script will:
1. Detect the running anvil (does **not** start its own)
2. Deploy ScatterDEX contracts with real `IdentityGate` (User CA) and `RelayerRegistry` (Relayer CA)
3. Register deployer as relayer
4. Start relayer on http://localhost:3001
5. Start frontend on http://localhost:3000

---

## Services

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Relayer | http://localhost:3001 |
| Anvil | http://localhost:8545 |

## Contract Tests

```bash
make test
# or
cd contracts && forge test
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| deployer fails to connect | Docker: ensure `--profile mock` is set. Native: start anvil first |
| `NotVerified` when depositing | Register the user wallet via zk-X509 (User CA) |
| `NotVerified` when registering relayer | Register the relayer via zk-X509 (Relayer CA) |
| Port conflict with zk-X509 frontend | Run the zk-X509 frontend on a different port: `PORT=3002` |
| `TokenNotWhitelisted` | Tokens are auto-whitelisted by `dev.sh` / deployer; check the correct addresses |
