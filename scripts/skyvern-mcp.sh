#!/usr/bin/env bash
#
# === VIVENTIUM START ===
# Skyvern MCP wrapper for LibreChat stdio integration.
# Purpose: Load env from Viventium/LibreChat, sanitize placeholders, then
#          run the official Skyvern MCP when available, otherwise fallback
#          to the lightweight HTTP MCP wrapper.
# Reason: LibreChat env interpolation does not support ${VAR:-default}, and
#         missing/malformed SKYVERN_BASE_URL causes "Invalid URL" failures.
# === VIVENTIUM END ===
#
set -euo pipefail

mask_value() {
  local value="${1:-}"
  if [[ -z "$value" ]]; then
    echo "<NOT SET>"
    return 0
  fi
  local prefix="${value:0:6}"
  local suffix="${value: -4}"
  echo "${prefix}...${suffix}"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIBRECHAT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
IN_CONTAINER=false
if [[ -f "/.dockerenv" || -f "/run/.containerenv" || -n "${CONTAINER_APP_NAME:-}" || -n "${WEBSITE_SITE_NAME:-}" ]]; then
  IN_CONTAINER=true
fi
if [[ "$ROOT_DIR" == "/" ]]; then
  IN_CONTAINER=true
fi

# DEBUG: Log env vars received from parent process
DEBUG_LOG="/tmp/skyvern-mcp-debug-$(date +%s).log"
{
  echo "=== SKYVERN MCP DEBUG $(date) ==="
  echo "SKYVERN_API_KEY: $(mask_value "${SKYVERN_API_KEY:-}")"
  echo "SKYVERN_BASE_URL: ${SKYVERN_BASE_URL:-<NOT SET>}"
  echo "SKYVERN_APP_URL: ${SKYVERN_APP_URL:-<NOT SET>}"
  echo "IN_CONTAINER: ${IN_CONTAINER}"
  echo "PWD: $(pwd)"
  echo "SCRIPT_DIR: ${SCRIPT_DIR}"
  echo "ROOT_DIR: ${ROOT_DIR}"
} > "$DEBUG_LOG" 2>&1 || true

load_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue

    local key="${BASH_REMATCH[1]}"
    local value="${BASH_REMATCH[2]}"
    # Do not override explicit env already provided by the MCP config.
    if [[ -n "${!key:-}" ]]; then
      continue
    fi
    # Avoid shipping local SKYVERN_* from baked .env into container runtime.
    if [[ "${IN_CONTAINER}" == "true" && "$key" == SKYVERN_* ]]; then
      continue
    fi
    [[ "$key" == "UID" || "$key" == "EUID" || "$key" == "PPID" || "$key" == "BASHPID" ]] && continue
    value="${value#\"}"
    value="${value%\"}"
    value="${value#\'}"
    value="${value%\'}"
    export "$key"="$value"
  done < "$env_file"
}

load_env_file "$LIBRECHAT_DIR/.env"
load_env_file "$ROOT_DIR/.env"
load_env_file "$ROOT_DIR/.env.local"

# Sanitize any template values inherited from parent process.
if [[ "${SKYVERN_BASE_URL:-}" == *'${'* ]]; then
  unset SKYVERN_BASE_URL
fi
if [[ "${SKYVERN_API_KEY:-}" == *'${'* ]]; then
  unset SKYVERN_API_KEY
fi

# Prefer explicit runtime configuration. Only default to localhost for non-container local runs.
if [[ -z "${SKYVERN_BASE_URL:-}" || "${SKYVERN_BASE_URL}" != http* ]]; then
  if [[ "${IN_CONTAINER}" == "true" ]]; then
    echo "[skyvern-mcp] SKYVERN_BASE_URL is not set for container runtime" >&2
    exit 1
  fi
  export SKYVERN_BASE_URL="http://localhost:8000"
fi
if [[ -z "${SKYVERN_APP_URL:-}" || "${SKYVERN_APP_URL}" != http* ]]; then
  if [[ "${IN_CONTAINER}" == "true" ]]; then
    export SKYVERN_APP_URL="${SKYVERN_BASE_URL}"
  else
    export SKYVERN_APP_URL="http://localhost:8080"
  fi
fi

{
  echo "--- SKYVERN MCP FINAL $(date) ---"
  echo "SKYVERN_API_KEY: $(mask_value "${SKYVERN_API_KEY:-}")"
  echo "SKYVERN_BASE_URL: ${SKYVERN_BASE_URL:-<NOT SET>}"
  echo "SKYVERN_APP_URL: ${SKYVERN_APP_URL:-<NOT SET>}"
} >> "$DEBUG_LOG" 2>&1 || true

if [[ -z "${SKYVERN_API_KEY:-}" ]]; then
  echo "[skyvern-mcp] SKYVERN_API_KEY is not set" >&2
  exit 1
fi

if [[ -z "${AZURE_API_KEY:-}" || "${AZURE_API_KEY}" == *'${'* ]]; then
  if [[ -n "${AZURE_AI_FOUNDRY_API_KEY:-}" ]]; then
    export AZURE_API_KEY="$AZURE_AI_FOUNDRY_API_KEY"
  fi
fi

# Check if the full Skyvern MCP tools package is installed by looking for its
# __init__.py on disk. This avoids a heavy Python import (10+ seconds) that
# would double the startup time.
MCP_TOOLS_DIR=$(python3 -c "import pathlib,skyvern;print(pathlib.Path(skyvern.__file__).parent/'cli'/'mcp_tools')" 2>/dev/null)
if [[ -n "$MCP_TOOLS_DIR" && -f "$MCP_TOOLS_DIR/__init__.py" ]]; then
  echo "[skyvern-mcp] Full Skyvern SDK detected, launching MCP server" >&2
  exec python3 -m skyvern run mcp
fi

echo "[skyvern-mcp] Full SDK not available, falling back to skyvern-mcp-lite (2 tools)" >&2
echo "[skyvern-mcp] To enable full MCP: pip install -e path/to/skyvern-source" >&2

# Resolve lite script path (container vs local)
LITE_SCRIPT="/app/scripts/skyvern-mcp-lite.py"
if [[ ! -f "$LITE_SCRIPT" ]]; then
  LITE_SCRIPT="$SCRIPT_DIR/skyvern-mcp-lite.py"
fi
exec python3 "$LITE_SCRIPT"
