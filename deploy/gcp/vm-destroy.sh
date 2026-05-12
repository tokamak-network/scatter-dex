#!/usr/bin/env bash
# deploy/gcp/vm-destroy.sh — delete the VM. DB volumes go with it.
# Snapshot the data disk first if you need to keep state.

set -euo pipefail
cd "$(dirname "$0")"
. ./config.sh

read -r -p "Delete VM '${VM_NAME}' in ${ZONE}? This is irreversible. [y/N] " yn
[[ "${yn}" == "y" || "${yn}" == "Y" ]] || { echo "aborted"; exit 1; }

gcloud compute instances delete "${VM_NAME}" --zone="${ZONE}" --quiet
echo "✓ VM deleted"
