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

The consumer tests need the runtime's shared scheduler contract on `PYTHONPATH`. A full Viventium
checkout supplies `viventium_v0_4/shared`. The GlassHive end-to-end cases additionally need
`GlassHive/runtime_phase1/src`; Workbench projection and compiler parity cases need the Core repo
root and `viventium_v0_4/prompt-workbench/backend`. Add those source directories to `PYTHONPATH`
when running the cross-repository checks. Missing optional integration owners produce explicit
skips for those cases; the scheduler consumer cases still run. A skip does not prove integration.

### Known source baseline gap

The 2026-09-08 publication review ran `test_glasshive_workspace_schedules.py` and
`test_scheduled_failure_provenance.py` with the shared runtime contract and without optional
GlassHive/Core/Workbench owners: **46 passed, 15 failed, 4 explicitly skipped**. The skips are
only the two GlassHive end-to-end cases and two Workbench projection cases described above.
With their owners present, both Workbench cases pass; both GlassHive end-to-end cases execute
and fail on the same missing occurrence-claim method below.

The 15 failures below remain active. Workspace dispatch calls `claim_scheduled_prompt_run`, and
owner deactivation calls `deactivate_glasshive_workspace_tasks_for_owner`, but `ScheduleStorage`
does not implement those methods. Both callsites and missing methods also exist in public base
`ae36f2ec680f9ae60903fa71aad2d94fece02c55`. This is an existing workspace-recurrence gap, not a
claim that other scheduler paths fail. Source publication does not certify this journey.

All failing cases are in `test_glasshive_workspace_schedules.py`:

- `test_bounded_catch_up_dispatches_only_the_bounded_latest_occurrences`
- `test_coalesce_and_skip_catch_up_record_truthful_occurrences` (`coalesce` subcase)
- `test_disable_owner_deactivates_only_glasshive_workspace_definitions`
- `test_expired_occurrence_claim_is_recovered_idempotently_after_restart`
- `test_jitter_is_bounded_deterministic_and_delays_dispatch_without_changing_identity`
- `test_nonretryable_workspace_failure_pauses_action_required_without_retry`
- `test_occurrence_claim_blocks_duplicate_dispatch_and_reports_its_lease`
- `test_overlap_policy_skips_or_queues_without_losing_the_occurrence` (`queue` subcase)
- `test_private_detail_failure_is_claimed_and_stops_after_bounded_budget`
- `test_real_scheduler_tick_queues_exactly_one_glasshive_workspace_run`
- `test_retryable_workspace_failures_stop_after_bounded_budget`
- `test_rfc5545_end_boundary_dispatches_the_final_occurrence_then_deactivates`
- `test_workspace_fire_delegates_user_revalidation_to_glasshive_without_credentials`
- `test_workspace_fire_records_glasshive_capability_reconnection_failure`
- `test_workspace_occurrences_delegate_just_in_time_capabilities_without_persisting_bundles`

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
