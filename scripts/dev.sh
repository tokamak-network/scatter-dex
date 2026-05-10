#!/usr/bin/env bash
# Requires bash 4+ for associative arrays (`declare -A`). macOS ships
# /bin/bash 3.2; install bash via Homebrew (`brew install bash`) so
# `/usr/bin/env bash` picks up the newer version on PATH.
if (( BASH_VERSINFO[0] < 4 )); then
  echo "ERROR: scripts/dev.sh requires bash 4+." >&2
  echo "Install a newer bash (for example: brew install bash) and ensure it is first on PATH." >&2
  exit 1
fi

# On Apple Silicon, native modules (better-sqlite3, esbuild) installed under
# arm64 fail to load when the script runs under x86_64 Rosetta — and vice
# versa. Some users have an x86_64 homebrew bash at /usr/local/bin/bash that
# `/usr/bin/env bash` picks first; re-exec under the native arm64 bash so
# `uname -m` matches the installed module arch.
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "x86_64" ] \
    && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = "1" ] \
    && [ -x /opt/homebrew/bin/bash ]; then
  exec /opt/homebrew/bin/bash "$0" "$@"
fi
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$ROOT_DIR/.dev-logs"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
# Hardhat Account #1 — Relayer A (also registered on-chain by DeployLocal.s.sol).
ZK_RELAYER_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
# Hardhat Account #2 — Relayer B (registered post-deploy for P2P orderbook tests).
RELAYER_B_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
RELAYER_B_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
RELAYER_FEE_BPS=30
RPC_URL="http://localhost:8545"
MOCK_MODE=false
MOBILE_BUNDLE_ID="io.scatterdex.mobile"
PIDS=()
CLEANED_UP=false

# Per-app dev ports come from each app's `next dev -p …` script.
# `hub` is intentionally excluded — it shares port 4000 with the
# shared-orderbook this script always starts, so it must be run from
# a separate terminal (it's a static landing site that doesn't need
# the relayer/anvil stack anyway).
declare -A APP_PORTS=(
  [pay]=4001
  [drop]=4002
  [pro]=4003
  [operators]=4004
)
# Comma-separated app list from --apps. Empty means "start frontend"
# (the legacy default).
APPS_LIST=""

usage() {
  echo "Usage: $0 [--mock] [--apps <a,b,c>]"
  echo ""
  echo "  Default:    Connects to running anvil with zk-X509 deployed."
  echo "              Requires IDENTITY_REGISTRY env var or prompts for it."
  echo "  --mock:     Starts own anvil with MockIdentityRegistry (no zk-X509 needed)."
  echo "  --apps L:   Comma-separated app names to run instead of \`frontend/\`."
  echo "              Valid: ${!APP_PORTS[*]}"
  echo "              Example: --apps pro,pay"
  echo "              Note: hub is excluded (port 4000 collides with shared-orderbook)."
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mock) MOCK_MODE=true; shift ;;
    --apps)
      # Without this guard, `--apps` as the last arg or before another
      # flag would silently consume the wrong value (or `shift 2` would
      # error under `set -e`).
      if [ -z "${2:-}" ] || [[ "$2" == --* ]]; then
        echo "ERROR: --apps requires a comma-separated value (try --help)" >&2
        exit 1
      fi
      APPS_LIST="$2"
      shift 2
      ;;
    --apps=*) APPS_LIST="${1#--apps=}"; shift ;;
    --help|-h) usage ;;
    *) echo "ERROR: unknown argument '$1' (try --help)" >&2; exit 1 ;;
  esac
done

# Validate --apps entries against APP_PORTS so a typo fails fast
# instead of silently skipping the app or starting the wrong port.
APPS_TO_RUN=()
if [ -n "$APPS_LIST" ]; then
  IFS=',' read -ra APPS_TO_RUN <<< "$APPS_LIST"
  for a in "${APPS_TO_RUN[@]}"; do
    if [ -z "${APP_PORTS[$a]:-}" ]; then
      echo "ERROR: unknown app '$a' (valid: ${!APP_PORTS[*]})" >&2
      exit 1
    fi
  done
fi

cleanup() {
  if [ "$CLEANED_UP" = true ]; then return; fi
  CLEANED_UP=true
  echo ""
  echo "Shutting down..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "Done. Logs saved in $LOG_DIR/"
}
trap cleanup EXIT

# Wait for a URL to respond, with timeout. Returns 1 on failure.
wait_for() {
  local url="$1" name="$2" max="$3"
  local i=0
  while true; do
    # Try JSON-RPC POST first (for anvil), then plain GET (for relayer/frontend)
    if curl -fsS "$url" -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' > /dev/null 2>&1; then
      break
    fi
    if curl -fsS "$url" > /dev/null 2>&1; then
      break
    fi
    i=$((i + 1))
    if [ "$i" -ge "$max" ]; then
      echo "  ERROR: $name failed to start (waited ${max}s)"
      return 1
    fi
    sleep 1
  done
  return 0
}

# Check if a port is already in use
check_port() {
  local port="$1" name="$2"
  # Only fail on an actual LISTEN socket; ignore browser-side CLOSE_WAIT
  # connections (e.g. MetaMask's lingering localhost:8545 socket) that
  # aren't actually holding the port.
  if lsof -iTCP:"$port" -sTCP:LISTEN > /dev/null 2>&1; then
    echo "ERROR: port $port is already in use ($name). Kill the existing process first."
    exit 1
  fi
}

# Create log directory
mkdir -p "$LOG_DIR"

# Ensure better-sqlite3's native binary matches the current shell arch.
# The .node file is built x86_64 under `arch -x86_64 bash` (dev-fork.sh)
# and arm64 under native bash (dev.sh --mock); switching between the two
# scripts requires a rebuild or Node dlopen fails with an arch mismatch.
ensure_sqlite_arch() {
  local pkg_dir="$1"
  local node_file="$pkg_dir/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  if [ ! -f "$node_file" ]; then return 0; fi
  local expected current
  expected=$(uname -m)
  # `|| true` keeps `set -e` from aborting when `file` prints no recognised
  # arch token (unusual platforms, file(1) wording drift). Empty `current`
  # is then handled by the -n guard below.
  current=$(file "$node_file" 2>/dev/null | grep -oE 'x86_64|arm64' | head -1 || true)
  if [ -n "$current" ] && [ "$current" != "$expected" ]; then
    echo "  better-sqlite3 in $(basename "$pkg_dir") is $current, need $expected — rebuilding..."
    ( cd "$pkg_dir" && npm rebuild better-sqlite3 ) > "$LOG_DIR/sqlite-rebuild-$(basename "$pkg_dir").log" 2>&1 \
      || { echo "  ERROR: better-sqlite3 rebuild failed. See $LOG_DIR/sqlite-rebuild-$(basename "$pkg_dir").log"; exit 1; }
  fi
}

# Wipe the mobile app from any booted iOS simulator / Android emulator.
# Fresh anvil means fresh contract addresses, so any cached commitment
# notes / claim notes / trade history in the app are stale. Full uninstall
# is the simplest reset — wallet/mnemonic must be re-entered on next run.
reset_mobile_app() {
  local wiped=0
  if command -v xcrun >/dev/null 2>&1; then
    local udids
    # `|| true` so `set -e` doesn't abort when no simulators are booted
    # (empty grep pipeline exits non-zero).
    udids=$(xcrun simctl list devices booted 2>/dev/null \
      | grep -oE '\([0-9A-F-]{36}\) \(Booted\)' \
      | grep -oE '[0-9A-F-]{36}' || true)
    for udid in $udids; do
      if xcrun simctl uninstall "$udid" "$MOBILE_BUNDLE_ID" 2>/dev/null; then
        echo "  Uninstalled $MOBILE_BUNDLE_ID from iOS simulator $udid"
        wiped=1
      fi
    done
  fi
  if command -v adb >/dev/null 2>&1; then
    local devs
    devs=$(adb devices 2>/dev/null | awk 'NR>1 && $2=="device" {print $1}' || true)
    for dev in $devs; do
      if adb -s "$dev" uninstall "$MOBILE_BUNDLE_ID" >/dev/null 2>&1; then
        echo "  Uninstalled $MOBILE_BUNDLE_ID from Android $dev"
        wiped=1
      fi
    done
  fi
  [ "$wiped" = 0 ] && echo "  No booted simulators/emulators with the app installed (skipped)."
  return 0
}

# Mobile-app uninstall + DB wipe assume a fresh anvil (contract addresses
# change every boot) and are destructive to any in-progress state. Only run
# them when we're actually starting a fresh chain (`--mock`) or the user has
# explicitly opted in with `RESET_STATE=1`; integration mode (external anvil)
# should not auto-wipe.
SHOULD_RESET_STATE=false
if [ "$MOCK_MODE" = true ] || [ "${RESET_STATE:-0}" = "1" ]; then
  SHOULD_RESET_STATE=true
fi

if [ "$SHOULD_RESET_STATE" = true ]; then
  echo "Resetting mobile app on booted simulators/emulators..."
  reset_mobile_app
  echo ""
else
  echo "Skipping mobile-app / DB reset (integration mode). Set RESET_STATE=1 to force."
  echo ""
fi

# Wipe relayer + shared-orderbook SQLite DBs: fresh anvil = fresh contracts =
# previously-indexed commitments/orders are keyed to obsolete pool addresses.
wipe_dev_dbs() {
  local files=(
    "$ROOT_DIR/zk-relayer/zk-relayer.db"
    "$ROOT_DIR/zk-relayer/zk-relayer-b.db"
    "$ROOT_DIR/shared-orderbook/shared-orderbook.db"
  )
  local removed=0
  for f in "${files[@]}"; do
    for ext in "" "-wal" "-shm"; do
      [ -f "${f}${ext}" ] && rm -f "${f}${ext}" && removed=1
    done
  done
  [ "$removed" = 1 ] && echo "Wiped stale relayer/orderbook DBs from previous run." && echo ""
  return 0
}
if [ "$SHOULD_RESET_STATE" = true ]; then
  wipe_dev_dbs
fi

# Always rebuild Groth16 verifiers + zkeys before deploy. Each phase-2
# setup emits different vkey constants, and the only way to guarantee
# zkey ↔ Verifier.sol consistency (no InvalidProof at runtime) is to
# regenerate them in one atomic build. The generated Verifier.sol files
# are gitignored for this reason.
#
# Set SKIP_CIRCUIT_BUILD=1 to bypass when you know nothing changed since
# the last build (saves ~30s+ on the settle phase-2).
# Mirror circuits/build wasm + zkey into every consumer surface
# (frontend/, apps/pro/) when they've drifted. Normally circuits/build.sh
# does this at the end of `npm run build`; with SKIP_CIRCUIT_BUILD=1 we
# bypass build, so a circuits/build/ that was rebuilt out-of-band between
# dev.sh runs would otherwise deploy a Verifier.sol that doesn't pair with
# the zkeys the apps actually load — every deposit/settle/claim then
# reverts InvalidProof(). apps/pay pulls from apps/pro via its predev
# script (`apps/pay/scripts/sync-zk-assets.mjs`); apps/drop has no such
# hook today and currently doesn't ship circuit-driven flows, so syncing
# the two canonical mirrors is enough.
#
# `mkdir -p` matches build.sh's behavior so a clean tree (frontend/public/zk
# is gitignored) still gets populated.
#
# Drift gate uses size + mtime (both preserved by `cp -p`) to avoid
# re-hashing 90 MB+ zkeys on every dev.sh start. Falls through to `cmp -s`
# only when the cheap check already says "maybe different".
_sync_one_asset() {
  local src="$1" dst="$2"
  if [ -f "$dst" ]; then
    local s_meta d_meta
    s_meta=$(stat -f '%z %m' "$src" 2>/dev/null || stat -c '%s %Y' "$src")
    d_meta=$(stat -f '%z %m' "$dst" 2>/dev/null || stat -c '%s %Y' "$dst")
    [ "$s_meta" = "$d_meta" ] && return 1
    cmp -s "$src" "$dst" && return 1
  fi
  cp -p "$src" "$dst"
  return 0
}
sync_zk_assets_from_build() {
  local build_dir="$ROOT_DIR/circuits/build"
  local circuits=(deposit withdraw claim claim_64 claim_128 authorize authorize_64 authorize_128 cancel)
  local targets=("$ROOT_DIR/frontend/public/zk" "$ROOT_DIR/apps/pro/public/zk")
  local updated=0
  for t in "${targets[@]}"; do
    mkdir -p "$t"
  done
  for c in "${circuits[@]}"; do
    local zkey="$build_dir/${c}_final.zkey"
    local wasm="$build_dir/${c}_js/${c}.wasm"
    [ -f "$zkey" ] || continue
    [ -f "$wasm" ] || continue
    for t in "${targets[@]}"; do
      _sync_one_asset "$zkey" "$t/${c}_final.zkey" && updated=$((updated + 1))
      _sync_one_asset "$wasm" "$t/${c}.wasm" && updated=$((updated + 1))
    done
  done
  if [ "$updated" -gt 0 ]; then
    echo "  Synced $updated drifted zk asset(s) from circuits/build/ to consumer surfaces (frontend/, apps/pro/)."
    # Refresh the deploy-time manifest so a later
    # `check-zk-artifacts.sh --verify` doesn't false-positive on the
    # newly-adopted build (the previous manifest described the *prior*
    # build that was up before the out-of-band rebuild).
    "$ROOT_DIR/scripts/check-zk-artifacts.sh" --write \
      || echo "  WARN: zk manifest write failed after sync"
  fi
}

ensure_circuits_built() {
  if [ "${SKIP_CIRCUIT_BUILD:-0}" = "1" ]; then
    echo "  SKIP_CIRCUIT_BUILD=1 — using existing zkeys + Verifier.sol."
    sync_zk_assets_from_build
    return
  fi
  echo "  Building circuits (regenerates zkeys + Verifier.sol — first run is slow)..."
  # `if !` instead of post-hoc `$?` check so the failure is caught even
  # under `set -e` (which would otherwise abort before the diagnostic runs).
  if ! ( cd "$ROOT_DIR/circuits" && npm run build ) > "$LOG_DIR/circuit-build.log" 2>&1; then
    echo "  ERROR: circuit build failed. Tail of $LOG_DIR/circuit-build.log:"
    tail -30 "$LOG_DIR/circuit-build.log" 2>/dev/null
    exit 1
  fi
  echo "  Circuits built."
  # Record a post-build fingerprint of the freshly-built zkeys so a
  # later run of `scripts/check-zk-artifacts.sh` can detect silent
  # drift — e.g. someone reruns the circuit build manually, or an
  # editor hook overwrites circuits/build/ before a later deploy or
  # the next session. Drift against whatever verifier set is eventually
  # deployed means every proof will revert InvalidProof(), and that
  # failure mode is otherwise maddening to diagnose. See issue #402.
  #
  # This snapshot is the local build output at this point in the
  # script — it's not a confirmation that the subsequent deploy
  # succeeded. If deploy later fails, the manifest still accurately
  # describes the build that *would have been* deployed; drift
  # detection remains useful. (Re-running the whole script regenerates
  # both the build and the manifest atomically.)
  "$ROOT_DIR/scripts/check-zk-artifacts.sh" --write \
    || echo "  WARN: zk manifest write failed"
}

echo "=== ScatterDEX Local Dev Environment ==="
echo ""

if [ "$MOCK_MODE" = true ]; then
  # ── Mock mode: standalone with MockIdentityRegistry ─────────
  echo "Mode: MOCK (standalone, no zk-X509)"
  echo ""

  check_port 8545 "anvil"
  check_port 4000 "shared-orderbook"
  check_port 3002 "zk-relayer-a"
  check_port 3003 "zk-relayer-b"
  check_port 3000 "frontend"

  echo "[1/6] Starting anvil (hardfork=prague for EIP-7702)..."
  # `--hardfork prague` enables Pectra-era features — notably EIP-7702
  # batch delegation, which the frontend uses to collapse the deposit
  # popup chain into one tx when the wallet supports it.
  # `--host 0.0.0.0` so a USB-tethered Android device on the same LAN can
  # reach anvil at the Mac's 192.168.x.y address (default bind is
  # 127.0.0.1 only). adb-reverse to localhost works too, but a LAN bind is
  # the no-trick path users reach for first.
  anvil --silent --hardfork prague --host 0.0.0.0 &
  last_pid=$!
  PIDS+=("$last_pid")
  if ! wait_for "$RPC_URL" "anvil" 10; then
    exit 1
  fi
  echo "  anvil running on $RPC_URL (PID $last_pid)"

  echo ""
  echo "[2/6] Deploying contracts (MockIdentityRegistry)..."
  ensure_circuits_built
  cd "$ROOT_DIR/contracts"
  # `forge script` can exit non-zero even when the on-chain deployment
  # succeeded — e.g. `Error: IO error: not a terminal` under captured
  # stdout, or contract-size warnings when a contract exceeds EIP-170 on
  # networks with that limit (anvil deploys fine regardless). Suppress
  # `set -e` only for those known-benign cases; surface any other failure.
  set +e
  DEPLOY_OUTPUT=$(forge script script/DeployLocal.s.sol:DeployLocal \
    --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)
  DEPLOY_STATUS=$?
  set -e
  if [ "$DEPLOY_STATUS" -ne 0 ] \
      && ! echo "$DEPLOY_OUTPUT" | grep -qE "Contract size|contract size|not a terminal|runtime size limit"; then
    echo "  ERROR: forge script failed (exit $DEPLOY_STATUS):"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

  RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "^  RelayerRegistry:" | awk '{print $NF}')
  WETH=$(echo "$DEPLOY_OUTPUT" | grep "^  WETH:" | awk '{print $NF}')
  USDC=$(echo "$DEPLOY_OUTPUT" | grep "^  USDC:" | awk '{print $NF}')
  USDT=$(echo "$DEPLOY_OUTPUT" | grep "^  USDT:" | awk '{print $NF}')
  TON=$(echo "$DEPLOY_OUTPUT" | grep "^  TON:" | awk '{print $NF}')
  COMMITMENT_POOL=$(echo "$DEPLOY_OUTPUT" | grep "^  CommitmentPool:" | awk '{print $NF}')
  PRIVATE_SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "^  PrivateSettlement:" | awk '{print $NF}')
  IDENTITY_GATE=$(echo "$DEPLOY_OUTPUT" | grep "^  IdentityGate:" | awk '{print $NF}')
  FEE_VAULT=$(echo "$DEPLOY_OUTPUT" | grep "^  FeeVault:" | awk '{print $NF}')
  BATCH_EXECUTOR=$(echo "$DEPLOY_OUTPUT" | grep "^  BatchExecutor:" | awk '{print $NF}')
  STEALTH_TRANSFER_ACCOUNT=$(echo "$DEPLOY_OUTPUT" | grep "^  StealthTransferAccount:" | awk '{print $NF}')

  if [ -z "$RELAYER_REGISTRY" ] || [ -z "$WETH" ] || [ -z "$USDC" ] || [ -z "$COMMITMENT_POOL" ] || [ -z "$PRIVATE_SETTLEMENT" ] || [ -z "$IDENTITY_GATE" ] || [ -z "$FEE_VAULT" ] || [ -z "$STEALTH_TRANSFER_ACCOUNT" ]; then
    echo "  ERROR: deployment failed (missing one or more contract addresses)"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

  # zk-relayer registration is handled by DeployLocal.s.sol (Account #1)

else
  # ── Integration mode: connect to existing anvil with zk-X509 ──
  echo "Mode: INTEGRATION (zk-X509 required)"
  echo ""

  # Verify anvil is running
  echo "[1/6] Checking anvil..."
  if ! curl -fsS "$RPC_URL" -X POST -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}' > /dev/null 2>&1; then
    echo "  ERROR: anvil is not running at $RPC_URL"
    echo "  Start zk-X509 local environment first. See:"
    echo "  https://github.com/user/zk-X509/blob/main/docs/local-setup.md"
    exit 1
  fi
  echo "  anvil is running."

  check_port 4000 "shared-orderbook"
  check_port 3002 "zk-relayer-a"
  check_port 3003 "zk-relayer-b"
  check_port 3000 "frontend"

  # Helper: prompt for a registry address if not set, verify contract exists
  require_registry() {
    local var_name="$1" prompt_text="$2" error_hint="$3"
    eval "local val=\$$var_name"

    if [ -z "$val" ]; then
      echo ""
      echo "  $var_name not set."
      echo "  $prompt_text"
      read -r -p "  > " val
      eval "$var_name=\"$val\""
    fi

    if [ -z "$val" ]; then
      echo "  ERROR: $var_name is required in integration mode."
      echo "  Usage: IDENTITY_REGISTRY=0x... RELAYER_IDENTITY_REGISTRY=0x... $0"
      echo "  Or use: $0 --mock"
      exit 1
    fi

    CODE=$(cast code "$val" --rpc-url "$RPC_URL" 2>/dev/null || echo "0x")
    if [ "$CODE" = "0x" ]; then
      echo "  ERROR: No contract found at $val"
      echo "  $error_hint"
      exit 1
    fi
  }

  require_registry "IDENTITY_REGISTRY" \
    "Enter the zk-X509 User CA IdentityRegistry proxy address:" \
    "Deploy zk-X509 contracts first."
  echo "  IdentityRegistry (User CA):    $IDENTITY_REGISTRY"

  require_registry "RELAYER_IDENTITY_REGISTRY" \
    "Enter the zk-X509 Relayer CA IdentityRegistry proxy address:" \
    "Deploy zk-X509 Relayer CA registry first."
  echo "  IdentityRegistry (Relayer CA): $RELAYER_IDENTITY_REGISTRY"

  echo ""
  echo "[2/6] Deploying contracts (real IdentityGate)..."
  ensure_circuits_built
  cd "$ROOT_DIR/contracts"

  # See MOCK branch: suppress `set -e` only for known-benign forge exits.
  set +e
  DEPLOY_OUTPUT=$(IDENTITY_REGISTRY="$IDENTITY_REGISTRY" \
    RELAYER_IDENTITY_REGISTRY="$RELAYER_IDENTITY_REGISTRY" \
    forge script script/DeployLocal.s.sol:DeployLocal \
    --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)
  DEPLOY_STATUS=$?
  set -e
  if [ "$DEPLOY_STATUS" -ne 0 ] \
      && ! echo "$DEPLOY_OUTPUT" | grep -qE "Contract size|contract size|not a terminal|runtime size limit"; then
    echo "  ERROR: forge script failed (exit $DEPLOY_STATUS):"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

  RELAYER_REGISTRY=$(echo "$DEPLOY_OUTPUT" | grep "RelayerRegistry:" | awk '{print $NF}')
  COMMITMENT_POOL=$(echo "$DEPLOY_OUTPUT" | grep "CommitmentPool:" | awk '{print $NF}')
  PRIVATE_SETTLEMENT=$(echo "$DEPLOY_OUTPUT" | grep "PrivateSettlement:" | awk '{print $NF}')
  IDENTITY_GATE=$(echo "$DEPLOY_OUTPUT" | grep "IdentityGate:" | awk '{print $NF}')
  FEE_VAULT=$(echo "$DEPLOY_OUTPUT" | grep "FeeVault:" | awk '{print $NF}')

  if [ -z "$RELAYER_REGISTRY" ] || [ -z "$COMMITMENT_POOL" ] || [ -z "$PRIVATE_SETTLEMENT" ] || [ -z "$IDENTITY_GATE" ] || [ -z "$FEE_VAULT" ]; then
    echo "  ERROR: deployment failed (missing contract addresses)"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi

  # No test tokens in integration mode
  WETH=""
  USDC=""
fi

echo "  RelayerRegistry:     $RELAYER_REGISTRY"
[ -n "$WETH" ] && echo "  WETH:                $WETH"
[ -n "$USDC" ] && echo "  USDC:                $USDC"
[ -n "$COMMITMENT_POOL" ] && echo "  CommitmentPool:      $COMMITMENT_POOL"
[ -n "$PRIVATE_SETTLEMENT" ] && echo "  PrivateSettlement:   $PRIVATE_SETTLEMENT"

if [ -z "$COMMITMENT_POOL" ] || [ -z "$PRIVATE_SETTLEMENT" ]; then
  echo "  ERROR: ZK contracts not deployed (missing CommitmentPool or PrivateSettlement)"
  exit 1
fi

# TOKEN_LIST is empty in integration mode (no test tokens deployed).
# Mock-mode adds USDT (6 dec) and TON (18 dec) so the wizard's
# whitelist (LAUNCH_TOKENS) is fully exercisable; fork mode keeps
# real WTON (27 dec) instead of TON.
if [ -n "$WETH" ] && [ -n "$USDC" ]; then
  TOKEN_LIST="$WETH:WETH:18,$USDC:USDC:6"
  if [ -n "$USDT" ]; then
    TOKEN_LIST="$TOKEN_LIST,$USDT:USDT:6"
  fi
  if [ -n "$TON" ]; then
    TOKEN_LIST="$TOKEN_LIST,$TON:TON:18"
  fi
else
  TOKEN_LIST=""
fi

# ── 3. Start shared orderbook ──────────────────────────────
echo ""
echo "[3/6] Starting shared orderbook (port 4000)..."
if [ ! -d "$ROOT_DIR/shared-orderbook/node_modules" ]; then
  echo "  Installing shared-orderbook dependencies (first run)..."
  ( cd "$ROOT_DIR/shared-orderbook" && npm install --no-audit --no-fund ) > "$LOG_DIR/shared-orderbook-install.log" 2>&1
fi
ensure_sqlite_arch "$ROOT_DIR/shared-orderbook"
cd "$ROOT_DIR/shared-orderbook"
PORT=4000 npm run dev > "$LOG_DIR/shared-orderbook.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "http://localhost:4000/health" "shared-orderbook" 20; then
  echo "  Last 20 lines of shared-orderbook log:"
  tail -20 "$LOG_DIR/shared-orderbook.log" 2>/dev/null
  exit 1
fi
echo "  shared-orderbook running on http://localhost:4000 (PID $last_pid)"

# Capture post-deploy block so relayers skip pre-deploy history on scan.
INDEX_FROM=$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null || echo 0)
ADMIN_KEY="dev-admin-$(head -c 16 /dev/urandom | xxd -p)"

ensure_sqlite_arch "$ROOT_DIR/zk-relayer"

# ── 4. Start Relayer A (port 3002) ─────────────────────────
echo ""
echo "[4/6] Starting Relayer A (port 3002)..."
cat > "$ROOT_DIR/zk-relayer/.env" << EOF
RPC_URL=$RPC_URL
RELAYER_PRIVATE_KEY=$ZK_RELAYER_KEY
COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
FEE_VAULT_ADDRESS=$FEE_VAULT
TOKEN_LIST=$TOKEN_LIST
ADMIN_API_KEY=$ADMIN_KEY
RELAYER_FEE=$RELAYER_FEE_BPS
PORT=3002
INDEX_FROM_BLOCK=$INDEX_FROM
SHARED_ORDERBOOK_URL=http://localhost:4000
RELAYER_PUBLIC_URL=http://localhost:3002
RELAYER_NAME=Relayer-A
DB_PATH=$ROOT_DIR/zk-relayer/zk-relayer.db
CORS_ORIGINS=http://localhost:3000,http://localhost:3002,http://localhost:3003,http://localhost:4001,http://localhost:4002,http://localhost:4003
STEALTH_TRANSFER_ACCOUNT_ADDRESS=$STEALTH_TRANSFER_ACCOUNT
GASLESS_FEE_USDC=0.10
GASLESS_FEE_USDT=0.10
GASLESS_FEE_TON=1.0
CLAIM_FEE_USDC=0.05
CLAIM_FEE_USDT=0.05
CLAIM_FEE_TON=0.5
EOF
echo "  Admin API key: $ADMIN_KEY"

cd "$ROOT_DIR/zk-relayer"
npm run dev > "$LOG_DIR/relayer-a.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "http://localhost:3002/api/info" "relayer-a" 30; then
  echo "  Last 20 lines of relayer-a log:"
  tail -20 "$LOG_DIR/relayer-a.log" 2>/dev/null
  exit 1
fi
echo "  Relayer A running on http://localhost:3002 (PID $last_pid)"

# ── 5. Start Relayer B (port 3003) ─────────────────────────
echo ""
echo "[5/6] Starting Relayer B (port 3003)..."
RPC_URL="$RPC_URL" \
RELAYER_PRIVATE_KEY="$RELAYER_B_KEY" \
COMMITMENT_POOL_ADDRESS="$COMMITMENT_POOL" \
PRIVATE_SETTLEMENT_ADDRESS="$PRIVATE_SETTLEMENT" \
FEE_VAULT_ADDRESS="$FEE_VAULT" \
TOKEN_LIST="$TOKEN_LIST" \
ADMIN_API_KEY="$ADMIN_KEY" \
RELAYER_FEE=$RELAYER_FEE_BPS \
PORT=3003 \
INDEX_FROM_BLOCK="$INDEX_FROM" \
SHARED_ORDERBOOK_URL=http://localhost:4000 \
RELAYER_PUBLIC_URL=http://localhost:3003 \
RELAYER_NAME=Relayer-B \
DB_PATH="$ROOT_DIR/zk-relayer/zk-relayer-b.db" \
CORS_ORIGINS=http://localhost:3000,http://localhost:3002,http://localhost:3003,http://localhost:4001,http://localhost:4002,http://localhost:4003 \
STEALTH_TRANSFER_ACCOUNT_ADDRESS="$STEALTH_TRANSFER_ACCOUNT" \
GASLESS_FEE_USDC=0.05 \
GASLESS_FEE_USDT=0.05 \
GASLESS_FEE_TON=0.5 \
CLAIM_FEE_USDC=0.03 \
CLAIM_FEE_USDT=0.03 \
CLAIM_FEE_TON=0.3 \
npm run dev > "$LOG_DIR/relayer-b.log" 2>&1 &
last_pid=$!
PIDS+=("$last_pid")
if ! wait_for "http://localhost:3003/api/info" "relayer-b" 30; then
  echo "  Last 20 lines of relayer-b log:"
  tail -20 "$LOG_DIR/relayer-b.log" 2>/dev/null
  exit 1
fi
echo "  Relayer B running on http://localhost:3003 (PID $last_pid)"

# Register Relayer B on-chain (DeployLocal.s.sol only registers Relayer A).
if cast send "$RELAYER_REGISTRY" "register(string,string,uint256,uint256)" \
    "http://localhost:3003" "Relayer-B" "$RELAYER_FEE_BPS" 0 \
    --private-key "$RELAYER_B_KEY" --rpc-url "$RPC_URL" \
    > /dev/null 2>&1; then
  echo "  Relayer B registered on RelayerRegistry (fee=$RELAYER_FEE_BPS bps)"
else
  EXISTING_URL=$(cast call "$RELAYER_REGISTRY" \
    "relayers(address)(string,uint256,uint256,uint256,uint256,bool)" \
    "$RELAYER_B_ADDR" --rpc-url "$RPC_URL" 2>/dev/null | head -1)
  if echo "$EXISTING_URL" | grep -q "http://localhost:3003"; then
    echo "  Relayer B already registered on RelayerRegistry"
  else
    echo "  WARNING: Relayer B on-chain registration failed — frontend may only list Relayer A"
  fi
fi

# ── 6. Start frontend (or selected apps via --apps) ────────
echo ""
TOKENS=""
if [ -n "$WETH" ] && [ -n "$USDC" ]; then
  TOKENS="$WETH:WETH:18,$USDC:USDC:6"
  [ -n "$USDT" ] && TOKENS="$TOKENS,$USDT:USDT:6"
  [ -n "$TON" ] && TOKENS="$TOKENS,$TON:TON:18"
fi

# Write the same NEXT_PUBLIC_* env file to a target dir. Used for both
# `frontend/` (legacy default) and `apps/*` (new --apps mode) so all
# clients see the same deployment without diverging by hand.
#
# `apps/pay` reads its own NEXT_PUBLIC_PAY_* prefix (its `network.ts`
# inlines those keys statically so the chain pill renders during SSR).
# Emit both shapes when targeting `apps/pay` so the wizard picks up
# the relayer registry, contract addresses, and RPC without the
# operator hand-editing .env.local after each redeploy.
write_app_env() {
  local target_dir="$1"
  # Preserve user-provided secrets (non-deployment env vars) across regeneration.
  # The deploy-driven NEXT_PUBLIC_* keys are overwritten on every run, but keys
  # like ONEINCH_API_KEY belong to the developer, not the deployment.
  local preserved=""
  if [ -f "$target_dir/.env.local" ]; then
    preserved=$(grep -E '^(ONEINCH_API_KEY|CSP_EXTRA_CONNECT_SRC|NEXT_PUBLIC_MAINNET_RPC|NEXT_PUBLIC_HUB_URL)=' "$target_dir/.env.local" || true)
  fi
  cat > "$target_dir/.env.local" << EOF
NEXT_PUBLIC_RPC_URL=$RPC_URL
NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS=$RELAYER_REGISTRY
NEXT_PUBLIC_WETH_ADDRESS=$WETH
NEXT_PUBLIC_TOKENS=$TOKENS
NEXT_PUBLIC_CHAIN_ID=31337
NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS=$COMMITMENT_POOL
NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS=$PRIVATE_SETTLEMENT
NEXT_PUBLIC_IDENTITY_GATE_ADDRESS=$IDENTITY_GATE
NEXT_PUBLIC_FEE_VAULT_ADDRESS=$FEE_VAULT
NEXT_PUBLIC_BATCH_EXECUTOR_ADDRESS=$BATCH_EXECUTOR
NEXT_PUBLIC_ZK_RELAYER_URL=http://localhost:3002
NEXT_PUBLIC_SHARED_ORDERBOOK_URL=http://localhost:4000
EOF
  case "$target_dir" in
    */apps/pay)
      cat >> "$target_dir/.env.local" << EOF
NEXT_PUBLIC_PAY_CHAIN_ID=31337
NEXT_PUBLIC_PAY_RPC_URL=$RPC_URL
NEXT_PUBLIC_PAY_PRIVATE_SETTLEMENT=$PRIVATE_SETTLEMENT
NEXT_PUBLIC_PAY_COMMITMENT_POOL=$COMMITMENT_POOL
NEXT_PUBLIC_PAY_IDENTITY_GATE=$IDENTITY_GATE
NEXT_PUBLIC_PAY_RELAYER_REGISTRY=$RELAYER_REGISTRY
NEXT_PUBLIC_PAY_WETH=$WETH
NEXT_PUBLIC_PAY_USDC=$USDC
NEXT_PUBLIC_PAY_USDT=$USDT
NEXT_PUBLIC_PAY_TON=$TON
NEXT_PUBLIC_PAY_RELAYER_URL=http://localhost:3002
NEXT_PUBLIC_PAY_DEPLOY_BLOCK=$INDEX_FROM
EOF
      # Only emit the stealth-transfer line when the address is set
      # (mock mode greps it from DeployLocal output). Integration mode
      # doesn't deploy this contract, so leaving the line out lets the
      # gasless toggle stay hidden cleanly rather than write an empty
      # value that silently disables the feature at runtime.
      if [ -n "$STEALTH_TRANSFER_ACCOUNT" ]; then
        echo "NEXT_PUBLIC_PAY_STEALTH_TRANSFER_ACCOUNT=$STEALTH_TRANSFER_ACCOUNT" >> "$target_dir/.env.local"
      fi
      ;;
  esac
  if [ -n "$preserved" ]; then
    echo "$preserved" >> "$target_dir/.env.local"
  fi
}

if [ ${#APPS_TO_RUN[@]} -eq 0 ]; then
  echo "[6/6] Starting frontend..."
  write_app_env "$ROOT_DIR/frontend"
else
  echo "[6/6] Starting selected apps: ${APPS_TO_RUN[*]}"
  for app in "${APPS_TO_RUN[@]}"; do
    check_port "${APP_PORTS[$app]}" "apps/$app"
  done
fi

# Mobile reads its per-chain contract map from
# mobile/src/config/fork-contracts.json (gitignored). Regenerate it
# alongside the frontend env so either dev script gives both clients
# the same deployment in one shot. Expo's Fast Refresh picks the JSON
# up on the next import without a rebuild.
mkdir -p "$ROOT_DIR/mobile/src/config"
# Emit the tokens array only when we actually have a USDC address.
# Integration mode explicitly clears USDC/WETH (and other addresses),
# so emitting `{"address":"","symbol":"USDC",…}` unconditionally would
# plant a malformed entry in fork-contracts.json that breaks
# ConfigService.getExtraTokens() consumers.
if [ -n "$USDC" ]; then
  MOBILE_TOKENS_LINE=$'    "tokens": [\n      { "address": "'"$USDC"$'", "symbol": "USDC", "decimals": 18 }\n    ],\n'
else
  MOBILE_TOKENS_LINE=""
fi
cat > "$ROOT_DIR/mobile/src/config/fork-contracts.json" << EOF
{
  "31337": {
    "rpcUrl": "$RPC_URL",
    "weth": "$WETH",
    "commitmentPool": "$COMMITMENT_POOL",
    "privateSettlement": "$PRIVATE_SETTLEMENT",
    "identityGate": "$IDENTITY_GATE",
    "relayerRegistry": "$RELAYER_REGISTRY",
    "feeVault": "$FEE_VAULT",
    "batchExecutor": "$BATCH_EXECUTOR",
${MOBILE_TOKENS_LINE}    "relayerUrl": "http://localhost:3002",
    "sharedOrderbookUrl": "http://localhost:4000"
  }
}
EOF
echo "  Wrote mobile contracts to mobile/src/config/fork-contracts.json (chain 31337)"

# Mobile's ZK circuit artifacts (mobile/assets/zk/*.zkey|wasm) must match
# the verifiers the just-deployed contracts reference. `copy:circuits`
# is idempotent and skips unchanged files.
if [ -d "$ROOT_DIR/mobile" ]; then
  (cd "$ROOT_DIR/mobile" && npm run copy:circuits) \
    && echo "  Synced mobile ZK assets from circuits/build/" \
    || echo "  WARN: failed to copy mobile ZK assets (proofs may fail to verify)"
fi

if [ ${#APPS_TO_RUN[@]} -eq 0 ]; then
  cd "$ROOT_DIR/frontend"
  npm run dev > "$LOG_DIR/frontend.log" 2>&1 &
  last_pid=$!
  PIDS+=("$last_pid")
  if ! wait_for "http://localhost:3000" "frontend" 30; then
    echo "  Last 20 lines of frontend log:"
    tail -20 "$LOG_DIR/frontend.log" 2>/dev/null
    exit 1
  fi
  echo "  frontend running on http://localhost:3000 (PID $last_pid)"
else
  for app in "${APPS_TO_RUN[@]}"; do
    port="${APP_PORTS[$app]}"
    write_app_env "$ROOT_DIR/apps/$app"
    # `exec` makes the subshell *become* the npm process so `$!` is the
    # real server PID. Without it, the subshell PID is captured and
    # `cleanup()` would kill only the wrapper, leaving npm/next orphaned
    # and the port wedged on the next run.
    ( cd "$ROOT_DIR/apps/$app" && exec npm run dev > "$LOG_DIR/app-$app.log" 2>&1 ) &
    last_pid=$!
    PIDS+=("$last_pid")
    if ! wait_for "http://localhost:$port" "apps/$app" 30; then
      echo "  Last 20 lines of $app log:"
      tail -20 "$LOG_DIR/app-$app.log" 2>/dev/null
      exit 1
    fi
    echo "  apps/$app running on http://localhost:$port (PID $last_pid)"
  done
fi

echo ""
echo "========================================"
echo "  Local dev environment is ready!"
echo "========================================"
echo ""
if [ "$MOCK_MODE" = true ]; then
  echo "  Mode:      MOCK (MockIdentityRegistry — all users verified)"
else
  echo "  Mode:      INTEGRATION (zk-X509 IdentityRegistry)"
  echo "  Registry:  $IDENTITY_REGISTRY"
fi
echo ""
if [ ${#APPS_TO_RUN[@]} -eq 0 ]; then
  echo "  Frontend:    http://localhost:3000"
else
  for app in "${APPS_TO_RUN[@]}"; do
    printf "  apps/%-10s http://localhost:%s\n" "$app:" "${APP_PORTS[$app]}"
  done
fi
echo "  Relayer A:   http://localhost:3002"
echo "  Relayer B:   http://localhost:3003"
echo "  Orderbook:   http://localhost:4000"
echo "  Anvil:       $RPC_URL"
echo ""
echo "  RelayerRegistry:     $RELAYER_REGISTRY"
[ -n "$WETH" ] && echo "  WETH:                $WETH"
[ -n "$USDC" ] && echo "  USDC:                $USDC"
[ -n "$COMMITMENT_POOL" ] && echo "  CommitmentPool:      $COMMITMENT_POOL"
[ -n "$PRIVATE_SETTLEMENT" ] && echo "  PrivateSettlement:   $PRIVATE_SETTLEMENT"
echo ""
echo "  Logs:      $LOG_DIR/"
echo ""
if [ "$MOCK_MODE" = true ]; then
  echo "  Test accounts (anvil defaults):"
  echo "    Alice: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  echo "    Bob:   0x70997970C51812dc3A010C7d01b50e0d17dc79C8"
  echo ""
fi
echo "  Press Ctrl+C to stop all services."
echo ""

# Keep alive
set +e
wait
