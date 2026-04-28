#!/usr/bin/env bash
# Build hub/docs/pro as static exports and deploy to Firebase Hosting.
# Usage:
#   ./scripts/firebase-deploy.sh           # deploy all three sites
#   ./scripts/firebase-deploy.sh hub       # deploy a single target
#   ./scripts/firebase-deploy.sh hub docs  # deploy multiple targets
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

ALL_TARGETS=(hub docs pro)
TARGETS=("${@:-${ALL_TARGETS[@]}}")

declare -A APP_DIR=(
  [hub]="apps/hub"
  [docs]="apps/docs"
  [pro]="apps/pro"
)

# Production URLs baked into static exports at build time. `.env.local`
# in each app holds dev URLs (localhost:*) and overrides .env.production
# in Next's loader order, so we inject prod values here instead.
export NEXT_PUBLIC_HUB_URL="https://zkscatter-hub.web.app"
export NEXT_PUBLIC_DOCS_URL="https://zkscatter-docs.web.app"
export NEXT_PUBLIC_PRO_URL="https://zkscatter-pro.web.app"

for target in "${TARGETS[@]}"; do
  dir="${APP_DIR[$target]:-}"
  if [ -z "$dir" ]; then
    echo "ERROR: unknown target '$target' (valid: ${!APP_DIR[*]})" >&2
    exit 1
  fi
  echo "==> Building $target ($dir)"
  # Temporarily move .env.local out of the way so prod env vars take effect
  # (Next loads .env.local at higher priority than .env.production).
  ENV_LOCAL="$ROOT_DIR/$dir/.env.local"
  ENV_BACKUP=""
  if [ -f "$ENV_LOCAL" ]; then
    ENV_BACKUP="$ENV_LOCAL.firebase-deploy-bak"
    mv "$ENV_LOCAL" "$ENV_BACKUP"
  fi
  ( cd "$dir" && npm run build )
  build_status=$?
  if [ -n "$ENV_BACKUP" ]; then
    mv "$ENV_BACKUP" "$ENV_LOCAL"
  fi
  if [ "$build_status" -ne 0 ]; then
    exit "$build_status"
  fi
done

DEPLOY_FLAGS=""
for target in "${TARGETS[@]}"; do
  DEPLOY_FLAGS+="${DEPLOY_FLAGS:+,}hosting:$target"
done

echo "==> Deploying to Firebase: $DEPLOY_FLAGS"
firebase deploy --only "$DEPLOY_FLAGS"
