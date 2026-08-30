# VIVENTIUM START
# Purpose: Keep signed scheduler callbacks scoped to their own latest occurrence.
# Porting: Copy this file with the Scheduling Cortex callback receiver.
# VIVENTIUM END

from __future__ import annotations

import hashlib
import hmac
import json
import sys
from pathlib import Path

import pytest
from starlette.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex import server
from scheduling_cortex.storage import ScheduleStorage, StorageConfig


OWNER = "synthetic-health-owner"
TASK = "synthetic-health-task"
OLDER_RUN = "synthetic-previous-health-run"
NEWER_RUN = "synthetic-current-health-run"
OLDER_STARTED = "2026-08-24T10:15:19Z"
NEWER_STARTED = "2026-08-25T10:15:52Z"
CALLBACK_SECRET = "synthetic-callback-secret"


def _storage_with_newer_failure(
    directory: Path, *, older_error_class: str | None = None
) -> ScheduleStorage:
    storage = ScheduleStorage(StorageConfig(db_path=str(directory / "schedules.db")))
    storage.create_task(
        {
            "id": TASK,
            "user_id": OWNER,
            "agent_id": "prompt-workbench",
            "prompt": "Synthetic private health analysis.",
            "schedule": {"type": "daily", "time": "06:15", "timezone": "UTC"},
            "channel": ["workbench"],
            "executor": "glasshive_host",
            "conversation_policy": "new",
            "conversation_id": None,
            "last_conversation_id": None,
            "active": 1,
            "created_by": "agent:prompt-workbench",
            "created_source": "agent",
            "created_at": OLDER_STARTED,
            "updated_at": NEWER_STARTED,
            "updated_by": "agent:prompt-workbench",
            "updated_source": "agent",
            "last_run_at": NEWER_STARTED,
            "next_run_at": "2026-08-26T10:15:00Z",
            "last_status": "error",
            "last_error": "completion_error",
            "last_delivery_outcome": "failed",
            "last_delivery_reason": "completion_error",
            "last_delivery": {
                "outcome": "failed",
                "reason": "completion_error",
                "scheduled_prompt_run_id": NEWER_RUN,
            },
            "metadata": {
                "scheduled_failure_state_v1": {
                    "version": 1,
                    "error_class": "completion_error",
                    "retryable": False,
                }
            },
        }
    )
    storage.create_scheduled_prompt_run(
        {
            "run_id": OLDER_RUN,
            "task_id": TASK,
            "user_id": OWNER,
            "due_at": OLDER_STARTED,
            "started_at": OLDER_STARTED,
            "status": "failed" if older_error_class else "running",
            "executor": "glasshive_host",
            "glasshive_project_id": "synthetic-project",
            "glasshive_worker_id": "synthetic-worker",
            "glasshive_run_id": "synthetic-glasshive-run",
            "error_class": older_error_class,
            "disposition": "failed" if older_error_class else "running",
            "trigger_kind": "scheduled",
            "trigger_source": "scheduler_loop",
            "execution_snapshot": {"executor": "glasshive_host"},
            "created_at": OLDER_STARTED,
            "updated_at": OLDER_STARTED,
        }
    )
    storage.create_scheduled_prompt_run(
        {
            "run_id": NEWER_RUN,
            "task_id": TASK,
            "user_id": OWNER,
            "due_at": NEWER_STARTED,
            "started_at": NEWER_STARTED,
            "completed_at": NEWER_STARTED,
            "status": "failed",
            "executor": "glasshive_host",
            "error_class": "completion_error",
            "disposition": "failed",
            "trigger_kind": "scheduled",
            "trigger_source": "scheduler_loop",
            "execution_snapshot": {"executor": "glasshive_host"},
            "created_at": NEWER_STARTED,
            "updated_at": NEWER_STARTED,
        }
    )
    return storage


def _terminal_payload(event: str) -> dict[str, object]:
    state = event.removeprefix("run.")
    ended_at = "2026-08-25T19:39:08+00:00"
    result_digest = "sha256:" + "a" * 64
    material = ":".join(
        ("synthetic-glasshive-run", state, ended_at, "0", "1", result_digest)
    )
    payload: dict[str, object] = {
        "callback_id": "cb_terminal_" + hashlib.sha256(material.encode()).hexdigest(),
        "event": event,
        "message": "Synthetic signed terminal result.",
        "message_id": OLDER_RUN,
        "result_digest": result_digest,
        "result_ended_at": ended_at,
        "result_revision": 1,
        "result_state": state,
        "run_id": "synthetic-glasshive-run",
        "user_id": OWNER,
        "worker_id": "synthetic-worker",
    }
    if event == "run.failed":
        payload.update(
            {
                "failure_class": "provider_response_failed",
                "failure_retryable": True,
                "provider_route_decision": "primary_selected",
            }
        )
    return payload


@pytest.mark.parametrize(
    ("event", "older_error_class"),
    [
        ("run.failed", None),
        ("run.completed", None),
        ("run.completed", "stale_run_reconciled"),
    ],
    ids=["older-failure", "older-completion", "older-reconciled-completion"],
)
def test_old_signed_callback_never_overwrites_newer_failed_occurrence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    event: str,
    older_error_class: str | None,
) -> None:
    storage = _storage_with_newer_failure(tmp_path, older_error_class=older_error_class)
    monkeypatch.setenv("SCHEDULING_GLASSHIVE_CALLBACK_SECRET", CALLBACK_SECRET)
    monkeypatch.setattr(server, "_refresh_workbench_periphery_index", lambda _run: None)
    payload = _terminal_payload(event)
    raw = json.dumps(payload, separators=(",", ":")).encode()
    binding = f"{payload['worker_id']}:{payload['run_id']}".encode()
    derived = hmac.new(CALLBACK_SECRET.encode(), binding, hashlib.sha256).hexdigest()
    signature = "sha256=" + hmac.new(derived.encode(), raw, hashlib.sha256).hexdigest()

    with TestClient(server.build_server(storage).http_app(transport="streamable-http")) as client:
        response = client.post(
            "/internal/scheduled-prompts/glasshive-callback",
            content=raw,
            headers={
                "content-type": "application/json",
                "x-glasshive-signature": signature,
            },
        )

    assert response.status_code == 200
    assert response.json()["callback_status"] == "accepted"
    assert storage.get_scheduled_prompt_run(OLDER_RUN)["status"] == event.removeprefix("run.")
    current = storage.get_scheduled_prompt_run(NEWER_RUN)
    assert current["status"] == "failed"
    assert current["error_class"] == "completion_error"
    parent = storage.get_task(OWNER, TASK)
    assert parent["last_run_at"] == NEWER_STARTED
    assert parent["last_status"] == "error"
    assert parent["last_error"] == "completion_error"
    assert parent["last_delivery_reason"] == "completion_error"
    assert parent["last_delivery"]["scheduled_prompt_run_id"] == NEWER_RUN
    assert parent["metadata"]["scheduled_failure_state_v1"]["error_class"] == "completion_error"
