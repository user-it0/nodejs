#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/nodejs}"
RUN_DIR="${RUN_DIR:-$APP_DIR/.run}"
PID_FILE="$RUN_DIR/helper.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No pid file found."
  exit 0
fi

HELPER_PID="$(cat "$PID_FILE" 2>/dev/null || true)"

if [ -z "$HELPER_PID" ]; then
  rm -f "$PID_FILE"
  echo "Pid file was empty."
  exit 0
fi

if kill -0 "$HELPER_PID" 2>/dev/null; then
  kill "$HELPER_PID"
  for _ in 1 2 3 4 5; do
    if ! kill -0 "$HELPER_PID" 2>/dev/null; then
      break
    fi
    sleep 1
  done
fi

if kill -0 "$HELPER_PID" 2>/dev/null; then
  kill -9 "$HELPER_PID" 2>/dev/null || true
fi

rm -f "$PID_FILE"
echo "Helper stopped."
