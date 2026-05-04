#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/nodejs}"
ENV_FILE="${ENV_FILE:-$APP_DIR/deploy/gce/.env.runtime}"
RUN_DIR="${RUN_DIR:-$APP_DIR/.run}"
PID_FILE="$RUN_DIR/helper.pid"
LOG_FILE="$RUN_DIR/helper.log"
NODE_HOME="${NODE_HOME:-$HOME/.local/node-v20}"

mkdir -p "$RUN_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing env file: $ENV_FILE"
  exit 1
fi

if [ ! -d "$APP_DIR/node_modules" ]; then
  echo "Missing node_modules. Run 'cd $APP_DIR && npm install' first."
  exit 1
fi

if [ -x "$NODE_HOME/bin/node" ]; then
  NODE_CMD="$NODE_HOME/bin/node"
else
  NODE_CMD="$(command -v node || true)"
fi

if [ -z "$NODE_CMD" ]; then
  echo "Node.js is not installed."
  exit 1
fi

NODE_VERSION_RAW="$("$NODE_CMD" -v 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION_RAW#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"

if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  echo "Warning: Node.js $NODE_VERSION_RAW is below the recommended version 20.x."
fi

if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "Helper is already running with pid $EXISTING_PID"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

cd "$APP_DIR"

nohup bash -lc "set -a && . \"$ENV_FILE\" && set +a && exec \"$NODE_CMD\" app.js" >>"$LOG_FILE" 2>&1 &
HELPER_PID=$!
echo "$HELPER_PID" > "$PID_FILE"

sleep 2

if kill -0 "$HELPER_PID" 2>/dev/null; then
  echo "Helper started with pid $HELPER_PID"
  echo "Log: $LOG_FILE"
  exit 0
fi

echo "Helper failed to start. Check $LOG_FILE"
exit 1
