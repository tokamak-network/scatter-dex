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
. ./_compose-files.sh

echo "starting ${DOMAIN:+with TLS for $DOMAIN}${DOMAIN:-in direct-port mode (no TLS)}"

docker compose "${COMPOSE_FILES[@]}" --env-file .env pull
docker compose "${COMPOSE_FILES[@]}" --env-file .env up -d
docker compose "${COMPOSE_FILES[@]}" --env-file .env ps
