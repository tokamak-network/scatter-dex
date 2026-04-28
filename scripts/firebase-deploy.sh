#!/usr/bin/env bash
# Build hub/docs/pro as static exports and deploy to Firebase Hosting.
# Usage:
#   ./scripts/firebase-deploy.sh           # deploy all three sites
#   ./scripts/firebase-deploy.sh hub       # deploy a single target
#   ./scripts/firebase-deploy.sh hub docs  # deploy multiple targets
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ALL_TARGETS=(hub docs pro pay)
# `"${@:-${ALL_TARGETS[@]}}"` collapses the default into one quoted
# string when no args are passed, so an explicit branch is needed to
# preserve word splitting for the array assignment.
if [ "$#" -eq 0 ]; then
  TARGETS=("${ALL_TARGETS[@]}")
else
  TARGETS=("$@")
fi

declare -A APP_DIR=(
  [hub]="apps/hub"
  [docs]="apps/docs"
  [pro]="apps/pro"
  [pay]="apps/pay"
)

# Production URLs baked into static exports at build time. `.env.local`
# in each app holds dev URLs (localhost:*) and overrides .env.production
# in Next's loader order, so we inject prod values here instead.
export NEXT_PUBLIC_HUB_URL="https://zkscatter-hub.web.app"
export NEXT_PUBLIC_DOCS_URL="https://zkscatter-docs.web.app"
export NEXT_PUBLIC_PRO_URL="https://zkscatter-pro.web.app"
export NEXT_PUBLIC_PAY_URL="https://zkscatter-pay.web.app"
# Pay reads its chain config from envs at build time. Default to
# Sepolia for the public Firebase deploy so the chain pill / wrong-
# chain banner show "Sepolia (testnet)" instead of falling back to
# the localhost id 31337.
export NEXT_PUBLIC_PAY_CHAIN_ID="11155111"

for target in "${TARGETS[@]}"; do
  dir="${APP_DIR[$target]:-}"
  if [ -z "$dir" ]; then
    echo "ERROR: unknown target '$target' (valid: ${!APP_DIR[*]})" >&2
    exit 1
  fi
  echo "==> Building $target ($dir)"
  # Temporarily move .env.local out of the way so prod env vars take effect
  # (Next loads .env.local at higher priority than .env.production).
  # `trap ... EXIT` guarantees the file is restored even if `npm run
  # build` fails or the user interrupts with Ctrl+C — otherwise the
  # backup would be left behind, breaking local dev on the next run.
  ENV_LOCAL="$ROOT_DIR/$dir/.env.local"
  ENV_BACKUP=""
  if [ -f "$ENV_LOCAL" ]; then
    ENV_BACKUP="$ENV_LOCAL.firebase-deploy-bak"
    mv "$ENV_LOCAL" "$ENV_BACKUP"
    trap 'if [ -n "${ENV_BACKUP:-}" ] && [ -f "$ENV_BACKUP" ]; then mv "$ENV_BACKUP" "$ENV_LOCAL"; fi' EXIT INT TERM
  fi
  # Under `set -e` a failing build aborts the script before the manual
  # restore runs, so we rely on the EXIT trap to put .env.local back.
  # On success the trap is cleared so the next iteration installs its
  # own and we restore manually.
  ( cd "$dir" && npm run build )
  if [ -n "$ENV_BACKUP" ]; then
    mv "$ENV_BACKUP" "$ENV_LOCAL"
    trap - EXIT INT TERM
    ENV_BACKUP=""
  fi
done

DEPLOY_FLAGS=""
for target in "${TARGETS[@]}"; do
  DEPLOY_FLAGS+="${DEPLOY_FLAGS:+,}hosting:$target"
done

echo "==> Deploying to Firebase: $DEPLOY_FLAGS"
firebase deploy --only "$DEPLOY_FLAGS"
