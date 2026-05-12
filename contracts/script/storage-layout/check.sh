#!/usr/bin/env bash
# Re-run forge inspect for each upgradeable contract and diff against
# the committed baseline in storage-layouts/. Exits non-zero (CI fail)
# if anything has drifted — that's how we catch a slot shift before
# it makes it into a production upgrade.
#
# We normalise out `astId` and `contract` before diffing because both
# change on unrelated source edits / solc bumps and would otherwise
# cause noisy false-positive CI failures. The fields that actually
# matter for upgrade safety (label, slot, offset, type) are preserved.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/storage-layouts"

CONTRACTS=(
  FeeVault
)

normalize() {
  jq '{storage: [.storage[] | {label: .label, offset: .offset, slot: .slot, type: .type}], types: .types}'
}

fail=0
for c in "${CONTRACTS[@]}"; do
  expected="$OUT/$c.json"
  if [[ ! -f "$expected" ]]; then
    echo "✗ baseline missing: $expected"
    fail=1
    continue
  fi
  expected_norm="$(normalize < "$expected")"
  actual_norm="$(forge inspect "$c" storage --json | normalize)"
  if ! diff -u <(echo "$expected_norm") <(echo "$actual_norm") >/dev/null; then
    echo "✗ $c storage layout drifted"
    diff -u <(echo "$expected_norm") <(echo "$actual_norm") || true
    fail=1
  else
    echo "✓ $c"
  fi
done

exit "$fail"
