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

## Live deployment — team Sepolia (current)

The central box and a relayer are deployed **separately**: the shared orderbook
is hosted once for the whole team; each relayer operator runs their own
`zk-relayer` (it is behind the `relayer` Compose profile, so the central box
does **not** start one).

| What | Where | Endpoint |
| --- | --- | --- |
| **shared-orderbook + settlement-verifier + commitment-indexer** | GCP e2-micro (`zkscatter-node`, `us-central1-a`, COS) — `deploy/gcp` | `http://136.115.115.93:4000` (`GET /health` → `{"status":"ok"}`; leaves at `GET /api/commitments`) |
| **zk-relayer** | per-operator (not on the central box) | operator's own `:3002` |
| **zk-X509 CMS backend** | Firebase (`zkscatter` project) — Cloud Functions + Firestore | `https://zkscatter.web.app/api/registries` |
| **Frontends (hub/pay/pro/operators/admin)** | run locally per team member | `localhost:400x` |

The orderbook is **multi-network** (`chain_id` partitioned): reads take
`?chainId=`, the verifier runs one loop per chain (`CHAINS` env, with a
single-chain `RPC_URL` / `PRIVATE_SETTLEMENT_ADDRESS` / `CHAIN_ID` fallback),
and a relayer pins its network with `CHAIN_ID`. A missing chainId defaults to
Sepolia (`11155111`), so the live single-network deployment is unaffected.

**Redeploy / restart** (central box). After building+pushing the image
(`deploy/ci/build-and-push.sh`), roll it out with `deploy/ci/deploy.sh` — it sets
`image-tag`, **re-syncs the compose files + `startup-script` metadata from the
repo**, then re-runs the startup script (idempotent; the DB migration is safe to
re-run):

```bash
deploy/ci/build-and-push.sh shared-orderbook   # only when code/image changed
deploy/ci/deploy.sh                            # image-tag + compose + startup-script + restart
```

> ⚠️ **Stale-metadata trap.** The compose files and `vm-startup.sh` live in
> instance *metadata*, not the image. A new image that adds a sidecar service
> (e.g. `commitment-indexer`) or a new env var (e.g. `COMMITMENT_DEPLOY_BLOCK`)
> does **nothing** until that metadata is re-pushed. `deploy.sh` now does this;
> if you ever push metadata by hand, push all three together:
>
> ```bash
> gcloud compute instances add-metadata zkscatter-node --zone us-central1-a \
>   --metadata-from-file startup-script=deploy/gcp/vm-startup.sh,\
> compose-yml=deploy/runtime/compose.yml,compose-tls-yml=deploy/runtime/compose.tls.yml,\
> caddyfile=deploy/runtime/Caddyfile
> ```
>
> COS note: verified on the deployed image (google-guest-agent 20250701); on a
> newer guest agent the run-startup equivalent is `... --script-type startup`.

> COS note: `/var` (incl. `HOME=/var/lib/zkscatter`) is mounted **noexec**, so
> the docker-compose plugin is staged under `/var/lib/docker/cli-plugins`
> (exec-capable) and symlinked into `~/.docker/cli-plugins`. See
> `deploy/gcp/vm-startup.sh`.

### Operating cost (testnet volume)

| Item | Tier | Monthly |
| --- | --- | --- |
| e2-micro VM (orderbook + verifier) | GCP Always Free (1×, us-central1) | **$0** |
| 30 GB pd-standard disk | free 30 GB | **$0** |
| **Static external IPv4** (in-use) | charged since 2024 (~$0.005/hr) | **~$3.65** |
| Secret Manager / Artifact Registry / Logging / egress | free tier | **$0** |
| GCS `zkscatter-zk-artifacts` (zkey/wasm distribution, ~210 MB) | standard, content-addressed | **~$0.01** + build-time egress (<$1) |
| Firebase Functions + Firestore + Hosting (zk-X509 CMS) | Blaze, ~free at this volume | **~$0** |
| Frontends | run locally | **$0** |
| **Total** | | **~$3.65 / mo** |

The only real charge is the static external IPv4. Static↔ephemeral makes no
difference (in-use IPv4 is billed either way), so the static IP is kept for a
stable team endpoint. Mainnet / production traffic would push Functions,
Firestore and egress past the free tiers.

## Let an AI agent do it

Hand this doc to an AI coding agent (e.g. Claude Code) and paste the prompt
below — it covers clone → build → up → health-check for a single relayer:

> 이 레포(`https://github.com/tokamak-network/scatter-dex`)를 클론하고
> `docs/operations/deployment.md`대로 **단일 릴레이어**를 mock 프로파일로 띄워줘:
> 1. `git clone … && cd scatter-dex`
> 2. `cd circuits && npm install && npm run build && cd ..` (ZK 아티팩트, 최초 1회·수 분)
> 3. `docker compose --profile mock up -d` (anvil + 컨트랙트 배포 + 릴레이어 1 + 오더북 + 프론트)
> 4. 헬스체크: `curl localhost:4000/health`, `curl localhost:3002/api/info`, `curl localhost:3000`
> 각 단계 결과를 한 줄로 보고하고, 실패하면 `docker compose logs <service>` 근거와 함께 알려줘.
> 종료는 `docker compose --profile mock down`.

For a **testnet / production** relayer (real chain, your own key), follow the
["Testnet Deployment"](#testnet-deployment) section instead — and note the
operator must complete on-chain onboarding (KYC → zk-X509 proof → admin
approval) before `RelayerRegistry.register()` succeeds. In `mock` mode every
wallet is pre-verified, so the local stack just works.

## Quick Start (Local Development)

### Prerequisites

- **Docker** (Engine + Compose v2) and **git**
- **Node.js + npm** (only for the one-time circuit build below)

### 0. Clone the repo

```bash
git clone https://github.com/tokamak-network/scatter-dex.git
cd scatter-dex
```

### 1. Build the ZK circuit artifacts (one-time, required)

`docker compose up` does **not** build these — the images copy
`frontend/public/zk/*.wasm` + `*.zkey` in at image-build time, but **none of the
generated zkey/wasm/Verifier.sol files are tracked in git** (each phase-2 setup
uses a fresh beacon, so committing them would let the on-chain Verifier drift
from the local zkey). Generate the full set once, from the repo root:

```bash
cd circuits && npm install && npm run build && cd ..
```

First run is slow (Powers-of-Tau, several minutes). Symptom matching for a
missing/mismatched build is in
[local-setup.md](./local-setup.md#prerequisite-zk-circuit-artifacts).

> The host-process scripts (`./scripts/dev.sh`, `./scripts/dev-fork.sh`) auto-run
> this before deploying contracts; only the `docker compose` path needs it manually.

### 2. Bring it up

```bash
# From the repo root. Starts anvil + deploys contracts + ONE relayer +
# shared orderbook + frontend.
docker compose --profile mock up -d
```

> Running more than one relayer (cross-relayer matching) is an advanced setup —
> see the `multi-relayer` profile in `docker-compose.yml`. The default single
> relayer is all an operator needs to get on-chain.

### Verify

```bash
curl http://localhost:4000/health          # Shared Orderbook
curl http://localhost:3002/api/info        # Relayer
curl http://localhost:3000                 # Frontend
```

### Stop

```bash
docker compose --profile mock down
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

### 4. Register the relayer on-chain

> ⚠ **On-chain registration is gated.** `RelayerRegistry.register()` reverts
> with `NotVerified` unless your wallet has proved its accredited certificate to
> zk-X509 (`identityRegistry.isVerified(you) == true`), and — when the KYC gate
> is wired — also requires a current admin approval (`NotKycApproved`). Complete
> onboarding first via the operators app `/register` wizard (KYC → zk-X509 proof
> → admin approval). See [Registering a Relayer](./registering-a-relayer.md).
> In `mock` mode every wallet is pre-verified, so this just works.

Once verified/approved, register from the **same wallet** that was verified.
The signature is `register(string url, string name, uint256 fee, uint256 bondAmount)`
(fee in basis points; `bondAmount` ≥ `RelayerRegistry.minBond()`, sent as
`msg.value` in native-bond mode):

```bash
# bondAmount (4th arg) must be >= RelayerRegistry.minBond(); in native-bond
# mode it's also sent as --value. The 0/0 below only works when minBond == 0
# — check it first: cast call $RELAYER_REGISTRY "minBond()(uint256)"
BOND=$(cast call $RELAYER_REGISTRY "minBond()(uint256)" --rpc-url $RPC_URL)
cast send $RELAYER_REGISTRY \
  "register(string,string,uint256,uint256)" \
  "https://relayer.yourdomain.com" "My Relayer" 30 "$BOND" \
  --value "$BOND" \
  --rpc-url $RPC_URL --private-key $RELAYER_KEY
```

Or just use the operators app `/register` Steps 4–5 (Endpoint + Bond), which
builds this tx for you with a live endpoint probe.

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

The settlement-verifier (same image, `verify.js` entrypoint) is multi-network:

| Variable | Default | Description |
|----------|---------|-------------|
| `CHAINS` | — | JSON array of per-chain configs `[{"chainId":…,"rpcUrl":…,"settlementAddress":…}]`. Runs one verify loop per chain. |
| `RPC_URL` / `PRIVATE_SETTLEMENT_ADDRESS` / `CHAIN_ID` | — / — / `11155111` | Single-chain fallback when `CHAINS` is unset. |

The commitment-indexer (same image, `commitment-indexer.js` entrypoint) scans
`CommitmentInserted` events into the shared DB so `GET /api/commitments` can
serve Merkle leaves. Like the verifier it shares the orderbook DB volume and is
multi-network:

| Variable | Default | Description |
|----------|---------|-------------|
| `COMMITMENT_CHAINS` | — | JSON array `[{"chainId":…,"rpcUrl":…,"commitmentPoolAddress":…,"deployBlock":…}]`. One indexer loop per chain. |
| `RPC_URL` / `COMMITMENT_POOL_ADDRESS` / `COMMITMENT_DEPLOY_BLOCK` / `CHAIN_ID` | — / — / `0` / `11155111` | Single-chain fallback when `COMMITMENT_CHAINS` is unset. Set the deploy block from the ledger so it doesn't scan from genesis. |
| `COMMITMENT_POLL_INTERVAL_SEC` / `COMMITMENT_BLOCK_SAFETY_MARGIN` / `COMMITMENT_INDEX_BLOCK_RANGE` | `30` / `6` / `50000` | Pass cadence, reorg margin, and `eth_getLogs` window. |

On the live box these come from instance metadata (`vm-startup.sh` maps
`commitment-pool-address` → `COMMITMENT_POOL_ADDRESS`, `commitment-deploy-block`
→ `COMMITMENT_DEPLOY_BLOCK`, etc.). **Enable / point the indexer:**

```bash
# 1. deploy block = the pool's deployBlock from contracts/deployments/<chainId>.json
gcloud compute instances add-metadata zkscatter-node --zone us-central1-a \
  --metadata commitment-deploy-block=11094792,commitment-pool-address=0x1c6bc81704f100C9EddeF79C151F7C2EbEa5848b
# 2. roll out (deploy.sh re-syncs compose so the commitment-indexer container exists)
deploy/ci/deploy.sh
# 3. verify
curl 'http://136.115.115.93:4000/api/commitments?chainId=11155111'   # -> {"total":N,…}
```

> ⚠️ **RPC range requirement.** The indexer walks `[deployBlock, latest]` in
> `COMMITMENT_INDEX_BLOCK_RANGE`-block windows, one `eth_getLogs` per window, so
> the box's `rpc-url` secret **must** allow at least that window
> (`50 000` by default) blocks per call. A **free-tier RPC with a tiny cap fails** (e.g.
> Alchemy free = 10-block `eth_getLogs` → `Under the Free tier plan…`). Use a
> keyless `publicnode` endpoint (50 000 cap, the stack default) or a paid key:
>
> ```bash
> printf 'https://ethereum-sepolia.publicnode.com' \
>   | gcloud secrets versions add rpc-url --data-file=- --project zkscatter
> deploy/ci/deploy.sh   # picks up the new secret version
> ```

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
| `CHAIN_ID` | `11155111` | EVM network this relayer trades on; stamped onto orders/settlements pushed to the (multi-network) shared orderbook and used to scope reads |
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
