# deploy/gcp/config.sh
# Shared GCP settings. Source this from other scripts.
#   . ./config.sh
# Override anything here by exporting before running, e.g.:
#   PROJECT_ID=my-other-project ./bootstrap.sh

: "${PROJECT_ID:=zkscatter}"
: "${REGION:=us-central1}"
: "${ZONE:=us-central1-a}"

# Artifact Registry repo holding our docker images.
: "${AR_REPO:=zkscatter}"
: "${AR_HOST:=${REGION}-docker.pkg.dev}"
: "${AR_PATH:=${AR_HOST}/${PROJECT_ID}/${AR_REPO}}"

# VM
: "${VM_NAME:=zkscatter-node}"
: "${VM_MACHINE_TYPE:=e2-micro}"
: "${VM_IMAGE_FAMILY:=cos-stable}"
: "${VM_IMAGE_PROJECT:=cos-cloud}"
: "${VM_DISK_SIZE_GB:=30}"
: "${VM_TAG:=zkscatter-node}"

# Service account used by the VM.
: "${VM_SA_ID:=zkscatter-node}"
: "${VM_SA_EMAIL:=${VM_SA_ID}@${PROJECT_ID}.iam.gserviceaccount.com}"

# Secret names in Secret Manager.
: "${SECRET_RELAYER_KEY:=relayer-private-key}"

export PROJECT_ID REGION ZONE
export AR_REPO AR_HOST AR_PATH
export VM_NAME VM_MACHINE_TYPE VM_IMAGE_FAMILY VM_IMAGE_PROJECT VM_DISK_SIZE_GB VM_TAG
export VM_SA_ID VM_SA_EMAIL
export SECRET_RELAYER_KEY
