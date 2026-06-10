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

# COS's metadata-script-runner invokes this without HOME set; under `set -u`
# the later `${HOME}/.docker` reference (docker-credential-gcr) would abort the
# whole startup. COS also has a READ-ONLY root fs, so /root/.docker can't be
# created — point HOME at the writable /var/lib/zkscatter tree instead.
export HOME=/var/lib/zkscatter
mkdir -p "${HOME}"

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
# Single-chain fallback chainId for the verifier + indexer. Defaults to Sepolia;
# set the `chain-id` metadata key for another network. (Multi-network is
# configured via the CHAINS / COMMITMENT_CHAINS JSON env, not this.)
CHAIN_ID=$(mget chain-id 11155111)
COMMITMENT_POOL_ADDRESS=$(mget commitment-pool-address)
# Pool deploy block for the commitment indexer (so it doesn't scan from
# genesis). Defaults to 0 if unset — set the `commitment-deploy-block`
# metadata key from the ledger's "deployBlock".
COMMITMENT_DEPLOY_BLOCK=$(mget commitment-deploy-block 0)
PRIVATE_SETTLEMENT_ADDRESS=$(mget private-settlement-address)
# RelayerRegistry contract — enables the relayer's wallet/SIWE admin auth
# (connecting wallet must be isActiveRelayer()). Public address, so metadata.
# Empty → relayer admin SIWE stays off.
# Strip any stray whitespace/newline (e.g. from a copy-pasted metadata value) —
# the relayer doesn't trim the address before parsing it.
RELAYER_REGISTRY_ADDRESS=$(mget relayer-registry-address | tr -d '[:space:]')
CORS_ORIGINS=$(mget cors-origins)
# SIWE admin allowlist — public wallet addresses, so it lives in metadata
# alongside the contract addresses (not Secret Manager). Empty → the SIWE
# challenge/session routes stay 404 (other admin routes return 503). The app
# trims/lowercases each entry, so commas-with-spaces are fine.
ADMIN_ADDRESSES=$(mget admin-addresses)
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

# Fetch Secret Manager secret $1 (latest version) and write its decoded bytes to
# stdout. Non-zero exit with no output when the secret/version is absent (under
# `set -o pipefail` the failed `curl -f` propagates). Both curl and python3
# stderr are silenced so an intentionally-absent optional secret leaves no
# JSON-traceback noise in the boot log. Reuses ${token} set by gcp_token below.
gcp_secret() {
	curl -s -f -H "Authorization: Bearer ${token}" \
		"https://secretmanager.googleapis.com/v1/projects/${PROJECT_ID}/secrets/$1/versions/latest:access" 2>/dev/null \
		| python3 -c 'import json,sys,base64; sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["payload"]["data"]))' 2>/dev/null
}

# Tight umask so the secret + .env files we write below are never
# briefly readable by other users between create and chmod.
umask 077

log "fetching secret '${RELAYER_SECRET_NAME}' (optional — only zk-relayer uses it)"
# `|| token=""` so a missing/denied service-account token does not abort the
# whole startup under `set -e` — the secret fetches below then fail gracefully
# (empty relayer placeholder) and RPC_URL falls back to the metadata endpoint.
token=$(gcp_token) || token=""
if gcp_secret "${RELAYER_SECRET_NAME}" > /var/lib/zkscatter/secrets/relayer.key \
	&& [[ -s /var/lib/zkscatter/secrets/relayer.key ]]; then
	log "secret written"
else
	# No secret version — expected on the central orderbook box, where
	# zk-relayer is disabled (run per-operator). Leave an empty placeholder so
	# the compose `relayer_key` secret file resolves; the profiled-off zk-relayer
	# never reads it.
	: > /var/lib/zkscatter/secrets/relayer.key
	log "no relayer secret — empty placeholder written (zk-relayer disabled)"
fi

# RPC_URL: prefer Secret Manager (keeps a provider API key, e.g. Alchemy, OUT of
# VM metadata — which is readable by anyone with compute.instances.get). Falls
# back to the metadata rpc-url (a keyless publicnode endpoint) when unset.
RPC_FROM_SECRET=$(gcp_secret rpc-url) || RPC_FROM_SECRET=""
if [[ -n "${RPC_FROM_SECRET}" ]]; then
	RPC_URL="${RPC_FROM_SECRET}"
	log "RPC_URL loaded from Secret Manager (rpc-url)"
else
	log "RPC_URL from metadata (no rpc-url secret set)"
fi

# ADMIN_TOKEN: a static admin bearer (legacy / CI / verify-stats path). It's a
# credential, so it comes from Secret Manager only — never metadata. Absent →
# empty, leaving SIWE (ADMIN_ADDRESSES) as the only admin auth.
ADMIN_TOKEN=$(gcp_secret admin-token) || ADMIN_TOKEN=""
# Relayer admin API key (static-key fallback for the relayer's admin routes).
# A credential, so Secret Manager only — never metadata. Absent → that path
# stays off; SIWE (RELAYER_REGISTRY_ADDRESS) can still enable admin auth.
# Strip CR/LF — Secret Manager values are often created with a trailing newline
# (e.g. `echo` without -n), which would corrupt the key. Keep any other bytes.
ADMIN_API_KEY=$(gcp_secret relayer-admin-api-key | tr -d '\r\n') || ADMIN_API_KEY=""
if [[ -n "${ADMIN_TOKEN}" ]]; then
	log "ADMIN_TOKEN loaded from Secret Manager (admin-token)"
fi

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
CHAIN_ID=${CHAIN_ID}
COMMITMENT_POOL_ADDRESS=${COMMITMENT_POOL_ADDRESS}
COMMITMENT_DEPLOY_BLOCK=${COMMITMENT_DEPLOY_BLOCK}
PRIVATE_SETTLEMENT_ADDRESS=${PRIVATE_SETTLEMENT_ADDRESS}
RELAYER_REGISTRY_ADDRESS=${RELAYER_REGISTRY_ADDRESS}
ADMIN_API_KEY=${ADMIN_API_KEY}
CORS_ORIGINS=${CORS_ORIGINS}
ADMIN_ADDRESSES=${ADMIN_ADDRESSES}
ADMIN_TOKEN=${ADMIN_TOKEN}
CIRCUITS_BUILD_DIR=/var/lib/zkscatter/circuits/build
RELAYER_KEY_FILE=/var/lib/zkscatter/secrets/relayer.key
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}
EOF

# COS ships the Docker daemon but NOT the compose v2 plugin. Install it into the
# writable cli-plugins dir (HOME=/var/lib/zkscatter) so `docker compose` works.
# Pin the version + per-arch SHA256 so boot never depends on an unverified
# remote binary, and pick the binary by `uname -m` (e2-micro is x86_64; aarch64
# COS images also work).
if ! docker compose version >/dev/null 2>&1; then
	compose_version=v2.29.7
	case "$(uname -m)" in
		x86_64)  compose_arch=x86_64;  compose_sha=383ce6698cd5d5bbf958d2c8489ed75094e34a77d340404d9f32c4ae9e12baf0 ;;
		aarch64) compose_arch=aarch64; compose_sha=6e9fbd5daa20dca5d7d89145081ae8155d68ef2928b497d9f85b54fe0f9dbb2c ;;
		*) log "unsupported arch $(uname -m) — cannot install docker compose plugin"; exit 1 ;;
	esac
	log "installing docker compose ${compose_version} (${compose_arch})"
	# COS mounts /var/lib (including HOME=/var/lib/zkscatter) noexec, so the
	# plugin binary cannot be executed from there. Stage it under
	# /var/lib/docker — a separate ext4 mount that IS exec — and symlink it
	# into the cli-plugins dir docker actually searches
	# (${HOME}/.docker/cli-plugins). Exec follows the symlink to the exec mount.
	compose_store=/var/lib/docker/cli-plugins
	mkdir -p "${compose_store}" "${HOME}/.docker/cli-plugins"
	# umask 077 (set above for secrets) would make these dirs 700, so a non-root
	# operator running `docker compose` couldn't traverse them to the plugin.
	# The compose binary is a public release, not a secret — make the dirs
	# world-traversable.
	chmod 755 "${compose_store}" "${HOME}/.docker/cli-plugins"
	compose_bin="${compose_store}/docker-compose"
	curl -fsSL "https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-${compose_arch}" \
		-o "${compose_bin}"
	if ! echo "${compose_sha}  ${compose_bin}" | sha256sum -c - >/dev/null 2>&1; then
		log "docker compose checksum mismatch — aborting"
		rm -f "${compose_bin}"
		exit 1
	fi
	# 755 (not just +x): under umask 077 the download is 600, and +x would
	# leave it 700 — executable by root only. The plugin is a public binary.
	chmod 755 "${compose_bin}"
	ln -sf "${compose_bin}" "${HOME}/.docker/cli-plugins/docker-compose"
	docker compose version
fi

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
