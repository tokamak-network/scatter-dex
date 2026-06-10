#!/usr/bin/env bash
# deploy/ci/deploy.sh
# Roll out a new image tag to the existing VM.
#
# Steps:
#   1. Update the VM's 'image-tag' metadata so future reboots use it.
#   2. Re-sync the runtime config metadata (compose files + startup-script)
#      from the repo, so a deploy reflects the CURRENT main — not just a new
#      image. Skipping this silently runs the box on a stale compose.yml /
#      vm-startup.sh (e.g. a new sidecar service or a new env var never lands).
#   3. SSH in and run the startup script again so the live containers
#      switch to the new tag + config immediately.
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

# Keep the box's compose + startup-script in lock-step with the image. These
# are the same metadata keys vm-create.sh seeds; re-pushing them on every
# deploy means "new image that needs a new service/env" just works.
echo "▶  syncing runtime config metadata (compose + startup-script) on ${VM_NAME}"
gcloud compute instances add-metadata "${VM_NAME}" \
	--zone="${ZONE}" \
	--metadata-from-file=\
startup-script=./vm-startup.sh,\
compose-yml=../runtime/compose.yml,\
compose-tls-yml=../runtime/compose.tls.yml

echo "▶  re-running startup script on ${VM_NAME}"
# `set -o pipefail` on the remote side so a startup-script failure is
# reflected in ssh's exit status (otherwise `tail` swallows it).
gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --command \
	'set -o pipefail; sudo google_metadata_script_runner startup 2>&1 | tail -40'

echo
echo "▶  status:"
gcloud compute ssh "${VM_NAME}" --zone="${ZONE}" --command \
	'cd /var/lib/zkscatter/runtime && docker compose ps'
