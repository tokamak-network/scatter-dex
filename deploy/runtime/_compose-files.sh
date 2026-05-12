# deploy/runtime/_compose-files.sh
# Source from start.sh / stop.sh / logs.sh to load .env and resolve which
# compose files to pass to docker compose. Exports the COMPOSE_FILES array.
#
#   . ./_compose-files.sh
#   docker compose "${COMPOSE_FILES[@]}" --env-file .env <verb>

[[ -f .env ]] && { set -a; . ./.env; set +a; }

COMPOSE_FILES=(-f compose.yml)
[[ -n "${DOMAIN:-}" ]] && COMPOSE_FILES+=(-f compose.tls.yml)
