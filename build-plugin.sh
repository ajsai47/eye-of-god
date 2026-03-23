#!/usr/bin/env bash
# build-plugin.sh — Assembles the plugin/ directory from source files.
# Run this after making changes to broker.ts, server.ts, or shared/ to sync them into the plugin.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugin"

echo "[build-plugin] Assembling plugin from source..." >&2

# Create directories
mkdir -p "$PLUGIN_DIR/shared" "$PLUGIN_DIR/scripts" "$PLUGIN_DIR/hooks" "$PLUGIN_DIR/.claude-plugin"

# Copy source files
cp "$REPO_ROOT/broker.ts" "$PLUGIN_DIR/broker.ts"
cp "$REPO_ROOT/server.ts" "$PLUGIN_DIR/server.ts"
cp "$REPO_ROOT/shared/types.ts" "$PLUGIN_DIR/shared/types.ts"
cp "$REPO_ROOT/shared/summarize.ts" "$PLUGIN_DIR/shared/summarize.ts"

echo "[build-plugin] Source files copied" >&2

# Install dependencies in plugin dir
if command -v bun &>/dev/null; then
  echo "[build-plugin] Installing plugin dependencies..." >&2
  cd "$PLUGIN_DIR"
  bun install 2>&1 >&2
  echo "[build-plugin] Dependencies installed" >&2
else
  echo "[build-plugin] WARNING: Bun not found, skipping dependency install" >&2
  echo "[build-plugin] Run 'cd plugin && bun install' manually" >&2
fi

# Make scripts executable
chmod +x "$PLUGIN_DIR/scripts/smart-install.sh" "$PLUGIN_DIR/scripts/ensure-broker.sh"

echo "[build-plugin] Plugin assembled at $PLUGIN_DIR" >&2
echo "[build-plugin] Done" >&2
