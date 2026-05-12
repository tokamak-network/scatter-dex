#!/usr/bin/env bash
# ============================================================
# Swap scatter-dex's IdentityGate from MockIdentityRegistry to a real
# zk-X509 IdentityRegistry. Run AFTER `dev.sh --mock` is up — with any
# `--apps` selection (e.g. `--apps pay`, `--apps pay,pro`, …) — and
# AFTER you've deployed a zk-X509 IdentityRegistry onto the same anvil.
#
# IdentityGate is a single on-chain contract shared by every app
# (Pay, Pro, Drop, etc.). One swap covers all of them — the script
# reads the address from apps/pay/.env.local for convenience.
#
# The native `dev.sh` integration path (no --mock, with
# IDENTITY_REGISTRY=...) tries to register the relayer identity
# during contract deploy, which reverts with NotVerified() on a
# freshly-deployed zk-X509 registry. Booting in mock and swapping
# afterwards lets the stack come up first and avoids that
# chicken-and-egg.
#
# Usage:
#   ./scripts/swap-identity-registry.sh <zk-X509 IdentityRegistry>
#   IDENTITY_GATE=0x... ./scripts/swap-identity-registry.sh 0x...
#   RPC_URL=http://localhost:8545 ./scripts/swap-identity-registry.sh 0x...
#
# Inputs (env or default):
#   IDENTITY_GATE   IdentityGate proxy. Auto-read from
#                   apps/pay/.env.local::NEXT_PUBLIC_IDENTITY_GATE_ADDRESS
#                   if not set (Pro & every other app point at the
#                   same on-chain address).
#   RPC_URL         default http://localhost:8545
#   DEPLOYER_KEY    default Anvil account #0 (must own IdentityGate)
# ============================================================

set -euo pipefail

ZK_REG="${1:-}"
if [ -z "$ZK_REG" ]; then
    echo "ERROR: zk-X509 IdentityRegistry address required."
    echo "Usage: $0 <zk-X509 IdentityRegistry>"
    exit 1
fi

RPC_URL="${RPC_URL:-http://localhost:8545}"
DEPLOYER_KEY="${DEPLOYER_KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}"

# Resolve IdentityGate from env or from Pay's .env.local
if [ -z "${IDENTITY_GATE:-}" ]; then
    ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/apps/pay/.env.local"
    if [ -f "$ENV_FILE" ]; then
        IDENTITY_GATE=$(grep -E '^NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
    fi
fi
if [ -z "${IDENTITY_GATE:-}" ]; then
    echo "ERROR: IDENTITY_GATE not set and apps/pay/.env.local doesn't have NEXT_PUBLIC_IDENTITY_GATE_ADDRESS."
    echo "       Did you run 'dev.sh --mock --apps pay' (or 'dev.sh --mock --apps pay,pro') first?"
    exit 1
fi

echo "=== Swap IdentityGate registry → zk-X509 ==="
echo "  IdentityGate: $IDENTITY_GATE"
echo "  zk-X509 reg:  $ZK_REG"
echo "  RPC:          $RPC_URL"
echo ""

# Sanity: anvil reachable, IdentityGate has code, zk-X509 reg has code.
for addr in "$IDENTITY_GATE" "$ZK_REG"; do
    CODE=$(cast code "$addr" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")
    if [ "$CODE" = "0x" ]; then
        echo "ERROR: no contract at $addr"
        exit 1
    fi
done

# Snapshot current registries before mutation.
CURRENT=$(cast call "$IDENTITY_GATE" "getRegistries()(address[])" --rpc-url "$RPC_URL")
echo "  Current registries: $CURRENT"

# Add zk-X509 first — IdentityGate refuses to leave 0 registries, so we
# can't remove the mock until the replacement is in place.
if echo "$CURRENT" | grep -qi "${ZK_REG#0x}"; then
    echo "  · zk-X509 registry already present, skipping addRegistry"
else
    echo "  → addRegistry($ZK_REG)"
    cast send "$IDENTITY_GATE" "addRegistry(address)" "$ZK_REG" \
        --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null
    echo "    done"
fi

# Remove every other registry (typically the mock from dev.sh's deploy).
UPDATED=$(cast call "$IDENTITY_GATE" "getRegistries()(address[])" --rpc-url "$RPC_URL")
IFS=',' read -ra ADDRS <<< "$(echo "$UPDATED" | tr -d '[] ')"
for addr in "${ADDRS[@]}"; do
    [ -z "$addr" ] && continue
    # Case-insensitive compare to avoid checksum mismatches.
    if [ "$(echo "$addr" | tr 'A-Z' 'a-z')" != "$(echo "$ZK_REG" | tr 'A-Z' 'a-z')" ]; then
        echo "  → removeRegistry($addr)"
        cast send "$IDENTITY_GATE" "removeRegistry(address)" "$addr" \
            --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" > /dev/null
        echo "    done"
    fi
done

FINAL=$(cast call "$IDENTITY_GATE" "getRegistries()(address[])" --rpc-url "$RPC_URL")
echo ""
echo "=== Final ==="
echo "  Registries on IdentityGate: $FINAL"
echo ""
echo "Pay's isVerified() now routes through zk-X509. Issue identities via"
echo "the zk-X509 dashboard at http://localhost:3000 before depositing."
