#!/bin/bash
# Start infrastructure for cross-relayer E2E testing.
#
# Prerequisites:
#   - anvil running (from ./scripts/dev.sh --mock)
#   - Contracts deployed (addresses in zk-relayer/.env)
#
# This script starts:
#   1. Shared orderbook server (port 4000)
#   2. Relayer A (restarted with shared orderbook config, port 3002)
#   3. Relayer B (port 3003)
#
# Usage:
#   ./scripts/start-cross-relayer-e2e.sh
#
# To run the E2E test:
#   cd zk-relayer && npx tsx test/e2e-cross-relayer.ts

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT_DIR/.e2e-logs"
mkdir -p "$LOG_DIR"

# Track background PIDs for cleanup
PIDS=()
EXIT_CODE=0
cleanup() {
  echo ""
  echo "Stopping background services..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "Done."
  exit "$EXIT_CODE"
}
trap 'EXIT_CODE=$?; cleanup' EXIT
trap 'EXIT_CODE=130; cleanup' SIGINT SIGTERM

echo "==============================================="
echo "  Cross-Relayer E2E Environment Setup"
echo "==============================================="

# Validate zk-relayer/.env exists and has required vars
echo ""
echo "[1/4] Validating environment..."
if [ ! -f "$ROOT_DIR/zk-relayer/.env" ]; then
  echo "  ERROR: zk-relayer/.env not found. Run ./scripts/dev.sh --mock first."
  exit 1
fi

# Safely read specific vars (not sourcing blindly)
COMMITMENT_POOL_ADDRESS=$(grep '^COMMITMENT_POOL_ADDRESS=' "$ROOT_DIR/zk-relayer/.env" | cut -d= -f2)
PRIVATE_SETTLEMENT_ADDRESS=$(grep '^PRIVATE_SETTLEMENT_ADDRESS=' "$ROOT_DIR/zk-relayer/.env" | cut -d= -f2)
FEE_VAULT_ADDRESS=$(grep '^FEE_VAULT_ADDRESS=' "$ROOT_DIR/zk-relayer/.env" | cut -d= -f2)
RPC_URL="${RPC_URL:-http://localhost:8545}"

for var in COMMITMENT_POOL_ADDRESS PRIVATE_SETTLEMENT_ADDRESS FEE_VAULT_ADDRESS; do
  val="${!var}"
  if [ -z "$val" ] || [ "${#val}" -lt 42 ]; then
    echo "  ERROR: $var is missing or invalid in zk-relayer/.env"
    exit 1
  fi
done
echo "  [ok] Contract addresses loaded"

# Check anvil is running
if ! curl -s "$RPC_URL" -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' > /dev/null 2>&1; then
  echo "  ERROR: anvil not running at $RPC_URL"
  exit 1
fi
echo "  [ok] Anvil running at $RPC_URL"

# Start shared orderbook server
echo ""
echo "[2/4] Starting shared orderbook server (port 4000)..."
if curl -s http://localhost:4000/health > /dev/null 2>&1; then
  echo "  [ok] Already running"
else
  cd "$ROOT_DIR/shared-orderbook"
  PORT=4000 npm run dev > "$LOG_DIR/orderbook.log" 2>&1 &
  OB_PID=$!
  PIDS+=($OB_PID)
  for i in $(seq 1 15); do
    sleep 1
    if curl -s http://localhost:4000/health > /dev/null 2>&1; then
      echo "  [ok] Started (PID: $OB_PID, log: .e2e-logs/orderbook.log)"
      break
    fi
    [ $i -eq 15 ] && { echo "  ERROR: Failed to start"; exit 1; }
  done
fi

# Stop existing Relayer A (if running from dev.sh) and restart with shared orderbook config
echo ""
echo "[3/4] Starting Relayer A (port 3002) with shared orderbook..."
# Kill any existing process on port 3002
lsof -ti:3002 | xargs kill 2>/dev/null || true
sleep 1

cd "$ROOT_DIR/zk-relayer"
# Anvil well-known test key (Account #1). Override via env for custom setups.
RELAYER_A_KEY="${RELAYER_A_KEY:-0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d}"

RPC_URL="$RPC_URL" \
RELAYER_PRIVATE_KEY="$RELAYER_A_KEY" \
COMMITMENT_POOL_ADDRESS="$COMMITMENT_POOL_ADDRESS" \
PRIVATE_SETTLEMENT_ADDRESS="$PRIVATE_SETTLEMENT_ADDRESS" \
FEE_VAULT_ADDRESS="$FEE_VAULT_ADDRESS" \
PORT=3002 \
RELAYER_FEE=30 \
DB_PATH="$ROOT_DIR/zk-relayer/zk-relayer.db" \
SHARED_ORDERBOOK_URL="http://localhost:4000" \
RELAYER_PUBLIC_URL="http://localhost:3002" \
RELAYER_NAME="Relayer-A" \
npm run dev > "$LOG_DIR/relayer-a.log" 2>&1 &
RA_PID=$!
PIDS+=($RA_PID)

for i in $(seq 1 15); do
  sleep 1
  if curl -s http://localhost:3002/api/info > /dev/null 2>&1; then
    echo "  [ok] Started (PID: $RA_PID, log: .e2e-logs/relayer-a.log)"
    break
  fi
  [ $i -eq 15 ] && { echo "  ERROR: Failed to start"; exit 1; }
done

# Start Relayer B
echo ""
echo "[4/4] Starting Relayer B (port 3003)..."
# Anvil well-known test key (Account #2). Override via env for custom setups.
RELAYER_B_KEY="${RELAYER_B_KEY:-0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a}"

RPC_URL="$RPC_URL" \
RELAYER_PRIVATE_KEY="$RELAYER_B_KEY" \
COMMITMENT_POOL_ADDRESS="$COMMITMENT_POOL_ADDRESS" \
PRIVATE_SETTLEMENT_ADDRESS="$PRIVATE_SETTLEMENT_ADDRESS" \
FEE_VAULT_ADDRESS="$FEE_VAULT_ADDRESS" \
PORT=3003 \
RELAYER_FEE=30 \
DB_PATH="$ROOT_DIR/zk-relayer/zk-relayer-b.db" \
SHARED_ORDERBOOK_URL="http://localhost:4000" \
RELAYER_PUBLIC_URL="http://localhost:3003" \
RELAYER_NAME="Relayer-B" \
npm run dev > "$LOG_DIR/relayer-b.log" 2>&1 &
RB_PID=$!
PIDS+=($RB_PID)

for i in $(seq 1 15); do
  sleep 1
  if curl -s http://localhost:3003/api/info > /dev/null 2>&1; then
    echo "  [ok] Started (PID: $RB_PID, log: .e2e-logs/relayer-b.log)"
    break
  fi
  [ $i -eq 15 ] && { echo "  ERROR: Failed to start"; exit 1; }
done

# Register Relayer B in the on-chain RelayerRegistry so the frontend
# (which discovers relayers via getActiveRelayers()) can see both.
# DeployLocal.s.sol only registers Account #1; Account #2 needs a
# post-deploy registration the first time the cross-relayer script runs.
echo ""
echo "[5/5] Registering Relayer B on RelayerRegistry..."
REGISTRY=$(grep '^NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=' "$ROOT_DIR/frontend/.env.local" 2>/dev/null | cut -d= -f2)
if [ -z "$REGISTRY" ]; then
  echo "  [warn] NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS not found; skipping on-chain registration"
else
  ALREADY=$(cast call "$REGISTRY" "relayers(address)(string,uint256,uint256,uint256,uint256,bool)" \
    0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC --rpc-url "$RPC_URL" 2>/dev/null | head -1)
  if echo "$ALREADY" | grep -q "http://localhost:3003"; then
    echo "  [ok] Already registered"
  else
    if cast send "$REGISTRY" "register(string,uint256)" "http://localhost:3003" 30 \
      --private-key "$RELAYER_B_KEY" --rpc-url "$RPC_URL" > /dev/null 2>&1; then
      echo "  [ok] Relayer B registered (url=http://localhost:3003, fee=30 bps)"
    else
      echo "  [warn] Registration call failed — frontend may only list Relayer A"
    fi
  fi
fi

echo ""
echo "==============================================="
echo "  Infrastructure ready!"
echo "==============================================="
echo ""
echo "  Shared Orderbook: http://localhost:4000"
echo "  Relayer A:        http://localhost:3002"
echo "  Relayer B:        http://localhost:3003"
echo "  Logs:             .e2e-logs/"
echo ""
echo "  To run E2E test:"
echo "    cd zk-relayer && npx tsx test/e2e-cross-relayer.ts"
echo ""
echo "  To check status:"
echo "    curl http://localhost:3002/api/info"
echo "    curl http://localhost:3003/api/info"
echo "    curl http://localhost:4000/health"
echo ""
echo "  Press Ctrl+C to stop all services"
echo ""
wait
