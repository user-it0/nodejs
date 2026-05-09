#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${REGION:?Set REGION}"

ADDRESS_NAME="${ADDRESS_NAME:-ivucx-helper-ip}"
NETWORK_TIER="${NETWORK_TIER:-PREMIUM}"

gcloud compute addresses create "$ADDRESS_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --network-tier="$NETWORK_TIER"
