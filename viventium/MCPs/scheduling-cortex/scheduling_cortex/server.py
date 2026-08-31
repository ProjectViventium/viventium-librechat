# VIVENTIUM START
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# VIVENTIUM END

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import logging
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Optional

from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
from starlette.requests import Request
from starlette.responses import JSONResponse, Response

from .models import (
    AVAILABLE_CHANNELS,
    DEFAULT_DELIVERY_CHANNELS,
    ChannelValue,
    CreateScheduleArgs,
    UpdateScheduleArgs,
    DeleteScheduleArgs,
    GetScheduleArgs,
    ListScheduleArgs,
    SearchScheduleArgs,
    PreviewScheduleArgs,
    LastDeliveryArgs,
    PeripheryListArgs,
    PeripheryReadArgs,
    ScheduleTask,
)
from .scheduler import SchedulerEngine, compute_next_run, compute_next_runs
from .dispatch import _patch_private_run_detail
from .glasshive_workspace_schedules import (
    GlassHiveWorkspaceScheduleService,
    WorkspaceScheduleError,
)
from .storage import ScheduleStorage, StorageConfig, scheduled_prompt_stale_seconds
from .utils import to_utc_iso

DEFAULT_PORT = 7010
HEADER_USER_ID = "x-viventium-user-id"
HEADER_AGENT_ID = "x-viventium-agent-id"

logger = logging.getLogger(__name__)

ISOLATED_ARTIFACT_RETRYABLE_ERRORS = {
    "isolated_artifact_pair_missing",
    "isolated_artifact_listing_truncated",
    "isolated_artifact_import_failed",
    "isolated_artifact_import_context_missing",
}


def _glasshive_callback_reconciliation_allowed(run: dict[str, Any], event: str) -> bool:
    """Allow signed late completion to repair only synthetic terminal failures."""

    current_status = str(run.get("status") or "queued")
    if current_status not in {"completed", "failed"}:
        return True
    error_class = str(run.get("error_class") or "")
    return current_status == "failed" and event == "run.completed" and (
        error_class == "stale_run_reconciled"
        or error_class in ISOLATED_ARTIFACT_RETRYABLE_ERRORS
    )


def _glasshive_callback_lifecycle(
    run: dict[str, Any],
    event: str,
    payload: dict[str, Any],
    now: str,
    *,
    authoritative_terminal: bool = False,
) -> tuple[str, str, Optional[str], Optional[str]]:
    """Apply monotonic callback state so late transport events cannot reopen terminal work."""

    current_status = str(run.get("status") or "queued")
    current_disposition = str(run.get("disposition") or "running")
    if (
        current_status in {"completed", "failed"}
        and not authoritative_terminal
        and not _glasshive_callback_reconciliation_allowed(run, event)
    ):
        return (
            current_status,
            current_disposition,
            run.get("completed_at"),
            run.get("error_class"),
        )
    if event == "run.completed":
        return "completed", "delivered", now, None
    if event in {"run.failed", "run.cancelled", "run.interrupted"}:
        callback_failure_class = str(
            payload.get("failure_class") or payload.get("failure_code") or ""
        ).strip()
        error_class = (
            callback_failure_class
            if re.fullmatch(r"[a-z0-9_.:-]{1,128}", callback_failure_class)
            else event.replace("run.", "")
        )
        disposition = "failed" if event == "run.failed" else "cancelled"
        return "failed", disposition, now, error_class
    if event == "run.queued":
        status = current_status if current_status in {"running", "completed", "failed"} else "queued"
        return (
            status,
            current_disposition if status in {"completed", "failed"} else "running",
            run.get("completed_at"),
            run.get("error_class") if status != "queued" else None,
        )
    if event in {"run.waiting_on_capacity", "run.requeued"}:
        return "queued", "running", run.get("completed_at"), None
    if event == "run.started":
        return "running", "running", run.get("completed_at"), run.get("error_class")
    return current_status, current_disposition, run.get("completed_at"), run.get("error_class")


def _metadata_with_required_capability_servers(
    metadata: Any,
    required_capability_servers: list[str] | None,
    *,
    executor: str,
) -> Dict[str, Any]:
    """Persist the schedule-authoring selection that fire-time grants consume.

    The typed top-level field owns this value. Callers cannot smuggle a broader selection through
    free-form metadata, and a GlassHive capability selection cannot be attached to another executor.
    """

    base = dict(metadata) if isinstance(metadata, dict) else {}
    workbench = base.get("workbench_scheduled_prompt")
    workbench = dict(workbench) if isinstance(workbench, dict) else {}
    values = list(required_capability_servers or [])
    if values and executor != "glasshive_host":
        raise ValueError("required_capability_servers requires executor='glasshive_host'")
    if values:
        workbench["required_capability_servers"] = values
    else:
        workbench.pop("required_capability_servers", None)
        workbench.pop("required_capability_server_names", None)
    if workbench:
        base["workbench_scheduled_prompt"] = workbench
    else:
        base.pop("workbench_scheduled_prompt", None)
    return base


def _required_capability_servers_from_metadata(metadata: Any) -> list[str]:
    if not isinstance(metadata, dict):
        return []
    workbench = metadata.get("workbench_scheduled_prompt")
    if not isinstance(workbench, dict):
        return []
    values = workbench.get("required_capability_servers")
    if not isinstance(values, list):
        return []
    return [str(value) for value in values]


def _default_scheduling_db_path() -> str:
    configured_root = str(os.getenv("VIVENTIUM_APP_SUPPORT_DIR") or "").strip()
    if configured_root:
        app_support_root = Path(configured_root).expanduser()
    elif sys.platform == "darwin":
        app_support_root = Path.home() / "Library" / "Application Support" / "Viventium"
    elif sys.platform == "win32":
        local_app_data = str(os.getenv("LOCALAPPDATA") or "").strip()
        app_support_root = (
            Path(local_app_data) / "Viventium"
            if local_app_data
            else Path.home() / "AppData" / "Local" / "Viventium"
        )
    else:
        xdg_data_home = str(os.getenv("XDG_DATA_HOME") or "").strip()
        app_support_root = (
            Path(xdg_data_home) / "Viventium"
            if xdg_data_home
            else Path.home() / ".local" / "share" / "Viventium"
        )
    return str(app_support_root / "state" / "scheduling" / "schedules.db")

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

Execution ownership:

- executor="viventium_agent" always reloads the persisted Main Agent configuration from Agent Builder at run time, including its configured fallback. The schedule does not own or override provider, model, reasoning effort, GlassHive options, tools, or fallback policy.
- glasshive_host is a separate explicit Workbench executor with its own declared worker profile. Use it only when the schedule is intentionally a Workbench-hosted automation, not as an alias for the Viventium Main Agent.
- Never copy a Main Agent model into schedule metadata or infer execution policy from prompt text, task names, agent names, or user identity.

When to use:

- The user asks to remind, follow up later, check back, keep watching, run a recurring task, or change an existing schedule.
- The user asks what reminders/jobs exist, when one will run, or what happened on the last run.
- A starter morning briefing exists and should be changed. Its stable template_id is
  morning_briefing_default_v1.
- Current schedule counts, status, and delivery state are live facts. Call the matching read tool in
  the current turn before stating them; never infer them from conversation history, capability
  readiness, or an earlier tool result.

Private periphery:

- Viventium may have private nightly risk, blind-spot, opportunity-cost, and opportunity artifacts.
- Use periphery_list, then periphery_read, when the user asks what Viventium noticed or when a deep planning/review task genuinely needs that evidence.
- Do not inspect periphery by default, do not imply an artifact exists before listing it, and treat stale or failed-quality artifacts as historical hypotheses rather than current facts.
- Periphery tools return a compact agent view; storage paths, raw record references, run identifiers, and duplicate bodies stay behind the tool boundary.

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


_PERIPHERY_CLAIM_FIELDS = (
    "observations",
    "risks",
    "blindSpots",
    "opportunityCosts",
    "opportunities",
    "whatWouldMakeThisWrong",
    "whenToSurface",
    "proposedActions",
)


def _periphery_insight_summary(artifact: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "insightRef": artifact.get("artifactId"),
        "module": artifact.get("moduleId"),
        "generatedAt": artifact.get("generatedAt"),
        "confidence": artifact.get("confidence"),
        "severity": artifact.get("severity"),
        "timeSensitivity": artifact.get("timeSensitivity"),
        "stale": bool(artifact.get("stale")),
        "quality": artifact.get("qualityStatus"),
        "qualityReasons": artifact.get("qualityReasons") or [],
        "evidenceQuality": {
            "declaredEvidence": artifact.get("sourceRefCount", 0),
            "resolvedEvidence": artifact.get("sourceRefsResolvedCount", 0),
            "unresolvedEvidence": artifact.get("sourceRefsUnresolvedCount", 0),
            "groundedClaims": artifact.get("claimsGroundedCount", 0),
            "ungroundedClaims": artifact.get("claimsUngroundedCount", 0),
        },
    }


def _serialize_periphery_list_for_agent(payload: Dict[str, Any]) -> Dict[str, Any]:
    artifacts = [item for item in payload.get("artifacts", []) if isinstance(item, dict)]

    def latest_per_module(*, current_only: bool, limit: int) -> list[Dict[str, Any]]:
        selected: list[Dict[str, Any]] = []
        seen_modules: set[str] = set()
        for item in artifacts:
            is_current = item.get("qualityStatus") == "passed" and not item.get("stale")
            if is_current != current_only:
                continue
            module = str(item.get("moduleId") or item.get("artifactId") or "unknown")
            if module in seen_modules:
                continue
            seen_modules.add(module)
            selected.append(_periphery_insight_summary(item))
            if len(selected) >= limit:
                break
        return selected

    current = latest_per_module(current_only=True, limit=5)
    historical = latest_per_module(current_only=False, limit=3)
    index = payload.get("index") if isinstance(payload.get("index"), dict) else {}
    allowed_blockers = {
        "outside_periphery_root",
        "private_permissions_unavailable",
        "unsafe_hard_link",
        "unsafe_symlink",
    }
    blocked_reasons = [
        str(reason)
        for reason in index.get("blockedReasons", [])
        if str(reason) in allowed_blockers
    ]
    status = str(index.get("status") or "").strip().lower()
    if status not in {"available", "degraded", "blocked"}:
        status = "degraded" if blocked_reasons and artifacts else "blocked" if blocked_reasons else "available"
    reason_guidance = {
        "outside_periphery_root": "An insight outside the private Periphery boundary was withheld.",
        "private_permissions_unavailable": "Private insight permissions could not be verified; check ownership and filesystem support.",
        "unsafe_hard_link": "A linked insight was withheld because its private storage boundary cannot be proven; restore it as a normal private file.",
        "unsafe_symlink": "A linked insight path was withheld because it could leave the private Periphery boundary.",
    }
    return {
        "currentInsights": current,
        "historicalInsights": historical,
        "availability": {
            "status": status,
            "reasons": blocked_reasons,
            "blockedCount": index.get("blockedArtifactCount", len(blocked_reasons)),
            "guidance": [reason_guidance[reason] for reason in blocked_reasons],
        },
        "totals": {
            "insights": index.get("artifactCount", len(artifacts)),
            "invalid": index.get("invalidArtifactCount", 0),
            "quality": index.get("qualityCounts", {}),
        },
        "usage": (
            "Prefer the newest current insight. Read historical insight only when explicitly useful, "
            "and describe stale or legacy material as historical uncertainty. If availability is degraded, "
            "use the available insights and disclose that some private artifacts were withheld. If it is blocked, "
            "report that private insight access is unavailable instead of claiming no insights exist."
        ),
    }


def _periphery_claim_for_agent(item: Any) -> Optional[Dict[str, Any]]:
    if isinstance(item, str):
        text = item.strip()
        return {"text": text, "evidenceCount": 0} if text else None
    if not isinstance(item, dict):
        return None
    text = str(
        item.get("text")
        or item.get("summary")
        or item.get("claim")
        or item.get("description")
        or ""
    ).strip()
    if not text:
        return None
    source_refs = item.get("sourceRefs")
    result: Dict[str, Any] = {
        "text": text,
        "evidenceCount": len(source_refs) if isinstance(source_refs, list) else 0,
    }
    kind = str(item.get("kind") or "").strip()
    if kind:
        result = {"kind": kind, **result}
    return result


def _serialize_periphery_read_for_agent(payload: Dict[str, Any]) -> Dict[str, Any]:
    artifact = payload.get("artifact") if isinstance(payload.get("artifact"), dict) else {}
    sidecar = payload.get("sidecar") if isinstance(payload.get("sidecar"), dict) else {}
    insight: Dict[str, Any] = {
        "module": sidecar.get("moduleId") or artifact.get("moduleId"),
        "generatedAt": sidecar.get("generatedAt") or artifact.get("generatedAt"),
        "confidence": sidecar.get("confidence") or artifact.get("confidence"),
        "severity": sidecar.get("severity") or artifact.get("severity"),
        "timeSensitivity": sidecar.get("timeSensitivity") or artifact.get("timeSensitivity"),
        "staleAfter": sidecar.get("staleAfter") or artifact.get("staleAfter"),
        "stale": bool(artifact.get("stale")),
        "quality": artifact.get("qualityStatus"),
        "qualityReasons": artifact.get("qualityReasons") or [],
        "evidenceQuality": {
            "declaredEvidence": artifact.get("sourceRefCount", len(sidecar.get("sourceRefs") or [])),
            "resolvedEvidence": artifact.get("sourceRefsResolvedCount", 0),
            "unresolvedEvidence": artifact.get("sourceRefsUnresolvedCount", 0),
            "groundedClaims": artifact.get("claimsGroundedCount", 0),
            "ungroundedClaims": artifact.get("claimsUngroundedCount", 0),
        },
        "memoryProposalCount": len(sidecar.get("memoryProposalRefs") or []),
    }
    for field in _PERIPHERY_CLAIM_FIELDS:
        claims = sidecar.get(field) if isinstance(sidecar.get(field), list) else []
        insight[field] = [
            serialized
            for serialized in (_periphery_claim_for_agent(item) for item in claims[:12])
            if serialized
        ]
    return {
        "insight": insight,
        "usage": (
            "Use observations as evidence and label inferences or hypotheses honestly. "
            "Caveat stale, legacy, unresolved, or ungrounded material. Do not expose tool plumbing."
        ),
    }


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


def _import_workbench_scheduled_prompts() -> Any:
    current = Path(__file__).resolve()
    for parent in current.parents:
        backend_root = parent / "viventium_v0_4" / "prompt-workbench" / "backend"
        if not backend_root.is_dir():
            continue
        if str(parent) not in sys.path:
            sys.path.insert(0, str(parent))
        if str(backend_root) not in sys.path:
            sys.path.insert(0, str(backend_root))
        from prompt_workbench import scheduled_prompts as workbench_scheduled_prompts

        return workbench_scheduled_prompts
    raise RuntimeError("Prompt Workbench periphery reader is unavailable")


def _refresh_workbench_periphery_index(run: Dict[str, Any]) -> None:
    definition_id = str(run.get("definition_id") or "").strip()
    user_id = str(run.get("user_id") or "").strip()
    if not definition_id or not user_id:
        return
    try:
        reader = _import_workbench_scheduled_prompts()
        reader.list_periphery_artifacts(definition_id, user_id=user_id)
    except Exception as exc:
        logger.warning(
            "[scheduling-cortex] Periphery index refresh failed after scheduled run",
            extra={"run_id": str(run.get("run_id") or ""), "error_class": exc.__class__.__name__},
        )


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
        return list(DEFAULT_DELIVERY_CHANNELS) if default_all else []
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


def _identity_hash(value: str) -> str:
    normalized = str(Path(value).expanduser().resolve()) if value else ""
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else ""


def _env_text_hash(value: str) -> str:
    normalized = str(value or "").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest() if normalized else ""


def _env_truthy(value: str) -> bool:
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def build_health_payload(storage: ScheduleStorage) -> Dict[str, Any]:
    """Return a public-safe runtime identity for local launcher ownership checks."""
    state_root = os.getenv("VIVENTIUM_STATE_ROOT", "")
    dev_env_name = os.getenv("VIVENTIUM_DEV_ENV_NAME", "")
    return {
        "status": "ok",
        "service": "scheduling-cortex",
        "pid": os.getpid(),
        "db_path_sha256": _identity_hash(storage.db_path),
        "state_root_sha256": _identity_hash(state_root),
        "runtime_profile": os.getenv("VIVENTIUM_RUNTIME_PROFILE", ""),
        "dev_env_enabled": _env_truthy(os.getenv("VIVENTIUM_DEV_ENV_ENABLED", "")),
        "dev_env_name_sha256": _env_text_hash(dev_env_name),
    }


EXTERNAL_WORK_TERMINAL_CALLBACK_CONTRACT = "glasshive_terminal_result_v1"


def _external_work_terminal_flag(summary: dict[str, Any]) -> bool:
    if "allRequiredTerminal" in summary:
        value = summary["allRequiredTerminal"]
    elif "all_required_terminal" in summary:
        value = summary["all_required_terminal"]
    else:
        raise ValueError("missing_all_required_terminal")
    if type(value) is not bool:
        raise ValueError("invalid_all_required_terminal")
    return value


def _external_work_callback_updates(
    run: dict[str, Any], summary: dict[str, Any], now: str
) -> dict[str, Any]:
    def count(camel: str, snake: str) -> int:
        try:
            return max(0, int(summary.get(camel) or summary.get(snake) or 0))
        except (TypeError, ValueError):
            return 0

    required_total = count("requiredTotal", "required_total")
    required_terminal = count("requiredTerminal", "required_terminal")
    required_failed = count("requiredFailed", "required_failed")
    all_required_terminal = _external_work_terminal_flag(summary)
    canonical = {
        "requiredTotal": required_total,
        "requiredTerminal": required_terminal,
        "requiredFailed": required_failed,
        "allRequiredTerminal": all_required_terminal,
        "state": str(summary.get("state") or "").strip()
        or ("completed" if all_required_terminal else "waiting_external"),
    }
    execution = (
        dict(run.get("execution_snapshot"))
        if isinstance(run.get("execution_snapshot"), dict)
        else {}
    )
    execution["external_work"] = canonical
    updates: dict[str, Any] = {"execution_snapshot": execution, "updated_at": now}
    if required_total > 0 and not all_required_terminal:
        lease_owner = str(run.get("lease_owner") or "").strip()
        lease_updates: dict[str, Any] = {}
        if lease_owner:
            now_dt = datetime.fromisoformat(str(now).replace("Z", "+00:00"))
            if now_dt.tzinfo is None:
                now_dt = now_dt.replace(tzinfo=timezone.utc)
            lease_updates = {
                "lease_owner": lease_owner,
                "lease_until": (
                    now_dt.astimezone(timezone.utc)
                    + timedelta(seconds=scheduled_prompt_stale_seconds())
                ).isoformat().replace("+00:00", "Z"),
            }
        return {
            **updates,
            **lease_updates,
            "status": "waiting_external",
            "disposition": "running",
            "completed_at": None,
            "error_class": None,
        }
    if required_total > 0:
        return {
            **updates,
            "status": "failed" if required_failed else "completed",
            "disposition": "failed" if required_failed else "delivered",
            "completed_at": now,
            "error_class": "required_external_work_failed" if required_failed else None,
        }
    return updates


def build_server(storage: ScheduleStorage) -> FastMCP:
    mcp = FastMCP(name="scheduling-cortex", instructions=SCHEDULING_CORTEX_INSTRUCTIONS)
    glasshive_workspace_schedules = GlassHiveWorkspaceScheduleService(storage)

    # VIVENTIUM NOTE: Add public-safe runtime identity for launcher probes.
    @mcp.custom_route("/health", methods=["GET"])
    async def health(_: Request) -> Response:
        return JSONResponse(build_health_payload(storage))
    # VIVENTIUM NOTE

    @mcp.custom_route("/internal/scheduled-prompts/external-work-callback", methods=["POST"])
    async def external_work_callback(request: Request) -> Response:
        expected_secret = str(
            os.getenv("VIVENTIUM_SCHEDULER_SECRET")
            or os.getenv("SCHEDULER_LIBRECHAT_SECRET")
            or ""
        ).strip()
        provided_secret = str(
            request.headers.get("x-viventium-scheduler-secret", "")
        ).strip()
        if not expected_secret or not hmac.compare_digest(provided_secret, expected_secret):
            return JSONResponse(
                {"status": "error", "reason": "invalid_scheduler_secret"},
                status_code=401,
            )
        try:
            payload = await request.json()
        except Exception:
            return JSONResponse(
                {"status": "error", "reason": "invalid_json"}, status_code=400
            )
        if not isinstance(payload, dict):
            return JSONResponse(
                {"status": "error", "reason": "invalid_payload"}, status_code=400
            )
        callback_contract = str(payload.get("callback_contract") or "").strip()
        header_contract = str(
            request.headers.get("x-viventium-callback-contract", "")
        ).strip()
        body_identity = any(
            field in payload for field in ("callback_id", "result_revision", "result_digest")
        )
        header_identity = any(
            request.headers.get(header)
            for header in (
                "x-viventium-callback-id",
                "x-viventium-result-revision",
                "x-viventium-result-digest",
            )
        )
        terminal_sender = bool(callback_contract or header_contract or body_identity or header_identity)
        if terminal_sender and (
            callback_contract != EXTERNAL_WORK_TERMINAL_CALLBACK_CONTRACT
            or header_contract != EXTERNAL_WORK_TERMINAL_CALLBACK_CONTRACT
        ):
            return JSONResponse(
                {"status": "error", "reason": "invalid_terminal_contract"},
                status_code=400,
            )
        callback_id = str(payload.get("callback_id") or "").strip()
        result_digest = str(payload.get("result_digest") or "").strip()
        result_revision = payload.get("result_revision")
        if terminal_sender and (
            not callback_id
            or not result_digest
            or not isinstance(result_revision, int)
            or isinstance(result_revision, bool)
            or str(request.headers.get("x-viventium-callback-id", "")).strip()
            != callback_id
            or str(request.headers.get("x-viventium-result-digest", "")).strip()
            != result_digest
            or str(request.headers.get("x-viventium-result-revision", "")).strip()
            != str(result_revision)
        ):
            return JSONResponse(
                {"status": "error", "reason": "invalid_terminal_identity"},
                status_code=400,
            )
        occurrence_key = str(payload.get("occurrence_key") or "").strip()
        user_id = str(payload.get("user_id") or "").strip()
        if not occurrence_key or not user_id:
            return JSONResponse(
                {"status": "error", "reason": "missing_occurrence_owner"},
                status_code=400,
            )
        run = storage.get_scheduled_prompt_run_by_occurrence_key(occurrence_key)
        if not run:
            return JSONResponse(
                {"status": "error", "reason": "unknown_occurrence"}, status_code=404
            )
        if str(run.get("user_id") or "") != user_id:
            return JSONResponse(
                {"status": "error", "reason": "owner_mismatch"}, status_code=403
            )
        try:
            all_required_terminal = _external_work_terminal_flag(payload)
        except ValueError as error:
            return JSONResponse(
                {"status": "error", "reason": str(error)}, status_code=400
            )
        source = str(payload.get("source") or "").strip().lower()
        event = str(payload.get("event") or "").strip().lower()
        state = str(payload.get("state") or "").strip().lower()
        terminal_intent = bool(
            event in {"run.completed", "run.failed", "run.cancelled"}
            or state in {"completed", "failed", "cancelled"}
            or all_required_terminal
        )
        glasshive_source = bool(
            source in {"glasshive", "glasshive_host"}
            or str(run.get("executor") or "").strip().lower() == "glasshive_host"
        )
        if terminal_intent and glasshive_source and not terminal_sender:
            return JSONResponse(
                {"status": "error", "reason": "invalid_terminal_identity"},
                status_code=400,
            )

        if not terminal_sender:
            if terminal_intent or glasshive_source:
                return JSONResponse(
                    {"status": "error", "reason": "legacy_callback_not_allowed"},
                    status_code=400,
                )
            updates = _external_work_callback_updates(
                run, payload, datetime.now(timezone.utc).isoformat()
            )
            applied = storage.update_scheduled_prompt_run_if_current(
                str(run["run_id"]),
                updates,
                expected_status=str(run.get("status") or ""),
                expected_error_class=run.get("error_class"),
            )
            if not applied.get("updated"):
                return JSONResponse(
                    {"status": "error", "reason": "legacy_callback_superseded"},
                    status_code=409,
                )
            return JSONResponse(
                {
                    "status": "http_accepted",
                    "run_id": str(run["run_id"]),
                    "occurrence_status": (applied.get("run") or {}).get("status"),
                    "callback_status": "legacy_accepted",
                }
            )

        try:
            decision = storage.accept_scheduled_terminal_callback_result(
                owner_id=user_id,
                work_id=str(run["run_id"]),
                payload=payload,
                callback_contract=EXTERNAL_WORK_TERMINAL_CALLBACK_CONTRACT,
            )
        except ValueError:
            return JSONResponse(
                {"status": "error", "reason": "invalid_terminal_identity"},
                status_code=400,
            )

        def terminal_response(status_code: int, persisted: bool) -> JSONResponse:
            return JSONResponse(
                {
                    "status": "http_accepted" if status_code < 300 else "error",
                    "run_id": str(run["run_id"]),
                    "occurrence_status": run.get("status"),
                    "callback_persisted": persisted,
                    "callback_status": str(decision.get("callback_status") or ""),
                    "callback_id": str(decision.get("callback_id") or ""),
                    "result_revision": decision.get("result_revision"),
                    "result_digest": str(decision.get("result_digest") or ""),
                    "current_result_revision": decision.get("current_result_revision"),
                    "current_result_digest": str(decision.get("current_result_digest") or ""),
                    "current_callback_id": str(decision.get("current_callback_id") or ""),
                },
                status_code=status_code,
            )

        callback_status = str(decision.get("callback_status") or "")
        if callback_status in {"superseded", "conflict"}:
            return terminal_response(409, False)
        if callback_status == "effects_in_progress":
            return terminal_response(425, False)
        if callback_status == "idempotent":
            return terminal_response(200, False)
        effect_lease = storage.claim_scheduled_terminal_callback_effect(
            owner_id=user_id,
            work_id=str(run["run_id"]),
            result_revision=int(decision["result_revision"]),
            result_digest=str(decision["result_digest"]),
        )
        if not effect_lease.get("claimed"):
            return terminal_response(425, False)
        lease_token = str(effect_lease["lease_token"])
        if not storage.scheduled_terminal_callback_effect_is_current(
            owner_id=user_id,
            work_id=str(run["run_id"]),
            result_revision=int(decision["result_revision"]),
            result_digest=str(decision["result_digest"]),
            lease_token=lease_token,
        ):
            return terminal_response(409, False)
        updates = _external_work_callback_updates(
            run, payload, datetime.now(timezone.utc).isoformat()
        )
        applied = storage.update_scheduled_prompt_run_if_current(
            str(run["run_id"]),
            updates,
            expected_status=str(run.get("status") or ""),
            expected_error_class=run.get("error_class"),
        )
        if not applied.get("updated"):
            storage.release_scheduled_terminal_callback_effect(
                owner_id=user_id,
                work_id=str(run["run_id"]),
                result_revision=int(decision["result_revision"]),
                result_digest=str(decision["result_digest"]),
                lease_token=lease_token,
            )
            return JSONResponse(
                {"status": "error", "reason": "callback_effect_not_persisted"},
                status_code=503,
            )
        if not storage.complete_scheduled_terminal_callback_effect(
            owner_id=user_id,
            work_id=str(run["run_id"]),
            result_revision=int(decision["result_revision"]),
            result_digest=str(decision["result_digest"]),
            lease_token=lease_token,
        ):
            return JSONResponse(
                {"status": "error", "reason": "callback_effect_lost"}, status_code=503
            )
        decision = {**decision, "callback_status": "accepted"}
        run = applied.get("run") or run
        return terminal_response(200, True)

    # === VIVENTIUM START ===
    # Feature: Signed GlassHive completion callback for Workbench scheduled prompts.
    def _glasshive_callback_secret() -> str:
        return (
            os.getenv("SCHEDULING_GLASSHIVE_CALLBACK_SECRET")
            or os.getenv("VIVENTIUM_GLASSHIVE_CALLBACK_SECRET")
            or os.getenv("SCHEDULER_LIBRECHAT_SECRET")
            or os.getenv("VIVENTIUM_SCHEDULER_SECRET")
            or ""
        ).strip()

    def _verify_glasshive_signature(payload: bytes, signature: str, worker_id: str, run_id: str) -> bool:
        secret = _glasshive_callback_secret()
        if not secret or not signature or not worker_id:
            return False
        binding = f"{worker_id}:{run_id}".encode("utf-8")
        derived_secret = hmac.new(secret.encode("utf-8"), binding, hashlib.sha256).hexdigest().encode("utf-8")
        expected = "sha256=" + hmac.new(derived_secret, payload, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, signature)

    _local_path_re = re.compile(r"(?:/Users|/home|/private/var|/var/folders)/[^\s`'\"<>]+")
    _url_re = re.compile(r"https?:\/\/[^\s`'\"<>)]*", re.IGNORECASE)
    _mongo_uri_re = re.compile(r"mongodb(?:\+srv)?:\/\/[^\s`'\"<>]+", re.IGNORECASE)
    _bearer_re = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE)

    def _safe_callback_summary(payload: Dict[str, Any], status: str, error_class: str | None) -> str:
        event = str(payload.get("event") or "").strip()
        if status == "completed":
            return "GlassHive run completed. Private details are stored in the run detail file."
        if status == "failed":
            raw = str(payload.get("error") or error_class or event or "GlassHive run failed").strip()
        elif event == "run.waiting_on_capacity":
            raw = "GlassHive run is waiting for host worker capacity and will retry."
        elif status == "running":
            raw = "GlassHive run started."
        else:
            raw = event or "GlassHive callback received."
        raw = _mongo_uri_re.sub("<mongo-uri>", raw)
        raw = _bearer_re.sub("Bearer <redacted>", raw)
        raw = _url_re.sub("<url>", raw)
        raw = _local_path_re.sub("<local-path>", raw)
        raw = re.sub(r"\s+", " ", raw).strip()
        return raw[:240] + ("..." if len(raw) > 240 else "")

    def _hash_payload_text(payload: Dict[str, Any]) -> str | None:
        text = str(payload.get("message") or payload.get("full_message") or payload.get("error") or "")
        if not text:
            return None
        return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]

    def _append_private_callback(run: Dict[str, Any], payload: Dict[str, Any], received_at: str) -> Dict[str, Any]:
        path_value = str(run.get("private_detail_path") or "").strip()
        if not path_value:
            return {}
        path = Path(path_value).expanduser()
        try:
            data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        except Exception:
            data = {}
        callbacks = data.get("callbacks") if isinstance(data.get("callbacks"), list) else []
        callbacks.append({"received_at": received_at, "payload": payload})
        data["callbacks"] = callbacks[-20:]
        try:
            path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            os.chmod(path, 0o600)
        except OSError:
            pass
        return data if isinstance(data, dict) else {}

    def _update_parent_task_for_glasshive_callback(
        run: Dict[str, Any],
        *,
        status: str,
        result_summary: str,
        error_class: str | None,
        payload: Dict[str, Any],
        received_at: str,
    ) -> None:
        task_id = str(run.get("task_id") or "").strip()
        user_id = str(run.get("user_id") or "").strip()
        if not task_id or not user_id:
            return
        event = str(payload.get("event") or "").strip()
        delivery = {
            "outcome": "failed" if status == "failed" else ("sent" if status == "completed" else "queued"),
            "reason": error_class or event or status,
            "generated_text": None,
            "scheduled_prompt_run_id": run.get("run_id"),
            "glasshive_run_id": run.get("glasshive_run_id"),
        }
        updates: Dict[str, Any] = {
            "updated_at": received_at,
            "last_run_at": run.get("started_at") or run.get("due_at") or received_at,
            "last_delivery_at": received_at,
            "last_delivery_outcome": delivery["outcome"],
            "last_delivery_reason": result_summary,
            "last_generated_text": None,
            "last_delivery": delivery,
        }
        if status == "completed":
            updates["last_status"] = "success"
            updates["last_error"] = None
        elif status == "failed":
            updates["last_status"] = "error"
            updates["last_error"] = result_summary
        else:
            updates["last_status"] = "running"
            updates["last_error"] = None
        storage.update_task(user_id, task_id, updates)

    def _proposal_files(my_folder: str, started_at: str | None) -> list[Path]:
        root = Path(my_folder).expanduser()
        if not root.is_dir():
            return []
        try:
            started_ts = datetime.fromisoformat(str(started_at).replace("Z", "+00:00")).timestamp() if started_at else 0
        except Exception:
            started_ts = 0
        paths = []
        for path in root.glob("*.json"):
            lowered = path.name.lower()
            if "memory" not in lowered or "proposal" not in lowered:
                continue
            try:
                if path.stat().st_mtime + 2 < started_ts:
                    continue
            except OSError:
                continue
            paths.append(path)
        return sorted(paths, key=lambda item: item.stat().st_mtime if item.exists() else 0, reverse=True)

    def _find_memory_proposal_helper() -> Path | None:
        for parent in Path(__file__).resolve().parents:
            candidate = parent / "scripts" / "viventium-memory-proposal-apply.js"
            if candidate.exists():
                return candidate
        return None

    def _maybe_apply_governed_memory(run: Dict[str, Any], private_detail: Dict[str, Any]) -> dict[str, Any] | None:
        if str(private_detail.get("memory_write_mode") or "").strip() != "apply_governed":
            return None
        my_folder = str(private_detail.get("my_folder") or "").strip()
        user_id = str(private_detail.get("user_id") or run.get("user_id") or "").strip()
        if not my_folder or not user_id:
            return {"ok": False, "reason": "missing_my_folder_or_user"}
        proposal = next(iter(_proposal_files(my_folder, run.get("started_at"))), None)
        if not proposal:
            return {"ok": False, "reason": "no_structured_memory_proposal"}
        helper = _find_memory_proposal_helper()
        if not helper:
            return {"ok": False, "reason": "helper_unavailable"}
        completed = subprocess.run(
            ["node", str(helper), "--proposal", str(proposal), "--user-id", user_id, "--apply", "--json"],
            cwd=str(helper.parents[1]),
            text=True,
            capture_output=True,
            timeout=45,
            check=False,
        )
        try:
            result = json.loads(completed.stdout.strip() or "{}")
        except json.JSONDecodeError:
            result = {"ok": False, "reason": "invalid_helper_json"}
        if completed.returncode not in {0, 2}:
            result = {"ok": False, "reason": "helper_failed"}
        private_detail["memory_apply"] = result
        try:
            detail_path = Path(str(run.get("private_detail_path") or "")).expanduser()
            if detail_path:
                detail_path.write_text(json.dumps(private_detail, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                os.chmod(detail_path, 0o600)
        except OSError:
            pass
        return result

    @mcp.custom_route("/internal/scheduled-prompts/glasshive-callback", methods=["POST"])
    async def glasshive_scheduled_prompt_callback(request: Request) -> Response:
        raw = await request.body()
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception:
            return JSONResponse({"status": "error", "reason": "invalid_json"}, status_code=400)
        if not isinstance(payload, dict):
            return JSONResponse({"status": "error", "reason": "invalid_payload"}, status_code=400)

        worker_id = str(payload.get("worker_id") or "").strip()
        run_id = str(payload.get("run_id") or "").strip()
        signature = request.headers.get("x-glasshive-signature", "")
        if not _verify_glasshive_signature(raw, signature, worker_id, run_id):
            return JSONResponse({"status": "error", "reason": "invalid_signature"}, status_code=401)

        event = str(payload.get("event") or "").strip()
        if event.startswith("worker.") and not run_id:
            return JSONResponse({"status": "http_accepted", "ignored": event})

        run = storage.get_scheduled_prompt_run_by_glasshive_run(run_id)
        callback_run_id = str(payload.get("message_id") or payload.get("scheduled_prompt_run_id") or "").strip()
        if not run and callback_run_id:
            run = storage.get_scheduled_prompt_run(callback_run_id)
        if not run:
            return JSONResponse({"status": "error", "reason": "unknown_run"}, status_code=404)

        now = _now_iso()
        terminal_before_callback = str(run.get("status") or "") in {"completed", "failed"}
        callback_reconciliation_allowed = _glasshive_callback_reconciliation_allowed(run, event)
        status, disposition, completed_at, error_class = _glasshive_callback_lifecycle(
            run, event, payload, now
        )

        private_detail = _append_private_callback(run, payload, now)
        # GlassHive now mints and revokes capability grants inside the execution boundary. Scheduling
        # Cortex persists only identity/work references and must never receive broker credentials.
        capability_revocation: Dict[str, Any] | None = None
        memory_apply = _maybe_apply_governed_memory(run, private_detail) if event == "run.completed" else None
        if memory_apply and not memory_apply.get("ok"):
            error_class = str(memory_apply.get("reason") or "memory_apply_blocked")
            result_summary = f"GlassHive run completed; governed memory apply blocked: {error_class}."
        elif memory_apply and memory_apply.get("ok"):
            result_summary = "GlassHive run completed; governed memory proposal applied."
        else:
            result_summary = _safe_callback_summary(payload, status, error_class)

        callback_summary = {
            "event": event,
            "received_at": now,
            "status": status,
            "message_hash": _hash_payload_text(payload),
            "has_private_payload": bool(payload.get("message") or payload.get("full_message") or payload.get("error")),
            "memory_apply_reason": memory_apply.get("reason") if isinstance(memory_apply, dict) else None,
            "capability_revocation_status": (
                capability_revocation.get("status")
                if isinstance(capability_revocation, dict)
                else None
            ),
            "effort_projection": {
                "requested": str((payload.get("effort_projection") or {}).get("requested") or "")[:32],
                "effective": str((payload.get("effort_projection") or {}).get("effective") or "")[:32],
                "fallback_reason": str(
                    (payload.get("effort_projection") or {}).get("fallback_reason") or ""
                )[:64],
            }
            if isinstance(payload.get("effort_projection"), dict)
            else None,
        }

        if not terminal_before_callback or callback_reconciliation_allowed:
            storage.update_scheduled_prompt_run(
                str(run["run_id"]),
                {
                    "status": status,
                    "disposition": disposition,
                    "completed_at": completed_at,
                    "result_summary": result_summary or run.get("result_summary"),
                    "error_class": error_class,
                    "callback_payload_json": json.dumps(callback_summary),
                    "updated_at": now,
                },
            )
            _update_parent_task_for_glasshive_callback(
                run,
                status=status,
                result_summary=result_summary or str(run.get("result_summary") or ""),
                error_class=error_class,
                payload=payload,
                received_at=now,
            )
            if event == "run.completed":
                _refresh_workbench_periphery_index(run)
        return JSONResponse({"status": "http_accepted", "run_id": run["run_id"]})
    # === VIVENTIUM END ===

    # === VIVENTIUM START ===
    # Feature: Authoritative GlassHive workspace recurrence owner.
    # Purpose: Viventium keeps one durable definition and one polling engine in Scheduling Cortex.
    @mcp.custom_route("/internal/glasshive/recurring-schedules", methods=["POST"])
    async def glasshive_recurring_schedules(request: Request) -> Response:
        expected_secret = str(os.getenv("VIVENTIUM_SCHEDULER_SECRET") or "").strip()
        provided_secret = str(request.headers.get("x-viventium-scheduler-secret") or "").strip()
        if not expected_secret:
            return JSONResponse(
                {"error": "Viventium Scheduling Cortex owner is unavailable", "code": "owner_unavailable"},
                status_code=503,
            )
        if not provided_secret or not hmac.compare_digest(provided_secret, expected_secret):
            return JSONResponse(
                {"error": "Unauthorized scheduling owner request", "code": "owner_unauthorized"},
                status_code=401,
            )
        raw = await request.body()
        if len(raw) > 1_048_576:
            return JSONResponse(
                {"error": "Scheduling owner request is too large", "code": "invalid_schedule"},
                status_code=413,
            )
        try:
            body = json.loads(raw.decode("utf-8")) if raw else {}
        except (UnicodeDecodeError, json.JSONDecodeError):
            return JSONResponse(
                {"error": "Scheduling owner request is invalid", "code": "invalid_schedule"},
                status_code=400,
            )
        if not isinstance(body, dict) or not isinstance(body.get("payload"), dict):
            return JSONResponse(
                {"error": "Scheduling owner request is invalid", "code": "invalid_schedule"},
                status_code=400,
            )
        tenant_id = str(body.get("tenant_id") or "").strip()
        owner_id = str(body.get("owner_id") or "").strip()
        agent_id = str(body.get("agent_id") or "scheduling-cortex").strip()
        asserted_tenant = str(request.headers.get("x-viventium-tenant-id") or "").strip()
        asserted_owner = str(request.headers.get("x-viventium-user-id") or "").strip()
        asserted_agent = str(request.headers.get("x-viventium-agent-id") or "").strip()
        if (
            not tenant_id
            or not owner_id
            or tenant_id != asserted_tenant
            or owner_id != asserted_owner
            or (asserted_agent and agent_id != asserted_agent)
        ):
            return JSONResponse(
                {"error": "Scheduling owner identity does not match", "code": "owner_identity_mismatch"},
                status_code=403,
            )
        try:
            result = glasshive_workspace_schedules.handle(
                str(body.get("action") or "").strip(),
                body["payload"],
                tenant_id=tenant_id,
                owner_id=owner_id,
                agent_id=agent_id,
            )
            return JSONResponse({"result": result})
        except WorkspaceScheduleError as exc:
            return JSONResponse(
                {"error": str(exc), "code": exc.code},
                status_code=exc.status,
            )
        except Exception:
            logger.exception("[scheduling-cortex] GlassHive recurrence owner request failed")
            return JSONResponse(
                {"error": "Viventium Scheduling Cortex request failed", "code": "owner_failed"},
                status_code=503,
            )
    # === VIVENTIUM END ===

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
            channel_value = list(DEFAULT_DELIVERY_CHANNELS)

        task = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "agent_id": agent_id,
            "prompt": prompt,
            "schedule": schedule,
            "channel": channel_value,
            "executor": "viventium_agent",
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

    @mcp.tool(
        description=_tool_description(
            what="List metadata for this user's validated private periphery modules and artifacts without loading their bodies.",
            use_when="The user asks what Viventium noticed overnight, asks for risks or blind spots, or a deep planning/review task may benefit from optional nightly evidence.",
            avoid_when="Ordinary conversation does not need periphery evidence, or the user has not asked for reflective/risk/opportunity review.",
            inputs="Optional user_id; it is auto-injected from the authenticated request when omitted.",
            returns="A bounded current/historical insight index with opaque references, freshness, quality, and evidence counts; no insight body or storage metadata.",
            failure_modes="Missing identity, Workbench reader unavailable, or no artifacts; an empty list is a valid result and must not be described as hidden insight.",
            idempotency="Read-only; list before read and do not create, modify, or duplicate artifacts.",
            delayed_callback="No delayed callback; this reads the current private index.",
        )
    )
    def periphery_list(args: PeripheryListArgs) -> Dict[str, Any]:
        user_id = _resolve_user_id(args.user_id)
        reader = _import_workbench_scheduled_prompts()
        return _serialize_periphery_list_for_agent(reader.list_user_periphery(user_id=user_id))

    @mcp.tool(
        description=_tool_description(
            what="Read one private periphery insight selected from periphery_list through a compact evidence and uncertainty view.",
            use_when="A listed artifact is relevant to the user's explicit blind-spot, risk, opportunity-cost, opportunity, or deep-review request.",
            avoid_when="No prior list result exists, the artifact is irrelevant, or ordinary chat does not need private nightly evidence.",
            inputs="The opaque artifact_id from periphery_list and optional user_id; user_id is auto-injected when omitted.",
            returns="A compact evidence view with claim text, uncertainty, freshness, and grounding counts; storage paths, run references, source-record ids, and duplicate markdown remain private.",
            failure_modes="Missing identity, unknown/foreign artifact, invalid sidecar, missing markdown, or unavailable Workbench reader.",
            idempotency="Read-only; use the exact artifact reference returned by periphery_list and do not guess paths or ids.",
            delayed_callback="No delayed callback; this reads one current private artifact.",
        )
    )
    def periphery_read(args: PeripheryReadArgs) -> Dict[str, Any]:
        user_id = _resolve_user_id(args.user_id)
        reader = _import_workbench_scheduled_prompts()
        return _serialize_periphery_read_for_agent(
            reader.read_user_periphery_artifact(
                user_id=user_id,
                artifact_id=args.artifact_id,
            )
        )

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
                "prompt, schedule, optional channel, conversation_policy, active, metadata. "
                "schedule.type is required; for one-time work use "
                "{'type': 'once', 'run_at': '<ISO datetime>', 'timezone': '<IANA timezone>'}. "
                "Use viventium_agent for ordinary schedules; glasshive_host is reserved for "
                "Prompt Workbench-owned schedules. "
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
        if args.executor == "glasshive_host" and not isinstance(
            (args.metadata or {}).get("workbench_scheduled_prompt"), dict
        ):
            raise ValueError(
                "glasshive_host is reserved for Prompt Workbench schedules; "
                "use viventium_agent for an ordinary scheduled request"
            )
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

        metadata = _metadata_with_required_capability_servers(
            args.metadata,
            args.required_capability_servers,
            executor=args.executor,
        )
        task = {
            "id": str(uuid.uuid4()),
            "user_id": user_id,
            "agent_id": agent_id,
            "prompt": args.prompt,
            "schedule": schedule,
            # === VIVENTIUM NOTE ===
            # Feature: Store normalized channel(s) for dispatch fan-out.
            "channel": channel_value,
            "executor": args.executor,
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
            "metadata": metadata or None,
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
        must_validate_future = args.schedule is not None or args.active is True
        next_run = compute_next_run(schedule, now, None) if schedule and must_validate_future else None
        if must_validate_future and schedule and schedule.get("type") == "once" and not next_run:
            run_at = schedule.get("run_at") if isinstance(schedule, dict) else None
            raise ValueError(
                f"run_at {run_at} must be in the future (now: {to_utc_iso(now)})"
            )

        effective_executor = args.executor or str(existing.get("executor") or "viventium_agent")
        current_required_capabilities = _required_capability_servers_from_metadata(
            existing.get("metadata")
        )
        selected_required_capabilities = (
            current_required_capabilities
            if args.required_capability_servers is None
            else args.required_capability_servers
        )
        effective_metadata = _metadata_with_required_capability_servers(
            args.metadata if args.metadata is not None else existing.get("metadata"),
            selected_required_capabilities,
            executor=effective_executor,
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
        if args.executor is not None:
            updates["executor"] = args.executor
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
        if (
            args.metadata is not None
            or args.required_capability_servers is not None
            or args.executor is not None
        ):
            updates["metadata"] = effective_metadata or None
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
    # === VIVENTIUM START ===
    # Local-only installs fail closed to loopback unless a future declared remote boundary owns exposure.
    parser.add_argument("--host", default=os.getenv("SCHEDULER_HOST", "127.0.0.1"))
    # === VIVENTIUM END ===
    parser.add_argument("--port", type=int, default=int(os.getenv("SCHEDULER_PORT", DEFAULT_PORT)))
    args = parser.parse_args()

    log_level = os.getenv("SCHEDULER_LOG_LEVEL", "INFO").upper()
    logging.basicConfig(level=log_level, format="%(asctime)s %(levelname)s %(name)s - %(message)s")

    db_path = os.getenv("SCHEDULING_DB_PATH") or _default_scheduling_db_path()
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
