#!/bin/bash
# deploy/gcp/vm-startup.sh
# Runs on the VM every boot (Container-Optimized OS metadata-key
# "startup-script"). Pulls runtime configuration from instance metadata,
# fetches secrets, and (re)starts docker compose.
#
# Required instance metadata keys (set by vm-create.sh):
#   project-id
#   ar-path                       e.g. us-central1-docker.pkg.dev/zkscatter/zkscatter
#   image-tag
#   rpc-url
#   commitment-pool-address
#   private-settlement-address
#   cors-origins
#   relayer-secret-name
#
# Optional:
#   domain                        if set, the TLS overlay activates
#   acme-email

set -euo pipefail

log() { echo "[startup $(date -u +%FT%TZ)] $*"; }

mget() {
	# `mget <key> [default]` — returns the metadata value or the default.
	local val
	val=$(curl -s -f -H 'Metadata-Flavor: Google' \
		"http://metadata.google.internal/computeMetadata/v1/instance/attributes/$1" \
		2>/dev/null) || val=""
	echo "${val:-${2:-}}"
}

PROJECT_ID=$(mget project-id)
AR_PATH=$(mget ar-path)
IMAGE_TAG=$(mget image-tag latest)
RPC_URL=$(mget rpc-url)
COMMITMENT_POOL_ADDRESS=$(mget commitment-pool-address)
PRIVATE_SETTLEMENT_ADDRESS=$(mget private-settlement-address)
CORS_ORIGINS=$(mget cors-origins)
DOMAIN=$(mget domain)
ACME_EMAIL=$(mget acme-email)
RELAYER_SECRET_NAME=$(mget relayer-secret-name relayer-private-key)

IMAGE_SO="${AR_PATH}/shared-orderbook"
IMAGE_ZK="${AR_PATH}/zk-relayer"

log "config: ar=${AR_PATH} tag=${IMAGE_TAG} domain=${DOMAIN:-<none>}"

mkdir -p /var/lib/zkscatter/runtime
mkdir -p /var/lib/zkscatter/circuits/build
install -d -m 700 /var/lib/zkscatter/secrets

cd /var/lib/zkscatter/runtime

# e2-micro caps at 1 GB RAM. A swap file keeps the OOM killer at bay during
# image pulls / npm-install spikes.
if [[ ! -f /var/lib/zkscatter/swapfile ]]; then
	log "creating 1G swap file"
	fallocate -l 1G /var/lib/zkscatter/swapfile \
		|| dd if=/dev/zero of=/var/lib/zkscatter/swapfile bs=1M count=1024
	chmod 600 /var/lib/zkscatter/swapfile
	mkswap /var/lib/zkscatter/swapfile >/dev/null
fi
swapon /var/lib/zkscatter/swapfile 2>/dev/null || true

gcp_token() {
	curl -s -H 'Metadata-Flavor: Google' \
		"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
		| python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])'
}

# Tight umask so the secret + .env files we write below are never
# briefly readable by other users between create and chmod.
umask 077

log "fetching secret '${RELAYER_SECRET_NAME}'"
token=$(gcp_token)
curl -s -f -H "Authorization: Bearer ${token}" \
	"https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${RELAYER_SECRET_NAME}/versions/latest:access" \
	| python3 -c 'import json,sys,base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["payload"]["data"]))' \
	> /var/lib/zkscatter/secrets/relayer.key
log "secret written"

# COS ships docker-credential-gcr but only registers gcr.io by default.
# Configure the AR host once and let the helper supply fresh tokens
# on each pull — no need for an extra `docker login`.
DOCKER_CONFIG="${HOME}/.docker/config.json"
if ! grep -q "${AR_PATH%%/*}" "${DOCKER_CONFIG}" 2>/dev/null; then
	docker-credential-gcr configure-docker --registries="${AR_PATH%%/*}" >/dev/null
	log "docker credential helper registered for ${AR_PATH%%/*}"
fi

# Re-pull compose / Caddy from metadata each boot so an `add-metadata`
# call is enough to roll out a runtime config change.
mget compose-yml > compose.yml
mget compose-tls-yml > compose.tls.yml
mget caddyfile > Caddyfile

cat > .env <<EOF
SHARED_ORDERBOOK_IMAGE=${IMAGE_SO}
ZK_RELAYER_IMAGE=${IMAGE_ZK}
IMAGE_TAG=${IMAGE_TAG}
SHARED_ORDERBOOK_PORT=4000
ZK_RELAYER_PORT=3002
RPC_URL=${RPC_URL}
COMMITMENT_POOL_ADDRESS=${COMMITMENT_POOL_ADDRESS}
PRIVATE_SETTLEMENT_ADDRESS=${PRIVATE_SETTLEMENT_ADDRESS}
CORS_ORIGINS=${CORS_ORIGINS}
CIRCUITS_BUILD_DIR=/var/lib/zkscatter/circuits/build
RELAYER_KEY_FILE=/var/lib/zkscatter/secrets/relayer.key
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
EOF

files=(-f compose.yml)
[[ -n "${DOMAIN}" ]] && files+=(-f compose.tls.yml)

# Serialize image pulls — two parallel extractions would peak above the
# 1 GB RAM ceiling on e2-micro.
export COMPOSE_PARALLEL_LIMIT=1

log "docker compose pull"
docker compose "${files[@]}" --env-file .env pull

log "docker compose up -d"
docker compose "${files[@]}" --env-file .env up -d

log "startup complete"
