# === VIVENTIUM START ===
# Purpose: Tests for the /internal/bootstrap-schedule endpoint.
# === VIVENTIUM END ===

import json
import hashlib
import hmac
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.storage import ScheduleStorage, StorageConfig
from scheduling_cortex.server import (
    _default_scheduling_db_path,
    build_server,
    serialize_task_summary,
)

try:
    from starlette.testclient import TestClient
except ImportError:
    TestClient = None


class SchedulingDatabasePathTests(unittest.TestCase):
    def test_default_db_path_uses_canonical_app_support_state(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(
                os.environ,
                {"VIVENTIUM_APP_SUPPORT_DIR": tmpdir},
                clear=False,
            ):
                self.assertEqual(
                    _default_scheduling_db_path(),
                    str(Path(tmpdir) / "state" / "scheduling" / "schedules.db"),
                )

    def test_macos_default_never_uses_legacy_hidden_fallback(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(os.environ, {}, clear=False), patch(
                "scheduling_cortex.server.Path.home",
                return_value=Path(tmpdir),
            ), patch("scheduling_cortex.server.sys.platform", "darwin"):
                os.environ.pop("VIVENTIUM_APP_SUPPORT_DIR", None)
                resolved = _default_scheduling_db_path()

        self.assertEqual(
            resolved,
            str(
                Path(tmpdir)
                / "Library"
                / "Application Support"
                / "Viventium"
                / "state"
                / "scheduling"
                / "schedules.db"
            ),
        )
        self.assertNotIn(".viventium", resolved)


@unittest.skipIf(TestClient is None, "starlette[testclient] not installed")
class BootstrapEndpointTests(unittest.TestCase):

    def _make_client(self, storage):
        mcp = build_server(storage)
        if hasattr(mcp, 'http_app'):
            app = mcp.http_app(transport="streamable-http")
        elif hasattr(mcp, '_mcp_server') and hasattr(mcp._mcp_server, 'asgi_app'):
            app = mcp._mcp_server.asgi_app()
        else:
            self.skipTest("Cannot extract ASGI app from FastMCP server")
            return None
        return TestClient(app)

    def _make_storage(self, tmpdir):
        return ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))

    @staticmethod
    def _glasshive_signature(secret, raw, worker_id, run_id):
        binding = f"{worker_id}:{run_id}".encode("utf-8")
        derived = hmac.new(secret.encode("utf-8"), binding, hashlib.sha256).hexdigest().encode(
            "utf-8"
        )
        return "sha256=" + hmac.new(derived, raw, hashlib.sha256).hexdigest()

    @staticmethod
    def _create_glasshive_run(storage, *, error_class):
        now = "2026-08-11T12:00:00Z"
        storage.create_task(
            {
                "id": "task-1",
                "user_id": "user-1",
                "agent_id": "agent-1",
                "prompt": "Synthetic scheduled task.",
                "schedule": {"type": "daily", "time": "09:00", "timezone": "UTC"},
                "channel": ["workbench"],
                "executor": "glasshive_host",
                "conversation_policy": "new",
                "conversation_id": None,
                "last_conversation_id": None,
                "active": 1,
                "created_by": "agent:agent-1",
                "created_source": "agent",
                "created_at": now,
                "updated_at": now,
                "updated_by": "agent:agent-1",
                "updated_source": "agent",
                "last_run_at": now,
                "next_run_at": None,
                "last_status": "error",
                "last_error": "Recovery window elapsed.",
                "metadata": {},
            }
        )
        return storage.create_scheduled_prompt_run(
            {
                "run_id": "scheduled-run-1",
                "task_id": "task-1",
                "definition_id": None,
                "user_id": "user-1",
                "version_id": None,
                "due_at": now,
                "started_at": now,
                "completed_at": now,
                "status": "failed",
                "executor": "glasshive_host",
                "rendered_hash": None,
                "variable_snapshot_hash": None,
                "glasshive_project_id": "project-1",
                "glasshive_worker_id": "worker-1",
                "glasshive_run_id": "glasshive-run-1",
                "result_summary": "Synthetic terminal failure.",
                "error_class": error_class,
                "private_detail_path": None,
                "callback_payload_json": None,
                "disposition": "failed",
                "created_at": now,
                "updated_at": now,
            }
        )

    def test_signed_late_completion_repairs_stale_recovery_but_not_real_terminal_failure(self):
        secret = "synthetic-callback-secret"
        payload = {
            "event": "run.completed",
            "worker_id": "worker-1",
            "run_id": "glasshive-run-1",
            "message": "Synthetic authoritative result.",
        }
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        signature = self._glasshive_signature(
            secret, raw, payload["worker_id"], payload["run_id"]
        )

        for error_class, expected_persisted, expected_status in (
            ("stale_run_reconciled", True, "completed"),
            ("worker_failed", False, "failed"),
        ):
            with self.subTest(error_class=error_class), tempfile.TemporaryDirectory() as tmpdir:
                storage = self._make_storage(tmpdir)
                self._create_glasshive_run(storage, error_class=error_class)
                try:
                    client = self._make_client(storage)
                except Exception:
                    self.skipTest("Could not create test client from FastMCP app")
                    return
                with patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ):
                    response = client.post(
                        "/internal/scheduled-prompts/glasshive-callback",
                        content=raw,
                        headers={
                            "content-type": "application/json",
                            "x-glasshive-signature": signature,
                        },
                    )

                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["callback_persisted"], expected_persisted)
                persisted = storage.get_scheduled_prompt_run("scheduled-run-1")
                self.assertEqual(persisted["status"], expected_status)
                if expected_persisted:
                    self.assertEqual(persisted["disposition"], "delivered")
                    self.assertIsNone(persisted["error_class"])
                    callback_summary = json.loads(persisted["callback_payload_json"])
                    self.assertEqual(callback_summary["event"], "run.completed")
                    parent = storage.get_task("user-1", "task-1")
                    self.assertEqual(parent["last_status"], "success")
                    self.assertEqual(parent["last_delivery_outcome"], "sent")
                    self.assertIsNone(parent["last_error"])
                else:
                    self.assertEqual(persisted["error_class"], "worker_failed")
                    parent = storage.get_task("user-1", "task-1")
                    self.assertEqual(parent["last_status"], "error")
                    self.assertEqual(parent["last_error"], "Recovery window elapsed.")

    def test_bootstrap_creates_schedule(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = self._make_storage(tmpdir)
            try:
                client = self._make_client(storage)
            except Exception:
                self.skipTest("Could not create test client from FastMCP app")
                return

            resp = client.post("/internal/bootstrap-schedule", json={
                "user_id": "user-1",
                "template_id": "morning_briefing_default_v1",
                "timezone": "America/Toronto",
                "time": "07:30",
            })
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data["status"], "created")
            self.assertIn("task_id", data)

            found = storage.find_by_metadata_template("user-1", "morning_briefing_default_v1")
            self.assertIsNotNone(found)
            self.assertEqual(found["schedule"]["time"], "07:30")
            self.assertEqual(found["schedule"]["timezone"], "America/Toronto")

    def test_bootstrap_idempotent_returns_exists(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = self._make_storage(tmpdir)
            try:
                client = self._make_client(storage)
            except Exception:
                self.skipTest("Could not create test client from FastMCP app")
                return

            first = client.post("/internal/bootstrap-schedule", json={
                "user_id": "user-1",
                "template_id": "morning_briefing_default_v1",
            })
            self.assertEqual(first.json()["status"], "created")

            second = client.post("/internal/bootstrap-schedule", json={
                "user_id": "user-1",
                "template_id": "morning_briefing_default_v1",
            })
            self.assertEqual(second.json()["status"], "exists")
            self.assertEqual(first.json()["task_id"], second.json()["task_id"])

    def test_bootstrap_missing_fields_returns_400(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = self._make_storage(tmpdir)
            try:
                client = self._make_client(storage)
            except Exception:
                self.skipTest("Could not create test client from FastMCP app")
                return

            resp = client.post("/internal/bootstrap-schedule", json={
                "user_id": "user-1",
            })
            self.assertEqual(resp.status_code, 400)

    def test_bootstrap_isolates_users(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = self._make_storage(tmpdir)
            try:
                client = self._make_client(storage)
            except Exception:
                self.skipTest("Could not create test client from FastMCP app")
                return

            client.post("/internal/bootstrap-schedule", json={
                "user_id": "user-1",
                "template_id": "morning_briefing_default_v1",
            })
            resp_u2 = client.post("/internal/bootstrap-schedule", json={
                "user_id": "user-2",
                "template_id": "morning_briefing_default_v1",
            })
            self.assertEqual(resp_u2.json()["status"], "created")

            found_u1 = storage.find_by_metadata_template("user-1", "morning_briefing_default_v1")
            found_u2 = storage.find_by_metadata_template("user-2", "morning_briefing_default_v1")
            self.assertIsNotNone(found_u1)
            self.assertIsNotNone(found_u2)
            self.assertNotEqual(found_u1["id"], found_u2["id"])

    def test_schedule_summary_omits_prompt_and_delivery_payloads(self):
        summary = serialize_task_summary({
            "id": "task-1",
            "user_id": "user-1",
            "agent_id": "agent-1",
            "prompt": "Eve's Inner Monologue\nReview stale project notes and monologue text.",
            "schedule": {"type": "daily", "time": "07:00", "timezone": "America/Toronto"},
            "channel": ["telegram", "librechat"],
            "conversation_policy": "same",
            "conversation_id": None,
            "last_conversation_id": None,
            "active": 1,
            "created_by": "agent:agent-1",
            "created_source": "agent",
            "created_at": "2026-04-08T07:00:00Z",
            "updated_at": "2026-04-08T07:00:00Z",
            "updated_by": "agent:agent-1",
            "updated_source": "agent",
            "last_run_at": "2026-04-08T07:00:00Z",
            "next_run_at": "2026-04-09T07:00:00Z",
            "last_status": "success",
            "last_error": None,
            "last_delivery_outcome": "sent",
            "last_delivery_reason": "delivered",
            "last_delivery_at": "2026-04-08T07:00:01Z",
            "last_generated_text": "Here is the full stale generated prose.",
            "last_delivery": {"generated_text": "Here is the full stale generated prose."},
            "metadata": {"name": "Morning Briefing"},
        })

        self.assertEqual(summary["summary"], "Morning Briefing")
        self.assertEqual(summary["task_id_internal"], "task-1")
        self.assertTrue(summary["starter_morning_briefing"] is False)
        self.assertNotIn("prompt", summary)
        self.assertNotIn("last_generated_text", summary)
        self.assertNotIn("last_delivery", summary)
        self.assertNotIn("metadata", summary)
        self.assertNotIn("user_id", summary)
        self.assertNotIn("agent_id", summary)
        self.assertNotIn("conversation_policy", summary)
        self.assertNotIn("created_by", summary)
        self.assertNotIn("updated_by", summary)
        self.assertNotIn("last_error", summary)
        self.assertNotIn("last_run_at", summary)
        self.assertNotIn("last_status", summary)
        self.assertNotIn("last_delivery_outcome", summary)
        self.assertNotIn("last_delivery_reason", summary)
        self.assertNotIn("last_delivery_at", summary)

        starter_summary = serialize_task_summary({
            **{
                "id": "task-2",
                "user_id": "user-1",
                "agent_id": "agent-1",
                "prompt": "Starter briefing internal prompt",
                "schedule": {"type": "daily", "time": "08:00", "timezone": "America/Toronto"},
                "channel": ["telegram", "librechat"],
                "conversation_policy": "same",
                "conversation_id": None,
                "last_conversation_id": None,
                "active": 1,
                "created_by": "agent:agent-1",
                "created_source": "agent",
                "created_at": "2026-04-08T07:00:00Z",
                "updated_at": "2026-04-08T07:00:00Z",
                "updated_by": "agent:agent-1",
                "updated_source": "agent",
                "last_run_at": None,
                "next_run_at": "2026-04-09T08:00:00Z",
                "last_status": None,
                "last_error": None,
                "last_delivery_outcome": None,
                "last_delivery_reason": None,
                "last_delivery_at": None,
                "last_generated_text": None,
                "last_delivery": None,
                "metadata": {"template_id": "morning_briefing_default_v1"},
            }
        })
        self.assertEqual(starter_summary["summary"], "Morning briefing")
        self.assertTrue(starter_summary["starter_morning_briefing"])
        self.assertNotIn("morning_briefing_default_v1", str(starter_summary))

        unnamed_summary = serialize_task_summary({
            **{
                "id": "task-3",
                "user_id": "user-1",
                "agent_id": "agent-1",
                "prompt": "Private internal reminder prompt that must never appear in list output.",
                "schedule": {"type": "daily", "time": "09:00", "timezone": "America/Toronto"},
                "channel": ["librechat"],
                "conversation_policy": "same",
                "conversation_id": None,
                "last_conversation_id": None,
                "active": 1,
                "created_by": "agent:agent-1",
                "created_source": "agent",
                "created_at": "2026-04-08T07:00:00Z",
                "updated_at": "2026-04-08T07:00:00Z",
                "updated_by": "agent:agent-1",
                "updated_source": "agent",
                "last_run_at": None,
                "next_run_at": "2026-04-09T09:00:00Z",
                "last_status": None,
                "last_error": None,
                "last_delivery_outcome": None,
                "last_delivery_reason": None,
                "last_delivery_at": None,
                "last_generated_text": None,
                "last_delivery": None,
                "metadata": {},
            }
        })
        self.assertEqual(unnamed_summary["summary"], "scheduled task")
        self.assertNotIn("Private internal reminder prompt", str(unnamed_summary))


if __name__ == "__main__":
    unittest.main()
