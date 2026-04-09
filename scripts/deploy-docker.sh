#!/bin/bash
# Deploy ScatterDEX ZK contracts and write addresses to shared volume.
# Used by docker-compose deployer service.
set -euo pipefail

RPC_URL="${RPC_URL:-http://anvil:8545}"
# WARNING: This is Anvil's well-known Account #0 key — for LOCAL DEVELOPMENT ONLY.
# NEVER use this key on mainnet or testnet. Override via DEPLOYER_KEY env var for production.
DEPLOYER_KEY="${DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"
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
IDENTITY_GATE=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*IdentityGate:" | awk '{print $NF}')
FEE_VAULT=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*FeeVault:" | awk '{print $NF}')

# Validate all addresses were parsed
for var_name in RELAYER_REGISTRY COMMITMENT_POOL PRIVATE_SETTLEMENT WETH USDC IDENTITY_GATE FEE_VAULT; do
  if [ -z "${!var_name}" ]; then
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
FEE_VAULT_ADDRESS=$FEE_VAULT
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=$IDENTITY_GATE
NEXT_PUBLIC_FEE_VAULT_ADDRESS=$FEE_VAULT
NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002
EOF

# Register Relayer B (Anvil Account #2) if multi-relayer mode
RELAYER_B_KEY="${RELAYER_B_KEY:-0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a}"
if [ -n "$RELAYER_B_KEY" ]; then
  echo ""
  echo "Registering Relayer B in RelayerRegistry..."
  # Check if register function exists (may vary by contract version)
  cast send "$RELAYER_REGISTRY" "register(string,uint256)" "http://zk-relayer-b:3003" 30 \
    --rpc-url "$RPC_URL" --private-key "$RELAYER_B_KEY" 2>/dev/null \
    && echo "Relayer B registered" \
    || echo "Relayer B registration skipped (may already be registered or function differs)"
fi

echo ""
echo "=== Addresses written to $OUTPUT_FILE ==="
cat "$OUTPUT_FILE"
