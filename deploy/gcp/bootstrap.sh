#!/usr/bin/env bash
# deploy/gcp/bootstrap.sh
# One-shot setup for the GCP side of zkScatter infra.
# Idempotent — safe to re-run.
#
# What this does:
#   1. Verifies the active project and billing.
#   2. Enables required APIs.
#   3. Creates the Artifact Registry repository.
#   4. Creates a VM service account with minimum IAM.
#   5. Creates Secret Manager entries (empty — fill them with secrets-set.sh).
#   6. Opens firewall rules for HTTP/HTTPS and the direct service ports.
#
# Run order:
#   ./bootstrap.sh
#   ./secrets-set.sh
#   ./vm-create.sh

set -euo pipefail
cd "$(dirname "$0")"
. ./config.sh

say() { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn(){ printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }

say "Checking project ${PROJECT_ID}"
if ! gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
	echo "Project ${PROJECT_ID} not accessible. Are you logged in to the right account?" >&2
	echo "  gcloud auth login" >&2
	echo "  gcloud config set project ${PROJECT_ID}" >&2
	exit 1
fi
gcloud config set project "${PROJECT_ID}" >/dev/null
ok "active project: ${PROJECT_ID}"

say "Checking billing"
billing=$(gcloud beta billing projects describe "${PROJECT_ID}" --format="value(billingEnabled)")
if [[ "${billing}" != "True" ]]; then
	warn "billing is NOT enabled on ${PROJECT_ID}."
	warn "Enable billing in console before continuing (Cloud Run, Artifact Registry, GCE all require it)."
	exit 1
fi
ok "billing enabled"

say "Enabling required APIs"
gcloud services enable \
	compute.googleapis.com \
	artifactregistry.googleapis.com \
	secretmanager.googleapis.com \
	iamcredentials.googleapis.com \
	logging.googleapis.com \
	monitoring.googleapis.com \
	billingbudgets.googleapis.com \
	--quiet
ok "APIs enabled"

say "Artifact Registry repo: ${AR_REPO} (${REGION})"
if gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" >/dev/null 2>&1; then
	ok "repo exists"
else
	gcloud artifacts repositories create "${AR_REPO}" \
		--repository-format=docker \
		--location="${REGION}" \
		--description="zkScatter container images"
	ok "repo created"
fi

say "Service account: ${VM_SA_EMAIL}"
if gcloud iam service-accounts describe "${VM_SA_EMAIL}" >/dev/null 2>&1; then
	ok "SA exists"
else
	gcloud iam service-accounts create "${VM_SA_ID}" \
		--display-name="zkScatter node runtime"
	ok "SA created"
fi

say "Granting IAM roles to ${VM_SA_EMAIL}"
for role in \
	roles/artifactregistry.reader \
	roles/secretmanager.secretAccessor \
	roles/logging.logWriter \
	roles/monitoring.metricWriter
do
	gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
		--member="serviceAccount:${VM_SA_EMAIL}" \
		--role="${role}" \
		--condition=None \
		--quiet >/dev/null
	ok "  + ${role}"
done

say "Secret Manager: ${SECRET_RELAYER_KEY}"
if gcloud secrets describe "${SECRET_RELAYER_KEY}" >/dev/null 2>&1; then
	ok "secret exists (value managed via secrets-set.sh)"
else
	gcloud secrets create "${SECRET_RELAYER_KEY}" \
		--replication-policy=automatic \
		--labels=service=zk-relayer
	ok "secret created (empty — populate with secrets-set.sh)"
fi

say "Firewall rules"
# HTTP/HTTPS for Caddy in TLS mode.
if ! gcloud compute firewall-rules describe zkscatter-http >/dev/null 2>&1; then
	gcloud compute firewall-rules create zkscatter-http \
		--network=default \
		--allow=tcp:80,tcp:443 \
		--target-tags="${VM_TAG}" \
		--description="zkScatter Caddy ingress"
	ok "  + zkscatter-http (80/443)"
else
	ok "  zkscatter-http exists"
fi

# Direct service ports for IP-only mode (delete later when TLS is on).
if ! gcloud compute firewall-rules describe zkscatter-direct >/dev/null 2>&1; then
	gcloud compute firewall-rules create zkscatter-direct \
		--network=default \
		--allow=tcp:3002,tcp:4000 \
		--target-tags="${VM_TAG}" \
		--description="zkScatter direct-port testing (remove once TLS is on)"
	ok "  + zkscatter-direct (3002/4000)"
else
	ok "  zkscatter-direct exists"
fi

say "Bootstrap complete"
cat <<EOF

Next steps:
  1. Put the relayer signing key into Secret Manager:
       ./secrets-set.sh
  2. Create the VM:
       ./vm-create.sh
  3. SSH in and run the runtime stack:
       gcloud compute ssh ${VM_NAME} --zone ${ZONE}
EOF
