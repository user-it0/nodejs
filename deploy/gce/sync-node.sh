#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/nodejs}"
ENV_FILE="${ENV_FILE:-$APP_DIR/deploy/gce/.env.runtime}"
NODE_HOME="${NODE_HOME:-$HOME/.local/node-v20}"
SYNC_REMOTE="${GCE_SYNC_REMOTE:-executor}"
SYNC_REPO_URL="${GCE_SYNC_REPO_URL:-https://github.com/user-it0/nodejs.git}"
SYNC_REF="${GCE_SYNC_REPO_REF:-main}"
LOCAL_BRANCH="${GCE_SYNC_LOCAL_BRANCH:-main}"
SYNC_RUN_NPM_INSTALL="${GCE_SYNC_RUN_NPM_INSTALL:-auto}"
SYNC_FORCE_CLEAN="${GCE_SYNC_FORCE_CLEAN:-false}"
SYNC_RESTART="${GCE_SYNC_RESTART:-true}"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

for arg in "$@"; do
  case "$arg" in
    --skip-restart)
      SYNC_RESTART="false"
      ;;
    --force-clean)
      SYNC_FORCE_CLEAN="true"
      ;;
    *)
      echo "Unknown argument: $arg"
      exit 1
      ;;
  esac
done

parse_bool() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

ensure_remote() {
  if git remote get-url "$SYNC_REMOTE" >/dev/null 2>&1; then
    git remote set-url "$SYNC_REMOTE" "$SYNC_REPO_URL"
  else
    git remote add "$SYNC_REMOTE" "$SYNC_REPO_URL"
  fi
}

ensure_node_toolchain() {
  if [ -x "$NODE_HOME/bin/npm" ]; then
    NPM_CMD="$NODE_HOME/bin/npm"
    NODE_CMD="$NODE_HOME/bin/node"
    return
  fi

  NPM_CMD="$(command -v npm || true)"
  NODE_CMD="$(command -v node || true)"
  if [ -z "$NPM_CMD" ] || [ -z "$NODE_CMD" ]; then
    echo "Node.js/npm are not installed."
    exit 1
  fi
}

should_run_npm_install() {
  case "$(printf '%s' "$SYNC_RUN_NPM_INSTALL" | tr '[:upper:]' '[:lower:]')" in
    always)
      return 0
      ;;
    never)
      return 1
      ;;
  esac

  if [ ! -d "$APP_DIR/node_modules" ]; then
    return 0
  fi

  printf '%s\n' "$CHANGED_FILES" | grep -Eq '(^|/)(package\.json|package-lock\.json)$'
}

if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$SYNC_REPO_URL" "$APP_DIR"
fi

cd "$APP_DIR"
ensure_remote

if ! git diff --quiet || ! git diff --cached --quiet; then
  if parse_bool "$SYNC_FORCE_CLEAN"; then
    git reset --hard HEAD
    git clean -fd
  else
    echo "Working tree has local changes. Re-run with --force-clean to discard them."
    exit 1
  fi
fi

PREVIOUS_COMMIT="$(git rev-parse HEAD)"
git fetch "$SYNC_REMOTE" "$SYNC_REF"
TARGET_COMMIT="$(git rev-parse FETCH_HEAD)"

if git show-ref --verify --quiet "refs/heads/$LOCAL_BRANCH"; then
  git checkout "$LOCAL_BRANCH"
else
  git checkout -B "$LOCAL_BRANCH" "$TARGET_COMMIT"
fi

if [ "$PREVIOUS_COMMIT" != "$TARGET_COMMIT" ]; then
  if git merge-base --is-ancestor HEAD "$TARGET_COMMIT"; then
    git merge --ff-only "$TARGET_COMMIT"
  elif parse_bool "$SYNC_FORCE_CLEAN"; then
    git reset --hard "$TARGET_COMMIT"
  else
    echo "Local branch cannot fast-forward to $SYNC_REMOTE/$SYNC_REF."
    echo "Re-run with --force-clean to reset to the remote commit."
    exit 1
  fi
fi

CHANGED_FILES="$(git diff --name-only "$PREVIOUS_COMMIT" "$TARGET_COMMIT" || true)"

ensure_node_toolchain
if should_run_npm_install; then
  "$NPM_CMD" install
fi

if parse_bool "$SYNC_RESTART"; then
  "$APP_DIR/deploy/gce/stop-node.sh" || true
  "$APP_DIR/deploy/gce/start-node.sh"
fi

printf 'synced_to=%s branch=%s remote=%s/%s\n' "$TARGET_COMMIT" "$LOCAL_BRANCH" "$SYNC_REMOTE" "$SYNC_REF"
