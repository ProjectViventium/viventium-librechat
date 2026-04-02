#!/bin/bash
# VIVENTIUM START
# Purpose: Backward-compatible wrapper for the Viventium LibreChat dev launcher.
# Details: The canonical implementation lives at repo root: ./viventium-start.sh
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# VIVENTIUM END

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

exec "$PROJECT_DIR/viventium-start.sh" "$@"
