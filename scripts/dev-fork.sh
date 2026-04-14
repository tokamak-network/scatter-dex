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
#   FORK_URL        (default: https://eth.llamarpc.com)
#   FORK_BLOCK      (default: latest — pin for reproducibility)
#   FORK_CHAIN_ID   (default: 1 — preserves mainnet semantics for 1inch API)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.dev-logs"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ZK_RELAYER_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
RPC_URL="http://localhost:8545"
FORK_URL="${FORK_URL:-https://eth.llamarpc.com}"
FORK_BLOCK="${FORK_BLOCK:-}"
FORK_CHAIN_ID="${FORK_CHAIN_ID:-1}"
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
  if lsof -i :"$port" > /dev/null 2>&1; then
    echo "ERROR: port $port is already in use ($name). Kill the existing process first."
    exit 1
  fi
}

mkdir -p "$LOG_DIR"

echo "=== ScatterDEX Local Dev Environment (FORK) ==="
echo "  Fork URL:      $FORK_URL"
[ -n "$FORK_BLOCK" ] && echo "  Fork block:    $FORK_BLOCK"
echo "  Chain ID:      $FORK_CHAIN_ID"
echo ""

check_port 8545 "anvil"
check_port 3002 "zk-relayer"
check_port 3000 "frontend"

echo "[1/4] Starting anvil (fork, hardfork=prague)..."
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
echo "[2/4] Deploying contracts (MockIdentityRegistry on forked chain)..."
cd "$ROOT_DIR/contracts"
set +e
DEPLOY_OUTPUT=$(forge script script/DeployLocal.s.sol:DeployLocal \
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

# ── 3. Start zk-relayer ─────────────────────────────────────
echo ""
echo "[3/4] Starting zk-relayer..."
ADMIN_KEY="dev-admin-$(head -c 16 /dev/urandom | xxd -p)"
cat > "$ROOT_DIR/zk-relayer/.env" << EOF
RPC_URL=$RPC_URL
RELAYER_PRIVATE_KEY=$ZK_RELAYER_KEY
COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
FEE_VAULT_ADDRESS=$FEE_VAULT
TOKEN_LIST=$WETH:WETH:18,$USDC:USDC:18
ADMIN_API_KEY=$ADMIN_KEY
RELAYER_FEE=30
PORT=3002
EOF
echo "  Admin API key: $ADMIN_KEY"

cd "$ROOT_DIR/zk-relayer"
npm run dev > "$LOG_DIR/zk-relayer.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "http://localhost:3002/api/info" "zk-relayer" 30; then
  echo "  Last 20 lines of zk-relayer log:"
  tail -20 "$LOG_DIR/zk-relayer.log" 2>/dev/null
  exit 1
fi
echo "  zk-relayer running on http://localhost:3002 (PID $last_pid)"

# ── 4. Start frontend ──────────────────────────────────────
echo ""
echo "[4/4] Starting frontend..."
TOKENS="$WETH:WETH:18,$USDC:USDC:18"

# Preserve developer-owned secrets (not regenerated from the deployment)
PRESERVED_ENV=""
if [ -f "$ROOT_DIR/frontend/.env.local" ]; then
  PRESERVED_ENV=$(grep -E '^(ONEINCH_API_KEY)=' "$ROOT_DIR/frontend/.env.local" || true)
fi

cat > "$ROOT_DIR/frontend/.env.local" << EOF
NEXT_PUBLIC_RPC_URL=$RPC_URL
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
NEXT_PUBLIC_WETH_ADDRESS=$WETH
NEXT_PUBLIC_TOKENS=$TOKENS
NEXT_PUBLIC_CHAIN_ID=$FORK_CHAIN_ID
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=$IDENTITY_GATE
NEXT_PUBLIC_FEE_VAULT_ADDRESS=$FEE_VAULT
NEXT_PUBLIC_BATCH_EXECUTOR_ADDRESS=$BATCH_EXECUTOR
NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002
EOF

if [ -n "$PRESERVED_ENV" ]; then
  echo "$PRESERVED_ENV" >> "$ROOT_DIR/frontend/.env.local"
else
  echo "  NOTE: ONEINCH_API_KEY not set — market orders will use Uniswap fallback."
  echo "        Add it to frontend/.env.local and restart the frontend to enable 1inch."
fi

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
echo "  Frontend:    http://localhost:3000"
echo "  ZK Relayer:  http://localhost:3002"
echo "  Anvil:       $RPC_URL"
echo ""
echo "  MetaMask: add a custom network with RPC=$RPC_URL, Chain ID=$FORK_CHAIN_ID"
echo "  Test account (anvil #0): 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo ""
echo "  Logs:        $LOG_DIR/"
echo "  Press Ctrl+C to stop all services."
echo ""

set +e
wait
