#!/usr/bin/env bash
set -e

cd "$(dirname "$0")/.."

BUILD=build
SNARKJS=./node_modules/.bin/snarkjs

# Circuits to build: deposit, withdraw, settle, claim, authorize, cancel
CIRCUITS=(deposit withdraw settle claim authorize cancel)

# Map circuit name → Solidity verifier contract name.
# Kept as a function (rather than an associative array) so the script
# runs under bash 3.2, which is what macOS ships as /bin/bash.
verifier_name_for() {
  case "$1" in
    deposit)   echo "DepositVerifier" ;;
    withdraw)  echo "WithdrawVerifier" ;;
    settle)    echo "SettleVerifier" ;;
    claim)     echo "ClaimVerifier" ;;
    authorize) echo "AuthorizeVerifier" ;;
    cancel)    echo "CancelVerifier" ;;
    *) echo "ERROR: no verifier mapping for circuit '$1'" >&2; return 1 ;;
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

for CIRCUIT in "${CIRCUITS[@]}"; do
  VERIFIER_NAME=$(verifier_name_for "$CIRCUIT")
  echo ""
  echo "─── Building circuit: ${CIRCUIT} ───"

  # 1. Compile circuit
  echo "  [1/5] Compiling ${CIRCUIT}.circom..."
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
  echo "  [2/5] Circuit has $CONSTRAINTS constraints → needs pot$PTAU_SIZE (2^$PTAU_SIZE = $((2**PTAU_SIZE)))"

  # 3. Ensure PTAU file exists
  ensure_ptau "$PTAU_SIZE"

  # 4. Circuit-specific setup (Phase 2)
  echo "  [3/5] Circuit-specific setup (Phase 2)..."
  $SNARKJS groth16 setup "$BUILD/${CIRCUIT}.r1cs" "$BUILD/pot${PTAU_SIZE}_final.ptau" "$BUILD/${CIRCUIT}_0000.zkey"
  $SNARKJS zkey contribute "$BUILD/${CIRCUIT}_0000.zkey" "$BUILD/${CIRCUIT}_final.zkey" \
    --name="Dev contribution" -v -e="scatter-circuit-dev-$(date +%s)"
  rm -f "$BUILD/${CIRCUIT}_0000.zkey"

  # 5. Export verification key
  echo "  [4/5] Exporting verification key..."
  $SNARKJS zkey export verificationkey "$BUILD/${CIRCUIT}_final.zkey" "$BUILD/${CIRCUIT}_vkey.json"

  # 6. Export Solidity verifier
  echo "  [5/5] Generating Solidity verifier..."
  $SNARKJS zkey export solidityverifier "$BUILD/${CIRCUIT}_final.zkey" "$BUILD/${VERIFIER_NAME}.sol"

  # Copy to contracts
  cp "$BUILD/${VERIFIER_NAME}.sol" "../contracts/src/zk/${VERIFIER_NAME}.sol"
  echo "  Copied to contracts/src/zk/${VERIFIER_NAME}.sol"
done

# Copy WASM + zkey for frontend
echo ""
echo "Copying artifacts for frontend..."
mkdir -p "../frontend/public/zk"
for CIRCUIT in "${CIRCUITS[@]}"; do
  cp "$BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm" "../frontend/public/zk/"
  cp "$BUILD/${CIRCUIT}_final.zkey" "../frontend/public/zk/"
done
echo "  Copied .wasm and .zkey to frontend/public/zk/"

echo ""
echo "=== Build complete ==="
for i in "${!CIRCUITS[@]}"; do
  CIRCUIT="${CIRCUITS[$i]}"
  VERIFIER_NAME=$(verifier_name_for "$CIRCUIT")
  echo "  Circuit:       ${CIRCUIT}.circom (${CONSTRAINT_COUNTS[$i]} constraints)"
  echo "  WASM:          $BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm"
  echo "  zkey:          $BUILD/${CIRCUIT}_final.zkey"
  echo "  Verifier:      contracts/src/zk/${VERIFIER_NAME}.sol"
done
