#!/usr/bin/env bash
# Re-run forge inspect for each upgradeable contract and diff against
# the committed baseline in storage-layouts/. Exits non-zero (CI fail)
# if anything has drifted — that's how we catch a slot shift before
# it makes it into a production upgrade.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/storage-layouts"

CONTRACTS=(
  FeeVault
)

fail=0
for c in "${CONTRACTS[@]}"; do
  expected="$OUT/$c.json"
  if [[ ! -f "$expected" ]]; then
    echo "✗ baseline missing: $expected"
    fail=1
    continue
  fi
  actual="$(forge inspect "$c" storage --json)"
  if ! diff -u "$expected" <(echo "$actual") >/dev/null; then
    echo "✗ $c storage layout drifted"
    diff -u "$expected" <(echo "$actual") || true
    fail=1
  else
    echo "✓ $c"
  fi
done

exit "$fail"
