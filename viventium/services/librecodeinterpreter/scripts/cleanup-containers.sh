#!/bin/bash
# Cleanup orphaned pooled containers created by Code Interpreter API
#
# Run this after docker compose down if pooled containers remain:
#   ./scripts/cleanup-containers.sh
#
# Or combine with compose down:
#   docker compose down && ./scripts/cleanup-containers.sh

set -e

LABEL="com.code-interpreter.managed=true"

# Find containers with our label
CONTAINERS=$(docker ps -aq --filter "label=$LABEL" 2>/dev/null || true)

if [ -z "$CONTAINERS" ]; then
    echo "No orphaned code-interpreter containers found."
    exit 0
fi

COUNT=$(echo "$CONTAINERS" | wc -l)
echo "Found $COUNT orphaned container(s) with label '$LABEL'"

# Remove them
echo "$CONTAINERS" | xargs docker rm -f

echo "Cleanup complete."
