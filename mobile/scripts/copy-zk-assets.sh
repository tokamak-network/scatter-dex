#!/usr/bin/env bash
# Copy compiled ZK circuit files from circuits/build/ to mobile/assets/zk/
#
# Prerequisites: run circuits/scripts/build.sh first to compile circuits.
# Can be run from any directory — resolves paths relative to this script.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CIRCUITS_BUILD="$MOBILE_DIR/../circuits/build"
ASSETS_ZK="$MOBILE_DIR/assets/zk"

REQUIRED_CIRCUITS=(deposit claim authorize)

echo "=== Copying ZK circuit assets for mobile ==="

mkdir -p "$ASSETS_ZK"

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
  echo "  $circuit.wasm ($wasm_size) + ${circuit}_final.zkey ($zkey_size)"
done

echo ""
echo "=== Done. Files in $ASSETS_ZK/ ==="
ls -lh "$ASSETS_ZK/"
