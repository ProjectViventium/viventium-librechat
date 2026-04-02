#!/usr/bin/env python3
"""
API Key Management CLI

Usage:
  python scripts/api_key_cli.py create --name "My App" [--hourly 1000] [--daily 10000] [--monthly 100000]
  python scripts/api_key_cli.py list
  python scripts/api_key_cli.py show <key_prefix>
  python scripts/api_key_cli.py revoke <key_prefix>
  python scripts/api_key_cli.py update <key_prefix> [--enable|--disable] [--hourly N] [--daily N] [--monthly N]
  python scripts/api_key_cli.py usage <key_prefix>

Environment:
  MASTER_API_KEY - Required for all operations (from .env or environment)
  REDIS_URL - Redis connection (defaults to settings)

Examples:
  # Create a new API key with rate limits
  python scripts/api_key_cli.py create --name "Production App" --hourly 1000 --daily 10000

  # Create an unlimited API key
  python scripts/api_key_cli.py create --name "Internal Service"

  # List all keys
  python scripts/api_key_cli.py list

  # Check usage for a key
  python scripts/api_key_cli.py usage sk-abc12345

  # Disable a key
  python scripts/api_key_cli.py update sk-abc12345 --disable

  # Revoke a key
  python scripts/api_key_cli.py revoke sk-abc12345
"""

import argparse
import asyncio
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# Load .env file if it exists
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

from src.config import settings
from src.services.api_key_manager import ApiKeyManagerService
from src.models.api_key import RateLimits
from src.core.pool import redis_pool


def require_master_key() -> str:
    """Ensure MASTER_API_KEY is set and return it."""
    master_key = os.environ.get("MASTER_API_KEY") or settings.master_api_key
    if not master_key:
        print("Error: MASTER_API_KEY environment variable is required")
        print("")
        print("Set it in your .env file or export it:")
        print("  export MASTER_API_KEY=your-secure-master-key")
        sys.exit(1)
    return master_key


async def get_manager() -> ApiKeyManagerService:
    """Get API key manager instance."""
    redis_client = redis_pool.get_client()
    # Test connection
    try:
        await redis_client.ping()
    except Exception as e:
        print(f"Error: Cannot connect to Redis: {e}")
        print("")
        print("Ensure Redis is running and REDIS_URL/REDIS_HOST is configured correctly.")
        sys.exit(1)
    return ApiKeyManagerService(redis_client)


async def cmd_create(args):
    """Create a new API key."""
    require_master_key()
    manager = await get_manager()

    rate_limits = RateLimits(
        hourly=args.hourly,
        daily=args.daily,
        monthly=args.monthly
    )

    full_key, record = await manager.create_key(
        name=args.name,
        rate_limits=rate_limits,
        metadata={"created_by": "cli", "created_at": datetime.now().isoformat()}
    )

    print("")
    print("API Key created successfully!")
    print("")
    print(f"  Key:     {full_key}")
    print(f"  Name:    {record.name}")
    print(f"  Prefix:  {record.key_prefix}")
    print(f"  Hash:    {record.key_hash[:16]}...")
    print("")
    print("  Rate Limits:")
    print(f"    Hourly:  {rate_limits.hourly if rate_limits.hourly else 'unlimited'}")
    print(f"    Daily:   {rate_limits.daily if rate_limits.daily else 'unlimited'}")
    print(f"    Monthly: {rate_limits.monthly if rate_limits.monthly else 'unlimited'}")
    print("")
    print("IMPORTANT: Save this key now. It cannot be retrieved later.")
    print("")


async def cmd_list(args):
    """List all API keys."""
    require_master_key()
    manager = await get_manager()
    keys = await manager.list_keys()

    if not keys:
        print("No API keys found.")
        print("")
        print("Create a new key with:")
        print("  python scripts/api_key_cli.py create --name \"My App\"")
        return

    print("")
    print(f"{'Prefix':<12} {'Name':<20} {'Enabled':<8} {'Hourly':<10} {'Daily':<10} {'Monthly':<10} {'Last Used'}")
    print("-" * 95)
    for key in keys:
        hourly = str(key.rate_limits.hourly) if key.rate_limits.hourly else "unlimited"
        daily = str(key.rate_limits.daily) if key.rate_limits.daily else "unlimited"
        monthly = str(key.rate_limits.monthly) if key.rate_limits.monthly else "unlimited"
        last_used = key.last_used_at.strftime('%Y-%m-%d %H:%M') if key.last_used_at else "never"

        print(f"{key.key_prefix:<12} {key.name[:18]:<20} {str(key.enabled):<8} "
              f"{hourly:<10} {daily:<10} {monthly:<10} {last_used}")
    print("")


async def cmd_show(args):
    """Show details for an API key."""
    require_master_key()
    manager = await get_manager()

    # Find key by prefix
    key_hash = await manager.find_key_by_prefix(args.key_id)
    if not key_hash:
        # Try as hash directly
        record = await manager.get_key(args.key_id)
        if record:
            key_hash = args.key_id
        else:
            print(f"Error: Key not found: {args.key_id}")
            sys.exit(1)
    else:
        record = await manager.get_key(key_hash)

    if not record:
        print(f"Error: Key not found: {args.key_id}")
        sys.exit(1)

    # Get current usage
    usage = await manager.get_usage(key_hash)

    print("")
    print(f"API Key: {record.key_prefix}")
    print(f"  Name:       {record.name}")
    print(f"  Enabled:    {record.enabled}")
    print(f"  Created:    {record.created_at.strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"  Last Used:  {record.last_used_at.strftime('%Y-%m-%d %H:%M:%S UTC') if record.last_used_at else 'never'}")
    print(f"  Total Uses: {record.usage_count}")
    print("")
    print("  Rate Limits:")
    print(f"    Hourly:  {record.rate_limits.hourly if record.rate_limits.hourly else 'unlimited'} (used: {usage['hourly']})")
    print(f"    Daily:   {record.rate_limits.daily if record.rate_limits.daily else 'unlimited'} (used: {usage['daily']})")
    print(f"    Monthly: {record.rate_limits.monthly if record.rate_limits.monthly else 'unlimited'} (used: {usage['monthly']})")
    print("")
    print(f"  Hash: {key_hash}")
    print("")


async def cmd_update(args):
    """Update an API key."""
    require_master_key()
    manager = await get_manager()

    # Find key by prefix
    key_hash = await manager.find_key_by_prefix(args.key_id)
    if not key_hash:
        record = await manager.get_key(args.key_id)
        if record:
            key_hash = args.key_id
        else:
            print(f"Error: Key not found: {args.key_id}")
            sys.exit(1)

    # Get current record
    record = await manager.get_key(key_hash)
    if not record:
        print(f"Error: Key not found: {args.key_id}")
        sys.exit(1)

    # Determine updates
    enabled = None
    if args.enable:
        enabled = True
    elif args.disable:
        enabled = False

    rate_limits = None
    if args.hourly is not None or args.daily is not None or args.monthly is not None:
        rate_limits = RateLimits(
            hourly=args.hourly if args.hourly is not None else record.rate_limits.hourly,
            daily=args.daily if args.daily is not None else record.rate_limits.daily,
            monthly=args.monthly if args.monthly is not None else record.rate_limits.monthly
        )

    name = args.name if args.name else None

    if enabled is None and rate_limits is None and name is None:
        print("No updates specified. Use --enable, --disable, --hourly, --daily, --monthly, or --name")
        sys.exit(1)

    success = await manager.update_key(
        key_hash=key_hash,
        enabled=enabled,
        rate_limits=rate_limits,
        name=name
    )

    if success:
        print(f"Key updated successfully: {record.key_prefix}")
        if enabled is not None:
            print(f"  Enabled: {enabled}")
        if rate_limits:
            print(f"  Hourly:  {rate_limits.hourly if rate_limits.hourly else 'unlimited'}")
            print(f"  Daily:   {rate_limits.daily if rate_limits.daily else 'unlimited'}")
            print(f"  Monthly: {rate_limits.monthly if rate_limits.monthly else 'unlimited'}")
        if name:
            print(f"  Name: {name}")
    else:
        print(f"Error: Failed to update key")
        sys.exit(1)


async def cmd_revoke(args):
    """Revoke an API key."""
    require_master_key()
    manager = await get_manager()

    # Find key by prefix
    key_hash = await manager.find_key_by_prefix(args.key_id)
    if not key_hash:
        record = await manager.get_key(args.key_id)
        if record:
            key_hash = args.key_id
        else:
            print(f"Error: Key not found: {args.key_id}")
            sys.exit(1)

    # Confirm revocation
    if not args.force:
        record = await manager.get_key(key_hash)
        if record:
            print(f"About to revoke API key: {record.key_prefix} ({record.name})")
            confirm = input("Are you sure? (yes/no): ")
            if confirm.lower() != "yes":
                print("Revocation cancelled.")
                sys.exit(0)

    success = await manager.revoke_key(key_hash)
    if success:
        print(f"Key revoked successfully: {args.key_id}")
    else:
        print(f"Error: Failed to revoke key")
        sys.exit(1)


async def cmd_usage(args):
    """Show usage for an API key."""
    require_master_key()
    manager = await get_manager()

    # Find key by prefix
    key_hash = await manager.find_key_by_prefix(args.key_id)
    if not key_hash:
        record = await manager.get_key(args.key_id)
        if record:
            key_hash = args.key_id
        else:
            print(f"Error: Key not found: {args.key_id}")
            sys.exit(1)
    else:
        record = await manager.get_key(key_hash)

    if not record:
        print(f"Error: Key not found: {args.key_id}")
        sys.exit(1)

    # Get current usage and rate limit status
    usage = await manager.get_usage(key_hash)
    statuses = await manager.get_rate_limit_status(key_hash)

    print("")
    print(f"Usage for: {record.key_prefix} ({record.name})")
    print("")
    print(f"{'Period':<10} {'Used':<10} {'Limit':<12} {'Remaining':<12} {'Resets At'}")
    print("-" * 60)

    for status in statuses:
        limit_str = str(status.limit) if status.limit else "unlimited"
        remaining_str = str(status.remaining) if status.remaining is not None else "unlimited"
        resets_at = status.resets_at.strftime('%Y-%m-%d %H:%M')

        exceeded_marker = " [EXCEEDED]" if status.is_exceeded else ""
        print(f"{status.period:<10} {status.used:<10} {limit_str:<12} {remaining_str:<12} {resets_at}{exceeded_marker}")

    print("")
    print(f"Total lifetime uses: {record.usage_count}")
    print("")


def main():
    parser = argparse.ArgumentParser(
        description="API Key Management CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s create --name "My App" --hourly 1000 --daily 10000
  %(prog)s list
  %(prog)s show sk-abc12345
  %(prog)s usage sk-abc12345
  %(prog)s update sk-abc12345 --disable
  %(prog)s revoke sk-abc12345
"""
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # create command
    create_parser = subparsers.add_parser("create", help="Create a new API key")
    create_parser.add_argument("--name", required=True, help="Name for the key")
    create_parser.add_argument("--hourly", type=int, help="Hourly rate limit (omit for unlimited)")
    create_parser.add_argument("--daily", type=int, help="Daily rate limit (omit for unlimited)")
    create_parser.add_argument("--monthly", type=int, help="Monthly rate limit (omit for unlimited)")

    # list command
    subparsers.add_parser("list", help="List all API keys")

    # show command
    show_parser = subparsers.add_parser("show", help="Show details for an API key")
    show_parser.add_argument("key_id", help="Key prefix or hash")

    # revoke command
    revoke_parser = subparsers.add_parser("revoke", help="Revoke an API key")
    revoke_parser.add_argument("key_id", help="Key prefix or hash")
    revoke_parser.add_argument("-f", "--force", action="store_true", help="Skip confirmation")

    # update command
    update_parser = subparsers.add_parser("update", help="Update an API key")
    update_parser.add_argument("key_id", help="Key prefix or hash")
    update_parser.add_argument("--enable", action="store_true", help="Enable the key")
    update_parser.add_argument("--disable", action="store_true", help="Disable the key")
    update_parser.add_argument("--hourly", type=int, help="New hourly rate limit (0 for unlimited)")
    update_parser.add_argument("--daily", type=int, help="New daily rate limit (0 for unlimited)")
    update_parser.add_argument("--monthly", type=int, help="New monthly rate limit (0 for unlimited)")
    update_parser.add_argument("--name", help="New name for the key")

    # usage command
    usage_parser = subparsers.add_parser("usage", help="Show usage for an API key")
    usage_parser.add_argument("key_id", help="Key prefix or hash")

    args = parser.parse_args()

    # Dispatch to command handler
    handlers = {
        "create": cmd_create,
        "list": cmd_list,
        "show": cmd_show,
        "revoke": cmd_revoke,
        "update": cmd_update,
        "usage": cmd_usage,
    }

    try:
        asyncio.run(handlers[args.command](args))
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(1)


if __name__ == "__main__":
    main()
