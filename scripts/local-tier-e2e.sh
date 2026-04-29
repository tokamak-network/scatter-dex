#!/usr/bin/env bash
# Validate the multi-tier verifier registry against a live local node.
#
# Run-once smoke test that proves the dispatch wiring shipped in
# `feat/multi-tier-circuits-foundation` (PR #528) works against
# real deployed bytecode — not just forge mocks. Exercises the
# tier 16 / 64 / 128 slots for both authorize + claim verifier
# registries and the disable / restore round-trip.
#
# Usage:
#   anvil --silent &                         # in another shell
#   forge script script/DeployLocal.s.sol \  # in contracts/
#     --tc DeployLocal --rpc-url http://localhost:8545 --broadcast \
#     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
#   ./scripts/local-tier-e2e.sh \
#     --settlement 0x... \
#     --tier16-authorize 0x... \
#     --tier16-claim 0x...
#
# Anvil's deterministic accounts are used so the same script runs
# against any fresh deploy. Defaults match the addresses produced by
# DeployLocal.s.sol on a fresh `anvil --silent` boot.
set -euo pipefail

RPC=${RPC:-http://localhost:8545}
KEY=${KEY:-0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80}

SETTLE=${SETTLE:-}
TIER16_AUTHORIZE=${TIER16_AUTHORIZE:-}
TIER16_CLAIM=${TIER16_CLAIM:-}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --settlement)        SETTLE=$2;          shift 2 ;;
    --tier16-authorize)  TIER16_AUTHORIZE=$2; shift 2 ;;
    --tier16-claim)      TIER16_CLAIM=$2;    shift 2 ;;
    --rpc)               RPC=$2;             shift 2 ;;
    *) echo "unknown arg: $1"; exit 64 ;;
  esac
done

if [[ -z "$SETTLE" || -z "$TIER16_AUTHORIZE" || -z "$TIER16_CLAIM" ]]; then
  echo "Missing required addresses. Pass --settlement / --tier16-authorize / --tier16-claim or set env vars." >&2
  exit 64
fi

ZERO=0x0000000000000000000000000000000000000000

step()  { printf "\n\033[1m== %s ==\033[0m\n" "$1"; }
expect() {
  # Compare lowercased addresses so cast's checksum casing doesn't break
  # equality against arguments the user paste-pasted in lower or mixed case.
  local actual=${1,,}
  local want=${2,,}
  local label=$3
  if [[ "$actual" != "$want" ]]; then
    printf "FAIL [%s]: expected %s, got %s\n" "$label" "$want" "$actual" >&2
    exit 1
  fi
  printf "  ok  %s -> %s\n" "$label" "$actual"
}

step "Read tier 16 — wired by constructor + setAuthorizeVerifier(16, _)"
expect "$(cast call "$SETTLE" 'authorizeVerifierByTier(uint8)(address)' 16 --rpc-url "$RPC")" \
       "$TIER16_AUTHORIZE" "authorizeVerifierByTier(16)"
expect "$(cast call "$SETTLE" 'claimVerifierByTier(uint8)(address)' 16 --rpc-url "$RPC")" \
       "$TIER16_CLAIM" "claimVerifierByTier(16)"

step "Tier 64 / 128 unconfigured by default"
expect "$(cast call "$SETTLE" 'authorizeVerifierByTier(uint8)(address)' 64  --rpc-url "$RPC")" $ZERO "authorizeVerifierByTier(64)"
expect "$(cast call "$SETTLE" 'authorizeVerifierByTier(uint8)(address)' 128 --rpc-url "$RPC")" $ZERO "authorizeVerifierByTier(128)"
expect "$(cast call "$SETTLE" 'claimVerifierByTier(uint8)(address)' 64  --rpc-url "$RPC")" $ZERO "claimVerifierByTier(64)"
expect "$(cast call "$SETTLE" 'claimVerifierByTier(uint8)(address)' 128 --rpc-url "$RPC")" $ZERO "claimVerifierByTier(128)"

step "Owner registers tier 64 — verifies setter writes both registries"
cast send "$SETTLE" 'setAuthorizeVerifier(uint8,address)' 64 "$TIER16_AUTHORIZE" \
  --rpc-url "$RPC" --private-key "$KEY" >/dev/null
cast send "$SETTLE" 'setClaimVerifier(uint8,address)' 64 "$TIER16_CLAIM" \
  --rpc-url "$RPC" --private-key "$KEY" >/dev/null
expect "$(cast call "$SETTLE" 'authorizeVerifierByTier(uint8)(address)' 64 --rpc-url "$RPC")" "$TIER16_AUTHORIZE" "authorizeVerifierByTier(64) after register"
expect "$(cast call "$SETTLE" 'claimVerifierByTier(uint8)(address)' 64 --rpc-url "$RPC")"     "$TIER16_CLAIM"     "claimVerifierByTier(64) after register"

step "Disable + restore round-trip on tier 16"
cast send "$SETTLE" 'setAuthorizeVerifier(uint8,address)' 16 "$ZERO" \
  --rpc-url "$RPC" --private-key "$KEY" >/dev/null
expect "$(cast call "$SETTLE" 'authorizeVerifierByTier(uint8)(address)' 16 --rpc-url "$RPC")" $ZERO "authorizeVerifierByTier(16) after disable"
cast send "$SETTLE" 'setAuthorizeVerifier(uint8,address)' 16 "$TIER16_AUTHORIZE" \
  --rpc-url "$RPC" --private-key "$KEY" >/dev/null
expect "$(cast call "$SETTLE" 'authorizeVerifierByTier(uint8)(address)' 16 --rpc-url "$RPC")" "$TIER16_AUTHORIZE" "authorizeVerifierByTier(16) restored"

printf "\n\033[1;32mAll tier-registry checks passed against %s\033[0m\n" "$SETTLE"
