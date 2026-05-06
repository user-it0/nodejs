#!/usr/bin/env bash
set -euo pipefail

: "${PROJECT_ID:?Set PROJECT_ID}"
: "${ZONE:?Set ZONE}"
: "${INSTANCE_NAME:?Set INSTANCE_NAME}"

MACHINE_TYPE="${MACHINE_TYPE:-e2-micro}"
BOOT_DISK_SIZE="${BOOT_DISK_SIZE:-20GB}"
IMAGE_PROJECT="${IMAGE_PROJECT:-ubuntu-os-cloud}"
IMAGE_FAMILY="${IMAGE_FAMILY:-ubuntu-2204-lts}"
NETWORK_TAG="${NETWORK_TAG:-ivucx-helper}"
STATIC_IP="${STATIC_IP:-}"
REPO_URL="${REPO_URL:-https://github.com/user-it0/nodejs.git}"
REPO_REF="${REPO_REF:-main}"
STARTUP_SCRIPT_PATH="${STARTUP_SCRIPT_PATH:-deploy/gce/startup-script.sh}"
RUNTIME_ENV_PATH="${RUNTIME_ENV_PATH:-deploy/gce/.env.runtime}"

ARGS=(
  compute instances create "$INSTANCE_NAME"
  "--project=$PROJECT_ID"
  "--zone=$ZONE"
  "--machine-type=$MACHINE_TYPE"
  "--boot-disk-size=$BOOT_DISK_SIZE"
  "--image-project=$IMAGE_PROJECT"
  "--image-family=$IMAGE_FAMILY"
  "--tags=$NETWORK_TAG"
  "--metadata=ivucx-helper-repo-url=$REPO_URL,ivucx-helper-repo-ref=$REPO_REF"
  "--metadata-from-file=startup-script=$STARTUP_SCRIPT_PATH,ivucx-helper-env=$RUNTIME_ENV_PATH"
)

if [ -n "$STATIC_IP" ]; then
  ARGS+=("--address=$STATIC_IP")
fi

gcloud "${ARGS[@]}"
