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

# Circuits we ship to the mobile + frontend clients. Matches the list
# in circuits/scripts/build.sh (source of truth); keep in sync if that
# list changes. Each has a zkey in circuits/build/ and a copy at
# mobile/assets/zk/ and frontend/public/zk/. Mismatch between
# circuits/build and the deployed verifier is the scenario that caused
# issue #402; the client copies are also compared because a desync
# there means mobile/frontend proofs won't verify either.
#
# withdraw is built by circuits/build.sh but doesn't have a client-side
# copy (the pool hosts withdraw proving server-side), so the mobile /
# frontend comparison skips it — see `client_copies` below.
CIRCUITS=(deposit withdraw claim authorize cancel)
# Circuits that DO get copied to mobile + frontend. Rest (just
# `withdraw`) are verified against the manifest in `circuits/build/`
# only.
client_copies() {
  case "$1" in
    deposit|claim|authorize|cancel) return 0 ;;
    *) return 1 ;;
  esac
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
# dozen hashes even though each call is cheap.
if command -v shasum >/dev/null 2>&1; then
  SHA_CMD="shasum -a 256"
else
  SHA_CMD="sha256sum"
fi

sha_of() {
  if [ ! -f "$1" ]; then
    echo "MISSING"
    return
  fi
  $SHA_CMD "$1" | awk '{print $1}'
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

echo "[zk-drift] verifying against $MANIFEST"
for c in "${CIRCUITS[@]}"; do
  # Pull expected from manifest without jq — grep the line, strip quotes.
  expected="$(
    grep -E "\"$c\":" "$MANIFEST" 2>/dev/null \
      | head -1 \
      | sed -E 's/.*"'"$c"'"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
  )"
  if [ -z "$expected" ]; then
    echo "  ⚠  $c: missing from manifest (manifest predates this circuit?)"
    continue
  fi

  build_sha="$(sha_of "$(build_zkey "$c")")"
  row_ok=1
  report_line build "$(build_zkey "$c")" "$build_sha" || row_ok=0

  # Only circuits that ship to clients get the mobile / frontend copy
  # check. Skipping this for server-only circuits (e.g. `withdraw`)
  # avoids spurious "file missing" warnings.
  if client_copies "$c"; then
    mobile_sha="$(sha_of "$(mobile_zkey "$c")")"
    frontend_sha="$(sha_of "$(frontend_zkey "$c")")"
    report_line mobile   "$(mobile_zkey "$c")"   "$mobile_sha"   || row_ok=0
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
