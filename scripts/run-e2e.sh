#!/bin/bash
set -e

echo "=== ScatterDEX Full E2E Test ==="
echo ""

# Default addresses from DeployLocal.s.sol on anvil
SETTLEMENT="${SETTLEMENT_ADDRESS:-0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9}"
WETH="${WETH_ADDRESS:-0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9}"
USDC="${USDC_ADDRESS:-0x5FC8d32690cc91D4c39d9d3abcBD16989F875707}"
RPC="${RPC_URL:-http://localhost:8545}"
RELAYER="${RELAYER_URL:-http://localhost:3001}"

echo "Step 1: Check anvil..."
if ! curl -s $RPC -X POST -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
  echo "  ERROR: anvil not running at $RPC"
  echo "  Start with: anvil"
  exit 1
fi
echo "  OK"

echo ""
echo "Step 2: Check relayer..."
if ! curl -s $RELAYER/api/info > /dev/null 2>&1; then
  echo "  ERROR: relayer not running at $RELAYER"
  echo "  Start with: cd relayer && npm run dev"
  exit 1
fi
echo "  OK — $(curl -s $RELAYER/api/info | python3 -c 'import sys,json; d=json.load(sys.stdin); print(f"fee={d[\"fee\"]}bps, orders={d[\"orderCount\"]}")')"

echo ""
echo "Step 3: Run Foundry E2E tests..."
cd contracts
forge test --match-path test/E2ELocal.t.sol -v
cd ..

echo ""
echo "Step 4: Run relayer integration tests..."
cd relayer
SETTLEMENT_ADDRESS=$SETTLEMENT \
WETH_ADDRESS=$WETH \
USDC_ADDRESS=$USDC \
RPC_URL=$RPC \
RELAYER_URL=$RELAYER \
npm run test:e2e
cd ..

echo ""
echo "=== ALL E2E TESTS PASSED ==="
