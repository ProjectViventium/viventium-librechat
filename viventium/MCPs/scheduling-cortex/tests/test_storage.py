# === VIVENTIUM START ===
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# === VIVENTIUM END ===

import sys
import tempfile
import unittest
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
            self.assertEqual(restarted.get_scheduled_prompt_run("fresh-run")["status"], "queued")


if __name__ == "__main__":
    unittest.main()
