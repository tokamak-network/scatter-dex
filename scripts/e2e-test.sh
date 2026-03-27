#!/bin/bash
set -e

echo "=== ScatterDEX E2E Test Scenarios ==="
echo ""

RPC_URL="http://localhost:8545"

# Anvil default accounts
ALICE_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
ALICE="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
BOB_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
BOB="0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
RELAYER_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
RELAYER="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
RECIPIENT_KEY="0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
RECIPIENT="0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"

cd contracts

# Read deployed addresses from broadcast
SETTLEMENT=$(cat broadcast/DeployLocal.s.sol/31337/run-latest.json | python3 -c "import sys,json; txs=json.load(sys.stdin)['transactions']; [print(t['contractAddress']) for t in txs if t.get('contractName')=='ScatterSettlement']" 2>/dev/null || echo "")
RELAYER_REGISTRY=$(cat broadcast/DeployLocal.s.sol/31337/run-latest.json | python3 -c "import sys,json; txs=json.load(sys.stdin)['transactions']; [print(t['contractAddress']) for t in txs if t.get('contractName')=='RelayerRegistry']" 2>/dev/null || echo "")
WETH=$(cat broadcast/DeployLocal.s.sol/31337/run-latest.json | python3 -c "import sys,json; txs=json.load(sys.stdin)['transactions']; [print(t['contractAddress']) for t in txs if t.get('contractName')=='MockToken' and t.get('arguments') and 'WETH' in str(t['arguments'])]" 2>/dev/null || echo "")
USDC=$(cat broadcast/DeployLocal.s.sol/31337/run-latest.json | python3 -c "import sys,json; txs=json.load(sys.stdin)['transactions']; [print(t['contractAddress']) for t in txs if t.get('contractName')=='MockToken' and t.get('arguments') and 'USDC' in str(t['arguments'])]" 2>/dev/null || echo "")

if [ -z "$SETTLEMENT" ]; then
  echo "ERROR: Contracts not deployed. Run scripts/local-e2e.sh first."
  exit 1
fi

echo "Contracts:"
echo "  Settlement: $SETTLEMENT"
echo "  RelayerRegistry: $RELAYER_REGISTRY"
echo "  WETH: $WETH"
echo "  USDC: $USDC"
echo ""

PASS=0
FAIL=0

run_test() {
  local name="$1"
  local cmd="$2"
  echo -n "  [$name] "
  if eval "$cmd" > /dev/null 2>&1; then
    echo "✓ PASS"
    PASS=$((PASS + 1))
  else
    echo "✗ FAIL"
    FAIL=$((FAIL + 1))
  fi
}

# ============================================================
echo "--- Scenario 1: Relayer Registration ---"
# ============================================================

# Register a new relayer
run_test "Register relayer" \
  "cast send $RELAYER_REGISTRY 'register(string,uint256)' 'http://localhost:3001' 30 --value 0.1ether --private-key $RELAYER_KEY --rpc-url $RPC_URL"

# Verify relayer is active
run_test "Relayer is active" \
  "cast call $RELAYER_REGISTRY 'isActiveRelayer(address)(bool)' $RELAYER --rpc-url $RPC_URL | grep -q true"

# Get relayer count
run_test "Relayer count >= 2" \
  "test \$(cast call $RELAYER_REGISTRY 'getRelayerCount()(uint256)' --rpc-url $RPC_URL | tr -d '[:space:]') -ge 2"

echo ""

# ============================================================
echo "--- Scenario 2: Alice Deposits WETH ---"
# ============================================================

# Approve + deposit
run_test "Alice approves WETH" \
  "cast send $WETH 'approve(address,uint256)' $SETTLEMENT 100000000000000000000 --private-key $ALICE_KEY --rpc-url $RPC_URL"

run_test "Alice deposits 10 WETH" \
  "cast send $SETTLEMENT 'deposit(address,uint256)' $WETH 10000000000000000000 --private-key $ALICE_KEY --rpc-url $RPC_URL"

# Check escrow balance
run_test "Alice escrow = 10 WETH" \
  "test \$(cast call $SETTLEMENT 'deposits(address,address)(uint256)' $ALICE $WETH --rpc-url $RPC_URL | tr -d '[:space:]') = 10000000000000000000"

echo ""

# ============================================================
echo "--- Scenario 3: Bob Deposits USDC ---"
# ============================================================

run_test "Bob approves USDC" \
  "cast send $USDC 'approve(address,uint256)' $SETTLEMENT 100000000000000000000000 --private-key $BOB_KEY --rpc-url $RPC_URL"

run_test "Bob deposits 21000 USDC" \
  "cast send $SETTLEMENT 'deposit(address,uint256)' $USDC 21000000000000000000000 --private-key $BOB_KEY --rpc-url $RPC_URL"

run_test "Bob escrow = 21000 USDC" \
  "test \$(cast call $SETTLEMENT 'deposits(address,address)(uint256)' $BOB $USDC --rpc-url $RPC_URL | tr -d '[:space:]') = 21000000000000000000000"

echo ""

# ============================================================
echo "--- Scenario 4: Alice Withdraws Partial ---"
# ============================================================

run_test "Alice withdraws 2 WETH" \
  "cast send $SETTLEMENT 'withdraw(address,uint256)' $WETH 2000000000000000000 --private-key $ALICE_KEY --rpc-url $RPC_URL"

run_test "Alice escrow = 8 WETH" \
  "test \$(cast call $SETTLEMENT 'deposits(address,address)(uint256)' $ALICE $WETH --rpc-url $RPC_URL | tr -d '[:space:]') = 8000000000000000000"

echo ""

# ============================================================
echo "--- Scenario 5: Cancel Order ---"
# ============================================================

run_test "Alice cancels nonce 42" \
  "cast send $SETTLEMENT 'cancelOrder(uint256)' 42 --private-key $ALICE_KEY --rpc-url $RPC_URL"

run_test "Nonce 42 consumed" \
  "cast call $SETTLEMENT 'nonces(address,uint256)(bool)' $ALICE 42 --rpc-url $RPC_URL | grep -q true"

echo ""

# ============================================================
echo "--- Scenario 6: Unverified User Blocked ---"
# ============================================================
# Anvil account #5 is not verified (but MockIdentityRegistry verifies everyone)
# Skip this test since MockIdentityRegistry accepts all

echo "  [Skipped - MockIdentityRegistry accepts all users for local testing]"
echo ""

# ============================================================
echo "--- Scenario 7: Relayer Exit Flow ---"
# ============================================================

# Request exit
run_test "Relayer requests exit" \
  "cast send $RELAYER_REGISTRY 'requestExit()' --private-key $RELAYER_KEY --rpc-url $RPC_URL"

# Should no longer be active
run_test "Relayer no longer active" \
  "cast call $RELAYER_REGISTRY 'isActiveRelayer(address)(bool)' $RELAYER --rpc-url $RPC_URL | grep -q false"

# Fast forward 7 days
run_test "Warp 7 days" \
  "cast rpc anvil_increaseTime 604800 --rpc-url $RPC_URL && cast rpc anvil_mine 1 --rpc-url $RPC_URL"

# Execute exit
run_test "Relayer executes exit" \
  "cast send $RELAYER_REGISTRY 'executeExit()' --private-key $RELAYER_KEY --rpc-url $RPC_URL"

echo ""

# ============================================================
echo "--- Scenario 8: Escrow Balance Queries ---"
# ============================================================

run_test "Query Alice WETH escrow" \
  "cast call $SETTLEMENT 'deposits(address,address)(uint256)' $ALICE $WETH --rpc-url $RPC_URL"

run_test "Query Bob USDC escrow" \
  "cast call $SETTLEMENT 'deposits(address,address)(uint256)' $BOB $USDC --rpc-url $RPC_URL"

run_test "Query schedule count" \
  "cast call $SETTLEMENT 'scheduleCount()(uint256)' --rpc-url $RPC_URL"

echo ""

# ============================================================
echo "--- Scenario 9: Token Balance Checks ---"
# ============================================================

run_test "Alice WETH wallet balance" \
  "cast call $WETH 'balanceOf(address)(uint256)' $ALICE --rpc-url $RPC_URL"

run_test "Bob USDC wallet balance" \
  "cast call $USDC 'balanceOf(address)(uint256)' $BOB --rpc-url $RPC_URL"

echo ""

# ============================================================
# Summary
# ============================================================
echo "=== E2E Test Results ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
echo "  Total:  $((PASS + FAIL))"

if [ $FAIL -gt 0 ]; then
  echo ""
  echo "SOME TESTS FAILED!"
  exit 1
else
  echo ""
  echo "ALL TESTS PASSED!"
fi
