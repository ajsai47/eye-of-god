#!/usr/bin/env bash
# smart-install.sh — Ensures Bun and node_modules are ready for the Eye of God plugin.
# Called by SessionStart hook before the MCP server starts.

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# --- Check for Bun ---

find_bun() {
  if command -v bun &>/dev/null; then
    echo "$(command -v bun)"
    return 0
  fi

  # Check common install locations
  for candidate in "$HOME/.bun/bin/bun" "/usr/local/bin/bun"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

BUN_PATH=""
if BUN_PATH=$(find_bun); then
  BUN_VER=$("$BUN_PATH" --version 2>/dev/null || echo "unknown")
  echo "[eye-of-god] Bun found: $BUN_PATH ($BUN_VER)" >&2
else
  echo "[eye-of-god] Bun not found. Installing Bun (https://bun.sh)..." >&2
  echo "[eye-of-god] To skip auto-install, install Bun manually and retry." >&2
  curl -fsSL https://bun.sh/install | bash 2>&1 >&2

  # Source the updated PATH
  export PATH="$HOME/.bun/bin:$PATH"

  if BUN_PATH=$(find_bun); then
    BUN_VER=$("$BUN_PATH" --version 2>/dev/null || echo "unknown")
    echo "[eye-of-god] Bun installed: $BUN_PATH ($BUN_VER)" >&2
  else
    echo "[eye-of-god] ERROR: Failed to install Bun" >&2
    exit 1
  fi
fi

# Ensure Bun is on PATH for subsequent commands
export PATH="$(dirname "$BUN_PATH"):$PATH"

# --- Check for node_modules ---

if [[ ! -d "$PLUGIN_DIR/node_modules" ]]; then
  echo "[eye-of-god] Installing dependencies..." >&2
  cd "$PLUGIN_DIR"
  bun install 2>&1 >&2
  echo "[eye-of-god] Dependencies installed" >&2
else
  echo "[eye-of-god] Dependencies already installed" >&2
fi

echo "[eye-of-god] Ready" >&2
exit 0
