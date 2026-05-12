#!/usr/bin/env bash
# deploy/ci/deploy.sh
# Roll out a new image tag to the existing VM.
#
# Steps:
#   1. Update the VM's 'image-tag' metadata so future reboots use it.
#   2. SSH in and run the startup script again so the live containers
#      switch to the new tag immediately.
#
#   ./deploy.sh                   # uses IMAGE_TAG=latest
#   ./deploy.sh v1.2.3
#   ./deploy.sh sha-abcdef1

set -euo pipefail
cd "$(dirname "$0")/../gcp"
. ./config.sh

IMAGE_TAG="${1:-latest}"

echo "▶  setting image-tag=${IMAGE_TAG} on ${VM_NAME}"
gcloud compute instances add-metadata "${VM_NAME}" \
	--zone="${ZONE}" \
	--metadata="image-tag=${IMAGE_TAG}"

echo "▶  re-running startup script on ${VM_NAME}"
gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --command \
	'sudo google_metadata_script_runner startup 2>&1 | tail -40'

echo
echo "▶  status:"
gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --command \
	'cd /var/lib/zkscatter/runtime && docker compose ps'
