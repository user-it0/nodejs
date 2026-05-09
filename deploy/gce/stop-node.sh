#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/nodejs}"
RUN_DIR="${RUN_DIR:-$APP_DIR/.run}"
PID_FILE="$RUN_DIR/helper.pid"
ENV_FILE="${ENV_FILE:-$APP_DIR/deploy/gce/.env.runtime}"

if [ -f "$ENV_FILE" ]; then
  HELPER_PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
else
  HELPER_PORT=""
fi
HELPER_PORT="${HELPER_PORT:-3000}"

kill_pid() {
  local pid="$1"
  if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    if ! kill -0 "$pid" 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  kill -9 "$pid" 2>/dev/null || true
}

find_listener_pids() {
  if command -v fuser >/dev/null 2>&1; then
    fuser -n tcp "$HELPER_PORT" 2>/dev/null || true
    return
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$HELPER_PORT" -sTCP:LISTEN 2>/dev/null || true
  fi
}

if [ ! -f "$PID_FILE" ]; then
  LISTENER_PIDS="$(find_listener_pids | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true)"
  if [ -z "$LISTENER_PIDS" ]; then
    echo "No pid file found."
    exit 0
  fi
  for pid in $LISTENER_PIDS; do
    kill_pid "$pid"
  done
  echo "Helper listener stopped on port $HELPER_PORT."
  exit 0
fi

HELPER_PID="$(cat "$PID_FILE" 2>/dev/null || true)"

if [ -z "$HELPER_PID" ]; then
  rm -f "$PID_FILE"
  echo "Pid file was empty."
  exit 0
fi

kill_pid "$HELPER_PID"

rm -f "$PID_FILE"
echo "Helper stopped."
