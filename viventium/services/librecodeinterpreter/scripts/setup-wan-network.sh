#!/bin/bash
# Setup script for WAN-only network with iptables rules
# This script should be run with root/sudo privileges
#
# This script creates a Docker network that allows containers to access
# the public internet while blocking access to:
# - Private IP ranges (10.x, 172.16-31.x, 192.168.x)
# - Link-local addresses (169.254.x.x) - includes cloud metadata services
# - Docker host gateway
# - Other containers on the same network (ICC disabled)

set -e

# Configuration (can be overridden by environment variables)
NETWORK_NAME="${WAN_NETWORK_NAME:-code-interpreter-wan}"
SUBNET="172.30.0.0/16"
GATEWAY="172.30.0.1"
CHAIN_NAME="CODE_INTERP_WAN"
DNS_SERVERS="${WAN_DNS_SERVERS:-8.8.8.8,1.1.1.1,8.8.4.4}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}Setting up WAN-only network: $NETWORK_NAME${NC}"
echo ""

# Check for root/sudo
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Error: This script must be run with root/sudo privileges${NC}"
    echo "Please run: sudo $0"
    exit 1
fi

# Check if Docker is available
if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed or not in PATH${NC}"
    exit 1
fi

# Create Docker network if it doesn't exist
if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
    echo "Creating Docker network..."
    docker network create \
        --driver bridge \
        --subnet="$SUBNET" \
        --gateway="$GATEWAY" \
        --opt "com.docker.network.bridge.enable_ip_masquerade=true" \
        --opt "com.docker.network.bridge.enable_icc=false" \
        --label "com.code-interpreter.managed=true" \
        --label "com.code-interpreter.type=wan-access" \
        "$NETWORK_NAME"
    echo -e "${GREEN}Network created successfully${NC}"
else
    echo -e "${YELLOW}Network $NETWORK_NAME already exists${NC}"
fi

# Get bridge interface name
NETWORK_ID=$(docker network inspect "$NETWORK_NAME" --format '{{.Id}}' | cut -c1-12)
BRIDGE_NAME="br-$NETWORK_ID"

echo ""
echo "Network details:"
echo "  - Network ID: $NETWORK_ID"
echo "  - Bridge interface: $BRIDGE_NAME"
echo "  - Subnet: $SUBNET"
echo "  - Gateway: $GATEWAY"
echo ""

# Wait for bridge interface to be available
echo "Waiting for bridge interface..."
for i in {1..10}; do
    if ip link show "$BRIDGE_NAME" >/dev/null 2>&1; then
        echo -e "${GREEN}Bridge interface $BRIDGE_NAME is ready${NC}"
        break
    fi
    if [ $i -eq 10 ]; then
        echo -e "${YELLOW}Warning: Bridge interface not found. iptables rules may fail.${NC}"
        echo "This can happen if no containers are connected to the network yet."
    fi
    sleep 1
done

echo ""
echo "Setting up iptables rules..."

# Create chain if it doesn't exist
iptables -N "$CHAIN_NAME" 2>/dev/null || iptables -F "$CHAIN_NAME"

# Allow established connections (critical for return traffic)
iptables -A "$CHAIN_NAME" -m state --state ESTABLISHED,RELATED -j ACCEPT

# Allow DNS to public servers
IFS=',' read -ra DNS_ARRAY <<< "$DNS_SERVERS"
for DNS in "${DNS_ARRAY[@]}"; do
    echo "  Allowing DNS to $DNS"
    iptables -A "$CHAIN_NAME" -p udp -d "$DNS" --dport 53 -j ACCEPT
    iptables -A "$CHAIN_NAME" -p tcp -d "$DNS" --dport 53 -j ACCEPT
done

# Block private IP ranges
echo "  Blocking private IP ranges..."
iptables -A "$CHAIN_NAME" -d 10.0.0.0/8 -j DROP
iptables -A "$CHAIN_NAME" -d 172.16.0.0/12 -j DROP
iptables -A "$CHAIN_NAME" -d 192.168.0.0/16 -j DROP
iptables -A "$CHAIN_NAME" -d 169.254.0.0/16 -j DROP
iptables -A "$CHAIN_NAME" -d 127.0.0.0/8 -j DROP
iptables -A "$CHAIN_NAME" -d 224.0.0.0/4 -j DROP
iptables -A "$CHAIN_NAME" -d 240.0.0.0/4 -j DROP

# Block gateway (Docker host)
echo "  Blocking Docker host gateway ($GATEWAY)..."
iptables -A "$CHAIN_NAME" -d "$GATEWAY" -j DROP

# Allow all other traffic (public internet)
iptables -A "$CHAIN_NAME" -j ACCEPT

# Insert into FORWARD chain (remove existing rule first to avoid duplicates)
iptables -D FORWARD -i "$BRIDGE_NAME" -j "$CHAIN_NAME" 2>/dev/null || true
iptables -I FORWARD 1 -i "$BRIDGE_NAME" -j "$CHAIN_NAME"

echo ""
echo -e "${GREEN}WAN network setup complete!${NC}"
echo ""
echo "Containers on '$NETWORK_NAME' can now access:"
echo "  - Public internet (all ports)"
echo "  - Public DNS servers ($DNS_SERVERS)"
echo ""
echo "Blocked:"
echo "  - Private IP ranges (10.x, 172.16-31.x, 192.168.x)"
echo "  - Link-local addresses (169.254.x.x)"
echo "  - Docker host gateway ($GATEWAY)"
echo "  - Inter-container communication"
echo ""
echo -e "${YELLOW}Note: These iptables rules are not persistent across reboots.${NC}"
echo "Run this script again after a system restart, or use iptables-persistent."
