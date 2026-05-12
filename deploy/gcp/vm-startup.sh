#!/bin/bash
# deploy/gcp/vm-startup.sh
# Runs on the VM every boot (Container-Optimized OS metadata-key
# "startup-script"). Pulls the runtime configuration from instance
# metadata, fetches secrets, and (re)starts docker compose.
#
# Required instance metadata keys (set by vm-create.sh):
#   project-id
#   ar-path                       e.g. us-central1-docker.pkg.dev/zkscatter/zkscatter
#   image-tag                     e.g. latest, sha-abc123
#   rpc-url
#   commitment-pool-address
#   private-settlement-address
#   cors-origins
#   relayer-secret-name           Secret Manager name; key is fetched at boot
#
# Optional:
#   domain                        if set, TLS overlay is enabled
#   acme-email
#   image-shared-orderbook        override image (default ${AR_PATH}/shared-orderbook)
#   image-zk-relayer              override image (default ${AR_PATH}/zk-relayer)

set -euo pipefail

log() { echo "[startup $(date -u +%FT%TZ)] $*"; }

# --- fetch metadata helper -------------------------------------------------
mget() {
	local key="$1"
	curl -s -f -H 'Metadata-Flavor: Google' \
		"http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}" \
		|| echo ""
}

PROJECT_ID=$(mget project-id)
AR_PATH=$(mget ar-path)
IMAGE_TAG=$(mget image-tag)
IMAGE_TAG="${IMAGE_TAG:-latest}"
IMAGE_SO=$(mget image-shared-orderbook)
IMAGE_ZK=$(mget image-zk-relayer)
IMAGE_SO="${IMAGE_SO:-${AR_PATH}/shared-orderbook}"
IMAGE_ZK="${IMAGE_ZK:-${AR_PATH}/zk-relayer}"

RPC_URL=$(mget rpc-url)
COMMITMENT_POOL_ADDRESS=$(mget commitment-pool-address)
PRIVATE_SETTLEMENT_ADDRESS=$(mget private-settlement-address)
CORS_ORIGINS=$(mget cors-origins)
DOMAIN=$(mget domain)
ACME_EMAIL=$(mget acme-email)
RELAYER_SECRET_NAME=$(mget relayer-secret-name)
RELAYER_SECRET_NAME="${RELAYER_SECRET_NAME:-relayer-private-key}"

log "config: ar=${AR_PATH} tag=${IMAGE_TAG} domain=${DOMAIN:-<none>}"

# --- ensure directories ----------------------------------------------------
mkdir -p /var/lib/zkscatter/runtime
mkdir -p /var/lib/zkscatter/circuits/build
mkdir -p /var/lib/zkscatter/secrets
chmod 700 /var/lib/zkscatter/secrets

cd /var/lib/zkscatter/runtime

# --- 1 GB swap on e2-micro ------------------------------------------------
# e2-micro caps at 1 GB RAM. A swap file keeps the OOM killer at bay during
# image pulls / npm-install spikes. Idempotent: create only once.
if [[ ! -f /var/lib/zkscatter/swapfile ]]; then
	log "creating 1G swap file"
	fallocate -l 1G /var/lib/zkscatter/swapfile || \
		dd if=/dev/zero of=/var/lib/zkscatter/swapfile bs=1M count=1024
	chmod 600 /var/lib/zkscatter/swapfile
	mkswap /var/lib/zkscatter/swapfile >/dev/null
fi
swapon /var/lib/zkscatter/swapfile 2>/dev/null || true

# --- shared helper: GCP access token from metadata ------------------------
gcp_token() {
	curl -s -H 'Metadata-Flavor: Google' \
		"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token" \
		| python3 -c 'import json,sys;print(json.load(sys.stdin)["access_token"])'
}

# --- fetch relayer key from Secret Manager (REST, no docker pull) ---------
log "fetching secret '${RELAYER_SECRET_NAME}'"
token=$(gcp_token)
curl -s -f -H "Authorization: Bearer ${token}" \
	"https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/${RELAYER_SECRET_NAME}/versions/latest:access" \
	| python3 -c 'import json,sys,base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["payload"]["data"]))' \
	> /var/lib/zkscatter/secrets/relayer.key
chmod 600 /var/lib/zkscatter/secrets/relayer.key
log "secret written ($(wc -c </var/lib/zkscatter/secrets/relayer.key) bytes)"

# --- auth docker to Artifact Registry -------------------------------------
# COS ships docker-credential-gcr but only registers gcr.io by default.
docker-credential-gcr configure-docker --registries="${AR_PATH%%/*}" >/dev/null 2>&1 || true
echo "${token}" | docker login -u oauth2accesstoken --password-stdin "https://${AR_PATH%%/*}" >/dev/null
log "docker auth ok"

# --- refresh compose files from metadata ---------------------------------
# vm-create.sh always uploads the current compose/Caddy files into instance
# metadata, so re-pulling each boot keeps the VM in sync with the latest
# committed runtime config (operators only need to re-add metadata to roll
# out a change — no rebuild required).
mget compose-yml > compose.yml
mget compose-tls-yml > compose.tls.yml
mget caddyfile > Caddyfile

# --- write .env -----------------------------------------------------------
cat > .env <<EOF
SHARED_ORDERBOOK_IMAGE=${IMAGE_SO}
ZK_RELAYER_IMAGE=${IMAGE_ZK}
IMAGE_TAG=${IMAGE_TAG}
SHARED_ORDERBOOK_PORT=4000
ZK_RELAYER_PORT=3002
RPC_URL=${RPC_URL}
COMMITMENT_POOL_ADDRESS=${COMMITMENT_POOL_ADDRESS}
PRIVATE_SETTLEMENT_ADDRESS=${PRIVATE_SETTLEMENT_ADDRESS}
RELAYER_FEE=30
CORS_ORIGINS=${CORS_ORIGINS}
CIRCUITS_BUILD_DIR=/var/lib/zkscatter/circuits/build
RELAYER_KEY_FILE=/var/lib/zkscatter/secrets/relayer.key
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
EOF
chmod 600 .env

# --- launch ---------------------------------------------------------------
files=(-f compose.yml)
[[ -n "${DOMAIN}" ]] && files+=(-f compose.tls.yml)

log "docker compose pull"
docker compose "${files[@]}" --env-file .env pull

log "docker compose up -d"
docker compose "${files[@]}" --env-file .env up -d

log "startup complete"
