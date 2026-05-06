#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/nodejs}"
RUN_DIR="${RUN_DIR:-$APP_DIR/.run}"
SYNC_LOG_FILE="${SYNC_LOG_FILE:-$RUN_DIR/sync.log}"
CRON_SCHEDULE="${CRON_SCHEDULE:-*/5 * * * *}"
SYNC_CMD="cd \"$APP_DIR\" && \"$APP_DIR/deploy/gce/sync-node.sh\" >> \"$SYNC_LOG_FILE\" 2>&1"
CRON_LINE="$CRON_SCHEDULE $SYNC_CMD # ivucx-helper autosync"

mkdir -p "$RUN_DIR"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

crontab -l 2>/dev/null | grep -Fv '# ivucx-helper autosync' > "$TMP_FILE" || true
printf '%s\n' "$CRON_LINE" >> "$TMP_FILE"
crontab "$TMP_FILE"

echo "Installed user crontab autosync entry:"
crontab -l | grep -F '# ivucx-helper autosync'
