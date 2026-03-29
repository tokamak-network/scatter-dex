#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
RPC_URL="http://localhost:8545"
PIDS=()

cleanup() {
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

echo "=== ScatterDEX Local Dev Environment ==="
echo ""

# ── 1. Start anvil ────────────────────────────────────────────
echo "[1/4] Starting anvil..."
anvil --silent &
PIDS+=($!)
sleep 2

if ! curl -s "$RPC_URL" -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
  echo "  ERROR: anvil failed to start"
  exit 1
fi
echo "  anvil running on $RPC_URL (PID ${PIDS[-1]})"

# ── 2. Deploy contracts ──────────────────────────────────────
echo ""
echo "[2/4] Deploying contracts..."
cd "$ROOT_DIR/contracts"
DEPLOY_OUTPUT=$(forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)

SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "ScatterSettlement:" | awk '{print $NF}')
RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "RelayerRegistry:" | awk '{print $NF}')
WETH=$(echo "$DEPLOY_OUTPUT" | grep "WETH:" | awk '{print $NF}')
USDC=$(echo "$DEPLOY_OUTPUT" | grep "USDC:" | awk '{print $NF}')

if [ -z "$SETTLEMENT" ]; then
  echo "  ERROR: deployment failed"
  echo "$DEPLOY_OUTPUT"
  exit 1
fi

# Whitelist tokens
echo "  Whitelisting tokens..."
cast send "$SETTLEMENT" "setTokenWhitelist(address,bool)" "$WETH" true \
  --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL" > /dev/null 2>&1
cast send "$SETTLEMENT" "setTokenWhitelist(address,bool)" "$USDC" true \
  --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL" > /dev/null 2>&1

echo "  Settlement:       $SETTLEMENT"
echo "  RelayerRegistry:  $RELAYER_REGISTRY"
echo "  WETH:             $WETH"
echo "  USDC:             $USDC"

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
npm run dev > /dev/null 2>&1 &
PIDS+=($!)
sleep 2
echo "  relayer running on http://localhost:3001 (PID ${PIDS[-1]})"

# ── 4. Start frontend ────────────────────────────────────────
echo ""
echo "[4/4] Starting frontend..."
cat > "$ROOT_DIR/frontend/.env.local" << EOF
NEXT_PUBLIC_RPC_URL=$RPC_URL
NEXT_PUBLIC_SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
NEXT_PUBLIC_TOKEN_LIST=$WETH,$USDC
EOF

cd "$ROOT_DIR/frontend"
npm run dev &
PIDS+=($!)

echo ""
echo "========================================"
echo "  Local dev environment is ready!"
echo "========================================"
echo ""
echo "  Frontend:  http://localhost:3000"
echo "  Relayer:   http://localhost:3001"
echo "  Anvil:     $RPC_URL"
echo ""
echo "  WETH: $WETH"
echo "  USDC: $USDC"
echo ""
echo "  Test accounts (anvil defaults):"
echo "    Alice: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo "    Bob:   0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
echo ""
echo "  Press Ctrl+C to stop all services."
echo ""

# Wait for any child to exit
wait
