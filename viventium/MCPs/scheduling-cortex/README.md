<!-- VIVENTIUM START
Purpose: Viventium addition in private LibreChat fork (new file).
Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
VIVENTIUM END -->

# Scheduling Cortex MCP

Lightweight MCP server for Viventium scheduling (Selective Consciousness Continuity).

## Run (streamable-http)

```bash
python -m scheduling_cortex.server --transport streamable-http --port 7010
```

## Run (stdio)

```bash
python -m scheduling_cortex.server --transport stdio
```

## Environment

- `SCHEDULING_DB_PATH` (default: `~/.viventium/scheduling/schedules.db`)
- `SCHEDULER_POLL_INTERVAL_S` (default: `30`)
- `SCHEDULER_MISFIRE_GRACE_S` (default: `900`)
- `SCHEDULER_RETRY_DELAY_S` (default: `300`)
- `SCHEDULER_LOG_LEVEL` (default: `INFO`)
- `SCHEDULER_LIBRECHAT_URL` (default: `http://localhost:3080`)
- `SCHEDULER_LIBRECHAT_SECRET` (required for LibreChat dispatch)
- `SCHEDULER_TELEGRAM_SECRET` (required for Telegram dispatch)

## Notes

- The scheduler is designed to run persistently in HTTP mode.
- Tools are called by the main Viventium agent to create/update schedules.
- LibreChat injects `X-Viventium-User-Id` and `X-Viventium-Agent-Id` headers for auto scoping.
