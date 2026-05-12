#!/usr/bin/env bash
# deploy/ci/build-and-push.sh
# Builds shared-orderbook and zk-relayer images from the monorepo root
# and pushes them to Artifact Registry.
#
# Usage:
#   ./build-and-push.sh                      # tags 'latest' and the current git sha
#   ./build-and-push.sh shared-orderbook     # only one service
#   IMAGE_TAG=v1.2.3 ./build-and-push.sh     # explicit tag (still also pushes sha)
#
# Requires:
#   - gcloud auth configured for the AR repository
#   - docker buildx (default in recent Docker installs)

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
cd "${HERE}/../gcp"
. ./config.sh
cd "${REPO_ROOT}"

SHA="$(git rev-parse --short HEAD 2>/dev/null || echo "nogit")"
: "${IMAGE_TAG:=latest}"

# Authenticate docker to Artifact Registry once.
gcloud auth configure-docker "${AR_HOST}" --quiet >/dev/null

# Determine target platform. e2-micro is x86_64; matches our laptops only
# when not on Apple Silicon. Force linux/amd64 so M-series Macs produce
# images the VM can actually run.
PLATFORM="${PLATFORM:-linux/amd64}"

build_and_push() {
	local svc="$1"
	local dockerfile="${REPO_ROOT}/${svc}/Dockerfile"
	if [[ ! -f "${dockerfile}" ]]; then
		echo "no Dockerfile at ${dockerfile}" >&2
		return 1
	fi

	local img="${AR_PATH}/${svc}"

	echo
	echo "▶  building ${svc}"
	echo "   image:    ${img}"
	echo "   tags:     ${IMAGE_TAG}, sha-${SHA}"
	echo "   platform: ${PLATFORM}"

	# Cache layers into a dedicated tag in Artifact Registry so repeat
	# builds (especially in CI) skip the npm install step. `mode=max`
	# uploads inline cache for every intermediate stage.
	docker buildx build \
		--platform "${PLATFORM}" \
		--file "${dockerfile}" \
		--tag "${img}:${IMAGE_TAG}" \
		--tag "${img}:sha-${SHA}" \
		--cache-from "type=registry,ref=${img}:buildcache" \
		--cache-to   "type=registry,ref=${img}:buildcache,mode=max" \
		--push \
		"${REPO_ROOT}"

	echo "✓  pushed ${img}:${IMAGE_TAG}"
	echo "✓  pushed ${img}:sha-${SHA}"
}

services=("$@")
if [[ ${#services[@]} -eq 0 ]]; then
	services=(shared-orderbook zk-relayer)
fi

for svc in "${services[@]}"; do
	build_and_push "${svc}"
done

echo
echo "all done. Tag in use: ${IMAGE_TAG} (also sha-${SHA})"
echo "On the VM, deploy with: ../ci/deploy.sh"
