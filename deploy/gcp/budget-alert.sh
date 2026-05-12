#!/usr/bin/env bash
# deploy/gcp/budget-alert.sh
# Creates a monthly budget alert for the billing account that hosts ${PROJECT_ID}.
# The amount is interpreted in the billing account's own currency.
# Triggers email at 50% / 90% / 100%.
#
#   ./budget-alert.sh           # default 1500 (KRW: ~$1, USD: $1500 — adjust)
#   ./budget-alert.sh 5000      # 5000 in the billing account currency

set -euo pipefail
cd "$(dirname "$0")"
. ./config.sh

AMOUNT="${1:-1500}"

BILLING_ACCOUNT=$(gcloud beta billing projects describe "${PROJECT_ID}" \
	--format="value(billingAccountName)" | sed 's|billingAccounts/||')

if [[ -z "${BILLING_ACCOUNT}" ]]; then
	echo "could not resolve billing account for project ${PROJECT_ID}" >&2
	exit 1
fi

CURRENCY=$(gcloud beta billing accounts describe "${BILLING_ACCOUNT}" \
	--format="value(currencyCode)")

DISPLAY_NAME="${PROJECT_ID}-${AMOUNT}${CURRENCY,,}"

echo "creating budget '${DISPLAY_NAME}' on billing account ${BILLING_ACCOUNT} (${CURRENCY})"

gcloud billing budgets create \
	--billing-account="${BILLING_ACCOUNT}" \
	--display-name="${DISPLAY_NAME}" \
	--budget-amount="${AMOUNT}${CURRENCY}" \
	--threshold-rule=percent=0.5 \
	--threshold-rule=percent=0.9 \
	--threshold-rule=percent=1.0 \
	--filter-projects="projects/${PROJECT_ID}"

echo "✓ budget created. Recipients are the billing account admins by default."
echo "  Add Pub/Sub or extra recipients in the console if needed."
