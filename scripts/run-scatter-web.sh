#!/usr/bin/env bash
#
# run-scatter-web.sh — point a scatter frontend at a *deployed* network and run it.
#
# Generates apps/<app>/.env.local from the committed on-chain address ledger
# (contracts/deployments/<chainId>.json) so a teammate can clone the repo, supply
# only their own RPC key, and see the same Sepolia deployment everyone else sees.
#
#   scripts/run-scatter-web.sh <app> <network> [--no-start]
#
#     app      hub | pay | pro | operators | admin
#     network  sepolia                       (network → chainId map below)
#     --no-start   write .env.local only; do not start the dev server
#
# Why a generator (not a checked-in .env): .env.local is gitignored because it
# carries a per-developer RPC key (NEXT_PUBLIC_ → browser-exposed). The contract
# ADDRESSES are public and live in the ledger; only the RPC key is private and
# must come from each developer's own environment. This script joins the two.
#
# Idempotent: re-running regenerates .env.local. After a redeploy, refresh the
# ledger (git pull) and re-run — addresses update automatically.
#
# Required environment (network-derived, never committed):
#   SEPOLIA_RPC_URL   your own Sepolia RPC endpoint (Alchemy/Infura/your node).
#                     NEXT_PUBLIC_ vars are browser-exposed, so use YOUR key.
#   (hub needs no RPC — it only links to the other apps.)
#
# Optional overrides (sensible defaults below — central/shared services):
#   SCATTER_ORDERBOOK_URL   central shared orderbook  (default: live Sepolia box)
#   ZKX509_WEB_URL          zk-X509 CA-registration website link
#   ZK_RELAYER_URL          a relayer endpoint (operator-hosted; dev default)
#
# zk-X509 core (circuits/contracts/lib) is never touched — this is config only.
set -euo pipefail

# Pin Node to native arm64 on Apple Silicon so Next/Turbopack loads the arm64
# @next/swc (the x64 one panics under Rosetta with a BMI2 error). See the helper
# for the full rationale. Sets the NODE_RUN array used for npm below.
source "$(dirname "$0")/lib/node-arm64.sh"
setup_node_run

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- args ------------------------------------------------------------------
NO_START=0
APP=""
NETWORK=""
for a in "$@"; do
  case "$a" in
    --no-start) NO_START=1 ;;
    -h|--help)
      # Print the contiguous comment header (skip the shebang, stop at the
      # first non-comment line) so help stays usage-only as the header grows.
      awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"
      exit 0 ;;
    -*) echo "ERROR: unknown flag: $a" >&2; exit 1 ;;
    *)
      if [ -z "$APP" ]; then APP="$a"
      elif [ -z "$NETWORK" ]; then NETWORK="$a"
      else echo "ERROR: unexpected argument: $a" >&2; exit 1; fi ;;
  esac
done

case "$APP" in
  hub|pay|pro|operators|admin) ;;
  "") echo "ERROR: missing <app>. Usage: $0 <hub|pay|pro|operators|admin> <network> [--no-start]" >&2; exit 1 ;;
  *)  echo "ERROR: unknown app '$APP' (expected: hub|pay|pro|operators|admin)" >&2; exit 1 ;;
esac

# network → chainId (extend here for new networks)
case "$NETWORK" in
  sepolia) CHAIN_ID=11155111 ;;
  "") echo "ERROR: missing <network>. Supported: sepolia" >&2; exit 1 ;;
  *)  echo "ERROR: unsupported network '$NETWORK' (supported: sepolia)" >&2; exit 1 ;;
esac

APP_DIR="$ROOT_DIR/apps/$APP"
[ -d "$APP_DIR" ] || { echo "ERROR: app dir not found: $APP_DIR" >&2; exit 1; }

LEDGER="$ROOT_DIR/contracts/deployments/${CHAIN_ID}.json"
[ -f "$LEDGER" ] || { echo "ERROR: ledger not found: $LEDGER (is $NETWORK deployed? git pull?)" >&2; exit 1; }

# --- RPC (read endpoint — optional, per-developer) -------------------------
# hub links to sibling apps only; it needs no chain access.
#
# Transactions are signed and sent through the user's MetaMask node — this RPC
# is a READ endpoint only: pre-connect reads, wrong-network fallback, and the
# write gas pre-flight (kept off MetaMask's throttled node). All three work on a
# public node, so the key is OPTIONAL; supplying your own just avoids public
# rate limits under team load.
PUBLIC_RPC_DEFAULT="https://ethereum-sepolia.publicnode.com"
RPC_URL=""
if [ "$APP" != "hub" ]; then
  RPC_VAR="$(echo "$NETWORK" | tr '[:lower:]' '[:upper:]')_RPC_URL"   # SEPOLIA_RPC_URL
  RPC_URL="${!RPC_VAR:-}"
  if [ -z "$RPC_URL" ]; then
    RPC_URL="$PUBLIC_RPC_DEFAULT"
    cat >&2 <<EOF
NOTE: \$$RPC_VAR not set — using a public $NETWORK node:
        $RPC_URL
  This serves read fallbacks + gas pre-flight only; your transactions still go
  through MetaMask. Public nodes are rate-limited — for reliable team use export
  your own key (NEXT_PUBLIC_, so browser-exposed; never share it):
        export $RPC_VAR="https://eth-sepolia.g.alchemy.com/v2/<your-key>"
EOF
  fi
fi

# --- central / shared service URLs (overridable) ---------------------------
# Central shared orderbook (static-reserved IP — safe to default; see K0 ops).
ORDERBOOK_URL="${SCATTER_ORDERBOOK_URL:-http://136.115.115.93:4000}"
# zk-X509 CA-registration website (central/operator-hosted; dev default).
ZKX509_URL="${ZKX509_WEB_URL:-http://localhost:3000}"
# A relayer endpoint (operator-hosted; dev default).
RELAYER_URL="${ZK_RELAYER_URL:-http://localhost:3002}"

# Hub app links (local dev ports — match each app's `next dev -p`).
HUB_URL="${SCATTER_HUB_URL:-http://localhost:4006}"
PAY_URL="${SCATTER_PAY_URL:-http://localhost:4001}"
PRO_URL="${SCATTER_PRO_URL:-http://localhost:4003}"
OPERATORS_URL="${SCATTER_OPERATORS_URL:-http://localhost:4004}"
ADMIN_URL="${SCATTER_ADMIN_URL:-http://localhost:4005}"
DOCS_URL="${SCATTER_DOCS_URL:-http://localhost:4100}"
DROP_URL="${SCATTER_DROP_URL:-http://localhost:4002}"

# --- generate apps/<app>/.env.local ----------------------------------------
ENV_FILE="$APP_DIR/.env.local"
python3 - "$APP" "$NETWORK" "$CHAIN_ID" "$LEDGER" "$ENV_FILE" \
  "$RPC_URL" "$ORDERBOOK_URL" "$ZKX509_URL" "$RELAYER_URL" \
  "$HUB_URL" "$PAY_URL" "$PRO_URL" "$OPERATORS_URL" "$ADMIN_URL" "$DOCS_URL" "$DROP_URL" <<'PY'
import json, sys

(app, network, chain_id, ledger_path, out_path, rpc,
 orderbook, zkx509, relayer,
 hub, pay, pro, operators, admin, docs, drop) = sys.argv[1:17]

with open(ledger_path, encoding="utf-8") as f:
    L = json.load(f)

# Guard against a corrupted/mismatched ledger: the filename told us the chainId,
# so the ledger's own chainId must agree.
if str(L.get("chainId")) != str(chain_id):
    raise SystemExit(f"ERROR: {ledger_path} chainId={L.get('chainId')} != expected {chain_id}")

def addr(key):
    v = L.get(key)
    if not v:
        raise SystemExit(f"ERROR: ledger {ledger_path} is missing '{key}'")
    return v

header = [
    f"# GENERATED by scripts/run-scatter-web.sh {app} {network} — DO NOT COMMIT.",
    f"# Source ledger: contracts/deployments/{chain_id}.json (chainId {chain_id}).",
    "# Addresses are public; RPC key is yours. Re-run after a redeploy/git pull.",
    "",
]

lines = []
if app == "hub":
    # Hub is pure navigation — it links to the sibling apps, no chain access.
    lines += [
        f"NEXT_PUBLIC_PRO_URL={pro}",
        f"NEXT_PUBLIC_PAY_URL={pay}",
        f"NEXT_PUBLIC_DROP_URL={drop}",
        f"NEXT_PUBLIC_RELAYER_URL={operators}",
        f"NEXT_PUBLIC_DOCS_URL={docs}",
        f"NEXT_PUBLIC_HUB_URL={hub}",
    ]
elif app == "pay":
    # Pay uses its own NEXT_PUBLIC_PAY_* namespace.
    lines += [
        f"NEXT_PUBLIC_PAY_CHAIN_ID={chain_id}",
        f"NEXT_PUBLIC_PAY_RPC_URL={rpc}",
        f"NEXT_PUBLIC_PAY_PRIVATE_SETTLEMENT={addr('privateSettlement')}",
        f"NEXT_PUBLIC_PAY_COMMITMENT_POOL={addr('commitmentPool')}",
        f"NEXT_PUBLIC_PAY_IDENTITY_GATE={addr('identityGate')}",
        f"NEXT_PUBLIC_PAY_RELAYER_REGISTRY={addr('relayerRegistry')}",
        f"NEXT_PUBLIC_PAY_WETH={addr('weth')}",
        f"NEXT_PUBLIC_PAY_DEPLOY_BLOCK={L.get('deployBlock', 0)}",
        f"NEXT_PUBLIC_PAY_RELAYER_URL={relayer}",
        f"NEXT_PUBLIC_PAY_ZK_X509_URL={zkx509}",
        f"NEXT_PUBLIC_SHARED_ORDERBOOK_URL={orderbook}",
        f"NEXT_PUBLIC_HUB_URL={hub}",
        "# Token symbols/decimals are sourced from the on-chain whitelist (#928).",
        "# To overlay USDC/USDT/TON metadata, set NEXT_PUBLIC_PAY_{USDC,USDT,TON} here.",
    ]
else:
    # pro / operators / admin share the generic NEXT_PUBLIC_* namespace.
    lines += [
        f"NEXT_PUBLIC_CHAIN_ID={chain_id}",
        f"NEXT_PUBLIC_CHAIN_NAME={network.capitalize()}",
        f"NEXT_PUBLIC_RPC_URL={rpc}",
        f"NEXT_PUBLIC_COMMITMENT_POOL_ADDRESS={addr('commitmentPool')}",
        f"NEXT_PUBLIC_PRIVATE_SETTLEMENT_ADDRESS={addr('privateSettlement')}",
        f"NEXT_PUBLIC_IDENTITY_GATE_ADDRESS={addr('identityGate')}",
        f"NEXT_PUBLIC_RELAYER_REGISTRY_ADDRESS={addr('relayerRegistry')}",
        f"NEXT_PUBLIC_FEE_VAULT_ADDRESS={addr('feeVault')}",
        f"NEXT_PUBLIC_WETH_ADDRESS={addr('weth')}",
        f"NEXT_PUBLIC_SHARED_ORDERBOOK_URL={orderbook}",
        f"NEXT_PUBLIC_ZK_RELAYER_URL={relayer}",
        f"NEXT_PUBLIC_HUB_URL={hub}",
    ]
    # Token addresses come from the on-chain whitelist (#928/#929); env is a
    # metadata fallback. Omitted here since the ledger has no symbol/decimals.
    if app in ("operators", "admin"):
        lines += [
            f"NEXT_PUBLIC_ISSUANCE_APPROVAL_REGISTRY_ADDRESS={L.get('issuanceApprovalRegistry','')}",
            f"NEXT_PUBLIC_CA_REGISTRATION_URL={zkx509}",
            f"NEXT_PUBLIC_ZK_X509_URL={zkx509}",
        ]
    if app == "admin":
        lines += [
            f"NEXT_PUBLIC_SANCTIONS_LIST_ADDRESS={addr('sanctionsList')}",
            f"NEXT_PUBLIC_TREASURY_ADDRESS={addr('treasury')}",
            f"NEXT_PUBLIC_OPERATORS_URL={operators}",
        ]

with open(out_path, "w", encoding="utf-8") as f:
    f.write("\n".join(header + lines) + "\n")

print(f"  wrote {out_path}")
PY

echo "Generated apps/$APP/.env.local for $NETWORK (chainId $CHAIN_ID)."

# --- start dev server ------------------------------------------------------
if [ "$NO_START" = 1 ]; then
  echo "(--no-start) env written; not starting the dev server."
  exit 0
fi

# Each app is a standalone npm project (there is no root workspace), so a fresh
# clone has no node_modules. Install on first run so "clone → run script" just
# works — no manual npm install and no `next build` (dev compiles on the fly).
install_if_needed "$APP_DIR"

echo "Starting '$APP' dev server (cd apps/$APP && npm run dev)…"
cd "$APP_DIR"
exec "${NODE_RUN[@]}" run dev
