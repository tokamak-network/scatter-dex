#!/bin/bash
# Non-interactive E2E environment bring-up for CI.
#
# Brings up: anvil → DeployLocal (mock IdentityRegistry) → shared OB
# (port 4000) → Relayer A (3002) → Relayer B (3003) → registers Relayer B
# on RelayerRegistry. Writes background PIDs to `.e2e-pids` and exits 0
# once everything is reachable. Companion `stop-e2e-env.sh` tears it down.
#
# Differs from `dev.sh --mock` + `start-cross-relayer-e2e.sh`:
#   - No EXIT/SIGINT trap killing background services (CI runs the next
#     step against this same env).
#   - No trailing `wait` (the script must exit so CI can move on).
#   - Skips circuit build — CI handles that with caching upstream.
#
# Prerequisites (CI installs these; honoured via PATH):
#   - foundry (forge, anvil, cast)
#   - node 20 + npm install in shared-orderbook/ and zk-relayer/
#   - circuits/build/ already populated (Verifier.sol + zkeys + wasm)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT_DIR/.e2e-logs"
PID_FILE="$ROOT_DIR/.e2e-pids"
mkdir -p "$LOG_DIR"
: > "$PID_FILE"

DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
RELAYER_A_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"  # anvil #1
RELAYER_B_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"  # anvil #2
RELAYER_B_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"  # cast-derived from RELAYER_B_KEY; needed for isActiveRelayer() check below
RPC_URL="${RPC_URL:-http://localhost:8545}"

record_pid() { echo "$1" >> "$PID_FILE"; }

wait_for() {
  local url="$1" name="$2" max="${3:-30}" i=0
  while [ "$i" -lt "$max" ]; do
    if curl -fsS "$url" -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' > /dev/null 2>&1; then
      return 0
    fi
    if curl -fsS "$url" > /dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "  ERROR: $name failed to start (waited ${max}s)"
  return 1
}

echo "=== ScatterDEX E2E env (CI) ==="

# ── 1. anvil ────────────────────────────────────────────────
echo ""
echo "[1/5] Starting anvil..."
anvil --silent --hardfork prague > "$LOG_DIR/anvil.log" 2>&1 &
record_pid $!
wait_for "$RPC_URL" "anvil" 15 || { tail -30 "$LOG_DIR/anvil.log"; exit 1; }
echo "  [ok] anvil on $RPC_URL"

# ── 2. Deploy contracts ─────────────────────────────────────
echo ""
echo "[2/5] Deploying contracts (DeployLocal, mock identity)..."
cd "$ROOT_DIR/contracts"
# `set +e` window matches dev.sh: forge can exit non-zero on benign
# stdout-not-a-terminal / contract-size warnings even when the deploy
# succeeded. Surface anything else.
set +e
DEPLOY_OUTPUT=$(NO_COLOR=1 forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)
DEPLOY_STATUS=$?
set -e
if [ "$DEPLOY_STATUS" -ne 0 ] \
    && ! echo "$DEPLOY_OUTPUT" | grep -qE "Contract size|contract size|not a terminal|runtime size limit"; then
  echo "  ERROR: forge script failed (exit $DEPLOY_STATUS):"
  echo "$DEPLOY_OUTPUT"
  exit 1
fi

# Proxy migration changed the deploy log: each upgradeable contract now
# prints `Name impl: <addr>` + `Name proxy: <addr>` (apps consume the proxy).
# Non-upgradeable contracts (WETH, USDC, ...) still use the bare `Name: <addr>`
# form. Prefer `proxy:` when present; fall back to the bare label otherwise.
parse_addr() {
    local addr
    addr=$(echo "$DEPLOY_OUTPUT" | grep "^  $1 proxy:" | head -1 | awk '{print $NF}')
    if [ -z "$addr" ]; then
        addr=$(echo "$DEPLOY_OUTPUT" | grep "^  $1:" | head -1 | awk '{print $NF}')
    fi
    echo "$addr"
}
RELAYER_REGISTRY=$(parse_addr RelayerRegistry)
WETH=$(parse_addr WETH)
USDC=$(parse_addr USDC)
COMMITMENT_POOL=$(parse_addr CommitmentPool)
PRIVATE_SETTLEMENT=$(parse_addr PrivateSettlement)
FEE_VAULT=$(parse_addr FeeVault)

for var in RELAYER_REGISTRY WETH USDC COMMITMENT_POOL PRIVATE_SETTLEMENT FEE_VAULT; do
  if [ -z "${!var}" ]; then
    echo "  ERROR: missing $var in deploy output"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi
done
echo "  [ok] deployed (CommitmentPool=$COMMITMENT_POOL)"

# ── 3. Shared orderbook ─────────────────────────────────────
echo ""
echo "[3/5] Starting shared-orderbook (port 4000)..."
cd "$ROOT_DIR/shared-orderbook"
PORT=4000 ALLOW_PRIVATE_RELAYER_URLS=1 npm run dev > "$LOG_DIR/orderbook.log" 2>&1 &
record_pid $!
wait_for "http://localhost:4000/health" "shared-orderbook" 30 \
  || { tail -30 "$LOG_DIR/orderbook.log"; exit 1; }
echo "  [ok] orderbook on :4000"

# ── 4. Relayer A & B ────────────────────────────────────────
start_relayer() {
  local name="$1" port="$2" key="$3" db="$4" log="$5"
  cd "$ROOT_DIR/zk-relayer"
  RPC_URL="$RPC_URL" \
  RELAYER_PRIVATE_KEY="$key" \
  COMMITMENT_POOL_ADDRESS="$COMMITMENT_POOL" \
  PRIVATE_SETTLEMENT_ADDRESS="$PRIVATE_SETTLEMENT" \
  FEE_VAULT_ADDRESS="$FEE_VAULT" \
  PORT="$port" \
  RELAYER_FEE=30 \
  DB_PATH="$ROOT_DIR/zk-relayer/$db" \
  SHARED_ORDERBOOK_URL="http://localhost:4000" \
  RELAYER_PUBLIC_URL="http://localhost:$port" \
  RELAYER_NAME="$name" \
  ALLOW_PRIVATE_RELAYER_URLS=1 npm run dev > "$LOG_DIR/$log" 2>&1 &
  record_pid $!
  wait_for "http://localhost:$port/api/info" "$name" 30 \
    || { tail -30 "$LOG_DIR/$log"; return 1; }
  echo "  [ok] $name on :$port"
}

echo ""
echo "[4/5] Starting Relayer A & B..."
# Fresh DBs each CI run so prior state never leaks across invocations.
# Glob also catches SQLite WAL/SHM sidecar files (`-wal`/`-shm`) that
# can otherwise retain in-flight state across reruns on the same runner.
rm -f "$ROOT_DIR/zk-relayer/zk-relayer"*.db*
start_relayer "Relayer-A" 3002 "$RELAYER_A_KEY" "zk-relayer.db"   "relayer-a.log"
start_relayer "Relayer-B" 3003 "$RELAYER_B_KEY" "zk-relayer-b.db" "relayer-b.log"

# ── 5. Register Relayer B on-chain ──────────────────────────
# Must succeed: PrivateSettlement.settleAuth gates on
# RelayerRegistry.isActiveRelayer() for both maker and taker relayers.
# A silently-skipped registration would surface only as an opaque
# `NotActiveRelayer` revert in the e2e test, so fail fast here instead.
echo ""
echo "[5/5] Registering Relayer B on RelayerRegistry..."
if cast call "$RELAYER_REGISTRY" "isActiveRelayer(address)(bool)" "$RELAYER_B_ADDR" \
    --rpc-url "$RPC_URL" 2>/dev/null | grep -q true; then
  echo "  [ok] already active"
else
  # `register` signature post-RelayerRegistry proxy migration is
  # (url, name, fee, bondAmount). minBond defaults to 0 in MOCK mode so
  # bondAmount=0 and msg.value=0 both satisfy `_pullBond`.
  if ! cast send "$RELAYER_REGISTRY" "register(string,string,uint256,uint256)" \
      "http://localhost:3003" "Relayer-B" 30 0 \
      --private-key "$RELAYER_B_KEY" --rpc-url "$RPC_URL" > /dev/null 2>&1; then
    echo "  ERROR: register() failed"
    exit 1
  fi
  if ! cast call "$RELAYER_REGISTRY" "isActiveRelayer(address)(bool)" "$RELAYER_B_ADDR" \
      --rpc-url "$RPC_URL" 2>/dev/null | grep -q true; then
    echo "  ERROR: register() returned ok but isActiveRelayer() is still false"
    exit 1
  fi
  echo "  [ok] Relayer B registered + active"
fi

echo ""
echo "READY"
echo "  COMMITMENT_POOL=$COMMITMENT_POOL"
echo "  PRIVATE_SETTLEMENT=$PRIVATE_SETTLEMENT"
echo "  FEE_VAULT=$FEE_VAULT"
echo "  USDC=$USDC"
echo "  WETH=$WETH"
echo "  PIDs: $(tr '\n' ' ' < "$PID_FILE")"

# Propagate deployed addresses to the GitHub Actions env so downstream
# steps don't have to hardcode them. No-op outside CI (unset $GITHUB_ENV).
if [ -n "$GITHUB_ENV" ]; then
  {
    echo "E2E_USDC_ADDRESS=$USDC"
    echo "E2E_WETH_ADDRESS=$WETH"
    echo "E2E_COMMITMENT_POOL=$COMMITMENT_POOL"
    echo "E2E_PRIVATE_SETTLEMENT=$PRIVATE_SETTLEMENT"
    echo "E2E_FEE_VAULT=$FEE_VAULT"
  } >> "$GITHUB_ENV"
fi
