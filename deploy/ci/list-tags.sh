#!/usr/bin/env bash
# deploy/ci/list-tags.sh — show recent image tags. Useful before rollback.

set -euo pipefail
cd "$(dirname "$0")/../gcp"
. ./config.sh

for svc in shared-orderbook zk-relayer; do
	echo
	echo "== ${svc} =="
	gcloud artifacts docker tags list "${AR_PATH}/${svc}" --limit=20 \
		--format="table(tag,version.basename())" 2>/dev/null || echo "  (none)"
done
