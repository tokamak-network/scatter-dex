#!/usr/bin/env bash
#
# run-zkx509-web.sh — point the zk-X509 management website at a deployed network
# and run its frontend.
#
#   scripts/run-zkx509-web.sh <network> [--no-start] [--with-local-backend]
#
#     network               sepolia                  (network → chainId map below)
#     --no-start            write .env.local only; do not start the frontend
#     --with-local-backend  also generate backend/.env and start a LOCAL backend
#                           (default: backend is CENTRAL — not started here)
#
# Topology (per K0 ops):
#   * frontend  — factory-centric UI; reads RegistryFactory.getRegistries().
#                 Works against the chain with only a wallet + RPC; NO backend
#                 needed for registry browse / addCA / dashboard.
#   * backend   — offline metadata/CMS (display names, notices, CA guide, GitHub
#                 PR submission). It is a CENTRAL service (a per-developer
#                 localhost copy would not share metadata) — so this script does
#                 NOT start it unless --with-local-backend is passed.
#   * prover    — NOT deployed → wallet `verify` (proof submission) is unavailable.
#                 On-chain read/write (addCA, browse) still works with a wallet.
#
# Address source: the zk-X509 repo's own ledger ($ZK_X509_REPO/deployments/
# <chainId>.json) — self-contained with the frontend. Falls back to scatter-dex's
# committed copy (contracts/deployments/zk-x509-{factory,users}-<chainId>.json)
# when the zk-X509 ledger is absent.
#
# zk-X509 core (circuits/contracts/lib) is never modified — config only.
#
# Optional overrides:
#   ZK_X509_REPO         path to the zk-X509 checkout      (default: ../zk-X509)
#   ZKX509_RPC_URL (or SEPOLIA_RPC_URL)  your own Sepolia RPC endpoint.
#       The zk-X509 frontend routes ALL node access (read + write) through the
#       connected wallet — it does NOT use NEXT_PUBLIC_RPC_URL to read the chain.
#       So this is OPTIONAL; unset → a keyless public node default is written
#       (display/reference only). Set it to YOUR key if you want; it's
#       browser-exposed via NEXT_PUBLIC_, so never share a key.
#   ZKX509_BACKEND_URL   central metadata/CMS backend URL  (default: placeholder)
set -euo pipefail

# Pin Node to native arm64 on Apple Silicon so Next/Turbopack loads the arm64
# @next/swc (the x64 one panics under Rosetta with a BMI2 error). See the helper
# for the full rationale. Sets the NODE_RUN array used for npm below.
source "$(dirname "$0")/lib/node-arm64.sh"
setup_node_run

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- args ------------------------------------------------------------------
NO_START=0
WITH_LOCAL_BACKEND=0
NETWORK=""
for a in "$@"; do
  case "$a" in
    --no-start) NO_START=1 ;;
    --with-local-backend) WITH_LOCAL_BACKEND=1 ;;
    -h|--help)
      # Print the contiguous comment header (skip the shebang, stop at the
      # first non-comment line) so help stays usage-only as the header grows.
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0 ;;
    -*) echo "ERROR: unknown flag: $a" >&2; exit 1 ;;
    *)
      if [ -z "$NETWORK" ]; then NETWORK="$a"
      else echo "ERROR: unexpected argument: $a" >&2; exit 1; fi ;;
  esac
done

case "$NETWORK" in
  sepolia) CHAIN_ID=11155111 ;;
  "") echo "ERROR: missing <network>. Supported: sepolia" >&2; exit 1 ;;
  *)  echo "ERROR: unsupported network '$NETWORK' (supported: sepolia)" >&2; exit 1 ;;
esac

# --- locate the zk-X509 repo -----------------------------------------------
ZK_X509_REPO="${ZK_X509_REPO:-$ROOT_DIR/../zk-X509}"
if [ ! -d "$ZK_X509_REPO/frontend" ]; then
  cat >&2 <<EOF
ERROR: zk-X509 frontend not found at: $ZK_X509_REPO/frontend

  Set ZK_X509_REPO to your zk-X509 checkout, e.g.:
    export ZK_X509_REPO="\$HOME/src/zk-X509"
  Then re-run: $0 $NETWORK
EOF
  exit 1
fi

# --- resolve the address ledger --------------------------------------------
# Prefer the zk-X509 repo's own ledger; fall back to scatter-dex's copy.
ZKX509_LEDGER="$ZK_X509_REPO/deployments/${CHAIN_ID}.json"
FACTORY_LEDGER="$ROOT_DIR/contracts/deployments/zk-x509-factory-${CHAIN_ID}.json"
USERS_LEDGER="$ROOT_DIR/contracts/deployments/zk-x509-users-${CHAIN_ID}.json"

LEDGER_MODE=""
if [ -f "$ZKX509_LEDGER" ]; then
  LEDGER_MODE="zkx509"
elif [ -f "$FACTORY_LEDGER" ] && [ -f "$USERS_LEDGER" ]; then
  LEDGER_MODE="scatter"
  echo "NOTE: $ZKX509_LEDGER not found — falling back to scatter-dex zk-x509 ledger."
else
  echo "ERROR: no zk-X509 ledger for chainId $CHAIN_ID." >&2
  echo "  Looked for: $ZKX509_LEDGER" >&2
  echo "          or: $FACTORY_LEDGER + $USERS_LEDGER" >&2
  exit 1
fi

# --- RPC (optional — display/reference only) -------------------------------
# The zk-X509 frontend reads AND writes through the connected wallet (MetaMask);
# it never uses NEXT_PUBLIC_RPC_URL to talk to the chain (see lib/useReadProvider
# .ts). So a key is not required to run the app. When unset we write a keyless
# public node so the value isn't empty; set your own key only if you want it.
case "$NETWORK" in
  sepolia) DEFAULT_RPC_URL="https://ethereum-sepolia.publicnode.com" ;;
  *)       DEFAULT_RPC_URL="" ;;
esac
USER_RPC_URL="${ZKX509_RPC_URL:-${SEPOLIA_RPC_URL:-}}"
RPC_URL="${USER_RPC_URL:-$DEFAULT_RPC_URL}"
if [ -z "$USER_RPC_URL" ]; then
  echo "NOTE: no \$ZKX509_RPC_URL/\$SEPOLIA_RPC_URL set — using keyless public node"
  echo "      ($RPC_URL). The frontend reads via your wallet, so this is fine."
fi

# Central metadata/CMS backend — placeholder until the central host is set.
# (The frontend works without it; only notices / CA-guide panels need it.)
BACKEND_URL="${ZKX509_BACKEND_URL:-http://localhost:4000}"
CA_REGISTRY_URL="https://github.com/tokamak-network/zk-x509-ca-registry"

# --- generate frontend/.env.local ------------------------------------------
FRONTEND_ENV="$ZK_X509_REPO/frontend/.env.local"
python3 - "$LEDGER_MODE" "$CHAIN_ID" "$NETWORK" "$ZKX509_LEDGER" "$FACTORY_LEDGER" "$USERS_LEDGER" \
  "$FRONTEND_ENV" "$RPC_URL" "$BACKEND_URL" "$CA_REGISTRY_URL" <<'PY'
import json, sys

(mode, chain_id, network, zkx509_ledger, factory_ledger, users_ledger,
 out_path, rpc, backend, ca_registry) = sys.argv[1:11]

def load(p):
    with open(p, encoding="utf-8") as f:
        return json.load(f)

if mode == "zkx509":
    L = load(zkx509_ledger)
    if L.get("chainId") is not None and str(L.get("chainId")) != str(chain_id):
        raise SystemExit(f"ERROR: {zkx509_ledger} chainId={L.get('chainId')} != expected {chain_id}")
    factory = L.get("registryFactory")
    users = (L.get("registries") or {}).get("users") or {}
    registry = users.get("address")
    src = zkx509_ledger
else:  # scatter-dex fallback (two separate files)
    F = load(factory_ledger)
    U = load(users_ledger)
    for path, d in ((factory_ledger, F), (users_ledger, U)):
        if d.get("chainId") is not None and str(d.get("chainId")) != str(chain_id):
            raise SystemExit(f"ERROR: {path} chainId={d.get('chainId')} != expected {chain_id}")
    factory = F.get("registryFactory")
    registry = U.get("identityRegistry")
    src = f"{factory_ledger} + {users_ledger}"

if not factory:
    raise SystemExit(f"ERROR: registryFactory missing in {src}")
if not registry:
    raise SystemExit(f"ERROR: users registry address missing in {src}")

lines = [
    f"# GENERATED by scripts/run-zkx509-web.sh {network} — DO NOT COMMIT.",
    f"# Address source: {src} (chainId {chain_id}).",
    "# RPC is display-only (frontend reads via wallet). Re-run after redeploy/git pull.",
    "",
    f"NEXT_PUBLIC_CHAIN_ID={chain_id}",
    f"NEXT_PUBLIC_RPC_URL={rpc}",
    f"NEXT_PUBLIC_FACTORY_ADDRESS={factory}",
    f"NEXT_PUBLIC_REGISTRY_ADDRESS={registry}",
    f"NEXT_PUBLIC_BACKEND_URL={backend}",
    f"NEXT_PUBLIC_CA_REGISTRY_URL={ca_registry}",
]
with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(lines) + "\n")
print(f"  wrote {out_path}")
print(f"  factory  = {factory}")
print(f"  registry = {registry}")
PY

echo "Generated zk-X509 frontend/.env.local for $NETWORK (chainId $CHAIN_ID)."

# --- optional local backend/.env -------------------------------------------
if [ "$WITH_LOCAL_BACKEND" = 1 ]; then
  BACKEND_ENV="$ZK_X509_REPO/backend/.env"
  if [ -d "$ZK_X509_REPO/backend" ]; then
    {
      echo "# GENERATED by scripts/run-zkx509-web.sh --with-local-backend — DO NOT COMMIT."
      echo "RPC_URL=$RPC_URL"
      echo "CHAIN_ID=$CHAIN_ID"
      echo "PORT=4000"
    } > "$BACKEND_ENV"
    echo "Generated zk-X509 backend/.env (local backend on :4000)."
  else
    echo "WARN: --with-local-backend given but $ZK_X509_REPO/backend not found; skipping." >&2
  fi
fi

# --- start ------------------------------------------------------------------
if [ "$NO_START" = 1 ]; then
  echo "(--no-start) env written; not starting the frontend."
  exit 0
fi

LOCAL_BACKEND=0
if [ "$WITH_LOCAL_BACKEND" = 1 ] && [ -d "$ZK_X509_REPO/backend" ]; then
  # Reuse an already-running backend on :4000 instead of starting a duplicate
  # (avoids "port in use" and leaves the existing process untouched).
  if lsof -nP -iTCP:4000 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Local zk-X509 backend already running on :4000 — reusing it."
  else
    echo "Starting local zk-X509 backend (cd backend && npm run dev) in background…"
    ( cd "$ZK_X509_REPO/backend" && "${NODE_RUN[@]}" run dev ) &
    BACKEND_PID=$!
    LOCAL_BACKEND=1
    # Reap the background backend when the frontend exits so it doesn't leak and
    # keep port 4000 held on the next run. (Only when WE started it.)
    trap 'kill "$BACKEND_PID" 2>/dev/null || true' EXIT INT TERM
  fi
fi

install_if_needed "$ZK_X509_REPO/frontend"

echo "Starting zk-X509 frontend (cd frontend && npm run dev)…"
cd "$ZK_X509_REPO/frontend"
if [ "$LOCAL_BACKEND" = 1 ]; then
  # Don't exec — the shell must survive to run the cleanup trap above.
  "${NODE_RUN[@]}" run dev
else
  exec "${NODE_RUN[@]}" run dev
fi
