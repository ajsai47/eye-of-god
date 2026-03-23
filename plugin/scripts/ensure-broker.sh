#!/usr/bin/env bash
# ensure-broker.sh — Starts the Eye of God broker if not already running.
# The MCP server's ensureBroker() handles this automatically, but this script
# is available for standalone use or debugging.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BROKER_PORT="${CLAUDE_PEERS_PORT:-7899}"
BROKER_URL="http://127.0.0.1:${BROKER_PORT}"

# --- Check if broker is alive ---

if curl -sf "${BROKER_URL}/health" >/dev/null 2>&1; then
  echo "[eye-of-god] Broker already running on port ${BROKER_PORT}" >&2
  exit 0
fi

echo "[eye-of-god] Starting broker daemon..." >&2

# Find Bun
BUN_CMD="bun"
if ! command -v bun &>/dev/null; then
  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    BUN_CMD="$HOME/.bun/bin/bun"
  else
    echo "[eye-of-god] ERROR: Bun not found. Run smart-install.sh first." >&2
    exit 1
  fi
fi

# Start broker in background, detached
nohup "$BUN_CMD" "${PLUGIN_DIR}/broker.ts" >/dev/null 2>&1 &

# Wait for health check (up to 5 seconds)
for i in $(seq 1 25); do
  sleep 0.2
  if curl -sf "${BROKER_URL}/health" >/dev/null 2>&1; then
    echo "[eye-of-god] Broker started on port ${BROKER_PORT}" >&2
    exit 0
  fi
done

echo "[eye-of-god] ERROR: Broker failed to start within 5 seconds" >&2
exit 1
