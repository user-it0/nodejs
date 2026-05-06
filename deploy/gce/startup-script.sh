#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/opt/ivucx-helper"
REPO_URL="${IVUCX_HELPER_REPO_URL:-https://github.com/user-it0/nodejs.git}"
REPO_REF="${IVUCX_HELPER_REPO_REF:-main}"
COMPOSE_FILE="$APP_DIR/deploy/gce/compose.yaml"
RUNTIME_ENV_FILE="$APP_DIR/deploy/gce/.env.runtime"
LOG_FILE="/var/log/ivucx-helper-startup.log"

exec > >(tee -a "$LOG_FILE") 2>&1

metadata() {
  local key="$1"
  curl -fsSL -H "Metadata-Flavor: Google" \
    "http://metadata.google.internal/computeMetadata/v1/instance/attributes/${key}" || true
}

REPO_URL="$(metadata ivucx-helper-repo-url || true)"
REPO_URL="${REPO_URL:-${IVUCX_HELPER_REPO_URL:-https://github.com/user-it0/nodejs.git}}"

REPO_REF="$(metadata ivucx-helper-repo-ref || true)"
REPO_REF="${REPO_REF:-${IVUCX_HELPER_REPO_REF:-main}}"

ENV_FROM_METADATA="$(metadata ivucx-helper-env || true)"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl git docker.io docker-compose-plugin

systemctl enable docker
systemctl restart docker

mkdir -p "$APP_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
fi

git -C "$APP_DIR" fetch --depth=1 origin "$REPO_REF"
git -C "$APP_DIR" checkout -f FETCH_HEAD

if [ -n "$ENV_FROM_METADATA" ]; then
  mkdir -p "$(dirname "$RUNTIME_ENV_FILE")"
  printf '%s\n' "$ENV_FROM_METADATA" > "$RUNTIME_ENV_FILE"
fi

if [ ! -f "$RUNTIME_ENV_FILE" ]; then
  echo "Missing runtime env file: $RUNTIME_ENV_FILE"
  exit 1
fi

docker compose -f "$COMPOSE_FILE" --env-file "$RUNTIME_ENV_FILE" up --build -d
