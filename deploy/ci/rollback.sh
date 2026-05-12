#!/usr/bin/env bash
# deploy/ci/rollback.sh
# Roll back to a previous image tag (any tag present in Artifact Registry).
# This is just a thin wrapper over deploy.sh that requires an explicit tag.
#
#   ./rollback.sh sha-abcdef1
#   ./rollback.sh v1.2.2

set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "usage: $0 <previous-tag>" >&2
	echo "list tags: gcloud artifacts docker tags list <AR_PATH>/zk-relayer --limit 20" >&2
	exit 1
fi

exec "$(dirname "$0")/deploy.sh" "$1"
