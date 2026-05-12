# VIVENTIUM START
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# VIVENTIUM END

from __future__ import annotations

import argparse
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .models import (
    AVAILABLE_CHANNELS,
    ChannelValue,
    CreateScheduleArgs,
    UpdateScheduleArgs,
    DeleteScheduleArgs,
    GetScheduleArgs,
    ListScheduleArgs,
    SearchScheduleArgs,
    PreviewScheduleArgs,
    LastDeliveryArgs,
    ScheduleTask,
)
from .scheduler import SchedulerEngine, compute_next_run, compute_next_runs
from .storage import ScheduleStorage, StorageConfig
from .utils import to_utc_iso

DEFAULT_PORT = 7010
HEADER_USER_ID = "x-viventium-user-id"
HEADER_AGENT_ID = "x-viventium-agent-id"

logger = logging.getLogger(__name__)

# === VIVENTIUM START ===
# Feature: Model-owned Scheduling Cortex instruction surface.
# Purpose:
# - Move scheduling cognition into the owning MCP surface before main prompt compaction.
# - Keep the runtime deterministic: no prompt-text or schedule-name branching.
SCHEDULING_CORTEX_INSTRUCTIONS = """
Scheduling Cortex owns reminders, recurring jobs, and schedule management for Viventium.

What it does:
- Create, update, delete, list, search, inspect, and preview schedules.
- Run schedules later through the configured Viventium agent and channels.
- Track last delivery state, including sent, suppressed, failed, and generated text summaries.

When to use:
- The user asks to remind, follow up later, check back, keep watching, run a recurring task, or change an existing schedule.
- The user asks what reminders/jobs exist, when one will run, or what happened on the last run.
- A starter morning briefing exists and should be changed. Its stable template_id is
  morning_briefing_default_v1.

When not to use:
- Do not use for immediate live work that should happen now.
- Do not create duplicate schedules when an existing task can be found and updated.
- Do not branch on prompt text, schedule name, user identity, or template wording; use declared structured fields, internal task references, filters, and tool evidence.

Inputs and identity:
- user_id and agent_id are injected from request headers when omitted.
- Use the user's timezone in schedule payloads when known; otherwise state uncertainty and use an explicit timezone.
- Channels are "telegram", "librechat", or both.

Output and delivery:
- Tools return structured task or summary objects.
- list/search are summary-safe: they return user-facing schedule state plus an internal task reference for follow-up tool calls. They must not return raw prompt text, metadata, user IDs, agent IDs, conversation policy, creator/updater fields, or delivery payloads.
- Use schedule_get or schedule_last_delivery only when full private verification or diagnostics are needed.
- Scheduled runs may intentionally produce {NTA}; silent no-response delivery is valid and should not be surfaced as a system announcement.
- Delivery can be delayed; do not promise completion until a run or last_delivery record says so.
- User-facing replies must translate tool output into plain outcomes. Do not expose task IDs, raw prompt text, metadata keys/flags, tool function names, channel errors, delivery internals, or server/tool plumbing unless the user explicitly asks for diagnostics.
- When a full-detail read shows internal prompt text or metadata solely to verify state, use it as private evidence. The user-facing answer should say what is already configured or what changed, without quoting stored prompt text or naming storage fields.

Duplicate prevention and idempotency:
- For starter morning briefing, use the summary's starter_morning_briefing flag, template_id
  morning_briefing_default_v1, or a private full-detail read to identify the existing task, then
  update that internal task reference; do not create another starter task.
- For user-authored changes, prefer updating a matching existing task over creating a duplicate when the user's intent is to modify an existing reminder/job.
""".strip()


def _tool_description(
    *,
    what: str,
    use_when: str,
    avoid_when: str,
    inputs: str,
    returns: str,
    failure_modes: str,
    idempotency: str,
    delayed_callback: str,
) -> str:
    return (
        f"What it does: {what} "
        f"When to use: {use_when} "
        f"When not to use: {avoid_when} "
        f"Inputs: {inputs} "
        f"Returns: {returns} "
        f"Failure modes: {failure_modes} "
        f"Idempotency and duplicate prevention: {idempotency} "
        f"Delayed callback behavior: {delayed_callback}"
    )
# === VIVENTIUM END ===


def _normalize_headers(raw_headers: object) -> Dict[str, str]:
    if raw_headers is None:
        return {}
    if hasattr(raw_headers, "items"):
        items = raw_headers.items()
    elif isinstance(raw_headers, list):
        items = raw_headers
    else:
        return {}
    return {str(key).lower(): str(value) for key, value in items}


def _get_request_headers() -> Dict[str, str]:
    try:
        return _normalize_headers(get_http_headers())
    except Exception:
        return {}


def _sanitize_header_value(value: Optional[str]) -> str:
    if not value:
        return ""
    stripped = value.strip()
    if stripped.startswith("{{") and stripped.endswith("}}"):
        return ""
    if stripped.startswith("${") and stripped.endswith("}"):
        return ""
    return stripped


def _resolve_user_id(explicit_user_id: Optional[str]) -> str:
    headers = _get_request_headers()
    user_id = _sanitize_header_value(headers.get(HEADER_USER_ID))
    if not user_id:
        if explicit_user_id:
            return explicit_user_id
        raise ValueError("user_id is required (missing from args and request headers)")
    return user_id


def _resolve_agent_id(explicit_agent_id: Optional[str], fallback: Optional[str] = None) -> str:
    if explicit_agent_id:
        return explicit_agent_id
    headers = _get_request_headers()
    agent_id = _sanitize_header_value(headers.get(HEADER_AGENT_ID))
    if not agent_id:
        agent_id = os.getenv("VIVENTIUM_MAIN_AGENT_ID") or ""
    if not agent_id and fallback:
        return fallback
    if not agent_id:
        raise ValueError("agent_id is required (missing from args and request headers)")
    return agent_id


def _resolve_request_agent_id(fallback: Optional[str] = None) -> str:
    headers = _get_request_headers()
    agent_id = _sanitize_header_value(headers.get(HEADER_AGENT_ID))
    if not agent_id:
        agent_id = os.getenv("VIVENTIUM_MAIN_AGENT_ID") or ""
    if not agent_id and fallback:
        return fallback
    if not agent_id:
        raise ValueError("request agent_id is required (missing from headers and VIVENTIUM_MAIN_AGENT_ID)")
    return agent_id


def _resolve_actor_id(explicit_actor: Optional[str], agent_id: str) -> str:
    if explicit_actor:
        return explicit_actor
    if not agent_id:
        raise ValueError("agent_id is required to derive actor id")
    return f"agent:{agent_id}"


# === VIVENTIUM NOTE ===
# Feature: Summary-safe schedule browsing.
# Purpose: Keep list/search browsing useful without leaking full internal prompts or
# generated delivery text into ordinary answer-building context.
def serialize_task_summary(task: Dict[str, Any]) -> Dict[str, Any]:
    if not task:
        return {}
    payload = ScheduleTask(**task).model_dump()
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    schedule = payload.get("schedule") if isinstance(payload.get("schedule"), dict) else payload.get("schedule")
    channel = payload.get("channel")
    starter_morning_briefing = metadata.get("template_id") == "morning_briefing_default_v1"
    summary = (
        str(metadata.get("name") or "").strip()
        or ("Morning briefing" if starter_morning_briefing else "")
        or "scheduled task"
    )
    return {
        "task_id_internal": payload.get("id"),
        "summary": summary,
        "schedule": schedule,
        "channel": channel,
        "active": payload.get("active"),
        "starter_morning_briefing": starter_morning_briefing,
        "next_run_at": payload.get("next_run_at"),
    }


# === VIVENTIUM NOTE ===
# Feature: Normalize channel inputs and default to all when omitted.
def _normalize_channels(value: Optional[ChannelValue], default_all: bool = False) -> list[str]:
    if value is None:
        return list(AVAILABLE_CHANNELS) if default_all else []
    if isinstance(value, str):
        raw_values = [value]
    else:
        raw_values = list(value)

    normalized: list[str] = []
    seen = set()
    for item in raw_values:
        if item is None:
            continue
        key = str(item).strip().lower()
        if not key:
            continue
        if key not in AVAILABLE_CHANNELS:
            raise ValueError(f"Unsupported channel: {item}")
        if key not in seen:
            normalized.append(key)
            seen.add(key)

    if not normalized:
        raise ValueError("channel must include at least one valid entry")
    return normalized
# === VIVENTIUM NOTE ===


def build_server(storage: ScheduleStorage) -> FastMCP:
    mcp = FastMCP(name="scheduling-cortex", instructions=SCHEDULING_CORTEX_INSTRUCTIONS)

    # VIVENTIUM NOTE: Add health endpoint for container app probes.
    @mcp.custom_route("/health", methods=["GET"])
    async def health(_: Request) -> Response:
        return JSONResponse({"status": "ok"})
    # VIVENTIUM NOTE

    # === VIVENTIUM NOTE ===
    # Feature: Internal bootstrap endpoint for idempotent starter schedule provisioning.
    # Called by LibreChat morningBriefingBootstrap.js on first user interaction.
    @mcp.custom_route("/internal/bootstrap-schedule", methods=["POST"])
    async def bootstrap_schedule(request: Request) -> Response:
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"status": "error", "reason": "invalid_json"}, status_code=400)

        user_id = body.get("user_id")
        template_id = body.get("template_id")
        if not user_id or not template_id:
            return JSONResponse(
                {"status": "error", "reason": "user_id and template_id required"},
                status_code=400,
            )

        existing = storage.find_by_metadata_template(user_id, template_id)
        if existing:
            return JSONResponse({"status": "exists", "task_id": existing.get("id")})

        agent_id = body.get("agent_id") or os.getenv("VIVENTIUM_MAIN_AGENT_ID") or ""
        channels = body.get("channels")
        tz = body.get("timezone") or "UTC"
        time_str = body.get("time") or "08:00"
        prompt = body.get("prompt") or (
            "Morning orientation: review my memories, calendar, pending tasks, "
            "and any overnight signals. Prepare a concise morning briefing for the user."
        )
        metadata = body.get("metadata") or {}
        metadata["template_id"] = template_id

        now = datetime.now(timezone.utc)
        schedule = {"type": "daily", "time": time_str, "timezone": tz}
        next_run = compute_next_run(schedule, now, None)

        channel_value: Any
        if isinstance(channels, list) and len(channels) == 1:
            channel_value = channels[0]
        elif isinstance(channels, list):
            channel_value = channels
        elif isinstance(channels, str):
            channel_value = channels
        else:
            channel_value = list(AVAILABLE_CHANNELS)

        task = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "agent_id": agent_id,
            "prompt": prompt,
            "schedule": schedule,
            "channel": channel_value,
            "conversation_policy": body.get("conversation_policy") or "same",
            "conversation_id": None,
            "last_conversation_id": None,
            "active": 1,
            "created_by": f"agent:{agent_id}" if agent_id else "system:bootstrap",
            "created_source": "agent",
            "created_at": to_utc_iso(now),
            "updated_at": to_utc_iso(now),
            "updated_by": f"agent:{agent_id}" if agent_id else "system:bootstrap",
            "updated_source": "agent",
            "last_run_at": None,
            "next_run_at": to_utc_iso(next_run) if next_run else None,
            "last_status": None,
            "last_error": None,
            "last_delivery_outcome": None,
            "last_delivery_reason": None,
            "last_delivery_at": None,
            "last_generated_text": None,
            "last_delivery": None,
            "metadata": metadata,
        }

        storage.create_task(task)
        logger.info(
            "[scheduling-cortex] Bootstrap schedule created: user_id=%s template_id=%s task_id=%s",
            user_id,
            template_id,
            task["id"],
        )
        return JSONResponse({"status": "created", "task_id": task["id"]})
    # === VIVENTIUM NOTE ===

    def _serialize(task: Dict[str, Any]) -> Dict[str, Any]:
        if not task:
            return {}
        return ScheduleTask(**task).model_dump()

    def _serialize_summary(task: Dict[str, Any]) -> Dict[str, Any]:
        return serialize_task_summary(task)

    def _now_iso() -> str:
        return to_utc_iso(datetime.now(timezone.utc))

    # === VIVENTIUM NOTE ===
    # Feature: Clarify tool schema defaults and channel behavior.
    @mcp.tool(
        description=_tool_description(
            what="Create a scheduled task for a future or recurring self-prompt.",
            use_when="The user asks for a reminder, follow-up, recurring check, or new scheduled job.",
            avoid_when=(
                "The request is immediate, or a matching existing schedule should be updated instead."
            ),
            inputs=(
                "prompt, schedule, optional channel, conversation_policy, active, metadata; "
                "user_id, agent_id, and created_by are auto-injected when omitted."
            ),
            returns="success, full task object, and creation message.",
            failure_modes="Invalid schedule, unsupported channel, missing identity, or past once run_at.",
            idempotency=(
                "Search/list before creating when the user means to change an existing schedule; "
                "for starter briefing, update the existing starter task returned by list/search."
            ),
            delayed_callback=(
                "Creation only schedules future work; later runs may deliver text or {NTA} silently."
            ),
        )
    )
    # === VIVENTIUM NOTE ===
    def schedule_create(args: CreateScheduleArgs) -> Dict[str, Any]:
        now = datetime.now(timezone.utc)
        schedule = args.schedule.model_dump()
        user_id = _resolve_user_id(args.user_id)
        agent_id = _resolve_agent_id(args.agent_id)
        request_agent_id = _resolve_request_agent_id(fallback=agent_id)
        created_by = _resolve_actor_id(args.created_by, request_agent_id)
        created_source = args.created_source or "user"
        # === VIVENTIUM NOTE ===
        # Feature: Default to all channels when channel is omitted.
        channels = _normalize_channels(args.channel, default_all=True)
        channel_value: Any = channels[0] if len(channels) == 1 else channels
        # === VIVENTIUM NOTE ===

        next_run = compute_next_run(schedule, now, None)
        if schedule.get("type") == "once":
            if not next_run:
                run_at = schedule.get("run_at")
                raise ValueError(
                    f"run_at {run_at} must be in the future (now: {to_utc_iso(now)})"
                )
        elif not next_run:
            raise ValueError("Unable to compute next_run_at for schedule")

        task = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "agent_id": agent_id,
            "prompt": args.prompt,
            "schedule": schedule,
            # === VIVENTIUM NOTE ===
            # Feature: Store normalized channel(s) for dispatch fan-out.
            "channel": channel_value,
            # === VIVENTIUM NOTE ===
            "conversation_policy": args.conversation_policy,
            "conversation_id": args.conversation_id,
            "last_conversation_id": None,
            "active": 1 if args.active else 0,
            "created_by": created_by,
            "created_source": created_source,
            "created_at": to_utc_iso(now),
            "updated_at": to_utc_iso(now),
            "updated_by": created_by,
            "updated_source": created_source,
            "last_run_at": None,
            "next_run_at": to_utc_iso(next_run) if next_run else None,
            "last_status": None,
            "last_error": None,
            # === VIVENTIUM NOTE ===
            # Feature: Initialize delivery visibility ledger state.
            "last_delivery_outcome": None,
            "last_delivery_reason": None,
            "last_delivery_at": None,
            "last_generated_text": None,
            "last_delivery": None,
            # === VIVENTIUM NOTE ===
            "metadata": args.metadata,
        }

        storage.create_task(task)
        return {
            "success": True,
            "task": _serialize(task),
            "message": "Scheduled task created",
        }

    # === VIVENTIUM NOTE ===
    # Feature: Clarify tool schema defaults and auto-injected fields.
    @mcp.tool(
        description=_tool_description(
            what="Get one scheduled task by id with full prompt, schedule, metadata, and delivery fields for private verification or diagnostics.",
            use_when="The user asks for details about a specific reminder or job, or you must verify existing stored state before an update.",
            avoid_when="The user only needs a broad list or search result.",
            inputs="task_id and optional user_id; user_id is auto-injected when omitted.",
            returns="task object or null; ordinary user-facing replies must translate the object into plain outcomes and avoid raw prompt text, metadata keys, task references, tool function names, or delivery plumbing unless diagnostics were requested.",
            failure_modes="Missing identity or unknown task_id returns null.",
            idempotency="Read-only; does not create, update, or duplicate schedules.",
            delayed_callback="No delayed callback; this only reads current stored state.",
        )
    )
    # === VIVENTIUM NOTE ===
    def schedule_get(args: GetScheduleArgs) -> Dict[str, Any]:
        user_id = _resolve_user_id(args.user_id)
        task = storage.get_task(user_id, args.task_id)
        return {"task": _serialize(task) if task else None}

    # === VIVENTIUM NOTE ===
    # Feature: Clarify tool schema defaults and channel filtering.
    @mcp.tool(
        description=_tool_description(
            what="List scheduled tasks with summary-safe fields.",
            use_when="The user asks what reminders/jobs exist or needs candidates before an update.",
            avoid_when="The user needs full prompt text or last generated delivery details.",
            inputs="active_only, channel, agent_id, limit, offset, optional user_id.",
            returns="summary task list and total count; use schedule_get for full details.",
            failure_modes="Missing identity or invalid channel.",
            idempotency="Read-only; use results to prevent duplicate creates.",
            delayed_callback="No delayed callback; list reflects currently stored schedule state.",
        )
    )
    # === VIVENTIUM NOTE ===
    def schedule_list(args: ListScheduleArgs) -> Dict[str, Any]:
        user_id = _resolve_user_id(args.user_id)
        tasks = storage.list_tasks(
            user_id,
            active_only=args.active_only,
            channel=args.channel,
            agent_id=args.agent_id,
            limit=args.limit,
            offset=args.offset,
        )
        return {"tasks": [_serialize_summary(t) for t in tasks], "total": len(tasks)}

    # === VIVENTIUM NOTE ===
    # Feature: Clarify tool schema defaults and channel filtering.
    @mcp.tool(
        description=_tool_description(
            what="Search existing schedules by query and filters using summary-safe output.",
            use_when="The user refers to an existing reminder/job by topic, purpose, or wording.",
            avoid_when="The user already provided a task_id, or no schedule lookup is needed.",
            inputs="query, channel, agent_id, limit, offset, optional user_id.",
            returns="summary task list and total count; use schedule_get for full details.",
            failure_modes="Missing identity or invalid channel.",
            idempotency="Read-only; search before creating similar schedules to avoid duplicates.",
            delayed_callback="No delayed callback; search reflects currently stored schedule state.",
        )
    )
    # === VIVENTIUM NOTE ===
    def schedule_search(args: SearchScheduleArgs) -> Dict[str, Any]:
        user_id = _resolve_user_id(args.user_id)
        tasks = storage.search_tasks(
            user_id,
            query=args.query,
            channel=args.channel,
            agent_id=args.agent_id,
            limit=args.limit,
            offset=args.offset,
        )
        return {"tasks": [_serialize_summary(t) for t in tasks], "total": len(tasks)}

    # === VIVENTIUM NOTE ===
    # Feature: Visibility tool for the last generated/suppressed scheduled output.
    @mcp.tool(
        description=_tool_description(
            what="Read the most recent generated/sent/suppressed delivery state for a schedule.",
            use_when="The user asks whether a scheduled run fired, what it sent, or why it stayed silent.",
            avoid_when="The user only wants schedule configuration or future run previews.",
            inputs="optional task_id, channel, agent_id, user_id.",
            returns="full task object with last_delivery fields or null.",
            failure_modes="Missing identity, unknown task_id, or no matching delivery record.",
            idempotency="Read-only; does not retry or duplicate a delivery.",
            delayed_callback="Shows delayed run outcome; {NTA} suppression is a valid silent outcome.",
        )
    )
    # === VIVENTIUM NOTE ===
    def schedule_last_delivery(args: LastDeliveryArgs) -> Dict[str, Any]:
        user_id = _resolve_user_id(args.user_id)
        if args.task_id:
            task = storage.get_task(user_id, args.task_id)
            if not task:
                return {"task": None}
            return {"task": _serialize(task)}

        task = storage.get_latest_delivery_task(
            user_id=user_id,
            channel=args.channel,
            agent_id=args.agent_id,
        )
        return {"task": _serialize(task) if task else None}

    # === VIVENTIUM NOTE ===
    # Feature: Clarify tool schema defaults and channel behavior.
    @mcp.tool(
        description=_tool_description(
            what="Update fields on an existing scheduled task.",
            use_when="The user changes timing, prompt, channel, active state, metadata, or conversation policy.",
            avoid_when="The user is asking to create a clearly new unrelated schedule.",
            inputs=(
                "task_id plus any fields to override: prompt, schedule, agent_id, channel, "
                "conversation_policy, conversation_id, active, metadata; user_id and updated_by are auto-injected."
            ),
            returns="success, updated full task object, and update message.",
            failure_modes="Missing identity, unknown task_id, invalid channel, or past once run_at.",
            idempotency=(
                "Use update rather than create for existing schedules; preserve unchanged fields when omitted."
            ),
            delayed_callback="Update changes future behavior only; later runs may deliver text or {NTA} silently.",
        )
    )
    # === VIVENTIUM NOTE ===
    def schedule_update(args: UpdateScheduleArgs) -> Dict[str, Any]:
        user_id = _resolve_user_id(args.user_id)
        existing = storage.get_task(user_id, args.task_id)
        if not existing:
            raise ValueError("Task not found")

        agent_id = _resolve_agent_id(args.agent_id, fallback=existing.get("agent_id"))
        request_agent_id = _resolve_request_agent_id(fallback=agent_id)
        updated_by = _resolve_actor_id(args.updated_by, request_agent_id)
        updated_source = args.updated_source or "user"
        schedule = existing.get("schedule")
        if args.schedule:
            schedule = args.schedule.model_dump()

        now = datetime.now(timezone.utc)
        next_run = compute_next_run(schedule, now, None) if schedule else None
        if schedule and schedule.get("type") == "once" and not next_run:
            run_at = schedule.get("run_at") if isinstance(schedule, dict) else None
            raise ValueError(
                f"run_at {run_at} must be in the future (now: {to_utc_iso(now)})"
            )

        updates: Dict[str, Any] = {
            "updated_at": to_utc_iso(now),
            "updated_by": updated_by,
            "updated_source": updated_source,
        }

        if args.prompt is not None:
            updates["prompt"] = args.prompt
        if args.agent_id is not None:
            updates["agent_id"] = args.agent_id
        if args.channel is not None:
            # === VIVENTIUM NOTE ===
            # Feature: Normalize channel(s) for updates.
            channels = _normalize_channels(args.channel)
            updates["channel"] = channels[0] if len(channels) == 1 else channels
            # === VIVENTIUM NOTE ===
        if args.conversation_policy is not None:
            updates["conversation_policy"] = args.conversation_policy
            if args.conversation_policy == "same" and not args.conversation_id:
                last_convo = existing.get("last_conversation_id")
                current_convo = existing.get("conversation_id")
                if last_convo and not current_convo:
                    updates["conversation_id"] = last_convo
            if args.conversation_policy == "new" and args.conversation_id is None:
                updates["conversation_id"] = None
        if args.conversation_id is not None:
            updates["conversation_id"] = args.conversation_id
        if args.active is not None:
            updates["active"] = 1 if args.active else 0
        if args.metadata is not None:
            updates["metadata"] = args.metadata
        if args.schedule is not None:
            updates["schedule"] = schedule
            updates["next_run_at"] = to_utc_iso(next_run) if next_run else None

        updated = storage.update_task(user_id, args.task_id, updates)
        return {"success": True, "task": _serialize(updated), "message": "Task updated"}

    # === VIVENTIUM NOTE ===
    # Feature: Clarify tool schema defaults and auto-injected fields.
    @mcp.tool(
        description=_tool_description(
            what="Delete one scheduled task.",
            use_when="The user asks to cancel, remove, or stop a specific reminder/job permanently.",
            avoid_when="The user only wants to pause or disable temporarily; use schedule_update active=false.",
            inputs="task_id and optional user_id; user_id is auto-injected when omitted.",
            returns="success boolean.",
            failure_modes="Missing identity or unknown task_id returns success false.",
            idempotency="Deleting the same missing task returns false and does not create side effects.",
            delayed_callback="No delayed callback; future runs stop once deletion succeeds.",
        )
    )
    # === VIVENTIUM NOTE ===
    def schedule_delete(args: DeleteScheduleArgs) -> Dict[str, Any]:
        user_id = _resolve_user_id(args.user_id)
        deleted = storage.delete_task(user_id, args.task_id)
        return {"success": deleted}

    # === VIVENTIUM NOTE ===
    # Feature: Clarify tool schema defaults and auto-injected fields.
    @mcp.tool(
        description=_tool_description(
            what="Preview upcoming run times for an existing scheduled task.",
            use_when="The user asks when a reminder/job will run next.",
            avoid_when="The user needs to modify timing; use schedule_update after preview if requested.",
            inputs="task_id, count, optional user_id; user_id is auto-injected when omitted.",
            returns="task_id and next_runs list.",
            failure_modes="Missing identity, unknown task_id, or invalid schedule.",
            idempotency="Read-only; does not change next_run_at or create duplicate schedules.",
            delayed_callback="No delayed callback; preview is informational only.",
        )
    )
    # === VIVENTIUM NOTE ===
    def schedule_preview_next(args: PreviewScheduleArgs) -> Dict[str, Any]:
        user_id = _resolve_user_id(args.user_id)
        task = storage.get_task(user_id, args.task_id)
        if not task:
            raise ValueError("Task not found")
        schedule = task.get("schedule") or {}
        now = datetime.now(timezone.utc)
        runs = compute_next_runs(schedule, now, args.count)
        return {"task_id": args.task_id, "next_runs": runs}

    return mcp


def main() -> None:
    parser = argparse.ArgumentParser(description="Scheduling Cortex MCP")
    parser.add_argument("--transport", choices=["stdio", "streamable-http"], default="streamable-http")
    parser.add_argument("--host", default=os.getenv("SCHEDULER_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("SCHEDULER_PORT", DEFAULT_PORT)))
    args = parser.parse_args()

    log_level = os.getenv("SCHEDULER_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(level=log_level, format="%(asctime)s %(levelname)s %(name)s - %(message)s")

    db_path = os.getenv(
        "SCHEDULING_DB_PATH",
        os.path.expanduser("~/.viventium/scheduling/schedules.db"),
    )
    # === VIVENTIUM NOTE ===
    # Feature: Mirror DB to durable storage when configured.
    mirror_path = os.getenv("SCHEDULING_DB_MIRROR_PATH")
    storage = ScheduleStorage(StorageConfig(db_path=db_path, mirror_db_path=mirror_path))
    # === VIVENTIUM NOTE ===

    poll_interval_s = int(os.getenv("SCHEDULER_POLL_INTERVAL_S", "30"))
    misfire_grace_s = int(os.getenv("SCHEDULER_MISFIRE_GRACE_S", "900"))
    retry_delay_s = int(os.getenv("SCHEDULER_RETRY_DELAY_S", "300"))
    catch_up_max_late_s = int(os.getenv("SCHEDULER_CATCH_UP_MAX_LATE_S", "43200"))

    scheduler = SchedulerEngine(
        storage,
        poll_interval_s,
        misfire_grace_s,
        retry_delay_s,
        catch_up_max_late_s,
    )
    scheduler.start()

    server = build_server(storage)
    server.run(transport=args.transport, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
