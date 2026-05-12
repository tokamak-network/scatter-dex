#!/usr/bin/env bash
#
# Full E2E sweep — orchestrates the three working TS E2E scripts in
# `zk-relayer/test/` against a running local stack. Replaces the
# previous version which referenced a now-non-existent `relayer/`
# directory and a deleted `E2ELocal.t.sol`.
#
# Prerequisites — boot the stack first (any of):
#   ./scripts/start-e2e-env.sh                 # CI-grade, non-interactive
#   SKIP_CIRCUIT_BUILD=1 ./scripts/dev.sh --mock
#
# Then run:
#   ./scripts/run-e2e.sh                       # full sweep
#   ./scripts/run-e2e.sh --skip-cross-relayer  # only single-relayer flows
#
# Each scenario is exit-code gated; the wrapper returns the count of
# failed scenarios (0 on full pass).
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

RPC=${RPC_URL:-http://localhost:8545}
RELAYER_A=${RELAYER_A_URL:-http://localhost:3002}

SKIP_CROSS=0
for arg in "$@"; do
    case "$arg" in
        --skip-cross-relayer) SKIP_CROSS=1 ;;
        -h|--help) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown arg: $arg"; exit 2 ;;
    esac
done

# Pre-flight: anvil + relayer A reachable
if ! curl -fsS -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    --max-time 3 "$RPC" >/dev/null 2>&1; then
    echo "ERROR: anvil not reachable at $RPC"
    echo "  Boot the stack first: ./scripts/start-e2e-env.sh"
    exit 2
fi
if ! curl -fsS "$RELAYER_A/api/info" --max-time 3 >/dev/null 2>&1; then
    echo "ERROR: relayer A not reachable at $RELAYER_A"
    exit 2
fi

# Resolve canonical addresses from the latest broadcast — works regardless
# of whether `dev.sh` or `start-e2e-env.sh` was the boot route.
BCAST="$ROOT_DIR/contracts/broadcast/DeployLocal.s.sol/31337/run-latest.json"
if [ ! -f "$BCAST" ]; then
    echo "ERROR: deploy broadcast missing: $BCAST"
    exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
    echo "ERROR: jq required to parse broadcast"
    exit 2
fi

read_proxy_after() {
    jq -r --arg N "$1" '
      [.transactions[] | select(.contractAddress != null)]
      | (map(.contractName) | index($N)) as $i
      | .[$i + 1] // {}
      | .contractAddress // ""
    ' "$BCAST"
}
read_token() {
    jq -r --arg N "$1" '
      [.transactions[] | select(.contractName == $N) | .contractAddress] | .[0] // ""
    ' "$BCAST"
}

POOL=$(read_proxy_after CommitmentPool)
SETTLE=$(read_proxy_after PrivateSettlement)
# DeployLocal mints MockTokens in order: USDC (idx 0), USDT, TON.
# Pick by constructor arg `symbol == "USDC"` to be order-independent.
USDC=$(jq -r '
  [.transactions[] | select(.contractName == "MockToken" and .arguments[1] == "USDC") | .contractAddress] | .[0] // ""
' "$BCAST")

echo "=== ScatterDEX Full E2E Sweep ==="
echo "  RPC:        $RPC"
echo "  Pool:       $POOL"
echo "  Settlement: $SETTLE"
echo "  USDC:       $USDC"
echo ""

declare -a SCENARIOS=(
    "market-order:e2e-market-order.ts"
    "scatter-direct-auth:e2e-scatter-direct-auth.ts"
)
if [ $SKIP_CROSS -eq 0 ]; then
    SCENARIOS+=("authorize-cross-relayer:e2e-authorize-cross-relayer.ts")
fi

PASS=0; FAIL=0
FAILED=()

for entry in "${SCENARIOS[@]}"; do
    label="${entry%%:*}"
    script="${entry##*:}"
    echo "── scenario: $label ──"
    if (cd zk-relayer && \
        E2E_USDC_ADDRESS="$USDC" \
        E2E_POOL_ADDRESS="$POOL" \
        E2E_SETTLEMENT_ADDRESS="$SETTLE" \
        npx tsx "test/$script"); then
        echo "  ✓ $label PASSED"
        PASS=$((PASS+1))
    else
        echo "  ✗ $label FAILED"
        FAIL=$((FAIL+1))
        FAILED+=("$label")
    fi
    echo ""
done

echo "=== Summary ==="
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
if [ "$FAIL" -gt 0 ]; then
    echo "Failed scenarios:"
    for s in "${FAILED[@]}"; do echo "  · $s"; done
fi
exit "$FAIL"
