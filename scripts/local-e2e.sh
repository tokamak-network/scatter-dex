#!/bin/bash
set -e

echo "=== ScatterDEX Local E2E Setup ==="
echo ""

# Anvil default private key (account #0)
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
RPC_URL="http://localhost:8545"

# 1. Check anvil is running
echo "1. Checking anvil..."
if ! curl -s $RPC_URL -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
  echo "   anvil is not running. Start it with: anvil"
  exit 1
fi
echo "   anvil is running."

# 2. Deploy contracts
echo ""
echo "2. Deploying contracts..."
cd contracts
DEPLOY_OUTPUT=$(forge script script/DeployLocal.s.sol:DeployLocal --rpc-url $RPC_URL --broadcast --private-key $DEPLOYER_KEY 2>&1)
echo "$DEPLOY_OUTPUT" | grep -E "(MockIdentityRegistry|IdentityGate|RelayerRegistry|ScatterSettlement|WETH|USDC|registered):"

# Extract addresses
SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "ScatterSettlement:" | awk '{print $NF}')
RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "RelayerRegistry:" | awk '{print $NF}')
WETH=$(echo "$DEPLOY_OUTPUT" | grep "WETH:" | awk '{print $NF}')
USDC=$(echo "$DEPLOY_OUTPUT" | grep "USDC:" | awk '{print $NF}')
cd ..

echo ""
echo "=== Deployed Addresses ==="
echo "SETTLEMENT_ADDRESS=$SETTLEMENT"
echo "RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY"
echo "WETH=$WETH"
echo "USDC=$USDC"

# 3. Write relayer .env
echo ""
echo "3. Configuring relayer..."
cat > relayer/.env << EOF
RPC_URL=$RPC_URL
RELAYER_PRIVATE_KEY=$DEPLOYER_KEY
SETTLEMENT_ADDRESS=$SETTLEMENT
RELAYER_FEE=30
PORT=3001
EOF
echo "   relayer/.env written"

# 4. Write frontend .env.local
echo ""
echo "4. Configuring frontend..."
cat > frontend/.env.local << EOF
NEXT_PUBLIC_RPC_URL=$RPC_URL
NEXT_PUBLIC_SETTLEMENT_ADDRESS=$SETTLEMENT
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
NEXT_PUBLIC_TOKEN_LIST=$WETH,$USDC
EOF
echo "   frontend/.env.local written"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Start relayer:   cd relayer && npm run dev"
echo "  2. Start frontend:  cd frontend && npm run dev"
echo "  3. Open browser:    http://localhost:3000"
echo ""
echo "Test accounts (anvil):"
echo "  Alice: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (1000 WETH, 1M USDC)"
echo "  Bob:   0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (1000 WETH, 1M USDC)"
