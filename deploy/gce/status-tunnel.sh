#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/cloudflared.pid"
URL_FILE="$RUN_DIR/cloudflared.url"
LOG_FILE="$RUN_DIR/cloudflared.log"

if [ ! -f "$PID_FILE" ]; then
  echo "status=stopped"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  echo "status=running pid=$PID"
else
  echo "status=stale-pid"
fi

if [ -f "$URL_FILE" ]; then
  echo "url=$(cat "$URL_FILE")"
fi

if [ -f "$LOG_FILE" ]; then
  echo "log=$LOG_FILE"
fi
