#!/bin/bash
# Non-interactive E2E environment bring-up for CI.
#
# Brings up: anvil → DeployLocal (mock IdentityRegistry) → shared OB
# (port 4000) → Relayer A (3002) → Relayer B (3003) → registers Relayer B
# on RelayerRegistry. Writes background PIDs to `.e2e-pids` and exits 0
# once everything is reachable. Companion `stop-e2e-env.sh` tears it down.
#
# Differs from `dev.sh --mock` + `start-cross-relayer-e2e.sh`:
#   - No EXIT/SIGINT trap killing background services (CI runs the next
#     step against this same env).
#   - No trailing `wait` (the script must exit so CI can move on).
#   - Skips circuit build — CI handles that with caching upstream.
#
# Prerequisites (CI installs these; honoured via PATH):
#   - foundry (forge, anvil, cast)
#   - node 20 + npm install in shared-orderbook/ and zk-relayer/
#   - circuits/build/ already populated (Verifier.sol + zkeys + wasm)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$ROOT_DIR/.e2e-logs"
PID_FILE="$ROOT_DIR/.e2e-pids"
mkdir -p "$LOG_DIR"
: > "$PID_FILE"

DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
RELAYER_A_KEY="0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"  # anvil #1
RELAYER_B_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"  # anvil #2
RELAYER_B_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"  # cast-derived from RELAYER_B_KEY; needed for isActiveRelayer() check below
RPC_URL="${RPC_URL:-http://localhost:8545}"

record_pid() { echo "$1" >> "$PID_FILE"; }

wait_for() {
  local url="$1" name="$2" max="${3:-30}" i=0
  while [ "$i" -lt "$max" ]; do
    if curl -fsS "$url" -X POST -H "Content-Type: application/json" \
        -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}' > /dev/null 2>&1; then
      return 0
    fi
    if curl -fsS "$url" > /dev/null 2>&1; then
      return 0
    fi
    i=$((i + 1))
    sleep 1
  done
  echo "  ERROR: $name failed to start (waited ${max}s)"
  return 1
}

echo "=== ScatterDEX E2E env (CI) ==="

# Ensure each gitignored `*Verifier.sol` was generated from the
# `*_final.zkey` sitting next to it. The zkey/.sol pair is non-deterministic
# (Groth16 phase-2 picks fresh entropy), so a `*_final.zkey` from a manual
# rebuild + a `Verifier.sol` from an earlier build = every Groth16 proof
# reverts `InvalidProof()` after deploy. dev.sh/dev-fork.sh avoid this by
# regenerating zkeys + verifiers atomically; this script skips that to stay
# CI-friendly, but it still needs to defend the invariant — so we re-export
# Verifier.sol straight from the current zkey before deploy. Cheap
# (~1s/circuit, no phase-2 rerun); no-op when artifacts are already aligned.
sync_verifiers_from_zkeys() {
  local circuits_dir="$ROOT_DIR/circuits"
  local snarkjs="$circuits_dir/node_modules/.bin/snarkjs"
  if [ ! -x "$snarkjs" ]; then
    echo "  ERROR: snarkjs not found at $snarkjs — run 'npm ci' in circuits/"
    exit 1
  fi
  # circuit:VerifierName pairs. BatchAuthorizeVerifier is hand-written
  # (tracked, not gitignored) — kept in sync separately by whoever edits
  # the circuit. The list mirrors the gitignored entries in .gitignore
  # and `circuits/scripts/build.sh`'s `verifier_name_for()`.
  local pairs=(
    "authorize:AuthorizeVerifier"
    "authorize_64:AuthorizeVerifier_64"
    "authorize_128:AuthorizeVerifier_128"
    "claim:ClaimVerifier"
    "claim_64:ClaimVerifier_64"
    "claim_128:ClaimVerifier_128"
    "deposit:DepositVerifier"
    "withdraw:WithdrawVerifier"
    "cancel:CancelVerifier"
  )
  local skipped=0 exported=0
  for pair in "${pairs[@]}"; do
    local circ="${pair%%:*}"
    local vname="${pair##*:}"
    local zkey_rel="build/${circ}_final.zkey"
    local zkey="$circuits_dir/$zkey_rel"
    local sol="$ROOT_DIR/contracts/src/zk/${vname}.sol"
    if [ ! -f "$zkey" ]; then
      echo "  ERROR: missing $zkey — run circuits/scripts/build.sh first"
      exit 1
    fi
    # Skip when the existing .sol is already newer than the zkey it
    # was generated from — the export is deterministic for a given
    # zkey, so an up-to-date .sol cannot disagree. Saves ~2s/run when
    # nothing changed.
    if [ -f "$sol" ] && [ "$sol" -nt "$zkey" ]; then
      skipped=$((skipped + 1))
      continue
    fi
    local out
    out=$( cd "$circuits_dir" && "$snarkjs" zkey export solidityverifier \
        "$zkey_rel" "$sol" 2>&1 ) \
      || { echo "  ERROR: snarkjs export failed for $circ:"; echo "$out"; exit 1; }
    exported=$((exported + 1))
  done
  echo "  [ok] verifiers in sync (re-exported: $exported, already current: $skipped)"

  # BatchAuthorizeVerifier is hand-written (5-pairing aggregator over
  # two authorize.circom proofs) so the snarkjs loop above can't touch
  # it. Run the dedicated patcher to keep its VK constants in sync with
  # the authorize zkey — without this, any future `setBatchAuthorizeVerifier`
  # wire-up reverts every same-tier settleAuth with `InvalidProof()`.
  local batch_out
  batch_out=$( node "$ROOT_DIR/circuits/scripts/sync-batch-verifier-vk.mjs" 2>&1 ) \
    || { echo "  ERROR: BatchAuthorizeVerifier sync failed:"; echo "$batch_out"; exit 1; }
  echo "  [ok] $batch_out"

  # Sync the canonical zkey + wasm from circuits/build to every
  # consumer that fetches them at runtime (frontend, apps/pro,
  # apps/pay). circuits/scripts/build.sh copies to frontend +
  # apps/pro; apps/pay's predev mirrors apps/pro into its own
  # public/zk. Each hop is a drift opportunity — if any consumer
  # zkey OR wasm diverges from the canonical one the on-chain
  # Verifier.sol was exported from, every proof on that flow
  # reverts with the opaque `InvalidProof()` error the per-side
  # Verifier sync above also guards. (wasm drift breaks witness
  # generation before proving even reaches the verifier, so both
  # must stay in lock-step.) Force-overwrite (cmp + cp) so the
  # canonical circuits/build copy wins regardless of which local
  # rebuild last touched the consumer path. `mkdir -p` the target
  # so a fresh checkout where the consumer's public/zk dir doesn't
  # exist yet gets created cleanly instead of silently skipped.
  local zk_targets=(
    "$ROOT_DIR/frontend/public/zk"
    "$ROOT_DIR/apps/pro/public/zk"
    "$ROOT_DIR/apps/pay/public/zk"
  )
  local zk_circuits=(
    deposit withdraw cancel claim claim_64 claim_128
    authorize authorize_64 authorize_128
  )
  local zk_copied=0
  for target in "${zk_targets[@]}"; do
    # Only sync into a consumer whose parent app dir exists in
    # this checkout — skips e.g. apps/pay when running against a
    # frontend-only tree, while still creating public/zk on first
    # boot of an app that ships with empty public/.
    local parent="$(dirname "$target")"
    [ -d "$parent" ] || continue
    mkdir -p "$target"
    for circ in "${zk_circuits[@]}"; do
      local zkey="$circuits_dir/build/${circ}_final.zkey"
      local wasm="$circuits_dir/build/${circ}_js/${circ}.wasm"
      if [ -f "$zkey" ]; then
        local dst="$target/${circ}_final.zkey"
        if [ ! -f "$dst" ] || ! cmp -s "$zkey" "$dst"; then
          cp "$zkey" "$dst"
          zk_copied=$((zk_copied + 1))
        fi
      fi
      if [ -f "$wasm" ]; then
        local dst="$target/${circ}.wasm"
        if [ ! -f "$dst" ] || ! cmp -s "$wasm" "$dst"; then
          cp "$wasm" "$dst"
          zk_copied=$((zk_copied + 1))
        fi
      fi
    done
  done
  echo "  [ok] consumer zk assets in sync (copied: $zk_copied)"
}

echo ""
echo "[pre] Syncing Verifier.sol with zkeys..."
sync_verifiers_from_zkeys

# ── 1. anvil ────────────────────────────────────────────────
echo ""
echo "[1/5] Starting anvil..."
anvil --silent --hardfork prague > "$LOG_DIR/anvil.log" 2>&1 &
record_pid $!
wait_for "$RPC_URL" "anvil" 15 || { tail -30 "$LOG_DIR/anvil.log"; exit 1; }
echo "  [ok] anvil on $RPC_URL"

# ── 2. Deploy contracts ─────────────────────────────────────
echo ""
echo "[2/5] Deploying contracts (DeployLocal, mock identity)..."
cd "$ROOT_DIR/contracts"
# `set +e` window matches dev.sh: forge can exit non-zero on benign
# stdout-not-a-terminal / contract-size warnings even when the deploy
# succeeded. Surface anything else.
set +e
DEPLOY_OUTPUT=$(NO_COLOR=1 forge script script/DeployLocal.s.sol:DeployLocal \
  --rpc-url "$RPC_URL" --broadcast --private-key "$DEPLOYER_KEY" 2>&1)
DEPLOY_STATUS=$?
set -e
if [ "$DEPLOY_STATUS" -ne 0 ] \
    && ! echo "$DEPLOY_OUTPUT" | grep -qE "Contract size|contract size|not a terminal|runtime size limit"; then
  echo "  ERROR: forge script failed (exit $DEPLOY_STATUS):"
  echo "$DEPLOY_OUTPUT"
  exit 1
fi

# Proxy migration changed the deploy log: each upgradeable contract now
# prints `Name impl: <addr>` + `Name proxy: <addr>` (apps consume the proxy).
# Non-upgradeable contracts (WETH, USDC, ...) still use the bare `Name: <addr>`
# form. Prefer `proxy:` when present; fall back to the bare label otherwise.
parse_addr() {
    local addr
    addr=$(echo "$DEPLOY_OUTPUT" | grep "^  $1 proxy:" | head -1 | awk '{print $NF}')
    if [ -z "$addr" ]; then
        addr=$(echo "$DEPLOY_OUTPUT" | grep "^  $1:" | head -1 | awk '{print $NF}')
    fi
    echo "$addr"
}
RELAYER_REGISTRY=$(parse_addr RelayerRegistry)
WETH=$(parse_addr WETH)
USDC=$(parse_addr USDC)
USDT=$(parse_addr USDT)
TON=$(parse_addr TON)
COMMITMENT_POOL=$(parse_addr CommitmentPool)
PRIVATE_SETTLEMENT=$(parse_addr PrivateSettlement)
FEE_VAULT=$(parse_addr FeeVault)
IDENTITY_GATE=$(parse_addr IdentityGate)
# Non-upgradeable, printed via the bare `Name: <addr>` form.
ISSUANCE_APPROVAL_REGISTRY=$(parse_addr IssuanceApprovalRegistry)

for var in RELAYER_REGISTRY WETH USDC USDT TON COMMITMENT_POOL PRIVATE_SETTLEMENT FEE_VAULT IDENTITY_GATE; do
  if [ -z "${!var}" ]; then
    echo "  ERROR: missing $var in deploy output"
    echo "$DEPLOY_OUTPUT"
    exit 1
  fi
done
# IssuanceApprovalRegistry is optional in deploy output (legacy
# DeployLocal builds didn't ship it); warn rather than abort so a
# pinned older contracts build still boots the stack. Operators app
# falls through to the `idle` CTA state in that case.
if [ -z "$ISSUANCE_APPROVAL_REGISTRY" ]; then
  echo "  [warn] missing IssuanceApprovalRegistry in deploy output — operators /register approval CTA will stay idle"
fi
echo "  [ok] deployed (CommitmentPool=$COMMITMENT_POOL)"

# Rewrite apps/pay/.env.local with the just-deployed proxy addresses.
# Pay reads NEXT_PUBLIC_PAY_* at build time, and the previous values were
# whatever a prior `dev.sh --apps pay` run left behind — silently stale
# after every redeploy. Pay E2E specs that depend on the IdentityGate
# (or any other proxy-deployed contract) need this sync to do anything
# meaningful. Matches the block dev.sh writes; preserves operator-set
# values (ONEINCH_API_KEY, CSP overrides, etc.) the same way.
PAY_ENV="$ROOT_DIR/apps/pay/.env.local"
if [ -d "$ROOT_DIR/apps/pay" ]; then
  PRESERVED=""
  if [ -f "$PAY_ENV" ]; then
    PRESERVED=$(grep -E '^(ONEINCH_API_KEY|CSP_EXTRA_CONNECT_SRC|NEXT_PUBLIC_MAINNET_RPC|NEXT_PUBLIC_HUB_URL)=' "$PAY_ENV" 2>/dev/null || true)
  fi
  DEPLOY_BLOCK=$(cast block-number --rpc-url "$RPC_URL" 2>/dev/null || echo 0)
  # Build the would-be file in a temp buffer first; only swap if it
  # differs from the on-disk copy. DeployLocal is deterministic against
  # a fresh anvil, so the proxy addresses match on every reboot —
  # skipping the rewrite when nothing changed avoids `next dev`'s
  # `.env.local` watcher tripping a needless reload (sub-second but
  # surfaces in WebServer log noise during back-to-back spec runs).
  # Mirror dev.sh's cache-buster: derive a short content hash from
  # the deposit zkey so the IndexedDB-cached assets get a new key on
  # every redeploy that ships fresh zkeys. Keep in sync with dev.sh.
  ZK_ASSETS_VERSION=""
  if [ -f "$ROOT_DIR/circuits/build/deposit_final.zkey" ]; then
    if command -v shasum >/dev/null 2>&1; then
      ZK_ASSETS_VERSION=$(shasum -a 256 "$ROOT_DIR/circuits/build/deposit_final.zkey" | awk '{print substr($1,1,12)}')
    elif command -v sha256sum >/dev/null 2>&1; then
      ZK_ASSETS_VERSION=$(sha256sum "$ROOT_DIR/circuits/build/deposit_final.zkey" | awk '{print substr($1,1,12)}')
    fi
  fi
  NEW_ENV=$(cat <<EOF
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
NEXT_PUBLIC_PAY_DEPLOY_BLOCK=$DEPLOY_BLOCK
NEXT_PUBLIC_ZK_ASSETS_VERSION=$ZK_ASSETS_VERSION
EOF
)
  [ -n "$PRESERVED" ] && NEW_ENV="$NEW_ENV
$PRESERVED"
  if [ -f "$PAY_ENV" ] && [ "$(cat "$PAY_ENV")" = "$NEW_ENV" ]; then
    echo "  [ok] $PAY_ENV already in sync (IdentityGate=$IDENTITY_GATE)"
  else
    printf "%s\n" "$NEW_ENV" > "$PAY_ENV"
    echo "  [ok] wrote $PAY_ENV (IdentityGate=$IDENTITY_GATE)"
  fi
fi

# Sync IssuanceApprovalRegistry into apps/operators/.env.local so
# the new /register approval-aware CTA reads from the freshly-
# deployed contract rather than staying in `idle`. Only this single
# key — the rest of the file is hand-maintained by the operators-
# app maintainer (see dual_ca_gate_model memory for why operators
# env diverged from Pay's). Idempotent: in-place updates the line
# when present, appends when absent, no-op when value matches.
OPERATORS_ENV="$ROOT_DIR/apps/operators/.env.local"
if [ -n "$ISSUANCE_APPROVAL_REGISTRY" ] && [ -f "$OPERATORS_ENV" ]; then
  KEY="NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS"
  EXPECTED_LINE="$KEY=$ISSUANCE_APPROVAL_REGISTRY"
  if grep -qE "^${KEY}=" "$OPERATORS_ENV"; then
    EXISTING=$(grep -E "^${KEY}=" "$OPERATORS_ENV" | head -1)
    if [ "$EXISTING" = "$EXPECTED_LINE" ]; then
      echo "  [ok] $OPERATORS_ENV already has $KEY"
    else
      # macOS sed needs `-i ''`; GNU sed accepts `-i`. Use a temp
      # file to stay portable across both.
      TMP=$(mktemp)
      grep -vE "^${KEY}=" "$OPERATORS_ENV" > "$TMP"
      printf "%s\n" "$EXPECTED_LINE" >> "$TMP"
      mv "$TMP" "$OPERATORS_ENV"
      echo "  [ok] updated $KEY in $OPERATORS_ENV"
    fi
  else
    printf "%s\n" "$EXPECTED_LINE" >> "$OPERATORS_ENV"
    echo "  [ok] appended $KEY to $OPERATORS_ENV"
  fi
fi

# ── 3. Shared orderbook ─────────────────────────────────────
# Mirror dev.sh's CORS allowlist union so CI e2e specs that drive
# any --apps mode app (Pay :4001, Drop :4002, Pro :4003, Operators
# :4004) don't get blocked by CORS preflight. Kept hardcoded here
# (rather than sourced from dev.sh) since this script is CI-targeted
# and must run without an active dev.sh shell — keep this list in
# sync with dev.sh's APP_PORTS dictionary.
DEV_CORS_ORIGINS="http://localhost:3000,http://localhost:3002,http://localhost:3003,http://localhost:4001,http://localhost:4002,http://localhost:4003,http://localhost:4004"

echo ""
echo "[3/5] Starting shared-orderbook (port 4000)..."
cd "$ROOT_DIR/shared-orderbook"
CORS_ORIGINS="$DEV_CORS_ORIGINS" PORT=4000 ALLOW_PRIVATE_RELAYER_URLS=1 \
  npm run dev > "$LOG_DIR/orderbook.log" 2>&1 &
record_pid $!
wait_for "http://localhost:4000/health" "shared-orderbook" 30 \
  || { tail -30 "$LOG_DIR/orderbook.log"; exit 1; }
echo "  [ok] orderbook on :4000"

# ── 4. Relayer A & B ────────────────────────────────────────
start_relayer() {
  local name="$1" port="$2" key="$3" db="$4" log="$5"
  cd "$ROOT_DIR/zk-relayer"
  RPC_URL="$RPC_URL" \
  RELAYER_PRIVATE_KEY="$key" \
  COMMITMENT_POOL_ADDRESS="$COMMITMENT_POOL" \
  PRIVATE_SETTLEMENT_ADDRESS="$PRIVATE_SETTLEMENT" \
  FEE_VAULT_ADDRESS="$FEE_VAULT" \
  PORT="$port" \
  RELAYER_FEE=30 \
  DB_PATH="$ROOT_DIR/zk-relayer/$db" \
  SHARED_ORDERBOOK_URL="http://localhost:4000" \
  RELAYER_PUBLIC_URL="http://localhost:$port" \
  RELAYER_NAME="$name" \
  CORS_ORIGINS="$DEV_CORS_ORIGINS" \
  ALLOW_PRIVATE_RELAYER_URLS=1 npm run dev > "$LOG_DIR/$log" 2>&1 &
  record_pid $!
  wait_for "http://localhost:$port/api/info" "$name" 30 \
    || { tail -30 "$LOG_DIR/$log"; return 1; }
  echo "  [ok] $name on :$port"
}

echo ""
echo "[4/5] Starting Relayer A & B..."
# Fresh DBs each CI run so prior state never leaks across invocations.
# Glob also catches SQLite WAL/SHM sidecar files (`-wal`/`-shm`) that
# can otherwise retain in-flight state across reruns on the same runner.
rm -f "$ROOT_DIR/zk-relayer/zk-relayer"*.db*
start_relayer "Relayer-A" 3002 "$RELAYER_A_KEY" "zk-relayer.db"   "relayer-a.log"
start_relayer "Relayer-B" 3003 "$RELAYER_B_KEY" "zk-relayer-b.db" "relayer-b.log"

# ── 5. Register Relayer B on-chain ──────────────────────────
# Must succeed: PrivateSettlement.settleAuth gates on
# RelayerRegistry.isActiveRelayer() for both maker and taker relayers.
# A silently-skipped registration would surface only as an opaque
# `NotActiveRelayer` revert in the e2e test, so fail fast here instead.
echo ""
echo "[5/5] Registering Relayer B on RelayerRegistry..."
if cast call "$RELAYER_REGISTRY" "isActiveRelayer(address)(bool)" "$RELAYER_B_ADDR" \
    --rpc-url "$RPC_URL" 2>/dev/null | grep -q true; then
  echo "  [ok] already active"
else
  # `register` signature post-RelayerRegistry proxy migration is
  # (url, name, fee, bondAmount). minBond defaults to 0 in MOCK mode so
  # bondAmount=0 and msg.value=0 both satisfy `_pullBond`.
  if ! cast send "$RELAYER_REGISTRY" "register(string,string,uint256,uint256)" \
      "http://localhost:3003" "Relayer-B" 30 0 \
      --private-key "$RELAYER_B_KEY" --rpc-url "$RPC_URL" > /dev/null 2>&1; then
    echo "  ERROR: register() failed"
    exit 1
  fi
  if ! cast call "$RELAYER_REGISTRY" "isActiveRelayer(address)(bool)" "$RELAYER_B_ADDR" \
      --rpc-url "$RPC_URL" 2>/dev/null | grep -q true; then
    echo "  ERROR: register() returned ok but isActiveRelayer() is still false"
    exit 1
  fi
  echo "  [ok] Relayer B registered + active"
fi

echo ""
echo "READY"
echo "  COMMITMENT_POOL=$COMMITMENT_POOL"
echo "  PRIVATE_SETTLEMENT=$PRIVATE_SETTLEMENT"
echo "  FEE_VAULT=$FEE_VAULT"
echo "  USDC=$USDC"
echo "  WETH=$WETH"
echo "  PIDs: $(tr '\n' ' ' < "$PID_FILE")"

# Propagate deployed addresses to the GitHub Actions env so downstream
# steps don't have to hardcode them. No-op outside CI (unset $GITHUB_ENV).
if [ -n "$GITHUB_ENV" ]; then
  {
    echo "E2E_USDC_ADDRESS=$USDC"
    echo "E2E_WETH_ADDRESS=$WETH"
    echo "E2E_COMMITMENT_POOL=$COMMITMENT_POOL"
    echo "E2E_PRIVATE_SETTLEMENT=$PRIVATE_SETTLEMENT"
    echo "E2E_FEE_VAULT=$FEE_VAULT"
  } >> "$GITHUB_ENV"
fi
