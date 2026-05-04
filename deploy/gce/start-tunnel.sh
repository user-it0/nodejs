#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_DIR="$ROOT_DIR/.run"
LOG_FILE="$RUN_DIR/cloudflared.log"
PID_FILE="$RUN_DIR/cloudflared.pid"
URL_FILE="$RUN_DIR/cloudflared.url"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-$HOME/.local/bin/cloudflared}"
TARGET_URL="${1:-${HELPER_TUNNEL_TARGET_URL:-http://127.0.0.1:${PORT:-3000}}}"

mkdir -p "$RUN_DIR"

if [ ! -x "$CLOUDFLARED_BIN" ]; then
  echo "cloudflared was not found at $CLOUDFLARED_BIN" >&2
  exit 1
fi

if [ -f "$PID_FILE" ]; then
  EXISTING_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$EXISTING_PID" ] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "cloudflared is already running with pid=$EXISTING_PID"
    if [ -f "$URL_FILE" ]; then
      cat "$URL_FILE"
    fi
    exit 0
  fi
fi

rm -f "$LOG_FILE" "$PID_FILE" "$URL_FILE"
nohup "$CLOUDFLARED_BIN" tunnel --url "$TARGET_URL" --no-autoupdate >"$LOG_FILE" 2>&1 &
TUNNEL_PID=$!
echo "$TUNNEL_PID" > "$PID_FILE"

for _ in $(seq 1 60); do
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    echo "cloudflared exited early. Check $LOG_FILE" >&2
    exit 1
  fi

  URL="$(grep -Eo 'https://[-a-z0-9]+\.trycloudflare\.com' "$LOG_FILE" | head -n 1 || true)"
  if [ -n "$URL" ]; then
    printf '%s\n' "$URL" > "$URL_FILE"
    echo "$URL"
    exit 0
  fi

  sleep 1
done

echo "cloudflared started but no public URL was detected yet. Check $LOG_FILE" >&2
exit 1
