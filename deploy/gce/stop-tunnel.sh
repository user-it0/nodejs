#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
PID_FILE="$RUN_DIR/cloudflared.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "cloudflared is not running"
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
fi

rm -f "$PID_FILE" "$RUN_DIR/cloudflared.url"
echo "cloudflared stopped"
