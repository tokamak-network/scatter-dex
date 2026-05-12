#!/usr/bin/env bash
# deploy/runtime/logs.sh — tail logs from one or all services.
#   ./logs.sh                 (all)
#   ./logs.sh zk-relayer
#   ./logs.sh shared-orderbook

set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
. ./_compose-files.sh

env_flag=()
[[ -f .env ]] && env_flag=(--env-file .env)

docker compose "${COMPOSE_FILES[@]}" "${env_flag[@]}" logs -f --tail=200 "$@"
