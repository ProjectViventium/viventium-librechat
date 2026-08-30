# === VIVENTIUM START ===
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# === VIVENTIUM END ===

import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.dispatch import HttpJsonError, scheduled_exception_failure
from scheduling_cortex.models import ScheduleRule
from scheduling_cortex.scheduler import (
    SchedulerEngine,
    SCHEDULER_MISFIRE_KEY,
    _latest_due_occurrence,
    compute_next_run,
    _resolve_misfire_policy,
)
from scheduling_cortex.storage import ScheduleStorage, StorageConfig


def _seed_task(
    storage: ScheduleStorage,
    task_id: str = "task-1",
    *,
    schedule: dict | None = None,
    created_source: str = "agent",
    metadata: dict | None = None,
    next_run_at: str = "2026-02-13T19:00:00Z",
    prompt: str = "Daily reflection",
) -> dict:
    task = {
        "id": task_id,
        "user_id": "user-1",
        "agent_id": "agent-1",
        "prompt": prompt,
        "schedule": schedule or {"type": "daily", "time": "09:00", "timezone": "UTC"},
        "channel": "telegram",
        "conversation_policy": "same",
        "conversation_id": None,
        "last_conversation_id": None,
        "active": 1,
        "created_by": "agent:agent-1",
        "created_source": created_source,
        "created_at": "2026-02-13T18:00:00Z",
        "updated_at": "2026-02-13T18:00:00Z",
        "updated_by": "agent:agent-1",
        "updated_source": created_source,
        "last_run_at": None,
        "next_run_at": next_run_at,
        "last_status": None,
        "last_error": None,
        "metadata": metadata,
    }
    storage.create_task(task)
    created = storage.get_task("user-1", task_id)
    assert created is not None
    return created


class LatestDueOccurrenceTests(unittest.TestCase):
    def test_active_window_is_interval_only_and_requires_ordered_local_bounds(self):
        with self.assertRaisesRegex(ValueError, "active_window is only supported"):
            ScheduleRule.model_validate(
                {
                    "type": "daily",
                    "time": "09:00",
                    "timezone": "UTC",
                    "active_window": {
                        "start_local": "09:00",
                        "end_local": "11:00",
                        "cadence": "restart_daily",
                    },
                }
            )
        with self.assertRaisesRegex(ValueError, "end_local must be at or after start_local"):
            ScheduleRule.model_validate(
                {
                    "type": "interval",
                    "timezone": "UTC",
                    "interval": {"every": 30, "unit": "minute"},
                    "active_window": {
                        "start_local": "11:00",
                        "end_local": "09:00",
                        "cadence": "restart_daily",
                    },
                }
            )

    def test_interval_active_window_restarts_on_each_local_day_and_is_inclusive(self):
        schedule = {
            "type": "interval",
            "timezone": "America/Toronto",
            "interval": {"every": 30, "unit": "minute"},
            "active_window": {
                "start_local": "09:00",
                "end_local": "11:00",
                "cadence": "restart_daily",
            },
        }
        stored = datetime(2026, 8, 9, 13, 0, tzinfo=timezone.utc)

        self.assertEqual(
            _latest_due_occurrence(
                schedule,
                stored,
                datetime(2026, 8, 10, 15, 5, tzinfo=timezone.utc),
            ),
            datetime(2026, 8, 10, 15, 0, tzinfo=timezone.utc),
        )
        self.assertEqual(
            compute_next_run(
                schedule,
                datetime(2026, 8, 10, 15, 5, tzinfo=timezone.utc),
                None,
            ),
            datetime(2026, 8, 11, 13, 0, tzinfo=timezone.utc),
        )

    def test_interval_active_window_skips_nonexistent_dst_wall_time(self):
        schedule = {
            "type": "interval",
            "timezone": "America/Toronto",
            "interval": {"every": 60, "unit": "minute"},
            "active_window": {
                "start_local": "01:00",
                "end_local": "04:00",
                "cadence": "restart_daily",
            },
        }

        self.assertEqual(
            compute_next_run(
                schedule,
                datetime(2026, 3, 8, 6, 30, tzinfo=timezone.utc),
                None,
            ),
            datetime(2026, 3, 8, 7, 0, tzinfo=timezone.utc),
        )

    def test_latest_due_occurrence_covers_supported_recurring_types(self):
        default_stored = datetime(2026, 7, 1, 3, 0, tzinfo=timezone.utc)
        cases = (
            (
                {"type": "daily", "time": "03:00", "timezone": "UTC"},
                default_stored,
                datetime(2026, 7, 11, 7, 0, tzinfo=timezone.utc),
                datetime(2026, 7, 11, 3, 0, tzinfo=timezone.utc),
            ),
            (
                {"type": "weekdays", "time": "03:00", "timezone": "UTC"},
                default_stored,
                datetime(2026, 7, 12, 7, 0, tzinfo=timezone.utc),
                datetime(2026, 7, 10, 3, 0, tzinfo=timezone.utc),
            ),
            (
                {
                    "type": "weekly",
                    "time": "03:00",
                    "timezone": "UTC",
                    "days_of_week": ["tue", "fri"],
                },
                default_stored,
                datetime(2026, 7, 11, 7, 0, tzinfo=timezone.utc),
                datetime(2026, 7, 10, 3, 0, tzinfo=timezone.utc),
            ),
            (
                {
                    "type": "monthly",
                    "time": "03:00",
                    "timezone": "UTC",
                    "day_of_month": 15,
                },
                datetime(2026, 5, 15, 3, 0, tzinfo=timezone.utc),
                datetime(2026, 7, 11, 7, 0, tzinfo=timezone.utc),
                datetime(2026, 6, 15, 3, 0, tzinfo=timezone.utc),
            ),
            (
                {
                    "type": "interval",
                    "timezone": "UTC",
                    "start_at": "2026-07-01T03:00:00Z",
                    "interval": {"every": 2, "unit": "day"},
                },
                default_stored,
                datetime(2026, 7, 11, 7, 0, tzinfo=timezone.utc),
                datetime(2026, 7, 11, 3, 0, tzinfo=timezone.utc),
            ),
            (
                {"type": "cron", "timezone": "UTC", "cron": "0 3 * * *"},
                default_stored,
                datetime(2026, 7, 11, 7, 0, tzinfo=timezone.utc),
                datetime(2026, 7, 11, 3, 0, tzinfo=timezone.utc),
            ),
        )

        for schedule, stored, now, expected in cases:
            with self.subTest(schedule_type=schedule["type"]):
                self.assertEqual(_latest_due_occurrence(schedule, stored, now), expected)

    def test_latest_daily_occurrence_uses_schedule_timezone_across_dst(self):
        schedule = {"type": "daily", "time": "03:00", "timezone": "America/Toronto"}
        stored = datetime(2026, 3, 7, 8, 0, tzinfo=timezone.utc)
        now = datetime(2026, 3, 8, 12, 0, tzinfo=timezone.utc)

        self.assertEqual(
            _latest_due_occurrence(schedule, stored, now),
            datetime(2026, 3, 8, 7, 0, tzinfo=timezone.utc),
        )

    def test_latest_daily_occurrence_does_not_use_host_timezone(self):
        schedule = {"type": "daily", "time": "03:00", "timezone": "Asia/Tokyo"}
        stored = datetime(2026, 7, 1, 18, 0, tzinfo=timezone.utc)
        now = datetime(2026, 7, 11, 0, 0, tzinfo=timezone.utc)

        self.assertEqual(
            _latest_due_occurrence(schedule, stored, now),
            datetime(2026, 7, 10, 18, 0, tzinfo=timezone.utc),
        )

    def test_latest_day_interval_remains_elapsed_utc_across_dst(self):
        schedule = {
            "type": "interval",
            "timezone": "America/Toronto",
            "start_at": "2026-03-07T08:00:00Z",
            "interval": {"every": 1, "unit": "day"},
        }
        stored = datetime(2026, 3, 7, 8, 0, tzinfo=timezone.utc)
        now = datetime(2026, 3, 9, 12, 0, tzinfo=timezone.utc)

        self.assertEqual(
            _latest_due_occurrence(schedule, stored, now),
            datetime(2026, 3, 9, 8, 0, tzinfo=timezone.utc),
        )


class SchedulerDeliveryPersistenceTests(unittest.TestCase):
    def test_tick_uses_bounded_nonblocking_pool_and_retries_saturated_tasks(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            for index in range(3):
                _seed_task(
                    storage,
                    f"task-pool-{index}",
                    prompt=f"Daily reflection {index}",
                )
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
                max_workers=2,
            )
            release = threading.Event()
            started = threading.Event()
            call_count = 0
            lock = threading.Lock()

            def blocking_dispatch(_task):
                nonlocal call_count
                with lock:
                    call_count += 1
                    if call_count == 2:
                        started.set()
                release.wait(2)
                return {"delivery": {"outcome": "sent", "reason": "delivered", "channels": {}}}

            with patch("scheduling_cortex.scheduler.dispatch_task", side_effect=blocking_dispatch):
                with patch(
                    "scheduling_cortex.scheduler.datetime"
                ) as mock_datetime:
                    mock_datetime.now.return_value = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)
                    engine._tick()
                self.assertTrue(started.wait(1))
                engine._tick()
                self.assertEqual(call_count, 2)
                pending = [
                    storage.get_task("user-1", f"task-pool-{index}")
                    for index in range(3)
                ]
                self.assertTrue(any(task.get("last_status") is None for task in pending))
                self.assertFalse(any(task.get("last_status") == "error" for task in pending))
                release.set()
                deadline = time.time() + 2
                while engine._futures and time.time() < deadline:
                    time.sleep(0.01)
                with patch("scheduling_cortex.scheduler.datetime") as mock_datetime:
                    mock_datetime.now.return_value = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)
                    engine._tick()
                deadline = time.time() + 2
                while call_count < 3 and time.time() < deadline:
                    time.sleep(0.01)

            self.assertEqual(call_count, 3)
            engine.stop()

    def test_scheduler_pool_defaults_to_four_workers(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            engine = SchedulerEngine(
                ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db"))),
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
            )
            self.assertEqual(engine._max_workers, 4)
            engine.stop()

    def test_viventium_agent_occurrence_writes_one_complete_run_lifecycle(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-agent-run")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

            with patch(
                "scheduling_cortex.scheduler.dispatch_task",
                return_value={
                    "conversation_id": "conversation-synthetic",
                    "execution": {"provider": "openai", "model": "gpt-5.6-sol", "reasoning_effort": "xhigh"},
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "channels": {"telegram": {"outcome": "sent"}},
                    },
                },
            ) as mock_dispatch:
                engine._process_task(task, now)

            dispatched = mock_dispatch.call_args.args[0]
            runs = storage.list_scheduled_prompt_runs(task_id="task-agent-run")
            self.assertEqual(len(runs), 1)
            self.assertEqual(dispatched["_scheduled_prompt_run_id"], runs[0]["run_id"])
            self.assertEqual(runs[0]["status"], "completed")
            self.assertEqual(runs[0]["disposition"], "delivered")
            self.assertEqual(runs[0]["executor"], "viventium_agent")
            self.assertEqual(runs[0]["execution_snapshot"]["model"], "gpt-5.6-sol")
            self.assertEqual(runs[0]["channel_outcomes"]["telegram"]["outcome"], "sent")
            self.assertEqual(runs[0]["interaction_ref"], "conversation:conversation-synthetic")

    def test_required_tool_launched_missions_hold_occurrence_and_lease_while_waiting_external(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            "os.environ",
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-agent-external")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

            with patch(
                "scheduling_cortex.scheduler.dispatch_task",
                return_value={
                    "conversation_id": "conversation-synthetic",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "acknowledged",
                        "channels": {"librechat": {"outcome": "sent"}},
                    },
                    "external_work": {
                        "requiredTotal": 2,
                        "requiredTerminal": 1,
                        "allRequiredTerminal": False,
                        "state": "waiting_external",
                    },
                },
            ):
                engine._process_task(task, now)

            run = storage.list_scheduled_prompt_runs(task_id="task-agent-external")[0]
            self.assertEqual(run["status"], "waiting_external")
            self.assertEqual(run["disposition"], "running")
            self.assertIsNone(run["completed_at"])
            self.assertIsNotNone(run["lease_owner"])
            self.assertIsNotNone(run["lease_until"])
            self.assertEqual(run["execution_snapshot"]["external_work"]["requiredTotal"], 2)
            lease_until = datetime.fromisoformat(run["lease_until"].replace("Z", "+00:00"))
            heartbeat_at = datetime.fromisoformat(run["updated_at"].replace("Z", "+00:00"))
            self.assertEqual((lease_until - heartbeat_at).total_seconds(), 24 * 60 * 60)

    def test_restart_never_replays_dispatched_same_day_catch_up_occurrence(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            "os.environ",
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            now = datetime.now(timezone.utc).replace(microsecond=0)
            due_at = now - timedelta(hours=2)
            due_iso = due_at.isoformat().replace("+00:00", "Z")
            next_due = (due_at + timedelta(days=1)).isoformat().replace("+00:00", "Z")
            task = _seed_task(
                storage,
                "task-dispatched-catch-up",
                schedule={"type": "daily", "time": due_at.strftime("%H:%M"), "timezone": "UTC"},
                metadata={"misfire_policy": {"mode": "catch_up", "max_late_s": 43200}},
                next_run_at=next_due,
            )
            storage.update_task(
                task["user_id"],
                task["id"],
                {"executor": "glasshive_host", "last_status": "running"},
            )
            claimed = storage.claim_scheduled_prompt_occurrence(
                task_id=task["id"],
                user_id=task["user_id"],
                executor="glasshive_host",
                due_at=due_iso,
                lease_owner="scheduler:abandoned",
                now=due_iso,
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                claimed["run"]["run_id"],
                {
                    "status": "running",
                    "glasshive_run_id": "worker-run-dispatched",
                    "updated_at": due_iso,
                },
            )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            engine = SchedulerEngine(
                restarted,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
            )
            with patch("scheduling_cortex.scheduler.dispatch_task") as dispatch:
                engine._tick()
            engine.stop()

            dispatch.assert_not_called()
            run = restarted.get_scheduled_prompt_run(claimed["run"]["run_id"])
            parent = restarted.get_task(task["user_id"], task["id"])
            self.assertEqual(run["status"], "running")
            self.assertIsNone(run["error_class"])
            self.assertEqual(parent["last_status"], "running")
            self.assertEqual(parent["next_run_at"], next_due)
            self.assertEqual(len(restarted.list_scheduled_prompt_runs(task_id=task["id"])), 1)

    def test_manual_overlap_defers_and_then_runs_the_automatic_occurrence_past_grace(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-deferred-overlap")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            manual_at = "2026-02-13T18:59:50Z"
            storage.claim_manual_scheduled_prompt_run(
                {
                    "run_id": "manual-overlap",
                    "task_id": "task-deferred-overlap",
                    "user_id": task["user_id"],
                    "due_at": manual_at,
                    "started_at": manual_at,
                    "status": "running",
                    "executor": "viventium_agent",
                    "trigger_kind": "manual",
                    "trigger_source": "workbench_manual",
                    "occurrence_key": "manual-overlap",
                    "disposition": "running",
                    "created_at": manual_at,
                    "updated_at": manual_at,
                },
                lease_owner="workbench:manual-overlap",
                now=manual_at,
                lease_seconds=60,
            )

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                engine._process_task(task, datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc))
                mock_dispatch.assert_not_called()

            deferred_task = storage.get_task(task["user_id"], task["id"])
            marker = deferred_task["metadata"]["scheduler_deferred_occurrence_v1"]
            self.assertEqual(marker["due_at"], "2026-02-13T19:00:00Z")
            self.assertEqual(marker["blocker_run_id"], "manual-overlap")

            storage.update_scheduled_prompt_run(
                "manual-overlap",
                {
                    "status": "completed",
                    "disposition": "silent",
                    "completed_at": "2026-02-13T19:16:00Z",
                    "updated_at": "2026-02-13T19:16:00Z",
                },
            )
            with patch(
                "scheduling_cortex.scheduler.dispatch_task",
                return_value={
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "channels": {"telegram": {"outcome": "sent"}},
                    }
                },
            ) as mock_dispatch:
                engine._process_task(
                    deferred_task,
                    datetime(2026, 2, 13, 19, 16, tzinfo=timezone.utc),
                )

            mock_dispatch.assert_called_once()
            updated_task = storage.get_task(task["user_id"], task["id"])
            self.assertNotIn("scheduler_deferred_occurrence_v1", updated_task["metadata"])
            scheduled_runs = [
                run
                for run in storage.list_scheduled_prompt_runs(task_id=task["id"])
                if run["trigger_kind"] == "scheduled"
            ]
            self.assertEqual(len(scheduled_runs), 1)
            self.assertEqual(scheduled_runs[0]["status"], "completed")

    def test_occurrence_persists_dispatch_intent_and_forwards_deterministic_key(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-dispatch-intent")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

            def inspect_intent(dispatched):
                run = storage.list_scheduled_prompt_runs(task_id="task-dispatch-intent")[0]
                self.assertEqual(run["status"], "dispatching")
                self.assertEqual(dispatched["_scheduled_prompt_occurrence_key"], run["occurrence_key"])
                self.assertEqual(
                    run["execution_snapshot"]["dispatch_idempotency_key"],
                    run["occurrence_key"],
                )
                return {"delivery": {"outcome": "sent", "channels": {"librechat": {"outcome": "sent"}}}}

            with patch("scheduling_cortex.scheduler.dispatch_task", side_effect=inspect_intent):
                engine._process_task(task, now)
            completed = storage.list_scheduled_prompt_runs(task_id="task-dispatch-intent")[0]
            self.assertEqual(completed["status"], "completed")
            self.assertEqual(
                completed["execution_snapshot"]["dispatch_idempotency_key"],
                completed["occurrence_key"],
            )

    def test_failed_occurrence_keeps_private_exception_detail_out_of_run_summary(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-private-failure")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

            failure_result = {
                "generation_failure": {
                    "error_class": "completion_error",
                    "failure_retryable": True,
                    "transition": {
                        "retry_disposition": "next_occurrence_only",
                        "retryable": True,
                    },
                },
                "delivery": {
                    "outcome": "failed",
                    "reason": "completion_error",
                    "generated_text": None,
                    "channels": {"telegram": {"outcome": "sent"}},
                },
            }
            with patch(
                "scheduling_cortex.scheduler.dispatch_task",
                side_effect=RuntimeError("Bearer synthetic-private-value"),
            ), patch(
                "scheduling_cortex.scheduler.scheduled_failure_result",
                return_value=failure_result,
            ) as close_failure:
                engine._process_task(task, now)

            run = storage.list_scheduled_prompt_runs(task_id="task-private-failure")[0]
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error_class"], "completion_error")
            self.assertEqual(
                run["result_summary"],
                "Scheduled generation failed (completion_error).",
            )
            self.assertNotIn("synthetic-private-value", run["result_summary"])
            self.assertIsNone(run["lease_until"])
            close_failure.assert_called_once()

    def test_user_not_found_occurrence_closes_the_orphaned_schedule(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-orphaned-owner-route")
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
            )
            now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

            with patch(
                "scheduling_cortex.scheduler.dispatch_task",
                side_effect=HttpJsonError(
                    "synthetic private HTTP detail",
                    status=404,
                    method="POST",
                    path="/api/viventium/scheduler/chat",
                    reason="user_not_found",
                ),
            ):
                engine._process_task(task, now)

            run = storage.list_scheduled_prompt_runs(task_id=task["id"])[0]
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error_class"], "orphaned_user_not_found")
            self.assertEqual(
                run["result_summary"],
                "Scheduled generation failed (orphaned_user_not_found).",
            )
            self.assertNotIn("private HTTP detail", run["result_summary"])

            updated = storage.get_task(task["user_id"], task["id"])
            self.assertEqual(updated["active"], 0)
            self.assertIsNone(updated["next_run_at"])
            self.assertEqual(updated["last_error"], "orphaned_user_not_found")
            self.assertEqual(updated["last_delivery_reason"], "orphaned_user_not_found")
            self.assertEqual(
                updated["metadata"]["scheduled_failure_state_v1"]["retry_disposition"],
                "terminal_action_required",
            )

    def test_orphaned_user_classification_requires_exact_scheduler_404_route(self):
        task = {"executor": "viventium_agent"}
        adjacent_errors = (
            HttpJsonError(
                "same reason on another endpoint",
                status=404,
                method="POST",
                path="/api/viventium/agents/chat",
                reason="user_not_found",
            ),
            HttpJsonError(
                "same route without a not-found status",
                status=409,
                method="POST",
                path="/api/viventium/scheduler/chat",
                failure_class="user_not_found",
            ),
        )

        for error in adjacent_errors:
            with self.subTest(status=error.status, path=error.path):
                self.assertEqual(
                    scheduled_exception_failure(task, error)["error_class"],
                    "completion_error",
                )

    def test_structured_terminal_provider_failure_stops_one_time_retry_loop(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-provider-unauthorized",
                schedule={"type": "once", "at": "2026-02-13T19:00:00Z", "timezone": "UTC"},
            )
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
            )
            now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

            with patch(
                "scheduling_cortex.scheduler.dispatch_task",
                return_value={
                    "conversation_id": "conversation-provider-error",
                    "response_message_id": "message-provider-error",
                    "generation_failure": {"error_class": "provider_unauthorized"},
                    "delivery": {
                        "outcome": "failed",
                        "reason": "provider_unauthorized",
                        "generated_text": None,
                        "channels": {
                            "librechat": {
                                "outcome": "failed",
                                "reason": "provider_unauthorized",
                            },
                            "telegram": {
                                "outcome": "sent",
                                "reason": "action_required",
                            },
                        },
                    },
                },
            ):
                engine._process_task(task, now)

            run = storage.list_scheduled_prompt_runs(task_id=task["id"])[0]
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["disposition"], "failed")
            self.assertEqual(run["error_class"], "provider_unauthorized")
            self.assertEqual(
                run["result_summary"],
                "Scheduled generation failed (provider_unauthorized).",
            )
            self.assertEqual(run["interaction_ref"], "conversation:conversation-provider-error")
            self.assertEqual(run["channel_outcomes"]["telegram"]["outcome"], "sent")

            updated = storage.get_task(task["user_id"], task["id"])
            self.assertEqual(updated["last_status"], "error")
            self.assertEqual(updated["last_error"], "provider_unauthorized")
            self.assertEqual(updated["last_delivery_outcome"], "failed")
            self.assertEqual(updated["last_delivery_reason"], "provider_unauthorized")
            self.assertEqual(updated["active"], 0)
            self.assertIsNone(updated["next_run_at"])
            self.assertEqual(
                updated["metadata"]["scheduled_failure_state_v1"]["retry_disposition"],
                "terminal_action_required",
            )

    def test_retryable_one_time_failure_stops_after_the_closed_contract_limit(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-rate-limited",
                schedule={"type": "once", "at": "2026-02-13T19:00:00Z", "timezone": "UTC"},
            )
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
            )
            result = {
                "generation_failure": {
                    "error_class": "provider_rate_limited",
                    "failure_retryable": True,
                },
                "delivery": {"outcome": "failed", "reason": "provider_rate_limited"},
            }
            now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

            for attempt in range(1, 4):
                engine._update_after_generation_failure(task, now, result)
                task = storage.get_task("user-1", "task-rate-limited")
                state = task["metadata"]["scheduled_failure_state_v1"]
                self.assertEqual(state["consecutive_count"], attempt)
                if attempt < 3:
                    self.assertEqual(state["retry_disposition"], "retry_scheduled")
                    self.assertEqual(task["active"], 1)
                    self.assertIsNotNone(task["next_run_at"])
                else:
                    self.assertEqual(state["retry_disposition"], "terminal_action_required")
                    self.assertEqual(task["active"], 0)
                    self.assertIsNone(task["next_run_at"])

    def test_glasshive_occurrence_reuses_claimed_row_and_remains_queued(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            "os.environ",
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-glasshive")
            storage.update_task("user-1", "task-glasshive", {"executor": "glasshive_host"})
            task = storage.get_task("user-1", "task-glasshive")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

            def queued_result(dispatched):
                run_id = dispatched["_scheduled_prompt_run_id"]
                return {
                    "scheduled_prompt_run_id": run_id,
                    "glasshive_run_id": "glasshive-synthetic",
                    "delivery": {
                        "outcome": "queued",
                        "reason": "glasshive_host_run_queued",
                        "channels": {"workbench": {"outcome": "queued"}},
                    },
                }

            with patch("scheduling_cortex.scheduler.dispatch_task", side_effect=queued_result):
                engine._process_task(task, now)

            runs = storage.list_scheduled_prompt_runs(task_id="task-glasshive")
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0]["status"], "queued")
            self.assertEqual(runs[0]["disposition"], "running")
            self.assertEqual(runs[0]["interaction_ref"], "glasshive:glasshive-synthetic")
            self.assertIsNotNone(runs[0]["lease_until"])
            lease_until = datetime.fromisoformat(runs[0]["lease_until"].replace("Z", "+00:00"))
            heartbeat_at = datetime.fromisoformat(runs[0]["updated_at"].replace("Z", "+00:00"))
            self.assertEqual((lease_until - heartbeat_at).total_seconds(), 15 * 60)

    def test_scheduler_maps_silence_and_partial_delivery_to_public_dispositions(self):
        cases = (
            (
                "silent",
                {
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "nta",
                        "channels": {"librechat": {"outcome": "suppressed", "reason": "nta"}},
                    }
                },
            ),
            (
                "partial",
                {
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "channels": {"librechat": {"outcome": "sent"}},
                    },
                    "channel_errors": {"telegram": "synthetic_unavailable"},
                },
            ),
        )
        for expected, dispatch_result in cases:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory() as tmpdir:
                storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
                task = _seed_task(storage, f"task-{expected}")
                engine = SchedulerEngine(
                    storage,
                    poll_interval_s=30,
                    misfire_grace_s=900,
                    retry_delay_s=300,
                )
                now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

                with patch("scheduling_cortex.scheduler.dispatch_task", return_value=dispatch_result):
                    engine._process_task(task, now)

                run = storage.list_scheduled_prompt_runs(task_id=f"task-{expected}")[0]
                self.assertEqual(run["disposition"], expected)

    def test_scheduler_persists_superseded_as_distinct_completed_disposition(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-superseded")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)
            result = {
                "conversation_id": "conversation-same",
                "delivery": {
                    "outcome": "superseded",
                    "reason": "newer_stable_turn",
                    "channels": {"librechat": {"outcome": "superseded"}},
                },
            }

            with patch("scheduling_cortex.scheduler.dispatch_task", return_value=result):
                engine._process_task(task, now)

            run = storage.list_scheduled_prompt_runs(task_id="task-superseded")[0]
            self.assertEqual(run["status"], "completed")
            self.assertEqual(run["disposition"], "superseded")

    def test_concurrent_engines_dispatch_one_occurrence_once(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "schedules.db")
            primary = ScheduleStorage(StorageConfig(db_path=db_path))
            task = _seed_task(primary, "task-duplicate")
            engines = [
                SchedulerEngine(
                    ScheduleStorage(StorageConfig(db_path=db_path)),
                    poll_interval_s=30,
                    misfire_grace_s=900,
                    retry_delay_s=300,
                )
                for _ in range(2)
            ]
            barrier = threading.Barrier(2)
            call_count = 0
            call_lock = threading.Lock()

            def dispatch_once(_task):
                nonlocal call_count
                with call_lock:
                    call_count += 1
                time.sleep(0.05)
                return {"delivery": {"outcome": "sent", "reason": "delivered", "channels": {}}}

            def process(engine):
                barrier.wait()
                engine._process_task(task, datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc))

            with patch("scheduling_cortex.scheduler.dispatch_task", side_effect=dispatch_once):
                threads = [threading.Thread(target=process, args=(engine,)) for engine in engines]
                for thread in threads:
                    thread.start()
                for thread in threads:
                    thread.join()

            self.assertEqual(call_count, 1)
            self.assertEqual(len(primary.list_scheduled_prompt_runs(task_id="task-duplicate")), 1)

    def test_update_after_success_records_delivery_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-success")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-123",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "telegram:nta",
                        "generated_text": "{NTA}",
                        "channels": {"telegram": {"outcome": "suppressed", "reason": "nta"}},
                    },
                },
            )

            updated = storage.get_task("user-1", "task-success")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("conversation_id"), "conv-123")
            self.assertEqual(updated.get("last_conversation_id"), "conv-123")
            self.assertEqual(updated.get("last_delivery_outcome"), "suppressed")
            self.assertEqual(updated.get("last_delivery_reason"), "telegram:nta")
            self.assertEqual(updated.get("last_generated_text"), "{NTA}")
            recurrence = updated.get("metadata", {}).get("recurrence_state_v1", {})
            self.assertEqual(recurrence.get("version"), 1)
            self.assertEqual(recurrence.get("outcome"), "suppressed")
            self.assertEqual(recurrence.get("reason"), "telegram:nta")
            self.assertEqual(recurrence.get("result_excerpt"), "{NTA}")
            self.assertEqual(len(recurrence.get("result_sha256", "")), 64)
            self.assertEqual(updated.get("last_delivery", {}).get("channels", {}).get("telegram", {}).get("reason"), "nta")

    def test_update_after_success_keeps_any_scheduled_suppression_silent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-passive-check")
            task["metadata"] = {
                "name": "Passive Check",
                "heartbeat_quiet_streak": 99,
                "heartbeat_last_pulse_at": "2026-02-13T18:30:00Z",
            }
            storage.update_task(task["user_id"], task["id"], {"metadata": task["metadata"]})
            task = storage.get_task(task["user_id"], task["id"])
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 30, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-heartbeat-1",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "telegram:nta",
                        "generated_text": "{NTA}",
                    },
                },
            )

            suppressed = storage.get_task("user-1", "task-passive-check")
            self.assertEqual(suppressed.get("last_status"), "success")
            self.assertEqual(suppressed.get("last_delivery_outcome"), "suppressed")
            self.assertEqual(suppressed.get("last_delivery_reason"), "telegram:nta")
            self.assertEqual(suppressed.get("last_generated_text"), "{NTA}")
            self.assertEqual(suppressed.get("metadata", {}).get("name"), "Passive Check")
            self.assertNotIn("heartbeat_quiet_streak", suppressed.get("metadata", {}))
            self.assertNotIn("heartbeat_last_pulse_at", suppressed.get("metadata", {}))

    def test_update_after_success_keeps_empty_scheduled_suppression_silent(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-passive-empty")
            task["metadata"] = {
                "name": "Passive Check",
                "heartbeat_quiet_streak": 42,
                "heartbeat_last_pulse_at": "2026-02-13T18:30:00Z",
            }
            storage.update_task(task["user_id"], task["id"], {"metadata": task["metadata"]})
            task = storage.get_task(task["user_id"], task["id"])
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 30, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-heartbeat-empty",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "telegram:empty",
                        "generated_text": None,
                    },
                },
            )

            suppressed = storage.get_task("user-1", "task-passive-empty")
            self.assertEqual(suppressed.get("last_status"), "success")
            self.assertEqual(suppressed.get("last_delivery_outcome"), "suppressed")
            self.assertEqual(suppressed.get("last_delivery_reason"), "telegram:empty")
            self.assertIsNone(suppressed.get("last_generated_text"))
            self.assertEqual(suppressed.get("metadata", {}).get("name"), "Passive Check")
            self.assertNotIn("heartbeat_quiet_streak", suppressed.get("metadata", {}))
            self.assertNotIn("heartbeat_last_pulse_at", suppressed.get("metadata", {}))

    def test_update_after_failure_records_failed_delivery_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-fail")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_failure(task, now, "telegram:timeout")

            updated = storage.get_task("user-1", "task-fail")
            self.assertEqual(updated.get("last_status"), "error")
            self.assertEqual(updated.get("last_error"), "telegram:timeout")
            self.assertEqual(updated.get("last_delivery_outcome"), "failed")
            self.assertEqual(updated.get("last_delivery_reason"), "telegram:timeout")
            self.assertIsNone(updated.get("last_generated_text"))
            self.assertEqual(updated.get("last_delivery", {}).get("outcome"), "failed")
            self.assertEqual(updated.get("active"), 1)
            self.assertIsNotNone(updated.get("next_run_at"))

    def test_update_after_failure_deactivates_orphaned_user_schedule(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-orphaned-user")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_failure(
                task,
                now,
                HttpJsonError(
                    "POST /api/viventium/scheduler/chat failed: HTTP 404 (user_not_found): User not found",
                    status=404,
                    method="POST",
                    path="/api/viventium/scheduler/chat",
                    reason="user_not_found",
                ),
            )

            updated = storage.get_task("user-1", "task-orphaned-user")
            self.assertEqual(updated.get("active"), 0)
            self.assertIsNone(updated.get("next_run_at"))
            self.assertEqual(updated.get("last_status"), "error")
            self.assertEqual(updated.get("last_delivery_outcome"), "failed")
            self.assertEqual(updated.get("last_delivery_reason"), "orphaned_user_not_found")
            self.assertEqual(updated.get("last_delivery", {}).get("failure_class"), "orphaned_user_not_found")

    def test_update_after_success_records_fallback_delivery_as_degraded_outcome(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-fallback")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-fallback",
                    "delivery": {
                        "outcome": "fallback_delivered",
                        "reason": "telegram:insight_fallback",
                        "generated_text": "Best-effort fallback summary",
                        "channels": {
                            "telegram": {
                                "outcome": "fallback_delivered",
                                "reason": "insight_fallback",
                                "fallback_delivered": True,
                            },
                        },
                    },
                },
            )

            updated = storage.get_task("user-1", "task-fallback")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("last_delivery_outcome"), "fallback_delivered")
            self.assertEqual(updated.get("last_delivery_reason"), "telegram:insight_fallback")
            self.assertEqual(updated.get("last_generated_text"), "Best-effort fallback summary")
            self.assertEqual(
                updated.get("last_delivery", {}).get("degradation", {}).get("type"),
                "deferred_fallback",
            )

    def test_update_after_success_records_suppressed_deferred_fallback_as_degraded(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-suppressed-fallback")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-suppressed-fallback",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "telegram:empty_deferred_response",
                        "generated_text": "{NTA}",
                        "channels": {
                            "telegram": {
                                "outcome": "suppressed",
                                "reason": "empty_deferred_response",
                            },
                        },
                    },
                },
            )

            updated = storage.get_task("user-1", "task-suppressed-fallback")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("last_delivery_outcome"), "suppressed")
            self.assertEqual(updated.get("last_delivery_reason"), "telegram:empty_deferred_response")
            self.assertEqual(
                updated.get("last_delivery", {}).get("degradation", {}).get("reason"),
                "telegram:empty_deferred_response",
            )

    def test_update_after_success_reads_deferred_fallback_from_channel_detail(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-channel-fallback")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-channel-fallback",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "suppressed",
                        "generated_text": "{NTA}",
                        "channels": {
                            "telegram": {
                                "outcome": "suppressed",
                                "reason": "empty_deferred_response",
                            },
                        },
                    },
                },
            )

            updated = storage.get_task("user-1", "task-channel-fallback")
            self.assertEqual(updated.get("last_delivery_outcome"), "suppressed")
            self.assertEqual(
                updated.get("last_delivery", {}).get("degradation", {}).get("reason"),
                "telegram:empty_deferred_response",
            )


    def test_update_after_success_with_partial_channel_errors(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-partial")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-partial",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "generated_text": "Good morning!",
                        "channels": {"librechat": {"outcome": "sent", "reason": "delivered"}},
                    },
                    "channel_errors": {"telegram": "Telegram identity not found"},
                },
            )

            updated = storage.get_task("user-1", "task-partial")
            self.assertEqual(updated.get("last_status"), "partial_success")
            self.assertEqual(updated.get("conversation_id"), "conv-partial")
            self.assertIn("channel_errors", updated.get("last_delivery_reason", ""))
            self.assertIn("telegram", updated.get("last_delivery_reason", ""))
            delivery = updated.get("last_delivery", {})
            self.assertIn("channel_errors", delivery)
            self.assertIn("telegram", delivery["channel_errors"])

    def test_update_after_success_without_channel_errors_stays_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-clean")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-clean",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "generated_text": "Hello!",
                    },
                },
            )

            updated = storage.get_task("user-1", "task-clean")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertNotIn("channel_errors", updated.get("last_delivery_reason", ""))

    def test_user_once_misfire_within_window_dispatches_catch_up(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-late-catch-up",
                schedule={"type": "once", "run_at": "2026-02-13T19:00:00", "timezone": "UTC"},
                created_source="user",
                next_run_at="2026-02-13T19:00:00Z",
            )
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
                catch_up_max_late_s=43200,
            )
            now = datetime(2026, 2, 13, 20, 24, 52, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                mock_dispatch.return_value = {
                    "conversation_id": "conv-late",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "generated_text": "Meditate now.",
                    },
                }

                engine._process_task(task, now)

            mock_dispatch.assert_called_once()
            dispatched_task = mock_dispatch.call_args.args[0]
            self.assertEqual(dispatched_task.get("_scheduled_prompt_trigger_kind"), "scheduled")
            self.assertEqual(
                dispatched_task.get("_scheduled_prompt_trigger_source"),
                "scheduler_loop",
            )
            late_delivery = dispatched_task.get("metadata", {}).get(SCHEDULER_MISFIRE_KEY)
            self.assertEqual(late_delivery.get("mode"), "catch_up")
            self.assertEqual(late_delivery.get("due_at"), "2026-02-13T19:00:00Z")
            self.assertEqual(late_delivery.get("late_seconds"), 5092)
            self.assertEqual(late_delivery.get("late_minutes"), 85)

            updated = storage.get_task("user-1", "task-late-catch-up")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("last_delivery_outcome"), "sent")
            self.assertEqual(updated.get("last_delivery_reason"), "delivered_late")
            self.assertEqual(updated.get("active"), 0)
            self.assertIsNone(updated.get("next_run_at"))
            self.assertEqual(updated.get("last_delivery", {}).get("late_delivery", {}).get("late_seconds"), 5092)

    def test_user_once_misfire_policy_does_not_branch_on_schedule_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-user-named-heartbeat",
                schedule={"type": "once", "run_at": "2026-02-13T19:00:00", "timezone": "UTC"},
                created_source="user",
                metadata={"name": "Heartbeat"},
                next_run_at="2026-02-13T19:00:00Z",
            )
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
                catch_up_max_late_s=43200,
            )
            now = datetime(2026, 2, 13, 20, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                mock_dispatch.return_value = {
                    "conversation_id": "conv-name-proof",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "generated_text": "Named schedule still follows structured policy.",
                    },
                }

                engine._process_task(task, now)

            mock_dispatch.assert_called_once()
            dispatched_task = mock_dispatch.call_args.args[0]
            self.assertEqual(
                dispatched_task.get("metadata", {}).get(SCHEDULER_MISFIRE_KEY, {}).get("mode"),
                "catch_up",
            )

    def test_agent_once_misfire_defaults_to_strict_without_name_branching(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-agent-once-strict",
                schedule={"type": "once", "run_at": "2026-02-13T19:00:00", "timezone": "UTC"},
                created_source="agent",
                metadata={"name": "Reminder"},
                next_run_at="2026-02-13T19:00:00Z",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 20, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                engine._process_task(task, now)

            mock_dispatch.assert_not_called()
            updated = storage.get_task("user-1", "task-agent-once-strict")
            self.assertEqual(updated.get("last_status"), "missed")
            self.assertEqual(updated.get("last_delivery_reason"), "misfire_grace_exceeded")
            self.assertEqual(updated.get("last_delivery", {}).get("policy", {}).get("mode"), "strict")

    def test_recurring_user_misfire_can_catch_up_with_structured_policy(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-recurring-user-catch-up",
                schedule={"type": "daily", "time": "19:00", "timezone": "UTC"},
                created_source="user",
                metadata={"misfire_policy": {"mode": "catch_up", "max_late_s": 7200}},
                next_run_at="2026-02-13T19:00:00Z",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 20, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                mock_dispatch.return_value = {
                    "conversation_id": "conv-recurring-catch-up",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "generated_text": "Recurring catch-up.",
                    },
                }

                engine._process_task(task, now)

            mock_dispatch.assert_called_once()
            dispatched_task = mock_dispatch.call_args.args[0]
            late_delivery = dispatched_task.get("metadata", {}).get(SCHEDULER_MISFIRE_KEY)
            self.assertEqual(late_delivery.get("mode"), "catch_up")
            self.assertEqual(late_delivery.get("late_seconds"), 3600)
            updated = storage.get_task("user-1", "task-recurring-user-catch-up")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("last_delivery_reason"), "delivered_late")
            self.assertEqual(updated.get("active"), 1)

    def test_stale_recurring_task_judges_latest_due_occurrence_for_catch_up(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-stale-recurring-catch-up",
                schedule={"type": "daily", "time": "03:00", "timezone": "UTC"},
                created_source="user",
                metadata={"misfire_policy": {"mode": "catch_up", "max_late_s": 43200}},
                next_run_at="2026-07-01T03:00:00Z",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 7, 11, 7, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                mock_dispatch.return_value = {
                    "conversation_id": "conv-latest-occurrence",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "generated_text": "Latest occurrence catch-up.",
                    },
                }
                engine._process_task(task, now)

            mock_dispatch.assert_called_once()
            dispatched_task = mock_dispatch.call_args.args[0]
            late_delivery = dispatched_task.get("metadata", {}).get(SCHEDULER_MISFIRE_KEY)
            self.assertEqual(late_delivery.get("due_at"), "2026-07-11T03:00:00Z")
            self.assertEqual(late_delivery.get("late_seconds"), 4 * 60 * 60)
            updated = storage.get_task("user-1", "task-stale-recurring-catch-up")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("next_run_at"), "2026-07-12T03:00:00Z")

    def test_stale_recurring_task_skip_ledger_names_latest_due_occurrence(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-stale-recurring-too-late",
                schedule={"type": "daily", "time": "03:00", "timezone": "UTC"},
                created_source="user",
                metadata={"misfire_policy": {"mode": "catch_up", "max_late_s": 43200}},
                next_run_at="2026-07-01T03:00:00Z",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 7, 11, 16, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                engine._process_task(task, now)

            mock_dispatch.assert_not_called()
            updated = storage.get_task("user-1", "task-stale-recurring-too-late")
            self.assertEqual(updated.get("last_status"), "missed")
            self.assertEqual(updated.get("last_delivery", {}).get("due_at"), "2026-07-11T03:00:00Z")
            self.assertEqual(updated.get("last_delivery", {}).get("late_seconds"), 13 * 60 * 60)
            self.assertEqual(updated.get("next_run_at"), "2026-07-12T03:00:00Z")

    def test_misfire_policy_mode_normalization(self):
        base_task = {
            "id": "task-policy",
            "created_source": "agent",
            "schedule": {"type": "daily", "time": "19:00", "timezone": "UTC"},
        }

        self.assertEqual(
            _resolve_misfire_policy(
                {**base_task, "metadata": {"misfire_policy": {"mode": " CATCH_UP "}}},
                43200,
            ).get("mode"),
            "catch_up",
        )
        self.assertEqual(
            _resolve_misfire_policy(
                {**base_task, "metadata": {"misfire_policy": {"mode": " miss "}}},
                43200,
            ).get("mode"),
            "strict",
        )
        self.assertEqual(
            _resolve_misfire_policy(
                {**base_task, "metadata": {"misfire_policy": " SKIP "}},
                43200,
            ).get("mode"),
            "strict",
        )

    def test_user_once_misfire_beyond_window_marks_missed_with_ledger(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-too-late",
                schedule={"type": "once", "run_at": "2026-02-13T07:30:00", "timezone": "UTC"},
                created_source="user",
                next_run_at="2026-02-13T07:30:00Z",
            )
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
                catch_up_max_late_s=3600,
            )
            now = datetime(2026, 2, 13, 9, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                engine._process_task(task, now)

            mock_dispatch.assert_not_called()
            updated = storage.get_task("user-1", "task-too-late")
            self.assertEqual(updated.get("last_status"), "missed")
            self.assertEqual(updated.get("last_delivery_outcome"), "missed")
            self.assertEqual(updated.get("last_delivery_reason"), "catch_up_window_exceeded")
            self.assertEqual(updated.get("last_delivery_at"), "2026-02-13T09:00:00Z")
            self.assertEqual(updated.get("active"), 0)
            self.assertIsNone(updated.get("next_run_at"))
            delivery = updated.get("last_delivery", {})
            self.assertEqual(delivery.get("outcome"), "missed")
            self.assertEqual(delivery.get("due_at"), "2026-02-13T07:30:00Z")
            self.assertEqual(delivery.get("late_seconds"), 5400)
            self.assertEqual(delivery.get("policy", {}).get("mode"), "catch_up")

    def test_recurring_misfire_uses_strict_missed_ledger_without_catch_up(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-recurring-late",
                schedule={"type": "daily", "time": "19:00", "timezone": "UTC"},
                created_source="agent",
                next_run_at="2026-02-13T19:00:00Z",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 20, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                engine._process_task(task, now)

            mock_dispatch.assert_not_called()
            updated = storage.get_task("user-1", "task-recurring-late")
            self.assertEqual(updated.get("last_status"), "missed")
            self.assertEqual(updated.get("last_delivery_outcome"), "missed")
            self.assertEqual(updated.get("last_delivery_reason"), "misfire_grace_exceeded")
            self.assertEqual(updated.get("active"), 1)
            self.assertEqual(updated.get("next_run_at"), "2026-02-14T19:00:00Z")
            self.assertEqual(updated.get("last_delivery", {}).get("policy", {}).get("mode"), "strict")

    def test_metadata_strict_policy_overrides_user_once_catch_up_default(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-user-strict",
                schedule={"type": "once", "run_at": "2026-02-13T19:00:00", "timezone": "UTC"},
                created_source="user",
                metadata={"misfire_policy": {"mode": "strict"}},
                next_run_at="2026-02-13T19:00:00Z",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 20, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                engine._process_task(task, now)

            mock_dispatch.assert_not_called()
            updated = storage.get_task("user-1", "task-user-strict")
            self.assertEqual(updated.get("last_status"), "missed")
            self.assertEqual(updated.get("last_delivery_reason"), "misfire_grace_exceeded")
            self.assertEqual(updated.get("last_delivery", {}).get("policy", {}).get("mode"), "strict")


if __name__ == "__main__":
    unittest.main()
