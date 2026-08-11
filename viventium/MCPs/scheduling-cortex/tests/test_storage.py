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
from datetime import datetime, timezone
from unittest.mock import patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.storage import ScheduleStorage, StorageConfig


def _build_task(task_id: str, user_id: str = "user-1", created_at: str = "2026-02-13T19:00:00Z"):
    return {
        "id": task_id,
        "user_id": user_id,
        "agent_id": "agent-1",
        "prompt": "Check in",
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
                storage.create_task(_build_task(f"mirror-task-{index}"))

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
            storage.create_task(_build_task("task-old", created_at="2026-02-13T17:00:00Z"))
            storage.create_task(_build_task("task-new", created_at="2026-02-13T18:00:00Z"))

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
