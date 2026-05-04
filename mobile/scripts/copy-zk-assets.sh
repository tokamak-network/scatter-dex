#!/usr/bin/env bash
# Copy compiled ZK circuit files from circuits/build/ into the mobile
# native-prover destinations:
#   - mobile/assets/zk-native/                — bundled into the APK
#                                                for `expo-asset` to
#                                                extract on first use
#   - mobile/native-prover/test-vectors/circom — scanned by
#                                                `rust_witness::transpile_wasm`
#                                                at Cargo build time
# Both must stay in lockstep with `circuits/build/` (and therefore with
# the Verifier.sol that contracts/scripts/Deploy*.s.sol just deployed).
# A stale destination produces proofs against a verification key the
# chain has already moved past — the relayer accepts the order at POST
# time (no off-chain verify), but the on-chain
# `_verifier.verifyProof(...)` returns false and settle reverts with
# `InvalidProof()` (selector `0x09bde339`).
#
# Phase C-4 dropped the WebView prover; mobile/assets/zk/ is no longer
# populated here — every circuit consumer goes through
# `NativeProverService.generateNativeProof`.
#
# Prerequisites: run circuits/scripts/build.sh first to compile the
# circuits. This script can be run from any directory — paths are
# resolved relative to the script itself.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CIRCUITS_BUILD="$MOBILE_DIR/../circuits/build"
ASSETS_ZK_NATIVE="$MOBILE_DIR/assets/zk-native"
NATIVE_TEST_VECTORS="$MOBILE_DIR/native-prover/test-vectors/circom"

# Circuits the native prover crate registers. Adding one here also
# requires a matching `rust_witness::witness!(name)` +
# `set_circom_circuits!` entry in mobile/native-prover/src/lib.rs and
# a `CIRCUITS` row in mobile/src/services/NativeProverService.ts.
# Tier-16 only. The web frontends (apps/pay, apps/pro, frontend/)
# also ship `authorize_64` / `authorize_128` / `claim_64` / `claim_128`
# for the multi-tier rollout, but mobile does NOT bundle those
# tiers — adding ~140 MB of zkey to the APK is not viable, and the
# higher-tier prove time pushes past the foreground-UX budget on
# mobile-class hardware. See `mobile/assets/zk/README.md` for the
# full policy and the conditions that would let us reconsider.
CIRCUITS=(authorize cancel claim deposit withdraw)

echo "=== Copying ZK circuit assets for mobile (native prover) ==="

mkdir -p "$ASSETS_ZK_NATIVE"
mkdir -p "$NATIVE_TEST_VECTORS"

for circuit in "${CIRCUITS[@]}"; do
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

  cp "$zkey" "$ASSETS_ZK_NATIVE/${circuit}_final.zkey"
  cp "$wasm" "$NATIVE_TEST_VECTORS/${circuit}.wasm"
  cp "$zkey" "$NATIVE_TEST_VECTORS/${circuit}_final.zkey"

  zkey_size=$(du -h "$ASSETS_ZK_NATIVE/${circuit}_final.zkey" | awk '{print $1}')
  wasm_size=$(du -h "$NATIVE_TEST_VECTORS/${circuit}.wasm" | awk '{print $1}')
  echo "  $circuit: zkey ($zkey_size) → assets/zk-native, wasm ($wasm_size) → test-vectors"
done

echo ""
echo "=== Files in $ASSETS_ZK_NATIVE/ ==="
ls -lh "$ASSETS_ZK_NATIVE/"
