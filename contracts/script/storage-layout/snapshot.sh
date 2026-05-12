#!/usr/bin/env bash
# Snapshot storage layout for each upgradeable contract.
# Run after the implementation changes are intentional (i.e. as part
# of a deliberate upgrade PR). CI re-runs `check.sh` against the
# committed baselines and fails if a slot drifts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/storage-layouts"
mkdir -p "$OUT"

CONTRACTS=(
  FeeVault
  SanctionsList
  IdentityGate
  RelayerRegistry
  # Future PRs append here: CommitmentPool, PrivateSettlement.
)

for c in "${CONTRACTS[@]}"; do
  echo "→ snapshot $c"
  forge inspect "$c" storage --json > "$OUT/$c.json"
done

echo "wrote ${#CONTRACTS[@]} layouts to $OUT"
