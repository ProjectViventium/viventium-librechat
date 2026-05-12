#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p data/7001 data/7002 data/7003 logs

if ! command -v redis-server >/dev/null 2>&1; then
  echo "redis-server is required"
  exit 1
fi

if ! command -v redis-cli >/dev/null 2>&1; then
  echo "redis-cli is required"
  exit 1
fi

redis-server redis-7001.conf --daemonize yes
redis-server redis-7002.conf --daemonize yes
redis-server redis-7003.conf --daemonize yes

sleep 5

for port in 7001 7002 7003; do
  redis-cli -p "$port" ping >/dev/null
done

if redis-cli -p 7001 cluster info 2>/dev/null | grep -q "cluster_state:ok"; then
  echo "Redis cluster already initialized"
  exit 0
fi

echo "yes" | redis-cli --cluster create \
  127.0.0.1:7001 \
  127.0.0.1:7002 \
  127.0.0.1:7003 \
  --cluster-replicas 0

sleep 5

redis-cli -p 7001 cluster info | grep -q "cluster_state:ok"
echo "Redis cluster ready"
