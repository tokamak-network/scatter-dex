#!/usr/bin/env bash
# deploy/runtime/stop.sh — graceful shutdown.

set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
. ./_compose-files.sh

# --env-file accepts a missing file as long as no compose value depends on it.
# When .env is absent we omit the flag so `down` works on a fresh checkout.
env_flag=()
[[ -f .env ]] && env_flag=(--env-file .env)

docker compose "${COMPOSE_FILES[@]}" "${env_flag[@]}" down "$@"
