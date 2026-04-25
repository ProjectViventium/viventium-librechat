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
    summary = (
        str(metadata.get("name") or "").strip()
        or str(metadata.get("template_id") or "").strip()
        or str(payload.get("prompt") or "").strip().splitlines()[0][:120]
        or "scheduled task"
    )
    return {
        "id": payload.get("id"),
        "user_id": payload.get("user_id"),
        "agent_id": payload.get("agent_id"),
        "channel": payload.get("channel"),
        "schedule": payload.get("schedule"),
        "conversation_policy": payload.get("conversation_policy"),
        "active": payload.get("active"),
        "created_by": payload.get("created_by"),
        "created_source": payload.get("created_source"),
        "created_at": payload.get("created_at"),
        "updated_at": payload.get("updated_at"),
        "updated_by": payload.get("updated_by"),
        "updated_source": payload.get("updated_source"),
        "last_run_at": payload.get("last_run_at"),
        "next_run_at": payload.get("next_run_at"),
        "last_status": payload.get("last_status"),
        "last_error": payload.get("last_error"),
        "last_delivery_outcome": payload.get("last_delivery_outcome"),
        "last_delivery_reason": payload.get("last_delivery_reason"),
        "last_delivery_at": payload.get("last_delivery_at"),
        "summary": summary,
        "metadata": metadata,
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
    mcp = FastMCP(name="scheduling-cortex")

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
        description=(
            "Create a scheduled task. Defaults: channel -> all available channels "
            "(['telegram','librechat']) when omitted; conversation_policy -> 'new'. "
            "user_id, agent_id, created_by are auto-injected from request headers/env if omitted. "
            "Write prompt as a note to yourself (the AI agent), i.e., the scheduled self-prompt to perform "
            "without extra framing; a fixed scheduled self-prompt prefix is injected automatically. "
            "Example channel: 'telegram' or ['telegram','librechat']."
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
        description=(
            "Get a scheduled task by id. user_id is auto-injected from request headers if omitted."
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
        description=(
            "List scheduled tasks. Filters: active_only (default false), channel "
            "('telegram' | 'librechat' or list; matches any channel in task), agent_id. "
            "Returns summary fields only; use schedule_get or schedule_last_delivery for full prompt "
            "or delivery details. user_id is auto-injected from request headers if omitted."
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
        description=(
            "Search scheduled tasks by prompt text. Filters: channel ('telegram' | 'librechat' or list), "
            "agent_id. Returns summary fields only; use schedule_get or schedule_last_delivery for full "
            "prompt or delivery details. Defaults: limit=50, offset=0. user_id is auto-injected if omitted."
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
        description=(
            "Get last delivery details for a scheduled task. If task_id is omitted, returns "
            "the most recent matching task for this user (optional channel/agent filters). "
            "Includes whether the run was sent or suppressed and the generated text summary."
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
        description=(
            "Update a scheduled task. Any provided fields override existing values. "
            "channel accepts 'telegram' | 'librechat' or list; when omitted, channel is unchanged. "
            "conversation_policy='same' reuses conversation_id when available (first run may start new). "
            "user_id, updated_by are auto-injected if omitted."
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
        description=(
            "Delete a scheduled task. user_id is auto-injected from request headers if omitted."
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
        description=(
            "Preview upcoming run times for a task. Defaults: count=3. "
            "user_id is auto-injected if omitted."
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
