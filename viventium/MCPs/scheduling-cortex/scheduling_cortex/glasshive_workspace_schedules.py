# === VIVENTIUM START ===
# Purpose: Make Scheduling Cortex the authoritative GlassHive workspace recurrence owner.
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# === VIVENTIUM END ===

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Any

from .storage import ScheduleStorage
from .utils import to_utc_iso
from .workspace_recurrence import first_occurrence_at, normalize_recurrence_spec

WORKSPACE_METADATA_KEY = "glasshive_workspace_schedule"
SUPPORTED_ACTIONS = {
    "create",
    "list",
    "get",
    "update",
    "deactivate",
    "retire",
    "run_now",
    "occurrences",
    "deactivate_owner",
}
_ID_RE = re.compile(r"^[A-Za-z0-9_.:@-]{1,200}$")
_CAPABILITY_SERVER_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,120}$")


class WorkspaceScheduleError(ValueError):
    def __init__(self, message: str, *, code: str = "invalid_schedule", status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


def _id(value: object, label: str) -> str:
    normalized = str(value or "").strip()
    if not _ID_RE.fullmatch(normalized):
        raise WorkspaceScheduleError(f"{label} is invalid")
    return normalized


def _metadata(task: dict[str, Any]) -> dict[str, Any]:
    metadata = task.get("metadata")
    if not isinstance(metadata, dict):
        return {}
    workspace = metadata.get(WORKSPACE_METADATA_KEY)
    return workspace if isinstance(workspace, dict) else {}


def _execution_mode(value: object) -> str:
    mode = str(value or "docker").strip().lower()
    if mode not in {"host", "docker"}:
        raise WorkspaceScheduleError("Workspace execution_mode must be host or docker")
    return mode


def _required_capability_servers(value: object) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise WorkspaceScheduleError("required_capability_servers must be a list")
    normalized = sorted({str(item or "").strip() for item in value})
    if any(not _CAPABILITY_SERVER_RE.fullmatch(item) for item in normalized):
        raise WorkspaceScheduleError("required_capability_servers contains an invalid server name")
    if len(normalized) > 32:
        raise WorkspaceScheduleError("required_capability_servers may contain at most 32 entries")
    return normalized


def _cortex_schedule(spec: dict[str, Any]) -> dict[str, Any]:
    try:
        return normalize_recurrence_spec(
            recurrence_type=str(spec.get("recurrence_type") or ""),
            interval_seconds=spec.get("interval_seconds"),
            local_time=str(spec.get("local_time") or ""),
            timezone_name=str(spec.get("timezone_name") or "UTC"),
            dst_policy=str(spec.get("dst_policy") or "next_valid_earliest"),
            cron_expression=str(spec.get("cron_expression") or ""),
            rrule=str(spec.get("rrule") or ""),
            starts_at=str(spec.get("starts_at") or "") or None,
            ends_at=str(spec.get("ends_at") or "") or None,
            enabled=bool(spec.get("enabled", True)),
            overlap_policy=str(spec.get("overlap_policy") or "skip"),
            misfire_grace_seconds=int(spec.get("misfire_grace_seconds") or 0),
            catch_up_policy=str(spec.get("catch_up_policy") or "skip"),
            max_catch_up_occurrences=int(spec.get("max_catch_up_occurrences") or 1),
            jitter_seconds=int(spec.get("jitter_seconds") or 0),
        )
    except (TypeError, ValueError) as exc:
        raise WorkspaceScheduleError(str(exc), status=422) from exc


def _normalized_spec(spec: dict[str, Any], schedule: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(spec)
    normalized.update({key: value for key, value in schedule.items() if key != "type"})
    return normalized


def _definition(task: dict[str, Any]) -> dict[str, Any]:
    spec = _metadata(task)
    retired_at = spec.get("retired_at")
    active = bool(task.get("active")) and not retired_at
    last_outcome = str(task.get("last_status") or task.get("last_delivery_outcome") or "").strip()
    last_error = str(task.get("last_error") or "").strip()
    if not last_error and last_outcome in {
        "action_required",
        "error",
        "failed",
        "missed",
        "partial_success",
        "terminal",
    }:
        last_error = str(task.get("last_delivery_reason") or "").strip()
    return {
        "definition_id": task["id"],
        "project_id": spec.get("project_id"),
        "worker_id": spec.get("worker_id"),
        "tenant_id": spec.get("tenant_id") or "local",
        "owner_id": task.get("user_id"),
        "scheduler_owner": "viventium_cortex",
        "schedule_owner": "viventium_cortex",
        "owner_action": "dispatch_via_viventium_cortex",
        "instruction": task.get("prompt") or "",
        "schedule_text": spec.get("schedule_text") or "",
        "recurrence_type": spec.get("recurrence_type"),
        "interval_seconds": spec.get("interval_seconds"),
        "local_time": spec.get("local_time") or "",
        "timezone_name": spec.get("timezone_name") or "UTC",
        "dst_policy": spec.get("dst_policy") or "next_valid_earliest",
        "cron_expression": spec.get("cron_expression") or "",
        "rrule": spec.get("rrule") or "",
        "starts_at": spec.get("starts_at"),
        "ends_at": spec.get("ends_at"),
        "enabled": active,
        "overlap_policy": spec.get("overlap_policy") or "skip",
        "misfire_grace_seconds": int(spec.get("misfire_grace_seconds") or 300),
        "catch_up_policy": spec.get("catch_up_policy") or "skip",
        "max_catch_up_occurrences": int(spec.get("max_catch_up_occurrences") or 1),
        "jitter_seconds": int(spec.get("jitter_seconds") or 0),
        "next_run_at": str(task.get("next_run_at") or ""),
        "next_occurrence_at": str(task.get("next_run_at") or ""),
        "last_occurrence_at": task.get("last_run_at"),
        "last_outcome": last_outcome,
        "last_error": last_error,
        "last_delivery_outcome": task.get("last_delivery_outcome"),
        "last_delivery_reason": task.get("last_delivery_reason"),
        "last_delivery_at": task.get("last_delivery_at"),
        "retired_at": retired_at,
        "active": active,
        "created_at": task.get("created_at"),
        "updated_at": task.get("updated_at"),
    }


def _occurrence(run: dict[str, Any], definition: dict[str, Any]) -> dict[str, Any]:
    status = str(run.get("status") or "queued")
    state = {
        "dispatching": "running",
        "queued": "queued",
        "running": "running",
        "completed": "completed",
        "failed": "failed",
        "skipped": "skipped",
    }.get(status, "queued")
    failure_class = str(run.get("error_class") or "").strip()
    outcome = failure_class if state in {"failed", "skipped"} and failure_class else status
    return {
        "occurrence_id": run["run_id"],
        "definition_id": definition["definition_id"],
        "tenant_id": definition["tenant_id"],
        "owner_id": definition["owner_id"],
        "scheduled_for": run.get("due_at") or run.get("created_at"),
        "detected_at": run.get("started_at") or run.get("created_at"),
        "scheduled_run_id": run["run_id"],
        "idempotency_key": run["run_id"],
        "claimant": "viventium_cortex",
        "claimed_at": run.get("claimed_at") or run.get("started_at"),
        "claim_expires_at": run.get("claim_expires_at"),
        "attempt_count": int(run.get("attempt_count") or 0),
        "outcome": outcome,
        "terminal_at": run.get("completed_at"),
        "created_at": run.get("created_at"),
        "state": state,
        "queued_run_id": run.get("glasshive_run_id"),
        "last_error": (
            failure_class or str(run.get("result_summary") or "")
            if state in {"failed", "skipped"}
            else ""
        ),
    }


class GlassHiveWorkspaceScheduleService:
    def __init__(self, storage: ScheduleStorage) -> None:
        self.storage = storage

    def _task(self, owner_id: str, definition_id: object) -> dict[str, Any] | None:
        task = self.storage.get_task(owner_id, _id(definition_id, "definition_id"))
        return task if task and _metadata(task) else None

    def _list_tasks(self, owner_id: str) -> list[dict[str, Any]]:
        return [
            task
            for task in self.storage.list_tasks(owner_id, active_only=False, limit=500, offset=0)
            if _metadata(task)
        ]

    def handle(
        self,
        action: str,
        payload: dict[str, Any],
        *,
        tenant_id: str,
        owner_id: str,
        agent_id: str,
    ) -> object:
        if action not in SUPPORTED_ACTIONS:
            raise WorkspaceScheduleError("Unsupported scheduling owner action")
        tenant_id = _id(tenant_id, "tenant_id")
        owner_id = _id(owner_id, "owner_id")
        agent_id = _id(agent_id, "agent_id")
        payload = payload if isinstance(payload, dict) else {}

        if action == "create":
            spec = dict(payload)
            spec["tenant_id"] = tenant_id
            spec["owner_id"] = owner_id
            spec["project_id"] = _id(spec.get("project_id"), "project_id")
            spec["worker_id"] = _id(spec.get("worker_id"), "worker_id")
            spec["execution_mode"] = _execution_mode(spec.get("execution_mode"))
            spec["required_capability_servers"] = _required_capability_servers(
                spec.get("required_capability_servers")
            )
            schedule = _cortex_schedule(spec)
            spec = _normalized_spec(spec, schedule)
            now = datetime.now(timezone.utc)
            task_id = _id(spec.get("definition_id") or f"rsd_{uuid.uuid4().hex}", "definition_id")
            existing = self.storage.get_task(owner_id, task_id)
            if existing:
                if _metadata(existing) == spec and str(existing.get("prompt") or "") == str(spec.get("instruction") or ""):
                    return _definition(existing)
                raise WorkspaceScheduleError("Recurring schedule id is already bound", code="schedule_conflict", status=409)
            requested_next_run = str(spec.get("next_run_at") or "") or None
            try:
                next_run_at = to_utc_iso(
                    first_occurrence_at(
                        schedule,
                        now=now,
                        first_run_at=requested_next_run,
                    )
                )
            except ValueError as exc:
                raise WorkspaceScheduleError(str(exc), status=422) from exc
            task = {
                "id": task_id,
                "user_id": owner_id,
                "agent_id": agent_id,
                "prompt": str(spec.get("instruction") or "").strip(),
                "schedule": schedule,
                "channel": "workbench",
                "executor": "glasshive_workspace",
                "conversation_policy": "same",
                "conversation_id": None,
                "last_conversation_id": None,
                "active": 1 if bool(spec.get("enabled", True)) else 0,
                "created_by": f"agent:{agent_id}",
                "created_source": "agent",
                "created_at": to_utc_iso(now),
                "updated_at": to_utc_iso(now),
                "updated_by": f"agent:{agent_id}",
                "updated_source": "agent",
                "last_run_at": None,
                "next_run_at": next_run_at,
                "last_status": None,
                "last_error": None,
                "last_delivery_outcome": None,
                "last_delivery_reason": None,
                "last_delivery_at": None,
                "last_generated_text": None,
                "last_delivery": None,
                "metadata": {WORKSPACE_METADATA_KEY: spec},
            }
            self.storage.create_task(task)
            return _definition(task)

        if action == "list":
            worker_id = str(payload.get("worker_id") or "").strip()
            include_inactive = bool(payload.get("include_inactive"))
            limit = max(1, min(int(payload.get("limit") or 100), 100))
            definitions = []
            for task in self._list_tasks(owner_id):
                definition = _definition(task)
                if definition["tenant_id"] != tenant_id:
                    continue
                if worker_id and definition["worker_id"] != worker_id:
                    continue
                if not include_inactive and not definition["active"]:
                    continue
                definitions.append(definition)
                if len(definitions) >= limit:
                    break
            return definitions

        if action == "deactivate_owner":
            deactivated = self.storage.deactivate_glasshive_workspace_tasks_for_owner(
                user_id=owner_id,
                tenant_id=tenant_id,
                updated_at=to_utc_iso(datetime.now(timezone.utc)),
            )
            return {"deactivated": deactivated}

        task = self._task(owner_id, payload.get("definition_id"))
        if not task or str(_metadata(task).get("tenant_id") or "") != tenant_id:
            raise WorkspaceScheduleError("Recurring schedule not found", code="schedule_not_found", status=404)

        if action == "get":
            return _definition(task)
        if action == "occurrences":
            definition = _definition(task)
            limit = max(1, min(int(payload.get("limit") or 50), 100))
            return [
                _occurrence(run, definition)
                for run in self.storage.list_scheduled_prompt_runs(task_id=task["id"], limit=limit)
            ]
        if action in {"deactivate", "retire"}:
            workspace = dict(_metadata(task))
            updates: dict[str, Any] = {"active": 0, "updated_at": to_utc_iso(datetime.now(timezone.utc))}
            if action == "retire":
                workspace["retired_at"] = updates["updated_at"]
                updates["metadata"] = {WORKSPACE_METADATA_KEY: workspace}
            updated = self.storage.update_task(owner_id, task["id"], updates)
            return _definition(updated or task)
        if action == "update":
            current = dict(_metadata(task))
            if current.get("retired_at"):
                raise WorkspaceScheduleError("Retired schedule cannot be changed", code="schedule_retired", status=409)
            requested = payload.get("updates")
            requested = requested if isinstance(requested, dict) else {}
            merged = {**current, **requested, "tenant_id": tenant_id, "owner_id": owner_id}
            merged["execution_mode"] = _execution_mode(merged.get("execution_mode"))
            merged["required_capability_servers"] = _required_capability_servers(
                merged.get("required_capability_servers")
            )
            schedule = _cortex_schedule(merged)
            merged = _normalized_spec(merged, schedule)
            now = datetime.now(timezone.utc)
            try:
                next_run = (
                    first_occurrence_at(schedule, now=now)
                    if bool(merged.get("enabled", True))
                    else None
                )
            except ValueError as exc:
                raise WorkspaceScheduleError(str(exc), status=422) from exc
            updates = {
                "prompt": str(merged.get("instruction") or task.get("prompt") or "").strip(),
                "schedule": schedule,
                "active": 1 if bool(merged.get("enabled", True)) else 0,
                "next_run_at": to_utc_iso(next_run) if next_run else None,
                "metadata": {WORKSPACE_METADATA_KEY: merged},
                "updated_at": to_utc_iso(now),
                "updated_by": f"agent:{agent_id}",
                "updated_source": "agent",
            }
            updated = self.storage.update_task(owner_id, task["id"], updates)
            return _definition(updated or task)

        idempotency_key = _id(payload.get("idempotency_key"), "idempotency_key")
        manual = dict(task)
        manual_metadata = dict(task.get("metadata") or {})
        workspace = dict(_metadata(task))
        workspace["manual_occurrence_key"] = idempotency_key
        manual_metadata[WORKSPACE_METADATA_KEY] = workspace
        manual["metadata"] = manual_metadata
        manual["next_run_at"] = to_utc_iso(datetime.now(timezone.utc))
        from .dispatch import dispatch_task

        result = dispatch_task(manual)
        return {
            "definition_id": task["id"],
            "status": "scheduled",
            "schedule_owner": "viventium_cortex",
            "owner_action": "dispatch_via_viventium_cortex",
            "schedule_id": result.get("scheduled_prompt_run_id"),
            "occurrence_id": result.get("scheduled_prompt_run_id"),
            "queued_run_id": result.get("glasshive_run_id"),
        }
