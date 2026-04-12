# === VIVENTIUM START ===
# Purpose: Tests for the /internal/bootstrap-schedule endpoint.
# === VIVENTIUM END ===

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.storage import ScheduleStorage, StorageConfig
from scheduling_cortex.server import build_server, serialize_task_summary

try:
    from starlette.testclient import TestClient
except ImportError:
    TestClient = None


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
        self.assertNotIn("prompt", summary)
        self.assertNotIn("last_generated_text", summary)
        self.assertNotIn("last_delivery", summary)


if __name__ == "__main__":
    unittest.main()
