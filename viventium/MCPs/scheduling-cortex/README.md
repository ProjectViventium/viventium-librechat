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

## Test

The package carries a locked test-only dependency group so its QA commands are reproducible without
adding browser/API test libraries to the production runtime:

```bash
uv run --group test pytest -q
```

## Environment

- `SCHEDULING_DB_PATH` (default: `~/Library/Application Support/Viventium/state/runtime/isolated/scheduling/schedules.db`)
- `SCHEDULER_POLL_INTERVAL_S` (default: `30`)
- `SCHEDULER_MISFIRE_GRACE_S` (default: `900`)
- `SCHEDULER_RETRY_DELAY_S` (default: `300`)
- `SCHEDULING_OCCURRENCE_CLAIM_SECONDS` (default: `300`, bounded to `30`–`900`; durable
  claim lease used to fence one GlassHive workspace occurrence across scheduler restarts)
- `SCHEDULER_LOG_LEVEL` (default: `INFO`)
- `SCHEDULER_LIBRECHAT_URL` (optional explicit override; otherwise
  `VIVENTIUM_LIBRECHAT_ORIGIN`, then the legacy development fallback `http://localhost:3080`)
- `SCHEDULER_LIBRECHAT_SECRET` (required for LibreChat dispatch)
- `VIVENTIUM_SCHEDULER_SECRET` (required signing key for authenticated recurrence control and fresh
  short-lived GlassHive workspace-run assertions; the raw value is not sent on workspace-run dispatch)
- `SCHEDULER_CAPABILITY_HTTP_TIMEOUT_S` (default: `15`; fire-time GlassHive capability broker
  authorization/revocation timeout)
- `SCHEDULER_CAPABILITY_HTTP_ATTEMPTS` (default: `2`, maximum: `3`; transient fire-time grant
  request attempts using one stable scheduled-run scope)
- `SCHEDULER_TELEGRAM_SECRET` (required for Telegram dispatch)
- `SCHEDULING_GLASSHIVE_CALLBACK_SECRET` (required for Workbench `glasshive_host` callback
  updates)
- `SCHEDULING_GLASSHIVE_CALLBACK_URL` (optional explicit callback URL)
- `SCHEDULING_MCP_URL` or `VIVENTIUM_SCHEDULING_MCP_PORT` / `SCHEDULING_MCP_PORT`
  (used to derive the default Workbench GlassHive callback URL)

## Notes

- The scheduler is designed to run persistently in HTTP mode.
- `/health` is intentionally unauthenticated for local launcher probes, but it must include a
  public-safe runtime identity. The launcher matches `db_path_sha256` against its expected
  `SCHEDULING_DB_PATH`; raw DB paths, App Support paths, schedule content, tokens, and operator
  names are never returned.
- Tools are called by the main Viventium agent to create/update schedules.
- LibreChat injects `X-Viventium-User-Id` and `X-Viventium-Agent-Id` headers for auto scoping.
- Scheduled tasks carry `executor`. Existing user-level schedules normally use
  `executor="viventium_agent"`, which reloads the persisted Main Agent route and fallback from
  Agent Builder at run time without a scheduler-owned provider/model override. Prompt Workbench
  private scheduled prompts use
  `executor="glasshive_host"` and `channel="workbench"` so dispatch queues GlassHive host work
  directly instead of asking the main Viventium agent to call GlassHive.
- Viventium-owned GlassHive workspace recurrence uses the internal-only
  `executor="glasshive_workspace"`. Authenticated GlassHive recurrence CRUD writes only the Cortex
  definition store; a fire mints a 90-second assertion bound to the exact occurrence, owner,
  workspace, task, and instruction, then GlassHive revalidates workspace ownership and reserves one
  stable one-shot run. This executor is not accepted by public schedule-create/update tools.
- The workspace executor accepts the same validated structural recurrence contract as GlassHive:
  one-shot, elapsed interval, daily wall clock, cron, and RFC 5545 RRULE definitions; optional end
  boundaries; deterministic bounded jitter; queue/skip overlap; skip/coalesce/bounded catch-up; and
  earliest/latest DST fold selection. Jitter first materializes one stable nominal occurrence and
  delays only its dispatch, so short intervals cannot continually replace a waiting occurrence.
- Workspace occurrences use deterministic ids plus durable `claimed_at`, `claim_expires_at`, and
  `attempt_count` fields. An unexpired claim defers a second dispatcher, while an expired claim is
  recovered against the same id and increments the attempt count. No credential or capability
  token is stored in the definition, occurrence, task metadata, or restart-recovery state.
- Prompt Workbench reads existing user-level `scheduled_tasks` rows as prompt objects by user id.
  Workbench-private prompt definitions are stored separately and de-duplicated by `task_id`.
- A `glasshive_host` run asks LibreChat for a fresh user/tenant/schedule/run-scoped capability
  grant immediately before worker creation. The schedule and run ledgers store only the non-secret
  grant reference; provider credentials and broker grant tokens are not stored there.
- Structured `workbench_scheduled_prompt.required_capability_servers` entries fail closed when
  current review policy or OAuth consent is missing. Legacy schedules without that declaration
  continue in a clearly degraded, no-connected-capability mode when broker authorization is not
  configured.
- Terminal GlassHive callbacks revoke the deterministic grant. Duplicate callbacks are idempotent;
  a revocation infrastructure failure returns `503` so the callback can retry before the terminal
  result is accepted.
