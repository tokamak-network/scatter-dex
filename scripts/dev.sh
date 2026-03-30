#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.dev-logs"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
RPC_URL="http://localhost:8545"
MOCK_MODE=false
PIDS=()
CLEANED_UP=false

usage() {
  echo "Usage: $0 [--mock]"
  echo ""
  echo "  Default:  Connects to running anvil with zk-X509 deployed."
  echo "            Requires IDENTITY_REGISTRY env var or prompts for it."
  echo "  --mock:   Starts own anvil with MockIdentityRegistry (no zk-X509 needed)."
  exit 0
}

for arg in "$@"; do
  case "$arg" in
    --mock) MOCK_MODE=true ;;
    --help|-h) usage ;;
  esac
done

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

# Wait for a URL to respond, with timeout. Returns 1 on failure.
wait_for() {
  local url="$1" name="$2" max="$3"
  local i=0
  while ! curl -fsS "$url" > /dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -ge "$max" ]; then
      echo "  ERROR: $name failed to start (waited ${max}s)"
      return 1
    fi
    sleep 1
  done
  return 0
}

# Check if a port is already in use
check_port() {
  local port="$1" name="$2"
  if lsof -i :"$port" > /dev/null 2>&1; then
    echo "ERROR: port $port is already in use ($name). Kill the existing process first."
    exit 1
  fi
}

# Create log directory
mkdir -p "$LOG_DIR"

echo "=== ScatterDEX Local Dev Environment ==="
echo ""

if [ "$MOCK_MODE" = true ]; then
  # ── Mock mode: standalone with MockIdentityRegistry ─────────
  echo "Mode: MOCK (standalone, no zk-X509)"
  echo ""

  check_port 8545 "anvil"
  check_port 3001 "relayer"
  check_port 3000 "frontend"

  echo "[1/4] Starting anvil..."
  anvil --silent &
  last_pid=$!
  PIDS+=("$last_pid")
  if ! wait_for "$RPC_URL" "anvil" 10; then
    exit 1
  fi
  echo "  anvil running on $RPC_URL (PID $last_pid)"

  echo ""
  echo "[2/4] Deploying contracts (MockIdentityRegistry)..."
  cd "$ROOT_DIR/contracts"
  DEPLOY_OUTPUT=$(forge script script/DeployLocal.s.sol:DeployLocal \
    --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)

  SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "ScatterSettlement:" | awk '{print $NF}')
  RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "RelayerRegistry:" | awk '{print $NF}')
  WETH=$(echo "$DEPLOY_OUTPUT" | grep "WETH:" | awk '{print $NF}')
  USDC=$(echo "$DEPLOY_OUTPUT" | grep "USDC:" | awk '{print $NF}')

  if [ -z "$SETTLEMENT" ] || [ -z "$RELAYER_REGISTRY" ] || [ -z "$WETH" ] || [ -z "$USDC" ]; then
    echo "  ERROR: deployment failed (missing one or more contract addresses)"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

else
  # ── Integration mode: connect to existing anvil with zk-X509 ──
  echo "Mode: INTEGRATION (zk-X509 required)"
  echo ""

  # Verify anvil is running
  echo "[1/4] Checking anvil..."
  if ! curl -fsS "$RPC_URL" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
    echo "  ERROR: anvil is not running at $RPC_URL"
    echo "  Start zk-X509 local environment first. See:"
    echo "  https://github.com/user/zk-X509/blob/main/docs/local-setup.md"
    exit 1
  fi
  echo "  anvil is running."

  check_port 3001 "relayer"
  check_port 3000 "frontend"

  # Get User IdentityRegistry address
  if [ -z "$IDENTITY_REGISTRY" ]; then
    echo ""
    echo "  IDENTITY_REGISTRY not set."
    echo "  Enter the zk-X509 User CA IdentityRegistry proxy address:"
    read -r -p "  > " IDENTITY_REGISTRY
  fi

  if [ -z "$IDENTITY_REGISTRY" ]; then
    echo "  ERROR: IDENTITY_REGISTRY is required in integration mode."
    echo "  Usage: IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x... $0"
    echo "  Or use: $0 --mock"
    exit 1
  fi

  # Get Relayer IdentityRegistry address
  if [ -z "$RELAYER_IDENTITY_REGISTRY" ]; then
    echo ""
    echo "  RELAYER_IDENTITY_REGISTRY not set."
    echo "  Enter the zk-X509 Relayer CA IdentityRegistry proxy address:"
    read -r -p "  > " RELAYER_IDENTITY_REGISTRY
  fi

  if [ -z "$RELAYER_IDENTITY_REGISTRY" ]; then
    echo "  ERROR: RELAYER_IDENTITY_REGISTRY is required in integration mode."
    echo "  Usage: IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x... $0"
    echo "  Or use: $0 --mock"
    exit 1
  fi

  # Verify the registry contracts exist
  CODE=$(cast code "$IDENTITY_REGISTRY" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")
  if [ "$CODE" = "0x" ]; then
    echo "  ERROR: No contract found at $IDENTITY_REGISTRY"
    echo "  Deploy zk-X509 contracts first."
    exit 1
  fi
  echo "  IdentityRegistry (User CA):    $IDENTITY_REGISTRY"

  CODE=$(cast code "$RELAYER_IDENTITY_REGISTRY" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")
  if [ "$CODE" = "0x" ]; then
    echo "  ERROR: No contract found at $RELAYER_IDENTITY_REGISTRY"
    echo "  Deploy zk-X509 Relayer CA registry first."
    exit 1
  fi
  echo "  IdentityRegistry (Relayer CA): $RELAYER_IDENTITY_REGISTRY"

  echo ""
  echo "[2/4] Deploying contracts (real IdentityGate)..."
  cd "$ROOT_DIR/contracts"

  # Use deployer as treasury for local dev
  TREASURY="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

  DEPLOY_OUTPUT=$(IDENTITY_REGISTRY="$IDENTITY_REGISTRY" \
    RELAYER_IDENTITY_REGISTRY="$RELAYER_IDENTITY_REGISTRY" \
    TREASURY="$TREASURY" \
    PROTOCOL_FEE_BPS=1000 \
    forge script script/DeploySettlement.s.sol:DeploySettlement \
    --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)

  SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "ScatterSettlement deployed:" | awk '{print $NF}')
  RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "RelayerRegistry deployed:" | awk '{print $NF}')

  if [ -z "$SETTLEMENT" ] || [ -z "$RELAYER_REGISTRY" ]; then
    echo "  ERROR: deployment failed (missing contract addresses)"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

  # No test tokens in integration mode
  WETH=""
  USDC=""

  # Register deployer as relayer
  echo "  Registering deployer as relayer..."
  cast send "$RELAYER_REGISTRY" "register(string,uint256)" "http://localhost:3001" 30 \
    --value 0.1ether --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL" > /dev/null || true
fi

# Whitelist tokens (if available)
if [ -n "$WETH" ] && [ -n "$USDC" ]; then
  echo "  Whitelisting tokens..."
  cast send "$SETTLEMENT" "setTokenWhitelist(address,bool)" "$WETH" true \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL" > /dev/null
  cast send "$SETTLEMENT" "setTokenWhitelist(address,bool)" "$USDC" true \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL" > /dev/null
fi

echo "  Settlement:       $SETTLEMENT"
echo "  RelayerRegistry:  $RELAYER_REGISTRY"
[ -n "$WETH" ] && echo "  WETH:             $WETH"
[ -n "$USDC" ] && echo "  USDC:             $USDC"

# ── 3. Start relayer ─────────────────────────────────────────
echo ""
echo "[3/4] Starting relayer..."
cat > "$ROOT_DIR/relayer/.env" << EOF
RPC_URL=$RPC_URL
RELAYER_PRIVATE_KEY=$DEPLOYER_KEY
SETTLEMENT_ADDRESS=$SETTLEMENT
RELAYER_FEE=30
PORT=3001
EOF

cd "$ROOT_DIR/relayer"
npm run dev > "$LOG_DIR/relayer.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "http://localhost:3001/api/info" "relayer" 15; then
  echo "  Last 20 lines of relayer log:"
  tail -20 "$LOG_DIR/relayer.log" 2>/dev/null
  exit 1
fi
echo "  relayer running on http://localhost:3001 (PID $last_pid)"

# ── 4. Start frontend ────────────────────────────────────────
echo ""
echo "[4/4] Starting frontend..."
TOKEN_LIST=""
[ -n "$WETH" ] && [ -n "$USDC" ] && TOKEN_LIST="$WETH,$USDC"

cat > "$ROOT_DIR/frontend/.env.local" << EOF
NEXT_PUBLIC_RPC_URL=$RPC_URL
NEXT_PUBLIC_SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
NEXT_PUBLIC_TOKEN_LIST=$TOKEN_LIST
EOF

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
echo "  Local dev environment is ready!"
echo "========================================"
echo ""
if [ "$MOCK_MODE" = true ]; then
  echo "  Mode:      MOCK (MockIdentityRegistry — all users verified)"
else
  echo "  Mode:      INTEGRATION (zk-X509 IdentityRegistry)"
  echo "  Registry:  $IDENTITY_REGISTRY"
fi
echo ""
echo "  Frontend:  http://localhost:3000"
echo "  Relayer:   http://localhost:3001"
echo "  Anvil:     $RPC_URL"
echo ""
echo "  Settlement:       $SETTLEMENT"
echo "  RelayerRegistry:  $RELAYER_REGISTRY"
[ -n "$WETH" ] && echo "  WETH:             $WETH"
[ -n "$USDC" ] && echo "  USDC:             $USDC"
echo ""
echo "  Logs:      $LOG_DIR/"
echo ""
if [ "$MOCK_MODE" = true ]; then
  echo "  Test accounts (anvil defaults):"
  echo "    Alice: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  echo "    Bob:   0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
  echo ""
fi
echo "  Press Ctrl+C to stop all services."
echo ""

# Keep alive
set +e
wait
