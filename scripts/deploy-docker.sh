#!/bin/bash
# Deploy ScatterDEX ZK contracts and write addresses to shared volume.
# Used by docker-compose deployer service.
set -euo pipefail

RPC_URL="${RPC_URL:-http://anvil:8545}"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
OUTPUT_FILE="/shared/addresses.env"

# Ensure shared volume is writable
if [ ! -w /shared ]; then
  echo "ERROR: /shared is not writable"
  exit 1
fi

MAX_RPC_WAIT="${MAX_RPC_WAIT:-60}"
echo "Waiting for RPC at $RPC_URL (timeout: ${MAX_RPC_WAIT}s)..."
elapsed=0
until cast block-number --rpc-url "$RPC_URL" > /dev/null 2>&1; do
  sleep 1
  elapsed=$((elapsed + 1))
  if [ "$elapsed" -ge "$MAX_RPC_WAIT" ]; then
    echo "ERROR: RPC not ready after ${MAX_RPC_WAIT}s at $RPC_URL"
    exit 1
  fi
done
echo "RPC is ready."

cd /contracts

# ── Deploy with DeployLocal (MockIdentityRegistry) ──
echo "Mode: MOCK (standalone)"

DEPLOY_OUTPUT=$(forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)

echo "$DEPLOY_OUTPUT"

RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*RelayerRegistry:" | awk '{print $NF}')
COMMITMENT_POOL=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*CommitmentPool:" | awk '{print $NF}')
PRIVATE_SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*PrivateSettlement:" | awk '{print $NF}')
WETH=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*WETH:" | awk '{print $NF}')
USDC=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*USDC:" | awk '{print $NF}')

# Validate all addresses were parsed
for var_name in RELAYER_REGISTRY COMMITMENT_POOL PRIVATE_SETTLEMENT WETH USDC; do
  eval val=\$$var_name
  if [ -z "$val" ]; then
    echo "ERROR: Failed to parse $var_name from deploy output"
    exit 1
  fi
done

cat > "$OUTPUT_FILE" <<EOF
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
# MockToken uses default ERC20 decimals (18). Real USDC uses 6.
NEXT_PUBLIC_TOKENS=$WETH:WETH:18,$USDC:USDC:18
NEXT_PUBLIC_WETH_ADDRESS=$WETH
COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002
EOF

echo ""
echo "=== Addresses written to $OUTPUT_FILE ==="
cat "$OUTPUT_FILE"
