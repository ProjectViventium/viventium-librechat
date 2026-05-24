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

- `SCHEDULING_DB_PATH` (default: `~/Library/Application Support/Viventium/state/runtime/isolated/scheduling/schedules.db`)
- `SCHEDULER_POLL_INTERVAL_S` (default: `30`)
- `SCHEDULER_MISFIRE_GRACE_S` (default: `900`)
- `SCHEDULER_RETRY_DELAY_S` (default: `300`)
- `SCHEDULER_LOG_LEVEL` (default: `INFO`)
- `SCHEDULER_LIBRECHAT_URL` (default: `http://localhost:3080`)
- `SCHEDULER_LIBRECHAT_SECRET` (required for LibreChat dispatch)
- `SCHEDULER_TELEGRAM_SECRET` (required for Telegram dispatch)
- `SCHEDULING_GLASSHIVE_CALLBACK_SECRET` (required for Workbench `glasshive_host` callback
  updates)
- `SCHEDULING_GLASSHIVE_CALLBACK_URL` (optional explicit callback URL)
- `SCHEDULING_MCP_URL` or `VIVENTIUM_SCHEDULING_MCP_PORT` / `SCHEDULING_MCP_PORT`
  (used to derive the default Workbench GlassHive callback URL)

## Notes

- The scheduler is designed to run persistently in HTTP mode.
- Tools are called by the main Viventium agent to create/update schedules.
- LibreChat injects `X-Viventium-User-Id` and `X-Viventium-Agent-Id` headers for auto scoping.
- Scheduled tasks carry `executor`. Existing user-level schedules normally use
  `executor="viventium_agent"`; Prompt Workbench private scheduled prompts use
  `executor="glasshive_host"` and `channel="workbench"` so dispatch queues GlassHive host work
  directly instead of asking the main Viventium agent to call GlassHive.
- Prompt Workbench reads existing user-level `scheduled_tasks` rows as prompt objects by user id.
  Workbench-private prompt definitions are stored separately and de-duplicated by `task_id`.
