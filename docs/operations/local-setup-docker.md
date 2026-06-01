# Local Development Setup — Docker Compose

This is the **Docker Compose** path for running zkScatter locally. For the
default **native (host-process)** workflow — and the full zk-X509 integration
flow — see **[local-setup.md](local-setup.md)**.

> **Note:** the compose `frontend` service builds the legacy `frontend/` app,
> which is no longer the product entry point (the apps under `apps/*` are). The
> compose stack is kept for reproducible, throwaway trials of the contract +
> relayer + orderbook layer; app development happens natively via `dev.sh`
> (see [local-setup.md](local-setup.md)).

## Prerequisite: ZK circuit artifacts

The Docker images bake in `frontend/public/zk/*` at image-build time, and those
artifacts are gitignored. The `make` targets below run `circuits && npm run build`
first (skipped when `SKIP_CIRCUIT_BUILD=1`). See
[local-setup.md](local-setup.md#prerequisite-zk-circuit-artifacts) for the full
rationale on why zkeys / `*Verifier.sol` are build outputs.

## Quick Start — Makefile (Docker Compose)

```bash
make up              # mock mode (anvil + frontend + zk-relayer A + shared orderbook)
make up-multi        # mock mode + second relayer on :3003 (cross-relayer matching)
make up-integration IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x...   # real zk-X509
```

| Target | Purpose |
|---|---|
| `make up` | `docker compose --profile mock up -d` — frontend, relayer A, shared orderbook, anvil |
| `make up-multi` | Adds relayer B under the `multi-relayer` profile |
| `make up-integration` | Runs against pre-deployed zk-X509 registries (requires env vars) |
| `make ps` | `docker compose ps` |
| `make logs` | Follow all container logs |
| `make down` | Stop containers (keeps volumes) |
| `make clean` | Stop and **drop volumes** (anvil state, relayer DB) |
| `make test` | `forge test` on the contracts package |

### Monitoring (Docker)

```bash
make ps                                  # container status
make logs                                # follow all container logs
docker compose logs -f frontend          # follow a single service
docker compose logs -f zk-relayer        # relayer A in the default mock stack
docker compose logs -f zk-relayer-b      # relayer B when using make up-multi
docker compose logs --tail=200 anvil     # last 200 lines only
docker stats                             # live CPU / memory per container

# Service health
curl http://localhost:3002/api/info
curl http://localhost:4000/health
cast block-number --rpc-url http://localhost:8545
```

### Stopping & cleanup (make / Docker)

```bash
make down            # stop containers, keep volumes (anvil state, relayer DB persist)
make clean           # stop containers and drop volumes — full reset

# If a container is stuck / orphaned, list and remove manually:
docker compose ps
docker compose --profile mock --profile multi-relayer rm -fsv
```

Because Docker owns the ports, you don't need the `lsof` cleanup that the native
`dev.sh` flow sometimes requires.

## Docker (ZK Relayer standalone)

Run only the relayer container against an external RPC and pre-deployed contracts:

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

## Redeployment / Reset (Docker)

When redeploying contracts (e.g. after code changes), drop the volumes so the
relayer database and anvil state are wiped:

```bash
make clean           # stop containers and drop volumes — required to wipe relayer DB
make up              # rebuild + redeploy on a fresh chain
```

Old commitment / claim notes are invalid after a redeploy — delete
`zkscatter-note-*.json` and `zkscatter-claims-*.json` from your notes folder.
