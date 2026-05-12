#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

for port in 7001 7002 7003; do
  if redis-cli -p "$port" ping >/dev/null 2>&1; then
    redis-cli -p "$port" SHUTDOWN NOSAVE >/dev/null 2>&1 || true
  fi
done

rm -f nodes-7001.conf nodes-7002.conf nodes-7003.conf
