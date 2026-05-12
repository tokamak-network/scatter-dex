#!/usr/bin/env bash
#
# E2E live check — exercises every row marked 🌐 / on-chain-invariant
# in `docs/operations/feature-checklist.md`. Assumes the e2e stack
# is already up (`./scripts/start-e2e-env.sh` or `./scripts/dev.sh
# --mock`).
#
# Pre-flight: if anvil is unreachable we exit with code 2 (usage
# error) since none of the on-chain checks are meaningful without
# it. To run only the offline portion, prefer `./scripts/feature-
# check.sh --quick`.
#
# Usage:
#   ./scripts/e2e-live-check.sh                # run full live sweep
#   ./scripts/e2e-live-check.sh --verbose      # show raw responses
#
# Exit code = number of FAILs (or 2 on pre-flight error).

set -uo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

VERBOSE=0
for arg in "$@"; do
    case "$arg" in
        -v|--verbose) VERBOSE=1 ;;
        -h|--help) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown arg: $arg"; exit 2 ;;
    esac
done

PASS_COUNT=0; FAIL_COUNT=0; SKIP_COUNT=0
FAILED=()

pass() { printf "  \033[32m[PASS]\033[0m %s\n" "$1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail() { printf "  \033[31m[FAIL]\033[0m %s — %s\n" "$1" "$2"; FAIL_COUNT=$((FAIL_COUNT+1)); FAILED+=("$1"); }
skip() { printf "  \033[33m[SKIP]\033[0m %s — %s\n" "$1" "$2"; SKIP_COUNT=$((SKIP_COUNT+1)); }
section() { printf "\n\033[1;36m── %s ──\033[0m\n" "$1"; }

RPC=http://localhost:8545
ADMIN_SLOT=0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RELAYER_A_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

# Pre-flight: anvil reachable?
if ! curl -fsS -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
    --max-time 3 "$RPC" >/dev/null 2>&1; then
    echo "anvil not reachable at $RPC — run dev.sh --mock first"
    exit 2
fi

# Resolve canonical proxy addresses from the latest broadcast file —
# works for both `dev.sh --mock` and `start-e2e-env.sh` boots (the
# latter doesn't write `apps/pay/.env.local`). If `.env.local` is
# present we cross-check, but the broadcast file is the source of
# truth: it always reflects the most recent deploy run on chain 31337.
BCAST="$ROOT_DIR/contracts/broadcast/DeployLocal.s.sol/31337/run-latest.json"
if [ ! -f "$BCAST" ]; then
    echo "broadcast file missing: $BCAST — re-run the deploy"
    exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
    echo "jq required to parse broadcast addresses"
    exit 2
fi

# Walk transactions in order. DeployLocal deploys each proxy as a pair:
# `Name impl` (the implementation, contractName = the contract itself) +
# `TransparentUpgradeableProxy` (the proxy, points at impl). The proxy
# is always the second of the pair, in deploy order.
read_proxy_after() {
    local impl_name="$1"
    jq -r --arg N "$impl_name" '
      [.transactions[] | select(.contractAddress != null)]
      | (map(.contractName) | index($N)) as $i
      | .[$i + 1] // {}
      | .contractAddress // ""
    ' "$BCAST"
}

POOL=$(read_proxy_after CommitmentPool)
SETTLE=$(read_proxy_after PrivateSettlement)
GATE=$(read_proxy_after IdentityGate)
VAULT=$(read_proxy_after FeeVault)
RREG=$(read_proxy_after RelayerRegistry)

for v in POOL:CommitmentPool SETTLE:PrivateSettlement GATE:IdentityGate VAULT:FeeVault RREG:RelayerRegistry; do
    name="${v%%:*}"; label="${v##*:}"
    val="${!name}"
    if [ -z "$val" ] || [ "$val" = "null" ]; then
        echo "ERROR: failed to resolve $label proxy from $BCAST"
        exit 2
    fi
done

echo "scatter-dex · e2e live check"
echo "$(date '+%Y-%m-%d %H:%M:%S')"

# ─── HTTP health ────────────────────────────────────────────────
section "HTTP · service health"
for svc in \
    "anvil:$RPC" \
    "orderbook /health:http://localhost:4000/health" \
    "orderbook /api/stats:http://localhost:4000/api/stats" \
    "orderbook /api/relayers:http://localhost:4000/api/relayers" \
    "orderbook /api/orders:http://localhost:4000/api/orders" \
    "relayer A /api/info:http://localhost:3002/api/info" \
    "relayer A /health:http://localhost:3002/health" \
    "relayer B /api/info:http://localhost:3003/api/info" \
    "relayer B /health:http://localhost:3003/health" \
    "Pay /:http://localhost:4001" \
    "Pro /:http://localhost:4003"; do
    label="${svc%%:*}"; url="${svc#*:}"
    # `-f` would suppress output on 4xx and force curl exit 22; we WANT
    # to capture all HTTP codes (including 401 for admin endpoints) so
    # drop `-f` and rely on the printed `%{http_code}` alone.
    if [ "$label" = "anvil" ]; then
        code=$(curl -sS -X POST -H "Content-Type: application/json" \
            -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' \
            --max-time 3 -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)
    else
        code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 5 "$url" 2>/dev/null)
    fi
    code="${code:-000}"
    # Pay (4001) / Pro (4003) are not started by start-e2e-env.sh — only
    # by `dev.sh --apps pay,pro`. SKIP cleanly on connection refused so
    # operators using the lighter CI boot don't get spurious FAILs.
    if [[ "$label" == "Pay /" || "$label" == "Pro /" ]] && [ "$code" = "000" ]; then
        skip "$label" "not running (boot with dev.sh --apps pay,pro)"
        continue
    fi
    if [[ "$code" =~ ^2 ]]; then pass "$label ($code)"
    else fail "$label" "HTTP $code"; fi
done

# ─── HTTP admin endpoints (require x-admin-key) ──────────────────
# `/api/admin/*` is gated by `adminAuth` middleware. We send the
# default mock key; the relayer rejects with 401 if `ADMIN_API_KEY`
# is configured to a different value — that's a SKIP, not a FAIL.
# Override the key with:  ADMIN_API_KEY=... ./scripts/e2e-live-check.sh
section "HTTP · admin endpoints (auth required)"
ADMIN_KEY="${ADMIN_API_KEY:-dev-admin-key}"
for url in \
    "relayer A /api/admin/profile:http://localhost:3002/api/admin/profile" \
    "relayer B /api/admin/profile:http://localhost:3003/api/admin/profile"; do
    label="${url%%:*}"; target="${url#*:}"
    code=$(curl -sS -H "x-admin-key: $ADMIN_KEY" -o /dev/null -w "%{http_code}" --max-time 5 "$target" 2>/dev/null)
    code="${code:-000}"
    if [[ "$code" =~ ^2 ]]; then pass "$label ($code)"
    elif [ "$code" = "401" ] || [ "$code" = "403" ]; then
        skip "$label" "admin auth rejected (set ADMIN_API_KEY env to match the relayer's configured key)"
    else
        fail "$label" "HTTP $code"
    fi
done

# ─── On-chain proxy admin slot ───────────────────────────────────
section "on-chain · proxy ADMIN_SLOT (ERC1967)"
for entry in \
    "FeeVault:$VAULT" \
    "CommitmentPool:$POOL" \
    "PrivateSettlement:$SETTLE" \
    "IdentityGate:$GATE" \
    "RelayerRegistry:$RREG"; do
    label="${entry%%:*}"; addr_="${entry#*:}"
    if [ -z "$addr_" ] || [ "$addr_" = "0x" ]; then
        skip "$label admin slot" "address not in apps/pay/.env.local"
        continue
    fi
    slot=$(cast storage "$addr_" "$ADMIN_SLOT" --rpc-url "$RPC" 2>/dev/null)
    [ $VERBOSE -eq 1 ] && echo "    addr=$addr_ slot=$slot"
    if [ -n "$slot" ] && [ "$slot" != "0x0000000000000000000000000000000000000000000000000000000000000000" ]; then
        pass "$label admin slot populated"
    else
        fail "$label admin slot" "empty — proxy admin missing"
    fi
done

# ─── On-chain code present at every proxy address ────────────────
section "on-chain · proxy code present"
for entry in \
    "FeeVault:$VAULT" \
    "CommitmentPool:$POOL" \
    "PrivateSettlement:$SETTLE" \
    "IdentityGate:$GATE" \
    "RelayerRegistry:$RREG"; do
    label="${entry%%:*}"; addr_="${entry#*:}"
    [ -z "$addr_" ] && skip "$label code" "addr missing" && continue
    code=$(cast code "$addr_" --rpc-url "$RPC" 2>/dev/null)
    if [ -n "$code" ] && [ "$code" != "0x" ]; then
        pass "$label has code (${#code} bytes hex)"
    else
        fail "$label" "no code at $addr_"
    fi
done

# ─── On-chain · CommitmentPool pause invariants ─────────────────
section "on-chain · CommitmentPool pause invariant"
if [ -z "$POOL" ]; then
    skip "pool pause invariant" "POOL address missing"
else
    p=$(cast call "$POOL" "paused()(bool)" --rpc-url "$RPC" 2>/dev/null)
    if [ "$p" = "false" ]; then pass "paused() = false (initial)"
    else fail "paused()" "expected false, got '$p'"; fi

    # Non-owner attempt must revert
    err=$(cast send "$POOL" "pause()" \
        --rpc-url "$RPC" --private-key "$RELAYER_A_KEY" 2>&1 || true)
    if echo "$err" | grep -qE "OwnableUnauthorizedAccount|revert"; then
        pass "pause() rejects non-owner (OwnableUnauthorizedAccount)"
    else
        fail "pause() onlyOwner" "non-owner call did not revert as expected"
    fi
fi

# ─── On-chain · PrivateSettlement pause invariants ───────────────
section "on-chain · PrivateSettlement pause invariant"
if [ -z "$SETTLE" ]; then
    skip "settlement pause invariant" "SETTLE address missing"
else
    p=$(cast call "$SETTLE" "paused()(bool)" --rpc-url "$RPC" 2>/dev/null)
    if [ "$p" = "false" ]; then pass "paused() = false (initial)"
    else fail "paused()" "expected false, got '$p'"; fi

    err=$(cast send "$SETTLE" "pause()" \
        --rpc-url "$RPC" --private-key "$RELAYER_A_KEY" 2>&1 || true)
    if echo "$err" | grep -qE "OwnableUnauthorizedAccount|revert"; then
        pass "pause() rejects non-owner"
    else
        fail "pause() onlyOwner" "non-owner call did not revert"
    fi
fi

# ─── On-chain · RelayerRegistry has 2 active relayers ────────────
section "on-chain · RelayerRegistry state"
if [ -z "$RREG" ]; then
    skip "relayer registry" "address missing"
else
    count=$(cast call "$RREG" "getRelayerCount()(uint256)" --rpc-url "$RPC" 2>/dev/null)
    [ $VERBOSE -eq 1 ] && echo "    getRelayerCount() = $count"
    # Account #1 (relayer A) is registered by DeployLocal; relayer B
    # joins via start-e2e-env.sh / dev.sh's post-deploy register call.
    # Both should be registered → require ≥2.
    if [ -n "$count" ] && [ "$count" -ge 2 ]; then
        pass "registered relayers: $count (expected ≥2)"
    else
        fail "RelayerRegistry.getRelayerCount" "got '$count', expected ≥2"
    fi
fi

# ─── On-chain · IdentityGate has at least one registry ───────────
section "on-chain · IdentityGate registries"
if [ -z "$GATE" ]; then
    skip "identity gate" "address missing"
else
    rcount=$(cast call "$GATE" "getRegistryCount()(uint256)" --rpc-url "$RPC" 2>/dev/null)
    if [ -n "$rcount" ] && [ "$rcount" -ge 1 ]; then
        pass "IdentityGate registries: $rcount"
    else
        fail "IdentityGate.getRegistryCount" "got '$rcount', expected ≥1"
    fi
fi

# ─── Relayer A reports correct on-chain address ──────────────────
section "cross-ref · relayer ↔ on-chain"
info=$(curl -fsS --max-time 3 http://localhost:3002/api/info 2>/dev/null || echo "")
if [ -z "$info" ]; then
    skip "relayer A info ↔ chain" "no /api/info response"
else
    relayer_addr=$(echo "$info" | grep -oE '"address":"[^"]+"' | head -1 | cut -d'"' -f4)
    [ $VERBOSE -eq 1 ] && echo "    relayer A reports address=$relayer_addr"
    if [ -n "$relayer_addr" ]; then
        # `relayers(addr)` returns the Relayer struct
        # (url, name, fee, bond, registeredAt, exitRequestedAt, active).
        # The active bool is the LAST field — that's what we check; bond
        # itself may be zero in mock mode (minBond=0) and isn't the
        # registration signal.
        active=$(cast call "$RREG" "relayers(address)(string,string,uint256,uint256,uint256,uint256,bool)" "$relayer_addr" --rpc-url "$RPC" 2>/dev/null | tail -1)
        if [ "$active" = "true" ]; then
            pass "relayer A address ($relayer_addr) is active on-chain"
        else
            fail "relayer A on-chain" "active=$active"
        fi
    else
        fail "relayer A info" "no address in /api/info"
    fi
fi

# ─── Summary ─────────────────────────────────────────────────────
echo ""
section "summary"
echo "  PASS: $PASS_COUNT"
echo "  FAIL: $FAIL_COUNT"
echo "  SKIP: $SKIP_COUNT"
if [ "$FAIL_COUNT" -gt 0 ]; then
    echo ""
    echo "Failed:"
    for f in "${FAILED[@]}"; do echo "  · $f"; done
fi
exit "$FAIL_COUNT"
