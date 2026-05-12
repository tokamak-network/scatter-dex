#!/usr/bin/env bash
# deploy/runtime/stop.sh — graceful shutdown.

set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC1091
[[ -f .env ]] && { set -a; . ./.env; set +a; }

files=(-f compose.yml)
[[ -n "${DOMAIN:-}" ]] && files+=(-f compose.tls.yml)

docker compose "${files[@]}" --env-file .env down "$@"
