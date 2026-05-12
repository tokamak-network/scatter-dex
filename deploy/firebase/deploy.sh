#!/usr/bin/env bash
# deploy/firebase/deploy.sh
# Thin wrapper around scripts/firebase-deploy.sh so the firebase flow is
# discoverable next to the rest of the deploy/ tooling.
#
#   ./deploy.sh                 # all 5 sites
#   ./deploy.sh pay pro         # subset

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
exec "${HERE}/../../scripts/firebase-deploy.sh" "$@"
