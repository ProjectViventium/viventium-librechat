#!/usr/bin/env python3
"""
Metrics CLI - Interactive dashboard for execution metrics.

Usage:
  python scripts/metrics_cli.py              # Interactive mode
  python scripts/metrics_cli.py summary      # Quick summary
  python scripts/metrics_cli.py watch        # Auto-refresh dashboard

Commands:
  (no args)    Interactive menu
  summary      Show metrics summary
  languages    Per-language breakdown
  api-keys     Per-API-key usage
  pool         Container pool stats
  watch        Auto-refresh dashboard
"""

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional, List

# Add src to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# Load .env file if it exists
from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env")

from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.layout import Layout
from rich.live import Live
from rich.text import Text
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.prompt import Prompt, IntPrompt
from rich import box

from src.core.pool import redis_pool
from src.services.detailed_metrics import DetailedMetricsService

console = Console()


async def get_metrics_service() -> DetailedMetricsService:
    """Get metrics service instance."""
    redis_client = redis_pool.get_client()
    try:
        await redis_client.ping()
    except Exception as e:
        console.print(f"[red]Error:[/red] Cannot connect to Redis: {e}")
        console.print("\nEnsure Redis is running and REDIS_URL/REDIS_HOST is configured correctly.")
        sys.exit(1)
    return DetailedMetricsService(redis_client)


def format_duration(ms: float) -> str:
    """Format milliseconds to human readable."""
    if ms < 1000:
        return f"{ms:.0f}ms"
    elif ms < 60000:
        return f"{ms/1000:.2f}s"
    else:
        return f"{ms/60000:.1f}m"


def format_rate(rate: float, good_threshold: float = 80, bad_threshold: float = 50) -> Text:
    """Format percentage with color coding."""
    text = f"{rate:.1f}%"
    if rate >= good_threshold:
        return Text(text, style="green")
    elif rate >= bad_threshold:
        return Text(text, style="yellow")
    else:
        return Text(text, style="red")


def format_error_rate(rate: float) -> Text:
    """Format error rate (lower is better)."""
    text = f"{rate:.1f}%"
    if rate <= 5:
        return Text(text, style="green")
    elif rate <= 20:
        return Text(text, style="yellow")
    else:
        return Text(text, style="red")


async def build_summary_panel(service: DetailedMetricsService) -> Panel:
    """Build summary panel."""
    summary = await service.get_summary()

    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="white")

    table.add_row("Total Executions", str(summary.total_executions))
    table.add_row("Today (24h)", str(summary.total_executions_today))
    table.add_row("This Hour", str(summary.total_executions_hour))
    table.add_row("", "")
    table.add_row("Success Rate", format_rate(summary.success_rate))
    table.add_row("Avg Exec Time", format_duration(summary.avg_execution_time_ms))
    table.add_row("Active API Keys", str(summary.active_api_keys))
    table.add_row("Pool Hit Rate", format_rate(summary.pool_hit_rate))

    return Panel(table, title="[bold]Summary[/bold] (last 24h)", border_style="blue")


async def build_languages_table(service: DetailedMetricsService, hours: int = 24) -> Table:
    """Build languages table."""
    language_stats = await service.get_language_stats(hours=hours)

    table = Table(title=f"Language Metrics (last {hours}h)", box=box.ROUNDED)
    table.add_column("Language", style="cyan", justify="center")
    table.add_column("Executions", justify="right")
    table.add_column("Success", justify="right", style="green")
    table.add_column("Failures", justify="right", style="red")
    table.add_column("Avg Time", justify="right")
    table.add_column("Error Rate", justify="right")

    # Sort by execution count
    sorted_languages = sorted(
        language_stats.values(),
        key=lambda x: x.execution_count,
        reverse=True
    )

    for lang in sorted_languages:
        table.add_row(
            lang.language.upper(),
            str(lang.execution_count),
            str(lang.success_count),
            str(lang.failure_count),
            format_duration(lang.avg_execution_time_ms),
            format_error_rate(lang.error_rate)
        )

    if sorted_languages:
        total_exec = sum(l.execution_count for l in sorted_languages)
        total_success = sum(l.success_count for l in sorted_languages)
        total_fail = sum(l.failure_count for l in sorted_languages)
        overall_rate = (total_fail / total_exec * 100) if total_exec > 0 else 0

        table.add_row("", "", "", "", "", "", style="dim")
        table.add_row(
            "[bold]TOTAL[/bold]",
            f"[bold]{total_exec}[/bold]",
            f"[bold]{total_success}[/bold]",
            f"[bold]{total_fail}[/bold]",
            "",
            format_error_rate(overall_rate)
        )

    return table


async def build_api_keys_table(service: DetailedMetricsService, hours: int = 24) -> Table:
    """Build API keys usage table."""
    # Get all API key stats by scanning Redis
    redis = service.redis

    # Find all API key metric keys
    key_stats = {}
    cursor = 0
    while True:
        cursor, keys = await redis.scan(cursor, match="metrics:api_key:*", count=100)
        if keys:
            for key in keys:
                key_str = key.decode() if isinstance(key, bytes) else key
                # Extract API key hash prefix from key
                # Format: metrics:api_key:{hash}:hour:{hour_key}
                parts = key_str.split(":")
                if len(parts) >= 3:
                    api_hash = parts[2]
                    if api_hash not in key_stats:
                        key_stats[api_hash] = await service.get_api_key_stats(api_hash, hours=hours)
        if cursor == 0:
            break

    table = Table(title=f"API Key Usage (last {hours}h)", box=box.ROUNDED)
    table.add_column("Key Hash", style="cyan")
    table.add_column("Executions", justify="right")
    table.add_column("Success Rate", justify="right")
    table.add_column("Avg Time", justify="right")
    table.add_column("File Ops", justify="right", style="dim")

    if not key_stats:
        table.add_row("[dim]No API key usage data found[/dim]", "", "", "", "")
    else:
        # Sort by execution count
        for key_hash, stats in sorted(key_stats.items(), key=lambda x: x[1].execution_count, reverse=True):
            avg_time = (stats.total_execution_time_ms / stats.execution_count) if stats.execution_count > 0 else 0

            table.add_row(
                f"{key_hash}...",
                str(stats.execution_count),
                format_rate(stats.success_rate),
                format_duration(avg_time),
                str(stats.file_operations)
            )

    return table


async def build_pool_panel(service: DetailedMetricsService) -> Panel:
    """Build pool stats panel."""
    pool_stats = await service.get_pool_stats()

    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="white")

    table.add_row("Total Acquisitions", str(pool_stats.total_acquisitions))
    table.add_row("Pool Hits", Text(str(pool_stats.pool_hits), style="green"))
    table.add_row("Pool Misses", Text(str(pool_stats.pool_misses), style="yellow"))
    table.add_row("Hit Rate", format_rate(pool_stats.hit_rate))
    table.add_row("Avg Acquire Time", format_duration(pool_stats.avg_acquire_time_ms))
    table.add_row("Exhaustion Events", Text(str(pool_stats.exhaustion_events),
                                            style="red" if pool_stats.exhaustion_events > 0 else "green"))

    return Panel(table, title="[bold]Container Pool[/bold]", border_style="magenta")


async def build_hourly_table(service: DetailedMetricsService, hours: int = 12) -> Table:
    """Build hourly breakdown table."""
    table = Table(title=f"Hourly Breakdown (last {hours}h)", box=box.ROUNDED)
    table.add_column("Hour", style="dim")
    table.add_column("Executions", justify="right")
    table.add_column("Success", justify="right", style="green")
    table.add_column("Failures", justify="right", style="red")
    table.add_column("Timeouts", justify="right", style="yellow")
    table.add_column("Avg Time", justify="right")

    now = datetime.now(timezone.utc)

    for i in range(hours):
        hour = now - timedelta(hours=i)
        metrics = await service.get_hourly_metrics(hour)

        if metrics:
            table.add_row(
                hour.strftime('%m-%d %H:00'),
                str(metrics.execution_count),
                str(metrics.success_count),
                str(metrics.failure_count),
                str(metrics.timeout_count),
                format_duration(metrics.avg_execution_time_ms)
            )
        else:
            table.add_row(
                hour.strftime('%m-%d %H:00'),
                "[dim]0[/dim]",
                "[dim]0[/dim]",
                "[dim]0[/dim]",
                "[dim]0[/dim]",
                "[dim]-[/dim]"
            )

    return table


async def cmd_summary(args):
    """Show summary."""
    service = await get_metrics_service()
    panel = await build_summary_panel(service)
    console.print()
    console.print(panel)
    console.print()


async def cmd_languages(args):
    """Show per-language metrics."""
    service = await get_metrics_service()
    table = await build_languages_table(service, args.hours)
    console.print()
    console.print(table)
    console.print()


async def cmd_api_keys(args):
    """Show per-API-key metrics."""
    service = await get_metrics_service()
    table = await build_api_keys_table(service, args.hours)
    console.print()
    console.print(table)
    console.print()


async def cmd_pool(args):
    """Show pool stats."""
    service = await get_metrics_service()
    panel = await build_pool_panel(service)
    console.print()
    console.print(panel)
    console.print()


async def cmd_hourly(args):
    """Show hourly breakdown."""
    service = await get_metrics_service()
    table = await build_hourly_table(service, args.hours)
    console.print()
    console.print(table)
    console.print()


async def cmd_watch(args):
    """Auto-refresh dashboard."""
    service = await get_metrics_service()

    console.print("\n[bold cyan]Live Metrics Dashboard[/bold cyan]")
    console.print("[dim]Press Ctrl+C to exit[/dim]\n")

    try:
        while True:
            console.clear()
            console.print(Panel.fit(
                "[bold cyan]Code Interpreter Metrics[/bold cyan]\n"
                f"[dim]Last updated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}[/dim]",
                border_style="cyan"
            ))
            console.print()

            # Summary and Pool side by side
            summary_panel = await build_summary_panel(service)
            pool_panel = await build_pool_panel(service)
            console.print(summary_panel)
            console.print()
            console.print(pool_panel)
            console.print()

            # Language breakdown
            lang_table = await build_languages_table(service, 24)
            console.print(lang_table)
            console.print()

            console.print(f"[dim]Refreshing in {args.interval}s... (Ctrl+C to exit)[/dim]")
            await asyncio.sleep(args.interval)

    except KeyboardInterrupt:
        console.print("\n[yellow]Dashboard stopped.[/yellow]")


async def cmd_interactive(args):
    """Interactive menu."""
    service = await get_metrics_service()

    while True:
        console.clear()
        console.print(Panel.fit(
            "[bold cyan]Code Interpreter Metrics[/bold cyan]\n"
            "[dim]Interactive Dashboard[/dim]",
            border_style="cyan"
        ))
        console.print()

        # Show quick summary
        summary = await service.get_summary()
        console.print(f"  [cyan]Executions today:[/cyan] {summary.total_executions_today}  "
                     f"[cyan]Success rate:[/cyan] {summary.success_rate:.1f}%  "
                     f"[cyan]Avg time:[/cyan] {format_duration(summary.avg_execution_time_ms)}")
        console.print()

        console.print("[bold]Commands:[/bold]")
        console.print("  [cyan]1[/cyan]  Summary")
        console.print("  [cyan]2[/cyan]  Language breakdown")
        console.print("  [cyan]3[/cyan]  API key usage")
        console.print("  [cyan]4[/cyan]  Container pool stats")
        console.print("  [cyan]5[/cyan]  Hourly breakdown")
        console.print("  [cyan]6[/cyan]  Live dashboard (auto-refresh)")
        console.print("  [cyan]q[/cyan]  Quit")
        console.print()

        choice = Prompt.ask("Select", choices=["1", "2", "3", "4", "5", "6", "q"], default="1")

        if choice == "q":
            console.print("[yellow]Goodbye![/yellow]")
            break
        elif choice == "1":
            panel = await build_summary_panel(service)
            console.print()
            console.print(panel)
        elif choice == "2":
            table = await build_languages_table(service, 24)
            console.print()
            console.print(table)
        elif choice == "3":
            table = await build_api_keys_table(service, 24)
            console.print()
            console.print(table)
        elif choice == "4":
            panel = await build_pool_panel(service)
            console.print()
            console.print(panel)
        elif choice == "5":
            table = await build_hourly_table(service, 12)
            console.print()
            console.print(table)
        elif choice == "6":
            args.interval = 5
            await cmd_watch(args)
            continue

        console.print()
        Prompt.ask("[dim]Press Enter to continue[/dim]", default="")


def main():
    parser = argparse.ArgumentParser(
        description="Metrics CLI - Interactive execution metrics dashboard",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    subparsers = parser.add_subparsers(dest="command")

    # summary
    subparsers.add_parser("summary", help="Show metrics summary")

    # languages
    lang_p = subparsers.add_parser("languages", help="Per-language metrics")
    lang_p.add_argument("--hours", type=int, default=24)

    # api-keys
    keys_p = subparsers.add_parser("api-keys", help="Per-API-key usage")
    keys_p.add_argument("--hours", type=int, default=24)

    # pool
    subparsers.add_parser("pool", help="Container pool stats")

    # hourly
    hourly_p = subparsers.add_parser("hourly", help="Hourly breakdown")
    hourly_p.add_argument("--hours", type=int, default=12)

    # watch
    watch_p = subparsers.add_parser("watch", help="Auto-refresh dashboard")
    watch_p.add_argument("--interval", type=int, default=5, help="Refresh interval in seconds")

    args = parser.parse_args()

    handlers = {
        "summary": cmd_summary,
        "languages": cmd_languages,
        "api-keys": cmd_api_keys,
        "pool": cmd_pool,
        "hourly": cmd_hourly,
        "watch": cmd_watch,
        None: cmd_interactive,
    }

    try:
        asyncio.run(handlers[args.command](args))
    except KeyboardInterrupt:
        console.print("\n[yellow]Cancelled.[/yellow]")
        sys.exit(0)


if __name__ == "__main__":
    main()
