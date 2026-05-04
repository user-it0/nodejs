#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/nodejs}"
START_CMD="cd \"$APP_DIR\" && \"$APP_DIR/deploy/gce/start-node.sh\""
CRON_LINE="@reboot $START_CMD # ivucx-helper autostart"

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

crontab -l 2>/dev/null | grep -Fv '# ivucx-helper autostart' > "$TMP_FILE" || true
printf '%s\n' "$CRON_LINE" >> "$TMP_FILE"
crontab "$TMP_FILE"

echo "Installed user crontab autostart entry:"
crontab -l | grep -F '# ivucx-helper autostart'
