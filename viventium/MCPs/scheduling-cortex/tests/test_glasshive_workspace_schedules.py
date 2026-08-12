# === VIVENTIUM START ===
# Purpose: Regress authoritative GlassHive workspace recurrence ownership and real scheduler fire.
# === VIVENTIUM END ===

import os
import sqlite3
import sys
import tempfile
import time
import unittest
from datetime import date, datetime, timedelta, timezone
from datetime import time as wall_time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
GLASSHIVE_SRC = Path(__file__).resolve().parents[5] / "GlassHive" / "runtime_phase1" / "src"
if str(GLASSHIVE_SRC) not in sys.path:
    sys.path.insert(0, str(GLASSHIVE_SRC))

from workers_projects_runtime.api import create_app as create_glasshive_app

from scheduling_cortex import dispatch as dispatch_module
from scheduling_cortex.glasshive_workspace_schedules import (
    GlassHiveWorkspaceScheduleService,
    WorkspaceScheduleError,
)
from scheduling_cortex.models import CreateScheduleArgs, ScheduleTask
from scheduling_cortex.scheduler import SchedulerEngine
from scheduling_cortex.server import build_server
from scheduling_cortex.storage import ScheduleStorage, StorageConfig
from scheduling_cortex.utils import to_utc_iso
from scheduling_cortex.workspace_recurrence import (
    deterministic_jitter_seconds,
    due_occurrences_and_next,
    normalize_recurrence_spec,
    resolve_local_occurrence,
)
from scheduling_cortex import workspace_recurrence as workspace_recurrence_module

try:
    from starlette.testclient import TestClient
except ImportError:
    TestClient = None


def _payload(next_run_at: str) -> dict:
    return {
        "definition_id": "rsd_synthetic",
        "project_id": "prj_synthetic",
        "worker_id": "wrk_synthetic",
        "instruction": "Run the synthetic workspace check.",
        "schedule_text": "Every hour",
        "recurrence_type": "interval",
        "interval_seconds": 3600,
        "local_time": "",
        "timezone_name": "UTC",
        "dst_policy": "next_valid_earliest",
        "cron_expression": "",
        "rrule": "",
        "starts_at": next_run_at,
        "ends_at": None,
        "enabled": True,
        "overlap_policy": "skip",
        "misfire_grace_seconds": 300,
        "catch_up_policy": "skip",
        "max_catch_up_occurrences": 1,
        "jitter_seconds": 0,
        "next_run_at": next_run_at,
        "execution_mode": "docker",
        "required_capability_servers": [],
    }


def _wait_for_scheduler(engine: SchedulerEngine, timeout_s: float = 5.0) -> None:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        with engine._futures_lock:
            pending = list(engine._futures)
        if not pending:
            return
        for future in pending:
            future.result(timeout=max(0.01, deadline - time.monotonic()))
    raise AssertionError("scheduler worker did not finish within the test timeout")


class GlassHiveWorkspaceScheduleTests(unittest.TestCase):
    def test_workspace_executor_is_reserved_for_the_authenticated_internal_route(self):
        with self.assertRaisesRegex(ValueError, "executor"):
            CreateScheduleArgs(
                prompt="Synthetic public schedule attempt.",
                schedule={
                    "type": "once",
                    "timezone": "UTC",
                    "run_at": "2027-01-02T14:00:00+00:00",
                },
                executor="glasshive_workspace",
            )

    def test_cortex_is_the_only_definition_store_and_accepts_validated_advanced_forms(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(temp_dir) / "schedules.db")))
            service = GlassHiveWorkspaceScheduleService(storage)
            next_run = to_utc_iso(datetime.now(timezone.utc) + timedelta(hours=1))

            created = service.handle(
                "create",
                _payload(next_run),
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )
            listed = service.handle(
                "list",
                {"include_inactive": False, "limit": 100},
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )

            self.assertEqual(created["definition_id"], "rsd_synthetic")
            self.assertEqual(created["schedule_owner"], "viventium_cortex")
            self.assertEqual(listed, [created])
            self.assertEqual(storage.get_task("owner-synthetic", "rsd_synthetic")["executor"], "glasshive_workspace")
            storage.update_task(
                "owner-synthetic",
                "rsd_synthetic",
                {
                    "last_run_at": "2027-01-02T14:00:00+00:00",
                    "last_status": "action_required",
                    "last_error": None,
                    "last_delivery_outcome": "action_required",
                    "last_delivery_reason": "provider_reconnect_required",
                    "last_delivery_at": "2027-01-02T14:00:01+00:00",
                },
            )
            visible = service.handle(
                "get",
                {"definition_id": "rsd_synthetic"},
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )
            self.assertEqual(visible["last_outcome"], "action_required")
            self.assertEqual(visible["last_error"], "provider_reconnect_required")
            self.assertEqual(visible["last_occurrence_at"], "2027-01-02T14:00:00+00:00")
            advanced = service.handle(
                "create",
                {
                    **_payload(next_run),
                    "definition_id": "rsd_rfc",
                    "recurrence_type": "rfc5545",
                    "rrule": "FREQ=HOURLY;COUNT=4",
                    "starts_at": next_run,
                    "ends_at": to_utc_iso(datetime.now(timezone.utc) + timedelta(hours=5)),
                    "overlap_policy": "queue",
                    "catch_up_policy": "bounded",
                    "max_catch_up_occurrences": 3,
                    "jitter_seconds": 90,
                },
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )

            self.assertEqual(advanced["recurrence_type"], "rfc5545")
            self.assertEqual(advanced["rrule"], "FREQ=HOURLY;COUNT=4")
            self.assertEqual(advanced["overlap_policy"], "queue")
            self.assertEqual(advanced["catch_up_policy"], "bounded")
            self.assertEqual(advanced["max_catch_up_occurrences"], 3)
            self.assertEqual(advanced["jitter_seconds"], 90)
            stored = storage.get_task("owner-synthetic", "rsd_rfc")
            self.assertEqual(stored["schedule"]["type"], "glasshive_recurrence")
            self.assertEqual(stored["schedule"]["recurrence_type"], "rfc5545")
            self.assertEqual(
                ScheduleTask(**stored).model_dump()["schedule"]["recurrence_type"],
                "rfc5545",
            )

    def test_advanced_recurrence_validation_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(temp_dir) / "schedules.db")))
            service = GlassHiveWorkspaceScheduleService(storage)
            next_run = to_utc_iso(datetime.now(timezone.utc) + timedelta(hours=1))

            invalid_specs = [
                {"recurrence_type": "rfc5545", "rrule": "not-an-rrule"},
                {
                    "recurrence_type": "rfc5545",
                    "rrule": "FREQ=HOURLY",
                    "starts_at": next_run,
                    "ends_at": to_utc_iso(datetime.now(timezone.utc)),
                },
                {"jitter_seconds": 901},
                {"catch_up_policy": "bounded", "max_catch_up_occurrences": 11},
            ]
            for index, updates in enumerate(invalid_specs):
                with self.subTest(updates=updates), self.assertRaises(WorkspaceScheduleError):
                    service.handle(
                        "create",
                        {**_payload(next_run), "definition_id": f"rsd_invalid_{index}", **updates},
                        tenant_id="tenant-synthetic",
                        owner_id="owner-synthetic",
                        agent_id="agent-synthetic",
                    )

    def test_rfc5545_complexity_and_long_stale_latest_due_match_runtime(self):
        with self.assertRaisesRegex(ValueError, "at least one minute"):
            normalize_recurrence_spec(
                recurrence_type="rfc5545",
                rrule="FREQ=SECONDLY;INTERVAL=30",
                timezone_name="UTC",
            )
        with self.assertRaisesRegex(ValueError, "too complex"):
            normalize_recurrence_spec(
                recurrence_type="rfc5545",
                rrule="FREQ=MINUTELY;BYSECOND=0,15,30,45",
                timezone_name="UTC",
            )
        with self.assertRaisesRegex(ValueError, "INTERVAL"):
            normalize_recurrence_spec(
                recurrence_type="rfc5545",
                rrule="FREQ=MINUTELY;INTERVAL=0",
                timezone_name="UTC",
            )
        with self.assertRaisesRegex(ValueError, "cron_expression"):
            normalize_recurrence_spec(
                recurrence_type="cron",
                cron_expression="*/30 * * * * *",
                timezone_name="UTC",
            )

        spec = normalize_recurrence_spec(
            recurrence_type="rfc5545",
            rrule="FREQ=MINUTELY;INTERVAL=5",
            timezone_name="UTC",
            starts_at="2020-01-01T00:00:00+00:00",
            catch_up_policy="coalesce",
        )
        original_next_after = workspace_recurrence_module.next_after
        calls = 0

        def bounded_next_after(current_spec, occurrence):
            nonlocal calls
            calls += 1
            if calls > 2:
                raise AssertionError("latest-due calculation walked stale occurrences linearly")
            return original_next_after(current_spec, occurrence)

        with patch.object(
            workspace_recurrence_module,
            "next_after",
            side_effect=bounded_next_after,
        ):
            due, following = due_occurrences_and_next(
                spec,
                next_run_at="2020-01-01T00:00:00+00:00",
                now=datetime(2035, 1, 1, 0, 2, tzinfo=timezone.utc),
            )

        self.assertEqual(calls, 1)
        self.assertEqual(
            [item["scheduled_for"].isoformat() for item in due],
            ["2035-01-01T00:00:00+00:00"],
        )
        self.assertEqual(following.isoformat(), "2035-01-01T00:05:00+00:00")

        sparse = normalize_recurrence_spec(
            recurrence_type="rfc5545",
            rrule="FREQ=MINUTELY;BYMONTH=1;BYMONTHDAY=1;BYHOUR=0;BYMINUTE=0",
            timezone_name="UTC",
            starts_at="2020-01-01T00:00:00+00:00",
            catch_up_policy="coalesce",
        )
        sparse_due, sparse_following = due_occurrences_and_next(
            sparse,
            next_run_at="2020-01-01T00:00:00+00:00",
            now=datetime(2035, 7, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(
            [item["scheduled_for"].isoformat() for item in sparse_due],
            ["2035-01-01T00:00:00+00:00"],
        )
        self.assertEqual(
            sparse_following.isoformat(),
            "2036-01-01T00:00:00+00:00",
        )

        monthly = normalize_recurrence_spec(
            recurrence_type="rfc5545",
            rrule="FREQ=MONTHLY",
            timezone_name="UTC",
            starts_at="2020-01-15T09:30:00+00:00",
            catch_up_policy="coalesce",
        )
        monthly_due, monthly_following = due_occurrences_and_next(
            monthly,
            next_run_at="2020-01-15T09:30:00+00:00",
            now=datetime(2035, 7, 20, tzinfo=timezone.utc),
        )
        self.assertEqual(
            [item["scheduled_for"].isoformat() for item in monthly_due],
            ["2035-07-15T09:30:00+00:00"],
        )
        self.assertEqual(
            monthly_following.isoformat(),
            "2035-08-15T09:30:00+00:00",
        )

        month_end = normalize_recurrence_spec(
            recurrence_type="rfc5545",
            rrule="FREQ=MONTHLY",
            timezone_name="UTC",
            starts_at="2020-01-31T15:37:00+00:00",
            catch_up_policy="coalesce",
        )
        month_end_due, month_end_following = due_occurrences_and_next(
            month_end,
            next_run_at="2020-01-31T15:37:00+00:00",
            now=datetime(2035, 4, 1, tzinfo=timezone.utc),
        )
        self.assertEqual(
            [item["scheduled_for"].isoformat() for item in month_end_due],
            ["2035-03-31T15:37:00+00:00"],
        )
        self.assertIsNotNone(month_end_following)
        self.assertEqual(
            month_end_following.isoformat(),
            "2035-05-31T15:37:00+00:00",
        )

    def test_disable_owner_deactivates_only_glasshive_workspace_definitions(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(temp_dir) / "schedules.db")))
            service = GlassHiveWorkspaceScheduleService(storage)
            next_run = to_utc_iso(datetime.now(timezone.utc) + timedelta(hours=1))
            service.handle(
                "create",
                _payload(next_run),
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )
            workspace_task = storage.get_task("owner-synthetic", "rsd_synthetic")
            workspace_metadata = dict(workspace_task["metadata"])
            workspace_schedule = dict(workspace_metadata["glasshive_workspace_schedule"])
            workspace_schedule["pending_occurrence_key"] = next_run
            workspace_metadata["glasshive_workspace_schedule"] = workspace_schedule
            storage.update_task(
                "owner-synthetic",
                "rsd_synthetic",
                {"metadata": workspace_metadata},
            )
            service.handle(
                "create",
                {**_payload(next_run), "definition_id": "rsd_other_tenant"},
                tenant_id="tenant-other",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )
            storage.create_task(
                {
                    **storage.get_task("owner-synthetic", "rsd_synthetic"),
                    "id": "ordinary-viventium-schedule",
                    "executor": "viventium_agent",
                    "metadata": {},
                }
            )

            result = service.handle(
                "deactivate_owner",
                {},
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )

            self.assertEqual(result, {"deactivated": 1})
            deactivated = storage.get_task("owner-synthetic", "rsd_synthetic")
            self.assertEqual(deactivated["active"], 0)
            self.assertNotIn(
                "pending_occurrence_key",
                deactivated["metadata"]["glasshive_workspace_schedule"],
            )
            self.assertEqual(
                storage.get_task("owner-synthetic", "ordinary-viventium-schedule")["active"],
                1,
            )
            self.assertEqual(
                storage.get_task("owner-synthetic", "rsd_other_tenant")["active"],
                1,
            )

    def test_nonretryable_workspace_failure_pauses_action_required_without_retry(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            task = self._create_workspace_task(storage)
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            action_required = dispatch_module.HttpJsonError(
                "Reconnect the required account",
                status=409,
                method="POST",
                path="/internal/scheduling-cortex/workspace-runs",
                payload={"action_required": True},
                failure_class="connected_account_action_required",
                failure_retryable=False,
            )

            with patch(
                "scheduling_cortex.dispatch._post_json",
                side_effect=action_required,
            ) as dispatch:
                engine._process_task(task, datetime.now(timezone.utc))
                paused = storage.get_task("owner-synthetic", "rsd_synthetic")
                engine._tick()

            self.assertEqual(dispatch.call_count, 1)
            self.assertEqual(paused["active"], 0)
            self.assertIsNone(paused["next_run_at"])
            self.assertEqual(paused["last_status"], "action_required")
            self.assertEqual(
                paused["last_delivery"]["failure_class"],
                "connected_account_action_required",
            )

    def test_retryable_workspace_failures_stop_after_bounded_budget(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                "SCHEDULING_GLASSHIVE_MAX_RETRY_ATTEMPTS": "2",
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            task = self._create_workspace_task(storage)
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=1)
            retryable = dispatch_module.HttpJsonError(
                "GlassHive is temporarily unavailable",
                status=503,
                method="POST",
                path="/internal/scheduling-cortex/workspace-runs",
                failure_class="runtime_temporarily_unavailable",
                failure_retryable=True,
            )

            with patch("scheduling_cortex.dispatch._post_json", side_effect=retryable) as dispatch:
                engine._process_task(task, datetime.now(timezone.utc))
                retry_task = storage.get_task("owner-synthetic", "rsd_synthetic")
                engine._process_task(
                    retry_task,
                    datetime.fromisoformat(retry_task["next_run_at"].replace("Z", "+00:00")),
                )
                terminal = storage.get_task("owner-synthetic", "rsd_synthetic")
                engine._tick()

            self.assertEqual(dispatch.call_count, 2)
            self.assertEqual(terminal["active"], 0)
            self.assertIsNone(terminal["next_run_at"])
            self.assertEqual(terminal["last_status"], "terminal")
            self.assertEqual(terminal["last_delivery"]["failure_class"], "retry_budget_exhausted")

    def test_private_detail_failure_is_claimed_and_stops_after_bounded_budget(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                "SCHEDULING_GLASSHIVE_MAX_RETRY_ATTEMPTS": "2",
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            task = self._create_workspace_task(storage)
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=1)

            with patch(
                "scheduling_cortex.dispatch._write_private_run_detail",
                side_effect=OSError("synthetic private detail directory is unavailable"),
            ) as detail_write:
                engine._process_task(task, datetime.now(timezone.utc))
                retry_task = storage.get_task("owner-synthetic", "rsd_synthetic")
                engine._process_task(
                    retry_task,
                    datetime.fromisoformat(retry_task["next_run_at"].replace("Z", "+00:00")),
                )
                terminal = storage.get_task("owner-synthetic", "rsd_synthetic")
                runs = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")

            self.assertEqual(detail_write.call_count, 2)
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0]["attempt_count"], 2)
            self.assertEqual(runs[0]["status"], "failed")
            self.assertEqual(terminal["active"], 0)
            self.assertIsNone(terminal["next_run_at"])
            self.assertEqual(terminal["last_delivery"]["failure_class"], "retry_budget_exhausted")

    def test_daily_dst_policy_selects_the_declared_fold_and_advances_missing_time(self):
        earliest = resolve_local_occurrence(
            date(2027, 11, 7),
            wall_time(1, 30),
            timezone_name="America/New_York",
            dst_policy="next_valid_earliest",
        )
        latest = resolve_local_occurrence(
            date(2027, 11, 7),
            wall_time(1, 30),
            timezone_name="America/New_York",
            dst_policy="next_valid_latest",
        )
        missing = resolve_local_occurrence(
            date(2027, 3, 14),
            wall_time(2, 30),
            timezone_name="America/New_York",
            dst_policy="next_valid_earliest",
        )

        self.assertEqual((latest - earliest).total_seconds(), 3600)
        self.assertEqual(missing.astimezone().tzinfo is not None, True)
        self.assertEqual(missing.isoformat(), "2027-03-14T07:00:00+00:00")

    def test_bounded_catch_up_dispatches_only_the_bounded_latest_occurrences(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            service = GlassHiveWorkspaceScheduleService(storage)
            now = datetime(2027, 1, 2, 12, 30, tzinfo=timezone.utc)
            due = now - timedelta(hours=3)
            service.handle(
                "create",
                {
                    **_payload(to_utc_iso(due)),
                    "starts_at": to_utc_iso(due),
                    "overlap_policy": "queue",
                    "catch_up_policy": "bounded",
                    "max_catch_up_occurrences": 2,
                    "misfire_grace_seconds": 0,
                },
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)

            with patch(
                "scheduling_cortex.dispatch._post_json",
                side_effect=[{"run_id": "run_first"}, {"run_id": "run_second"}],
            ) as dispatch:
                engine._process_task(storage.get_task("owner-synthetic", "rsd_synthetic"), now)

            self.assertEqual(dispatch.call_count, 2)
            runs = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")
            self.assertEqual(len(runs), 2)
            self.assertEqual({run["glasshive_run_id"] for run in runs}, {"run_first", "run_second"})
            next_run = storage.get_task("owner-synthetic", "rsd_synthetic")["next_run_at"]
            self.assertGreater(datetime.fromisoformat(next_run.replace("Z", "+00:00")), now)

    def test_rfc5545_end_boundary_dispatches_the_final_occurrence_then_deactivates(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            first_due = datetime(2027, 1, 2, 12, 0, tzinfo=timezone.utc)
            final_due = first_due + timedelta(hours=1)
            GlassHiveWorkspaceScheduleService(storage).handle(
                "create",
                {
                    **_payload(to_utc_iso(first_due)),
                    "recurrence_type": "rfc5545",
                    "rrule": "FREQ=HOURLY;COUNT=2",
                    "starts_at": to_utc_iso(first_due),
                    "ends_at": to_utc_iso(final_due),
                    "overlap_policy": "queue",
                    "catch_up_policy": "coalesce",
                },
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            with patch(
                "scheduling_cortex.dispatch._post_json",
                side_effect=[{"run_id": "run_first"}, {"run_id": "run_final"}],
            ) as dispatch:
                engine._process_task(
                    storage.get_task("owner-synthetic", "rsd_synthetic"),
                    first_due,
                )
                after_first = storage.get_task("owner-synthetic", "rsd_synthetic")
                self.assertEqual(after_first["next_run_at"], to_utc_iso(final_due))
                self.assertEqual(after_first["active"], 1)
                engine._process_task(after_first, final_due)

            self.assertEqual(dispatch.call_count, 2)
            completed = storage.get_task("owner-synthetic", "rsd_synthetic")
            self.assertEqual(completed["active"], 0)
            self.assertIsNone(completed["next_run_at"])
            self.assertEqual(
                {run["glasshive_run_id"] for run in storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")},
                {"run_first", "run_final"},
            )

    def test_coalesce_and_skip_catch_up_record_truthful_occurrences(self):
        for catch_up_policy, expected_calls, expected_status in (
            ("coalesce", 1, "queued"),
            ("skip", 0, "skipped"),
        ):
            with self.subTest(catch_up_policy=catch_up_policy), tempfile.TemporaryDirectory() as temp_dir, patch.dict(
                os.environ,
                {
                    "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                    "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                },
                clear=True,
            ):
                storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
                now = datetime(2027, 1, 2, 12, 30, tzinfo=timezone.utc)
                due = now - timedelta(hours=3, minutes=10)
                GlassHiveWorkspaceScheduleService(storage).handle(
                    "create",
                    {
                        **_payload(to_utc_iso(due)),
                        "starts_at": to_utc_iso(due),
                        "overlap_policy": "queue",
                        "catch_up_policy": catch_up_policy,
                        "misfire_grace_seconds": 30,
                        "jitter_seconds": 90 if catch_up_policy == "skip" else 0,
                    },
                    tenant_id="tenant-synthetic",
                    owner_id="owner-synthetic",
                    agent_id="agent-synthetic",
                )
                engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
                with patch(
                    "scheduling_cortex.dispatch._post_json",
                    return_value={"run_id": "run_coalesced"},
                ) as dispatch:
                    engine._process_task(storage.get_task("owner-synthetic", "rsd_synthetic"), now)

                self.assertEqual(dispatch.call_count, expected_calls)
                runs = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")
                self.assertEqual(len(runs), 1)
                self.assertEqual(runs[0]["status"], expected_status)
                if catch_up_policy == "skip":
                    occurrence = GlassHiveWorkspaceScheduleService(storage).handle(
                        "occurrences",
                        {"definition_id": "rsd_synthetic", "limit": 20},
                        tenant_id="tenant-synthetic",
                        owner_id="owner-synthetic",
                        agent_id="agent-synthetic",
                    )[0]
                    self.assertEqual(occurrence["outcome"], "misfire_skipped")
                    self.assertEqual(occurrence["last_error"], "misfire_skipped")

    def test_overlap_policy_skips_or_queues_without_losing_the_occurrence(self):
        for overlap_policy, expected_calls, expected_status in (
            ("skip", 0, "skipped"),
            ("queue", 1, "queued"),
        ):
            with self.subTest(overlap_policy=overlap_policy), tempfile.TemporaryDirectory() as temp_dir, patch.dict(
                os.environ,
                {
                    "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                    "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                },
                clear=True,
            ):
                storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
                now = datetime(2027, 1, 2, 12, 0, tzinfo=timezone.utc)
                due = now - timedelta(seconds=1)
                GlassHiveWorkspaceScheduleService(storage).handle(
                    "create",
                    {
                        **_payload(to_utc_iso(due)),
                        "starts_at": to_utc_iso(due),
                        "overlap_policy": overlap_policy,
                        "catch_up_policy": "coalesce",
                    },
                    tenant_id="tenant-synthetic",
                    owner_id="owner-synthetic",
                    agent_id="agent-synthetic",
                )
                storage.create_scheduled_prompt_run(
                    self._run_row(
                        run_id="sp_run_existing",
                        due_at=to_utc_iso(now - timedelta(minutes=10)),
                        status="running",
                    )
                )
                engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
                with patch(
                    "scheduling_cortex.dispatch._post_json",
                    return_value={"run_id": "run_queued"},
                ) as dispatch:
                    engine._process_task(storage.get_task("owner-synthetic", "rsd_synthetic"), now)

                self.assertEqual(dispatch.call_count, expected_calls)
                new_runs = [
                    run
                    for run in storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")
                    if run["run_id"] != "sp_run_existing"
                ]
                self.assertEqual(len(new_runs), 1)
                self.assertEqual(new_runs[0]["status"], expected_status)

    def test_jitter_is_bounded_deterministic_and_delays_dispatch_without_changing_identity(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            due = datetime(2027, 1, 2, 12, 0, tzinfo=timezone.utc)
            jitter = deterministic_jitter_seconds("rsd_synthetic", due, 900)
            self.assertGreater(jitter, 0)
            self.assertLessEqual(jitter, 900)
            GlassHiveWorkspaceScheduleService(storage).handle(
                "create",
                {
                    **_payload(to_utc_iso(due)),
                    "starts_at": to_utc_iso(due),
                    "jitter_seconds": 900,
                    "catch_up_policy": "coalesce",
                },
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            with patch(
                "scheduling_cortex.dispatch._post_json",
                return_value={"run_id": "run_jittered"},
            ) as dispatch:
                task = storage.get_task("owner-synthetic", "rsd_synthetic")
                engine._process_task(task, due)
                waiting = storage.get_task("owner-synthetic", "rsd_synthetic")
                self.assertEqual(waiting["last_status"], "waiting")
                self.assertEqual(
                    waiting["metadata"]["glasshive_workspace_schedule"]["pending_occurrence_key"],
                    to_utc_iso(due),
                )
                dispatch_at = datetime.fromisoformat(waiting["next_run_at"].replace("Z", "+00:00"))
                self.assertEqual(dispatch_at, due + timedelta(seconds=jitter))
                engine._process_task(waiting, dispatch_at)

            self.assertEqual(dispatch.call_count, 1)
            run = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")[0]
            self.assertEqual(run["due_at"], to_utc_iso(due))

    @staticmethod
    def _run_row(*, run_id: str, due_at: str, status: str) -> dict:
        now = to_utc_iso(datetime.now(timezone.utc))
        return {
            "run_id": run_id,
            "task_id": "rsd_synthetic",
            "definition_id": None,
            "user_id": "owner-synthetic",
            "version_id": None,
            "due_at": due_at,
            "started_at": now,
            "completed_at": None,
            "status": status,
            "executor": "glasshive_workspace",
            "rendered_hash": "synthetic-hash",
            "variable_snapshot_hash": None,
            "glasshive_project_id": "prj_synthetic",
            "glasshive_worker_id": "wrk_synthetic",
            "glasshive_run_id": "run_existing" if status in {"queued", "running"} else None,
            "result_summary": None,
            "error_class": None,
            "private_detail_path": None,
            "callback_payload_json": None,
            "created_at": now,
            "updated_at": now,
        }

    def test_real_scheduler_tick_queues_exactly_one_glasshive_workspace_run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = str(Path(temp_dir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            service = GlassHiveWorkspaceScheduleService(storage)
            due = to_utc_iso(datetime.now(timezone.utc) - timedelta(seconds=1))
            service.handle(
                "create",
                _payload(due),
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
            )
            previous_db_path = os.environ.get("SCHEDULING_DB_PATH")
            previous_secret = os.environ.get("VIVENTIUM_SCHEDULER_SECRET")
            os.environ["SCHEDULING_DB_PATH"] = db_path
            os.environ["VIVENTIUM_SCHEDULER_SECRET"] = "synthetic-scheduler-secret"
            try:
                with patch(
                    "scheduling_cortex.dispatch._post_json",
                    return_value={"run_id": "run_synthetic"},
                ) as dispatch:
                    engine._tick()
                    _wait_for_scheduler(engine)
                    engine._tick()
                    _wait_for_scheduler(engine)
            finally:
                if previous_db_path is None:
                    os.environ.pop("SCHEDULING_DB_PATH", None)
                else:
                    os.environ["SCHEDULING_DB_PATH"] = previous_db_path
                if previous_secret is None:
                    os.environ.pop("VIVENTIUM_SCHEDULER_SECRET", None)
                else:
                    os.environ["VIVENTIUM_SCHEDULER_SECRET"] = previous_secret

            self.assertEqual(dispatch.call_count, 1)
            self.assertTrue(dispatch.call_args.args[0].endswith("/internal/scheduling-cortex/workspace-runs"))
            self.assertIn("X-Viventium-Scheduler-Assertion", dispatch.call_args.args[2])
            self.assertNotIn("X-Viventium-Scheduler-Secret", dispatch.call_args.args[2])
            self.assertNotIn("bootstrap_bundle", dispatch.call_args.args[1])
            runs = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")
            self.assertEqual(len(runs), 1)
            self.assertEqual(runs[0]["glasshive_run_id"], "run_synthetic")
            self.assertEqual(storage.get_task("owner-synthetic", "rsd_synthetic")["last_status"], "success")

    def test_workspace_fire_delegates_user_revalidation_to_glasshive_without_credentials(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                "VIVENTIUM_PRIVATE_USER_DATA_DIR": str(Path(temp_dir) / "private"),
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            task = self._create_workspace_task(storage)
            calls: list[str] = []

            def post_json(url, payload, _headers, _timeout):
                calls.append(url)
                if url.endswith("/internal/scheduling-cortex/workspace-runs"):
                    self.assertNotIn("bootstrap_bundle", payload)
                    raise dispatch_module.HttpJsonError(
                        "scheduled user no longer exists",
                        status=404,
                        method="POST",
                        path="/internal/scheduling-cortex/workspace-runs",
                        reason="user_not_found",
                        failure_class="user_not_found",
                        failure_retryable=False,
                    )
                self.fail("Scheduling Cortex must call only the credential-free GlassHive dispatcher")

            with patch(
                "scheduling_cortex.dispatch._post_json", side_effect=post_json
            ), self.assertRaises(dispatch_module.HttpJsonError):
                dispatch_module._dispatch_glasshive_workspace_task(task)

            self.assertEqual(len(calls), 1)
            run = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")[0]
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error_class"], "user_not_found")
            self.assertIsNone(run["glasshive_run_id"])

    def test_workspace_fire_records_glasshive_capability_reconnection_failure(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                "VIVENTIUM_PRIVATE_USER_DATA_DIR": str(Path(temp_dir) / "private"),
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            task = self._create_workspace_task(storage, required_servers=["synthetic-docs"])
            workspace_payloads: list[dict] = []

            def post_json(url, payload, _headers, _timeout):
                if url.endswith("/internal/scheduling-cortex/workspace-runs"):
                    workspace_payloads.append(payload)
                    self.assertNotIn("bootstrap_bundle", payload)
                    raise dispatch_module.HttpJsonError(
                        "connected account requires action",
                        status=409,
                        method="POST",
                        path="/internal/scheduling-cortex/workspace-runs",
                        reason="connected_account_action_required",
                        failure_class="connected_account_action_required",
                        failure_retryable=False,
                    )
                self.fail("Scheduling Cortex must not mint or transport capability credentials")

            with patch(
                "scheduling_cortex.dispatch._post_json", side_effect=post_json
            ), self.assertRaises(dispatch_module.HttpJsonError):
                dispatch_module._dispatch_glasshive_workspace_task(task)

            self.assertEqual(len(workspace_payloads), 1)
            run = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")[0]
            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error_class"], "connected_account_action_required")
            self.assertIsNone(run["glasshive_run_id"])

    def test_workspace_occurrences_delegate_just_in_time_capabilities_without_persisting_bundles(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                "VIVENTIUM_PRIVATE_USER_DATA_DIR": str(Path(temp_dir) / "private"),
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            task = self._create_workspace_task(storage, required_servers=["synthetic-docs"])
            workspace_payloads: list[dict] = []

            def post_json(url, payload, _headers, _timeout):
                if url.endswith("/internal/scheduling-cortex/workspace-runs"):
                    self.assertNotIn("bootstrap_bundle", payload)
                    self.assertNotIn("GLASSHIVE_CAPABILITY_BROKER_TOKEN", str(payload))
                    workspace_payloads.append(payload)
                    return {"run_id": f"run_{len(workspace_payloads)}"}
                self.fail(f"Unexpected URL: {url}")

            with patch("scheduling_cortex.dispatch._post_json", side_effect=post_json):
                first = dispatch_module._dispatch_glasshive_workspace_task(task)
                later = dict(task)
                later["next_run_at"] = to_utc_iso(datetime.now(timezone.utc) + timedelta(hours=1))
                second = dispatch_module._dispatch_glasshive_workspace_task(later)

            self.assertNotEqual(first["scheduled_prompt_run_id"], second["scheduled_prompt_run_id"])
            self.assertEqual(len(workspace_payloads), 2)
            self.assertNotEqual(workspace_payloads[0]["occurrence_id"], workspace_payloads[1]["occurrence_id"])
            stored_task = storage.get_task("owner-synthetic", "rsd_synthetic")
            self.assertNotIn("GLASSHIVE_CAPABILITY_BROKER_TOKEN", str(stored_task))
            for run in storage.list_scheduled_prompt_runs(task_id="rsd_synthetic"):
                self.assertNotIn("GLASSHIVE_CAPABILITY_BROKER_TOKEN", str(run))

    def test_occurrence_claim_blocks_duplicate_dispatch_and_reports_its_lease(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                "VIVENTIUM_PRIVATE_USER_DATA_DIR": str(Path(temp_dir) / "private"),
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            task = self._create_workspace_task(storage)
            with patch(
                "scheduling_cortex.dispatch._post_json",
                side_effect=KeyboardInterrupt("synthetic process crash"),
            ), self.assertRaises(KeyboardInterrupt):
                dispatch_module._dispatch_glasshive_workspace_task(task)

            claimed = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")[0]
            self.assertEqual(claimed["status"], "dispatching")
            self.assertEqual(claimed["attempt_count"], 1)
            self.assertTrue(claimed["claimed_at"])
            self.assertTrue(claimed["claim_expires_at"])
            with patch(
                "scheduling_cortex.dispatch._post_json",
                side_effect=AssertionError("an unexpired claim must not dispatch twice"),
            ) as post_json:
                duplicate = dispatch_module._dispatch_glasshive_workspace_task(task)

            self.assertEqual(post_json.call_count, 0)
            self.assertTrue(duplicate["deferred"])
            self.assertEqual(duplicate["delivery"]["reason"], "occurrence_claim_active")
            unchanged = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")[0]
            self.assertEqual(unchanged["attempt_count"], 1)
            occurrences = GlassHiveWorkspaceScheduleService(storage).handle(
                "occurrences",
                {"definition_id": "rsd_synthetic", "limit": 20},
                tenant_id="tenant-synthetic",
                owner_id="owner-synthetic",
                agent_id="agent-synthetic",
            )
            self.assertEqual(occurrences[0]["attempt_count"], 1)
            self.assertEqual(occurrences[0]["claim_expires_at"], claimed["claim_expires_at"])

    def test_expired_occurrence_claim_is_recovered_idempotently_after_restart(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                "VIVENTIUM_PRIVATE_USER_DATA_DIR": str(Path(temp_dir) / "private"),
            },
            clear=True,
        ):
            db_path = os.environ["SCHEDULING_DB_PATH"]
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            task = self._create_workspace_task(storage)
            with patch(
                "scheduling_cortex.dispatch._post_json",
                side_effect=KeyboardInterrupt("synthetic process crash"),
            ), self.assertRaises(KeyboardInterrupt):
                dispatch_module._dispatch_glasshive_workspace_task(task)
            original = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")[0]
            with sqlite3.connect(db_path) as connection:
                connection.execute(
                    "UPDATE scheduled_prompt_runs SET claim_expires_at = ? WHERE run_id = ?",
                    (to_utc_iso(datetime.now(timezone.utc) - timedelta(seconds=1)), original["run_id"]),
                )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            restarted_task = restarted.get_task("owner-synthetic", "rsd_synthetic")
            with patch(
                "scheduling_cortex.dispatch._post_json",
                return_value={"run_id": "run_recovered"},
            ) as post_json:
                recovered = dispatch_module._dispatch_glasshive_workspace_task(restarted_task)

            self.assertEqual(post_json.call_count, 1)
            self.assertEqual(recovered["scheduled_prompt_run_id"], original["run_id"])
            row = restarted.get_scheduled_prompt_run(original["run_id"])
            self.assertEqual(row["attempt_count"], 2)
            self.assertEqual(row["glasshive_run_id"], "run_recovered")

    @staticmethod
    def _create_workspace_task(
        storage: ScheduleStorage,
        *,
        required_servers: list[str] | None = None,
    ) -> dict:
        due = to_utc_iso(datetime.now(timezone.utc) - timedelta(seconds=1))
        GlassHiveWorkspaceScheduleService(storage).handle(
            "create",
            {
                **_payload(due),
                "required_capability_servers": list(required_servers or []),
            },
            tenant_id="tenant-synthetic",
            owner_id="owner-synthetic",
            agent_id="agent-synthetic",
        )
        return storage.get_task("owner-synthetic", "rsd_synthetic")

    def test_real_scheduler_retry_reaches_glasshive_once_end_to_end(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "VIVENTIUM_DISABLE_DEFAULT_RUNTIME_ENV": "1",
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                "VIVENTIUM_GLASSHIVE_CALLBACK_SECRET": "synthetic-callback-secret",
                "GLASSHIVE_RECURRING_SCHEDULE_OWNER": "viventium_cortex",
                "GLASSHIVE_SCHEDULING_OWNER_URL": "http://127.0.0.1:7110/mcp",
                "GLASSHIVE_SCHEDULER_INTERVAL_S": "3600",
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
            },
            clear=True,
        ):
            glasshive_app = create_glasshive_app(
                str(Path(temp_dir) / "glasshive.db"),
                runtime_backend="stub",
            )
            with TestClient(glasshive_app) as glasshive:
                project = glasshive.post(
                    "/v1/projects",
                    json={
                        "owner_id": "owner-synthetic",
                        "title": "Synthetic scheduler project",
                        "goal": "Prove exactly-once delegated dispatch.",
                        "default_worker_profile": "codex-cli",
                    },
                )
                self.assertEqual(project.status_code, 201, project.text)
                worker = glasshive.post(
                    f"/v1/projects/{project.json()['project_id']}/workers",
                    json={
                        "owner_id": "owner-synthetic",
                        "name": "Synthetic scheduler worker",
                        "role": "operator",
                        "profile": "codex-cli",
                        "execution_mode": "docker",
                        "start_synchronously": False,
                    },
                )
                self.assertEqual(worker.status_code, 201, worker.text)

                storage = ScheduleStorage(
                    StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"])
                )
                due = to_utc_iso(datetime.now(timezone.utc) - timedelta(seconds=1))
                payload = {
                    **_payload(due),
                    "project_id": project.json()["project_id"],
                    "worker_id": worker.json()["worker_id"],
                }
                GlassHiveWorkspaceScheduleService(storage).handle(
                    "create",
                    payload,
                    tenant_id="local",
                    owner_id="owner-synthetic",
                    agent_id="agent-synthetic",
                )

                attempts = 0

                def post_to_glasshive(url, body, headers, timeout):
                    nonlocal attempts
                    if url.endswith("/glasshive-capabilities/grant"):
                        return {
                            "bootstrapBundle": {},
                            "grantRef": None,
                            "capabilityStatus": {"status": "degraded", "reason": "no_reviewed_capabilities"},
                        }
                    attempts += 1
                    self.assertTrue(url.endswith("/internal/scheduling-cortex/workspace-runs"))
                    self.assertGreater(timeout, 0)
                    self.assertIn("X-Viventium-Scheduler-Assertion", headers)
                    self.assertNotIn("X-Viventium-Scheduler-Secret", headers)
                    response = glasshive.post(
                        "/internal/scheduling-cortex/workspace-runs",
                        json=body,
                        headers=headers,
                    )
                    self.assertEqual(response.status_code, 202, response.text)
                    if attempts == 1:
                        raise RuntimeError("synthetic response lost after GlassHive accepted the run")
                    return response.json()

                engine = SchedulerEngine(
                    storage,
                    poll_interval_s=30,
                    misfire_grace_s=900,
                    retry_delay_s=300,
                )
                with patch("scheduling_cortex.dispatch._post_json", side_effect=post_to_glasshive), patch(
                    "workers_projects_runtime.service.httpx.post",
                    return_value=type("Response", (), {"status_code": 200})(),
                ):
                    engine._tick()
                    _wait_for_scheduler(engine)
                    retry_task = storage.get_task("owner-synthetic", "rsd_synthetic")
                    self.assertEqual(retry_task["last_status"], "error")
                    retry_at = datetime.fromisoformat(
                        str(retry_task["next_run_at"]).replace("Z", "+00:00")
                    )
                    engine._process_task(retry_task, retry_at + timedelta(seconds=1))

                runs = glasshive.app.state.store.list_runs_for_worker(
                    worker.json()["worker_id"],
                    tenant_id="local",
                )
                self.assertEqual(len(runs), 1)
                self.assertEqual(runs[0]["instruction"], payload["instruction"])
                self.assertEqual(attempts, 2)

    def test_real_scheduler_terminal_callback_reconciles_the_authoritative_occurrence(self):
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                "VIVENTIUM_DISABLE_DEFAULT_RUNTIME_ENV": "1",
                "VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret",
                "VIVENTIUM_GLASSHIVE_CALLBACK_SECRET": "synthetic-callback-secret",
                "SCHEDULING_GLASSHIVE_CALLBACK_SECRET": "synthetic-callback-secret",
                "GLASSHIVE_RECURRING_SCHEDULE_OWNER": "viventium_cortex",
                "GLASSHIVE_SCHEDULING_OWNER_URL": "http://127.0.0.1:7110/mcp",
                "GLASSHIVE_SCHEDULER_INTERVAL_S": "3600",
                "SCHEDULING_DB_PATH": str(Path(temp_dir) / "schedules.db"),
            },
            clear=True,
        ):
            storage = ScheduleStorage(StorageConfig(db_path=os.environ["SCHEDULING_DB_PATH"]))
            cortex_app = build_server(storage).http_app(transport="streamable-http")
            glasshive_app = create_glasshive_app(
                str(Path(temp_dir) / "glasshive.db"),
                runtime_backend="stub",
            )
            with TestClient(cortex_app) as cortex, TestClient(glasshive_app) as glasshive:
                project = glasshive.post(
                    "/v1/projects",
                    json={
                        "owner_id": "owner-synthetic",
                        "title": "Synthetic callback project",
                        "goal": "Prove delegated terminal callback reconciliation.",
                        "default_worker_profile": "codex-cli",
                    },
                )
                worker = glasshive.post(
                    f"/v1/projects/{project.json()['project_id']}/workers",
                    json={
                        "owner_id": "owner-synthetic",
                        "name": "Synthetic callback worker",
                        "role": "operator",
                        "profile": "codex-cli",
                        "execution_mode": "docker",
                        "start_synchronously": False,
                    },
                )
                due = to_utc_iso(datetime.now(timezone.utc) - timedelta(seconds=1))
                GlassHiveWorkspaceScheduleService(storage).handle(
                    "create",
                    {
                        **_payload(due),
                        "project_id": project.json()["project_id"],
                        "worker_id": worker.json()["worker_id"],
                    },
                    tenant_id="local",
                    owner_id="owner-synthetic",
                    agent_id="agent-synthetic",
                )
                def post_to_glasshive(_url, body, headers, _timeout):
                    self.assertTrue(_url.endswith("/internal/scheduling-cortex/workspace-runs"))
                    self.assertNotIn("bootstrap_bundle", body)
                    self.assertIn("X-Viventium-Scheduler-Assertion", headers)
                    self.assertNotIn("X-Viventium-Scheduler-Secret", headers)
                    response = glasshive.post(
                        "/internal/scheduling-cortex/workspace-runs",
                        json=body,
                        headers=headers,
                    )
                    self.assertEqual(response.status_code, 202, response.text)
                    return response.json()

                def post_callback(_url, *, content, headers, timeout):
                    self.assertGreater(timeout, 0)
                    return cortex.post(
                        "/internal/scheduled-prompts/glasshive-callback",
                        content=content,
                        headers=headers,
                    )

                engine = SchedulerEngine(
                    storage,
                    poll_interval_s=30,
                    misfire_grace_s=900,
                    retry_delay_s=300,
                )
                with patch("scheduling_cortex.dispatch._post_json", side_effect=post_to_glasshive), patch(
                    "workers_projects_runtime.service.httpx.post",
                    side_effect=post_callback,
                ):
                    engine._tick()
                    deadline = datetime.now(timezone.utc) + timedelta(seconds=2)
                    while datetime.now(timezone.utc) < deadline:
                        runs = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")
                        if runs and runs[0]["status"] == "completed":
                            break
                        time.sleep(0.01)

                runs = storage.list_scheduled_prompt_runs(task_id="rsd_synthetic")
                self.assertEqual(len(runs), 1)
                self.assertEqual(runs[0]["status"], "completed")
                self.assertTrue(runs[0]["glasshive_run_id"])
                self.assertEqual(runs[0]["callback_payload"]["event"], "run.completed")
                glasshive_run = glasshive.app.state.store.get_run(runs[0]["glasshive_run_id"])
                self.assertIsNone(glasshive_run["runtime_bundle_json"])
                persisted_worker = glasshive.app.state.store.get_worker(worker.json()["worker_id"])
                self.assertNotIn("GLASSHIVE_CAPABILITY_BROKER_TOKEN", str(persisted_worker))
                private_detail = Path(runs[0]["private_detail_path"]).read_text(encoding="utf-8")
                self.assertNotIn("GLASSHIVE_CAPABILITY_BROKER_TOKEN", private_detail)
                occurrences = GlassHiveWorkspaceScheduleService(storage).handle(
                    "occurrences",
                    {"definition_id": "rsd_synthetic", "limit": 20},
                    tenant_id="local",
                    owner_id="owner-synthetic",
                    agent_id="agent-synthetic",
                )
                self.assertEqual(occurrences[0]["state"], "completed")


@unittest.skipIf(TestClient is None, "starlette[testclient] not installed")
class GlassHiveWorkspaceScheduleRouteTests(unittest.TestCase):
    def test_internal_owner_route_requires_secret_and_matching_identity(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(temp_dir) / "schedules.db")))
            mcp = build_server(storage)
            app = mcp.http_app(transport="streamable-http")
            request = {
                "action": "create",
                "tenant_id": "tenant-synthetic",
                "owner_id": "owner-synthetic",
                "agent_id": "agent-synthetic",
                "payload": _payload(to_utc_iso(datetime.now(timezone.utc) + timedelta(hours=1))),
            }
            with patch.dict(
                os.environ,
                {"VIVENTIUM_SCHEDULER_SECRET": "synthetic-scheduler-secret"},
                clear=False,
            ), TestClient(app) as client:
                unauthorized = client.post(
                    "/internal/glasshive/recurring-schedules",
                    json=request,
                )
                mismatch = client.post(
                    "/internal/glasshive/recurring-schedules",
                    headers={
                        "X-Viventium-Scheduler-Secret": "synthetic-scheduler-secret",
                        "X-Viventium-Tenant-Id": "tenant-synthetic",
                        "X-Viventium-User-Id": "another-owner",
                        "X-Viventium-Agent-Id": "agent-synthetic",
                    },
                    json=request,
                )
                authorized = client.post(
                    "/internal/glasshive/recurring-schedules",
                    headers={
                        "X-Viventium-Scheduler-Secret": "synthetic-scheduler-secret",
                        "X-Viventium-Tenant-Id": "tenant-synthetic",
                        "X-Viventium-User-Id": "owner-synthetic",
                        "X-Viventium-Agent-Id": "agent-synthetic",
                    },
                    json=request,
                )

            self.assertEqual(unauthorized.status_code, 401)
            self.assertEqual(mismatch.status_code, 403)
            self.assertEqual(authorized.status_code, 200)
            self.assertEqual(authorized.json()["result"]["definition_id"], "rsd_synthetic")


if __name__ == "__main__":
    unittest.main()
