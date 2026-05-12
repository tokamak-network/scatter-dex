#!/usr/bin/env bash
# deploy/gcp/vm-create.sh
# Creates the e2-micro VM that runs the runtime stack.
# Idempotent — if the VM already exists, this script exits without changes.
# Use vm-destroy.sh + vm-create.sh to rebuild.
#
# Required env (override via .env or shell):
#   RPC_URL                       chain RPC endpoint
#   COMMITMENT_POOL_ADDRESS
#   PRIVATE_SETTLEMENT_ADDRESS
#   CORS_ORIGINS                  comma-separated
# Optional:
#   IMAGE_TAG                     default 'latest'
#   DOMAIN                        if set, TLS overlay enabled
#   ACME_EMAIL

set -euo pipefail
cd "$(dirname "$0")"
. ./config.sh

# Load deploy-time config from a local file if present (not committed).
if [[ -f deploy.env ]]; then
	# shellcheck disable=SC1091
	set -a; . ./deploy.env; set +a
fi

: "${RPC_URL:?RPC_URL must be set}"
: "${COMMITMENT_POOL_ADDRESS:?COMMITMENT_POOL_ADDRESS must be set}"
: "${PRIVATE_SETTLEMENT_ADDRESS:?PRIVATE_SETTLEMENT_ADDRESS must be set}"
: "${CORS_ORIGINS:?CORS_ORIGINS must be set}"
: "${IMAGE_TAG:=latest}"
: "${DOMAIN:=}"
: "${ACME_EMAIL:=}"

if gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" >/dev/null 2>&1; then
	echo "VM ${VM_NAME} already exists in ${ZONE}. Use vm-destroy.sh first if you want to rebuild."
	exit 0
fi

# us-central1 e2-micro is in the GCP Always Free tier; other zones drop
# the free credit.
echo "creating VM ${VM_NAME} (${VM_MACHINE_TYPE}, ${ZONE})"

# `|` delimiter so commas in CORS_ORIGINS survive. File bodies go via
# --metadata-from-file to avoid in-line escaping entirely.
gcloud compute instances create "${VM_NAME}" \
	--zone="${ZONE}" \
	--machine-type="${VM_MACHINE_TYPE}" \
	--image-family="${VM_IMAGE_FAMILY}" \
	--image-project="${VM_IMAGE_PROJECT}" \
	--boot-disk-size="${VM_DISK_SIZE_GB}GB" \
	--boot-disk-type=pd-standard \
	--service-account="${VM_SA_EMAIL}" \
	--scopes=cloud-platform \
	--tags="${VM_TAG}" \
	--metadata=^\|^"\
project-id=${PROJECT_ID}|\
ar-path=${AR_PATH}|\
image-tag=${IMAGE_TAG}|\
rpc-url=${RPC_URL}|\
commitment-pool-address=${COMMITMENT_POOL_ADDRESS}|\
private-settlement-address=${PRIVATE_SETTLEMENT_ADDRESS}|\
cors-origins=${CORS_ORIGINS}|\
domain=${DOMAIN}|\
acme-email=${ACME_EMAIL}|\
relayer-secret-name=${SECRET_RELAYER_KEY}" \
	--metadata-from-file=\
startup-script=./vm-startup.sh,\
compose-yml=../runtime/compose.yml,\
compose-tls-yml=../runtime/compose.tls.yml,\
caddyfile=../runtime/Caddyfile

echo "✓ VM created."
echo
gcloud compute instances describe "${VM_NAME}" --zone="${ZONE}" \
	--format="table(name,status,machineType.basename(),networkInterfaces[0].accessConfigs[0].natIP:label=EXTERNAL_IP)"

cat <<EOF

Useful commands:
  ssh:           gcloud compute ssh ${VM_NAME} --zone ${ZONE}
  serial log:    gcloud compute instances get-serial-port-output ${VM_NAME} --zone ${ZONE} | tail -200
  startup re-run gcloud compute ssh ${VM_NAME} --zone ${ZONE} --command 'sudo google_metadata_script_runner startup'
EOF
