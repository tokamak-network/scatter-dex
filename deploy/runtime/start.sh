#!/usr/bin/env bash
# deploy/runtime/start.sh
# Convenience wrapper. Picks the TLS overlay automatically when DOMAIN is set.

set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
	echo "missing .env. cp .env.example .env and fill it in." >&2
	exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

files=(-f compose.yml)
if [[ -n "${DOMAIN:-}" ]]; then
	files+=(-f compose.tls.yml)
	echo "starting with TLS for ${DOMAIN}"
else
	echo "starting in direct-port mode (no TLS)"
fi

docker compose "${files[@]}" --env-file .env pull
docker compose "${files[@]}" --env-file .env up -d
docker compose "${files[@]}" --env-file .env ps
