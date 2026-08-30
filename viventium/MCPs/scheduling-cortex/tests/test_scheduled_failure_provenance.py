# VIVENTIUM START
# Purpose: Preserve typed scheduled failure evidence across owner-scoped ledgers.
# Porting: Copy this file with the Scheduling Cortex scheduled failure contract.
# VIVENTIUM END

from __future__ import annotations

import hashlib
import hmac
import json
import sys
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path
from urllib.error import HTTPError, URLError

import pytest
from starlette.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex import dispatch
from scheduling_cortex.scheduler import SchedulerEngine
from scheduling_cortex.server import build_server
from scheduling_cortex.storage import ScheduleStorage, StorageConfig


def _task(
    storage: ScheduleStorage,
    *,
    owner: str = "synthetic-owner-a",
    task_id: str = "synthetic-task-a",
    executor: str = "viventium_agent",
    schedule: dict | None = None,
    due_at: str = "2026-08-25T15:15:00Z",
) -> dict:
    storage.create_task(
        {
            "id": task_id,
            "user_id": owner,
            "agent_id": "synthetic-existing-main",
            "prompt": "Synthetic scheduled continuity opportunity.",
            "schedule": schedule
            or {
                "type": "interval",
                "timezone": "America/Toronto",
                "interval": {"every": 45, "unit": "minute"},
                "active_window": {
                    "start_local": "09:00",
                    "end_local": "21:00",
                    "cadence": "restart_daily",
                },
            },
            "channel": ["workbench"],
            "executor": executor,
            "conversation_policy": "same",
            "conversation_id": "synthetic-durable-conversation",
            "last_conversation_id": "synthetic-durable-conversation",
            "active": 1,
            "created_by": "agent:synthetic-existing-main",
            "created_source": "agent",
            "created_at": "2026-08-25T12:00:00Z",
            "updated_at": "2026-08-25T12:00:00Z",
            "updated_by": "agent:synthetic-existing-main",
            "updated_source": "agent",
            "last_run_at": None,
            "next_run_at": due_at,
            "last_status": None,
            "last_error": None,
            "metadata": {
                "source_prompt_id": "scheduler.consciousness_continuity_opportunity"
            },
        }
    )
    task = storage.get_task(owner, task_id)
    assert task is not None
    return task


def _run(
    storage: ScheduleStorage,
    *,
    owner: str = "synthetic-owner-a",
    task_id: str = "synthetic-task-a",
    run_id: str = "synthetic-scheduled-run-a",
    updated_at: str = "2026-08-25T15:15:00Z",
) -> None:
    storage.create_scheduled_prompt_run(
        {
            "run_id": run_id,
            "task_id": task_id,
            "user_id": owner,
            "due_at": updated_at,
            "started_at": updated_at,
            "status": "running",
            "executor": "glasshive_host",
            "glasshive_project_id": "synthetic-project-a",
            "glasshive_worker_id": "synthetic-worker-a",
            "glasshive_run_id": "synthetic-glasshive-run-a",
            "result_summary": "Synthetic run is active.",
            "disposition": "running",
            "execution_snapshot": {"executor": "glasshive_host"},
            "created_at": updated_at,
            "updated_at": updated_at,
        }
    )


def _terminal_failure_payload(
    *,
    owner: str = "synthetic-owner-a",
    work_id: str = "synthetic-scheduled-run-a",
    failure_class: str = "provider_quota_exhausted",
    retryable: bool = True,
    route_decision: str = "fallback_unavailable",
) -> dict:
    result_digest = "sha256:" + "a" * 64
    result_ended_at = "2026-08-25T15:16:00+00:00"
    run_id = "synthetic-glasshive-run-a"
    material = ":".join((run_id, "failed", result_ended_at, "0", "1", result_digest))
    return {
        "callback_id": "cb_terminal_" + hashlib.sha256(material.encode()).hexdigest(),
        "callback_ts": 1787670960,
        "event": "run.failed",
        "failure_class": failure_class,
        "failure_retryable": retryable,
        "message": "Synthetic private failure detail must stay private.",
        "message_id": work_id,
        "provider_route_decision": route_decision,
        "result_digest": result_digest,
        "result_ended_at": result_ended_at,
        "result_revision": 1,
        "result_state": "failed",
        "run_id": run_id,
        "user_id": owner,
        "worker_id": "synthetic-worker-a",
    }


def _terminal_completion_payload() -> dict:
    payload = _terminal_failure_payload()
    payload.update(
        {
            "event": "run.completed",
            "message": "Synthetic scheduled work completed after callback recovery.",
            "result_state": "completed",
        }
    )
    payload.pop("failure_class")
    payload.pop("failure_retryable")
    payload.pop("provider_route_decision")
    material = ":".join(
        (
            str(payload["run_id"]),
            "completed",
            str(payload["result_ended_at"]),
            "0",
            str(payload["result_revision"]),
            str(payload["result_digest"]),
        )
    )
    payload["callback_id"] = "cb_terminal_" + hashlib.sha256(
        material.encode()
    ).hexdigest()
    return payload


def _post_callback(storage: ScheduleStorage, payload: dict):
    secret = "synthetic-callback-secret"
    raw = json.dumps(payload, separators=(",", ":")).encode()
    binding = f"{payload['worker_id']}:{payload['run_id']}".encode()
    derived = hmac.new(secret.encode(), binding, hashlib.sha256).hexdigest().encode()
    signature = "sha256=" + hmac.new(derived, raw, hashlib.sha256).hexdigest()
    server = build_server(storage)
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setenv("SCHEDULING_GLASSHIVE_CALLBACK_SECRET", secret)
        with TestClient(server.http_app(transport="streamable-http")) as client:
            return client.post(
                "/internal/scheduled-prompts/glasshive-callback",
                content=raw,
                headers={
                    "content-type": "application/json",
                    "x-glasshive-signature": signature,
                },
            )


@pytest.mark.parametrize(
    ("failure_class", "retryable"),
    [
        ("runtime_dependency_missing", False),
        ("runtime_sandbox_unavailable", True),
        ("parallel_execution_isolation_required", False),
        ("runtime_io_failed", True),
        ("unsupported_runtime_configuration", False),
        ("host_capacity", True),
        ("scheduler_gateway_unavailable", True),
        ("glasshive_runtime_unavailable", True),
        ("glasshive_worker_quota_exceeded", False),
    ],
)
def test_scheduler_preserves_closed_typed_runtime_failures(
    failure_class: str, retryable: bool
) -> None:
    task = {"id": "synthetic-failure", "schedule": {"type": "once"}}

    assert dispatch.normalized_scheduled_generation_failure_class(failure_class) == (
        failure_class
    )
    transition = dispatch.resolve_scheduled_failure_transition(task, failure_class)
    assert transition["error_class"] == failure_class
    assert transition["retryable"] is retryable


def test_consciousness_gateway_failure_preserves_recurrence_and_conversation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _task(storage)
    engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
    monkeypatch.setattr(
        "scheduling_cortex.scheduler.dispatch_task",
        lambda _task: (_ for _ in ()).throw(URLError(ConnectionRefusedError(61, "synthetic"))),
    )

    engine._process_task(task, datetime(2026, 8, 25, 15, 15, tzinfo=timezone.utc))

    run = storage.list_scheduled_prompt_runs(task_id=task["id"])[0]
    updated = storage.get_task(task["user_id"], task["id"])
    assert updated is not None
    assert run["status"] == "failed"
    assert run["error_class"] == "scheduler_gateway_unavailable"
    assert run["execution_snapshot"]["scheduled_failure_state_v1"] == {
        "version": 1,
        "error_class": "scheduler_gateway_unavailable",
        "retryable": True,
        "retry_disposition": "next_occurrence_only",
    }
    assert updated["last_error"] == "scheduler_gateway_unavailable"
    assert updated["metadata"]["scheduled_failure_state_v1"]["retryable"] is True
    assert updated["next_run_at"] == "2026-08-25T16:00:00Z"
    assert updated["conversation_id"] == "synthetic-durable-conversation"
    assert updated["last_conversation_id"] == "synthetic-durable-conversation"


def test_consciousness_terminal_error_frame_preserves_rejection_and_recurrence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _task(storage)
    requests: list[dict] = []

    def post_json(_url, payload, _headers, _timeout_s):
        requests.append(payload)
        return {
            "streamId": "synthetic-stream",
            "conversationId": "synthetic-durable-conversation",
        }

    monkeypatch.setenv("SCHEDULER_LIBRECHAT_SECRET", "synthetic-secret")
    monkeypatch.setattr(dispatch, "_post_json", post_json)
    monkeypatch.setattr(dispatch, "_get_json", lambda *_args: {})
    monkeypatch.setattr(
        dispatch,
        "_iter_sse_payloads",
        lambda *_args: iter(
            (
                json.dumps(
                    {
                        "error": "Bearer synthetic-private-provider-value-never-return",
                        "error_class": "provider_request_rejected",
                        "failure_retryable": False,
                    }
                ),
            )
        ),
    )
    engine = SchedulerEngine(
        storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300
    )

    engine._process_task(task, datetime(2026, 8, 25, 15, 15, tzinfo=timezone.utc))

    run = storage.list_scheduled_prompt_runs(task_id=task["id"])[0]
    updated = storage.get_task(task["user_id"], task["id"])
    assert updated is not None
    assert len(requests) == 1
    assert requests[0]["agentId"] == "synthetic-existing-main"
    assert "model" not in requests[0]
    assert "provider" not in requests[0]
    assert run["status"] == "failed"
    assert run["error_class"] == "provider_request_rejected"
    assert run["execution_snapshot"]["scheduled_failure_state_v1"] == {
        "version": 1,
        "error_class": "provider_request_rejected",
        "retryable": False,
        "retry_disposition": "next_occurrence_only",
    }
    assert updated["active"] == 1
    assert updated["last_error"] == "provider_request_rejected"
    assert updated["next_run_at"] == "2026-08-25T16:00:00Z"
    assert updated["conversation_id"] == "synthetic-durable-conversation"
    assert "synthetic-private-provider-value" not in json.dumps(run)


def test_consciousness_recovers_at_next_occurrence_without_changing_main_route(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _task(storage)
    engine = SchedulerEngine(
        storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300
    )
    attempts: list[dict] = []

    def dispatch_occurrence(scheduled_task: dict) -> dict:
        attempts.append(scheduled_task)
        if len(attempts) == 1:
            return dispatch.scheduled_failure_result(
                scheduled_task, "provider_response_failed", failure_retryable=True
            )
        return {
            "conversation_id": "synthetic-durable-conversation",
            "response_message_id": "synthetic-recovered-response",
            "execution": {
                "effective_model": "synthetic-receipted-main-model",
                "effective_reasoning_effort": "high",
                "provider": "synthetic-receipted-main-route",
            },
            "delivery": {
                "outcome": "sent",
                "reason": "delivered",
                "generated_text": "Synthetic recovered continuity insight.",
                "channels": {
                    "workbench": {"outcome": "sent", "reason": "delivered"}
                },
            },
        }

    monkeypatch.setattr(
        "scheduling_cortex.scheduler.dispatch_task", dispatch_occurrence
    )

    engine._process_task(task, datetime(2026, 8, 25, 15, 15, tzinfo=timezone.utc))
    next_task = storage.get_task(task["user_id"], task["id"])
    assert next_task is not None
    assert next_task["last_error"] == "provider_response_failed"
    assert next_task["next_run_at"] == "2026-08-25T16:00:00Z"

    engine._process_task(
        next_task, datetime(2026, 8, 25, 16, 0, tzinfo=timezone.utc)
    )

    recovered = storage.get_task(task["user_id"], task["id"])
    runs = storage.list_scheduled_prompt_runs(task_id=task["id"])
    assert recovered is not None
    assert len(runs) == 2
    assert [run["status"] for run in runs] == ["completed", "failed"]
    assert runs[0]["execution_snapshot"]["effective_model"] == (
        "synthetic-receipted-main-model"
    )
    assert runs[0]["execution_snapshot"]["effective_reasoning_effort"] == "high"
    assert recovered["last_status"] == "success"
    assert recovered["last_error"] is None
    assert recovered["next_run_at"] == "2026-08-25T16:45:00Z"
    assert recovered["conversation_id"] == "synthetic-durable-conversation"
    assert "scheduled_failure_state_v1" not in recovered["metadata"]
    assert all(attempt["agent_id"] == "synthetic-existing-main" for attempt in attempts)
    assert all("model" not in attempt for attempt in attempts)


def test_consciousness_session_authority_conflict_waits_for_next_occurrence(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _task(storage)
    engine = SchedulerEngine(
        storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300
    )
    monkeypatch.setattr(
        "scheduling_cortex.scheduler.dispatch_task",
        lambda scheduled_task: dispatch.scheduled_failure_result(
            scheduled_task,
            "conversation_session_authority_conflict",
            failure_retryable=True,
        ),
    )

    engine._process_task(task, datetime(2026, 8, 25, 15, 15, tzinfo=timezone.utc))

    run = storage.list_scheduled_prompt_runs(task_id=task["id"])[0]
    updated = storage.get_task(task["user_id"], task["id"])
    assert updated is not None
    assert run["status"] == "failed"
    assert run["error_class"] == "conversation_session_authority_conflict"
    assert run["execution_snapshot"]["scheduled_failure_state_v1"] == {
        "version": 1,
        "error_class": "conversation_session_authority_conflict",
        "retryable": True,
        "retry_disposition": "next_occurrence_only",
    }
    assert updated["active"] == 1
    assert updated["last_error"] == "conversation_session_authority_conflict"
    assert updated["next_run_at"] == "2026-08-25T16:00:00Z"
    assert updated["conversation_id"] == "synthetic-durable-conversation"


@pytest.mark.parametrize("generation_failed", [False, True])
def test_explicit_effective_execution_receipt_survives_scheduler_generation(
    monkeypatch: pytest.MonkeyPatch, generation_failed: bool
) -> None:
    task = {
        "id": "synthetic-continuity-task",
        "user_id": "synthetic-owner-a",
        "agent_id": "synthetic-existing-main",
        "prompt": "Synthetic continuity opportunity.",
        "channel": ["workbench"],
        "conversation_policy": "same",
        "metadata": {
            "source_prompt_id": "scheduler.consciousness_continuity_opportunity"
        },
    }
    requests: list[dict] = []
    monkeypatch.setenv("SCHEDULER_LIBRECHAT_SECRET", "synthetic-secret")

    def accept(_url: str, payload: dict, _headers: dict, _timeout: int) -> dict:
        requests.append(payload)
        return {
            "streamId": "synthetic-stream",
            "conversationId": "synthetic-durable-conversation",
            "executionReceipt": {
                "effectiveModel": "synthetic-primary-model",
                "effectiveReasoningEffort": "medium",
                "provider": "synthetic-primary-route",
            },
        }

    metadata = {
        "execution_receipt": {
            "effective_model": "synthetic-actual-model",
            "effective_reasoning_effort": "high",
            "provider": "synthetic-actual-route",
            "authorization_token": "synthetic-private-token",
        }
    }
    if generation_failed:
        metadata["generation_failure"] = {
            "error_class": "provider_response_failed",
            "failure_retryable": True,
        }
    monkeypatch.setattr(dispatch, "_post_json", accept)
    monkeypatch.setattr(
        dispatch,
        "_stream_scheduler_response",
        lambda *_args, **_kwargs: (
            "Synthetic completed response." if not generation_failed else "",
            "synthetic-response-message",
            "",
            metadata,
        ),
    )
    monkeypatch.setattr(
        dispatch,
        "_poll_scheduler_followup",
        lambda *_args, **_kwargs: {"followup_text": "", "canonical_text": ""},
    )

    result = dispatch._run_scheduler_generation(
        task, "http://synthetic.invalid", 5, "synthetic-durable-conversation"
    )

    assert result["execution"]["effective_model"] == "synthetic-actual-model"
    assert result["execution"]["effective_reasoning_effort"] == "high"
    assert result["execution"]["provider"] == "synthetic-actual-route"
    assert "authorization_token" not in result["execution"]
    assert "model" not in requests[0]
    assert "reasoning_effort" not in requests[0]
    if generation_failed:
        assert result["generation_failure"]["error_class"] == "provider_response_failed"


def test_scheduler_stream_preserves_explicit_final_execution_receipt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    final_event = {
        "final": True,
        "responseMessage": {
            "messageId": "synthetic-response-message",
            "executionReceipt": {
                "effectiveModel": "synthetic-effective-model",
                "effectiveReasoningEffort": "xhigh",
                "provider": "synthetic-effective-route",
            },
            "content": [
                {
                    "type": "error",
                    "error_class": "provider_response_failed",
                    "failure_retryable": True,
                }
            ],
        },
    }
    monkeypatch.setattr(
        dispatch,
        "_iter_sse_payloads",
        lambda *_args: iter((json.dumps(final_event),)),
    )

    result = dispatch._stream_scheduler_response(
        "http://synthetic.invalid",
        "synthetic-stream",
        "synthetic-owner-a",
        "synthetic-secret",
        5,
        return_metadata=True,
    )

    assert result[3]["generation_failure"]["error_class"] == "provider_response_failed"
    assert result[3]["execution_receipt"]["effective_model"] == "synthetic-effective-model"
    assert result[3]["execution_receipt"]["effective_reasoning_effort"] == "xhigh"


@pytest.mark.parametrize("fallback_used", [False, True])
@pytest.mark.parametrize("receipt_location", ["response_metadata", "terminal_execution"])
def test_scheduler_ingests_final_server_authored_scheduled_execution_metadata(
    monkeypatch: pytest.MonkeyPatch,
    fallback_used: bool,
    receipt_location: str,
) -> None:
    scheduled_execution = {
        "version": 1,
        "provider": "claude-code",
        "model": "opus",
        "reasoningEffort": "high",
        "fallbackUsed": fallback_used,
        "fallbackReason": "provider_quota_exhausted" if fallback_used else None,
        "authorizationToken": "synthetic-secret-must-not-enter-ledgers",
    }
    final_event = {
        "final": True,
        "responseMessage": {
            "messageId": "synthetic-response-message",
            "content": [
                {"type": "text", "text": "Synthetic scheduled response."}
            ],
        },
    }
    if receipt_location == "response_metadata":
        final_event["responseMessage"]["metadata"] = {
            "viventium": {"scheduledExecution": scheduled_execution}
        }
    else:
        final_event["execution"] = scheduled_execution
    monkeypatch.setattr(
        dispatch,
        "_iter_sse_payloads",
        lambda *_args: iter((json.dumps(final_event),)),
    )

    result = dispatch._stream_scheduler_response(
        "http://synthetic.invalid",
        "synthetic-stream",
        "synthetic-owner-a",
        "synthetic-secret",
        5,
        return_metadata=True,
    )

    receipt = result[3]["execution_receipt"]
    assert receipt["provider"] == "claude-code"
    assert receipt["effective_model"] == "opus"
    assert receipt["effective_reasoning_effort"] == "high"
    assert receipt["fallback_used"] is fallback_used
    if fallback_used:
        assert receipt["fallback_reason"] == "provider_quota_exhausted"
    else:
        assert "fallback_reason" not in receipt
    assert "authorizationToken" not in receipt
    assert "synthetic-secret" not in str(receipt)


@pytest.mark.parametrize(
    "invalid_changes",
    [
        {"version": 2},
        {"provider": ""},
        {"model": ""},
        {"fallbackUsed": "true"},
    ],
)
def test_scheduler_rejects_invalid_server_authored_scheduled_execution_metadata(
    monkeypatch: pytest.MonkeyPatch, invalid_changes: dict
) -> None:
    scheduled_execution = {
        "version": 1,
        "provider": "claude-code",
        "model": "opus",
        "fallbackUsed": True,
        **invalid_changes,
    }
    final_event = {
        "final": True,
        "responseMessage": {
            "messageId": "synthetic-response-message",
            "metadata": {
                "viventium": {"scheduledExecution": scheduled_execution}
            },
            "content": [{"type": "text", "text": "Synthetic response."}],
        },
    }
    monkeypatch.setattr(
        dispatch,
        "_iter_sse_payloads",
        lambda *_args: iter((json.dumps(final_event),)),
    )

    result = dispatch._stream_scheduler_response(
        "http://synthetic.invalid",
        "synthetic-stream",
        "synthetic-owner-a",
        "synthetic-secret",
        5,
        return_metadata=True,
    )

    assert "execution_receipt" not in result[3]


def test_scheduler_never_treats_nonfinal_route_metadata_as_winning_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    speculative_event = {
        "final": False,
        "responseMessage": {
            "metadata": {
                "viventium": {
                    "scheduledExecution": {
                        "version": 1,
                        "provider": "synthetic-speculative-primary",
                        "model": "synthetic-primary-that-may-fail",
                        "reasoningEffort": "xhigh",
                        "fallbackUsed": False,
                    }
                }
            }
        },
    }
    final_event = {
        "final": True,
        "responseMessage": {
            "messageId": "synthetic-response-message",
            "content": [{"type": "text", "text": "Synthetic response."}],
        },
    }
    monkeypatch.setattr(
        dispatch,
        "_iter_sse_payloads",
        lambda *_args: iter((json.dumps(speculative_event), json.dumps(final_event))),
    )

    result = dispatch._stream_scheduler_response(
        "http://synthetic.invalid",
        "synthetic-stream",
        "synthetic-owner-a",
        "synthetic-secret",
        5,
        return_metadata=True,
    )

    assert "execution_receipt" not in result[3]


def test_scheduler_does_not_misreport_accepted_route_as_effective_execution(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    task = {
        "id": "synthetic-continuity-task",
        "user_id": "synthetic-owner-a",
        "agent_id": "synthetic-existing-main",
        "prompt": "Synthetic continuity opportunity.",
        "channel": ["workbench"],
        "conversation_policy": "same",
        "metadata": {},
    }
    monkeypatch.setenv("SCHEDULER_LIBRECHAT_SECRET", "synthetic-secret")
    monkeypatch.setattr(
        dispatch,
        "_post_json",
        lambda *_args: {
            "streamId": "synthetic-stream",
            "conversationId": "synthetic-durable-conversation",
            "executionReceipt": {
                "effectiveModel": "synthetic-primary-may-fallback",
                "effectiveReasoningEffort": "medium",
                "provider": "synthetic-primary-route",
            },
        },
    )
    monkeypatch.setattr(
        dispatch,
        "_stream_scheduler_response",
        lambda *_args, **_kwargs: (
            "Synthetic completed response.",
            "synthetic-response-message",
            "",
            {},
        ),
    )
    monkeypatch.setattr(
        dispatch,
        "_poll_scheduler_followup",
        lambda *_args, **_kwargs: {"followup_text": "", "canonical_text": ""},
    )

    result = dispatch._run_scheduler_generation(
        task, "http://synthetic.invalid", 5, "synthetic-durable-conversation"
    )

    assert "effective_model" not in result["execution"]
    assert "effective_reasoning_effort" not in result["execution"]
    assert "provider" not in result["execution"]


def test_native_winning_scheduled_route_reaches_run_ledger_and_workbench(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _task(storage)
    monkeypatch.setenv("SCHEDULER_LIBRECHAT_SECRET", "synthetic-secret")
    monkeypatch.setattr(
        dispatch,
        "_post_json",
        lambda *_args: {
            "streamId": "synthetic-stream",
            "conversationId": "synthetic-durable-conversation",
            "executionReceipt": {
                "effectiveModel": "synthetic-primary-that-failed",
                "provider": "synthetic-primary-provider",
            },
        },
    )
    monkeypatch.setattr(
        dispatch,
        "_iter_sse_payloads",
        lambda *_args: iter(
            (
                json.dumps(
                    {
                        "final": True,
                        "responseMessage": {
                            "messageId": "synthetic-response-message",
                            "metadata": {
                                "viventium": {
                                    "scheduledExecution": {
                                        "version": 1,
                                        "provider": "claude-code",
                                        "model": "opus",
                                        "reasoningEffort": "high",
                                        "fallbackUsed": True,
                                        "fallbackReason": "provider_quota_exhausted",
                                    }
                                }
                            },
                            "content": [
                                {
                                    "type": "text",
                                    "text": "Synthetic recovered scheduled response.",
                                }
                            ],
                        },
                    }
                ),
            )
        ),
    )
    monkeypatch.setattr(
        dispatch,
        "_poll_scheduler_followup",
        lambda *_args, **_kwargs: {"followup_text": "", "canonical_text": ""},
    )
    monkeypatch.setattr(dispatch, "_get_json", lambda *_args: {})
    monkeypatch.syspath_prepend(str(ROOT.parents[4]))
    monkeypatch.syspath_prepend(str(ROOT.parents[3] / "prompt-workbench" / "backend"))
    from prompt_workbench import scheduled_prompts

    engine = SchedulerEngine(
        storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300
    )
    engine._process_task(task, datetime(2026, 8, 25, 15, 15, tzinfo=timezone.utc))

    run = storage.list_scheduled_prompt_runs(task_id=task["id"])[0]
    public_run = scheduled_prompts._public_run(run, schedule=task["schedule"])
    execution = run["execution_snapshot"]
    assert run["status"] == "completed"
    assert execution["provider"] == "claude-code"
    assert execution["effective_model"] == "opus"
    assert execution["effective_reasoning_effort"] == "high"
    assert execution["fallback_used"] is True
    assert execution["fallback_reason"] == "provider_quota_exhausted"
    assert execution["effective_model"] != "synthetic-primary-that-failed"
    assert public_run["effectiveModel"] == "opus"
    assert public_run["effectiveReasoningEffort"] == "high"


def test_scheduler_failure_reaches_workbench_and_cognitive_health_without_guessing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _task(storage)
    monkeypatch.setenv("SCHEDULER_LIBRECHAT_SECRET", "synthetic-secret")
    monkeypatch.setattr(
        dispatch,
        "_post_json",
        lambda *_args: {
            "streamId": "synthetic-stream",
            "conversationId": "synthetic-durable-conversation",
        },
    )
    monkeypatch.setattr(
        dispatch,
        "_stream_scheduler_response",
        lambda *_args, **_kwargs: (
            "",
            "synthetic-response-message",
            "",
            {
                "generation_failure": {
                    "error_class": "provider_response_failed",
                    "failure_retryable": True,
                },
                "execution_receipt": {
                    "effective_model": "synthetic-receipted-model",
                    "effective_reasoning_effort": "high",
                    "provider": "synthetic-receipted-route",
                },
            },
        ),
    )
    monkeypatch.setattr(dispatch, "_get_json", lambda *_args: {})
    monkeypatch.syspath_prepend(str(ROOT.parents[4]))
    monkeypatch.syspath_prepend(str(ROOT.parents[3] / "prompt-workbench" / "backend"))
    from prompt_workbench import cognitive_integrity, scheduled_prompts

    engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
    engine._process_task(task, datetime(2026, 8, 25, 15, 15, tzinfo=timezone.utc))
    run = storage.list_scheduled_prompt_runs(task_id=task["id"])[0]
    public_run = scheduled_prompts._public_run(run, schedule=task["schedule"])
    monkeypatch.setattr(
        cognitive_integrity.scheduled_prompts,
        "list_scheduled_prompts",
        lambda **_kwargs: {
            "scheduledPrompts": [
                {
                    "sourcePromptId": "scheduler.consciousness_continuity_opportunity",
                    "active": True,
                    "recentRuns": [public_run],
                    "latestScheduledRun": public_run,
                    "lastStatus": "error",
                    "executor": "viventium_agent",
                }
            ]
        },
    )

    health = cognitive_integrity._consciousness_continuity_status(
        task["user_id"], now=datetime(2026, 8, 25, 15, 16, tzinfo=timezone.utc)
    )

    assert public_run["status"] == "failed"
    assert public_run["errorClass"] == "provider_response_failed"
    assert public_run["effectiveModel"] == "synthetic-receipted-model"
    assert public_run["effectiveReasoningEffort"] == "high"
    assert public_run["channelOutcomes"]["workbench"]["reason"] == "provider_response_failed"
    assert health["status"] == "blocked"
    assert health["latestScheduledStatus"] == "failed"
    assert health["lastErrorClass"] == "provider_response_failed"


@pytest.mark.parametrize("generation_failed", [False, True])
def test_telegram_channel_failure_preserves_typed_transport_cause(
    monkeypatch: pytest.MonkeyPatch, generation_failed: bool
) -> None:
    task = {
        "id": "synthetic-continuity-task",
        "user_id": "synthetic-owner-a",
        "agent_id": "synthetic-existing-main",
        "prompt": "Synthetic continuity opportunity.",
        "channel": ["librechat", "telegram"],
        "conversation_policy": "same",
        "conversation_id": "synthetic-durable-conversation",
        "schedule": {"type": "interval", "interval": {"every": 45, "unit": "minute"}},
        "metadata": {},
    }
    monkeypatch.setattr(
        dispatch,
        "_deliver_telegram_generated_text",
        lambda *_args: (_ for _ in ()).throw(
            URLError(ConnectionRefusedError(61, "synthetic-private-transport-detail"))
        ),
    )
    if generation_failed:
        result = dispatch.scheduled_failure_result(
            task, "provider_response_failed", failure_retryable=True
        )
    else:
        monkeypatch.setattr(
            dispatch,
            "_run_scheduler_generation",
            lambda *_args: {
                "conversation_id": "synthetic-durable-conversation",
                "response_message_id": "synthetic-response-message",
                "final_text": "Synthetic completed response.",
                "followup_text": "",
            },
        )
        result = dispatch.dispatch_task(task)

    detail = result["delivery"]["channels"]["telegram"]
    assert detail["reason"] == "scheduler_gateway_unavailable"
    assert detail["error_class"] == "scheduler_gateway_unavailable"
    assert detail["failure_retryable"] is True
    assert "synthetic-private-transport-detail" not in str(result)


@pytest.mark.parametrize(
    ("failure_class", "retryable"),
    [
        ("runtime_dependency_missing", False),
        ("runtime_sandbox_unavailable", True),
        ("provider_quota_exhausted", True),
        ("provider_response_failed", True),
    ],
)
def test_failed_worker_launch_preserves_exact_class_and_explicit_retryability(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    failure_class: str,
    retryable: bool,
) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _task(storage, executor="glasshive_host")
    error = dispatch.HttpJsonError(
        "Synthetic private transport body must not enter public ledgers.",
        status=409,
        method="POST",
        path="/v1/projects/synthetic-project/workers/find-or-resume",
        payload={
            "failure_class": failure_class,
            "failure_retryable": retryable,
            "provider_route_decision": "fallback_unavailable",
        },
        failure_class=failure_class,
        failure_retryable=retryable,
    )
    monkeypatch.setattr(
        "scheduling_cortex.scheduler.dispatch_task",
        lambda _task: (_ for _ in ()).throw(error),
    )
    engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)

    engine._process_task(task, datetime(2026, 8, 25, 15, 15, tzinfo=timezone.utc))

    run = storage.list_scheduled_prompt_runs(task_id=task["id"])[0]
    updated = storage.get_task(task["user_id"], task["id"])
    assert updated is not None
    assert run["error_class"] == failure_class
    assert run["execution_snapshot"]["scheduled_failure_state_v1"]["retryable"] is retryable
    assert run["execution_snapshot"]["provider_route_decision"] == "fallback_unavailable"
    assert updated["last_error"] == failure_class
    assert updated["metadata"]["scheduled_failure_state_v1"]["retryable"] is retryable
    assert "private transport body" not in str(run)


@pytest.mark.parametrize(
    ("quota_name", "declared_retryable", "retryable"),
    [
        ("GLASSHIVE_MAX_WORKSPACES_PER_USER", 0, False),
        ("GLASSHIVE_MAX_ACTIVE_WORKERS_PER_USER", 1, True),
    ],
)
def test_structured_glasshive_launch_quota_reaches_owner_scoped_run_ledger(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    quota_name: str,
    declared_retryable: int,
    retryable: bool,
) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _task(storage, executor="glasshive_host")
    other_owner = _task(
        storage, owner="synthetic-owner-b", task_id="synthetic-task-b"
    )
    url = "http://synthetic.invalid/v1/projects/synthetic-project/workers/find-or-resume"
    response = HTTPError(
        url,
        429,
        "Too Many Requests",
        {},
        BytesIO(
            json.dumps(
                {
                    "status": "blocked",
                    "detail": "Synthetic private workspace detail must not enter public ledgers.",
                    "failure_class": "glasshive_worker_quota_exceeded",
                    "failure_retryable": declared_retryable,
                    "quota": {
                        "env_name": quota_name,
                        "limit": 1,
                        "current_count": 1,
                    },
                }
            ).encode()
        ),
    )
    launch_failure = dispatch._format_http_error("POST", url, response)
    monkeypatch.setattr(
        "scheduling_cortex.scheduler.dispatch_task",
        lambda _task: (_ for _ in ()).throw(launch_failure),
    )
    engine = SchedulerEngine(
        storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300
    )

    engine._process_task(task, datetime(2026, 8, 25, 15, 15, tzinfo=timezone.utc))

    run = storage.list_scheduled_prompt_runs(task_id=task["id"])[0]
    updated = storage.get_task(task["user_id"], task["id"])
    unrelated = storage.get_task(other_owner["user_id"], other_owner["id"])
    assert updated is not None and unrelated is not None
    assert run["error_class"] == "glasshive_worker_quota_exceeded"
    assert run["error_class"] != "provider_quota_exhausted"
    assert run["execution_snapshot"]["scheduled_failure_state_v1"]["retryable"] is (
        retryable
    )
    assert updated["last_error"] == "glasshive_worker_quota_exceeded"
    assert updated["metadata"]["scheduled_failure_state_v1"]["retryable"] is retryable
    assert unrelated["last_error"] is None
    assert "private workspace detail" not in str(run)


def test_signed_terminal_failure_preserves_retryability_route_and_owner(
    tmp_path: Path,
) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    _task(storage, executor="glasshive_host")
    _task(storage, owner="synthetic-owner-b", task_id="synthetic-task-b")
    _run(storage)
    payload = _terminal_failure_payload()

    response = _post_callback(storage, payload)

    assert response.status_code == 200
    run = storage.get_scheduled_prompt_run("synthetic-scheduled-run-a")
    owner_a = storage.get_task("synthetic-owner-a", "synthetic-task-a")
    owner_b = storage.get_task("synthetic-owner-b", "synthetic-task-b")
    assert run is not None and owner_a is not None and owner_b is not None
    assert run["error_class"] == "provider_quota_exhausted"
    assert run["callback_payload"]["failure_class"] == "provider_quota_exhausted"
    assert run["callback_payload"]["failure_retryable"] is True
    assert run["callback_payload"]["provider_route_decision"] == "fallback_unavailable"
    assert run["execution_snapshot"]["scheduled_failure_state_v1"]["retryable"] is True
    assert owner_a["last_error"] == "provider_quota_exhausted"
    assert owner_a["last_delivery_reason"] == "provider_quota_exhausted"
    assert owner_a["last_delivery"]["failure_transition_v1"]["retryable"] is True
    assert owner_b["last_error"] is None
    assert "private failure detail" not in json.dumps(run["callback_payload"])


def test_restart_recovers_accepted_terminal_failure_without_foreign_owner_leakage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "schedules.db"
    storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
    _task(storage, executor="glasshive_host")
    _run(storage, updated_at="2020-01-01T00:00:00Z")
    owner_b_payload = _terminal_failure_payload(
        owner="synthetic-owner-b", failure_class="runtime_dependency_missing"
    )
    storage.accept_scheduled_terminal_callback_result(
        owner_id="synthetic-owner-b",
        work_id="synthetic-scheduled-run-a",
        payload=owner_b_payload,
    )
    owner_a_payload = _terminal_failure_payload(
        failure_class="provider_response_failed", retryable=True
    )
    storage.accept_scheduled_terminal_callback_result(
        owner_id="synthetic-owner-a",
        work_id="synthetic-scheduled-run-a",
        payload=owner_a_payload,
    )
    monkeypatch.setenv("SCHEDULING_STALE_PROMPT_RUN_SECONDS", "60")

    recovered = ScheduleStorage(StorageConfig(db_path=str(db_path)))

    run = recovered.get_scheduled_prompt_run("synthetic-scheduled-run-a")
    assert run is not None
    assert run["status"] == "failed"
    assert run["error_class"] == "provider_response_failed"
    assert run["execution_snapshot"]["scheduled_failure_state_v1"]["retryable"] is True
    assert run["execution_snapshot"]["provider_route_decision"] == "fallback_unavailable"
    assert run["error_class"] != "runtime_dependency_missing"


def test_restart_without_terminal_callback_never_claims_success(tmp_path: Path) -> None:
    db_path = tmp_path / "schedules.db"
    storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
    _task(storage, executor="glasshive_host")
    _run(storage, updated_at="2020-01-01T00:00:00Z")

    recovered = ScheduleStorage(StorageConfig(db_path=str(db_path)))

    run = recovered.get_scheduled_prompt_run("synthetic-scheduled-run-a")
    assert run is not None
    assert run["status"] == "failed"
    assert run["error_class"] == "stale_run_reconciled"


def test_late_signed_completion_repairs_stale_occurrence_and_parent_schedule(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    db_path = tmp_path / "schedules.db"
    storage = ScheduleStorage(StorageConfig(db_path=str(db_path)))
    _task(storage, executor="glasshive_host")
    _task(storage, owner="synthetic-owner-b", task_id="synthetic-task-b")
    _run(storage, updated_at="2020-01-01T00:00:00Z")
    monkeypatch.setattr(
        "scheduling_cortex.server._refresh_workbench_periphery_index",
        lambda _run: None,
    )

    recovered = ScheduleStorage(StorageConfig(db_path=str(db_path)))
    stale = recovered.get_scheduled_prompt_run("synthetic-scheduled-run-a")
    assert stale is not None and stale["error_class"] == "stale_run_reconciled"

    response = _post_callback(recovered, _terminal_completion_payload())

    run = recovered.get_scheduled_prompt_run("synthetic-scheduled-run-a")
    owner_a = recovered.get_task("synthetic-owner-a", "synthetic-task-a")
    owner_b = recovered.get_task("synthetic-owner-b", "synthetic-task-b")
    assert response.status_code == 200
    assert run is not None and owner_a is not None and owner_b is not None
    assert run["status"] == "completed"
    assert run["error_class"] is None
    assert owner_a["last_status"] == "success"
    assert owner_a["last_error"] is None
    assert owner_b["last_status"] is None
