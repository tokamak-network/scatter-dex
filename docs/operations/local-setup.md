# Local Development Setup

zkScatter requires a **zk-X509 Identity Registry** for user verification (Dual-CA architecture). This guide covers how to run the full stack locally.

## Prerequisite: ZK circuit artifacts

The apps load `.wasm` / `_final.zkey` pairs from their `public/zk/` directories at proof time — `deposit`, `withdraw`, `claim`, `authorize`, `cancel`, plus the tiered batch variants `claim_64` / `claim_128` and `authorize_64` / `authorize_128` — and `DeployLocal` deploys the matching `*Verifier.sol` contracts from `contracts/src/zk/`. **None of these are tracked in git** — both `dev.sh` and `dev-fork.sh` rebuild them automatically before the deploy step and mirror them into the app surfaces (`frontend/public/zk/`, `apps/pro/public/zk/`; Pay pulls from `apps/pro` via its `predev` hook).

### Why generated artifacts are gitignored

Each Groth16 phase-2 setup uses a fresh random beacon (`scripts/build.sh` lines 99–100), so every build emits different vkey constants. The `_final.zkey` and the embedded Solidity verifier are mathematically a single pair — if the two come from different builds, on-chain `verifyProof()` returns `false` and every transaction reverts with `InvalidProof()`. Committing one without the other (the historical state of this repo) guaranteed the two would drift apart, so both are now treated as build outputs:

| Artifact | Where | Tracked? |
|---|---|---|
| `circuits/build/*_final.zkey`, `*.wasm` | local build cache | no — `circuits/build/` ignored |
| `frontend/public/zk/*` | copied during build | no — `frontend/public/zk/` ignored |
| `contracts/src/zk/{Authorize,Cancel,Claim,Deposit,Withdraw}Verifier.sol` | rebuilt from same beacon | no — listed in `.gitignore` |
| `contracts/src/zk/I*Verifier.sol`, `BatchAuthorizeVerifier.sol` | hand-written | yes |

### Building manually

```bash
cd circuits
npm install         # first time only
npm run build       # runs scripts/build.sh
```

First run is slow (Powers-of-Tau generation, several minutes); subsequent runs reuse `circuits/build/pot*_final.ptau` but still re-run phase-2 setup (~30s+ for `settle`).

### Skipping the auto-rebuild

Both deploy scripts rebuild on every invocation. When you know nothing changed since the last successful build, set `SKIP_CIRCUIT_BUILD=1`:

```bash
SKIP_CIRCUIT_BUILD=1 ./scripts/dev-fork.sh
```

This is purely a speed knob — leaving it unset is the safe default and the only thing that guarantees the on-chain Verifier.sol matches the zkey the apps will load.

**Symptom if you skip the build incorrectly:** browser console shows `CompileError: WebAssembly.compile(): expected magic word 00 61 73 6d, found 3c 21 44 4f` (404 HTML being fed to WebAssembly because the `.wasm` is missing), or `InvalidProof()` (0x09bde339) at deposit time (`Verifier.sol` and `_final.zkey` came from different beacons). Re-run with the env var unset.

## How to run the stack

This guide covers the **native (host-process)** workflow — anvil, contracts,
the shared orderbook, both relayers, and the apps run directly on your machine
via `./scripts/dev.sh`. This is the default for active development (native hot
reload, per-app logs, easy restarts).

> Prefer Docker Compose for a reproducible, throwaway stack? See
> **[local-setup-docker.md](local-setup-docker.md)**.

## Quick Start — dev.sh (host processes)

```bash
./scripts/dev.sh --mock --apps pay,pro,operators,admin,hub
```

Starts anvil, deploys all contracts (MockIdentityRegistry for both User CA and
Relayer CA), mock tokens, the shared orderbook, **both relayers**, and the
selected apps in one terminal. Press `Ctrl+C` to stop all services.

Services and ports (relayers + orderbook always start; each app starts only when named in `--apps`):
| Service | Port | Description |
|---------|------|-------------|
| Anvil | 8545 | Local Ethereum node |
| shared-orderbook | 4000 | Cross-relayer order discovery |
| Relayer A | 3002 | ZK private orders + gasless claims |
| Relayer B | 3003 | Second relayer (cross-relayer matching) |
| Pay | 4001 | `--apps pay` |
| Drop | 4002 | `--apps drop` |
| Pro | 4003 | `--apps pro` |
| Operators | 4004 | `--apps operators` |
| Admin | 4005 | `--apps admin` |
| Hub | 4006 | `--apps hub` (static landing site) |

`--apps` accepts `pay`, `drop`, `pro`, `operators`, `admin`, `hub`
(comma-separated). Pick the subset you need; `dev.sh` installs each app's deps
on demand and writes its `.env.local` with the freshly deployed contract
addresses. Hub moved off port 4000 (which the shared orderbook owns) to 4006.

### Run in the background

By default `dev.sh` runs in the foreground and **closing the terminal stops
everything** (it traps `SIGHUP`). To keep the stack running after you close the
window — and free the terminal — start it detached:

```bash
./scripts/dev.sh --mock --apps pay,pro,operators,admin,hub --background
```

It brings every service up, prints the URLs, saves the PIDs to
`.dev-logs/dev.pids`, and exits leaving the services running. Stop them later
with:

```bash
./scripts/dev.sh --stop
```

`--stop` kills the recorded PIDs and sweeps the well-known dev ports
(8545/3002/3003/4000–4006) for anything left behind.

### Monitoring (dev.sh)

```bash
# Per-service logs written while dev.sh runs
# (anvil is launched with --silent and does not write a log file)
tail -f .dev-logs/relayer-a.log
tail -f .dev-logs/shared-orderbook.log
tail -f .dev-logs/app-pay.log            # one per --apps entry (app-pro.log, …)

# Which ports are bound, and by which PID
lsof -i :8545 -i :3002 -i :4000 -i :4001

# Service health
curl http://localhost:3002/api/info      # relayer A
curl http://localhost:4000/health        # shared orderbook
curl http://localhost:4001 -I            # Pay app (expect 200)
cast block-number --rpc-url http://localhost:8545   # anvil
```

### Stopping & cleanup (dev.sh)

```bash
# Normal shutdown — trap handler kills every background PID
Ctrl+C

# If the terminal died without a clean exit, orphan processes can keep the
# ports held. Identify and kill them (portable across Linux/macOS — avoids
# GNU-specific `xargs -r`):
pids=$(lsof -ti :8545 -i :3002 -i :3003 -i :4000 -i :4001 -i :4002 -i :4003 -i :4004)
if [ -n "$pids" ]; then
  kill $pids
fi

# Optional — clear the log directory
rm -rf .dev-logs
```

`dev.sh` fails fast with `port X is already in use` when any of the above ports are occupied, so the port check above is the usual recovery path.

> Running via Docker Compose instead? The `make up` / `make logs` / `make down`
> workflow lives in **[local-setup-docker.md](local-setup-docker.md)**.

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

**4. Start an app (e.g. Pro):**

Write the deployed addresses into the app's `.env.local`, then start it. (`dev.sh`
does this automatically via `write_app_env`; the block below is the manual
equivalent for `apps/pro`, which reads the generic `NEXT_PUBLIC_*` keys.)

```bash
cd apps/pro
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
npm run dev          # Pro on http://localhost:4003
```

> **Pay is different:** `apps/pay` reads `NEXT_PUBLIC_PAY_*`-prefixed keys (see
> `apps/pay/app/_lib/network.ts`), not the generic ones above. Let `dev.sh
> --apps pay` write its `.env.local` rather than hand-rolling it.

## Integration Mode (with zk-X509)

This mode points Pay's `IdentityGate` at a **real** zk-X509 `IdentityRegistry` instead of the `MockIdentityRegistry` baked into dev.sh's deploy.

**Why not pass `IDENTITY_REGISTRY` env vars to `dev.sh` directly?** Native integration mode (`./scripts/dev.sh` without `--mock`) tries to register the zk-relayer (Anvil Account #1) into the zk-X509 Relayer CA registry during contract deploy. A freshly-deployed zk-X509 registry has no verified identities yet, so that deploy reverts with `NotVerified()`. The recommended flow is: boot in mock mode, then **swap** the mock registry out of `IdentityGate` for the real zk-X509 one.

### Prerequisite

A local zk-X509 checkout with `make elf` already run (the prebuilt ELF lives at `<zk-X509>/elf/zk-x509-program`). Below, `<zk-X509>` and `<scatter-dex>` are the absolute paths to each checkout.

### Step-by-step

**1. Start Pay (+ optionally Pro) in mock mode** — this brings up anvil, mock contracts, orderbook, relayers, and the listed apps in one shot:

```bash
cd <scatter-dex>
# Pay only:
SKIP_CIRCUIT_BUILD=1 ./scripts/dev.sh --mock --apps pay
# Or Pay + Pro (Pro runs on :4003 — same on-chain IdentityGate as Pay):
SKIP_CIRCUIT_BUILD=1 ./scripts/dev.sh --mock --apps pay,pro
```

Note the `IdentityGate` address from the deploy summary (`NEXT_PUBLIC_IDENTITY_GATE_ADDRESS` is also written to each app's `.env.local`). `IdentityGate` is a **single on-chain contract** that both Pay and Pro point at, so the registry swap in step 4 below applies to both apps — register a wallet once in the zk-X509 dashboard and it's verified everywhere.

**2. Start zk-X509 frontend + backend** in a separate terminal. scatter-dex no longer starts a service on port 3000, so zk-X509 can take its default port:

```bash
cd <zk-X509>
bash script/start-services.sh                           # frontend :3000, backend :4444
```

**3. Deploy a zk-X509 `IdentityRegistry` onto the same anvil** that `dev.sh --mock` started. The script also auto-seeds the test CA from `certs/ca_pub.der` so the registry isn't stuck at `caMerkleRoot = 0` (which would block every `register()` call):

```bash
cd <zk-X509>
MAX_WALLETS_PER_CERT=10 \
SERVICE_NAME="User CA (10 wallets/cert)" \
bash script/deploy-on-existing-anvil.sh
```

Optional environment variables:
- `MAX_WALLETS_PER_CERT=<n>` — how many wallets one certificate may bind (default 1 for strict 1:1, set to a higher value like the `10` above for multi-wallet use cases).
- `SEED_TEST_CA=0` — skip the auto-`addCA` step (e.g. when you're going to wire CAs from a separate admin flow).
- `CA_CERT_PATH=<path>` — point at a non-default CA cert; default is `certs/ca_pub.der`.

Note the printed `IdentityRegistry (proxy)` address — that's the registry Pay will route through. The script also prints the resulting `caMerkleRoot`, which should be non-zero (= `sha256` of the seeded CA cert).

**4. Swap the mock registry out of `IdentityGate`** using the helper script — it reads `IdentityGate` from `apps/pay/.env.local`, adds the zk-X509 registry, and removes every other registry (the mock from step 1). Pro shares the same on-chain `IdentityGate` so this one swap covers both apps:

```bash
cd <scatter-dex>
./scripts/swap-identity-registry.sh <zk-X509 IdentityRegistry from step 3>
```

If you'd rather drive `cast` directly:

```bash
IDENTITY_GATE=<IdentityGate from step 1>
ZK_X509_REG=<zk-X509 IdentityRegistry from step 3>
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # Anvil account #0
RPC=http://localhost:8545

cast send $IDENTITY_GATE "addRegistry(address)" $ZK_X509_REG --rpc-url $RPC --private-key $DEPLOYER_KEY
MOCK=$(cast call $IDENTITY_GATE "getRegistries()(address[])" --rpc-url $RPC | tr -d '[]' | awk -F',' '{print $1}' | tr -d ' ')
cast send $IDENTITY_GATE "removeRegistry(address)" $MOCK --rpc-url $RPC --private-key $DEPLOYER_KEY
cast call $IDENTITY_GATE "getRegistries()(address[])" --rpc-url $RPC
```

After the swap, `isVerified(user)` calls from **both Pay and Pro** route through the same zk-X509 registry (they share the on-chain `IdentityGate`). The registry already has the test CA loaded (from step 3) but no wallet has called `register(proof, publicValues)` yet, so `isVerified()` returns `false` for every wallet until you issue an identity through the zk-X509 dashboard at http://localhost:3000 (Identity → pick the registry → submit a proof against the seeded test CA). The CA itself should already be visible in the registry's Explorer tab; if it's not, re-run step 3 — `caMerkleRoot` in the script output should not be all-zeros.

### Ports at a glance (integration + zk-X509)

| Port | Service | Owner |
|---|---|---|
| 8545 | anvil | started by `dev.sh --mock` |
| 3000 | zk-X509 frontend / dashboard | zk-X509 (free because scatter-dex no longer starts a service on 3000) |
| 3002 | zk-relayer A | scatter-dex |
| 3003 | zk-relayer B | scatter-dex |
| 4000 | shared-orderbook | scatter-dex |
| 4001 | Pay app | scatter-dex |
| 4003 | Pro app (optional, `--apps pay,pro`) | scatter-dex |
| 4444 | zk-X509 backend | zk-X509 |

### Teardown

Use port-based termination so other dev stacks (e.g. another scatter-dex checkout) are untouched. `pkill -f "scripts/dev.sh"` would match every checkout's bootstrap script and `pkill -f "anvil --silent"` would kill unrelated anvil sessions:

```bash
# scatter-dex (Ctrl+C in dev.sh's terminal, or)
lsof -tiTCP:4001 -sTCP:LISTEN | xargs -r kill           # Pay
lsof -tiTCP:4003 -sTCP:LISTEN | xargs -r kill           # Pro (if --apps pay,pro)
lsof -tiTCP:4000 -sTCP:LISTEN | xargs -r kill           # shared-orderbook
lsof -tiTCP:3002 -tiTCP:3003 -sTCP:LISTEN | xargs -r kill   # relayers
lsof -tiTCP:8545 -sTCP:LISTEN | xargs -r kill           # anvil (this also tears down on-chain state)

# zk-X509
( cd <zk-X509> && bash script/stop-services.sh )
```

On macOS `xargs` doesn't support `-r`; if you're not on Linux, gate the kill with a check instead: `pids=$(lsof -tiTCP:8545 -sTCP:LISTEN); [ -n "$pids" ] && kill $pids`.

## Redeployment / Reset

When redeploying contracts (e.g., after code changes), reset the relayer database and notes:

```bash
# 1. Stop all services (Ctrl+C in dev.sh's terminal)

# 2. Delete relayer databases
rm -f zk-relayer/zk-relayer.db zk-relayer/zk-relayer-b.db shared-orderbook/shared-orderbook.db

# 3. Clear notes folder (old commitment notes are invalid after redeploy)
#    Delete zkscatter-note-*.json and zkscatter-claims-*.json from your notes folder

# 4. Restart everything
./scripts/dev.sh --mock --apps pay,pro,operators
```

> `dev.sh --mock` already wipes these DBs on a fresh start (it resets state
> whenever it boots a new chain), so step 2 is only needed if you restart the
> apps against an anvil that's still running. The Docker workflow uses
> `make clean` instead — see [local-setup-docker.md](local-setup-docker.md).

## Cross-Relayer Setup (Shared Orderbook)

`dev.sh --mock` already starts the shared orderbook + relayer A + relayer B, so
cross-relayer matching (S-M15) works out of the box. The standalone
`start-cross-relayer-e2e.sh` script is a separate variant that brings up the
orderbook + both relayers against an **already-running** anvil — use it when you
started anvil/contracts by other means and just need the relayer layer for an
E2E run:

```bash
# Normal flow — dev.sh --mock already brings up the orderbook + relayer A + B:
./scripts/dev.sh --mock --apps pay

# Standalone variant — ONLY when anvil + contracts are already up *without* dev.sh.
# Don't run this alongside dev.sh; it starts its own orderbook + relayers and would
# collide on ports 4000 / 3002 / 3003.
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

**Apps with two relayers:** `dev.sh` already writes `NEXT_PUBLIC_SHARED_ORDERBOOK_URL=http://localhost:4000` and `NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002` into each app's `.env.local`. To let an app forward claims to the second relayer too, append the server-side allowlist to that app's `.env.local` and restart `npm run dev`:

```
ALLOWED_RELAYER_ORIGINS=http://localhost:3002,http://localhost:3003
```

- `NEXT_PUBLIC_SHARED_ORDERBOOK_URL` lets the UI query the shared orderbook for cross-relayer order discovery.
- `ALLOWED_RELAYER_ORIGINS` is the server-side allowlist consulted by `/api/relay` before forwarding claims to a non-default relayer. Keep `NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002` as the default relayer.

## Market Orders (Fork Mode)

`settleWithDex` requires a whitelisted DEX router and real on-chain liquidity. Plain anvil has neither, so `dev.sh --mock` cannot exercise market orders. Use `dev-fork.sh` instead — it forks mainnet, deploys zkScatter against the forked state, and wires up real WETH/USDC so 1inch and Uniswap route through actual pools.

> **Terminology** — the UI labels this flow **"DEX Trade"**, the contract function is `settleWithDex`, and the rest of these docs call it a **market order**. All three refer to the same thing.

```bash
./scripts/dev-fork.sh
# Optional env (values shown are the defaults — override as needed):
#   FORK_URL=https://eth.llamarpc.com              (use https://eth.drpc.org
#                                                   as a more stable alternate
#                                                   when llamarpc's shard
#                                                   rotation returns 404s for
#                                                   Quoter / getLogs calls)
#   FORK_BLOCK=                                    (unset = tip; pin to a
#                                                   concrete block number to
#                                                   avoid "block not found" /
#                                                   state-drift reverts)
#   FORK_CHAIN_ID=31338                            (keeps MetaMask happy; do
#                                                   NOT override to 1, which
#                                                   collides with MetaMask's
#                                                   built-in Mainnet. The
#                                                   frontend pins 1inch
#                                                   routing to chainId=1 via
#                                                   NEXT_PUBLIC_AGGREGATOR_
#                                                   CHAIN_ID regardless.)
#   NEXT_PUBLIC_DISABLE_AGGREGATOR=true            (Uniswap-only routing;
#                                                   flip to false to exercise
#                                                   the 1inch Pathfinder path
#                                                   — works best with a
#                                                   FORK_BLOCK near tip)
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
| `InvalidProof()` (0x09bde339) on deposit | Circuit `.wasm` / `_final.zkey` in `frontend/public/zk/` don't match the `*Verifier.sol` bytecode deployed on-chain. Should not happen with the default flow (deploy scripts always rebuild before deploying), but possible if you ran with `SKIP_CIRCUIT_BUILD=1` after editing a `.circom` or after manually deleting `circuits/build/`. | Re-run `./scripts/dev-fork.sh` without `SKIP_CIRCUIT_BUILD` — it regenerates zkey + verifier in one atomic build and redeploys. |
| `execution reverted` from Uniswap `exactInputSingle` even with matching fee tier | SwapRouter02's `exactInputSingle` struct dropped the `deadline` field (it's enforced via a separate multicall path); using the V1 ABI with V2 router shifts the struct layout. | The frontend's ABI is fixed — if you're testing directly, make sure your calldata uses the 7-field tuple `(tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96)`. |
| Prefund warning: `USDC prefund failed — try FORK_BLOCK=<older block> or add whale` | The script impersonated a known whale (Circle, Binance 8/14) but that address no longer holds USDC at the current fork block. Non-fatal — services still start, but Alice has 0 USDC. | `FORK_BLOCK=<older> ./scripts/dev-fork.sh` (a day or two back is usually enough), or add a new whale to `USDC_WHALES=(...)` in the script. |
| MetaMask: `This Chain ID is currently used by the Ethereum network` | You tried to add the fork as chain ID `1`, which MetaMask reserves for its built-in Mainnet. | `dev-fork.sh` uses chain ID `31338` by default for exactly this reason — don't override `FORK_CHAIN_ID=1`. The Add Fork Network header button uses 31338 automatically. |
| `ONEINCH_API_KEY` present but 1inch path still not taken | Fork mode defaults `NEXT_PUBLIC_DISABLE_AGGREGATOR=true` to sidestep state-drift reverts (the env-var comment block and "1inch Swap API key" paragraph both mention this). | `NEXT_PUBLIC_DISABLE_AGGREGATOR=false ./scripts/dev-fork.sh` — also pin `FORK_BLOCK` near tip so 1inch's routing matches fork state. |

**App UI (non-fork-specific):** invisible text on mint-green buttons after editing `globals.css` is Tailwind v4's `@theme inline` block compiling into CSS custom properties at dev-server startup — HMR doesn't always pick up edits inside `@theme`. Kill the dev server, clear the affected app's build cache (`rm -rf apps/<name>/.next` for a native app, or `frontend/.next` in fork mode, which runs the legacy `frontend/`), restart `npm run dev`, hard-reload the browser tab (⌘⇧R).

When all else fails in fork mode, `rm -rf .dev-logs zk-relayer/zk-relayer.db frontend/.next` wipes the moving parts; rerun the circuits build once and `./scripts/dev-fork.sh`.

## E2E Test Runbook

| Scenario | Command | Prereqs |
|---|---|---|
| Full limit-order flow (single relayer) | open a started app (e.g. Pay `http://localhost:4001`), deposit → order → claim | `dev.sh --mock --apps pay` |
| Cross-relayer matching | `cd zk-relayer && npx tsx test/e2e-cross-relayer.ts` | `dev.sh --mock` (already starts the orderbook + relayer B) |
| Market order (DEX Trade) browser flow | open `http://localhost:3000`, add fork network, deposit → DEX Trade → claim; verify `DexSurplusCollected` / `PlatformFeeFromDex` / `PlatformSurplusFromDex` events fired (`cast logs --address <feeVault> …`). `FeeVault.platformRevenue(buyToken)` is only non-zero when the swap yielded positive slippage, and `platformRevenue(sellToken)` only when `dexPlatformFeeBps > 0` — events are the reliable invariant. | `dev-fork.sh` |
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
