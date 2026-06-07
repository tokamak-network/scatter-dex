#!/usr/bin/env bash
#
# deploy-zk-x509-sepolia.sh — deploy the zk-X509 RegistryFactory to a testnet
# and create the TWO scatter registries THROUGH that factory, then AUTO-WRITE
# per-network address ledgers.
#
# Why the factory (not a standalone registry): the zk-X509 management website
# is factory-centric — every core page reads `RegistryFactory.getRegistries()`.
# A registry deployed directly (zk-X509 `Deploy.s.sol`) is NOT tracked by any
# factory, so it never shows up in that UI. This wrapper therefore:
#   1. deploys the RegistryFactory via zk-X509's DeployLocal.s.sol (which also
#      deploys a fresh SP1VerifierGroth16 + the shared UpgradeableBeacon)
#   2. calls factory.createRegistry(...) twice — once per scatter role:
#        users     → maxWallets 10   (one cert ⇒ up to 10 wallets)
#        relayers  → maxWallets  2   (one cert ⇒ up to  2 wallets)
#   3. writes contracts/deployments/zk-x509-factory-<chainId>.json plus a
#      per-role ledger each, so the registry addresses are never lost.
#
# Factory-created registries are BeaconProxy instances sharing one beacon; the
# registry owner is the deployer (so the deployer can addCA / manage), and the
# factory tracks them for the website.
#
# Why a wrapper (not a zk-X509 edit): zk-X509 core (circuits/contracts/lib) is
# kept unmodified — see the relayer-KYC-onboarding design boundary. The
# cross-repo orchestration + ledger lives here in scatter-dex instead.
#
# Signing / RPC come from contracts/.env (DEPLOYER_KEY, SEPOLIA_RPC_URL) — the
# same deployer EOA as DeploySepolia. The key is sourced into the environment,
# never printed. zk-X509's DeployLocal.s.sol uses a no-arg vm.startBroadcast(),
# so the key is passed via --private-key (transient in process args only).
#
# ⚠️ No --verify anywhere: this is a PRIVATE testnet; Etherscan verification
#    would publish source. Deploy without it.
#
# Usage:
#   ZK_X509_REPO=/path/to/zk-X509 ./scripts/deploy-zk-x509-sepolia.sh
#   (defaults ZK_X509_REPO to ../zk-X509)
#
# Env (from contracts/.env, auto-sourced): DEPLOYER_KEY, SEPOLIA_RPC_URL
# Optional createRegistry config overrides (sane testnet defaults):
#   USERS_MAX_WALLETS (10)  RELAYERS_MAX_WALLETS (2)
#   MIN_DISCLOSURE_MASK (0)         # cert fields that must be disclosed, 0x00–0x0F
#   MAX_PROOF_AGE (3600)            # seconds, must be 300–86400
#   DELEGATED_PROVING (false)       # prover-server delegation (deferred → false)
#   REQUIRED_COUNTRY / REQUIRED_ORG / REQUIRED_ORG_UNIT / REQUIRED_COMMON_NAME
#       (bytes32, default zero = no requirement)
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

ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
USERS_MAX_WALLETS="${USERS_MAX_WALLETS:-10}"
RELAYERS_MAX_WALLETS="${RELAYERS_MAX_WALLETS:-2}"
MIN_DISCLOSURE_MASK="${MIN_DISCLOSURE_MASK:-0}"
MAX_PROOF_AGE="${MAX_PROOF_AGE:-3600}"
DELEGATED_PROVING="${DELEGATED_PROVING:-false}"
REQUIRED_COUNTRY="${REQUIRED_COUNTRY:-$ZERO32}"
REQUIRED_ORG="${REQUIRED_ORG:-$ZERO32}"
REQUIRED_ORG_UNIT="${REQUIRED_ORG_UNIT:-$ZERO32}"
REQUIRED_COMMON_NAME="${REQUIRED_COMMON_NAME:-$ZERO32}"

echo "[zk-x509-deploy] factory flow: users(maxWallets=$USERS_MAX_WALLETS) + relayers(maxWallets=$RELAYERS_MAX_WALLETS)"
echo "[zk-x509-deploy] config: mask=$MIN_DISCLOSURE_MASK proofAge=${MAX_PROOF_AGE}s delegatedProving=$DELEGATED_PROVING"

# ── 1. program vkey ─────────────────────────────────────────────────
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

# ── 2. deploy RegistryFactory (+ SP1Verifier + beacon) ──────────────
# set +e window: forge can exit non-zero even on a SUCCESSFUL broadcast, so
# success is decided by parsing the output, not $?. NOTE: --private-key puts the
# key in this process's args (visible to `ps` for the run's duration). zk-X509's
# DeployLocal.s.sol uses a no-arg vm.startBroadcast(), so a CLI key is required.
echo "[zk-x509-deploy] deploying RegistryFactory via DeployLocal.s.sol…"
set +e
OUT="$(cd "$ZK_X509_REPO/contracts" && \
  PROGRAM_V_KEY="$PROGRAM_V_KEY" \
  forge script script/DeployLocal.s.sol:DeployLocalScript \
    --rpc-url "$SEPOLIA_RPC_URL" --broadcast --slow \
    --private-key "$DEPLOYER_KEY" 2>&1)"
set -e
echo "$OUT" | grep -iE "SP1Verifier|RegistryFactory|Beacon|ONCHAIN EXECUTION" || true
echo "$OUT" | grep -qi "ONCHAIN EXECUTION COMPLETE" || { echo "ERROR: factory deploy did not complete:" >&2; echo "$OUT" | tail -20 >&2; exit 1; }

FACTORY="$(echo "$OUT" | grep -i "RegistryFactory:" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)"
SP1_VERIFIER="$(echo "$OUT" | grep -i "SP1VerifierGroth16" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)"
BEACON="$(echo "$OUT" | grep -i "Beacon:" | grep -oE '0x[0-9a-fA-F]{40}' | head -1)"
[ -n "$FACTORY" ] || { echo "ERROR: could not parse RegistryFactory address" >&2; exit 1; }
echo "[zk-x509-deploy] RegistryFactory=$FACTORY  SP1Verifier=$SP1_VERIFIER  Beacon=$BEACON"

# ── 3. create the two scatter registries through the factory ────────
# Signature: createRegistry(string,uint32,uint8,uint256,bool,bytes32,bytes32,bytes32,bytes32)
create_registry() {
  local name="$1" max="$2"
  cast send "$FACTORY" \
    "createRegistry(string,uint32,uint8,uint256,bool,bytes32,bytes32,bytes32,bytes32)" \
    "$name" "$max" "$MIN_DISCLOSURE_MASK" "$MAX_PROOF_AGE" "$DELEGATED_PROVING" \
    "$REQUIRED_COUNTRY" "$REQUIRED_ORG" "$REQUIRED_ORG_UNIT" "$REQUIRED_COMMON_NAME" \
    --rpc-url "$SEPOLIA_RPC_URL" --private-key "$DEPLOYER_KEY" >/dev/null \
    || { echo "ERROR: createRegistry($name) failed" >&2; exit 1; }
}
# Registries land in factory.getRegistries() in creation order — create users
# first then relayers, then read the array by index so the addresses are exact.
nth_registry() { # $1 = index → prints the registry address at that index
  cast call "$FACTORY" "getRegistries()(address[])" --rpc-url "$SEPOLIA_RPC_URL" \
    | grep -oE '0x[0-9a-fA-F]{40}' | sed -n "$(( $1 + 1 ))p"
}

START_COUNT="$(cast call "$FACTORY" "getRegistryCount()(uint256)" --rpc-url "$SEPOLIA_RPC_URL")"

echo "[zk-x509-deploy] createRegistry: zkScatter Users (maxWallets=$USERS_MAX_WALLETS)…"
create_registry "zkScatter Users" "$USERS_MAX_WALLETS"
USERS_REGISTRY="$(nth_registry "$START_COUNT")"

echo "[zk-x509-deploy] createRegistry: zkScatter Relayers (maxWallets=$RELAYERS_MAX_WALLETS)…"
create_registry "zkScatter Relayers" "$RELAYERS_MAX_WALLETS"
RELAYERS_REGISTRY="$(nth_registry "$(( START_COUNT + 1 ))")"

# Shared implementation behind the beacon (same for every factory registry).
IMPL="$(cast call "$BEACON" "implementation()(address)" --rpc-url "$SEPOLIA_RPC_URL" 2>/dev/null || echo "")"
# No 2>/dev/null on these — an RPC failure must surface, not empty a field.
CHAIN_ID="$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")"
BLOCK="$(cast block-number --rpc-url "$SEPOLIA_RPC_URL")"
DEPLOYER_ADDR="$(cast wallet address --private-key "$DEPLOYER_KEY")"

# Refuse to write an incomplete ledger — validate every resolved field.
for pair in "factory=$FACTORY" "users=$USERS_REGISTRY" "relayers=$RELAYERS_REGISTRY" \
            "impl=$IMPL" "chainId=$CHAIN_ID" "block=$BLOCK" "deployer=$DEPLOYER_ADDR"; do
  [ -n "${pair#*=}" ] || { echo "ERROR: failed to resolve ${pair%%=*} — refusing to write an incomplete ledger" >&2; exit 1; }
done

mkdir -p "$LEDGER_DIR"

# Factory ledger (one per chain).
cat > "$LEDGER_DIR/zk-x509-factory-${CHAIN_ID}.json" <<JSON
{
  "chainId": ${CHAIN_ID},
  "deployBlock": ${BLOCK},
  "registryFactory": "${FACTORY}",
  "beacon": "${BEACON}",
  "registryImpl": "${IMPL}",
  "sp1Verifier": "${SP1_VERIFIER}",
  "programVKey": "${PROGRAM_V_KEY}",
  "owner": "${DEPLOYER_ADDR}",
  "deployer": "${DEPLOYER_ADDR}"
}
JSON

# Per-role registry ledgers. Field names kept compatible with
# gen-deployment-doc.sh (identityRegistry / identityRegistryImpl / proxyType /
# owner / maxWalletsPerCert / deployBlock).
write_role_ledger() { # $1 role  $2 registry  $3 maxWallets
  cat > "$LEDGER_DIR/zk-x509-${1}-${CHAIN_ID}.json" <<JSON
{
  "role": "${1}",
  "chainId": ${CHAIN_ID},
  "deployBlock": ${BLOCK},
  "proxyType": "BeaconProxy (via RegistryFactory)",
  "identityRegistry": "${2}",
  "identityRegistryImpl": "${IMPL}",
  "registryFactory": "${FACTORY}",
  "beacon": "${BEACON}",
  "owner": "${DEPLOYER_ADDR}",
  "maxWalletsPerCert": ${3},
  "minDisclosureMask": ${MIN_DISCLOSURE_MASK},
  "maxProofAge": ${MAX_PROOF_AGE},
  "delegatedProving": ${DELEGATED_PROVING},
  "caMerkleRoot": "${ZERO32}",
  "deployer": "${DEPLOYER_ADDR}"
}
JSON
}
write_role_ledger users "$USERS_REGISTRY" "$USERS_MAX_WALLETS"
write_role_ledger relayers "$RELAYERS_REGISTRY" "$RELAYERS_MAX_WALLETS"

echo ""
echo "[zk-x509-deploy] ✅ ledgers written to $LEDGER_DIR/"
echo "[zk-x509-deploy] RegistryFactory: $FACTORY  (chain $CHAIN_ID, block $BLOCK)"
echo "[zk-x509-deploy] Users registry:    $USERS_REGISTRY    (maxWallets $USERS_MAX_WALLETS)"
echo "[zk-x509-deploy] Relayers registry: $RELAYERS_REGISTRY  (maxWallets $RELAYERS_MAX_WALLETS)"
echo ""
echo "Paste into contracts/.env for DeploySepolia:"
echo "  SEPOLIA_IDENTITY_REGISTRY=$USERS_REGISTRY"
echo "  SEPOLIA_RELAYER_IDENTITY_REGISTRY=$RELAYERS_REGISTRY"
echo ""
echo "For the zk-X509 website (frontend/.env.local):"
echo "  NEXT_PUBLIC_FACTORY_ADDRESS=$FACTORY"
echo "  NEXT_PUBLIC_REGISTRY_ADDRESS=$USERS_REGISTRY   # or the relayers one"
echo ""
echo "Then: register CAs (addCA) on each registry so register() works."
