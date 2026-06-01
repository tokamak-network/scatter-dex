#!/bin/bash
set -e

# dev-fork.sh — mock-identity local env on an anvil fork of mainnet.
#
# Unlike `dev.sh --mock`, anvil is started with `--fork-url` so the 1inch
# Aggregation Router V6 and Uniswap V3 SwapRouter02 are present on-chain
# and `DeployLocal.s.sol` auto-whitelists them. This is the only way to
# exercise the Market Order (`settleWithDex`) flow end-to-end locally.
#
# Env:
#   FORK_URL                     (default: https://eth.llamarpc.com — drpc is
#                                 a good alternate when llamarpc shards flap)
#   FORK_BLOCK                   (default: latest — pin for reproducibility)
#   FORK_CHAIN_ID                (default: 31338 — distinguishes the mainnet
#                                 fork env from plain local anvil (31337);
#                                 the frontend overrides the 1inch aggregator
#                                 chainId to 1 via NEXT_PUBLIC_AGGREGATOR_CHAIN_ID
#                                 so routing keeps using mainnet liquidity data)
#   NEXT_PUBLIC_DISABLE_AGGREGATOR
#                                (default: true on fork because 1inch's
#                                 Pathfinder often picks non-Uniswap pools
#                                 whose state diverges on the fork; set to
#                                 false when you've pinned FORK_BLOCK to the
#                                 current mainnet tip and want to exercise
#                                 the 1inch path end-to-end)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.dev-logs"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
# Anvil well-known test keys.
# Account #1 — Relayer A (also registered on-chain by DeployLocal.s.sol).
RELAYER_A_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
# Account #2 — Relayer B (registered post-deploy below; address is checked
# against the on-chain registry to decide whether to register).
RELAYER_B_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
RELAYER_B_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
RPC_URL="http://localhost:8545"
RELAYER_FEE_BPS=30
FORK_URL="${FORK_URL:-https://eth.llamarpc.com}"
FORK_BLOCK="${FORK_BLOCK:-}"
# Default to 31338 to distinguish the mainnet-fork env from plain anvil
# (31337). Using chain-id 1 would collide with mainnet and MetaMask blocks
# adding it. The frontend decouples wallet chain id from the aggregator
# chain id — 1inch is always queried with chainId=1 since the fork mirrors
# mainnet state (same router / pool addresses).
FORK_CHAIN_ID="${FORK_CHAIN_ID:-31338}"
PIDS=()
CLEANED_UP=false

cleanup() {
  if [ "$CLEANED_UP" = true ]; then return; fi
  CLEANED_UP=true
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "Done. Logs saved in $LOG_DIR/"
}
trap cleanup EXIT

wait_for() {
  local url="$1" name="$2" max="$3"
  local i=0
  while true; do
    if curl -fsS "$url" -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' > /dev/null 2>&1; then
      break
    fi
    if curl -fsS "$url" > /dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    if [ "$i" -ge "$max" ]; then
      echo "  ERROR: $name failed to start (waited ${max}s)"
      return 1
    fi
    sleep 1
  done
  return 0
}

check_port() {
  local port="$1" name="$2"
  # Only treat LISTENING sockets as "in use"; stale CLOSE_WAIT connections
  # from browsers/wallets must not block a fresh anvil startup.
  if lsof -iTCP:"$port" -sTCP:LISTEN -P > /dev/null 2>&1; then
    echo "ERROR: port $port is already in use ($name). Kill the existing process first."
    exit 1
  fi
}

mkdir -p "$LOG_DIR"

MOBILE_BUNDLE_ID="io.scatterdex.mobile"

# Ensure better-sqlite3's native binary matches the current shell arch.
# dev-fork.sh runs under `arch -x86_64 bash`, so expected arch is x86_64;
# switching to/from `dev.sh --mock` (native arm64) invalidates the build.
ensure_sqlite_arch() {
  local pkg_dir="$1"
  local node_file="$pkg_dir/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  if [ ! -f "$node_file" ]; then return 0; fi
  local expected current
  expected=$(uname -m)
  # `|| true` keeps `set -e` from aborting when `file` prints no recognised
  # arch token (unusual platforms, file(1) wording drift). Empty `current`
  # is then handled by the -n guard below.
  current=$(file "$node_file" 2>/dev/null | grep -oE 'x86_64|arm64' | head -1 || true)
  if [ -n "$current" ] && [ "$current" != "$expected" ]; then
    echo "  better-sqlite3 in $(basename "$pkg_dir") is $current, need $expected — rebuilding..."
    ( cd "$pkg_dir" && npm rebuild better-sqlite3 ) > "$LOG_DIR/sqlite-rebuild-$(basename "$pkg_dir").log" 2>&1 \
      || { echo "  ERROR: better-sqlite3 rebuild failed. See $LOG_DIR/sqlite-rebuild-$(basename "$pkg_dir").log"; exit 1; }
  fi
}

# Rebuild @scatter-dex/types when its built output is missing or stale.
# It resolves to dist/index.js (not src), and its `prepare` hook only builds
# when dist is absent — so a `git pull` that adds an export to src leaves a
# stale dist and the shared-orderbook / zk-relayer tsx processes crash at
# startup with "does not provide an export named …". Gate on a cheap
# src-newer-than-dist check so a fresh pull always boots against current types.
ensure_types_built() {
  local pkg="$ROOT_DIR/packages/types"
  local dist="$pkg/dist/index.js"
  [ -d "$pkg" ] || return 0
  if [ ! -f "$dist" ] || [ -n "$(find "$pkg/src" -name '*.ts' -newer "$dist" 2>/dev/null | head -1)" ]; then
    echo "  Building @scatter-dex/types (source changed since last build)..."
    ( cd "$pkg" && npm run build ) > "$LOG_DIR/types-build.log" 2>&1 \
      || { echo "  ERROR: @scatter-dex/types build failed. See $LOG_DIR/types-build.log"; exit 1; }
  fi
}

# Install a package's node_modules when missing OR when package.json is newer
# than the last install — a `git pull` that adds a `file:` workspace dependency
# otherwise leaves a stale node_modules and the process crashes with
# `ERR_MODULE_NOT_FOUND: Cannot find package`. The post-install `touch` stamps
# node_modules newer than package.json so the check doesn't re-fire next run.
ensure_deps_installed() {
  local dir="$1" name="$2"
  [ -f "$dir/package.json" ] || return 0
  if [ ! -d "$dir/node_modules" ] || [ "$dir/package.json" -nt "$dir/node_modules" ]; then
    echo "  Installing $name dependencies (first run or package.json changed)..."
    ( cd "$dir" && npm install --no-audit --no-fund ) > "$LOG_DIR/$name-install.log" 2>&1 \
      || { echo "  ERROR: $name dependency install failed. See $LOG_DIR/$name-install.log"; tail -15 "$LOG_DIR/$name-install.log" 2>/dev/null; exit 1; }
    touch "$dir/node_modules"
  fi
}

# Uninstall the mobile app from all booted simulators/emulators. Fresh contract
# addresses on every run make cached commitments/claim notes stale; wallet
# mnemonic must be re-imported after reset.
reset_mobile_app() {
  local wiped=0
  if command -v xcrun >/dev/null 2>&1; then
    local udids
    # `|| true` so `set -e` doesn't abort when no simulators are booted.
    udids=$(xcrun simctl list devices booted 2>/dev/null \
      | grep -oE '\([0-9A-F-]{36}\) \(Booted\)' \
      | grep -oE '[0-9A-F-]{36}' || true)
    for udid in $udids; do
      if xcrun simctl uninstall "$udid" "$MOBILE_BUNDLE_ID" 2>/dev/null; then
        echo "  Uninstalled $MOBILE_BUNDLE_ID from iOS simulator $udid"
        wiped=1
      fi
    done
  fi
  if command -v adb >/dev/null 2>&1; then
    local devs
    devs=$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}' || true)
    for dev in $devs; do
      if adb -s "$dev" uninstall "$MOBILE_BUNDLE_ID" >/dev/null 2>&1; then
        echo "  Uninstalled $MOBILE_BUNDLE_ID from Android $dev"
        wiped=1
      fi
    done
  fi
  [ "$wiped" = 0 ] && echo "  No booted simulators/emulators with the app installed (skipped)."
  return 0
}

# Wipe relayer + shared-orderbook SQLite DBs: fresh fork = fresh contracts =
# previously-indexed commitments/orders are keyed to obsolete pool addresses.
wipe_dev_dbs() {
  local files=(
    "$ROOT_DIR/zk-relayer/zk-relayer.db"
    "$ROOT_DIR/zk-relayer/zk-relayer-b.db"
    "$ROOT_DIR/shared-orderbook/shared-orderbook.db"
  )
  local removed=0
  for f in "${files[@]}"; do
    for ext in "" "-wal" "-shm"; do
      [ -f "${f}${ext}" ] && rm -f "${f}${ext}" && removed=1
    done
  done
  [ "$removed" = 1 ] && echo "Wiped stale relayer/orderbook DBs from previous run." && echo ""
}

echo "Resetting mobile app on booted simulators/emulators..."
reset_mobile_app
echo ""
wipe_dev_dbs

# Always rebuild Groth16 verifiers + zkeys before deploy. Each phase-2
# setup emits different vkey constants, and the only way to guarantee
# zkey ↔ Verifier.sol consistency (no InvalidProof at runtime) is to
# regenerate them in one atomic build. The generated Verifier.sol files
# are gitignored for this reason; the hand-written interfaces and
# BatchAuthorizeVerifier stay tracked.
#
# Set SKIP_CIRCUIT_BUILD=1 to bypass when you know nothing changed since
# the last build (saves ~30s+ on the settle phase-2).
#
# Sync helper kept inline (rather than sourced from dev.sh) to match the
# established duplication pattern between dev.sh / dev-fork.sh — see
# `ensure_sqlite_arch`, `ensure_circuits_built`, etc.
_sync_one_asset() {
  local src="$1" dst="$2"
  if [ -f "$dst" ]; then
    local s_meta d_meta
    s_meta=$(stat -f '%z %m' "$src" 2>/dev/null || stat -c '%s %Y' "$src")
    d_meta=$(stat -f '%z %m' "$dst" 2>/dev/null || stat -c '%s %Y' "$dst")
    [ "$s_meta" = "$d_meta" ] && return 1
    cmp -s "$src" "$dst" && return 1
  fi
  cp -p "$src" "$dst"
  return 0
}
sync_zk_assets_from_build() {
  local build_dir="$ROOT_DIR/circuits/build"
  local circuits=(deposit withdraw claim claim_64 claim_128 authorize authorize_64 authorize_128 cancel)
  local targets=("$ROOT_DIR/frontend/public/zk" "$ROOT_DIR/apps/pro/public/zk")
  local updated=0
  for t in "${targets[@]}"; do
    mkdir -p "$t"
  done
  for c in "${circuits[@]}"; do
    local zkey="$build_dir/${c}_final.zkey"
    local wasm="$build_dir/${c}_js/${c}.wasm"
    [ -f "$zkey" ] || continue
    [ -f "$wasm" ] || continue
    for t in "${targets[@]}"; do
      _sync_one_asset "$zkey" "$t/${c}_final.zkey" && updated=$((updated + 1))
      _sync_one_asset "$wasm" "$t/${c}.wasm" && updated=$((updated + 1))
    done
  done
  if [ "$updated" -gt 0 ]; then
    echo "  Synced $updated drifted zk asset(s) from circuits/build/ to consumer surfaces (frontend/, apps/pro/)."
    "$ROOT_DIR/scripts/check-zk-artifacts.sh" --write \
      || echo "  WARN: zk manifest write failed after sync"
  fi
}
ensure_circuits_built() {
  if [ "${SKIP_CIRCUIT_BUILD:-0}" = "1" ]; then
    echo "  SKIP_CIRCUIT_BUILD=1 — using existing zkeys + Verifier.sol."
    sync_zk_assets_from_build
    return
  fi
  echo "  Building circuits (regenerates zkeys + Verifier.sol — first run is slow)..."
  # `if !` instead of post-hoc `$?` check so the failure is caught even
  # under `set -e` (which would otherwise abort before the diagnostic runs).
  if ! ( cd "$ROOT_DIR/circuits" && npm run build ) > "$LOG_DIR/circuit-build.log" 2>&1; then
    echo "  ERROR: circuit build failed. Tail of $LOG_DIR/circuit-build.log:"
    tail -30 "$LOG_DIR/circuit-build.log" 2>/dev/null
    exit 1
  fi
  echo "  Circuits built."
}

echo "=== ScatterDEX Local Dev Environment (FORK) ==="
echo "  Fork URL:      $FORK_URL"
[ -n "$FORK_BLOCK" ] && echo "  Fork block:    $FORK_BLOCK"
echo "  Chain ID:      $FORK_CHAIN_ID"
echo ""

check_port 8545 "anvil"
check_port 4000 "shared-orderbook"
check_port 3002 "relayer-a"
check_port 3003 "relayer-b"
check_port 3000 "frontend"

echo "[1/6] Starting anvil (fork, hardfork=prague)..."
ANVIL_ARGS=(
  --silent
  --hardfork prague
  --fork-url "$FORK_URL"
  --chain-id "$FORK_CHAIN_ID"
)
[ -n "$FORK_BLOCK" ] && ANVIL_ARGS+=(--fork-block-number "$FORK_BLOCK")

anvil "${ANVIL_ARGS[@]}" > "$LOG_DIR/anvil.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "$RPC_URL" "anvil" 30; then
  echo "  Last 20 lines of anvil log:"
  tail -20 "$LOG_DIR/anvil.log" 2>/dev/null
  exit 1
fi
echo "  anvil running on $RPC_URL (PID $last_pid)"

echo ""
echo "[2/6] Deploying contracts (MockIdentityRegistry on forked chain, real WETH/USDC)..."
ensure_circuits_built
cd "$ROOT_DIR/contracts"
set +e
# USE_REAL_TOKENS=true → DeployLocal uses mainnet WETH/USDC (0xC02a…, 0xA0b8…)
# so settleWithDex can route through actual 1inch / Uniswap liquidity.
DEPLOY_OUTPUT=$(USE_REAL_TOKENS=true forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)
DEPLOY_STATUS=$?
set -e
if [ "$DEPLOY_STATUS" -ne 0 ] \
    && ! echo "$DEPLOY_OUTPUT" | grep -qE "Contract size|contract size|not a terminal|runtime size limit"; then
  echo "  ERROR: forge script failed (exit $DEPLOY_STATUS):"
  echo "$DEPLOY_OUTPUT"
  exit 1
fi

RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "^  RelayerRegistry:" | awk '{print $NF}')
WETH=$(echo "$DEPLOY_OUTPUT" | grep "^  WETH:" | awk '{print $NF}')
USDC=$(echo "$DEPLOY_OUTPUT" | grep "^  USDC:" | awk '{print $NF}')
USDT=$(echo "$DEPLOY_OUTPUT" | grep "^  USDT:" | awk '{print $NF}')
WTON=$(echo "$DEPLOY_OUTPUT" | grep "^  WTON:" | awk '{print $NF}')
COMMITMENT_POOL=$(echo "$DEPLOY_OUTPUT" | grep "^  CommitmentPool:" | awk '{print $NF}')
PRIVATE_SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "^  PrivateSettlement:" | awk '{print $NF}')
IDENTITY_GATE=$(echo "$DEPLOY_OUTPUT" | grep "^  IdentityGate:" | awk '{print $NF}')
FEE_VAULT=$(echo "$DEPLOY_OUTPUT" | grep "^  FeeVault:" | awk '{print $NF}')
BATCH_EXECUTOR=$(echo "$DEPLOY_OUTPUT" | grep "^  BatchExecutor:" | awk '{print $NF}')

if [ -z "$RELAYER_REGISTRY" ] || [ -z "$WETH" ] || [ -z "$USDC" ] || [ -z "$COMMITMENT_POOL" ] || [ -z "$PRIVATE_SETTLEMENT" ] || [ -z "$IDENTITY_GATE" ] || [ -z "$FEE_VAULT" ]; then
  echo "  ERROR: deployment failed (missing one or more contract addresses)"
  echo "$DEPLOY_OUTPUT"
  exit 1
fi

# Surface whether the DEX routers were whitelisted on this fork
if echo "$DEPLOY_OUTPUT" | grep -q "1inch Router whitelisted"; then
  echo "  1inch router:        whitelisted"
else
  echo "  WARNING: 1inch router not found on fork — market orders will fall back to Uniswap"
fi
if echo "$DEPLOY_OUTPUT" | grep -q "Uniswap SwapRouter02 whitelisted"; then
  echo "  Uniswap SwapRouter02:  whitelisted"
fi

echo "  RelayerRegistry:     $RELAYER_REGISTRY"
echo "  WETH:                $WETH"
echo "  USDC:                $USDC"
echo "  CommitmentPool:      $COMMITMENT_POOL"
echo "  PrivateSettlement:   $PRIVATE_SETTLEMENT"

# Real USDC has 6 decimals; Mock USDC has 18. DeployLocal's summary line
# encodes the correct value, but build it here so the rest of the script
# (relayer env, frontend env) stays consistent.
USDC_DECIMALS=6
if [ "${USE_REAL_TOKENS:-true}" != "true" ]; then USDC_DECIMALS=18; fi

# Token list shared by relayer and frontend — appends real USDT/WTON
# when the fork-mode deploy surfaced their addresses.
TOKEN_LIST="$WETH:WETH:18,$USDC:USDC:$USDC_DECIMALS"
[ -n "$USDT" ] && TOKEN_LIST="$TOKEN_LIST,$USDT:USDT:6"
[ -n "$WTON" ] && TOKEN_LIST="$TOKEN_LIST,$WTON:WTON:27"

# ── 2b. Prefund anvil Alice with ETH + USDC + USDT ────────
#        Real stablecoins can't be minted, so impersonate a whale and
#        transfer. ETH gives Alice gas + WETH wrapping headroom.
ALICE=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# Multiple whales so one failing (e.g. moved balance since fork block)
# doesn't break prefund. First match wins.
USDC_WHALES=(
  0x55FE002aefF02F77364de339a1292923A15844B8  # Circle
  0xF977814e90dA44bFA03b6295A0616a897441aceC  # Binance 8
  0x28C6c06298d514Db089934071355E5743bf21d60  # Binance 14
)
USDT_WHALES=(
  0xF977814e90dA44bFA03b6295A0616a897441aceC  # Binance 8
  0x5754284f345afc66a98fbB0a0Afe71e0F007B949  # Tether treasury
  0x28C6c06298d514Db089934071355E5743bf21d60  # Binance 14
)

echo ""
echo "[2b] Prefunding Alice ($ALICE) with ETH + USDC + USDT..."
cast rpc anvil_setBalance "$ALICE" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" > /dev/null  # 100 ETH

prefund_from_whale() {
  local token="$1" amount="$2" label="$3" ; shift 3
  local whales=("$@")
  for whale in "${whales[@]}"; do
    cast rpc anvil_impersonateAccount "$whale" --rpc-url "$RPC_URL" > /dev/null
    cast rpc anvil_setBalance "$whale" 0x56BC75E2D63100000 --rpc-url "$RPC_URL" > /dev/null
    if cast send "$token" "transfer(address,uint256)" "$ALICE" "$amount" \
        --from "$whale" --unlocked --rpc-url "$RPC_URL" > /dev/null 2>&1; then
      cast rpc anvil_stopImpersonatingAccount "$whale" --rpc-url "$RPC_URL" > /dev/null
      echo "  Alice funded: $label via $whale"
      return 0
    fi
    cast rpc anvil_stopImpersonatingAccount "$whale" --rpc-url "$RPC_URL" > /dev/null
  done
  echo "  WARNING: $label prefund failed — try FORK_BLOCK=<older block> or add whale"
  return 1
}

# Run USDC and USDT prefunds concurrently — each is a sequence of RPC
# roundtrips to the fork, independent of the other. Cuts wall time roughly
# in half when both need to fall back to a later whale.
prefund_from_whale "$USDC" 100000000000 "100,000 USDC" "${USDC_WHALES[@]}" &
USDC_PID=$!
if [ -n "$USDT" ]; then
  prefund_from_whale "$USDT" 100000000000 "100,000 USDT" "${USDT_WHALES[@]}" &
  USDT_PID=$!
fi
wait "$USDC_PID" 2>/dev/null || true
[ -n "${USDT_PID:-}" ] && wait "$USDT_PID" 2>/dev/null || true
# WTON is not worth chasing a whale for — UI can acquire via market order
# once WETH/USDC liquidity is available.

# ── 3. Start shared orderbook ──────────────────────────────
echo ""
echo "[3/6] Starting shared orderbook (port 4000)..."
# shared-orderbook AND zk-relayer both import @scatter-dex/types' built
# output — keep it fresh before either boots.
ensure_types_built
ensure_deps_installed "$ROOT_DIR/shared-orderbook" "shared-orderbook"
ensure_sqlite_arch "$ROOT_DIR/shared-orderbook"
cd "$ROOT_DIR/shared-orderbook"
# Mirror dev.sh's CORS allowlist union — see scripts/dev.sh DEV_CORS_ORIGINS
# for the rationale. Without this an --apps mode app (Pay :4001, Drop
# :4002, Pro :4003, Operators :4004) running against this fork stack
# would hit the orderbook's deficient hardcoded default and get
# blocked by CORS preflight. Keep this list in sync with the dev.sh
# version (APP_PORTS) — they're separate scripts so the duplication
# is explicit.
DEV_CORS_ORIGINS="http://localhost:3000,http://localhost:3002,http://localhost:3003,http://localhost:4001,http://localhost:4002,http://localhost:4003,http://localhost:4004"
CORS_ORIGINS="$DEV_CORS_ORIGINS" PORT=4000 ALLOW_PRIVATE_RELAYER_URLS=1 \
  npm run dev > "$LOG_DIR/shared-orderbook.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "http://localhost:4000/health" "shared-orderbook" 20; then
  echo "  Last 20 lines of shared-orderbook log:"
  tail -20 "$LOG_DIR/shared-orderbook.log" 2>/dev/null
  exit 1
fi
echo "  shared-orderbook running on http://localhost:4000 (PID $last_pid)"

# ── 4. Start Relayer A (primary, port 3002) ────────────────
echo ""
echo "[4/6] Starting Relayer A (port 3002)..."
ADMIN_KEY="dev-admin-$(head -c 16 /dev/urandom | xxd -p)"
# Capture the post-deploy block number so the relayer skips pre-fork history
# when scanning commitment events (upstream RPCs reject large ranges).
INDEX_FROM=$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null || echo 0)
cat > "$ROOT_DIR/zk-relayer/.env" << EOF
RPC_URL=$RPC_URL
RELAYER_PRIVATE_KEY=$RELAYER_A_KEY
COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
FEE_VAULT_ADDRESS=$FEE_VAULT
TOKEN_LIST=$TOKEN_LIST
ADMIN_API_KEY=$ADMIN_KEY
RELAYER_FEE=$RELAYER_FEE_BPS
PORT=3002
INDEX_FROM_BLOCK=$INDEX_FROM
SHARED_ORDERBOOK_URL=http://localhost:4000
RELAYER_PUBLIC_URL=http://localhost:3002
RELAYER_NAME=Relayer-A
DB_PATH=$ROOT_DIR/zk-relayer/zk-relayer.db
EOF
echo "  INDEX_FROM_BLOCK:    $INDEX_FROM"
echo "  Admin API key: $ADMIN_KEY"

ensure_deps_installed "$ROOT_DIR/zk-relayer" "zk-relayer"
ensure_sqlite_arch "$ROOT_DIR/zk-relayer"
cd "$ROOT_DIR/zk-relayer"
# Same CORS allowlist as the orderbook above — same rationale.
CORS_ORIGINS="$DEV_CORS_ORIGINS" ALLOW_PRIVATE_RELAYER_URLS=1 \
  npm run dev > "$LOG_DIR/relayer-a.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "http://localhost:3002/api/info" "relayer-a" 30; then
  echo "  Last 20 lines of relayer-a log:"
  tail -20 "$LOG_DIR/relayer-a.log" 2>/dev/null
  exit 1
fi
echo "  Relayer A running on http://localhost:3002 (PID $last_pid)"

# ── 5. Start Relayer B (secondary, port 3003) ──────────────
# Second relayer shares the same contracts but its own DB, identity,
# and public URL. Registered on-chain below so the frontend's
# `getActiveRelayers()` discovers both.
echo ""
echo "[5/6] Starting Relayer B (port 3003)..."
# Pass env inline rather than writing a second .env so zk-relayer/.env stays
# single-sourced for Admin API users.
RPC_URL="$RPC_URL" \
RELAYER_PRIVATE_KEY="$RELAYER_B_KEY" \
COMMITMENT_POOL_ADDRESS="$COMMITMENT_POOL" \
PRIVATE_SETTLEMENT_ADDRESS="$PRIVATE_SETTLEMENT" \
FEE_VAULT_ADDRESS="$FEE_VAULT" \
TOKEN_LIST="$TOKEN_LIST" \
ADMIN_API_KEY="$ADMIN_KEY" \
RELAYER_FEE=$RELAYER_FEE_BPS \
PORT=3003 \
INDEX_FROM_BLOCK="$INDEX_FROM" \
SHARED_ORDERBOOK_URL=http://localhost:4000 \
RELAYER_PUBLIC_URL=http://localhost:3003 \
RELAYER_NAME=Relayer-B \
DB_PATH="$ROOT_DIR/zk-relayer/zk-relayer-b.db" \
CORS_ORIGINS="$DEV_CORS_ORIGINS" \
ALLOW_PRIVATE_RELAYER_URLS=1 \
npm run dev > "$LOG_DIR/relayer-b.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "http://localhost:3003/api/info" "relayer-b" 30; then
  echo "  Last 20 lines of relayer-b log:"
  tail -20 "$LOG_DIR/relayer-b.log" 2>/dev/null
  exit 1
fi
echo "  Relayer B running on http://localhost:3003 (PID $last_pid)"

# Register Relayer B on-chain. DeployLocal.s.sol only registers
# account #1 (Relayer A) — account #2 needs a one-off registration
# post-deploy so frontend relayer discovery surfaces both.
# Idempotent: `register()` reverts if already registered, so a failed send
# on a re-run means "already registered" — confirm via a single call.
if cast send "$RELAYER_REGISTRY" "register(string,uint256)" \
    "http://localhost:3003" "$RELAYER_FEE_BPS" \
    --private-key "$RELAYER_B_KEY" --rpc-url "$RPC_URL" \
    > /dev/null 2>&1; then
  echo "  Relayer B registered on RelayerRegistry (fee=$RELAYER_FEE_BPS bps)"
else
  # RelayerRegistry.relayers(address) returns the full struct; decode with
  # the full tuple signature and take the first line (the URL string).
  EXISTING_URL=$(cast call "$RELAYER_REGISTRY" \
    "relayers(address)(string,uint256,uint256,uint256,uint256,bool)" \
    "$RELAYER_B_ADDR" --rpc-url "$RPC_URL" 2>/dev/null | head -1)
  if echo "$EXISTING_URL" | grep -q "http://localhost:3003"; then
    echo "  Relayer B already registered on RelayerRegistry"
  else
    echo "  WARNING: Relayer B on-chain registration failed — frontend may only list Relayer A"
  fi
fi

# ── 6. Start frontend ──────────────────────────────────────
echo ""
echo "[6/6] Starting frontend..."

# Preserve developer-owned secrets (not regenerated from the deployment)
PRESERVED_ENV=""
if [ -f "$ROOT_DIR/frontend/.env.local" ]; then
  PRESERVED_ENV=$(grep -E '^(ONEINCH_API_KEY|CSP_EXTRA_CONNECT_SRC|NEXT_PUBLIC_MAINNET_RPC)=' "$ROOT_DIR/frontend/.env.local" || true)
fi

cat > "$ROOT_DIR/frontend/.env.local" << EOF
NEXT_PUBLIC_RPC_URL=$RPC_URL
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
NEXT_PUBLIC_WETH_ADDRESS=$WETH
NEXT_PUBLIC_TOKENS=$TOKEN_LIST
NEXT_PUBLIC_CHAIN_ID=$FORK_CHAIN_ID
NEXT_PUBLIC_AGGREGATOR_CHAIN_ID=1
NEXT_PUBLIC_FORK_MODE=true
NEXT_PUBLIC_DISABLE_AGGREGATOR=${NEXT_PUBLIC_DISABLE_AGGREGATOR:-true}
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=$IDENTITY_GATE
NEXT_PUBLIC_FEE_VAULT_ADDRESS=$FEE_VAULT
NEXT_PUBLIC_BATCH_EXECUTOR_ADDRESS=$BATCH_EXECUTOR
NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002
NEXT_PUBLIC_SHARED_ORDERBOOK_URL=http://localhost:4000
# /api/relay proxy only allowlists NEXT_PUBLIC_ZK_RELAYER_URL by default;
# expand the allowlist so claim submissions can also target Relayer B.
ALLOWED_RELAYER_ORIGINS=http://localhost:3002,http://localhost:3003
EOF

# Mobile reads its chain-specific contract map from src/config/fork-contracts.json
# (gitignored). Regenerate it alongside the frontend env so running
# dev-fork.sh gives both clients the same deployment in one shot. Expo's
# Fast Refresh picks the JSON up on the next import without a rebuild.
mkdir -p "$ROOT_DIR/mobile/src/config"
# Build the mobile tokens[] array dynamically from whichever ERC-20s the
# deploy emitted. Mainnet-fork USDC/USDT are 6 decimals; mock USDC on
# dev.sh is 18 — we default to 6 here because dev-fork always uses real
# mainnet tokens (USE_REAL_TOKENS=true). WTON is 27 when it shows up.
# Render the tokens[] body ahead of the heredoc and substitute as a
# plain variable. Previously we used `$(printf %b ...)` inline inside
# the JSON, which relies on unquoted command substitution splitting
# rules — fragile and hard to read.
MOBILE_TOKENS_BODY="      { \"address\": \"$USDC\", \"symbol\": \"USDC\", \"decimals\": 6 }"
[ -n "$USDT" ] && MOBILE_TOKENS_BODY="${MOBILE_TOKENS_BODY},
      { \"address\": \"$USDT\", \"symbol\": \"USDT\", \"decimals\": 6 }"
[ -n "$WTON" ] && MOBILE_TOKENS_BODY="${MOBILE_TOKENS_BODY},
      { \"address\": \"$WTON\", \"symbol\": \"WTON\", \"decimals\": 27 }"

cat > "$ROOT_DIR/mobile/src/config/fork-contracts.json" << EOF
{
  "$FORK_CHAIN_ID": {
    "rpcUrl": "$RPC_URL",
    "weth": "$WETH",
    "commitmentPool": "$COMMITMENT_POOL",
    "privateSettlement": "$PRIVATE_SETTLEMENT",
    "identityGate": "$IDENTITY_GATE",
    "relayerRegistry": "$RELAYER_REGISTRY",
    "feeVault": "$FEE_VAULT",
    "batchExecutor": "$BATCH_EXECUTOR",
    "relayerUrl": "http://localhost:3002",
    "sharedOrderbookUrl": "http://localhost:4000",
    "tokens": [
${MOBILE_TOKENS_BODY}
    ]
  }
}
EOF
echo "  Wrote mobile contracts to mobile/src/config/fork-contracts.json"

# Mobile's ZK circuit artifacts (mobile/assets/zk/*.zkey|wasm) must match
# the verifiers the just-deployed contracts reference. `copy:circuits`
# is idempotent and skips unchanged files.
if [ -d "$ROOT_DIR/mobile" ]; then
  (cd "$ROOT_DIR/mobile" && npm run copy:circuits) \
    && echo "  Synced mobile ZK assets from circuits/build/" \
    || echo "  WARN: failed to copy mobile ZK assets (proofs may fail to verify)"
fi

if [ -n "$PRESERVED_ENV" ]; then
  echo "$PRESERVED_ENV" >> "$ROOT_DIR/frontend/.env.local"
  if [ "${NEXT_PUBLIC_DISABLE_AGGREGATOR:-true}" = "true" ]; then
    echo "  NOTE: ONEINCH_API_KEY is set, but NEXT_PUBLIC_DISABLE_AGGREGATOR=true"
    echo "        still pins routing to Uniswap V3. Re-run with"
    echo "        NEXT_PUBLIC_DISABLE_AGGREGATOR=false to enable the 1inch path."
  fi
else
  echo "  NOTE: ONEINCH_API_KEY not set — market orders will use Uniswap fallback."
  echo "        Add it to frontend/.env.local and restart the frontend to enable 1inch."
fi

ensure_deps_installed "$ROOT_DIR/frontend" "frontend"
cd "$ROOT_DIR/frontend"
npm run dev > "$LOG_DIR/frontend.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "http://localhost:3000" "frontend" 30; then
  echo "  Last 20 lines of frontend log:"
  tail -20 "$LOG_DIR/frontend.log" 2>/dev/null
  exit 1
fi
echo "  frontend running on http://localhost:3000 (PID $last_pid)"

echo ""
echo "========================================"
echo "  Fork dev environment is ready!"
echo "========================================"
echo ""
echo "  Mode:        FORK (mock identity on forked mainnet state)"
echo "  Fork URL:    $FORK_URL"
echo "  Chain ID:    $FORK_CHAIN_ID"
echo ""
echo "  Frontend:          http://localhost:3000"
echo "  Relayer A:         http://localhost:3002"
echo "  Relayer B:         http://localhost:3003"
echo "  Shared Orderbook:  http://localhost:4000"
echo "  Anvil:             $RPC_URL"
echo ""
echo "  MetaMask: add a custom network with RPC=$RPC_URL, Chain ID=$FORK_CHAIN_ID"
echo "  Test account (anvil #0): 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo ""
echo "  Logs:        $LOG_DIR/"
echo "  Press Ctrl+C to stop all services."
echo ""

set +e
wait
