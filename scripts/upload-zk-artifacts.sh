#!/usr/bin/env bash
#
# upload-zk-artifacts.sh — publish the canonical zk prover assets to the public
# GCS bucket so every clone / CI / teammate fetches identical bytes that pair
# with the on-chain verifiers. Run after a circuit rotation (rebuild + verifier
# redeploy), once, by someone with gcloud auth + write on the bucket.
#
# Objects are content-addressed (gs://<bucket>/zk/<sha256>) so uploads are
# idempotent and rotations never overwrite — old builds stay reachable by hash.
# git only ever carries circuits/zk-manifest.json (the sha256 pins).
#
#   scripts/upload-zk-artifacts.sh                 # regen manifest + upload
#   scripts/upload-zk-artifacts.sh --create-bucket # also create the public bucket first
#
# Browser delivery is unchanged (apps serve /zk/* from their own public/zk);
# zkeys are public proving keys (no secrets), so public-read is correct.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="$ROOT_DIR/circuits/build"
MANIFEST="$ROOT_DIR/circuits/zk-manifest.json"
# Single source of truth: the bucket name lives in the manifest.
BUCKET="$(node -e 'process.stdout.write(require(process.argv[1]).bucket)' "$MANIFEST")"

command -v gcloud >/dev/null || { echo "ERROR: gcloud not found (install Google Cloud SDK)." >&2; exit 1; }

if [ "${1:-}" = "--create-bucket" ]; then
  echo "Creating gs://$BUCKET (uniform access, public read)…"
  gcloud storage buckets create "gs://$BUCKET" --uniform-bucket-level-access || true
  gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" \
    --member=allUsers --role=roles/storage.objectViewer
fi

echo "Regenerating manifest from circuits/build…"
node "$ROOT_DIR/scripts/gen-zk-manifest.mjs"

echo "Uploading artifacts (content-addressed, skip-if-exists)…"
# Read each artifact's sha256 + src from the manifest and upload by hash.
node -e '
const m=require(process.argv[1]);
for(const [name,a] of Object.entries(m.artifacts)) console.log(`${a.sha256}\t${a.src}`);
' "$MANIFEST" | while IFS=$'\t' read -r sha src; do
  obj="gs://$BUCKET/zk/$sha"
  if gcloud storage objects describe "$obj" >/dev/null 2>&1; then
    echo "  skip  $sha  ($src)"
  else
    echo "  put   $sha  ($src)"
    gcloud storage cp "$BUILD/$src" "$obj" --cache-control="public, max-age=31536000, immutable"
  fi
done

echo "Done. Commit circuits/zk-manifest.json so consumers pick up the new pins."
