#!/usr/bin/env bash
# Copy compiled ZK circuit files from circuits/build/ to the mobile asset
# folders. Two destinations:
#   - mobile/assets/zk/        — WebView prover (snarkjs in HiddenWebView)
#   - mobile/assets/zk-native/ — native prover (mopro-ffi / arkworks)
# Both must stay in lockstep with `circuits/build/` (and therefore with the
# Verifier.sol that contracts/scripts/Deploy*.s.sol just deployed). When
# only one destination is refreshed, the other path produces proofs against
# a stale verification key — the relayer accepts them at POST time (no
# off-chain verify), but the on-chain `_verifier.verifyProof(...)` returns
# false and the settle reverts with `InvalidProof()` (selector 0x09bde339).
# That self-trade-only-looking failure was actually every native-prover
# order, just hidden behind the cross-token path's "no counterparty yet"
# wait.
#
# We also refresh mobile/native-prover/test-vectors/circom/ — that's the
# directory rust_witness::transpile_wasm scans at Cargo build time, so a
# stale wasm there bakes the wrong witness function into the Rust crate.
#
# Prerequisites: run circuits/scripts/build.sh first to compile circuits.
# Can be run from any directory — resolves paths relative to this script.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CIRCUITS_BUILD="$MOBILE_DIR/../circuits/build"
ASSETS_ZK="$MOBILE_DIR/assets/zk"
ASSETS_ZK_NATIVE="$MOBILE_DIR/assets/zk-native"
NATIVE_TEST_VECTORS="$MOBILE_DIR/native-prover/test-vectors/circom"

REQUIRED_CIRCUITS=(deposit claim authorize cancel)
# Subset the native prover crate currently registers. Adding a circuit
# here also requires a matching `rust_witness::witness!(name)` +
# `set_circom_circuits!` entry in mobile/native-prover/src/lib.rs and
# a `CIRCUITS` row in mobile/src/services/NativeProverService.ts.
NATIVE_CIRCUITS=(authorize cancel)

echo "=== Copying ZK circuit assets for mobile ==="

mkdir -p "$ASSETS_ZK"
mkdir -p "$ASSETS_ZK_NATIVE"
mkdir -p "$NATIVE_TEST_VECTORS"

for circuit in "${REQUIRED_CIRCUITS[@]}"; do
  wasm="$CIRCUITS_BUILD/${circuit}_js/${circuit}.wasm"
  zkey="$CIRCUITS_BUILD/${circuit}_final.zkey"

  if [ ! -f "$wasm" ]; then
    echo "ERROR: $wasm not found. Run circuits/scripts/build.sh first."
    exit 1
  fi
  if [ ! -f "$zkey" ]; then
    echo "ERROR: $zkey not found. Run circuits/scripts/build.sh first."
    exit 1
  fi

  cp "$wasm" "$ASSETS_ZK/${circuit}.wasm"
  cp "$zkey" "$ASSETS_ZK/${circuit}_final.zkey"

  wasm_size=$(du -h "$ASSETS_ZK/${circuit}.wasm" | awk '{print $1}')
  zkey_size=$(du -h "$ASSETS_ZK/${circuit}_final.zkey" | awk '{print $1}')
  echo "  [webview]  $circuit.wasm ($wasm_size) + ${circuit}_final.zkey ($zkey_size)"

  # Native-prover destinations: only the circuits the Rust crate actually
  # registers via `witness!(name)`. Keeping the list explicit (vs blanket
  # copying) means a circuit listed in `REQUIRED_CIRCUITS` but not yet
  # wired into the native crate is still refreshed for the WebView path.
  for native_circuit in "${NATIVE_CIRCUITS[@]}"; do
    if [ "$native_circuit" = "$circuit" ]; then
      cp "$zkey" "$ASSETS_ZK_NATIVE/${circuit}_final.zkey"
      cp "$wasm" "$NATIVE_TEST_VECTORS/${circuit}.wasm"
      cp "$zkey" "$NATIVE_TEST_VECTORS/${circuit}_final.zkey"
      echo "  [native]   ${circuit}_final.zkey + ${circuit}.wasm (test-vectors)"
    fi
  done
done

echo ""
echo "=== Done. Files in $ASSETS_ZK/ ==="
ls -lh "$ASSETS_ZK/"
echo ""
echo "=== Files in $ASSETS_ZK_NATIVE/ ==="
ls -lh "$ASSETS_ZK_NATIVE/"
