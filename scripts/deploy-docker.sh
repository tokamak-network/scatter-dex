#!/bin/bash
# Deploy ScatterDEX contracts and write addresses to shared volume.
# Used by docker-compose deployer service.
set -euo pipefail

RPC_URL="${RPC_URL:-http://anvil:8545}"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
DEPLOYER_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
OUTPUT_FILE="/shared/addresses.env"

echo "Waiting for RPC at $RPC_URL..."
until cast block-number --rpc-url "$RPC_URL" > /dev/null 2>&1; do
  sleep 1
done
echo "RPC is ready."

cd /contracts

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

  # Register deployer as relayer
  cast send "$RELAYER_REGISTRY" "register(string,uint256)" "http://relayer:3001" 30 \
    --value 0.1ether --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL" || true

  cat > "$OUTPUT_FILE" <<EOF
SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
IDENTITY_REGISTRY=$IDENTITY_REGISTRY
EOF

else
  # ── Mock mode: deploy everything including MockIdentityRegistry ──
  echo "Mode: MOCK (standalone)"

  DEPLOY_OUTPUT=$(forge script script/DeployLocal.s.sol:DeployLocal \
    --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)

  echo "$DEPLOY_OUTPUT"

  SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "ScatterSettlement:" | awk '{print $NF}')
  RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "RelayerRegistry:" | awk '{print $NF}')
  WETH=$(echo "$DEPLOY_OUTPUT" | grep "WETH:" | awk '{print $NF}')
  USDC=$(echo "$DEPLOY_OUTPUT" | grep "USDC:" | awk '{print $NF}')

  # Whitelist tokens
  cast send "$SETTLEMENT" "setTokenWhitelist(address,bool)" "$WETH" true \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL"
  cast send "$SETTLEMENT" "setTokenWhitelist(address,bool)" "$USDC" true \
    --private-key "$DEPLOYER_KEY" --rpc-url "$RPC_URL"

  cat > "$OUTPUT_FILE" <<EOF
SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
NEXT_PUBLIC_TOKEN_LIST=$WETH,$USDC
EOF

fi

echo ""
echo "=== Addresses written to $OUTPUT_FILE ==="
cat "$OUTPUT_FILE"
