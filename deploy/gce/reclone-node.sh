#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/nodejs}"
RECLONE_REPO_URL="${GCE_RECLONE_REPO_URL:-${GCE_SYNC_REPO_URL:-https://github.com/user-it0/nodejs.git}}"
RECLONE_REF="${GCE_RECLONE_REPO_REF:-${GCE_SYNC_REPO_REF:-main}}"
NODE_HOME="${NODE_HOME:-$HOME/.local/node-v20}"
TIMESTAMP="$(date -u +%Y%m%d%H%M%S)"
PARENT_DIR="$(dirname "$APP_DIR")"
APP_NAME="$(basename "$APP_DIR")"
NEW_DIR="$PARENT_DIR/.${APP_NAME}.new-$TIMESTAMP"
BACKUP_DIR="$PARENT_DIR/${APP_NAME}.backup-$TIMESTAMP"
ENV_RELATIVE_PATH="deploy/gce/.env.runtime"

if [ -e "$NEW_DIR" ] || [ -e "$BACKUP_DIR" ]; then
  echo "Temporary target already exists."
  exit 1
fi

if [ -d "$APP_DIR" ] && [ -x "$APP_DIR/deploy/gce/stop-node.sh" ]; then
  "$APP_DIR/deploy/gce/stop-node.sh" || true
fi

git clone "$RECLONE_REPO_URL" "$NEW_DIR"
git -C "$NEW_DIR" fetch origin "$RECLONE_REF"
git -C "$NEW_DIR" checkout -B main FETCH_HEAD

if [ -f "$APP_DIR/$ENV_RELATIVE_PATH" ]; then
  mkdir -p "$(dirname "$NEW_DIR/$ENV_RELATIVE_PATH")"
  cp "$APP_DIR/$ENV_RELATIVE_PATH" "$NEW_DIR/$ENV_RELATIVE_PATH"
fi

if [ -x "$NODE_HOME/bin/npm" ]; then
  NPM_CMD="$NODE_HOME/bin/npm"
else
  NPM_CMD="$(command -v npm || true)"
fi

if [ -z "$NPM_CMD" ]; then
  echo "npm is not installed."
  exit 1
fi

cd "$NEW_DIR"
"$NPM_CMD" install

if [ -d "$APP_DIR" ]; then
  mv "$APP_DIR" "$BACKUP_DIR"
fi
mv "$NEW_DIR" "$APP_DIR"

"$APP_DIR/deploy/gce/start-node.sh"
"$APP_DIR/deploy/gce/status-node.sh"

printf 'recloned_to=%s backup=%s repo=%s ref=%s\n' "$APP_DIR" "$BACKUP_DIR" "$RECLONE_REPO_URL" "$RECLONE_REF"
