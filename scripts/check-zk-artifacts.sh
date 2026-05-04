#!/usr/bin/env bash
#
# Verify that the local ZK circuit artifacts haven't drifted away from
# the set that was in place when the deployed Verifier.sol contracts
# were generated.
#
# Why this exists: Groth16 phase-2 setup is non-deterministic (fresh
# random entropy each run). dev.sh rebuilds zkeys + Verifier.sol
# atomically so the on-chain verifier always matches the local zkey
# at that point in time. But if someone later reruns the circuit
# build manually, or copies a stale zkey in from a branch / archive,
# the local zkey no longer pairs with the deployed verifier and
# proofs fail with `InvalidProof()` — a wildly unhelpful error that
# can burn hours before anyone thinks to compare file hashes.
#
# This script hashes the current zkey files and compares them against
# a manifest written by dev.sh at deploy time. Any mismatch => drift.
#
# Usage:
#   scripts/check-zk-artifacts.sh              # verify (default)
#   scripts/check-zk-artifacts.sh --write      # write deploy-time manifest
#   scripts/check-zk-artifacts.sh --help
#
# Exit codes:
#   0   clean (or manifest absent — no previous deploy to compare to)
#   1   drift detected
#   2   usage / IO error

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# Circuits we verify against the deploy-time manifest. Matches the
# list in circuits/scripts/build.sh (source of truth); keep in sync
# if that list changes.
#
# Coverage split between the two clients:
#   - frontend/public/zk/  — circuits/build.sh copies ALL circuits
#     (see build.sh:117-123). The browser generates every proof type,
#     including withdraw.
#   - mobile/assets/zk/    — mobile/scripts/copy-zk-assets.sh omits
#     `withdraw` (mobile doesn't generate withdraw proofs today).
#
# Separate predicates so `--verify` flags frontend-side withdraw drift
# even though mobile has no corresponding file to compare.
CIRCUITS=(
  deposit
  withdraw
  claim
  claim_64
  claim_128
  authorize
  authorize_64
  authorize_128
  cancel
)

mobile_copies() {
  case "$1" in
    # Mobile only ships the tier-16 circuits today; tier-64 / tier-128
    # zkeys are too large to bundle in an RN binary and are not exposed
    # to mobile consumers yet (see mobile/scripts/copy-zk-assets.sh).
    deposit|claim|authorize|cancel) return 0 ;;
    *) return 1 ;;
  esac
}

frontend_copies() {
  # All built circuits land in frontend/public/zk, per build.sh.
  return 0
}

BUILD_DIR="$ROOT_DIR/circuits/build"
MOBILE_DIR="$ROOT_DIR/mobile/assets/zk"
FRONTEND_DIR="$ROOT_DIR/frontend/public/zk"
MANIFEST="$ROOT_DIR/.dev-logs/zk-manifest.json"

MODE="verify"
case "${1:-}" in
  --write)   MODE="write" ;;
  --verify|"") MODE="verify" ;;
  --help|-h)
    cat <<'HELP'
Verify ZK circuit artifact consistency across circuits/build,
mobile/assets/zk, frontend/public/zk, and the deploy-time manifest
(.dev-logs/zk-manifest.json).

Usage:
  scripts/check-zk-artifacts.sh              verify (default)
  scripts/check-zk-artifacts.sh --write      snapshot current build
                                             to the manifest (called
                                             by dev.sh after deploy)
  scripts/check-zk-artifacts.sh --help       this message

Exit codes:
  0   clean (or manifest absent — no prior deploy to compare to)
  1   drift detected
  2   usage / IO error
HELP
    exit 0
    ;;
  *)
    echo "error: unknown argument: $1 (see --help)" >&2
    exit 2
    ;;
esac

# Cache the SHA binary once — `command -v` per file adds up across a
# dozen hashes even though each call is cheap. Fail fast if neither
# tool is available so write-mode can't emit a manifest full of empty
# hashes that would later compare equal to one another.
if command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
elif command -v sha256sum >/dev/null 2>&1; then
  SHA_CMD="sha256sum"
else
  echo "error: neither 'shasum' nor 'sha256sum' is on PATH — cannot compute zkey fingerprints" >&2
  exit 2
fi

# Enable pipefail so a hash binary that crashes mid-pipeline (ENOMEM,
# truncated read, etc.) can't produce an empty hash that passes through
# `awk` and looks like a normal result.
set -o pipefail

sha_of() {
  if [ ! -f "$1" ]; then
    echo "MISSING"
    return
  fi
  local out
  if ! out="$($SHA_CMD "$1" | awk '{print $1}')"; then
    echo "error: hashing $1 failed" >&2
    exit 2
  fi
  if [ -z "$out" ]; then
    echo "error: empty hash output for $1 — binary produced no data" >&2
    exit 2
  fi
  echo "$out"
}

build_zkey()    { echo "$BUILD_DIR/${1}_final.zkey"; }
mobile_zkey()   { echo "$MOBILE_DIR/${1}_final.zkey"; }
frontend_zkey() { echo "$FRONTEND_DIR/${1}_final.zkey"; }

# ─── write: snapshot current circuits/build zkeys to manifest ────────
if [ "$MODE" = "write" ]; then
  mkdir -p "$(dirname "$MANIFEST")"
  # Hash every circuit first so a missing zkey fails fast instead of
  # writing a manifest full of MISSING sentinels that then pass
  # verification (both sides would record MISSING and compare equal).
  for c in "${CIRCUITS[@]}"; do
    if [ ! -f "$(build_zkey "$c")" ]; then
      echo "error: build zkey for '$c' not found at $(build_zkey "$c")" >&2
      echo "       did circuits/scripts/build.sh run successfully?" >&2
      exit 2
    fi
  done
  # Hand-rolled JSON to avoid a jq dependency — the structure is tiny
  # and circuit names are hardcoded (no escaping concern).
  {
    echo "{"
    echo "  \"writtenAt\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "  \"circuits\": {"
    first=1
    for c in "${CIRCUITS[@]}"; do
      sha="$(sha_of "$(build_zkey "$c")")"
      if [ "$first" -eq 0 ]; then echo ","; fi
      printf '    "%s": "%s"' "$c" "$sha"
      first=0
    done
    echo ""
    echo "  }"
    echo "}"
  } > "$MANIFEST"
  echo "[zk-drift] manifest written: $MANIFEST"
  exit 0
fi

# ─── verify: compare current vs manifest + cross-copies ──────────────
if [ ! -f "$MANIFEST" ]; then
  # No manifest ⇒ no prior deploy to compare against. Not an error on
  # first-ever run; just skip with a hint.
  echo "[zk-drift] no manifest at $MANIFEST — skipping (run with --write after deploy)"
  exit 0
fi
if [ ! -r "$MANIFEST" ]; then
  # File exists but can't be read. Distinct from "not present" —
  # something in the dev env is actively wrong (permissions, bad
  # symlink). Fail fast with a clear IO-error exit rather than looking
  # like "clean" via an empty grep.
  echo "[zk-drift] error: manifest exists but is not readable: $MANIFEST" >&2
  exit 2
fi

# Hoisted — defined once, not per-iteration. Uses $expected / $c from
# the enclosing loop rather than extra args to keep the call sites
# short; bash dynamic scoping covers us.
report_line() {
  local label="$1" path="$2" got="$3"
  if [ "$got" = "MISSING" ]; then
    echo "  ⚠  $c/$label: file missing at $path"
    return 1
  fi
  if [ "$got" != "$expected" ]; then
    echo "  ✗  $c/$label: DRIFT"
    echo "       expected $expected"
    echo "       got      $got"
    echo "       path     $path"
    return 1
  fi
  return 0
}

drift=0

# Pull every expected SHA from the manifest in a single Python pass.
# Python is available in every dev env we target; parsing real JSON
# sidesteps the name-prefix false-positive (e.g. `deposit` matching
# `deposit_v2`) that the previous grep/sed pipeline was vulnerable to.
MANIFEST_ENTRIES="$(
  python3 - "$MANIFEST" <<'PY' || exit 2
import json, sys
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except Exception as e:
    print(f"__ERROR__:{e}")
    sys.exit(1)
for name, sha in (data.get("circuits") or {}).items():
    print(f"{name}\t{sha}")
PY
)"
if printf '%s\n' "$MANIFEST_ENTRIES" | grep -q '^__ERROR__:'; then
  echo "[zk-drift] error: failed to parse manifest: $MANIFEST_ENTRIES" >&2
  exit 2
fi

lookup_expected() {
  # $1 circuit name — prints the SHA or empty.
  printf '%s\n' "$MANIFEST_ENTRIES" | awk -F'\t' -v n="$1" '$1==n {print $2; exit}'
}

echo "[zk-drift] verifying against $MANIFEST"
for c in "${CIRCUITS[@]}"; do
  expected="$(lookup_expected "$c")"
  if [ -z "$expected" ]; then
    echo "  ⚠  $c: missing from manifest (manifest predates this circuit?)"
    continue
  fi

  build_sha="$(sha_of "$(build_zkey "$c")")"
  row_ok=1
  report_line build "$(build_zkey "$c")" "$build_sha" || row_ok=0

  if mobile_copies "$c"; then
    mobile_sha="$(sha_of "$(mobile_zkey "$c")")"
    report_line mobile "$(mobile_zkey "$c")" "$mobile_sha" || row_ok=0
  fi
  if frontend_copies "$c"; then
    frontend_sha="$(sha_of "$(frontend_zkey "$c")")"
    report_line frontend "$(frontend_zkey "$c")" "$frontend_sha" || row_ok=0
  fi

  if [ "$row_ok" -eq 1 ]; then
    echo "  ✓  $c: all copies match manifest ($expected)"
  else
    drift=1
  fi
done

if [ "$drift" -eq 1 ]; then
  echo ""
  echo "[zk-drift] DRIFT DETECTED — the on-chain verifier was generated"
  echo "            from a different zkey than what's currently in the"
  echo "            affected path. Proofs from the drifted artifact set"
  echo "            will fail with InvalidProof()."
  echo ""
  echo "            Fix options:"
  echo "              1. Rerun $ROOT_DIR/scripts/dev.sh to rebuild"
  echo "                 everything in sync (this redeploys contracts —"
  echo "                 clears mobile/frontend state)"
  echo "              2. Copy the matching zkey back from another path"
  echo "                 that's still in sync with the deployed verifier"
  exit 1
fi

echo "[zk-drift] clean"
exit 0
