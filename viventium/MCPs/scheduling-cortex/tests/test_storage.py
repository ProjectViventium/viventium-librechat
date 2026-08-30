# === VIVENTIUM START ===
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# === VIVENTIUM END ===

import sys
import tempfile
import threading
import unittest
import sqlite3
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.storage import (
    ScheduleStorage,
    StorageConfig,
    scheduled_prompt_stale_seconds,
)


def _build_task(
    task_id: str,
    user_id: str = "user-1",
    created_at: str = "2026-02-13T19:00:00Z",
    prompt: str = "Check in",
):
    return {
        "id": task_id,
        "user_id": user_id,
        "agent_id": "agent-1",
        "prompt": prompt,
        "schedule": {"type": "daily", "time": "09:00", "timezone": "UTC"},
        "channel": "telegram",
        "conversation_policy": "new",
        "conversation_id": None,
        "last_conversation_id": None,
        "active": 1,
        "created_by": "agent:agent-1",
        "created_source": "agent",
        "created_at": created_at,
        "updated_at": created_at,
        "updated_by": "agent:agent-1",
        "updated_source": "agent",
        "last_run_at": None,
        "next_run_at": "2026-02-13T20:00:00Z",
        "last_status": None,
        "last_error": None,
        "metadata": {"telegram_user_id": "123"},
    }


class StorageDeliveryLedgerTests(unittest.TestCase):
    def test_schedule_search_finds_a_topic_when_the_user_paraphrases_the_saved_prompt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            storage.create_task(
                _build_task(
                    "recommender-task",
                    prompt=(
                        "Continue the immigration recommendation work by asking which "
                        "recommender will sign the letter."
                    ),
                )
            )
            storage.create_task(
                _build_task(
                    "unrelated-task",
                    prompt="Run the first morning account review.",
                )
            )

            matches = storage.search_tasks(
                "user-1",
                query="which recommender should sign first",
            )

            self.assertEqual([task["id"] for task in matches], ["recommender-task"])

    def test_scheduled_telegram_delivery_claim_is_durable_and_reuses_confirmed_receipt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            first = storage.claim_scheduled_prompt_delivery(
                run_id="run-1",
                occurrence_key="occurrence-1",
                channel="telegram",
                part_index=0,
                payload_hash="payload-1",
                lease_owner="sender-1",
                now="2026-08-20T12:00:00Z",
                lease_seconds=30,
            )
            self.assertTrue(first["claimed"])

            sent = storage.complete_scheduled_prompt_delivery(
                delivery_key=first["delivery_key"],
                lease_owner="sender-1",
                message_id="91",
                now="2026-08-20T12:00:01Z",
            )
            self.assertTrue(sent["updated"])

            replay = storage.claim_scheduled_prompt_delivery(
                run_id="run-1",
                occurrence_key="occurrence-1",
                channel="telegram",
                part_index=0,
                payload_hash="payload-1",
                lease_owner="sender-2",
                now="2026-08-20T12:01:00Z",
                lease_seconds=30,
            )
            self.assertFalse(replay["claimed"])
            self.assertEqual(replay["reason"], "already_sent")
            self.assertEqual(replay["delivery"]["message_id"], "91")

    def test_expired_scheduled_telegram_send_claim_becomes_delivery_unknown(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            first = storage.claim_scheduled_prompt_delivery(
                run_id="run-2",
                occurrence_key="occurrence-2",
                channel="telegram",
                part_index=0,
                payload_hash="payload-2",
                lease_owner="sender-1",
                now="2026-08-20T12:00:00Z",
                lease_seconds=30,
            )
            recovered = storage.claim_scheduled_prompt_delivery(
                run_id="run-2",
                occurrence_key="occurrence-2",
                channel="telegram",
                part_index=0,
                payload_hash="payload-2",
                lease_owner="sender-2",
                now="2026-08-20T12:01:00Z",
                lease_seconds=30,
            )
            self.assertFalse(recovered["claimed"])
            self.assertEqual(recovered["reason"], "delivery_unknown")
            self.assertEqual(recovered["delivery"]["state"], "delivery_unknown")
            self.assertEqual(recovered["delivery_key"], first["delivery_key"])

    def test_scheduled_telegram_delivery_payload_change_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            storage.claim_scheduled_prompt_delivery(
                run_id="run-3",
                occurrence_key="occurrence-3",
                channel="telegram",
                part_index=0,
                payload_hash="payload-original",
                lease_owner="sender-1",
                now="2026-08-20T12:00:00Z",
                lease_seconds=30,
            )
            conflict = storage.claim_scheduled_prompt_delivery(
                run_id="run-3",
                occurrence_key="occurrence-3",
                channel="telegram",
                part_index=0,
                payload_hash="payload-changed",
                lease_owner="sender-2",
                now="2026-08-20T12:00:01Z",
                lease_seconds=30,
            )
            self.assertFalse(conflict["claimed"])
            self.assertEqual(conflict["reason"], "payload_conflict")
            self.assertEqual(conflict["delivery"]["state"], "delivery_unknown")

    def test_concurrent_restore_uses_independent_consistent_snapshots(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            local_path = root / "local.db"
            mirror_path = root / "mirror.db"
            with sqlite3.connect(mirror_path) as conn:
                conn.execute("CREATE TABLE evidence (value TEXT NOT NULL)")
                conn.execute("INSERT INTO evidence VALUES ('mirror-complete')")

            copy_barrier = threading.Barrier(4)
            original_copy = __import__("shutil").copy2

            def synchronized_copy(source, destination):
                copy_barrier.wait()
                result = original_copy(source, destination)
                copy_barrier.wait()
                return result

            def restore(_index):
                ScheduleStorage(
                    StorageConfig(db_path=str(local_path), mirror_db_path=str(mirror_path))
                )

            with patch("scheduling_cortex.storage.shutil.copy2", side_effect=synchronized_copy), patch(
                "scheduling_cortex.storage.logger.warning"
            ) as warning:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(restore, range(4)))

            warning.assert_not_called()
            with sqlite3.connect(local_path) as conn:
                self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(conn.execute("SELECT value FROM evidence").fetchone()[0], "mirror-complete")

    def test_restore_over_live_wal_replaces_stale_state_without_replay(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            local_path = root / "local.db"
            mirror_path = root / "mirror.db"
            local = sqlite3.connect(local_path)
            try:
                local.execute("PRAGMA journal_mode=WAL")
                local.execute("PRAGMA wal_autocheckpoint=0")
                local.execute("CREATE TABLE evidence (value TEXT NOT NULL)")
                local.execute("INSERT INTO evidence VALUES ('stale-local')")
                local.commit()
                with sqlite3.connect(mirror_path) as mirror:
                    mirror.execute("CREATE TABLE evidence (value TEXT NOT NULL)")
                    mirror.execute("INSERT INTO evidence VALUES ('fresh-mirror')")
                wal_path = Path(f"{local_path}-wal")
                future = max(local_path.stat().st_mtime, wal_path.stat().st_mtime) + 10
                os.utime(mirror_path, (future, future))

                storage = ScheduleStorage.__new__(ScheduleStorage)
                storage._db_path = local_path
                storage._mirror_path = mirror_path
                storage._mirror_lock = threading.Lock()
                storage._read_only = False
                storage._restore_from_mirror()

                with sqlite3.connect(local_path) as restored:
                    self.assertEqual(restored.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                    self.assertEqual(
                        restored.execute("SELECT value FROM evidence").fetchall(),
                        [("fresh-mirror",)],
                    )
            finally:
                local.close()

    def test_concurrent_writers_leave_mirror_complete_and_integral(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            mirror_path = Path(tmpdir) / "mirror" / "schedules.db"
            storage = ScheduleStorage(
                StorageConfig(db_path=str(db_path), mirror_db_path=str(mirror_path))
            )
            barrier = threading.Barrier(4)

            def create(index):
                barrier.wait()
                storage.create_task(
                    _build_task(f"mirror-task-{index}", prompt=f"Check in {index}")
                )

            copy_barrier = threading.Barrier(4)
            original_copy = __import__("shutil").copy2

            def synchronized_copy(source, destination):
                copy_barrier.wait()
                result = original_copy(source, destination)
                copy_barrier.wait()
                return result

            with patch("scheduling_cortex.storage.shutil.copy2", side_effect=synchronized_copy), patch(
                "scheduling_cortex.storage.logger.warning"
            ) as warning:
                with ThreadPoolExecutor(max_workers=4) as pool:
                    list(pool.map(create, range(4)))

            warning.assert_not_called()
            with sqlite3.connect(mirror_path) as conn:
                self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM scheduled_tasks").fetchone()[0], 4)

    def test_create_task_sets_delivery_defaults(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            storage.create_task(_build_task("task-1"))

            task = storage.get_task("user-1", "task-1")
            self.assertIsNotNone(task)
            self.assertIsNone(task.get("last_delivery_outcome"))
            self.assertIsNone(task.get("last_delivery_reason"))
            self.assertIsNone(task.get("last_delivery_at"))
            self.assertIsNone(task.get("last_generated_text"))
            self.assertIsNone(task.get("last_delivery"))

    def test_update_task_persists_delivery_ledger(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            storage.create_task(_build_task("task-2"))

            storage.update_task(
                "user-1",
                "task-2",
                {
                    "last_delivery_outcome": "suppressed",
                    "last_delivery_reason": "telegram:nta",
                    "last_delivery_at": "2026-02-13T19:01:00Z",
                    "last_generated_text": "{NTA}",
                    "last_delivery": {
                        "outcome": "suppressed",
                        "reason": "telegram:nta",
                        "generated_text": "{NTA}",
                        "channels": {
                            "telegram": {
                                "outcome": "suppressed",
                                "reason": "nta",
                            }
                        },
                    },
                },
            )

            task = storage.get_task("user-1", "task-2")
            self.assertEqual(task.get("last_delivery_outcome"), "suppressed")
            self.assertEqual(task.get("last_delivery_reason"), "telegram:nta")
            self.assertEqual(task.get("last_generated_text"), "{NTA}")
            self.assertEqual(task.get("last_delivery", {}).get("outcome"), "suppressed")
            self.assertEqual(task.get("last_delivery", {}).get("channels", {}).get("telegram", {}).get("reason"), "nta")

    def test_get_latest_delivery_task_orders_by_delivery_timestamp(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            storage.create_task(
                _build_task(
                    "task-old", created_at="2026-02-13T17:00:00Z", prompt="Old check in"
                )
            )
            storage.create_task(
                _build_task(
                    "task-new", created_at="2026-02-13T18:00:00Z", prompt="New check in"
                )
            )

            storage.update_task(
                "user-1",
                "task-old",
                {
                    "last_delivery_at": "2026-02-13T18:59:00Z",
                    "last_delivery_outcome": "sent",
                },
            )
            storage.update_task(
                "user-1",
                "task-new",
                {
                    "last_delivery_at": "2026-02-13T19:05:00Z",
                    "last_delivery_outcome": "suppressed",
                },
            )

            latest = storage.get_latest_delivery_task("user-1")
            self.assertIsNotNone(latest)
            self.assertEqual(latest.get("id"), "task-new")
            self.assertEqual(latest.get("last_delivery_outcome"), "suppressed")

    def test_exact_structural_create_replay_returns_the_existing_schedule(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            first = _build_task("task-first")
            replay = _build_task("task-replay", created_at="2026-02-13T19:01:00Z")

            stored_first = storage.create_task(first)
            stored_replay = storage.create_task(replay)

            self.assertEqual(stored_first["id"], "task-first")
            self.assertEqual(stored_replay["id"], "task-first")
            self.assertEqual(len(storage.list_tasks("user-1")), 1)

    def test_runtime_deferral_metadata_does_not_change_structural_schedule_identity(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            first = _build_task("task-first")
            stored_first = storage.create_task(first)
            storage.update_task(
                "user-1",
                "task-first",
                {
                    "metadata": {
                        **stored_first["metadata"],
                        "scheduler_deferred_occurrence_v1": {
                            "version": 1,
                            "due_at": "2026-02-13T20:00:00Z",
                            "blocked_at": "2026-02-13T19:59:59Z",
                            "blocker_run_id": "manual-run",
                            "blocker_trigger_kind": "manual",
                        },
                    }
                },
            )

            replay = _build_task("task-replay", created_at="2026-02-13T19:01:00Z")
            stored_replay = storage.create_task(replay)

            self.assertEqual(stored_replay["id"], "task-first")
            self.assertEqual(len(storage.list_tasks("user-1")), 1)

    def test_runtime_outcome_metadata_does_not_change_structural_schedule_identity(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            first = _build_task("task-first")
            stored_first = storage.create_task(first)
            storage.update_task(
                "user-1",
                "task-first",
                {
                    "metadata": {
                        **stored_first["metadata"],
                        "recurrence_state_v1": {"outcome": "failed", "occurrence_count": 3},
                        "scheduled_failure_state_v1": {"failure_class": "provider_error"},
                        "scheduler_misfire": {"late_seconds": 120},
                        "heartbeat_quiet_streak": 2,
                        "heartbeat_last_pulse_at": "2026-02-13T20:00:00Z",
                    }
                },
            )

            replay = _build_task("task-replay", created_at="2026-02-13T19:01:00Z")
            stored_replay = storage.create_task(replay)

            self.assertEqual(stored_replay["id"], "task-first")
            self.assertEqual(len(storage.list_tasks("user-1")), 1)

    def test_meaningful_user_metadata_change_creates_a_distinct_schedule(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            storage.create_task(_build_task("task-first"))
            changed = _build_task("task-changed")
            changed["metadata"] = {"telegram_user_id": "456"}

            stored = storage.create_task(changed)

            self.assertEqual(stored["id"], "task-changed")
            self.assertEqual(len(storage.list_tasks("user-1")), 2)

    def test_meaningful_structural_change_creates_a_distinct_schedule(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            storage.create_task(_build_task("task-first"))
            changed = _build_task("task-changed")
            changed["schedule"] = {"type": "daily", "time": "10:00", "timezone": "UTC"}

            stored = storage.create_task(changed)

            self.assertEqual(stored["id"], "task-changed")
            self.assertEqual(len(storage.list_tasks("user-1")), 2)


class StorageTemplateMetadataTests(unittest.TestCase):
    """Tests for find_by_metadata_template used by bootstrap idempotency."""

    def test_find_existing_template(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            task = _build_task("task-tpl")
            task["metadata"] = {"template_id": "morning_briefing_default_v1"}
            storage.create_task(task)

            found = storage.find_by_metadata_template("user-1", "morning_briefing_default_v1")
            self.assertIsNotNone(found)
            self.assertEqual(found["id"], "task-tpl")

    def test_returns_none_for_missing_template(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            storage.create_task(_build_task("task-other"))

            found = storage.find_by_metadata_template("user-1", "morning_briefing_default_v1")
            self.assertIsNone(found)

    def test_isolates_by_user_id(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            task = _build_task("task-u1", user_id="user-1")
            task["metadata"] = {"template_id": "morning_briefing_default_v1"}
            storage.create_task(task)

            found_u2 = storage.find_by_metadata_template("user-2", "morning_briefing_default_v1")
            self.assertIsNone(found_u2)

            found_u1 = storage.find_by_metadata_template("user-1", "morning_briefing_default_v1")
            self.assertIsNotNone(found_u1)


class StorageScheduledPromptLifecycleTests(unittest.TestCase):
    def test_occurrence_recovery_is_bounded_without_shortening_external_work_window(self):
        with patch.dict(os.environ, {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""}):
            self.assertEqual(ScheduleStorage._scheduled_prompt_stale_seconds(), 15 * 60)
            self.assertEqual(scheduled_prompt_stale_seconds(), 24 * 60 * 60)

    def test_positive_stale_override_is_shared_by_recovery_and_external_work(self):
        with patch.dict(os.environ, {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": "7200"}):
            self.assertEqual(ScheduleStorage._scheduled_prompt_stale_seconds(), 7200)
            self.assertEqual(scheduled_prompt_stale_seconds(), 7200)

    def test_run_schema_migrates_in_place_and_preserves_historical_rows(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            now = "2026-08-10T12:00:00Z"
            storage.create_scheduled_prompt_run(
                {
                    "run_id": "historical-run",
                    "task_id": "task-1",
                    "definition_id": None,
                    "user_id": "user-1",
                    "version_id": None,
                    "due_at": now,
                    "started_at": now,
                    "completed_at": now,
                    "status": "completed",
                    "executor": "viventium_agent",
                    "rendered_hash": None,
                    "variable_snapshot_hash": None,
                    "glasshive_project_id": None,
                    "glasshive_worker_id": None,
                    "glasshive_run_id": None,
                    "result_summary": "completed",
                    "error_class": None,
                    "private_detail_path": None,
                    "callback_payload_json": None,
                    "created_at": now,
                    "updated_at": now,
                }
            )

            migrated = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            row = migrated.get_scheduled_prompt_run("historical-run")

            self.assertEqual(row["status"], "completed")
            self.assertIsNone(row["occurrence_key"])
            self.assertIsNone(row["lease_owner"])
            self.assertIsNone(row["lease_until"])
            self.assertEqual(row["attempt"], 0)
            self.assertIsNone(row["disposition"])
            self.assertIsNone(row["execution_snapshot"])
            self.assertIsNone(row["channel_outcomes"])
            self.assertIsNone(row["interaction_ref"])

    def test_occurrence_claim_is_atomic_across_storage_instances(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            ScheduleStorage(StorageConfig(db_path=str(db_path)))
            barrier = threading.Barrier(2)
            results = []

            def claim(owner: str) -> None:
                storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
                barrier.wait()
                results.append(
                    storage.claim_scheduled_prompt_occurrence(
                        task_id="task-1",
                        user_id="user-1",
                        executor="viventium_agent",
                        due_at="2026-08-10T12:00:00Z",
                        lease_owner=owner,
                        now="2026-08-10T12:00:00Z",
                        lease_seconds=60,
                    )
                )

            threads = [threading.Thread(target=claim, args=(f"owner-{index}",)) for index in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            self.assertEqual(sum(1 for result in results if result["claimed"]), 1)
            self.assertEqual(len({result["run"]["run_id"] for result in results}), 1)
            rows = ScheduleStorage(StorageConfig(db_path=str(db_path))).list_scheduled_prompt_runs(
                task_id="task-1"
            )
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["attempt"], 1)

    def test_claim_blocks_another_occurrence_for_task_until_lease_expires(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            first = storage.claim_scheduled_prompt_occurrence(
                task_id="task-1",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-10T12:00:00Z",
                lease_owner="owner-1",
                now="2026-08-10T12:00:00Z",
                lease_seconds=60,
            )
            blocked = storage.claim_scheduled_prompt_occurrence(
                task_id="task-1",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-10T12:05:00Z",
                lease_owner="owner-2",
                now="2026-08-10T12:00:30Z",
                lease_seconds=60,
            )
            recovered = storage.claim_scheduled_prompt_occurrence(
                task_id="task-1",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-10T12:00:00Z",
                lease_owner="owner-2",
                now="2026-08-10T12:01:01Z",
                lease_seconds=60,
            )

            self.assertTrue(first["claimed"])
            self.assertFalse(blocked["claimed"])
            self.assertEqual(blocked["reason"], "task_has_active_occurrence")
            self.assertTrue(recovered["claimed"])
            self.assertEqual(recovered["run"]["run_id"], first["run"]["run_id"])
            self.assertEqual(recovered["run"]["attempt"], 2)
            self.assertEqual(recovered["run"]["disposition"], "running")

    def test_stale_running_heartbeat_cannot_pin_task_with_oversized_future_lease(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            abandoned = storage.claim_scheduled_prompt_occurrence(
                task_id="task-stale-heartbeat",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T03:00:00Z",
                lease_owner="scheduler:abandoned",
                now="2026-08-20T03:00:00Z",
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                abandoned["run"]["run_id"],
                {
                    "status": "running",
                    "updated_at": "2026-08-20T03:00:00Z",
                },
            )

            recovered = storage.claim_scheduled_prompt_occurrence(
                task_id="task-stale-heartbeat",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T03:45:00Z",
                lease_owner="scheduler:recovered",
                now="2026-08-20T03:45:00Z",
                lease_seconds=15 * 60,
            )

            self.assertTrue(recovered["claimed"])
            self.assertNotEqual(recovered["run"]["run_id"], abandoned["run"]["run_id"])
            abandoned_run = storage.get_scheduled_prompt_run(abandoned["run"]["run_id"])
            self.assertEqual(abandoned_run["status"], "failed")
            self.assertEqual(abandoned_run["disposition"], "failed")
            self.assertEqual(abandoned_run["error_class"], "stale_run_reconciled")

    def test_stale_oversized_lease_can_recover_undispatched_occurrence_once(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            abandoned = storage.claim_scheduled_prompt_occurrence(
                task_id="task-undispatched",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T03:00:00Z",
                lease_owner="scheduler:abandoned",
                now="2026-08-20T03:00:00Z",
                lease_seconds=24 * 60 * 60,
            )

            recovered = storage.claim_scheduled_prompt_occurrence(
                task_id="task-undispatched",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T03:00:00Z",
                lease_owner="scheduler:recovered",
                now="2026-08-20T03:16:00Z",
                lease_seconds=15 * 60,
            )
            duplicate = storage.claim_scheduled_prompt_occurrence(
                task_id="task-undispatched",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T03:00:00Z",
                lease_owner="scheduler:duplicate",
                now="2026-08-20T03:16:01Z",
                lease_seconds=15 * 60,
            )

            self.assertTrue(recovered["claimed"])
            self.assertEqual(recovered["run"]["run_id"], abandoned["run"]["run_id"])
            self.assertEqual(recovered["run"]["attempt"], 2)
            self.assertFalse(duplicate["claimed"])
            self.assertEqual(duplicate["reason"], "occurrence_already_claimed")
            self.assertEqual(len(storage.list_scheduled_prompt_runs(task_id="task-undispatched")), 1)

    def test_stale_local_occurrence_is_closed_without_repeating_dispatch(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            dispatched = storage.claim_scheduled_prompt_occurrence(
                task_id="task-dispatched-once",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T03:00:00Z",
                lease_owner="scheduler:abandoned",
                now="2026-08-20T03:00:00Z",
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                dispatched["run"]["run_id"],
                {
                    "status": "running",
                    "updated_at": "2026-08-20T03:00:00Z",
                },
            )

            replay = storage.claim_scheduled_prompt_occurrence(
                task_id="task-dispatched-once",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T03:00:00Z",
                lease_owner="scheduler:restarted",
                now="2026-08-20T03:16:00Z",
                lease_seconds=15 * 60,
            )

            self.assertFalse(replay["claimed"])
            self.assertEqual(replay["reason"], "occurrence_already_terminal")
            self.assertEqual(replay["run"]["status"], "failed")
            self.assertEqual(replay["run"]["error_class"], "stale_run_reconciled")
            self.assertEqual(replay["run"]["attempt"], 1)
            self.assertEqual(len(storage.list_scheduled_prompt_runs(task_id="task-dispatched-once")), 1)

    def test_external_worker_binding_blocks_duplicate_dispatch_after_stale_or_expired_lease(self):
        for lease_seconds in (24 * 60 * 60, 60):
            with self.subTest(lease_seconds=lease_seconds), tempfile.TemporaryDirectory() as tmpdir, patch.dict(
                os.environ,
                {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
            ):
                storage = ScheduleStorage(
                    StorageConfig(db_path=str(Path(tmpdir) / "schedules.db"))
                )
                dispatched = storage.claim_scheduled_prompt_occurrence(
                    task_id="task-external-worker-owned",
                    user_id="user-1",
                    executor="glasshive_host",
                    due_at="2026-08-20T03:00:00Z",
                    lease_owner="scheduler:original",
                    now="2026-08-20T03:00:00Z",
                    lease_seconds=lease_seconds,
                )
                storage.update_scheduled_prompt_run(
                    dispatched["run"]["run_id"],
                    {
                        "status": "running",
                        "glasshive_project_id": "project-external-owned",
                        "glasshive_worker_id": "worker-external-owned",
                        "glasshive_run_id": "run-external-owned",
                        "updated_at": "2026-08-20T03:00:00Z",
                    },
                )

                duplicate = storage.claim_scheduled_prompt_occurrence(
                    task_id="task-external-worker-owned",
                    user_id="user-1",
                    executor="glasshive_host",
                    due_at="2026-08-20T03:00:00Z",
                    lease_owner="scheduler:restarted",
                    now="2026-08-20T03:16:00Z",
                    lease_seconds=15 * 60,
                )
                overlap = storage.claim_scheduled_prompt_occurrence(
                    task_id="task-external-worker-owned",
                    user_id="user-1",
                    executor="glasshive_host",
                    due_at="2026-08-20T03:30:00Z",
                    lease_owner="scheduler:overlap",
                    now="2026-08-20T03:30:00Z",
                    lease_seconds=15 * 60,
                )

                self.assertFalse(duplicate["claimed"])
                self.assertEqual(duplicate["reason"], "occurrence_already_claimed")
                self.assertFalse(overlap["claimed"])
                self.assertEqual(overlap["reason"], "task_has_active_occurrence")
                self.assertEqual(overlap["run"]["run_id"], dispatched["run"]["run_id"])
                self.assertEqual(overlap["run"]["status"], "running")
                self.assertEqual(overlap["run"]["attempt"], 1)
                self.assertEqual(
                    len(storage.list_scheduled_prompt_runs(task_id="task-external-worker-owned")),
                    1,
                )

    def test_fresh_heartbeat_keeps_long_running_future_lease_exclusive(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            running = storage.claim_scheduled_prompt_occurrence(
                task_id="task-fresh-heartbeat",
                user_id="user-1",
                executor="glasshive_host",
                due_at="2026-08-20T03:00:00Z",
                lease_owner="scheduler:active",
                now="2026-08-20T03:00:00Z",
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                running["run"]["run_id"],
                {
                    "status": "running",
                    "glasshive_run_id": "worker-run-active",
                    "updated_at": "2026-08-20T14:25:00Z",
                },
            )

            overlap = storage.claim_scheduled_prompt_occurrence(
                task_id="task-fresh-heartbeat",
                user_id="user-1",
                executor="glasshive_host",
                due_at="2026-08-20T14:30:00Z",
                lease_owner="scheduler:overlap",
                now="2026-08-20T14:30:00Z",
                lease_seconds=15 * 60,
            )

            self.assertFalse(overlap["claimed"])
            self.assertEqual(overlap["reason"], "task_has_active_occurrence")
            self.assertEqual(overlap["run"]["run_id"], running["run"]["run_id"])

    def test_proven_external_work_lease_remains_exclusive_beyond_heartbeat_window(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": "900"},
        ):
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            waiting = storage.claim_scheduled_prompt_occurrence(
                task_id="task-external-work",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T03:00:00Z",
                lease_owner="scheduler:external",
                now="2026-08-20T03:00:00Z",
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                waiting["run"]["run_id"],
                {
                    "status": "waiting_external",
                    "execution_snapshot": {
                        "external_work": {
                            "requiredTotal": 2,
                            "requiredTerminal": 1,
                            "allRequiredTerminal": False,
                        }
                    },
                    "updated_at": "2026-08-20T03:00:00Z",
                },
            )

            overlap = storage.claim_scheduled_prompt_occurrence(
                task_id="task-external-work",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T05:00:00Z",
                lease_owner="scheduler:overlap",
                now="2026-08-20T05:00:00Z",
                lease_seconds=15 * 60,
            )

            self.assertFalse(overlap["claimed"])
            self.assertEqual(overlap["reason"], "task_has_active_occurrence")
            self.assertEqual(overlap["run"]["status"], "waiting_external")

    def test_manual_receipt_and_scheduled_occurrence_block_each_other_atomically(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            now = "2026-08-20T14:59:50Z"
            manual_run = {
                "run_id": "manual-run-1",
                "task_id": "task-manual-race",
                "definition_id": None,
                "user_id": "user-1",
                "version_id": None,
                "due_at": now,
                "started_at": now,
                "completed_at": None,
                "status": "running",
                "executor": "viventium_agent",
                "rendered_hash": None,
                "variable_snapshot_hash": None,
                "glasshive_project_id": None,
                "glasshive_worker_id": None,
                "glasshive_run_id": None,
                "result_summary": "Manual run started.",
                "error_class": None,
                "private_detail_path": None,
                "callback_payload_json": None,
                "trigger_kind": "manual",
                "trigger_source": "workbench_manual",
                "occurrence_key": "manual-run-1",
                "disposition": "running",
                "execution_snapshot": {"executor": "viventium_agent"},
                "channel_outcomes": {},
                "created_at": now,
                "updated_at": now,
            }

            manual = storage.claim_manual_scheduled_prompt_run(
                manual_run,
                lease_owner="workbench:manual-run-1",
                now=now,
                lease_seconds=60,
            )
            scheduled_blocked = storage.claim_scheduled_prompt_occurrence(
                task_id="task-manual-race",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T15:00:00Z",
                lease_owner="scheduler-1",
                now="2026-08-20T15:00:00Z",
                lease_seconds=60,
            )

            self.assertTrue(manual["claimed"])
            self.assertEqual(manual["run"]["lease_owner"], "workbench:manual-run-1")
            self.assertFalse(scheduled_blocked["claimed"])
            self.assertEqual(scheduled_blocked["reason"], "task_has_active_occurrence")
            self.assertEqual(scheduled_blocked["run"]["run_id"], "manual-run-1")

            other_storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "other.db")))
            scheduled = other_storage.claim_scheduled_prompt_occurrence(
                task_id="task-scheduled-race",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T15:00:00Z",
                lease_owner="scheduler-2",
                now="2026-08-20T15:00:00Z",
                lease_seconds=60,
            )
            blocked_manual_run = {**manual_run, "run_id": "manual-run-2", "task_id": "task-scheduled-race", "occurrence_key": "manual-run-2"}
            manual_blocked = other_storage.claim_manual_scheduled_prompt_run(
                blocked_manual_run,
                lease_owner="workbench:manual-run-2",
                now="2026-08-20T15:00:01Z",
                lease_seconds=60,
            )

            self.assertTrue(scheduled["claimed"])
            self.assertFalse(manual_blocked["claimed"])
            self.assertEqual(manual_blocked["reason"], "task_has_active_occurrence")
            self.assertEqual(manual_blocked["run"]["run_id"], scheduled["run"]["run_id"])

            race_storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "race.db")))
            race_barrier = threading.Barrier(2)
            race_results = []

            def claim_manual():
                race_barrier.wait()
                race_results.append(
                    race_storage.claim_manual_scheduled_prompt_run(
                        {
                            **manual_run,
                            "run_id": "manual-race-winner",
                            "task_id": "task-concurrent-race",
                            "occurrence_key": "manual-race-winner",
                        },
                        lease_owner="workbench:race",
                        now="2026-08-20T15:00:00Z",
                        lease_seconds=60,
                    )
                )

            def claim_scheduled():
                race_barrier.wait()
                race_results.append(
                    race_storage.claim_scheduled_prompt_occurrence(
                        task_id="task-concurrent-race",
                        user_id="user-1",
                        executor="viventium_agent",
                        due_at="2026-08-20T15:00:00Z",
                        lease_owner="scheduler:race",
                        now="2026-08-20T15:00:00Z",
                        lease_seconds=60,
                    )
                )

            manual_thread = threading.Thread(target=claim_manual)
            scheduled_thread = threading.Thread(target=claim_scheduled)
            manual_thread.start()
            scheduled_thread.start()
            manual_thread.join()
            scheduled_thread.join()

            self.assertEqual(sum(1 for result in race_results if result["claimed"]), 1)
            self.assertEqual(
                len(race_storage.list_scheduled_prompt_runs(task_id="task-concurrent-race")),
                1,
            )

    def test_waiting_external_run_without_live_lease_blocks_manual_and_scheduled_overlap(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            waiting = storage.create_scheduled_prompt_run(
                {
                    "run_id": "waiting-run",
                    "task_id": "task-waiting",
                    "user_id": "user-1",
                    "due_at": "2026-08-20T15:00:00Z",
                    "started_at": "2026-08-20T15:00:00Z",
                    "status": "waiting_external",
                    "executor": "glasshive_host",
                    "trigger_kind": "scheduled",
                    "trigger_source": "scheduler_loop",
                    "occurrence_key": "waiting-run",
                    "disposition": "running",
                    "created_at": "2026-08-20T15:00:00Z",
                    "updated_at": "2026-08-20T15:00:00Z",
                }
            )
            manual = storage.claim_manual_scheduled_prompt_run(
                {
                    **waiting,
                    "run_id": "manual-after-waiting",
                    "occurrence_key": "manual-after-waiting",
                    "trigger_kind": "manual",
                    "trigger_source": "workbench_manual",
                    "status": "running",
                },
                lease_owner="workbench:manual-after-waiting",
                now="2026-08-20T15:05:00Z",
                lease_seconds=60,
            )
            scheduled = storage.claim_scheduled_prompt_occurrence(
                task_id="task-waiting",
                user_id="user-1",
                executor="glasshive_host",
                due_at="2026-08-20T15:15:00Z",
                lease_owner="scheduler:new",
                now="2026-08-20T15:05:00Z",
                lease_seconds=60,
            )

            self.assertFalse(manual["claimed"])
            self.assertEqual(manual["reason"], "task_has_active_occurrence")
            self.assertEqual(manual["run"]["run_id"], "waiting-run")
            self.assertFalse(scheduled["claimed"])
            self.assertEqual(scheduled["reason"], "task_has_active_occurrence")
            self.assertEqual(scheduled["run"]["run_id"], "waiting-run")

    def test_expired_occurrence_cannot_recover_while_manual_run_owns_task(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": "1"},
        ):
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            first = storage.claim_scheduled_prompt_occurrence(
                task_id="task-stale-occurrence",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T15:00:00Z",
                lease_owner="scheduler:old",
                now="2026-08-20T15:00:00Z",
                lease_seconds=60,
            )
            manual = storage.claim_manual_scheduled_prompt_run(
                {
                    "run_id": "manual-live",
                    "task_id": "task-stale-occurrence",
                    "user_id": "user-1",
                    "due_at": "2026-08-20T15:01:01Z",
                    "started_at": "2026-08-20T15:01:01Z",
                    "status": "running",
                    "executor": "viventium_agent",
                    "trigger_kind": "manual",
                    "trigger_source": "workbench_manual",
                    "occurrence_key": "manual-live",
                    "disposition": "running",
                    "created_at": "2026-08-20T15:01:01Z",
                    "updated_at": "2026-08-20T15:01:01Z",
                },
                lease_owner="workbench:manual-live",
                now="2026-08-20T15:01:01Z",
                lease_seconds=60,
            )
            recovered = storage.claim_scheduled_prompt_occurrence(
                task_id="task-stale-occurrence",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T15:00:00Z",
                lease_owner="scheduler:new",
                now="2026-08-20T15:01:02Z",
                lease_seconds=60,
            )

            self.assertTrue(first["claimed"])
            self.assertTrue(manual["claimed"])
            self.assertFalse(recovered["claimed"])
            self.assertEqual(recovered["reason"], "task_has_active_occurrence")
            self.assertEqual(recovered["run"]["run_id"], "manual-live")

    def test_same_scheduler_owner_does_not_recover_its_own_long_running_occurrence(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            first = storage.claim_scheduled_prompt_occurrence(
                task_id="task-long-running",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T15:00:00Z",
                lease_owner="scheduler:stable-owner",
                now="2026-08-20T15:00:00Z",
                lease_seconds=60,
            )
            duplicate = storage.claim_scheduled_prompt_occurrence(
                task_id="task-long-running",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-20T15:00:00Z",
                lease_owner="scheduler:stable-owner",
                now="2026-08-20T15:02:00Z",
                lease_seconds=60,
            )

            self.assertTrue(first["claimed"])
            self.assertFalse(duplicate["claimed"])
            self.assertEqual(duplicate["reason"], "occurrence_already_claimed")
            self.assertEqual(duplicate["run"]["attempt"], 1)

    def test_restart_reconciles_stale_running_row_and_parent_without_duplicate_dispatch(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            now = datetime.now(timezone.utc).replace(microsecond=0)
            stale_at = (now - timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
            next_due = (now + timedelta(hours=23)).isoformat().replace("+00:00", "Z")
            task = _build_task("task-restart-recovery", created_at=stale_at)
            task.update(
                {
                    "next_run_at": next_due,
                    "last_status": "running",
                    "metadata": {"misfire_policy": {"mode": "catch_up", "max_late_s": 43200}},
                }
            )
            storage.create_task(task)
            claimed = storage.claim_scheduled_prompt_occurrence(
                task_id=task["id"],
                user_id=task["user_id"],
                executor="viventium_agent",
                due_at=stale_at,
                lease_owner="scheduler:abandoned",
                now=stale_at,
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                claimed["run"]["run_id"],
                {
                    "status": "running",
                    "updated_at": stale_at,
                },
            )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            run = restarted.get_scheduled_prompt_run(claimed["run"]["run_id"])
            parent = restarted.get_task(task["user_id"], task["id"])
            replay = restarted.claim_scheduled_prompt_occurrence(
                task_id=task["id"],
                user_id=task["user_id"],
                executor="viventium_agent",
                due_at=stale_at,
                lease_owner="scheduler:restarted",
                now=now.isoformat().replace("+00:00", "Z"),
                lease_seconds=15 * 60,
            )

            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["disposition"], "failed")
            self.assertEqual(run["error_class"], "stale_run_reconciled")
            self.assertIsNotNone(run["completed_at"])
            self.assertIsNone(run["lease_owner"])
            self.assertIsNone(run["lease_until"])
            self.assertEqual(parent["last_status"], "error")
            self.assertEqual(parent["last_error"], "stale_run_reconciled")
            self.assertEqual(parent["last_delivery_outcome"], "failed")
            self.assertEqual(parent["last_delivery_reason"], "stale_run_reconciled")
            self.assertEqual(parent["next_run_at"], next_due)
            self.assertFalse(replay["claimed"])
            self.assertEqual(replay["reason"], "occurrence_already_terminal")
            self.assertEqual(len(restarted.list_scheduled_prompt_runs(task_id=task["id"])), 1)

    def test_restart_preserves_stale_external_worker_without_trusted_terminal_evidence(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            now = datetime.now(timezone.utc).replace(microsecond=0)
            started_at = (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
            task = _build_task("task-external-worker-restart", created_at=started_at)
            task.update({"last_run_at": started_at, "last_status": "running"})
            storage.create_task(task)
            claimed = storage.claim_scheduled_prompt_occurrence(
                task_id=task["id"],
                user_id=task["user_id"],
                executor="glasshive_host",
                due_at=started_at,
                lease_owner="scheduler:original",
                now=started_at,
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                claimed["run"]["run_id"],
                {
                    "status": "running",
                    "glasshive_project_id": "project-external-restart",
                    "glasshive_worker_id": "worker-external-restart",
                    "glasshive_run_id": "run-external-restart",
                    "updated_at": started_at,
                },
            )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            run = restarted.get_scheduled_prompt_run(claimed["run"]["run_id"])
            parent = restarted.get_task(task["user_id"], task["id"])

            self.assertEqual(run["status"], "running")
            self.assertEqual(run["disposition"], "running")
            self.assertEqual(run["glasshive_run_id"], "run-external-restart")
            self.assertEqual(run["lease_owner"], "scheduler:original")
            self.assertEqual(parent["last_status"], "running")
            self.assertEqual(parent["last_run_at"], started_at)

    def test_restart_reconciles_external_worker_without_durable_occurrence_ownership(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            started_at = (
                datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)
            ).isoformat().replace("+00:00", "Z")
            task = _build_task("task-unowned-external-worker", created_at=started_at)
            task.update({"last_run_at": started_at, "last_status": "running"})
            storage.create_task(task)
            storage.create_scheduled_prompt_run(
                {
                    "run_id": "run-unowned-external-worker",
                    "task_id": task["id"],
                    "user_id": task["user_id"],
                    "due_at": started_at,
                    "started_at": started_at,
                    "status": "running",
                    "executor": "glasshive_host",
                    "glasshive_project_id": "project-unowned-external",
                    "glasshive_worker_id": "worker-unowned-external",
                    "glasshive_run_id": "run-unowned-external",
                    "disposition": "running",
                    "created_at": started_at,
                    "updated_at": started_at,
                }
            )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            run = restarted.get_scheduled_prompt_run("run-unowned-external-worker")
            parent = restarted.get_task(task["user_id"], task["id"])

            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error_class"], "stale_run_reconciled")
            self.assertEqual(parent["last_status"], "error")

    def test_restart_never_applies_older_local_failure_to_newer_parent_occurrence(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            now = datetime.now(timezone.utc).replace(microsecond=0)
            older_started_at = (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
            newer_started_at = (now - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
            task = _build_task("task-newer-parent-occurrence", created_at=older_started_at)
            task.update(
                {
                    "last_run_at": newer_started_at,
                    "last_status": "running",
                    "last_delivery_outcome": "queued",
                }
            )
            storage.create_task(task)
            claimed = storage.claim_scheduled_prompt_occurrence(
                task_id=task["id"],
                user_id=task["user_id"],
                executor="viventium_agent",
                due_at=older_started_at,
                lease_owner="scheduler:abandoned",
                now=older_started_at,
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                claimed["run"]["run_id"],
                {"status": "running", "updated_at": older_started_at},
            )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            run = restarted.get_scheduled_prompt_run(claimed["run"]["run_id"])
            parent = restarted.get_task(task["user_id"], task["id"])

            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error_class"], "stale_run_reconciled")
            self.assertEqual(parent["last_status"], "running")
            self.assertEqual(parent["last_run_at"], newer_started_at)
            self.assertEqual(parent["last_delivery_outcome"], "queued")
            self.assertIsNone(parent["last_error"])

    def test_restart_prefers_trusted_terminal_failure_over_stale_recovery_placeholder(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            stale_at = (
                datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=30)
            ).isoformat().replace("+00:00", "Z")
            task = _build_task("task-trusted-failure", created_at=stale_at)
            task["last_status"] = "running"
            storage.create_task(task)
            claimed = storage.claim_scheduled_prompt_occurrence(
                task_id=task["id"],
                user_id=task["user_id"],
                executor="glasshive_host",
                due_at=stale_at,
                lease_owner="scheduler:abandoned",
                now=stale_at,
                lease_seconds=24 * 60 * 60,
            )
            run_id = claimed["run"]["run_id"]
            storage.update_scheduled_prompt_run(
                run_id,
                {
                    "status": "running",
                    "glasshive_run_id": "worker-run-failed",
                    "updated_at": stale_at,
                },
            )
            storage.accept_scheduled_terminal_callback_result(
                owner_id=task["user_id"],
                work_id=run_id,
                callback_contract="glasshive_terminal_result_v1",
                payload={
                    "callback_contract": "glasshive_terminal_result_v1",
                    "callback_id": "cb_terminal_" + "a" * 64,
                    "event": "run.failed",
                    "failure_class": "provider_response_failed",
                    "failure_retryable": True,
                    "occurrence_key": claimed["occurrence_key"],
                    "provider_route_decision": "fallback_unavailable",
                    "result_digest": "sha256:" + "b" * 64,
                    "result_revision": 1,
                    "user_id": task["user_id"],
                },
            )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            run = restarted.get_scheduled_prompt_run(run_id)
            parent = restarted.get_task(task["user_id"], task["id"])

            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error_class"], "provider_response_failed")
            self.assertTrue(run["callback_payload"]["recovered_from_terminal_callback"])
            self.assertTrue(run["execution_snapshot"]["scheduled_failure_state_v1"]["retryable"])
            self.assertEqual(parent["last_status"], "error")
            self.assertEqual(parent["last_error"], "provider_response_failed")
            self.assertEqual(parent["last_delivery_reason"], "provider_response_failed")

    def test_restart_preserves_proven_live_external_work_after_heartbeat_window(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": "900"},
        ):
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            stale_at = (
                datetime.now(timezone.utc).replace(microsecond=0) - timedelta(hours=2)
            ).isoformat().replace("+00:00", "Z")
            claimed = storage.claim_scheduled_prompt_occurrence(
                task_id="task-live-external",
                user_id="user-1",
                executor="viventium_agent",
                due_at=stale_at,
                lease_owner="scheduler:external",
                now=stale_at,
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                claimed["run"]["run_id"],
                {
                    "status": "waiting_external",
                    "execution_snapshot": {
                        "external_work": {
                            "requiredTotal": 2,
                            "requiredTerminal": 1,
                            "allRequiredTerminal": False,
                        }
                    },
                    "updated_at": stale_at,
                },
            )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            waiting = restarted.get_scheduled_prompt_run(claimed["run"]["run_id"])

            self.assertEqual(waiting["status"], "waiting_external")
            self.assertEqual(waiting["disposition"], "running")
            self.assertEqual(waiting["lease_owner"], "scheduler:external")
            self.assertIsNotNone(waiting["lease_until"])

    def test_restart_preserves_long_running_work_with_fresh_heartbeat(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": ""},
        ):
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            now = datetime.now(timezone.utc).replace(microsecond=0)
            started_at = (now - timedelta(hours=2)).isoformat().replace("+00:00", "Z")
            heartbeat_at = (now - timedelta(minutes=2)).isoformat().replace("+00:00", "Z")
            claimed = storage.claim_scheduled_prompt_occurrence(
                task_id="task-live-running",
                user_id="user-1",
                executor="glasshive_host",
                due_at=started_at,
                lease_owner="scheduler:active",
                now=started_at,
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                claimed["run"]["run_id"],
                {
                    "status": "running",
                    "glasshive_run_id": "worker-run-active",
                    "updated_at": heartbeat_at,
                },
            )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            running = restarted.get_scheduled_prompt_run(claimed["run"]["run_id"])

            self.assertEqual(running["status"], "running")
            self.assertEqual(running["lease_owner"], "scheduler:active")

    def test_restart_honors_positive_recovery_window_override(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            stale_at = (
                datetime.now(timezone.utc).replace(microsecond=0) - timedelta(minutes=30)
            ).isoformat().replace("+00:00", "Z")
            claimed = storage.claim_scheduled_prompt_occurrence(
                task_id="task-configured-recovery",
                user_id="user-1",
                executor="glasshive_host",
                due_at=stale_at,
                lease_owner="scheduler:configured",
                now=stale_at,
                lease_seconds=24 * 60 * 60,
            )
            storage.update_scheduled_prompt_run(
                claimed["run"]["run_id"],
                {"status": "running", "updated_at": stale_at},
            )

            with patch.dict(os.environ, {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": "3600"}):
                preserved = ScheduleStorage(StorageConfig(db_path=db_path))
                self.assertEqual(
                    preserved.get_scheduled_prompt_run(claimed["run"]["run_id"])["status"],
                    "running",
                )

            with patch.dict(os.environ, {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": "900"}):
                recovered = ScheduleStorage(StorageConfig(db_path=db_path))
                self.assertEqual(
                    recovered.get_scheduled_prompt_run(claimed["run"]["run_id"])["status"],
                    "failed",
                )

    def test_startup_reconciles_stale_waiting_external_run(self):
        with tempfile.TemporaryDirectory() as tmpdir, patch.dict(
            os.environ,
            {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": "60"},
        ):
            db_path = str(Path(tmpdir) / "schedules.db")
            storage = ScheduleStorage(StorageConfig(db_path=db_path))
            storage.create_scheduled_prompt_run(
                {
                    "run_id": "stale-waiting",
                    "task_id": "task-stale-waiting",
                    "user_id": "user-1",
                    "due_at": "2026-01-01T00:00:00Z",
                    "started_at": "2026-01-01T00:00:00Z",
                    "status": "waiting_external",
                    "executor": "glasshive_host",
                    "trigger_kind": "scheduled",
                    "trigger_source": "scheduler_loop",
                    "occurrence_key": "stale-waiting",
                    "disposition": "running",
                    "created_at": "2026-01-01T00:00:00Z",
                    "updated_at": "2026-01-01T00:00:00Z",
                }
            )

            restarted = ScheduleStorage(StorageConfig(db_path=db_path))
            run = restarted.get_scheduled_prompt_run("stale-waiting")

            self.assertEqual(run["status"], "failed")
            self.assertEqual(run["error_class"], "stale_run_reconciled")

    def test_expired_occurrence_lease_compares_offset_timestamp_by_instant(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            first = storage.claim_scheduled_prompt_occurrence(
                task_id="task-offset",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-10T19:00:00Z",
                lease_owner="owner-1",
                now="2026-08-10T19:00:00Z",
                lease_seconds=60,
            )
            recovered = storage.claim_scheduled_prompt_occurrence(
                task_id="task-offset",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-10T19:00:00Z",
                lease_owner="owner-2",
                now="2026-08-10T14:02:00-05:00",
                lease_seconds=60,
            )

            self.assertTrue(first["claimed"])
            self.assertTrue(recovered["claimed"])
            self.assertEqual(recovered["reason"], "lease_recovered")

    def test_expired_task_lease_does_not_block_new_occurrence_with_offset_now(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            first = storage.claim_scheduled_prompt_occurrence(
                task_id="task-offset-grid",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-10T19:00:00Z",
                lease_owner="owner-1",
                now="2026-08-10T19:00:00Z",
                lease_seconds=60,
            )
            second = storage.claim_scheduled_prompt_occurrence(
                task_id="task-offset-grid",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-10T19:05:00Z",
                lease_owner="owner-2",
                now="2026-08-10T14:02:00-05:00",
                lease_seconds=60,
            )

            self.assertTrue(first["claimed"])
            self.assertTrue(second["claimed"])
            self.assertEqual(second["reason"], "claimed")

    def test_run_lifecycle_serializes_execution_and_channel_outcomes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            claimed = storage.claim_scheduled_prompt_occurrence(
                task_id="task-1",
                user_id="user-1",
                executor="viventium_agent",
                due_at="2026-08-10T12:00:00Z",
                lease_owner="owner-1",
                now="2026-08-10T12:00:00Z",
                lease_seconds=60,
            )
            updated = storage.update_scheduled_prompt_run(
                claimed["run"]["run_id"],
                {
                    "status": "completed",
                    "completed_at": "2026-08-10T12:00:10Z",
                    "disposition": "delivered",
                    "execution_snapshot": {"model": "gpt-5.6-sol", "reasoning_effort": "xhigh"},
                    "channel_outcomes": {"librechat": {"outcome": "sent"}},
                    "interaction_ref": "conversation:synthetic",
                    "updated_at": "2026-08-10T12:00:10Z",
                },
            )

            self.assertEqual(updated["execution_snapshot"]["model"], "gpt-5.6-sol")
            self.assertEqual(updated["channel_outcomes"]["librechat"]["outcome"], "sent")
            self.assertEqual(updated["interaction_ref"], "conversation:synthetic")
            self.assertIsNone(updated["lease_owner"])
            self.assertIsNone(updated["lease_until"])

    def test_terminal_update_cannot_retain_a_caller_supplied_lease(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            for status in ("completed", "failed", "cancelled", "missed"):
                storage = ScheduleStorage(
                    StorageConfig(db_path=str(Path(tmpdir) / f"{status}.db"))
                )
                claimed = storage.claim_scheduled_prompt_occurrence(
                    task_id=f"task-{status}",
                    user_id="user-1",
                    executor="viventium_agent",
                    due_at="2026-08-10T12:00:00Z",
                    lease_owner=f"owner-{status}",
                    now="2026-08-10T12:00:00Z",
                    lease_seconds=60,
                )

                updated = storage.update_scheduled_prompt_run(
                    claimed["run"]["run_id"],
                    {
                        "status": status,
                        "lease_owner": "must-not-survive",
                        "lease_until": "2099-01-01T00:00:00Z",
                        "updated_at": "2026-08-10T12:00:10Z",
                    },
                )

                self.assertIsNone(updated["lease_owner"])
                self.assertIsNone(updated["lease_until"])

    def test_run_writer_accepts_pre_serialized_new_json_columns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            now = "2026-08-10T12:00:00Z"
            run = {
                "run_id": "serialized-run",
                "task_id": "task-1",
                "definition_id": None,
                "user_id": "user-1",
                "version_id": None,
                "due_at": now,
                "started_at": now,
                "completed_at": None,
                "status": "queued",
                "executor": "glasshive_host",
                "rendered_hash": None,
                "variable_snapshot_hash": None,
                "glasshive_project_id": None,
                "glasshive_worker_id": None,
                "glasshive_run_id": None,
                "result_summary": None,
                "error_class": None,
                "private_detail_path": None,
                "callback_payload_json": None,
                "execution_snapshot_json": '{"model": "synthetic"}',
                "channel_outcomes_json": '{"workbench": {"outcome": "queued"}}',
                "created_at": now,
                "updated_at": now,
            }

            storage.create_scheduled_prompt_run(run)
            stored = storage.get_scheduled_prompt_run("serialized-run")

            self.assertEqual(stored["execution_snapshot"], {"model": "synthetic"})
            self.assertEqual(stored["channel_outcomes"]["workbench"]["outcome"], "queued")

    def test_occurrence_key_normalizes_equivalent_utc_timestamps(self):
        self.assertEqual(
            ScheduleStorage.scheduled_prompt_occurrence_key(
                "task-1", "2026-08-10T12:00:00Z"
            ),
            ScheduleStorage.scheduled_prompt_occurrence_key(
                "task-1", "2026-08-10T12:00:00+00:00"
            ),
        )

    def test_delete_definition_removes_private_versions_and_runs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            now = "2026-07-11T15:00:00Z"
            storage.create_scheduled_prompt_definition(
                {
                    "id": "definition-1",
                    "user_id": "user-1",
                    "task_id": "task-1",
                    "title": "Synthetic scheduled prompt",
                    "source_prompt_id": None,
                    "template_id": None,
                    "prompt_text": "Synthetic prompt",
                    "schedule": {"type": "daily", "time": "03:00", "timezone": "UTC"},
                    "timezone": "UTC",
                    "active": 0,
                    "memory_write_mode": "off",
                    "workspace_alias": "synthetic-workspace",
                    "my_folder": None,
                    "metadata": {},
                    "created_at": now,
                    "updated_at": now,
                }
            )
            storage.create_scheduled_prompt_version(
                {
                    "id": "version-1",
                    "definition_id": "definition-1",
                    "version_number": 1,
                    "prompt_text": "Synthetic prompt",
                    "rendered_text": '<private-rendered-prompt hash="rendered" />',
                    "rendered_hash": "rendered",
                    "variable_snapshot_json": '{"hash":"snapshot"}',
                    "variable_snapshot_hash": "snapshot",
                    "created_at": now,
                }
            )
            storage.create_scheduled_prompt_run(
                {
                    "run_id": "run-1",
                    "task_id": "task-1",
                    "definition_id": "definition-1",
                    "user_id": "user-1",
                    "version_id": "version-1",
                    "due_at": now,
                    "started_at": now,
                    "completed_at": now,
                    "status": "completed",
                    "executor": "glasshive_host",
                    "rendered_hash": "rendered",
                    "variable_snapshot_hash": "snapshot",
                    "glasshive_project_id": None,
                    "glasshive_worker_id": None,
                    "glasshive_run_id": None,
                    "result_summary": "Synthetic completion",
                    "error_class": None,
                    "private_detail_path": None,
                    "callback_payload_json": None,
                    "created_at": now,
                    "updated_at": now,
                }
            )

            self.assertTrue(storage.delete_scheduled_prompt_definition("definition-1"))
            self.assertIsNone(storage.get_scheduled_prompt_definition("definition-1"))
            self.assertIsNone(storage.latest_scheduled_prompt_version("definition-1"))
            self.assertEqual(storage.list_scheduled_prompt_runs(definition_id="definition-1"), [])

    def test_startup_reconciles_abandoned_runs_without_deleting_audit_rows(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            old = "2020-01-01T00:00:00Z"
            run = {
                "run_id": "abandoned-run",
                "task_id": "task-1",
                "definition_id": "definition-1",
                "user_id": "user-1",
                "version_id": None,
                "due_at": old,
                "started_at": old,
                "completed_at": None,
                "status": "queued",
                "executor": "glasshive_host",
                "rendered_hash": None,
                "variable_snapshot_hash": None,
                "glasshive_project_id": None,
                "glasshive_worker_id": None,
                "glasshive_run_id": None,
                "result_summary": None,
                "error_class": None,
                "private_detail_path": None,
                "callback_payload_json": None,
                "lease_owner": "abandoned-owner",
                "lease_until": "2099-01-01T00:00:00Z",
                "created_at": old,
                "updated_at": old,
            }
            storage.create_scheduled_prompt_run(run)
            for status in ("claimed", "dispatching"):
                storage.create_scheduled_prompt_run(
                    {
                        **run,
                        "run_id": f"abandoned-{status}",
                        "status": status,
                    }
                )
            fresh = dict(run)
            fresh_now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            fresh.update(
                {
                    "run_id": "fresh-run",
                    "due_at": fresh_now,
                    "started_at": fresh_now,
                    "created_at": fresh_now,
                    "updated_at": fresh_now,
                }
            )
            storage.create_scheduled_prompt_run(fresh)

            with patch.dict("os.environ", {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": "60"}):
                restarted = ScheduleStorage(StorageConfig(db_path=str(db_path)))

            reconciled = restarted.get_scheduled_prompt_run("abandoned-run")
            self.assertEqual(reconciled["status"], "failed")
            self.assertEqual(reconciled["error_class"], "stale_run_reconciled")
            self.assertIsNotNone(reconciled["completed_at"])
            self.assertEqual(reconciled["disposition"], "failed")
            self.assertIsNone(reconciled["lease_owner"])
            self.assertIsNone(reconciled["lease_until"])
            for status in ("claimed", "dispatching"):
                recovered = restarted.get_scheduled_prompt_run(f"abandoned-{status}")
                self.assertEqual(recovered["status"], "failed")
                self.assertEqual(recovered["error_class"], "stale_run_reconciled")
                self.assertIsNone(recovered["lease_owner"])
                self.assertIsNone(recovered["lease_until"])
            self.assertEqual(restarted.get_scheduled_prompt_run("fresh-run")["status"], "queued")

    def test_restart_repairs_terminal_failure_with_running_disposition(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            storage.create_scheduled_prompt_run(
                {
                    "run_id": "failed-but-running",
                    "task_id": "task-1",
                    "definition_id": "definition-1",
                    "user_id": "user-1",
                    "version_id": None,
                    "due_at": now,
                    "started_at": now,
                    "completed_at": now,
                    "status": "failed",
                    "executor": "viventium_agent",
                    "rendered_hash": None,
                    "variable_snapshot_hash": None,
                    "glasshive_project_id": None,
                    "glasshive_worker_id": None,
                    "glasshive_run_id": None,
                    "result_summary": "timed out",
                    "error_class": "TimeoutError",
                    "private_detail_path": None,
                    "callback_payload_json": None,
                    "disposition": "running",
                    "created_at": now,
                    "updated_at": now,
                }
            )

            restarted = ScheduleStorage(StorageConfig(db_path=str(db_path)))

            repaired = restarted.get_scheduled_prompt_run("failed-but-running")
            self.assertEqual(repaired["status"], "failed")
            self.assertEqual(repaired["disposition"], "failed")

    def test_read_only_observer_does_not_reconcile_or_mutate_abandoned_runs(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = Path(tmpdir) / "schedules.db"
            storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
            old = "2020-01-01T00:00:00Z"
            storage.create_scheduled_prompt_run(
                {
                    "run_id": "observed-run",
                    "task_id": "task-1",
                    "definition_id": "definition-1",
                    "user_id": "user-1",
                    "version_id": None,
                    "due_at": old,
                    "started_at": old,
                    "completed_at": None,
                    "status": "running",
                    "executor": "glasshive_host",
                    "rendered_hash": None,
                    "variable_snapshot_hash": None,
                    "glasshive_project_id": None,
                    "glasshive_worker_id": None,
                    "glasshive_run_id": None,
                    "result_summary": None,
                    "error_class": None,
                    "private_detail_path": None,
                    "callback_payload_json": None,
                    "created_at": old,
                    "updated_at": old,
                }
            )

            with patch.dict("os.environ", {"SCHEDULING_STALE_PROMPT_RUN_SECONDS": "60"}):
                observer = ScheduleStorage(StorageConfig(db_path=str(db_path), read_only=True))

            observed = observer.get_scheduled_prompt_run("observed-run")
            self.assertEqual(observed["status"], "running")
            self.assertIsNone(observed["error_class"])
            self.assertIsNone(observed["completed_at"])

    def test_scheduled_prompt_runs_can_be_filtered_by_explicit_trigger_kind(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(
                StorageConfig(db_path=str(Path(tmpdir) / "schedules.db"))
            )
            base = {
                "task_id": "task-1",
                "definition_id": "definition-1",
                "user_id": "user-1",
                "version_id": None,
                "due_at": "2026-08-08T07:00:00Z",
                "started_at": "2026-08-08T07:00:00Z",
                "completed_at": "2026-08-08T07:01:00Z",
                "status": "completed",
                "executor": "glasshive_host",
                "rendered_hash": None,
                "variable_snapshot_hash": None,
                "glasshive_project_id": None,
                "glasshive_worker_id": None,
                "glasshive_run_id": None,
                "result_summary": None,
                "error_class": None,
                "private_detail_path": None,
                "callback_payload_json": None,
                "created_at": "2026-08-08T07:00:00Z",
                "updated_at": "2026-08-08T07:01:00Z",
            }
            storage.create_scheduled_prompt_run(
                {
                    **base,
                    "run_id": "scheduled-run",
                    "trigger_kind": "scheduled",
                    "trigger_source": "scheduler_loop",
                }
            )
            storage.create_scheduled_prompt_run(
                {
                    **base,
                    "run_id": "manual-run",
                    "trigger_kind": "manual",
                    "trigger_source": "workbench_manual",
                    "started_at": "2026-08-08T08:00:00Z",
                    "created_at": "2026-08-08T08:00:00Z",
                }
            )

            scheduled = storage.list_scheduled_prompt_runs(
                definition_id="definition-1",
                trigger_kind="scheduled",
                trigger_source="scheduler_loop",
                limit=1,
            )
            manual = storage.list_scheduled_prompt_runs(
                definition_id="definition-1",
                trigger_kind="manual",
                trigger_source="workbench_manual",
                limit=1,
            )

            self.assertEqual([run["run_id"] for run in scheduled], ["scheduled-run"])
            self.assertEqual([run["run_id"] for run in manual], ["manual-run"])
            self.assertEqual(scheduled[0]["trigger_source"], "scheduler_loop")
            self.assertEqual(manual[0]["trigger_source"], "workbench_manual")


if __name__ == "__main__":
    unittest.main()
