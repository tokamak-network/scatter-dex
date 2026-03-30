# Local Development Setup

ScatterDEX requires a **zk-X509 Identity Registry** for user verification. This guide covers how to run the full stack locally using Docker.

## Prerequisites

- Docker Desktop
- [zk-X509](https://github.com/tokamak-network/zk-X509) repo (for integration mode)

## Quick Start (Mock Mode)

No zk-X509 needed. Uses `MockIdentityRegistry` that approves all users.

```bash
docker compose --profile mock up
```

This starts anvil, deploys all contracts (including mock tokens), and runs relayer + frontend.

## Integration Mode (with zk-X509)

Connects to the zk-X509 Docker environment already running on your machine.

### Step 1: Start zk-X509

Follow the [zk-X509 Local Setup Guide](https://github.com/tokamak-network/zk-X509/blob/main/docs/local-setup.md) to start its Docker environment. This brings up anvil and deploys the IdentityRegistry.

### Step 2: Start ScatterDEX

```bash
IDENTITY_REGISTRY=0x... \
RPC_URL=http://host.docker.internal:8545 \
NEXT_PUBLIC_RPC_URL=http://localhost:8545 \
docker compose up
```

> Replace `0x...` with the IdentityRegistry proxy address from zk-X509's deploy output.

## Services

| Service | URL |
|---------|-----|
| Frontend | http://localhost:3000 |
| Relayer | http://localhost:3001 |
| Anvil | http://localhost:8545 |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| deployer fails to connect | Mock mode: ensure `--profile mock` is set. Integration: check zk-X509 Docker is running |
| `NotVerified` when depositing | Register the user wallet via zk-X509 |
| Port conflict with zk-X509 frontend | zk-X509 frontend를 다른 포트로 실행: `PORT=3002` |
