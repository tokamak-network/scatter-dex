#!/usr/bin/env bash
#
# deploy-zk-x509-sepolia.sh — deploy the zk-X509 IdentityRegistry to a testnet
# and AUTO-WRITE a per-network address ledger (the zk-X509 repo's Deploy.s.sol
# only console-logs; this wrapper captures + persists the result so the
# IdentityRegistry address is never lost between the two deploy steps).
#
# Why a wrapper (not a zk-X509 edit): zk-X509 core (circuits/contracts/lib) is
# kept unmodified — see the relayer-KYC-onboarding design boundary. The
# cross-repo orchestration + ledger lives here in scatter-dex instead.
#
# What it does:
#   1. generate PROGRAM_V_KEY  (cargo run --bin vkey, warm ~1s)
#   2. forge script Deploy.s.sol in the zk-X509 repo (MAX_WALLETS_PER_CERT=10)
#   3. parse the IdentityRegistry proxy/impl addresses
#   4. write contracts/deployments/zk-x509-<chainId>.json   (the ledger)
#   5. print the SEPOLIA_IDENTITY_REGISTRY lines to paste into contracts/.env
#
# Signing / RPC come from contracts/.env (DEPLOYER_KEY, SEPOLIA_RPC_URL) — the
# same deployer EOA as DeploySepolia. The key is sourced into the environment,
# never printed. zk-X509's Deploy.s.sol uses a no-arg vm.startBroadcast(), so
# the key is passed via --private-key (transient in process args only).
#
# Usage:
#   ZK_X509_REPO=/path/to/zk-X509 ./scripts/deploy-zk-x509-sepolia.sh
#   (defaults ZK_X509_REPO to ../zk-X509)
#
# Env (from contracts/.env, auto-sourced):
#   DEPLOYER_KEY, SEPOLIA_RPC_URL
# Optional overrides:
#   MAX_WALLETS_PER_CERT (default 10)
#   SP1_VERIFIER_ADDRESS (default Sepolia Succinct gateway 0x3B60…185e)
#   CA_MERKLE_ROOT       (optional; if unset, register() reverts until addCA)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ZK_X509_REPO="${ZK_X509_REPO:-$ROOT_DIR/../zk-X509}"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/contracts/.env}"
LEDGER_DIR="$ROOT_DIR/contracts/deployments"

[ -d "$ZK_X509_REPO/contracts" ] || { echo "ERROR: zk-X509 repo not found at $ZK_X509_REPO (set ZK_X509_REPO=)"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found (need DEPLOYER_KEY, SEPOLIA_RPC_URL)"; exit 1; }

# Source the deployer key + RPC without echoing them.
set -a; # shellcheck disable=SC1090
source "$ENV_FILE"; set +a
: "${DEPLOYER_KEY:?DEPLOYER_KEY missing in contracts/.env}"
: "${SEPOLIA_RPC_URL:?SEPOLIA_RPC_URL missing in contracts/.env}"

MAX_WALLETS_PER_CERT="${MAX_WALLETS_PER_CERT:-10}"
SP1_VERIFIER_ADDRESS="${SP1_VERIFIER_ADDRESS:-0x3B6041173B80E77f038f3F2C0f9744f04837185e}"

echo "[zk-x509-deploy] generating program vkey…"
# set +e window: pipefail would otherwise abort before our explicit check,
# swallowing the cargo error. Keep stderr so a build failure is visible.
set +e
VKEY_OUT="$(cd "$ZK_X509_REPO" && cargo run --release --bin vkey 2>&1)"; vkey_rc=$?
set -e
PROGRAM_V_KEY="$(echo "$VKEY_OUT" | grep -oE '0x[0-9a-fA-F]{64}' | head -1)"
if [ "$vkey_rc" -ne 0 ] || [ -z "$PROGRAM_V_KEY" ]; then
  echo "ERROR: could not derive PROGRAM_V_KEY (cargo run --bin vkey rc=$vkey_rc):" >&2
  echo "$VKEY_OUT" | tail -10 >&2
  exit 1
fi
echo "[zk-x509-deploy] PROGRAM_V_KEY=$PROGRAM_V_KEY"

echo "[zk-x509-deploy] deploying IdentityRegistry (MAX_WALLETS_PER_CERT=$MAX_WALLETS_PER_CERT)…"
# set +e window: forge can exit non-zero even on a SUCCESSFUL broadcast, so
# success is decided by parsing the output (ONCHAIN EXECUTION COMPLETE), not $?.
# NOTE: --private-key puts the key in this process's args (visible to `ps` on
# this host for the forge run's duration). zk-X509's Deploy.s.sol uses a no-arg
# vm.startBroadcast(), so a CLI key is required. For stricter handling, import
# the key into a Foundry keystore and run Deploy.s.sol manually with --account.
set +e
OUT="$(cd "$ZK_X509_REPO/contracts" && \
  SP1_VERIFIER_ADDRESS="$SP1_VERIFIER_ADDRESS" \
  PROGRAM_V_KEY="$PROGRAM_V_KEY" \
  MAX_WALLETS_PER_CERT="$MAX_WALLETS_PER_CERT" \
  ${CA_MERKLE_ROOT:+CA_MERKLE_ROOT="$CA_MERKLE_ROOT"} \
  forge script script/Deploy.s.sol --tc DeployScript \
    --rpc-url "$SEPOLIA_RPC_URL" --broadcast \
    --private-key "$DEPLOYER_KEY" 2>&1)"
set -e

echo "$OUT" | grep -iE "Max wallets|IdentityRegistry|WARNING|ONCHAIN EXECUTION" || true
echo "$OUT" | grep -qi "ONCHAIN EXECUTION COMPLETE" || { echo "ERROR: deploy did not complete:" >&2; echo "$OUT" | tail -20 >&2; exit 1; }

REGISTRY="$(echo "$OUT" | grep -i "IdentityRegistry proxy" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)"
IMPL="$(echo "$OUT" | grep -i "IdentityRegistry implementation" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)"
# No 2>/dev/null — an RPC failure here must surface, not silently empty a field.
CHAIN_ID="$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")"
BLOCK="$(cast block-number --rpc-url "$SEPOLIA_RPC_URL")"
DEPLOYER_ADDR="$(cast wallet address --private-key "$DEPLOYER_KEY")"

# Refuse to write an incomplete ledger — validate every field, not just the proxy.
for pair in "registry=$REGISTRY" "impl=$IMPL" "chainId=$CHAIN_ID" "block=$BLOCK" "deployer=$DEPLOYER_ADDR"; do
  [ -n "${pair#*=}" ] || { echo "ERROR: failed to resolve ${pair%%=*} — refusing to write an incomplete ledger" >&2; exit 1; }
done

mkdir -p "$LEDGER_DIR"
LEDGER="$LEDGER_DIR/zk-x509-${CHAIN_ID}.json"
cat > "$LEDGER" <<JSON
{
  "chainId": ${CHAIN_ID},
  "deployBlock": ${BLOCK},
  "identityRegistry": "${REGISTRY}",
  "identityRegistryImpl": "${IMPL}",
  "sp1Verifier": "${SP1_VERIFIER_ADDRESS}",
  "programVKey": "${PROGRAM_V_KEY}",
  "maxWalletsPerCert": ${MAX_WALLETS_PER_CERT},
  "caMerkleRoot": "${CA_MERKLE_ROOT:-0x0000000000000000000000000000000000000000000000000000000000000000}",
  "deployer": "${DEPLOYER_ADDR}"
}
JSON

echo ""
echo "[zk-x509-deploy] ✅ ledger written: $LEDGER"
echo "[zk-x509-deploy] IdentityRegistry: $REGISTRY  (chain $CHAIN_ID, block $BLOCK)"
echo ""
echo "Paste into contracts/.env for DeploySepolia:"
echo "  SEPOLIA_IDENTITY_REGISTRY=$REGISTRY"
echo "  SEPOLIA_RELAYER_IDENTITY_REGISTRY=$REGISTRY"
echo ""
echo "Then: register CAs (addCA) so register() works, and run DeploySepolia."
