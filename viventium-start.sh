#!/bin/bash
# VIVENTIUM START
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# VIVENTIUM END

#
# Viventium Development Server Start Script
#
# Usage: ./scripts/viventium-start.sh [--build] [--clean] [--backend-only] [--frontend-only]
#
# Options:
#   --build         Force rebuild all packages before starting
#   --clean         Clean all dist folders and force rebuild (includes --build)
#   --backend-only  Only start the backend server
#   --frontend-only Only start the frontend dev server
#   --help          Show this help message
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Script is in LibreChat root, so PROJECT_DIR is the same as SCRIPT_DIR
PROJECT_DIR="$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Default options
BUILD_PACKAGES=false
CLEAN_BUILD=false
BACKEND_ONLY=false
FRONTEND_ONLY=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --build)
            BUILD_PACKAGES=true
            shift
            ;;
        --clean)
            CLEAN_BUILD=true
            BUILD_PACKAGES=true
            shift
            ;;
        --backend-only)
            BACKEND_ONLY=true
            shift
            ;;
        --frontend-only)
            FRONTEND_ONLY=true
            shift
            ;;
        --help)
            head -20 "$0" | tail -17
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"
            exit 1
            ;;
    esac
done

cd "$PROJECT_DIR"

# === VIVENTIUM NOTE ===
# Bind dev servers explicitly to a dual-stack local bind by default.
#
# `localhost` resolves to both `127.0.0.1` and `::1` on macOS. Some clients try IPv6 first,
# others try IPv4 first, and not all retry/fallback reliably.
#
# Using `HOST=::` yields a single dual-stack listener on macOS that accepts both:
# - http://127.0.0.1:* (IPv4)
# - http://[::1]:*     (IPv6)
#
# Security note: `HOST=::` binds to all interfaces on the machine (dual-stack). If you want
# loopback-only, override before running:
#   HOST=127.0.0.1 ./viventium-start.sh   (IPv4 loopback only)
#   HOST=::1       ./viventium-start.sh   (IPv6 loopback only)
export HOST="${HOST:-::}"
# === VIVENTIUM NOTE ===

resolve_local_meili_master_key() {
    if [[ -n "${MEILI_MASTER_KEY:-}" ]]; then
        printf '%s' "$MEILI_MASTER_KEY"
        return 0
    fi
    if [[ -n "${VIVENTIUM_LOCAL_MEILI_MASTER_KEY:-}" ]]; then
        printf '%s' "$VIVENTIUM_LOCAL_MEILI_MASTER_KEY"
        return 0
    fi
    if [[ -n "${VIVENTIUM_CALL_SESSION_SECRET:-}" ]]; then
        printf '%s' "$VIVENTIUM_CALL_SESSION_SECRET"
        return 0
    fi
    if command -v python3 >/dev/null 2>&1; then
        python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
        return 0
    fi
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex 32 2>/dev/null | tr -d '\n'
        return 0
    fi
    printf '%s' 'viventium-local-meili'
}

LC_API_PORT="${VIVENTIUM_LC_API_PORT:-${PORT:-3080}}"
LC_FRONTEND_PORT="${VIVENTIUM_LC_FRONTEND_PORT:-3090}"
LC_API_URL="http://localhost:${LC_API_PORT}"
LC_FRONTEND_URL="http://localhost:${LC_FRONTEND_PORT}"

# Load environment variables from .env file if it exists
if [ -f ".env" ]; then
    echo -e "${YELLOW}Loading environment variables from .env...${NC}"
    # Export variables from .env file, skipping readonly vars like UID/GID
    while IFS= read -r line || [[ -n "$line" ]]; do
        # Skip comments and empty lines
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ -z "$line" ]] && continue
        # Skip UID, GID, EUID, PPID and other readonly bash vars
        [[ "$line" =~ ^(UID|GID|EUID|PPID|DOCKER_GID)= ]] && continue
        # Export valid key=value pairs
        if [[ "$line" =~ ^([a-zA-Z_][a-zA-Z0-9_]*)=(.*)$ ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            # === VIVENTIUM NOTE ===
            # Respect already-set env vars so wrapper scripts can override .env
            # (prevents port/env mismatches across LibreChat + Playground + Voice Gateway).
            if [[ -z "${!key:-}" ]]; then
                export "$key=$value"
            fi
            # === VIVENTIUM NOTE ===
        fi
    done < .env
    echo -e "${GREEN}Environment variables loaded${NC}"
else
    echo -e "${YELLOW}Warning: .env file not found. Environment variables may not be loaded correctly.${NC}"
fi

# === VIVENTIUM START ===
# Local conversation search defaults. The outer launcher provisions Meilisearch;
# this script keeps the feature enabled when started directly against the local env.
export SEARCH="${SEARCH:-true}"
export MEILI_NO_ANALYTICS="${MEILI_NO_ANALYTICS:-true}"
export MEILI_SYNC_THRESHOLD="${MEILI_SYNC_THRESHOLD:-0}"
if [[ -z "${MEILI_MASTER_KEY:-}" ]]; then
    export MEILI_MASTER_KEY="$(resolve_local_meili_master_key)"
fi
if [[ -z "${MEILI_HOST:-}" ]]; then
    export MEILI_HOST="http://127.0.0.1:${VIVENTIUM_LOCAL_MEILI_PORT:-7700}"
fi
# === VIVENTIUM END ===

# === VIVENTIUM START ===
# Ensure the local Meili index contains full Mongo history before the dev
# servers come up. New writes continue to flow through the normal model hooks.
ensure_local_search_backfill() {
    local search_enabled
    search_enabled="$(printf '%s' "${SEARCH:-}" | tr '[:upper:]' '[:lower:]')"
    if [[ "$search_enabled" != "true" && "$search_enabled" != "1" && "$search_enabled" != "yes" && "$search_enabled" != "on" ]]; then
        return 0
    fi

    local sync_script="$PROJECT_DIR/scripts/viventium-sync-local-search.js"
    if [[ ! -f "$sync_script" ]]; then
        echo -e "${RED}Missing local search sync helper: ${sync_script}${NC}"
        return 1
    fi

    echo -e "${YELLOW}Ensuring local conversation search is fully indexed...${NC}"
    node "$sync_script"
}
# === VIVENTIUM END ===

#==================================================#
#         Anthropic mode (local dev only)          #
#==================================================#
# LibreChat uses a SINGLE global Anthropic config per running instance.
# For local dev (this script), we derive ANTHROPIC_* from a simple toggle:
#
#   VIVENTIUM_ANTHROPIC_MODE=foundry|direct
#
# This does NOT affect the dual-docker setup (docker-compose.dual.yml sets
# ANTHROPIC_* per container).
#
# ⚠️ CRITICAL: Reverse Proxy URL Format
# ======================================
# The ANTHROPIC_REVERSE_PROXY must NOT include a trailing /v1 because
# LibreChat's Anthropic SDK automatically appends /v1/messages to the baseURL.
#
# ✅ CORRECT: https://.../anthropic
#    → SDK creates: https://.../anthropic/v1/messages ✅
#
# ❌ WRONG:   https://.../anthropic/v1
#    → SDK creates: https://.../anthropic/v1/v1/messages → 404 error ❌
#
# This script automatically removes trailing /v1 as a safety measure.
# See docs/ANTHROPIC_AZURE_FOUNDRY_SETUP.md for full documentation.
configure_anthropic_env() {
    local mode="${VIVENTIUM_ANTHROPIC_MODE:-foundry}"
    local existing_anthropic_key="${ANTHROPIC_API_KEY:-}"
    local direct_anthropic_key="${VIVENTIUM_ANTHROPIC_DIRECT_API_KEY:-}"

    if [ "$mode" = "foundry" ]; then
        if [ -z "${AZURE_AI_FOUNDRY_API_KEY:-}" ]; then
            if [ -n "$direct_anthropic_key" ]; then
                export ANTHROPIC_API_KEY="$direct_anthropic_key"
            elif [ -n "$existing_anthropic_key" ]; then
                export ANTHROPIC_API_KEY="$existing_anthropic_key"
            else
                export ANTHROPIC_API_KEY="user_provided"
            fi
            unset ANTHROPIC_REVERSE_PROXY

            if [ -n "${VIVENTIUM_ANTHROPIC_DIRECT_MODELS:-}" ]; then
                export ANTHROPIC_MODELS="${VIVENTIUM_ANTHROPIC_DIRECT_MODELS}"
            else
                unset ANTHROPIC_MODELS
            fi

            echo -e "${YELLOW}Warning: AZURE_AI_FOUNDRY_API_KEY is not set; falling back to Anthropic direct/user-provided auth.${NC}"
            echo -e "${GREEN}Anthropic mode: Direct fallback${NC}"
            return 0
        fi
        export ANTHROPIC_API_KEY="${AZURE_AI_FOUNDRY_API_KEY:-}"
        # IMPORTANT: LibreChat Anthropic client appends `/v1/messages` internally.
        # Therefore this reverse proxy must NOT include a trailing `/v1` or you'll get `/v1/v1/messages` 404s.
        FOUNDRY_REVERSE_PROXY="${VIVENTIUM_FOUNDRY_ANTHROPIC_REVERSE_PROXY:-https://aihubpaisalesi3989106374.services.ai.azure.com/anthropic}"
        # Remove trailing /v1 if present (safety check)
        if [[ "$FOUNDRY_REVERSE_PROXY" == */v1 ]]; then
            echo -e "${YELLOW}Warning: Removing trailing /v1 from reverse proxy URL${NC}"
            FOUNDRY_REVERSE_PROXY="${FOUNDRY_REVERSE_PROXY%/v1}"
        fi
        export ANTHROPIC_REVERSE_PROXY="$FOUNDRY_REVERSE_PROXY"
        export ANTHROPIC_MODELS="${VIVENTIUM_FOUNDRY_ANTHROPIC_MODELS:-claude-opus-4-5}"
        echo -e "${GREEN}Anthropic mode: Foundry (Opus 4.5)${NC}"
        echo -e "${GREEN}  ANTHROPIC_REVERSE_PROXY=${ANTHROPIC_REVERSE_PROXY}${NC}"
    elif [ "$mode" = "direct" ]; then
        if [ -n "$direct_anthropic_key" ]; then
            export ANTHROPIC_API_KEY="$direct_anthropic_key"
        elif [ -n "$existing_anthropic_key" ]; then
            export ANTHROPIC_API_KEY="$existing_anthropic_key"
        else
            export ANTHROPIC_API_KEY="user_provided"
        fi
        unset ANTHROPIC_REVERSE_PROXY

        if [ -n "${VIVENTIUM_ANTHROPIC_DIRECT_MODELS:-}" ]; then
            export ANTHROPIC_MODELS="${VIVENTIUM_ANTHROPIC_DIRECT_MODELS}"
        else
            unset ANTHROPIC_MODELS
        fi
        echo -e "${GREEN}Anthropic mode: Direct${NC}"
    else
        echo -e "${RED}Unknown VIVENTIUM_ANTHROPIC_MODE=${mode}. Use 'foundry' or 'direct'.${NC}"
        exit 1
    fi
}

configure_anthropic_env

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}  Viventium Development Server${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check Node.js version
echo -e "${YELLOW}Checking Node.js version...${NC}"
NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}Node.js 20+ required. Current version: $(node -v)${NC}"
    echo -e "${YELLOW}Run: nvm use 20${NC}"
    exit 1
fi
echo -e "${GREEN}Node.js $(node -v) OK${NC}"

# Check if MongoDB is running on the configured target.
echo -e "${YELLOW}Checking MongoDB connection...${NC}"
MONGO_CHECK_TARGET="${MONGO_URI:-}"
if [[ -n "$MONGO_CHECK_TARGET" ]]; then
    if ! mongosh "$MONGO_CHECK_TARGET" --eval "db.runCommand({ping:1})" --quiet > /dev/null 2>&1; then
        echo -e "${RED}MongoDB is not reachable at MONGO_URI=${MONGO_CHECK_TARGET}${NC}"
        exit 1
    fi
else
    if ! mongosh --eval "db.runCommand({ping:1})" --quiet > /dev/null 2>&1; then
        echo -e "${RED}MongoDB is not running!${NC}"
        echo -e "${YELLOW}Please start MongoDB first:${NC}"
        echo -e "  brew services start mongodb-community"
        echo -e "  OR"
        echo -e "  mongod --dbpath ~/data/mongodb --fork --logpath ~/data/mongodb/mongo.log"
        exit 1
    fi
fi
echo -e "${GREEN}MongoDB connection OK${NC}"

# === VIVENTIUM START ===
search_enabled="$(printf '%s' "${SEARCH:-}" | tr '[:upper:]' '[:lower:]')"
if [[ "$search_enabled" == "true" || "$search_enabled" == "1" || "$search_enabled" == "yes" || "$search_enabled" == "on" ]]; then
    echo -e "${GREEN}Conversation search enabled via Meilisearch${NC}"
    echo -e "${GREEN}  MEILI_HOST=${MEILI_HOST}${NC}"
    if command -v curl >/dev/null 2>&1; then
        if curl -fs --max-time 3 "${MEILI_HOST%/}/health" >/dev/null 2>&1; then
            echo -e "${GREEN}Meilisearch connection OK${NC}"
        else
            echo -e "${YELLOW}Warning: SEARCH=true but Meilisearch is not reachable at ${MEILI_HOST}. Existing conversations will not be searchable until it is up.${NC}"
        fi
    fi
fi
# === VIVENTIUM END ===

# Verify critical environment variables for Groq (if librechat.yaml uses it)
if [ -f "librechat.yaml" ] && grep -q "GROQ_API_KEY" librechat.yaml 2>/dev/null; then
    if [ -z "${GROQ_API_KEY}" ]; then
        echo -e "${YELLOW}Warning: GROQ_API_KEY is not set but is referenced in librechat.yaml${NC}"
        echo -e "${YELLOW}Please ensure GROQ_API_KEY is set in your .env file${NC}"
    else
        echo -e "${GREEN}GROQ_API_KEY is configured${NC}"
    fi
fi

# Clean build if requested
if [ "$CLEAN_BUILD" = true ]; then
    echo -e "${YELLOW}Cleaning build artifacts...${NC}"
    # Clean package dist folders
    rm -rf packages/data-provider/dist
    rm -rf packages/data-schemas/dist
    rm -rf packages/api/dist
    rm -rf packages/client/dist
    rm -rf client/dist
    echo -e "${GREEN}Build artifacts cleaned${NC}"
fi

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing dependencies (first time setup)...${NC}"
    if [ -f "package-lock.json" ]; then npm ci; else echo "No package-lock.json found, running npm install..."; npm install; fi
    BUILD_PACKAGES=true
fi

# Detect stale dist artifacts. This is critical because LibreChat imports some packages
# from their built `dist/` output at runtime, and after upstream pulls/ports it's common
# to have `dist/` present but older than `src/` (causing runtime validation bugs).
find_newer_source() {
    local dist_file="$1"
    shift

    if [ ! -f "$dist_file" ]; then
        echo "$dist_file (missing)"
        return 0
    fi

    local p
    for p in "$@"; do
        if [ -f "$p" ] && [ "$p" -nt "$dist_file" ]; then
            echo "$p"
            return 0
        fi
        if [ -d "$p" ]; then
            local newer_file
            newer_file=$(find "$p" -type f -newer "$dist_file" 2>/dev/null | head -n 1)
            if [ -n "$newer_file" ]; then
                echo "$newer_file"
                return 0
            fi
        fi
    done

    return 1
}

# Auto-rebuild packages if their `dist/` is stale (common after git pulls/ports).
if [ "$BUILD_PACKAGES" = false ] && [ "$CLEAN_BUILD" = false ]; then
    STALE_PACKAGES=false

    if newer_source=$(find_newer_source "packages/data-provider/dist/index.js" \
        "packages/data-provider/src" \
        "packages/data-provider/react-query" \
        "packages/data-provider/rollup.config.js" \
        "packages/data-provider/server-rollup.config.js" \
        "packages/data-provider/package.json"); then
        echo -e "${YELLOW}Detected stale build: packages/data-provider${NC}"
        echo -e "${YELLOW}  Newer than dist/index.js:${NC} $newer_source"
        STALE_PACKAGES=true
    fi

    if newer_source=$(find_newer_source "packages/data-schemas/dist/index.cjs" \
        "packages/data-schemas/src" \
        "packages/data-schemas/rollup.config.js" \
        "packages/data-schemas/package.json"); then
        echo -e "${YELLOW}Detected stale build: packages/data-schemas${NC}"
        echo -e "${YELLOW}  Newer than dist/index.cjs:${NC} $newer_source"
        STALE_PACKAGES=true
    fi

    if newer_source=$(find_newer_source "packages/api/dist/index.js" \
        "packages/api/src" \
        "packages/api/rollup.config.js" \
        "packages/api/package.json"); then
        echo -e "${YELLOW}Detected stale build: packages/api${NC}"
        echo -e "${YELLOW}  Newer than dist/index.js:${NC} $newer_source"
        STALE_PACKAGES=true
    fi

    if newer_source=$(find_newer_source "packages/client/dist/index.js" \
        "packages/client/src" \
        "packages/client/rollup.config.js" \
        "packages/client/package.json"); then
        echo -e "${YELLOW}Detected stale build: packages/client${NC}"
        echo -e "${YELLOW}  Newer than dist/index.js:${NC} $newer_source"
        STALE_PACKAGES=true
    fi

    if [ "$STALE_PACKAGES" = true ]; then
        echo -e "${YELLOW}Stale package builds detected; rebuilding packages...${NC}"
        BUILD_PACKAGES=true
    fi
fi

# Build packages if needed or requested
if [ "$BUILD_PACKAGES" = true ]; then
    echo -e "${YELLOW}Building packages...${NC}"
    npm run build:data-provider
    npm run build:data-schemas
    npm run build:api
    npm run build:client-package
    echo -e "${GREEN}Packages built successfully${NC}"
fi

# Check if packages are built
if [ ! -d "packages/data-provider/dist" ] || [ ! -d "packages/data-schemas/dist" ] || [ ! -d "packages/api/dist" ] || [ ! -d "packages/client/dist" ]; then
    echo -e "${YELLOW}Packages not built. Building now...${NC}"
    npm run build:data-provider
    npm run build:data-schemas
    npm run build:api
    npm run build:client-package
fi

client_build_node_options() {
    local max_old_space_size="${VIVENTIUM_CLIENT_BUILD_MAX_OLD_SPACE_SIZE:-4096}"
    if [[ -n "$max_old_space_size" ]]; then
        printf '%s\n' "--max-old-space-size=${max_old_space_size}"
    fi
}

build_client_bundle() {
    local build_node_options=""
    build_node_options="$(client_build_node_options)"
    echo -e "${YELLOW}Building client (required for backend)...${NC}"
    if ! (
        if [[ -n "$build_node_options" ]]; then
            export NODE_OPTIONS="${build_node_options}${NODE_OPTIONS:+ ${NODE_OPTIONS}}"
        fi
        if [[ -L client/dist ]]; then
            rm -rf client/dist
        fi
        mkdir -p client/dist
        cd client
        npm run build
    ); then
        echo -e "${RED}Client build failed${NC}"
        return 1
    fi
    echo -e "${GREEN}Client built successfully${NC}"
}

# Check if client is built (required for backend to start)
if [ ! -f "client/dist/index.html" ]; then
    build_client_bundle || exit 1
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}  Starting servers...${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# Cleanup function
cleanup() {
    echo ""
    echo -e "${YELLOW}Shutting down servers...${NC}"
    pkill -f "node api/server/index.js" 2>/dev/null || true
    pkill -f "vite" 2>/dev/null || true
    echo -e "${GREEN}Servers stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

if [ "$FRONTEND_ONLY" = true ]; then
    echo -e "${BLUE}Starting frontend only...${NC}"
    # Use --host to ensure frontend URL works on systems where localhost resolves to IPv4 first.
    # Ensure Vite proxy routes /api to the active LibreChat API port.
    cd client && BACKEND_PORT="$LC_API_PORT" VIVENTIUM_LC_API_PORT="$LC_API_PORT" npm run dev -- --host "${HOST}" --port "$LC_FRONTEND_PORT"
elif [ "$BACKEND_ONLY" = true ]; then
    echo -e "${BLUE}Starting backend only...${NC}"
    ensure_local_search_backfill
    npm run backend:dev
else
    # Start both backend and frontend
    ensure_local_search_backfill
    echo -e "${BLUE}Starting backend server...${NC}"
    npm run backend:dev &
    BACKEND_PID=$!

    # Wait for backend to be ready
    echo -e "${YELLOW}Waiting for backend to start...${NC}"
    sleep 5

    echo -e "${BLUE}Starting frontend dev server...${NC}"
    # Use --host/--port to ensure frontend is reachable via LC_FRONTEND_URL.
    (cd client && BACKEND_PORT="$LC_API_PORT" VIVENTIUM_LC_API_PORT="$LC_API_PORT" npm run dev -- --host "${HOST}" --port "$LC_FRONTEND_PORT") &
    FRONTEND_PID=$!

    echo ""
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN}  Servers running!${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo ""
    echo -e "  ${BLUE}Frontend (dev):${NC} ${LC_FRONTEND_URL}"
    echo -e "  ${BLUE}Backend API:${NC}    ${LC_API_URL}/api"
    echo ""
    echo -e "${YELLOW}Open ${LC_FRONTEND_URL} in your browser${NC}"
    echo -e "${YELLOW}Press Ctrl+C to stop all servers${NC}"
    echo ""

    # Wait for either process to exit
    wait $BACKEND_PID $FRONTEND_PID
fi
