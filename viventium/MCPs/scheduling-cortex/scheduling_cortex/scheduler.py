# VIVENTIUM START
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# VIVENTIUM END

from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from croniter import croniter

from .dispatch import dispatch_task, normalized_scheduled_generation_failure_class
from .utils import ensure_timezone, parse_time, parse_iso, to_utc_iso, normalize_days, last_day_of_month
from .storage import ScheduleStorage

logger = logging.getLogger(__name__)

DEFAULT_CATCH_UP_MAX_LATE_S = 12 * 60 * 60
HARD_CATCH_UP_MAX_LATE_S = 24 * 60 * 60
MISFIRE_POLICY_KEY = "misfire_policy"
SCHEDULER_MISFIRE_KEY = "scheduler_misfire"
STALE_INTERNAL_METADATA_KEYS = frozenset(
    {
        "heartbeat_quiet_streak",
        "heartbeat_last_pulse_at",
    }
)

DEFERRED_FALLBACK_REASON_MARKERS = (
    "deferred_fallback",
    "empty_deferred_response",
    "insight_fallback",
)


def _has_deferred_fallback_marker(value: object) -> bool:
    reason = str(value or "").strip()
    return any(marker in reason for marker in DEFERRED_FALLBACK_REASON_MARKERS)


def _channel_deferred_fallback_reason(
    channel: object,
    detail: object,
) -> str:
    if not isinstance(detail, dict):
        return ""
    outcome = str(detail.get("outcome") or "").strip()
    reason = str(detail.get("reason") or "").strip()
    fallback_delivered = detail.get("fallback_delivered") is True
    if not fallback_delivered and outcome != "fallback_delivered" and not _has_deferred_fallback_marker(reason):
        return ""
    if not reason:
        return "deferred_fallback"
    channel_name = str(channel or "").strip()
    if channel_name and ":" not in reason:
        return f"{channel_name}:{reason}"
    return reason


def _delivery_detail_deferred_fallback_reason(delivery_detail: Optional[Dict[str, object]]) -> str:
    if not isinstance(delivery_detail, dict):
        return ""
    reason = str(delivery_detail.get("reason") or "").strip()
    if delivery_detail.get("fallback_delivered") is True or _has_deferred_fallback_marker(reason):
        return reason or "deferred_fallback"
    channels = delivery_detail.get("channels")
    if isinstance(channels, dict):
        for channel, detail in channels.items():
            channel_reason = _channel_deferred_fallback_reason(channel, detail)
            if channel_reason:
                return channel_reason
    return ""


def dispatch_run_ledger_updates(
    task: Dict[str, object],
    dispatch_result: Optional[Dict[str, object]],
    *,
    existing_execution: Optional[Dict[str, object]] = None,
    completed_at: Optional[datetime] = None,
) -> Dict[str, object]:
    """Build the canonical terminal ledger fields for scheduled and manual executions."""
    result = dispatch_result if isinstance(dispatch_result, dict) else {}
    delivery = result.get("delivery") if isinstance(result.get("delivery"), dict) else {}
    channels = delivery.get("channels") if isinstance(delivery.get("channels"), dict) else {}
    executor = str(task.get("executor") or "viventium_agent")
    queued = executor == "glasshive_host" and str(delivery.get("outcome") or "") == "queued"
    delivery_outcome = str(delivery.get("outcome") or "").strip().lower()
    channel_errors = result.get("channel_errors") if isinstance(result.get("channel_errors"), dict) else {}
    external_work = (
        result.get("external_work") if isinstance(result.get("external_work"), dict) else {}
    )
    generation_failure = (
        result.get("generation_failure")
        if isinstance(result.get("generation_failure"), dict)
        else None
    )
    required_total = max(0, int(external_work.get("requiredTotal") or 0))
    all_required_terminal = external_work.get("allRequiredTerminal") is True
    required_failed = max(0, int(external_work.get("requiredFailed") or 0))

    if queued:
        disposition = "running"
    elif delivery_outcome == "superseded":
        disposition = "superseded"
    elif channel_errors:
        disposition = "partial"
    elif delivery_outcome in {"sent", "fallback_delivered"}:
        disposition = "delivered"
    elif delivery_outcome in {"suppressed", "audit_only"}:
        disposition = "silent"
    else:
        disposition = "partial"

    interaction_ref = None
    if queued and result.get("glasshive_run_id"):
        interaction_ref = f"glasshive:{result['glasshive_run_id']}"
    elif result.get("conversation_id"):
        interaction_ref = f"conversation:{result['conversation_id']}"

    result_execution = result.get("execution") if isinstance(result.get("execution"), dict) else {}
    execution_snapshot = {**(existing_execution or {}), **result_execution}
    if external_work:
        execution_snapshot["external_work"] = external_work
    finished = completed_at or datetime.now(timezone.utc)
    if generation_failure is not None:
        error_class = normalized_scheduled_generation_failure_class(
            generation_failure.get("error_class")
        )
        return {
            "status": "failed",
            "disposition": "failed",
            "error_class": error_class,
            "result_summary": f"Scheduled generation failed ({error_class}).",
            "execution_snapshot": execution_snapshot,
            "channel_outcomes": channels,
            "interaction_ref": interaction_ref,
            "completed_at": to_utc_iso(finished),
            "lease_owner": None,
            "lease_until": None,
            "updated_at": to_utc_iso(finished),
        }
    if required_total and not all_required_terminal:
        return {
            "status": "waiting_external",
            "disposition": "running",
            "execution_snapshot": execution_snapshot,
            "channel_outcomes": channels,
            "interaction_ref": interaction_ref,
            "completed_at": None,
            "lease_owner": None,
            "lease_until": None,
            "updated_at": to_utc_iso(finished),
        }
    if required_total and all_required_terminal:
        return {
            "status": "failed" if required_failed else "completed",
            "disposition": "failed" if required_failed else "delivered",
            "execution_snapshot": execution_snapshot,
            "channel_outcomes": channels,
            "interaction_ref": interaction_ref,
            "completed_at": to_utc_iso(finished),
            "lease_owner": None,
            "lease_until": None,
            "updated_at": to_utc_iso(finished),
        }
    updates: Dict[str, object] = {
        "status": "queued" if queued else "completed",
        "disposition": disposition,
        "execution_snapshot": execution_snapshot,
        "channel_outcomes": channels,
        "interaction_ref": interaction_ref,
        "updated_at": to_utc_iso(finished),
    }
    if not queued:
        updates["completed_at"] = to_utc_iso(finished)
    return updates


def _deferred_fallback_degradation(
    *,
    delivery_outcome: str,
    delivery_reason: str,
    delivery_detail: Optional[Dict[str, object]] = None,
) -> Optional[Dict[str, object]]:
    reason = str(delivery_reason or "").strip()
    structured_reason = _delivery_detail_deferred_fallback_reason(delivery_detail)
    if delivery_outcome == "fallback_delivered" or _has_deferred_fallback_marker(reason) or structured_reason:
        degradation_reason = reason if _has_deferred_fallback_marker(reason) else structured_reason
        if not degradation_reason:
            degradation_reason = "deferred_fallback" if delivery_outcome == "fallback_delivered" else reason
        return {
            "type": "deferred_fallback",
            "reason": degradation_reason or "deferred_fallback",
        }
    return None


def _is_orphaned_user_failure(error: object) -> bool:
    path = str(getattr(error, "path", "") or "").strip().lower()
    status = getattr(error, "status", None)
    if path != "/api/viventium/scheduler/chat" or status != 404:
        return False
    failure_class = str(getattr(error, "failure_class", "") or "").strip().lower()
    reason = str(getattr(error, "reason", "") or "").strip().lower()
    return failure_class == "user_not_found" or reason == "user_not_found"


# === VIVENTIUM NOTE ===
# Feature: Structured misfire policy and late-reminder catch-up.
# Purpose: User-created one-time reminders should not disappear silently after
# a sleeping/local runtime wakes late. This uses task metadata and structural
# task fields only; it must never inspect prompt text or human-facing labels.
# === VIVENTIUM NOTE ===
def _coerce_int(value: object, default: int) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _clamp_late_window(value: object, default: int) -> int:
    parsed = _coerce_int(value, default)
    if parsed < 0:
        return 0
    return min(parsed, HARD_CATCH_UP_MAX_LATE_S)


def _schedule_timezone(schedule: Dict[str, object]) -> str:
    return str(schedule.get("timezone") or "UTC")


def _format_local_due(schedule: Dict[str, object], due_at: datetime) -> str:
    tz_name = _schedule_timezone(schedule)
    try:
        tz = ensure_timezone(tz_name)
    except Exception:
        tz = timezone.utc
        tz_name = "UTC"
    local_due = due_at.astimezone(tz)
    return f"{local_due.strftime('%Y-%m-%d %H:%M')} {tz_name}"


def _late_minutes(late_seconds: int) -> int:
    if late_seconds <= 0:
        return 0
    return max(1, int(round(late_seconds / 60)))


def _pruned_internal_metadata(task: Dict[str, object]) -> Optional[Dict[str, object]]:
    metadata = task.get("metadata")
    if not isinstance(metadata, dict):
        return None
    if not any(key in metadata for key in STALE_INTERNAL_METADATA_KEYS):
        return None
    return {key: value for key, value in metadata.items() if key not in STALE_INTERNAL_METADATA_KEYS}


def _default_misfire_mode(task: Dict[str, object]) -> str:
    schedule = task.get("schedule") if isinstance(task.get("schedule"), dict) else {}
    if (
        isinstance(schedule, dict)
        and schedule.get("type") == "once"
        and str(task.get("created_source") or "").strip().lower() == "user"
    ):
        return "catch_up"
    return "strict"


def _resolve_misfire_policy(task: Dict[str, object], default_catch_up_max_late_s: int) -> Dict[str, Any]:
    metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    raw_policy = metadata.get(MISFIRE_POLICY_KEY) if isinstance(metadata, dict) else None

    mode = ""
    max_late_s: Optional[int] = None
    if isinstance(raw_policy, dict):
        mode = str(raw_policy.get("mode") or raw_policy.get("action") or "").strip().lower()
        if raw_policy.get("max_late_s") is not None:
            max_late_s = _clamp_late_window(
                raw_policy.get("max_late_s"),
                default_catch_up_max_late_s,
            )
    elif isinstance(raw_policy, str):
        mode = raw_policy.strip().lower()

    if mode in {"skip", "miss", "missed"}:
        mode = "strict"
    if mode not in {"catch_up", "strict"}:
        mode = _default_misfire_mode(task)

    if max_late_s is None:
        max_late_s = _clamp_late_window(default_catch_up_max_late_s, DEFAULT_CATCH_UP_MAX_LATE_S)

    return {
        "mode": mode,
        "max_late_s": max_late_s,
    }


def _late_delivery_metadata(
    task: Dict[str, object],
    due_at: datetime,
    now: datetime,
    late_seconds: int,
    policy: Dict[str, Any],
) -> Dict[str, object]:
    schedule = task.get("schedule") if isinstance(task.get("schedule"), dict) else {}
    schedule_dict = schedule if isinstance(schedule, dict) else {}
    return {
        "mode": "catch_up",
        "policy": policy.get("mode") or "catch_up",
        "due_at": to_utc_iso(due_at),
        "due_at_local": _format_local_due(schedule_dict, due_at),
        "delivered_at": to_utc_iso(now),
        "late_seconds": late_seconds,
        "late_minutes": _late_minutes(late_seconds),
        "max_late_s": policy.get("max_late_s"),
    }


def _with_late_delivery_metadata(
    task: Dict[str, object],
    due_at: datetime,
    now: datetime,
    late_seconds: int,
    policy: Dict[str, Any],
) -> Dict[str, object]:
    patched = dict(task)
    metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    patched_metadata = dict(metadata) if isinstance(metadata, dict) else {}
    patched_metadata[SCHEDULER_MISFIRE_KEY] = _late_delivery_metadata(
        task,
        due_at,
        now,
        late_seconds,
        policy,
    )
    patched["metadata"] = patched_metadata
    return patched


def _scheduler_late_delivery(task: Dict[str, object]) -> Optional[Dict[str, object]]:
    metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    raw = metadata.get(SCHEDULER_MISFIRE_KEY) if isinstance(metadata, dict) else None
    if isinstance(raw, dict):
        return raw
    return None


def _interval_delta(schedule: Dict[str, object]) -> Optional[timedelta]:
    interval = schedule.get("interval") if isinstance(schedule.get("interval"), dict) else {}
    every = int(interval.get("every") or 0)
    unit = str(interval.get("unit") or "")
    units = {
        "minute": timedelta(minutes=every),
        "hour": timedelta(hours=every),
        "day": timedelta(days=every),
        "week": timedelta(weeks=every),
    }
    delta = units.get(unit)
    return delta if every > 0 and delta is not None else None


def _active_window_occurrences(
    schedule: Dict[str, object],
    local_day: object,
) -> list[datetime]:
    active_window = (
        schedule.get("active_window")
        if isinstance(schedule.get("active_window"), dict)
        else None
    )
    if not active_window or active_window.get("cadence") != "restart_daily":
        return []
    delta = _interval_delta(schedule)
    if delta is None:
        return []
    tz = ensure_timezone(str(schedule.get("timezone") or "UTC"))
    start_hour, start_minute = parse_time(str(active_window.get("start_local") or ""))
    end_hour, end_minute = parse_time(str(active_window.get("end_local") or ""))
    day = local_day
    start_naive = datetime(day.year, day.month, day.day, start_hour, start_minute)
    end_naive = datetime(day.year, day.month, day.day, end_hour, end_minute)
    candidates: list[datetime] = []
    cursor = start_naive
    while cursor <= end_naive:
        local_candidate = cursor.replace(tzinfo=tz)
        utc_candidate = local_candidate.astimezone(timezone.utc)
        round_trip = utc_candidate.astimezone(tz).replace(tzinfo=None)
        if round_trip == cursor and utc_candidate not in candidates:
            candidates.append(utc_candidate)
        cursor += delta
    return candidates


def _latest_active_window_occurrence(
    schedule: Dict[str, object],
    stored_due: datetime,
    now: datetime,
) -> datetime:
    tz = ensure_timezone(str(schedule.get("timezone") or "UTC"))
    now_local = now.astimezone(tz)
    candidates = _active_window_occurrences(schedule, now_local.date())
    due = [candidate for candidate in candidates if candidate <= now]
    if not due:
        due = _active_window_occurrences(schedule, now_local.date() - timedelta(days=1))
    latest = max(due) if due else stored_due
    return latest if latest >= stored_due else stored_due


def _next_active_window_occurrence(
    schedule: Dict[str, object],
    now: datetime,
) -> Optional[datetime]:
    tz = ensure_timezone(str(schedule.get("timezone") or "UTC"))
    local_day = now.astimezone(tz).date()
    for day_offset in (0, 1):
        candidates = _active_window_occurrences(schedule, local_day + timedelta(days=day_offset))
        for candidate in candidates:
            if candidate > now:
                return candidate
    return None


def _latest_due_occurrence(
    schedule: Dict[str, object],
    stored_due: datetime,
    now: datetime,
) -> datetime:
    sched_type = str(schedule.get("type") or "")
    if sched_type == "once" or stored_due > now:
        return stored_due

    try:
        tz = ensure_timezone(str(schedule.get("timezone") or "UTC"))
        now_local = now.astimezone(tz)
        candidate: Optional[datetime] = None

        if sched_type in {"daily", "weekdays", "weekly", "monthly"}:
            hour, minute = parse_time(str(schedule.get("time") or ""))

        if sched_type == "daily":
            candidate = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if candidate > now_local:
                candidate -= timedelta(days=1)
        elif sched_type == "weekdays":
            candidate = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
            while candidate > now_local or candidate.weekday() >= 5:
                candidate -= timedelta(days=1)
        elif sched_type == "weekly":
            days = normalize_days(schedule.get("days_of_week") or [])
            for offset in range(0, 8):
                possible = (now_local - timedelta(days=offset)).replace(
                    hour=hour,
                    minute=minute,
                    second=0,
                    microsecond=0,
                )
                if possible.weekday() in days and possible <= now_local:
                    candidate = possible
                    break
        elif sched_type == "monthly":
            day_of_month = int(schedule.get("day_of_month") or 0)
            if day_of_month <= 0:
                return stored_due
            year = now_local.year
            month = now_local.month
            day = min(day_of_month, last_day_of_month(year, month))
            candidate = now_local.replace(
                day=day,
                hour=hour,
                minute=minute,
                second=0,
                microsecond=0,
            )
            if candidate > now_local:
                month = 12 if month == 1 else month - 1
                year = year - 1 if now_local.month == 1 else year
                day = min(day_of_month, last_day_of_month(year, month))
                candidate = candidate.replace(year=year, month=month, day=day)
        elif sched_type == "interval":
            if isinstance(schedule.get("active_window"), dict):
                return _latest_active_window_occurrence(schedule, stored_due, now)
            delta = _interval_delta(schedule)
            if delta is None:
                return stored_due
            anchor_value = schedule.get("start_at")
            anchor = (
                parse_iso(str(anchor_value), tz).astimezone(timezone.utc)
                if anchor_value
                else stored_due.astimezone(timezone.utc)
            )
            if anchor > now:
                return stored_due
            steps = int((now - anchor).total_seconds() // delta.total_seconds())
            candidate = (anchor + (delta * steps)).astimezone(tz)
        elif sched_type == "cron":
            expression = str(schedule.get("cron") or "").strip()
            if not expression:
                return stored_due
            candidate = croniter(expression, now_local + timedelta(microseconds=1)).get_prev(datetime)
            if candidate.tzinfo is None:
                candidate = candidate.replace(tzinfo=tz)

        if candidate is None:
            return stored_due
        candidate_utc = candidate.astimezone(timezone.utc)
        return candidate_utc if candidate_utc >= stored_due else stored_due
    except Exception as exc:
        logger.warning("Could not resolve latest due occurrence; using persisted due time: %s", exc)
        return stored_due


class SchedulerEngine:
    def __init__(
        self,
        storage: ScheduleStorage,
        poll_interval_s: int,
        misfire_grace_s: int,
        retry_delay_s: int,
        catch_up_max_late_s: int = DEFAULT_CATCH_UP_MAX_LATE_S,
        max_workers: int = 4,
        occurrence_lease_s: int = 15 * 60,
    ) -> None:
        self._storage = storage
        self._poll_interval_s = max(1, poll_interval_s)
        self._misfire_grace_s = max(0, misfire_grace_s)
        self._retry_delay_s = max(1, retry_delay_s)
        self._catch_up_max_late_s = _clamp_late_window(
            catch_up_max_late_s,
            DEFAULT_CATCH_UP_MAX_LATE_S,
        )
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._max_workers = max(1, int(max_workers))
        self._occurrence_lease_s = max(1, int(occurrence_lease_s))
        self._lease_owner = f"scheduler:{os.getpid()}:{uuid.uuid4().hex}"
        self._executor = ThreadPoolExecutor(
            max_workers=self._max_workers,
            thread_name_prefix="scheduling-cortex-run",
        )
        self._capacity = threading.BoundedSemaphore(self._max_workers)
        self._futures: set[Future[None]] = set()
        self._futures_lock = threading.Lock()

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._run_loop, name="scheduling-cortex", daemon=True)
        self._thread.start()
        logger.info("Scheduling Cortex scheduler started")

    def stop(self) -> None:
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=5)
        self._executor.shutdown(wait=False, cancel_futures=True)

    def _run_loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self._tick()
            except Exception as exc:
                logger.exception("Scheduler tick failed: %s", exc)
            self._stop_event.wait(self._poll_interval_s)

    def _tick(self) -> None:
        now = datetime.now(timezone.utc)
        now_iso = to_utc_iso(now)
        due_tasks = self._storage.get_due_tasks(now_iso)
        if not due_tasks:
            return
        for task in due_tasks:
            if not self._capacity.acquire(blocking=False):
                logger.info(
                    "Scheduler worker pool saturated; task %s remains due for retry",
                    task.get("id"),
                )
                break
            try:
                future = self._executor.submit(self._process_task, task, now)
            except Exception:
                self._capacity.release()
                raise
            with self._futures_lock:
                self._futures.add(future)
            future.add_done_callback(self._release_worker_capacity)

    def _release_worker_capacity(self, future: Future[None]) -> None:
        with self._futures_lock:
            self._futures.discard(future)
        self._capacity.release()

    def _process_task(self, task: Dict[str, object], now: datetime) -> None:
        task_id = task.get("id")
        schedule = task.get("schedule")
        next_run_at = task.get("next_run_at")

        if not schedule or not next_run_at:
            return

        try:
            next_run_dt = parse_iso(next_run_at, timezone.utc)
        except Exception:
            logger.warning("Invalid next_run_at for task %s", task_id)
            next_run_dt = now

        next_run_dt = _latest_due_occurrence(schedule, next_run_dt, now)

        metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
        workbench = (
            metadata.get("workbench_scheduled_prompt")
            if isinstance(metadata.get("workbench_scheduled_prompt"), dict)
            else {}
        )
        claim = self._storage.claim_scheduled_prompt_occurrence(
            task_id=str(task_id or ""),
            user_id=str(task.get("user_id") or ""),
            executor=str(task.get("executor") or "viventium_agent"),
            due_at=to_utc_iso(next_run_dt),
            lease_owner=self._lease_owner,
            now=to_utc_iso(now),
            lease_seconds=self._occurrence_lease_s,
            definition_id=str(workbench.get("definition_id") or "") or None,
            version_id=str(workbench.get("version_id") or "") or None,
        )
        if not claim.get("claimed"):
            logger.info(
                "Scheduled occurrence for task %s was not claimed: %s",
                task_id,
                claim.get("reason") or "already_active",
            )
            return
        run = claim.get("run") if isinstance(claim.get("run"), dict) else {}
        run_id = str(run.get("run_id") or "")
        occurrence_key = str(run.get("occurrence_key") or run_id)
        task = dict(task)
        task["_scheduled_prompt_run_id"] = run_id
        task["_scheduled_prompt_occurrence_key"] = occurrence_key

        late_seconds = max(0, int((now - next_run_dt).total_seconds()))
        if late_seconds > self._misfire_grace_s:
            policy = _resolve_misfire_policy(task, self._catch_up_max_late_s)
            if policy.get("mode") == "catch_up" and late_seconds <= int(policy.get("max_late_s") or 0):
                logger.info(
                    "Task %s missed grace by %ss, dispatching catch-up",
                    task_id,
                    late_seconds,
                )
                task = _with_late_delivery_metadata(task, next_run_dt, now, late_seconds, policy)
            else:
                logger.info("Task %s missed beyond grace window, skipping", task_id)
                reason = (
                    "catch_up_window_exceeded"
                    if policy.get("mode") == "catch_up"
                    else "misfire_grace_exceeded"
                )
                self._update_after_skip(
                    task,
                    now,
                    next_run_dt=next_run_dt,
                    late_seconds=late_seconds,
                    reason=reason,
                    policy=policy,
                )
                self._storage.update_scheduled_prompt_run(
                    run_id,
                    {
                        "status": "missed",
                        "completed_at": to_utc_iso(now),
                        "disposition": "cancelled",
                        "channel_outcomes": {},
                        "updated_at": to_utc_iso(now),
                    },
                )
                return

        if late_seconds > self._misfire_grace_s:
            logger.info("Dispatching scheduled task %s as late catch-up", task_id)
        else:
            logger.info("Dispatching scheduled task %s", task_id)
        self._storage.update_task(
            task["user_id"],
            task_id,
            {
                "last_run_at": to_utc_iso(now),
                "last_status": "running",
                "last_error": None,
                "updated_at": to_utc_iso(now),
            },
        )
        self._storage.update_scheduled_prompt_run(
            run_id,
            {
                "status": "dispatching",
                "disposition": "running",
                "execution_snapshot": {
                    "dispatch_idempotency_key": occurrence_key,
                    "executor": str(task.get("executor") or "viventium_agent"),
                },
                "updated_at": to_utc_iso(now),
            },
        )

        try:
            scheduled_task = dict(task)
            scheduled_task["_scheduled_prompt_trigger_kind"] = "scheduled"
            scheduled_task["_scheduled_prompt_trigger_source"] = "scheduler_loop"
            dispatch_result = dispatch_task(scheduled_task)
            self._update_run_after_dispatch(run_id, task, now, dispatch_result)
            if isinstance(dispatch_result, dict) and isinstance(
                dispatch_result.get("generation_failure"), dict
            ):
                self._update_after_generation_failure(task, now, dispatch_result)
            else:
                self._update_after_success(task, now, dispatch_result)
        except Exception as exc:
            logger.exception("Task %s failed: %s", task_id, exc)
            self._storage.update_scheduled_prompt_run(
                run_id,
                {
                    "status": "failed",
                    "completed_at": to_utc_iso(datetime.now(timezone.utc)),
                    "disposition": "failed",
                    "error_class": type(exc).__name__,
                    "result_summary": f"Dispatch failed ({type(exc).__name__}).",
                    "updated_at": to_utc_iso(datetime.now(timezone.utc)),
                },
            )
            self._update_after_failure(task, now, exc)

    def _update_run_after_dispatch(
        self,
        run_id: str,
        task: Dict[str, object],
        now: datetime,
        dispatch_result: Optional[Dict[str, object]],
    ) -> None:
        existing_run = self._storage.get_scheduled_prompt_run(run_id) or {}
        existing_execution = (
            existing_run.get("execution_snapshot")
            if isinstance(existing_run.get("execution_snapshot"), dict)
            else {}
        )
        updates = dispatch_run_ledger_updates(
            task,
            dispatch_result,
            existing_execution=existing_execution,
        )
        self._storage.update_scheduled_prompt_run(run_id, updates)

    def _update_after_success(
        self,
        task: Dict[str, object],
        now: datetime,
        dispatch_result: Optional[Dict[str, object]] = None,
    ) -> None:
        schedule = task["schedule"]
        next_run = compute_next_run(schedule, now, now)
        updates = {
            "last_run_at": to_utc_iso(now),
            "last_status": "success",
            "last_error": None,
            "updated_at": to_utc_iso(now),
            # === VIVENTIUM NOTE ===
            # Feature: Persist delivery visibility for successful dispatch attempts.
            "last_delivery_at": to_utc_iso(now),
            # === VIVENTIUM NOTE ===
        }

        conversation_id = None
        delivery_outcome = "sent"
        delivery_reason = "delivered"
        generated_text = None
        delivery_detail: Dict[str, object] = {}
        if isinstance(dispatch_result, dict):
            conversation_id = dispatch_result.get("conversation_id")
            raw_delivery = dispatch_result.get("delivery")
            if isinstance(raw_delivery, dict):
                delivery_detail = raw_delivery
                outcome = raw_delivery.get("outcome")
                reason = raw_delivery.get("reason")
                generated = raw_delivery.get("generated_text")
                if isinstance(outcome, str) and outcome.strip():
                    delivery_outcome = outcome.strip()
                if isinstance(reason, str) and reason.strip():
                    delivery_reason = reason.strip()
                if isinstance(generated, str) and generated.strip():
                    generated_text = generated.strip()
        if conversation_id:
            updates["last_conversation_id"] = conversation_id
            if (task.get("conversation_policy") or "new") == "same":
                updates["conversation_id"] = conversation_id

        updates["last_delivery_outcome"] = delivery_outcome
        updates["last_delivery_reason"] = delivery_reason
        updates["last_generated_text"] = generated_text
        pruned_internal_metadata = _pruned_internal_metadata(task)
        if pruned_internal_metadata is not None:
            updates["metadata"] = pruned_internal_metadata

        # === VIVENTIUM NOTE ===
        # Feature: Persist per-channel error ledger for partial dispatch successes.
        channel_errors = (
            dispatch_result.get("channel_errors")
            if isinstance(dispatch_result, dict)
            else None
        )
        base_delivery = delivery_detail or {
            "outcome": delivery_outcome,
            "reason": delivery_reason,
            "generated_text": generated_text,
        }
        degradation = _deferred_fallback_degradation(
            delivery_outcome=delivery_outcome,
            delivery_reason=delivery_reason,
            delivery_detail=delivery_detail,
        )
        if degradation is not None:
            base_delivery["degradation"] = degradation
        if isinstance(channel_errors, dict) and channel_errors:
            base_delivery["channel_errors"] = channel_errors
            updates["last_status"] = "partial_success"
            updates["last_delivery_reason"] = (
                f"{delivery_reason}; channel_errors: "
                + "; ".join(f"{ch}: {err}" for ch, err in channel_errors.items())
            )
        late_delivery = _scheduler_late_delivery(task)
        if late_delivery is not None:
            base_delivery["late_delivery"] = late_delivery
            if updates["last_delivery_reason"] == "delivered":
                updates["last_delivery_reason"] = "delivered_late"
        updates["last_delivery"] = base_delivery
        # === VIVENTIUM NOTE ===

        if schedule.get("type") == "once":
            updates["active"] = 0
            updates["next_run_at"] = None
        else:
            updates["next_run_at"] = to_utc_iso(next_run) if next_run else None

        self._storage.update_task(task["user_id"], task["id"], updates)

    def _update_after_failure(self, task: Dict[str, object], now: datetime, error: object) -> None:
        retry_at = now + timedelta(seconds=self._retry_delay_s)
        orphaned_user = _is_orphaned_user_failure(error)
        error_message = str(error)
        delivery_reason = "orphaned_user_not_found" if orphaned_user else error_message
        updates = {
            "last_status": "error",
            "last_error": error_message,
            "updated_at": to_utc_iso(now),
            # === VIVENTIUM NOTE ===
            # Feature: Record failed delivery attempts for agent visibility.
            "last_delivery_outcome": "failed",
            "last_delivery_reason": delivery_reason,
            "last_delivery_at": to_utc_iso(now),
            "last_generated_text": None,
            "last_delivery": {
                "outcome": "failed",
                "reason": delivery_reason,
                "generated_text": None,
            },
            # === VIVENTIUM NOTE ===
        }
        if orphaned_user:
            updates["active"] = 0
            updates["next_run_at"] = None
            updates["last_delivery"]["failure_class"] = "orphaned_user_not_found"
        late_delivery = _scheduler_late_delivery(task)
        if late_delivery is not None:
            updates["last_delivery"]["late_delivery"] = late_delivery

        if not orphaned_user:
            if task["schedule"].get("type") == "once":
                updates["next_run_at"] = to_utc_iso(retry_at)
            else:
                next_run = compute_next_run(task["schedule"], now, now)
                if not next_run or next_run <= now:
                    next_run = retry_at
                updates["next_run_at"] = to_utc_iso(next_run)

        self._storage.update_task(task["user_id"], task["id"], updates)

    def _update_after_generation_failure(
        self,
        task: Dict[str, object],
        now: datetime,
        dispatch_result: Dict[str, object],
    ) -> None:
        failure = dispatch_result.get("generation_failure")
        error_class = normalized_scheduled_generation_failure_class(
            failure.get("error_class") if isinstance(failure, dict) else None
        )
        delivery = (
            dispatch_result.get("delivery")
            if isinstance(dispatch_result.get("delivery"), dict)
            else {}
        )
        retry_at = now + timedelta(seconds=self._retry_delay_s)
        updates: Dict[str, object] = {
            "last_run_at": to_utc_iso(now),
            "last_status": "error",
            "last_error": error_class,
            "last_delivery_outcome": "failed",
            "last_delivery_reason": error_class,
            "last_delivery_at": to_utc_iso(now),
            "last_generated_text": None,
            "last_delivery": delivery,
            "updated_at": to_utc_iso(now),
        }
        conversation_id = dispatch_result.get("conversation_id")
        if isinstance(conversation_id, str) and conversation_id.strip():
            updates["last_conversation_id"] = conversation_id.strip()
            if (task.get("conversation_policy") or "new") == "same":
                updates["conversation_id"] = conversation_id.strip()
        if task["schedule"].get("type") == "once":
            updates["active"] = 1
            updates["next_run_at"] = to_utc_iso(retry_at)
        else:
            next_run = compute_next_run(task["schedule"], now, now)
            if not next_run or next_run <= now:
                next_run = retry_at
            updates["next_run_at"] = to_utc_iso(next_run)
        self._storage.update_task(task["user_id"], task["id"], updates)

    def _update_after_skip(
        self,
        task: Dict[str, object],
        now: datetime,
        *,
        next_run_dt: Optional[datetime] = None,
        late_seconds: Optional[int] = None,
        reason: str = "misfire_grace_exceeded",
        policy: Optional[Dict[str, Any]] = None,
    ) -> None:
        schedule = task["schedule"]
        next_run = compute_next_run(schedule, now, now)
        if next_run_dt is None:
            raw_next = task.get("next_run_at")
            try:
                next_run_dt = parse_iso(raw_next, timezone.utc) if raw_next else now
            except Exception:
                next_run_dt = now
        if late_seconds is None:
            late_seconds = max(0, int((now - next_run_dt).total_seconds()))
        resolved_policy = policy or _resolve_misfire_policy(task, self._catch_up_max_late_s)
        delivery = {
            "outcome": "missed",
            "reason": reason,
            "generated_text": None,
            "due_at": to_utc_iso(next_run_dt),
            "due_at_local": _format_local_due(schedule, next_run_dt),
            "missed_at": to_utc_iso(now),
            "late_seconds": late_seconds,
            "late_minutes": _late_minutes(late_seconds),
            "policy": {
                "mode": resolved_policy.get("mode") or "strict",
                "max_late_s": resolved_policy.get("max_late_s"),
            },
        }
        updates = {
            "last_status": "missed",
            "last_error": None,
            "updated_at": to_utc_iso(now),
            "next_run_at": to_utc_iso(next_run) if next_run else None,
            "last_delivery_outcome": "missed",
            "last_delivery_reason": reason,
            "last_delivery_at": to_utc_iso(now),
            "last_generated_text": None,
            "last_delivery": delivery,
        }

        if schedule.get("type") == "once":
            updates["active"] = 0
            updates["next_run_at"] = None

        self._storage.update_task(task["user_id"], task["id"], updates)


def compute_next_run(schedule: Dict[str, object], now: datetime, last_run: Optional[datetime]) -> Optional[datetime]:
    tz = ensure_timezone(schedule.get("timezone") or "UTC")
    now_local = now.astimezone(tz)
    sched_type = schedule.get("type")

    if sched_type == "once":
        run_at = schedule.get("run_at")
        if not run_at:
            return None
        run_dt = parse_iso(run_at, tz)
        if run_dt <= now_local:
            return None
        return run_dt.astimezone(timezone.utc)

    if sched_type in {"daily", "weekdays", "weekly", "monthly"}:
        if not schedule.get("time"):
            return None
        hour, minute = parse_time(schedule["time"])

    if sched_type == "daily":
        candidate = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= now_local:
            candidate += timedelta(days=1)
        return candidate.astimezone(timezone.utc)

    if sched_type == "weekdays":
        candidate = now_local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        while candidate <= now_local or candidate.weekday() >= 5:
            candidate += timedelta(days=1)
        return candidate.astimezone(timezone.utc)

    if sched_type == "weekly":
        days = normalize_days(schedule.get("days_of_week") or [])
        # Range must be 0-8 (inclusive of 7) so that when offset=0 falls on
        # the target day but the time has already passed, offset=7 catches
        # the same weekday next week.  Without this, compute_next_run returns
        # None and the task is never scheduled again.
        for offset in range(0, 8):
            candidate_day = (now_local.weekday() + offset) % 7
            if candidate_day not in days:
                continue
            candidate = now_local + timedelta(days=offset)
            candidate = candidate.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if candidate > now_local:
                return candidate.astimezone(timezone.utc)
        return None

    if sched_type == "monthly":
        day_of_month = schedule.get("day_of_month")
        if not day_of_month:
            return None
        candidate_day = min(day_of_month, last_day_of_month(now_local.year, now_local.month))
        candidate = now_local.replace(day=candidate_day, hour=hour, minute=minute, second=0, microsecond=0)
        if candidate <= now_local:
            year = now_local.year + (1 if now_local.month == 12 else 0)
            month = 1 if now_local.month == 12 else now_local.month + 1
            candidate_day = min(day_of_month, last_day_of_month(year, month))
            candidate = candidate.replace(year=year, month=month, day=candidate_day)
        return candidate.astimezone(timezone.utc)

    if sched_type == "interval":
        if isinstance(schedule.get("active_window"), dict):
            return _next_active_window_occurrence(schedule, now)
        delta = _interval_delta(schedule)
        if delta is None:
            return None
        anchor = schedule.get("start_at")
        base = last_run or now
        if anchor:
            base = parse_iso(anchor, tz).astimezone(timezone.utc)
        candidate = base
        while candidate <= now:
            candidate += delta
        return candidate.astimezone(timezone.utc)

    if sched_type == "cron":
        expr = schedule.get("cron")
        if not expr:
            return None
        base = now_local
        cron = croniter(expr, base)
        next_local = cron.get_next(datetime)
        if next_local.tzinfo is None:
            next_local = next_local.replace(tzinfo=tz)
        return next_local.astimezone(timezone.utc)

    return None


def compute_next_runs(schedule: Dict[str, object], now: datetime, count: int) -> list[str]:
    runs = []
    last = None
    current = now
    for _ in range(count):
        next_run = compute_next_run(schedule, current, last)
        if not next_run:
            break
        runs.append(to_utc_iso(next_run))
        last = next_run
        current = next_run
    return runs
