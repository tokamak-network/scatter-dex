#!/bin/bash
set -e

cd "$(dirname "$0")/.."

CIRCUIT=withdraw
BUILD=build
SNARKJS=./node_modules/.bin/snarkjs
PTAU_SIZE=14  # 2^14 = 16384 constraints (enough for ~6K)

echo "=== ZK Circuit Build ==="
echo ""

# 1. Compile circuit
echo "[1/6] Compiling circuit..."
mkdir -p "$BUILD"
circom "${CIRCUIT}.circom" --r1cs --wasm --sym -o "$BUILD/"
echo "  Constraints: $(grep -o 'non-linear constraints: [0-9]*' /dev/stdin <<< "$(circom "${CIRCUIT}.circom" --r1cs -o "$BUILD/" 2>&1)" | grep -o '[0-9]*' || echo "see above")"

# 2. Powers of Tau (Phase 1)
if [ ! -f "$BUILD/pot${PTAU_SIZE}_final.ptau" ]; then
  echo ""
  echo "[2/6] Powers of Tau ceremony (Phase 1)..."
  $SNARKJS powersoftau new bn128 $PTAU_SIZE "$BUILD/pot${PTAU_SIZE}_0000.ptau" -v
  $SNARKJS powersoftau contribute "$BUILD/pot${PTAU_SIZE}_0000.ptau" "$BUILD/pot${PTAU_SIZE}_0001.ptau" \
    --name="Dev contribution" -v -e="scatter-dex-dev-entropy-$(date +%s)"
  $SNARKJS powersoftau prepare phase2 "$BUILD/pot${PTAU_SIZE}_0001.ptau" "$BUILD/pot${PTAU_SIZE}_final.ptau" -v
  rm -f "$BUILD/pot${PTAU_SIZE}_0000.ptau" "$BUILD/pot${PTAU_SIZE}_0001.ptau"
  echo "  Powers of Tau ready."
else
  echo ""
  echo "[2/6] Powers of Tau already exists, skipping."
fi

# 3. Circuit-specific setup (Phase 2)
echo ""
echo "[3/6] Circuit-specific setup (Phase 2)..."
$SNARKJS groth16 setup "$BUILD/${CIRCUIT}.r1cs" "$BUILD/pot${PTAU_SIZE}_final.ptau" "$BUILD/${CIRCUIT}_0000.zkey"
$SNARKJS zkey contribute "$BUILD/${CIRCUIT}_0000.zkey" "$BUILD/${CIRCUIT}_final.zkey" \
  --name="Dev contribution" -v -e="scatter-circuit-dev-$(date +%s)"
rm -f "$BUILD/${CIRCUIT}_0000.zkey"

# 4. Export verification key
echo ""
echo "[4/6] Exporting verification key..."
$SNARKJS zkey export verificationkey "$BUILD/${CIRCUIT}_final.zkey" "$BUILD/${CIRCUIT}_vkey.json"

# 5. Export Solidity verifier
echo ""
echo "[5/6] Generating Solidity verifier..."
$SNARKJS zkey export solidityverifier "$BUILD/${CIRCUIT}_final.zkey" "$BUILD/WithdrawVerifier.sol"

# Copy to contracts
cp "$BUILD/WithdrawVerifier.sol" "../contracts/src/zk/WithdrawVerifier.sol"
echo "  Copied to contracts/src/zk/WithdrawVerifier.sol"

# 6. Copy WASM + zkey for frontend
echo ""
echo "[6/6] Copying artifacts for frontend..."
mkdir -p "../frontend/public/zk"
cp "$BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm" "../frontend/public/zk/"
cp "$BUILD/${CIRCUIT}_final.zkey" "../frontend/public/zk/"
echo "  Copied .wasm and .zkey to frontend/public/zk/"

echo ""
echo "=== Build complete ==="
echo "  Circuit:    ${CIRCUIT}.circom"
echo "  R1CS:       $BUILD/${CIRCUIT}.r1cs"
echo "  WASM:       $BUILD/${CIRCUIT}_js/${CIRCUIT}.wasm"
echo "  zkey:       $BUILD/${CIRCUIT}_final.zkey"
echo "  Verifier:   contracts/src/zk/WithdrawVerifier.sol"
