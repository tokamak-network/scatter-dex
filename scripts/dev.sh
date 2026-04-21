#!/bin/bash
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.dev-logs"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
# Hardhat Account #1 — used for zk-relayer (separate identity)
ZK_RELAYER_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
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
  while true; do
    # Try JSON-RPC POST first (for anvil), then plain GET (for relayer/frontend)
    if curl -fsS "$url" -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' > /dev/null 2>&1; then
      break
    fi
    if curl -fsS "$url" > /dev/null 2>&1; then
      break
    fi
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
  # Only fail on an actual LISTEN socket; ignore browser-side CLOSE_WAIT
  # connections (e.g. MetaMask's lingering localhost:8545 socket) that
  # aren't actually holding the port.
  if lsof -iTCP:"$port" -sTCP:LISTEN > /dev/null 2>&1; then
    echo "ERROR: port $port is already in use ($name). Kill the existing process first."
    exit 1
  fi
}

# Create log directory
mkdir -p "$LOG_DIR"

# Always rebuild Groth16 verifiers + zkeys before deploy. Each phase-2
# setup emits different vkey constants, and the only way to guarantee
# zkey ↔ Verifier.sol consistency (no InvalidProof at runtime) is to
# regenerate them in one atomic build. The generated Verifier.sol files
# are gitignored for this reason.
#
# Set SKIP_CIRCUIT_BUILD=1 to bypass when you know nothing changed since
# the last build (saves ~30s+ on the settle phase-2).
ensure_circuits_built() {
  if [ "${SKIP_CIRCUIT_BUILD:-0}" = "1" ]; then
    echo "  SKIP_CIRCUIT_BUILD=1 — using existing zkeys + Verifier.sol."
    return
  fi
  echo "  Building circuits (regenerates zkeys + Verifier.sol — first run is slow)..."
  # `if !` instead of post-hoc `$?` check so the failure is caught even
  # under `set -e` (which would otherwise abort before the diagnostic runs).
  if ! ( cd "$ROOT_DIR/circuits" && npm run build ) > "$LOG_DIR/circuit-build.log" 2>&1; then
    echo "  ERROR: circuit build failed. Tail of $LOG_DIR/circuit-build.log:"
    tail -30 "$LOG_DIR/circuit-build.log" 2>/dev/null
    exit 1
  fi
  echo "  Circuits built."
}

echo "=== ScatterDEX Local Dev Environment ==="
echo ""

if [ "$MOCK_MODE" = true ]; then
  # ── Mock mode: standalone with MockIdentityRegistry ─────────
  echo "Mode: MOCK (standalone, no zk-X509)"
  echo ""

  check_port 8545 "anvil"
  check_port 3002 "zk-relayer"
  check_port 3000 "frontend"

  echo "[1/4] Starting anvil (hardfork=prague for EIP-7702)..."
  # `--hardfork prague` enables Pectra-era features — notably EIP-7702
  # batch delegation, which the frontend uses to collapse the deposit
  # popup chain into one tx when the wallet supports it.
  anvil --silent --hardfork prague &
  last_pid=$!
  PIDS+=("$last_pid")
  if ! wait_for "$RPC_URL" "anvil" 10; then
    exit 1
  fi
  echo "  anvil running on $RPC_URL (PID $last_pid)"

  echo ""
  echo "[2/4] Deploying contracts (MockIdentityRegistry)..."
  ensure_circuits_built
  cd "$ROOT_DIR/contracts"
  # `forge script` can exit non-zero even when the on-chain deployment
  # succeeded — e.g. `Error: IO error: not a terminal` under captured
  # stdout, or contract-size warnings when a contract exceeds EIP-170 on
  # networks with that limit (anvil deploys fine regardless). Suppress
  # `set -e` only for those known-benign cases; surface any other failure.
  set +e
  DEPLOY_OUTPUT=$(forge script script/DeployLocal.s.sol:DeployLocal \
    --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)
  DEPLOY_STATUS=$?
  set -e
  if [ "$DEPLOY_STATUS" -ne 0 ] \
      && ! echo "$DEPLOY_OUTPUT" | grep -qE "Contract size|contract size|not a terminal|runtime size limit"; then
    echo "  ERROR: forge script failed (exit $DEPLOY_STATUS):"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

  RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "^  RelayerRegistry:" | awk '{print $NF}')
  WETH=$(echo "$DEPLOY_OUTPUT" | grep "^  WETH:" | awk '{print $NF}')
  USDC=$(echo "$DEPLOY_OUTPUT" | grep "^  USDC:" | awk '{print $NF}')
  COMMITMENT_POOL=$(echo "$DEPLOY_OUTPUT" | grep "^  CommitmentPool:" | awk '{print $NF}')
  PRIVATE_SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "^  PrivateSettlement:" | awk '{print $NF}')
  IDENTITY_GATE=$(echo "$DEPLOY_OUTPUT" | grep "^  IdentityGate:" | awk '{print $NF}')
  FEE_VAULT=$(echo "$DEPLOY_OUTPUT" | grep "^  FeeVault:" | awk '{print $NF}')
  BATCH_EXECUTOR=$(echo "$DEPLOY_OUTPUT" | grep "^  BatchExecutor:" | awk '{print $NF}')

  if [ -z "$RELAYER_REGISTRY" ] || [ -z "$WETH" ] || [ -z "$USDC" ] || [ -z "$COMMITMENT_POOL" ] || [ -z "$PRIVATE_SETTLEMENT" ] || [ -z "$IDENTITY_GATE" ] || [ -z "$FEE_VAULT" ]; then
    echo "  ERROR: deployment failed (missing one or more contract addresses)"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

  # zk-relayer registration is handled by DeployLocal.s.sol (Account #1)

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

  check_port 3002 "zk-relayer"
  check_port 3000 "frontend"

  # Helper: prompt for a registry address if not set, verify contract exists
  require_registry() {
    local var_name="$1" prompt_text="$2" error_hint="$3"
    eval "local val=\$$var_name"

    if [ -z "$val" ]; then
      echo ""
      echo "  $var_name not set."
      echo "  $prompt_text"
      read -r -p "  > " val
      eval "$var_name=\"$val\""
    fi

    if [ -z "$val" ]; then
      echo "  ERROR: $var_name is required in integration mode."
      echo "  Usage: IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x... $0"
      echo "  Or use: $0 --mock"
      exit 1
    fi

    CODE=$(cast code "$val" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")
    if [ "$CODE" = "0x" ]; then
      echo "  ERROR: No contract found at $val"
      echo "  $error_hint"
      exit 1
    fi
  }

  require_registry "IDENTITY_REGISTRY" \
    "Enter the zk-X509 User CA IdentityRegistry proxy address:" \
    "Deploy zk-X509 contracts first."
  echo "  IdentityRegistry (User CA):    $IDENTITY_REGISTRY"

  require_registry "RELAYER_IDENTITY_REGISTRY" \
    "Enter the zk-X509 Relayer CA IdentityRegistry proxy address:" \
    "Deploy zk-X509 Relayer CA registry first."
  echo "  IdentityRegistry (Relayer CA): $RELAYER_IDENTITY_REGISTRY"

  echo ""
  echo "[2/4] Deploying contracts (real IdentityGate)..."
  ensure_circuits_built
  cd "$ROOT_DIR/contracts"

  # See MOCK branch: suppress `set -e` only for known-benign forge exits.
  set +e
  DEPLOY_OUTPUT=$(IDENTITY_REGISTRY="$IDENTITY_REGISTRY" \
    RELAYER_IDENTITY_REGISTRY="$RELAYER_IDENTITY_REGISTRY" \
    forge script script/DeployLocal.s.sol:DeployLocal \
    --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)
  DEPLOY_STATUS=$?
  set -e
  if [ "$DEPLOY_STATUS" -ne 0 ] \
      && ! echo "$DEPLOY_OUTPUT" | grep -qE "Contract size|contract size|not a terminal|runtime size limit"; then
    echo "  ERROR: forge script failed (exit $DEPLOY_STATUS):"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

  RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "RelayerRegistry:" | awk '{print $NF}')
  COMMITMENT_POOL=$(echo "$DEPLOY_OUTPUT" | grep "CommitmentPool:" | awk '{print $NF}')
  PRIVATE_SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "PrivateSettlement:" | awk '{print $NF}')
  IDENTITY_GATE=$(echo "$DEPLOY_OUTPUT" | grep "IdentityGate:" | awk '{print $NF}')
  FEE_VAULT=$(echo "$DEPLOY_OUTPUT" | grep "FeeVault:" | awk '{print $NF}')

  if [ -z "$RELAYER_REGISTRY" ] || [ -z "$COMMITMENT_POOL" ] || [ -z "$PRIVATE_SETTLEMENT" ] || [ -z "$IDENTITY_GATE" ] || [ -z "$FEE_VAULT" ]; then
    echo "  ERROR: deployment failed (missing contract addresses)"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

  # No test tokens in integration mode
  WETH=""
  USDC=""
fi

echo "  RelayerRegistry:     $RELAYER_REGISTRY"
[ -n "$WETH" ] && echo "  WETH:                $WETH"
[ -n "$USDC" ] && echo "  USDC:                $USDC"
[ -n "$COMMITMENT_POOL" ] && echo "  CommitmentPool:      $COMMITMENT_POOL"
[ -n "$PRIVATE_SETTLEMENT" ] && echo "  PrivateSettlement:   $PRIVATE_SETTLEMENT"

# ── 3. Start zk-relayer ─────────────────────────────────────
echo ""
echo "[3/4] Starting zk-relayer..."
if [ -n "$COMMITMENT_POOL" ] && [ -n "$PRIVATE_SETTLEMENT" ]; then
  ADMIN_KEY="dev-admin-$(head -c 16 /dev/urandom | xxd -p)"
  cat > "$ROOT_DIR/zk-relayer/.env" << EOF
RPC_URL=$RPC_URL
RELAYER_PRIVATE_KEY=$ZK_RELAYER_KEY
COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
FEE_VAULT_ADDRESS=$FEE_VAULT
TOKEN_LIST=$WETH:WETH:18,$USDC:USDC:18
ADMIN_API_KEY=$ADMIN_KEY
RELAYER_FEE=30
PORT=3002
EOF
  echo "  Admin API key: $ADMIN_KEY"

  cd "$ROOT_DIR/zk-relayer"
  npm run dev > "$LOG_DIR/zk-relayer.log" 2>&1 &
  last_pid=$!
  PIDS+=("$last_pid")
  if ! wait_for "http://localhost:3002/api/info" "zk-relayer" 30; then
    echo "  Last 20 lines of zk-relayer log:"
    tail -20 "$LOG_DIR/zk-relayer.log" 2>/dev/null
    exit 1
  fi
  echo "  zk-relayer running on http://localhost:3002 (PID $last_pid)"
else
  echo "  ERROR: ZK contracts not deployed (missing CommitmentPool or PrivateSettlement)"
  exit 1
fi

# ── 4. Start frontend ──────────────────────────────────────
echo ""
echo "[4/4] Starting frontend..."
TOKENS=""
[ -n "$WETH" ] && [ -n "$USDC" ] && TOKENS="$WETH:WETH:18,$USDC:USDC:18"

# Preserve user-provided secrets (non-deployment env vars) across regeneration.
# The deploy-driven NEXT_PUBLIC_* keys are overwritten on every run, but keys
# like ONEINCH_API_KEY belong to the developer, not the deployment.
PRESERVED_ENV=""
if [ -f "$ROOT_DIR/frontend/.env.local" ]; then
  PRESERVED_ENV=$(grep -E '^(ONEINCH_API_KEY|CSP_EXTRA_CONNECT_SRC|NEXT_PUBLIC_MAINNET_RPC)=' "$ROOT_DIR/frontend/.env.local" || true)
fi

cat > "$ROOT_DIR/frontend/.env.local" << EOF
NEXT_PUBLIC_RPC_URL=$RPC_URL
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
NEXT_PUBLIC_WETH_ADDRESS=$WETH
NEXT_PUBLIC_TOKENS=$TOKENS
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=$IDENTITY_GATE
NEXT_PUBLIC_FEE_VAULT_ADDRESS=$FEE_VAULT
NEXT_PUBLIC_BATCH_EXECUTOR_ADDRESS=$BATCH_EXECUTOR
NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002
NEXT_PUBLIC_SHARED_ORDERBOOK_URL=http://localhost:4000
EOF

if [ -n "$PRESERVED_ENV" ]; then
  echo "$PRESERVED_ENV" >> "$ROOT_DIR/frontend/.env.local"
fi

# Mobile reads its per-chain contract map from
# mobile/src/config/fork-contracts.json (gitignored). Regenerate it
# alongside the frontend env so either dev script gives both clients
# the same deployment in one shot. Expo's Fast Refresh picks the JSON
# up on the next import without a rebuild.
mkdir -p "$ROOT_DIR/mobile/src/config"
cat > "$ROOT_DIR/mobile/src/config/fork-contracts.json" << EOF
{
  "31337": {
    "rpcUrl": "$RPC_URL",
    "weth": "$WETH",
    "commitmentPool": "$COMMITMENT_POOL",
    "privateSettlement": "$PRIVATE_SETTLEMENT",
    "identityGate": "$IDENTITY_GATE",
    "relayerRegistry": "$RELAYER_REGISTRY",
    "feeVault": "$FEE_VAULT",
    "batchExecutor": "$BATCH_EXECUTOR",
    "relayerUrl": "http://localhost:3002",
    "sharedOrderbookUrl": "http://localhost:4000",
    "tokens": [
      { "address": "$USDC", "symbol": "USDC", "decimals": 18 }
    ]
  }
}
EOF
echo "  Wrote mobile contracts to mobile/src/config/fork-contracts.json (chain 31337)"

# Mobile's ZK circuit artifacts (mobile/assets/zk/*.zkey|wasm) must match
# the verifiers the just-deployed contracts reference. `copy:circuits`
# is idempotent and skips unchanged files.
if [ -d "$ROOT_DIR/mobile" ]; then
  (cd "$ROOT_DIR/mobile" && npm run copy:circuits) \
    && echo "  Synced mobile ZK assets from circuits/build/" \
    || echo "  WARN: failed to copy mobile ZK assets (proofs may fail to verify)"
fi

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
echo "  Frontend:    http://localhost:3000"
echo "  ZK Relayer:  http://localhost:3002"
echo "  Anvil:       $RPC_URL"
echo ""
echo "  RelayerRegistry:     $RELAYER_REGISTRY"
[ -n "$WETH" ] && echo "  WETH:                $WETH"
[ -n "$USDC" ] && echo "  USDC:                $USDC"
[ -n "$COMMITMENT_POOL" ] && echo "  CommitmentPool:      $COMMITMENT_POOL"
[ -n "$PRIVATE_SETTLEMENT" ] && echo "  PrivateSettlement:   $PRIVATE_SETTLEMENT"
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
