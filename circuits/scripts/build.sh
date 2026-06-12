#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

BUILD=build
SNARKJS=./node_modules/.bin/snarkjs

# Circuits to build. The authorize / claim circuits are split per
# tier (16 / 64 / 128) — same template body, different
# `component main` parameters in each wrapper file. Tier-16 keeps the
# legacy filename (`authorize` / `claim`) so existing deploys don't
# need a rename; higher tiers compile to `authorize_<cap>` /
# `claim_<cap>`.
CIRCUITS=(
  deposit
  withdraw
  claim
  claim_64
  claim_128
  authorize
  authorize_64
  authorize_128
  cancel
)

# Map circuit name → Solidity verifier contract name.
# Kept as a function (rather than an associative array) so the script
# runs under bash 3.2, which is what macOS ships as /bin/bash.
verifier_name_for() {
  case "$1" in
    deposit)        printf "DepositVerifier\n" ;;
    withdraw)       printf "WithdrawVerifier\n" ;;
    claim)          printf "ClaimVerifier\n" ;;
    claim_64)       printf "ClaimVerifier_64\n" ;;
    claim_128)      printf "ClaimVerifier_128\n" ;;
    authorize)      printf "AuthorizeVerifier\n" ;;
    authorize_64)   printf "AuthorizeVerifier_64\n" ;;
    authorize_128)  printf "AuthorizeVerifier_128\n" ;;
    cancel)         printf "CancelVerifier\n" ;;
    *) printf "ERROR: no verifier mapping for circuit '%s'\n" "$1" >&2; return 1 ;;
  esac
}

echo "=== ZK Circuit Build ==="
echo ""

# Determine required PTAU size for a given number of constraints.
# PTAU must be >= ceil(log2(constraints)).
MIN_PTAU=14  # minimum PTAU size (2^14 = 16,384)

required_ptau() {
  local constraints="$1"
  local size=0
  local power=1
  while [ "$power" -lt "$constraints" ]; do
    size=$((size + 1))
    power=$((power * 2))
  done
  # Enforce minimum
  if [ "$size" -lt "$MIN_PTAU" ]; then
    size=$MIN_PTAU
  fi
  echo "$size"
}

# Export the vkey JSON + Solidity verifier for a circuit from its zkey.
# Both are deterministic functions of the zkey, so they're refreshed only
# when missing or older than the zkey — a no-op build then skips 9
# snarkjs startups and doesn't dirty file-watchers (the contracts copy
# is also skipped when byte-identical).
export_verifier_artifacts() {
  local zkey="$1" circuit="$2" verifier_name="$3"
  if [ ! -f "$BUILD/${circuit}_vkey.json" ] || [ "$zkey" -nt "$BUILD/${circuit}_vkey.json" ]; then
    $SNARKJS zkey export verificationkey "$zkey" "$BUILD/${circuit}_vkey.json"
  fi
  if [ ! -f "$BUILD/${verifier_name}.sol" ] || [ "$zkey" -nt "$BUILD/${verifier_name}.sol" ]; then
    $SNARKJS zkey export solidityverifier "$zkey" "$BUILD/${verifier_name}.sol"
  fi
  if ! cmp -s "$BUILD/${verifier_name}.sol" "../contracts/src/zk/${verifier_name}.sol"; then
    cp "$BUILD/${verifier_name}.sol" "../contracts/src/zk/${verifier_name}.sol"
    echo "  Copied to contracts/src/zk/${verifier_name}.sol"
  fi
}

# Ensure a Powers of Tau file of the given size exists.
ensure_ptau() {
  local size="$1"
  local ptau_file="$BUILD/pot${size}_final.ptau"

  if [ -f "$ptau_file" ]; then
    echo "  Powers of Tau (2^$size) already exists."
    return
  fi

  echo "  [Phase 1] Generating Powers of Tau (2^$size = $((2**size)))..."
  mkdir -p "$BUILD"
  $SNARKJS powersoftau new bn128 "$size" "$BUILD/pot${size}_0000.ptau" -v
  $SNARKJS powersoftau contribute "$BUILD/pot${size}_0000.ptau" "$BUILD/pot${size}_0001.ptau" \
    --name="Dev contribution" -v -e="scatter-dex-dev-entropy-$(date +%s)"
  $SNARKJS powersoftau prepare phase2 "$BUILD/pot${size}_0001.ptau" "$ptau_file" -v
  rm -f "$BUILD/pot${size}_0000.ptau" "$BUILD/pot${size}_0001.ptau"
  echo "  Powers of Tau (2^$size) ready."
}

# Parallel to CIRCUITS — CONSTRAINT_COUNTS[$i] holds the constraint count
# for CIRCUITS[$i]. Kept as a positional array for bash 3.2 compatibility.
CONSTRAINT_COUNTS=()

# Reuse-don't-regenerate: Groth16 phase-2 setup draws fresh entropy on
# every run, so rebuilding an existing zkey silently replaces the
# canonical artifact set that pairs with the verifiers deployed on live
# networks (circuits/zk-manifest.json is the canonical fingerprint; the
# 2026-06-11 mock run that clobbered every zkey is the cautionary tale).
# A local stack never needs a fresh setup — exporting Verifier.sol from
# the *existing* zkey (done below in both paths) already guarantees the
# zkey ↔ Verifier.sol pairing that the old always-rebuild behavior was
# protecting. Phase-2 setup therefore runs only when the zkey is missing
# or explicitly requested with FORCE_CIRCUIT_SETUP=1. Forcing mints a
# new artifact set: it must be committed, pushed to the GCS bucket, and
# the on-chain verifiers redeployed — otherwise every proof reverts
# InvalidProof().
FORCE_CIRCUIT_SETUP="${FORCE_CIRCUIT_SETUP:-0}"

for CIRCUIT in "${CIRCUITS[@]}"; do
  VERIFIER_NAME=$(verifier_name_for "$CIRCUIT")
  ZKEY="$BUILD/${CIRCUIT}_final.zkey"
  echo ""

  if [ -f "$ZKEY" ] && [ "$FORCE_CIRCUIT_SETUP" != "1" ]; then
    echo "─── Reusing circuit: ${CIRCUIT} (zkey exists; FORCE_CIRCUIT_SETUP=1 to regenerate) ───"
    # Reuse assumes the circuit source is unchanged: only compile when
    # outputs are missing (recompiling over a kept zkey could pair a
    # newer wasm with an older proving key), and warn when a .circom
    # file is newer than the kept zkey so a real circuit change isn't
    # silently proven against a stale key.
    if [ -n "$(find . -name '*.circom' -newer "$ZKEY" -not -path './node_modules/*' 2>/dev/null | head -1)" ]; then
      echo "  WARNING: a .circom source is newer than the kept zkey — if the"
      echo "           circuit logic changed, rerun with FORCE_CIRCUIT_SETUP=1."
    fi
    if [ ! -f "$BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm" ] || [ ! -f "$BUILD/${CIRCUIT}.r1cs" ]; then
      echo "  Compiling ${CIRCUIT}.circom (missing wasm/r1cs)..."
      mkdir -p "$BUILD"
      circom "${CIRCUIT}.circom" --r1cs --wasm --sym -o "$BUILD/"
    fi
    CONSTRAINT_COUNTS+=("reused")
    export_verifier_artifacts "$ZKEY" "$CIRCUIT" "$VERIFIER_NAME"
    continue
  fi

  echo "─── Building circuit: ${CIRCUIT} ───"
  if [ -f "$ZKEY" ]; then
    echo "  WARNING: FORCE_CIRCUIT_SETUP=1 — overwriting the existing zkey."
    echo "           The new set must be committed/distributed and the"
    echo "           on-chain verifiers redeployed, or proofs will revert"
    echo "           InvalidProof()."
  fi

  # 1. Compile circuit
  echo "  [1/4] Compiling ${CIRCUIT}.circom..."
  mkdir -p "$BUILD"
  circom "${CIRCUIT}.circom" --r1cs --wasm --sym -o "$BUILD/"

  # 2. Determine required PTAU size from constraint count
  CONSTRAINTS=$($SNARKJS r1cs info "$BUILD/${CIRCUIT}.r1cs" 2>&1 | grep "Constraints" | awk '{print $NF}')
  if ! [[ "$CONSTRAINTS" =~ ^[0-9]+$ ]]; then
    echo "  ERROR: failed to parse constraint count for ${CIRCUIT} (got: '$CONSTRAINTS')"
    exit 1
  fi
  CONSTRAINT_COUNTS+=("$CONSTRAINTS")
  PTAU_SIZE=$(required_ptau "$CONSTRAINTS")
  echo "  [2/4] Circuit has $CONSTRAINTS constraints → needs pot$PTAU_SIZE (2^$PTAU_SIZE = $((2**PTAU_SIZE)))"

  # 3. Ensure PTAU file exists
  ensure_ptau "$PTAU_SIZE"

  # 4. Circuit-specific setup (Phase 2)
  echo "  [3/4] Circuit-specific setup (Phase 2)..."
  $SNARKJS groth16 setup "$BUILD/${CIRCUIT}.r1cs" "$BUILD/pot${PTAU_SIZE}_final.ptau" "$BUILD/${CIRCUIT}_0000.zkey"
  $SNARKJS zkey contribute "$BUILD/${CIRCUIT}_0000.zkey" "$BUILD/${CIRCUIT}_final.zkey" \
    --name="Dev contribution" -v -e="scatter-circuit-dev-$(date +%s)"
  rm -f "$BUILD/${CIRCUIT}_0000.zkey"

  # 5. Export verification key + Solidity verifier, copy to contracts
  echo "  [4/4] Exporting verification key + Solidity verifier..."
  export_verifier_artifacts "$ZKEY" "$CIRCUIT" "$VERIFIER_NAME"
done

# Copy WASM + zkey to every consumer surface. apps/pro is the
# shipping Pro product (real ZK in workers); frontend/ is the
# reference implementation kept in lock-step until apps/pro reaches
# parity. Apps/pay and apps/drop will be added here when their
# circuit-driven flows ship.
echo ""
echo "Copying artifacts to consumer surfaces..."
TARGETS=("../frontend/public/zk" "../apps/pro/public/zk")
for TARGET in "${TARGETS[@]}"; do
  mkdir -p "$TARGET"
done
for CIRCUIT in "${CIRCUITS[@]}"; do
  for TARGET in "${TARGETS[@]}"; do
    cp "$BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm" "$TARGET/"
    cp "$BUILD/${CIRCUIT}_final.zkey" "$TARGET/"
  done
done
echo "  Copied .wasm and .zkey to:"
for TARGET in "${TARGETS[@]}"; do
  echo "    $TARGET/"
done

# Sync BatchAuthorizeVerifier (hand-written aggregator that can't be
# re-exported via snarkjs) with the freshly-built authorize zkey. Skip
# silently when the authorize circuit wasn't part of this build run —
# the script reads the vkey from either `authorize_vkey.json` (step 5
# above) or `authorize_final.zkey` directly, so gate on the zkey since
# that's the underlying prerequisite for both code paths.
if [ -f "$BUILD/authorize_final.zkey" ]; then
  echo ""
  echo "Syncing BatchAuthorizeVerifier with authorize zkey..."
  node "$(dirname "$0")/sync-batch-verifier-vk.mjs"
fi

echo ""
echo "=== Build complete ==="
for i in "${!CIRCUITS[@]}"; do
  CIRCUIT="${CIRCUITS[$i]}"
  VERIFIER_NAME=$(verifier_name_for "$CIRCUIT")
  if [ "${CONSTRAINT_COUNTS[$i]}" = "reused" ]; then
    echo "  Circuit:       ${CIRCUIT}.circom (existing zkey reused)"
  else
    echo "  Circuit:       ${CIRCUIT}.circom (${CONSTRAINT_COUNTS[$i]} constraints)"
  fi
  echo "  WASM:          $BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm"
  echo "  zkey:          $BUILD/${CIRCUIT}_final.zkey"
  echo "  Verifier:      contracts/src/zk/${VERIFIER_NAME}.sol"
done
