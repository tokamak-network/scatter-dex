#!/usr/bin/env bash
# deploy/gcp/secrets-set.sh
# Adds a new version of the relayer signing key to Secret Manager.
#
#   ./secrets-set.sh path/to/relayer.key
#
# The file must contain exactly the private key in the format that
# zk-relayer expects (single line, no trailing newline preferred).

set -euo pipefail
cd "$(dirname "$0")"
. ./config.sh

KEY_FILE="${1:-}"
if [[ -z "${KEY_FILE}" || ! -f "${KEY_FILE}" ]]; then
	echo "usage: $0 <path-to-relayer.key>" >&2
	exit 1
fi

gcloud secrets versions add "${SECRET_RELAYER_KEY}" \
	--project="${PROJECT_ID}" \
	--data-file="${KEY_FILE}"

echo "✓ new version added to secret '${SECRET_RELAYER_KEY}'"
echo "  list versions: gcloud secrets versions list ${SECRET_RELAYER_KEY}"
