# === VIVENTIUM START ===
# Purpose: Queued GlassHive work blocked for owner authorization keeps its typed class and can resume.
# === VIVENTIUM END ===

import hashlib
import hmac
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.server import (
    _glasshive_callback_channel_outcomes,
    _glasshive_callback_delivery_outcome,
    build_server,
)
from scheduling_cortex.storage import ScheduleStorage, StorageConfig

try:
    from starlette.testclient import TestClient
except ImportError:
    TestClient = None

SECRET = "synthetic-callback-secret"
NOW = "2026-08-11T12:00:00Z"
NEXT_RUN = "2026-08-12T09:00:00Z"
BLOCKED_CLASS = "capability_authorization_horizon_expired"
CALLBACK_PATH = "/internal/scheduled-prompts/glasshive-callback"
BLOCKED_CALLBACK = {
    "event": "run.needs_input",
    "worker_id": "worker-1",
    "run_id": "glasshive-run-1",
    "message_id": "scheduled-run-1",
    "message": "Provide the requested authorization, then resume this work.",
    "failure_code": BLOCKED_CLASS,
    "failure_class": BLOCKED_CLASS,
    "failure_retryable": False,
}
RESUMED_CALLBACK = {
    "event": "run.started",
    "worker_id": "worker-1",
    "run_id": "glasshive-run-1",
    "message_id": "scheduled-run-1",
    "message": "Resumed after authorization was restored.",
}


def _signature(raw: bytes, worker_id: str, run_id: str) -> str:
    binding = f"{worker_id}:{run_id}".encode("utf-8")
    derived = hmac.new(SECRET.encode("utf-8"), binding, hashlib.sha256).hexdigest().encode("utf-8")
    return "sha256=" + hmac.new(derived, raw, hashlib.sha256).hexdigest()


def _terminal_completion() -> dict:
    digest = "sha256:" + "b" * 64
    material = ":".join(("glasshive-run-1", "completed", NOW, "0", "1", digest))
    return {
        "event": "run.completed",
        "worker_id": "worker-1",
        "run_id": "glasshive-run-1",
        "message": "Synthetic result after the owner restored authorization.",
        "callback_id": "cb_terminal_" + hashlib.sha256(material.encode("utf-8")).hexdigest(),
        "callback_ts": 1786478400,
        "message_id": "scheduled-run-1",
        "result_digest": digest,
        "result_ended_at": NOW,
        "result_revision": 1,
        "result_state": "completed",
        "user_id": "user-1",
    }


CAPACITY_WAIT_CALLBACK = {
    "event": "run.waiting_on_capacity",
    "worker_id": "worker-1",
    "run_id": "glasshive-run-1",
    "message_id": "scheduled-run-1",
    "message": "Waiting for host worker capacity.",
}


def _terminal_failure(failure_class: str) -> dict:
    digest = "sha256:" + "c" * 64
    material = ":".join(("glasshive-run-1", "failed", NOW, "0", "1", digest))
    return {
        "event": "run.failed",
        "worker_id": "worker-1",
        "run_id": "glasshive-run-1",
        "message": "Synthetic terminal failure after the bounded admission wait.",
        "error": failure_class,
        "failure_class": failure_class,
        "failure_retryable": True,
        "callback_id": "cb_terminal_" + hashlib.sha256(material.encode("utf-8")).hexdigest(),
        "callback_ts": 1786478400,
        "message_id": "scheduled-run-1",
        "result_digest": digest,
        "result_ended_at": NOW,
        "result_revision": 1,
        "result_state": "failed",
        "user_id": "user-1",
    }


@unittest.skipIf(TestClient is None, "starlette test client is unavailable")
class QueuedGlassHiveRunNeedsInputTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = Path(self._tmp.name)
        self._env = patch.dict(
            os.environ,
            {
                "SCHEDULING_GLASSHIVE_CALLBACK_SECRET": SECRET,
                "VIVENTIUM_APP_SUPPORT_DIR": str(root / "app-support"),
                "VIVENTIUM_PRIVATE_USER_DATA_DIR": str(root / "private"),
            },
            clear=False,
        )
        self._env.start()
        self.storage = ScheduleStorage(StorageConfig(db_path=str(root / "schedules.db")))
        self._create_queued_occurrence()
        self.client = TestClient(build_server(self.storage).http_app(transport="streamable-http"))

    def tearDown(self):
        self._env.stop()
        self._tmp.cleanup()

    def _create_queued_occurrence(self):
        self.storage.create_task(
            {
                "id": "task-1",
                "user_id": "user-1",
                "agent_id": "agent-1",
                "prompt": "Synthetic scheduled workspace task.",
                "schedule": {"type": "daily", "time": "09:00", "timezone": "UTC"},
                "channel": ["workbench"],
                "executor": "glasshive_host",
                "conversation_policy": "new",
                "conversation_id": None,
                "last_conversation_id": None,
                "active": 1,
                "created_by": "agent:agent-1",
                "created_source": "agent",
                "created_at": NOW,
                "updated_at": NOW,
                "updated_by": "agent:agent-1",
                "updated_source": "agent",
                "last_run_at": NOW,
                "next_run_at": NEXT_RUN,
                "last_status": "running",
                "last_error": None,
                "metadata": {},
            }
        )
        self.storage.create_scheduled_prompt_run(
            {
                "run_id": "scheduled-run-1",
                "task_id": "task-1",
                "definition_id": None,
                "user_id": "user-1",
                "version_id": None,
                "due_at": NOW,
                "started_at": NOW,
                "completed_at": None,
                "status": "queued",
                "executor": "glasshive_host",
                "rendered_hash": None,
                "variable_snapshot_hash": None,
                "glasshive_project_id": "project-1",
                "glasshive_worker_id": "worker-1",
                "glasshive_run_id": "glasshive-run-1",
                "result_summary": None,
                "error_class": None,
                "private_detail_path": None,
                "callback_payload_json": None,
                "disposition": "running",
                # Production shape: dispatch records each GlassHive channel as queued.
                "channel_outcomes": {
                    "workbench": {
                        "outcome": "queued",
                        "reason": "glasshive_host_run_queued",
                        "scheduled_prompt_run_id": "scheduled-run-1",
                        "glasshive_run_id": "glasshive-run-1",
                    }
                },
                "created_at": NOW,
                "updated_at": NOW,
            }
        )

    def _post(self, payload: dict):
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        return self.client.post(
            CALLBACK_PATH,
            content=raw,
            headers={
                "content-type": "application/json",
                "x-glasshive-signature": _signature(raw, payload["worker_id"], payload["run_id"]),
            },
        )

    def _state(self):
        run = self.storage.get_scheduled_prompt_run("scheduled-run-1")
        task = self.storage.get_task("user-1", "task-1")
        return run, task

    def test_blocked_queued_run_reports_its_typed_class_and_stays_resumable(self):
        response = self._post(BLOCKED_CALLBACK)
        run, task = self._state()

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(
            (run["status"], run["disposition"], run["error_class"], run["completed_at"]),
            ("queued", "running", BLOCKED_CLASS, None),
        )
        self.assertEqual(task["last_status"], "action_required")
        self.assertEqual(task["last_delivery"]["outcome"], "action_required")
        self.assertEqual(task["last_delivery"]["reason"], BLOCKED_CLASS)
        self.assertEqual(
            run["channel_outcomes"]["workbench"],
            {
                "outcome": "action_required",
                "reason": BLOCKED_CLASS,
                "scheduled_prompt_run_id": "scheduled-run-1",
                "glasshive_run_id": "glasshive-run-1",
            },
        )
        self.assertIn(BLOCKED_CLASS, task["last_error"])
        self.assertEqual((task["active"], task["next_run_at"]), (1, NEXT_RUN))

    def test_resumed_run_completes_once_after_authorization_returns(self):
        self._post(BLOCKED_CALLBACK)
        resumed = self._post(RESUMED_CALLBACK)
        running_run, running_task = self._state()
        completed = self._post(_terminal_completion())
        replayed = self._post(_terminal_completion())
        run, task = self._state()

        self.assertEqual((resumed.status_code, completed.status_code), (200, 200), completed.text)
        self.assertEqual((running_run["status"], running_task["last_status"]), ("running", "running"))
        self.assertEqual(replayed.json().get("callback_status"), "idempotent", replayed.text)
        self.assertEqual(
            (run["status"], run["disposition"], run["error_class"]),
            ("completed", "delivered", None),
        )
        self.assertEqual((task["last_status"], task["active"]), ("success", 1))
        # The owner-facing channel record follows the terminal result, keeping its identity keys,
        # rather than still reading queued for work that was delivered.
        self.assertEqual(run["channel_outcomes"]["workbench"]["outcome"], "sent")
        self.assertEqual(
            run["channel_outcomes"]["workbench"]["glasshive_run_id"], "glasshive-run-1"
        )

    def test_blocked_notice_cannot_reopen_a_completed_run(self):
        self._post(RESUMED_CALLBACK)
        self._post(_terminal_completion())
        late_notice = self._post(BLOCKED_CALLBACK)
        run, task = self._state()

        self.assertEqual(late_notice.status_code, 200, late_notice.text)
        self.assertEqual(
            (run["status"], run["disposition"], run["error_class"]),
            ("completed", "delivered", None),
        )
        self.assertEqual(task["last_status"], "success")
        self.assertEqual(run["channel_outcomes"]["workbench"]["outcome"], "sent")

    def test_capacity_wait_then_bounded_expiry_reach_the_owner_channel_truthfully(self):
        # Current GlassHive turns a host shortage into a wait, then ends an expired wait as an
        # asynchronous terminal failure. Both steps must reach the owner's channel record instead
        # of leaving it at the dispatch-time "queued".
        waiting = self._post(CAPACITY_WAIT_CALLBACK)
        waiting_run, waiting_task = self._state()
        expired = self._post(_terminal_failure("queue_wait_timeout"))
        run, task = self._state()

        self.assertEqual((waiting.status_code, expired.status_code), (200, 200), expired.text)
        self.assertEqual(
            waiting_run["channel_outcomes"]["workbench"]["reason"], "run.waiting_on_capacity"
        )
        self.assertEqual(waiting_run["channel_outcomes"]["workbench"]["outcome"], "queued")
        self.assertEqual(waiting_task["last_delivery"]["outcome"], "queued")
        self.assertEqual((run["status"], run["error_class"]), ("failed", "queue_wait_timeout"))
        self.assertEqual(
            (
                run["channel_outcomes"]["workbench"]["outcome"],
                run["channel_outcomes"]["workbench"]["reason"],
            ),
            ("failed", "queue_wait_timeout"),
        )
        self.assertEqual(
            (task["last_status"], task["last_delivery"]["outcome"]), ("error", "failed")
        )


class GlassHiveCallbackChannelOutcomeTests(unittest.TestCase):
    def test_channel_outcome_follows_the_lifecycle_status(self):
        self.assertEqual(_glasshive_callback_delivery_outcome("completed", "run.completed"), "sent")
        self.assertEqual(_glasshive_callback_delivery_outcome("failed", "run.failed"), "failed")
        self.assertEqual(
            _glasshive_callback_delivery_outcome("queued", "run.needs_input"), "action_required"
        )
        self.assertEqual(
            _glasshive_callback_delivery_outcome("queued", "run.waiting_on_capacity"), "queued"
        )

    def test_a_run_dispatched_without_channels_is_not_given_invented_ones(self):
        for record in (None, {}):
            self.assertEqual(
                _glasshive_callback_channel_outcomes(
                    {"channel_outcomes": record}, outcome="sent", reason="run.completed"
                ),
                {},
            )


if __name__ == "__main__":
    unittest.main()
