#!/usr/bin/env bash
#
# Per-feature health-check sweep. Runs through every shippable feature in
# the service inventory and reports PASS / FAIL / SKIP per item, with a
# summary at the end.
#
# Designed to be cheap (no full dev.sh boot required) and incremental:
#   --static    config + file integrity (default group, always runs)
#   --unit      forge + vitest unit suites (no services needed)
#   --live      curl-based checks of running services (skipped if down)
#   --all       static + unit + live (the default when no flag)
#   --quick     static + storage-layout only (~10s)
#
# Examples:
#   scripts/feature-check.sh                  # full sweep
#   scripts/feature-check.sh --quick          # static + storage only
#   scripts/feature-check.sh --unit           # all offline test suites
#   scripts/feature-check.sh --live           # service health (boot dev.sh first)
#
# Exit code = number of FAILs. PASS-only run exits 0.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

# ─── Args ─────────────────────────────────────────────────────────
# --quick is "fastest sanity check" — file integrity + invariants + the
# storage-layout drift check (a single forge call). It does NOT run the
# full forge test suite or vitest.
DO_STATIC=0; DO_UNIT=0; DO_LIVE=0; DO_QUICK_ONLY=0; VERBOSE=0
if [ $# -eq 0 ]; then
    DO_STATIC=1; DO_UNIT=1; DO_LIVE=1
fi
for arg in "$@"; do
    case "$arg" in
        --static) DO_STATIC=1 ;;
        --unit)   DO_UNIT=1 ;;
        --live)   DO_LIVE=1 ;;
        --all)    DO_STATIC=1; DO_UNIT=1; DO_LIVE=1 ;;
        --quick)  DO_STATIC=1; DO_QUICK_ONLY=1 ;;
        -v|--verbose) VERBOSE=1 ;;
        -h|--help)
            sed -n '3,22p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) echo "unknown arg: $arg (try --help)"; exit 2 ;;
    esac
done

# ─── Dependency probe ─────────────────────────────────────────────
# Fail fast (exit 2 — usage error) when a required tool is missing.
# Live mode is the only one that needs `cast`; we don't probe it
# unconditionally so a contributor running `--quick` doesn't need
# foundry installed.
require_tool() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "ERROR: required tool '$1' not found on PATH ($2)" >&2
        exit 2
    fi
}
[ $DO_UNIT -eq 1 ] || [ $DO_STATIC -eq 1 ] && require_tool forge "install foundry: https://book.getfoundry.sh/getting-started/installation"
[ $DO_UNIT -eq 1 ] && require_tool npm "install Node.js"
[ $DO_LIVE -eq 1 ] && require_tool curl "comes with macOS / most distros"
[ $DO_LIVE -eq 1 ] && require_tool cast "install foundry (cast ships with forge)"

# ─── Output helpers ───────────────────────────────────────────────
PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0
FAILED=()

pass() { printf "  \033[32m[PASS]\033[0m %s\n" "$1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() { printf "  \033[31m[FAIL]\033[0m %s — %s\n" "$1" "$2"; FAIL_COUNT=$((FAIL_COUNT+1)); FAILED+=("$1"); }
skip() { printf "  \033[33m[SKIP]\033[0m %s — %s\n" "$1" "$2"; SKIP_COUNT=$((SKIP_COUNT+1)); }
section() { printf "\n\033[1;36m── %s ──\033[0m\n" "$1"; }

# Curl reachability — returns true on HTTP 2xx.
http_ok() {
    local url="$1"
    local code
    code=$(curl -fsS -o /dev/null -w "%{http_code}" --max-time 3 "$url" 2>/dev/null || echo "000")
    [[ "$code" =~ ^2 ]]
}

# ─── STATIC: config + file integrity ──────────────────────────────
run_static() {
    section "static · file integrity"

    # Core source files exist
    for f in \
        "contracts/src/FeeVault.sol" \
        "contracts/src/SanctionsList.sol" \
        "contracts/src/IdentityGate.sol" \
        "contracts/src/RelayerRegistry.sol" \
        "contracts/src/zk/CommitmentPool.sol" \
        "contracts/src/zk/IncrementalMerkleTree.sol" \
        "contracts/src/zk/PrivateSettlement.sol" \
        "contracts/test/utils/ProxyDeployer.sol" \
        "contracts/script/DeployLocal.s.sol" \
        "contracts/script/storage-layout/snapshot.sh" \
        "contracts/script/storage-layout/check.sh" \
        "scripts/dev.sh" \
        "scripts/swap-identity-registry.sh" \
        "zk-relayer/package.json" \
        "shared-orderbook/package.json" \
        "apps/pay/package.json" \
        "apps/pro/package.json"; do
        if [ -f "$f" ]; then pass "exists: $f"
        else fail "exists: $f" "missing"; fi
    done

    section "static · storage-layout baselines"
    for c in FeeVault SanctionsList IdentityGate RelayerRegistry CommitmentPool PrivateSettlement; do
        if [ -f "contracts/storage-layouts/$c.json" ]; then pass "baseline: $c.json"
        else fail "baseline: $c.json" "missing"; fi
    done

    section "static · upgradeable migration invariants"

    # Every converted contract MUST disable initializers in its impl ctor
    for f in contracts/src/FeeVault.sol contracts/src/SanctionsList.sol \
             contracts/src/IdentityGate.sol contracts/src/RelayerRegistry.sol \
             contracts/src/zk/CommitmentPool.sol contracts/src/zk/PrivateSettlement.sol; do
        local name; name=$(basename "$f" .sol)
        if grep -q "_disableInitializers()" "$f"; then pass "_disableInitializers: $name"
        else fail "_disableInitializers: $name" "not found"; fi
    done

    # Every converted contract MUST have a storage __gap
    for f in contracts/src/FeeVault.sol contracts/src/SanctionsList.sol \
             contracts/src/IdentityGate.sol contracts/src/RelayerRegistry.sol \
             contracts/src/zk/CommitmentPool.sol contracts/src/zk/PrivateSettlement.sol; do
        local name; name=$(basename "$f" .sol)
        if grep -qE "uint256\[[0-9]+\] private __gap" "$f"; then pass "__gap: $name"
        else fail "__gap: $name" "not found"; fi
    done

    # PausableUpgradeable migration: __deprecated_paused placeholder
    for f in contracts/src/zk/CommitmentPool.sol contracts/src/zk/PrivateSettlement.sol; do
        local name; name=$(basename "$f" .sol)
        if grep -q "__deprecated_paused" "$f"; then pass "__deprecated_paused: $name"
        else fail "__deprecated_paused: $name" "missing — pause migration broke slot ordering"; fi
    done

    # No leftover non-upgradeable Ownable2Step on the migrated set
    for f in contracts/src/FeeVault.sol contracts/src/SanctionsList.sol \
             contracts/src/IdentityGate.sol contracts/src/RelayerRegistry.sol \
             contracts/src/zk/CommitmentPool.sol contracts/src/zk/PrivateSettlement.sol; do
        local name; name=$(basename "$f" .sol)
        if grep -qE "^import.*\{Ownable2Step\}" "$f"; then
            fail "no-old-Ownable2Step: $name" "still imports non-upgradeable Ownable2Step"
        else pass "no-old-Ownable2Step: $name"; fi
    done

    section "static · CI wiring"
    if grep -q "storage-layout/check.sh" .github/workflows/ci.yml 2>/dev/null; then
        pass "ci.yml: storage-layout check step"
    else
        fail "ci.yml: storage-layout check step" "not found in .github/workflows/ci.yml"
    fi
    if grep -q "UPGRADE_OWNER" contracts/script/DeployLocal.s.sol; then
        pass "DeployLocal: UPGRADE_OWNER guard present"
    else
        fail "DeployLocal: UPGRADE_OWNER guard present" "guard missing"
    fi
}

# Run storage-layout drift check (used by both --quick and --unit).
run_storage_layout_check() {
    section "storage-layout drift"
    local out
    if out=$(cd contracts && ./script/storage-layout/check.sh 2>&1); then
        pass "storage-layout check (6 contracts)"
    else
        # check.sh prints the offending diff before exiting non-zero;
        # surface the first ✗ line so the operator can see which contract drifted.
        local first_bad; first_bad=$(echo "$out" | grep '✗' | head -1 | sed 's/^[[:space:]]*//')
        fail "storage-layout check" "${first_bad:-baseline diff (see check.sh output)}"
    fi
}

# ─── UNIT: forge + vitest suites ──────────────────────────────────
run_unit() {
    section "unit · solidity (forge)"
    local out
    if out=$(cd contracts && forge test --no-match-contract Fork 2>&1); then
        # `tests?` to handle the singular form ("1 test passed").
        local n_pass; n_pass=$(echo "$out" | grep -oE '[0-9]+ tests? passed' | head -1 | awk '{print $1}')
        local n_fail; n_fail=$(echo "$out" | grep -oE '[0-9]+ failed' | head -1 | awk '{print $1}')
        n_pass=${n_pass:-0}; n_fail=${n_fail:-0}
        if [ "$n_fail" = "0" ] || [ -z "$n_fail" ]; then
            pass "forge test --no-match-contract Fork ($n_pass tests)"
        else
            fail "forge test" "$n_fail failed of $((n_pass+n_fail))"
        fi
    else
        fail "forge test" "compile or run failed"
    fi

    run_storage_layout_check

    section "unit · zk-relayer (vitest)"
    if [ ! -d zk-relayer/node_modules ]; then
        skip "zk-relayer vitest" "node_modules absent (run npm install first)"
    else
        local out
        if out=$(cd zk-relayer && npm test 2>&1); then
            pass "zk-relayer vitest (all green)"
        else
            local nfail; nfail=$(echo "$out" | grep -oE 'Tests +[0-9]+ failed' | awk '{print $2}')
            nfail=${nfail:-?}
            fail "zk-relayer vitest" "$nfail tests failed (likely stale fixture, see test-debt note)"
        fi
    fi

    section "unit · shared-orderbook (vitest)"
    if [ ! -d shared-orderbook/node_modules ]; then
        skip "shared-orderbook vitest" "node_modules absent"
    else
        local out
        if out=$(cd shared-orderbook && npm test 2>&1); then
            pass "shared-orderbook vitest (all green)"
        else
            local nfail; nfail=$(echo "$out" | grep -oE 'Tests +[0-9]+ failed' | awk '{print $2}')
            nfail=${nfail:-?}
            fail "shared-orderbook vitest" "$nfail tests failed (OFFER_HANDLE fixture drift)"
        fi
    fi

    section "unit · upgrade simulation"
    local out
    if out=$(cd contracts && forge test --match-contract UpgradeSim 2>&1); then
        local n; n=$(echo "$out" | grep -oE '[0-9]+ tests? passed' | head -1 | awk '{print $1}')
        pass "upgrade-sim: V1→V2 state preservation ($n cases)"
    else
        fail "upgrade-sim" "V1→V2 test failed"
    fi
}

# ─── LIVE: HTTP endpoints (require dev.sh up) ─────────────────────
run_live() {
    section "live · anvil + service ports"
    if http_ok "http://localhost:8545"; then pass "anvil :8545"; else
        # anvil doesn't respond to GET / — try block-number JSON-RPC
        local code
        code=$(curl -fsS -X POST -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
            --max-time 3 -o /dev/null -w "%{http_code}" http://localhost:8545 2>/dev/null || echo 000)
        if [ "$code" = "200" ]; then pass "anvil :8545 (JSON-RPC)"
        else skip "anvil :8545" "not running — start with: arch -arm64 /opt/homebrew/bin/bash -c 'SKIP_CIRCUIT_BUILD=1 ./scripts/dev.sh --mock --apps pay,pro'"; return 0; fi
    fi

    section "live · shared orderbook (4000)"
    if http_ok "http://localhost:4000/health"; then pass "GET /health"
    else fail "GET /health" "orderbook not responding"; fi
    if http_ok "http://localhost:4000/api/stats"; then pass "GET /api/stats"
    else fail "GET /api/stats" "non-2xx"; fi
    if http_ok "http://localhost:4000/api/relayers"; then pass "GET /api/relayers"
    else fail "GET /api/relayers" "non-2xx"; fi
    if http_ok "http://localhost:4000/api/orders"; then pass "GET /api/orders"
    else fail "GET /api/orders" "non-2xx"; fi

    section "live · zk-relayer A (3002)"
    if http_ok "http://localhost:3002/api/info"; then pass "A GET /api/info"
    else fail "A GET /api/info" "relayer A not responding"; fi
    if http_ok "http://localhost:3002/api/admin/profile"; then pass "A GET /api/admin/profile"
    else fail "A GET /api/admin/profile" "non-2xx"; fi

    section "live · zk-relayer B (3003)"
    if http_ok "http://localhost:3003/api/info"; then pass "B GET /api/info"
    else fail "B GET /api/info" "relayer B not responding"; fi

    section "live · Pay (4001)"
    if http_ok "http://localhost:4001"; then pass "Pay /"
    else fail "Pay /" "not responding"; fi

    section "live · Pro (4003)"
    if http_ok "http://localhost:4003"; then pass "Pro /"
    else fail "Pro /" "not responding"; fi

    section "live · on-chain proxy admins"
    # ADMIN_SLOT = bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)
    local ADMIN_SLOT=0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103
    for label_env in "FEE_VAULT NEXT_PUBLIC_FEE_VAULT_ADDRESS" \
                     "IDENTITY_GATE NEXT_PUBLIC_IDENTITY_GATE_ADDRESS" \
                     "POOL NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS" \
                     "SETTLE NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS"; do
        local label="${label_env%% *}"
        local envvar="${label_env##* }"
        local addr; addr=$(grep -E "^$envvar=" apps/pay/.env.local 2>/dev/null | head -1 | cut -d= -f2-)
        if [ -z "$addr" ]; then skip "ADMIN_SLOT($label)" "address not in apps/pay/.env.local"; continue; fi
        local slot; slot=$(cast storage "$addr" "$ADMIN_SLOT" --rpc-url http://localhost:8545 2>/dev/null)
        if [ -n "$slot" ] && [ "$slot" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
            pass "ADMIN_SLOT($label) = $slot (ProxyAdmin present)"
        else
            fail "ADMIN_SLOT($label)" "slot empty — proxy admin missing"
        fi
    done

    section "live · pause/unpause owner-only"
    local POOL; POOL=$(grep -E "^NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=" apps/pay/.env.local 2>/dev/null | head -1 | cut -d= -f2-)
    if [ -z "$POOL" ]; then skip "CommitmentPool.pause()" "address missing"
    else
        # current state should be false
        local p; p=$(cast call "$POOL" "paused()(bool)" --rpc-url http://localhost:8545 2>/dev/null)
        if [ "$p" = "false" ]; then pass "CommitmentPool.paused() = false (initial)"
        else fail "CommitmentPool.paused()" "expected false, got $p"; fi

        # non-owner pause must revert
        local non_owner_key=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d  # Account #1
        if cast send "$POOL" "pause()" --rpc-url http://localhost:8545 \
            --private-key "$non_owner_key" 2>/dev/null; then
            fail "CommitmentPool.pause() onlyOwner" "non-owner pause succeeded — access control broken"
        else
            pass "CommitmentPool.pause() rejects non-owner"
        fi
    fi
}

# ─── Run selected groups ──────────────────────────────────────────
echo "scatter-dex · feature health check"
echo "$(date '+%Y-%m-%d %H:%M:%S')"
[ $DO_STATIC -eq 1 ] && run_static
# --quick = static + storage-layout drift (the single forge call most
# likely to catch a deployment regression). Skip the full forge / vitest
# suites which are owned by --unit / --all.
[ $DO_QUICK_ONLY -eq 1 ] && run_storage_layout_check
[ $DO_UNIT   -eq 1 ] && run_unit
[ $DO_LIVE   -eq 1 ] && run_live

echo ""
section "summary"
echo "  PASS: $PASS_COUNT"
echo "  FAIL: $FAIL_COUNT"
echo "  SKIP: $SKIP_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
    echo ""
    echo "Failed checks:"
    for f in "${FAILED[@]}"; do echo "  · $f"; done
fi
exit "$FAIL_COUNT"
