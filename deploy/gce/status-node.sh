#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/nodejs}"
ENV_FILE="${ENV_FILE:-$APP_DIR/deploy/gce/.env.runtime}"
RUN_DIR="${RUN_DIR:-$APP_DIR/.run}"
PID_FILE="$RUN_DIR/helper.pid"
LOG_FILE="$RUN_DIR/helper.log"
NODE_HOME="${NODE_HOME:-$HOME/.local/node-v20}"

if [ -f "$PID_FILE" ]; then
  HELPER_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
else
  HELPER_PID=""
fi

if [ -n "$HELPER_PID" ] && kill -0 "$HELPER_PID" 2>/dev/null; then
  echo "pid=$HELPER_PID status=running"
else
  echo "pid=${HELPER_PID:-none} status=stopped"
fi

if [ -f "$ENV_FILE" ]; then
  HELPER_PORT="$(grep -E '^PORT=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  HELPER_PUBLIC_BASE_URL="$(grep -E '^HELPER_PUBLIC_BASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  HELPER_API_KEY_VALUE="$(grep -E '^HELPER_API_KEY=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  HELPER_ALLOWED_ORIGINS_VALUE="$(grep -E '^HELPER_ALLOWED_ORIGINS=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  SUPABASE_URL_VALUE="$(grep -E '^(NEXT_PUBLIC_SUPABASE_URL|SUPABASE_URL)=' "$ENV_FILE" | head -n 1 | cut -d= -f2- || true)"
  SUPABASE_SERVICE_ROLE_VALUE="$(grep -E '^(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_SERVICE_KEY)=' "$ENV_FILE" | head -n 1 | cut -d= -f2- || true)"
  GITHUB_EXECUTION_ENABLED_VALUE="$(grep -E '^GITHUB_EXECUTION_ENABLED=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
  GITHUB_EXECUTION_TOKEN_VALUE="$(grep -E '^GITHUB_EXECUTION_TOKEN=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
else
  HELPER_PORT=""
  HELPER_PUBLIC_BASE_URL=""
  HELPER_API_KEY_VALUE=""
  HELPER_ALLOWED_ORIGINS_VALUE=""
  SUPABASE_URL_VALUE=""
  SUPABASE_SERVICE_ROLE_VALUE=""
  GITHUB_EXECUTION_ENABLED_VALUE=""
  GITHUB_EXECUTION_TOKEN_VALUE=""
fi

HELPER_PORT="${HELPER_PORT:-3000}"
if [ -x "$NODE_HOME/bin/node" ]; then
  NODE_CMD="$NODE_HOME/bin/node"
else
  NODE_CMD="$(command -v node || true)"
fi

if [ -n "$NODE_CMD" ]; then
  NODE_VERSION_RAW="$("$NODE_CMD" -v 2>/dev/null || echo missing)"
else
  NODE_VERSION_RAW="missing"
fi

echo "node=$NODE_VERSION_RAW"
echo "port=$HELPER_PORT"

if command -v curl >/dev/null 2>&1; then
  echo "health:"
  curl -fsS "http://127.0.0.1:${HELPER_PORT}/healthz" || true
  echo
fi

if [ -f "$LOG_FILE" ]; then
  echo "log=$LOG_FILE"
fi

if [ -z "$HELPER_PUBLIC_BASE_URL" ] || printf '%s' "$HELPER_PUBLIC_BASE_URL" | grep -q 'YOUR_'; then
  echo "warning=HELPER_PUBLIC_BASE_URL is missing or still a placeholder"
fi

if [ -z "$HELPER_API_KEY_VALUE" ] || printf '%s' "$HELPER_API_KEY_VALUE" | grep -q 'replace-with'; then
  echo "warning=HELPER_API_KEY is missing or still a placeholder"
fi

if [ -z "$HELPER_ALLOWED_ORIGINS_VALUE" ] || printf '%s' "$HELPER_ALLOWED_ORIGINS_VALUE" | grep -q 'YOUR_VERCEL_DOMAIN'; then
  echo "warning=HELPER_ALLOWED_ORIGINS is not set for your real Vercel domain yet"
fi

if [ -z "$SUPABASE_URL_VALUE" ]; then
  echo "warning=Supabase URL is missing"
fi

if [ -z "$SUPABASE_SERVICE_ROLE_VALUE" ]; then
  echo "warning=Supabase service-role key is missing"
fi

if printf '%s' "$GITHUB_EXECUTION_ENABLED_VALUE" | grep -Eiq '^(1|true|yes|on)$' && [ -z "$GITHUB_EXECUTION_TOKEN_VALUE" ]; then
  echo "warning=GITHUB_EXECUTION_ENABLED is on but GITHUB_EXECUTION_TOKEN is missing"
fi
