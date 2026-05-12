#!/usr/bin/env bash
# Re-run forge inspect for each upgradeable contract and diff against
# the committed baseline in storage-layouts/. Exits non-zero (CI fail)
# if anything has drifted — that's how we catch a slot shift before
# it makes it into a production upgrade.
#
# We normalise out `astId`, `contract`, and AST node ids embedded in
# type identifiers (e.g. `t_contract(IFoo)2357` → `t_contract(IFoo)`)
# before diffing. All three churn on unrelated source edits / solc
# bumps but don't change the actual storage layout. The fields that
# matter for upgrade safety (label, slot, offset, normalised type) are
# preserved — a real slot shift still surfaces.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/storage-layouts"

CONTRACTS=(
  FeeVault
  SanctionsList
  IdentityGate
  RelayerRegistry
  CommitmentPool
  PrivateSettlement
)

normalize() {
  # Pass 1 (jq): keep only slot-meaningful fields and the types table.
  # Pass 2 (sed): strip the trailing AST node id baked into type identifiers
  #               (e.g. `t_contract(IFoo)2357` → `t_contract(IFoo)`).
  jq '{storage: [.storage[] | {label: .label, offset: .offset, slot: .slot, type: .type}], types: .types}' \
    | sed -E 's/(t_contract\([^)]+\))[0-9]+/\1/g; s/(t_userDefinedValueType\([^)]+\))[0-9]+/\1/g; s/(t_enum\([^)]+\))[0-9]+/\1/g; s/(t_struct\([^)]+\))[0-9]+/\1/g'
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
