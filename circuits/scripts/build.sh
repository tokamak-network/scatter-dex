#!/bin/bash
set -e

cd "$(dirname "$0")/.."

BUILD=build
SNARKJS=./node_modules/.bin/snarkjs
PTAU_SIZE=14  # 2^14 = 16384 constraints (enough for ~6K)

# Circuits to build: withdraw, settle, claim
CIRCUITS=(withdraw settle claim)

echo "=== ZK Circuit Build ==="
echo ""

# 1. Powers of Tau (Phase 1) — shared across all circuits
if [ ! -f "$BUILD/pot${PTAU_SIZE}_final.ptau" ]; then
  echo "[Phase 1] Powers of Tau ceremony..."
  mkdir -p "$BUILD"
  $SNARKJS powersoftau new bn128 $PTAU_SIZE "$BUILD/pot${PTAU_SIZE}_0000.ptau" -v
  $SNARKJS powersoftau contribute "$BUILD/pot${PTAU_SIZE}_0000.ptau" "$BUILD/pot${PTAU_SIZE}_0001.ptau" \
    --name="Dev contribution" -v -e="scatter-dex-dev-entropy-$(date +%s)"
  $SNARKJS powersoftau prepare phase2 "$BUILD/pot${PTAU_SIZE}_0001.ptau" "$BUILD/pot${PTAU_SIZE}_final.ptau" -v
  rm -f "$BUILD/pot${PTAU_SIZE}_0000.ptau" "$BUILD/pot${PTAU_SIZE}_0001.ptau"
  echo "  Powers of Tau ready."
else
  echo "[Phase 1] Powers of Tau already exists, skipping."
fi

# Map circuit name → Solidity verifier contract name
declare -A VERIFIER_NAMES
VERIFIER_NAMES[withdraw]="WithdrawVerifier"
VERIFIER_NAMES[settle]="SettleVerifier"
VERIFIER_NAMES[claim]="ClaimVerifier"

for CIRCUIT in "${CIRCUITS[@]}"; do
  VERIFIER_NAME="${VERIFIER_NAMES[$CIRCUIT]}"
  echo ""
  echo "─── Building circuit: ${CIRCUIT} ───"

  # 2. Compile circuit
  echo "  [1/4] Compiling ${CIRCUIT}.circom..."
  mkdir -p "$BUILD"
  circom "${CIRCUIT}.circom" --r1cs --wasm --sym -o "$BUILD/"

  # 3. Circuit-specific setup (Phase 2)
  echo "  [2/4] Circuit-specific setup (Phase 2)..."
  $SNARKJS groth16 setup "$BUILD/${CIRCUIT}.r1cs" "$BUILD/pot${PTAU_SIZE}_final.ptau" "$BUILD/${CIRCUIT}_0000.zkey"
  $SNARKJS zkey contribute "$BUILD/${CIRCUIT}_0000.zkey" "$BUILD/${CIRCUIT}_final.zkey" \
    --name="Dev contribution" -v -e="scatter-circuit-dev-$(date +%s)"
  rm -f "$BUILD/${CIRCUIT}_0000.zkey"

  # 4. Export verification key
  echo "  [3/4] Exporting verification key..."
  $SNARKJS zkey export verificationkey "$BUILD/${CIRCUIT}_final.zkey" "$BUILD/${CIRCUIT}_vkey.json"

  # 5. Export Solidity verifier
  echo "  [4/4] Generating Solidity verifier..."
  $SNARKJS zkey export solidityverifier "$BUILD/${CIRCUIT}_final.zkey" "$BUILD/${VERIFIER_NAME}.sol"

  # Copy to contracts
  cp "$BUILD/${VERIFIER_NAME}.sol" "../contracts/src/zk/${VERIFIER_NAME}.sol"
  echo "  Copied to contracts/src/zk/${VERIFIER_NAME}.sol"
done

# 6. Copy WASM + zkey for frontend
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
for CIRCUIT in "${CIRCUITS[@]}"; do
  VERIFIER_NAME="${VERIFIER_NAMES[$CIRCUIT]}"
  echo "  Circuit:    ${CIRCUIT}.circom"
  echo "  R1CS:       $BUILD/${CIRCUIT}.r1cs"
  echo "  WASM:       $BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm"
  echo "  zkey:       $BUILD/${CIRCUIT}_final.zkey"
  echo "  Verifier:   contracts/src/zk/${VERIFIER_NAME}.sol"
done
