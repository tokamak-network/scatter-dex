#!/bin/bash
# Deploy ScatterDEX contracts and write addresses to shared volume.
# Used by docker-compose deployer service.
set -euo pipefail

RPC_URL="${RPC_URL:-http://anvil:8545}"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
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

# ── Shared helper ────────────────────────────────────────────
whitelist_tokens() {
  local settlement="$1" weth="$2" usdc="$3"
  if [ -z "$weth" ] || [ -z "$usdc" ]; then
    echo "ERROR: Failed to parse token addresses (WETH='$weth', USDC='$usdc')"
    exit 1
  fi
  echo "Whitelisting WETH=$weth USDC=$usdc"
  cast send "$settlement" "setTokenWhitelist(address,bool)" "$weth" true \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL"
  cast send "$settlement" "setTokenWhitelist(address,bool)" "$usdc" true \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL"
}

if [ -n "${IDENTITY_REGISTRY:-}" ]; then
  # ── Integration mode: use real zk-X509 Dual-CA IdentityRegistries ──
  if [ -z "${RELAYER_IDENTITY_REGISTRY:-}" ]; then
    echo "ERROR: RELAYER_IDENTITY_REGISTRY is required in integration mode."
    exit 1
  fi

  echo "Mode: INTEGRATION (Dual-CA)"
  echo "  User CA:    $IDENTITY_REGISTRY"
  echo "  Relayer CA: $RELAYER_IDENTITY_REGISTRY"

  DEPLOY_OUTPUT=$(IDENTITY_REGISTRY="$IDENTITY_REGISTRY" \
    RELAYER_IDENTITY_REGISTRY="$RELAYER_IDENTITY_REGISTRY" \
    TREASURY="$DEPLOYER_ADDR" \
    PROTOCOL_FEE_BPS="${PROTOCOL_FEE_BPS:-1000}" \
    forge script script/DeploySettlement.s.sol:DeploySettlement \
      --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)

  echo "$DEPLOY_OUTPUT"

  SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "ScatterSettlement deployed:" | awk '{print $NF}')
  RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "RelayerRegistry deployed:" | awk '{print $NF}')

  # Register deployer as relayer (use localhost URL reachable from browser)
  RELAYER_URL="${RELAYER_URL:-http://localhost:3001}"
  echo "Registering relayer at $RELAYER_URL..."
  cast send "$RELAYER_REGISTRY" "register(string,uint256)" "$RELAYER_URL" 30 \
    --value 0.1ether --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL"

  # Deploy test tokens (not included in DeploySettlement)
  echo ""
  echo "=== Deploying test tokens ==="
  TOKEN_OUTPUT=$(forge script script/DeployTestTokens.s.sol:DeployTestTokens \
    --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)
  echo "$TOKEN_OUTPUT"

  WETH=$(echo "$TOKEN_OUTPUT" | grep "WETH:" | awk '{print $NF}')
  USDC=$(echo "$TOKEN_OUTPUT" | grep "USDC:" | awk '{print $NF}')

  whitelist_tokens "$SETTLEMENT" "$WETH" "$USDC"

  cat > "$OUTPUT_FILE" <<EOF
SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
NEXT_PUBLIC_TOKENS=$WETH:WETH:18,$USDC:USDC:18
NEXT_PUBLIC_WETH_ADDRESS=$WETH
IDENTITY_REGISTRY=$IDENTITY_REGISTRY
EOF

else
  # ── Mock mode: deploy everything including MockIdentityRegistry ──
  echo "Mode: MOCK (standalone)"

  DEPLOY_OUTPUT=$(forge script script/DeployLocal.s.sol:DeployLocal \
    --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)

  echo "$DEPLOY_OUTPUT"

  SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*ScatterSettlement:" | awk '{print $NF}')
  RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*RelayerRegistry:" | awk '{print $NF}')
  COMMITMENT_POOL=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*CommitmentPool:" | awk '{print $NF}')
  PRIVATE_SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*PrivateSettlement:" | awk '{print $NF}')
  WETH=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*WETH:" | awk '{print $NF}')
  USDC=$(echo "$DEPLOY_OUTPUT" | grep "^[[:space:]]*USDC:" | awk '{print $NF}')

  # Validate all addresses were parsed
  for var_name in SETTLEMENT RELAYER_REGISTRY COMMITMENT_POOL PRIVATE_SETTLEMENT WETH USDC; do
    eval val=\$$var_name
    if [ -z "$val" ]; then
      echo "ERROR: Failed to parse $var_name from deploy output"
      exit 1
    fi
  done

  whitelist_tokens "$SETTLEMENT" "$WETH" "$USDC"

  # Register Anvil Account #1 as zk-relayer (Account #0 is registered by DeployLocal)
  ZK_RELAYER_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
  echo "Registering zk-relayer (Account #1)..."
  cast send "$RELAYER_REGISTRY" "register(string,uint256)" "http://localhost:3002" 30 \
    --private-key "$ZK_RELAYER_KEY" --rpc-url "$RPC_URL" 2>/dev/null || true

  cat > "$OUTPUT_FILE" <<EOF
SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
# MockToken uses default ERC20 decimals (18). Real USDC uses 6.
NEXT_PUBLIC_TOKENS=$WETH:WETH:18,$USDC:USDC:18
NEXT_PUBLIC_WETH_ADDRESS=$WETH
COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002
EOF

fi

echo ""
echo "=== Addresses written to $OUTPUT_FILE ==="
cat "$OUTPUT_FILE"
