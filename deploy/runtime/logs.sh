#!/usr/bin/env bash
# deploy/runtime/logs.sh — tail logs from one or all services.
#   ./logs.sh                 (all)
#   ./logs.sh zk-relayer
#   ./logs.sh shared-orderbook

set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
[[ -f .env ]] && { set -a; . ./.env; set +a; }

files=(-f compose.yml)
[[ -n "${DOMAIN:-}" ]] && files+=(-f compose.tls.yml)

docker compose "${files[@]}" --env-file .env logs -f --tail=200 "$@"
