# Local Development Setup

zkScatter requires a **zk-X509 Identity Registry** for user verification (Dual-CA architecture). This guide covers how to run the full stack locally.

## Prerequisite: build ZK circuit artifacts

Neither `dev.sh` nor `make up` builds the circuits — they only start services. The frontend loads six `.wasm` / `_final.zkey` pairs from `frontend/public/zk/` at proof time (deposit, withdraw, settle, claim, authorize, cancel), but **only `authorize.*` and `cancel.*` are committed to the repo**. The other four must be generated locally before the private-order flows will work:

```bash
cd circuits
npm install         # first time only
npm run build       # runs scripts/build.sh
```

`build.sh` compiles each `.circom`, runs Powers-of-Tau setup, exports Groth16 verifier keys, and copies the resulting `.wasm` + `_final.zkey` into `frontend/public/zk/`. First run is slow (PTAU generation); subsequent runs reuse `circuits/build/pot*_final.ptau`.

**Symptom if skipped:** the browser console shows `CompileError: WebAssembly.compile(): expected magic word 00 61 73 6d, found 3c 21 44 4f` — that's the Next.js 404 HTML page being fed to `WebAssembly.compile` because e.g. `/zk/deposit.wasm` doesn't exist. Run the build above and reload.

## Two ways to run the stack

Both options run the stack in mock mode, but the service topology differs slightly between them (`make up` also starts the shared orderbook + deployer container; `dev.sh --mock` does not). Pick whichever fits your workflow:

| | `./scripts/dev.sh --mock` | `make up` |
|---|---|---|
| Runtime | Host processes (anvil / node / next) | Docker Compose containers |
| Hot reload | Yes — edits re-run locally | No — rebuild image to pick up code changes |
| Logs | `.dev-logs/*.log` + foreground stdout | `make logs` / `docker compose logs` |
| Stop | `Ctrl+C` (trap cleanup kills PIDs) | `make down` (or `make clean` to drop volumes) |
| Cross-relayer | Run `./scripts/start-cross-relayer-e2e.sh` in a 2nd terminal | `make up-multi` (relayer B + shared orderbook) |
| Best for | Active development, debugging with native tools | Reproducible environment, throwaway trials |

## Quick Start — dev.sh (host processes)

```bash
./scripts/dev.sh --mock
```

Starts anvil, deploys all contracts (MockIdentityRegistry for both User CA and Relayer CA), mock tokens, zk-relayer, and frontend in one terminal. Press `Ctrl+C` to stop all services.

Services started:
| Service | Port | Description |
|---------|------|-------------|
| Anvil | 8545 | Local Ethereum node |
| ZK Relayer | 3002 | ZK private orders + gasless claims |
| Frontend | 3000 | Next.js web app |

### Monitoring (dev.sh)

```bash
# Per-service logs written while dev.sh runs
# (anvil is launched with --silent and does not write a log file)
tail -f .dev-logs/zk-relayer.log
tail -f .dev-logs/frontend.log

# Which ports are bound, and by which PID
lsof -i :8545 -i :3000 -i :3002

# Service health
curl http://localhost:3002/api/info      # zk-relayer
curl http://localhost:3000 -I            # frontend (expect 200)
cast block-number --rpc-url http://localhost:8545   # anvil
```

### Stopping & cleanup (dev.sh)

```bash
# Normal shutdown — trap handler kills every background PID
Ctrl+C

# If the terminal died without a clean exit, orphan processes can keep the
# ports held. Identify and kill them (portable across Linux/macOS — avoids
# GNU-specific `xargs -r`):
pids=$(lsof -ti :8545 -i :3000 -i :3002)
if [ -n "$pids" ]; then
  kill $pids
fi

# Optional — clear the log directory
rm -rf .dev-logs
```

`dev.sh` fails fast with `port X is already in use` when any of the above ports are occupied, so the port check above is the usual recovery path.

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

# Service health (same endpoints as dev.sh)
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

Because Docker owns the ports, you don't need the `lsof` cleanup that `dev.sh` sometimes requires.

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
# 1. Stop all services
#    dev.sh mode  : Ctrl+C
#    Docker mode  : make clean   (drops volumes — required to wipe relayer DB)

# 2. Delete relayer database (dev.sh mode only — Docker mode is cleared by `make clean`)
rm -f zk-relayer/zk-relayer.db

# 3. Clear notes folder (old commitment notes are invalid after redeploy)
#    Delete zkscatter-note-*.json and zkscatter-claims-*.json from your notes folder

# 4. Restart everything
./scripts/dev.sh --mock     # or: make up
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

`settleWithDex` requires a whitelisted DEX router and real on-chain liquidity. Plain anvil has neither, so `dev.sh --mock` cannot exercise market orders. Use `dev-fork.sh` instead — it forks mainnet, deploys zkScatter against the forked state, and wires up real WETH/USDC so 1inch and Uniswap route through actual pools.

> **Terminology** — the UI labels this flow **"DEX Trade"**, the contract function is `settleWithDex`, and the rest of these docs call it a **market order**. All three refer to the same thing.

```bash
./scripts/dev-fork.sh
# Optional env:
#   FORK_URL=https://eth.drpc.org                 (default: llamarpc — drpc
#                                                  is a more stable alternate
#                                                  when llamarpc's shard
#                                                  rotation returns 404s for
#                                                  Quoter / getLogs calls)
#   FORK_BLOCK=24874771                            (pin block — use to avoid
#                                                  "block not found" / state-
#                                                  drift reverts; unset =
#                                                  tip)
#   FORK_CHAIN_ID=1                                (default: 31338 — keeps
#                                                  MetaMask happy; the
#                                                  frontend pins 1inch
#                                                  routing to chainId=1 via
#                                                  NEXT_PUBLIC_AGGREGATOR_
#                                                  CHAIN_ID regardless)
#   NEXT_PUBLIC_DISABLE_AGGREGATOR=false          (default: true — flip to
#                                                  false to exercise the
#                                                  1inch Pathfinder path;
#                                                  works best with a
#                                                  FORK_BLOCK near tip)
```

What it does differently from `dev.sh --mock`:

| | `dev.sh --mock` | `dev-fork.sh` |
|---|---|---|
| anvil | plain, chainid 31337 | `--fork-url`, chainid 31338 |
| Tokens | MockWETH / MockUSDC (18 dec) | Real mainnet WETH `0xC02a…` / USDC `0xA0b8…` (6 dec) + USDT + WTON |
| DEX routers | none on chain → market orders disabled | 1inch V6 + Uniswap V3 SwapRouter02 whitelisted |
| Routing default | n/a | Uniswap V3 only (1inch disabled to avoid fork-state drift); flip `NEXT_PUBLIC_DISABLE_AGGREGATOR=false` to enable 1inch |
| Prefund | mint Mock USDC to Alice/Bob | `anvil_setBalance` + impersonate Circle / Binance whales for real USDC + USDT |
| Relayer indexing | `fromBlock=0` (fresh chain) | `INDEX_FROM_BLOCK=<post-deploy>` to skip pre-fork history (upstream RPCs reject >10k-block `eth_getLogs` ranges) |
| Use case | Limit orders, private-order UI | Market orders (`settleWithDex`), aggregator integration |

**Fork-mode defaults:** `dev-fork.sh` forks Ethereum mainnet from `https://eth.llamarpc.com` and starts the local RPC on `http://localhost:8545` with chain ID `31338`. The non-mainnet chain id lets MetaMask accept this as a custom network without colliding with its built-in Mainnet entry; the frontend separately pins the 1inch aggregator chain id to `1` via `NEXT_PUBLIC_AGGREGATOR_CHAIN_ID` so routing still looks up mainnet liquidity. Override with `FORK_URL=... FORK_CHAIN_ID=... ./scripts/dev-fork.sh` when you need a different RPC (drpc.org tends to be more stable than llamarpc).

**1inch Swap API key:** `/api/swap` proxies to 1inch's Swap API (`https://api.1inch.dev/swap/v6.0/...`). Put your key in `frontend/.env.local` as `ONEINCH_API_KEY=...` (no `NEXT_PUBLIC_` prefix — server-side only). Without it the UI falls back to Uniswap V3 direct quoting. Get a free key at <https://portal.1inch.dev/>.

Fork mode additionally sets `NEXT_PUBLIC_DISABLE_AGGREGATOR=true` by default because 1inch's Pathfinder often routes through non-Uniswap pools whose state drifts against the fork. Pin `FORK_BLOCK` close to the live tip and run `NEXT_PUBLIC_DISABLE_AGGREGATOR=false ./scripts/dev-fork.sh` when you specifically want to exercise the 1inch path.

`dev.sh` and `dev-fork.sh` both preserve `ONEINCH_API_KEY` across `.env.local` regeneration.

**MetaMask setup (fork mode):** add a custom network with RPC `http://localhost:8545` and Chain ID `31338`. Import anvil account #0 (`0xf39F…F2266`) — `dev-fork.sh` prefunds it with 100 ETH, 100,000 USDC, and 100,000 USDT. Keep the fork network separate from MetaMask's built-in Mainnet entry to avoid confusion.

**Integration mode with zk-X509:** `./scripts/dev.sh` (no `--mock`) still works for zk-X509 testing against an already-running anvil — see the Integration Mode section above. Fork mode and zk-X509 integration aren't combined today.

### Fork Mode Troubleshooting

Fork-mode failure modes fall into four buckets. Diagnose in this order:

| Symptom | Likely cause | Fix |
|---|---|---|
| `anvil failed to start (waited 30s)` in step [1/4] | Upstream RPC returned `block not found` or `historical state … is not available`. llamarpc rotates shards mid-query so the "latest" it returned a second ago may be gone. | Retry once, or `FORK_URL=https://eth.drpc.org ./scripts/dev-fork.sh`; pin with `FORK_BLOCK=<n>` a few hundred blocks behind tip. |
| `dev-fork.sh` exits at `[3/4] zk-relayer failed to start` with `ranges over 10000 blocks are not supported on freetier` | The relayer's commitment indexer started querying `eth_getLogs` from block 0 and the upstream RPC rejected the range. | `dev-fork.sh` already sets `INDEX_FROM_BLOCK=<post-deploy>`; if you're running the relayer by hand, export it to the deploy block. |
| `DexCallReverted()` (0x39753cda) on `settleWithDex` | Fork state drifted from live mainnet — the DEX pool the router is calling has a different tick/reserve snapshot than when the calldata was built. Especially 1inch multi-hop through non-Uniswap pools. | 1) Pin `FORK_BLOCK` close to tip and re-run. 2) Stay on the Uniswap-only path (`NEXT_PUBLIC_DISABLE_AGGREGATOR=true`, the default). 3) For Uniswap, the frontend auto-probes fee tiers (100/500/3000/10000) and picks the deepest pool — a tier-specific failure means that pool has near-zero liquidity for this pair on the fork block. |
| `InvalidProof()` (0x09bde339) on deposit | Circuit `.wasm` / `_final.zkey` in `frontend/public/zk/` don't match the `*Verifier.sol` bytecode deployed on-chain. Happens when the contracts tree is reset but circuits weren't rebuilt. | `cd circuits && npm run build` — regenerates every zkey + verifier .sol; then redeploy via `./scripts/dev-fork.sh`. |
| `execution reverted` from Uniswap `exactInputSingle` even with matching fee tier | SwapRouter02's `exactInputSingle` struct dropped the `deadline` field (it's enforced via a separate multicall path); using the V1 ABI with V2 router shifts the struct layout. | The frontend's ABI is fixed — if you're testing directly, make sure your calldata uses the 7-field tuple `(tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96)`. |
| Prefund warning: `USDC prefund failed — try FORK_BLOCK=<older block> or add whale` | The script impersonated a known whale (Circle, Binance 8/14) but that address no longer holds USDC at the current fork block. Non-fatal — services still start, but Alice has 0 USDC. | `FORK_BLOCK=<older> ./scripts/dev-fork.sh` (a day or two back is usually enough), or add a new whale to `USDC_WHALES=(...)` in the script. |
| MetaMask: `This Chain ID is currently used by the Ethereum network` | You tried to add the fork as chain ID `1`, which MetaMask reserves for its built-in Mainnet. | `dev-fork.sh` uses chain ID `31338` by default for exactly this reason — don't override `FORK_CHAIN_ID=1`. The Add Fork Network header button uses 31338 automatically. |
| `ONEINCH_API_KEY` present but 1inch path still not taken | Fork mode defaults `NEXT_PUBLIC_DISABLE_AGGREGATOR=true` to sidestep state-drift reverts (the env-var comment block and "1inch Swap API key" paragraph both mention this). | `NEXT_PUBLIC_DISABLE_AGGREGATOR=false ./scripts/dev-fork.sh` — also pin `FORK_BLOCK` near tip so 1inch's routing matches fork state. |

**Frontend (non-fork-specific):** invisible text on mint-green buttons after editing `globals.css` is Tailwind v4's `@theme inline` block compiling into CSS custom properties at dev-server startup — HMR doesn't always pick up edits inside `@theme`. Kill the frontend, `rm -rf frontend/.next`, restart `npm run dev`, hard-reload the browser tab (⌘⇧R).

When all else fails, `make clean` (Docker) or `rm -rf .dev-logs zk-relayer/zk-relayer.db frontend/.next` (host processes) wipes the moving parts; rerun the circuits build once and `./scripts/dev-fork.sh`.

## E2E Test Runbook

| Scenario | Command | Prereqs |
|---|---|---|
| Full limit-order flow (single relayer) | open `http://localhost:3000`, deposit → order → claim | `dev.sh --mock` |
| Cross-relayer matching | `cd zk-relayer && npx tsx test/e2e-cross-relayer.ts` | `dev.sh --mock` + `start-cross-relayer-e2e.sh` |
| Market order (DEX Trade) browser flow | open `http://localhost:3000`, add fork network, deposit → DEX Trade → claim; check `FeeVault.platformRevenue(USDC) > 0` | `dev-fork.sh` |
| Market order (settleWithDex) Foundry fork | `cd contracts && forge test --match-contract SettleWithDex --fork-url <MAINNET_RPC>` | mainnet RPC URL |
| FeeVault platformRevenue unit tests | `cd contracts && forge test --match-contract FeeVaultPlatformRevenue` | none (hermetic) |
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
