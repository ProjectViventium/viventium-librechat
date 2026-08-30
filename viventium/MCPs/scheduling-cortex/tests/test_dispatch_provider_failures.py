from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex import dispatch


@pytest.mark.parametrize(
    ("failure_class", "retryable"),
    [
        ("conversation_capability_grant_required", False),
        ("conversation_session_authority_conflict", True),
        ("provider_response_failed", True),
        ("provider_unavailable", True),
        ("provider_request_rejected", False),
        ("provider_auth_projection_unavailable", False),
        ("provider_content_filter", False),
        ("provider_context_limit_exceeded", False),
    ],
)
def test_scheduler_preserves_typed_provider_failure_and_its_safe_retry_policy(
    failure_class: str, retryable: bool
):
    task = {
        "id": "synthetic-provider-failure",
        "schedule": {"type": "once"},
        "metadata": {},
    }

    assert dispatch.normalized_scheduled_generation_failure_class(failure_class) == (
        failure_class
    )
    transition = dispatch.resolve_scheduled_failure_transition(task, failure_class)
    assert transition["error_class"] == failure_class
    assert transition["retryable"] is retryable
    assert transition["retry_disposition"] == (
        "retry_scheduled" if retryable else "terminal_action_required"
    )


def test_scheduler_uses_final_provider_attempt_without_leaking_provider_details():
    private_provider_error = "Bearer synthetic-private-provider-value-never-return"

    def stream(_url, _headers, _timeout_s):
        yield json.dumps(
            {
                "final": True,
                "responseMessage": {
                    "messageId": "synthetic-final-provider-attempt",
                    "content": [
                        {
                            "type": "error",
                            "error_class": "provider_rate_limited",
                            "failure_retryable": True,
                            "error": "The earlier configured route was unavailable.",
                        },
                        {
                            "type": "error",
                            "error_class": "provider_response_failed",
                            "failure_retryable": False,
                            "error": private_provider_error,
                        },
                    ],
                },
            }
        )

    with patch.object(dispatch, "_iter_sse_payloads", side_effect=stream):
        result = dispatch._stream_scheduler_response(
            "http://127.0.0.1:3180",
            "synthetic-stream",
            "synthetic-owner",
            "synthetic-secret",
            10,
            return_metadata=True,
        )

    assert result[3]["generation_failure"] == {
        "error_class": "provider_response_failed",
        "failure_retryable": False,
    }
    assert private_provider_error not in str(result)


@pytest.mark.parametrize(
    ("failure_class", "retryable"),
    [
        ("conversation_capability_grant_required", False),
        ("conversation_session_authority_conflict", True),
        ("provider_response_failed", True),
        ("provider_request_rejected", False),
        ("provider_quota_exhausted", False),
    ],
)
def test_scheduler_preserves_typed_terminal_error_frames_without_private_details(
    failure_class: str, retryable: bool
):
    private_provider_error = "Bearer synthetic-private-provider-value-never-return"

    def stream(_url, _headers, _timeout_s):
        yield json.dumps(
            {
                "error": private_provider_error,
                "error_class": failure_class,
                "failure_retryable": retryable,
            }
        )

    with patch.object(dispatch, "_iter_sse_payloads", side_effect=stream):
        result = dispatch._stream_scheduler_response(
            "http://127.0.0.1:3180",
            "synthetic-terminal-provider-error",
            "synthetic-owner",
            "synthetic-secret",
            10,
            return_metadata=True,
        )

    assert result[:3] == ("", "", "")
    assert result[3]["generation_failure"] == {
        "error_class": failure_class,
        "failure_retryable": retryable,
    }
    assert private_provider_error not in str(result)


def test_scheduler_rejects_unknown_terminal_error_frame_without_private_details():
    private_provider_error = "Bearer synthetic-private-provider-value-never-return"

    def stream(_url, _headers, _timeout_s):
        yield json.dumps(
            {
                "error": private_provider_error,
                "error_class": "provider_secret_unknown",
            }
        )

    with patch.object(dispatch, "_iter_sse_payloads", side_effect=stream):
        result = dispatch._stream_scheduler_response(
            "http://127.0.0.1:3180",
            "synthetic-terminal-unknown-error",
            "synthetic-owner",
            "synthetic-secret",
            10,
            return_metadata=True,
        )

    assert result[3]["generation_failure"] == {"error_class": "completion_error"}
    assert private_provider_error not in str(result)


def test_scheduler_preserves_the_final_attempt_explicit_retryability():
    task = {
        "id": "synthetic-provider-failure",
        "schedule": {"type": "once"},
        "metadata": {},
    }

    transition = dispatch.resolve_scheduled_failure_transition(
        task, "provider_response_failed", False
    )

    assert transition["error_class"] == "provider_response_failed"
    assert transition["retryable"] is False
    assert transition["retry_disposition"] == "terminal_action_required"


def test_scheduled_provider_failure_keeps_one_execution_and_no_guessed_fallback():
    task = {
        "id": "synthetic-scheduled-provider-failure",
        "user_id": "synthetic-owner",
        "agent_id": "synthetic-main",
        "prompt": "Run the configured scheduled action.",
        "channel": "workbench",
        "conversation_policy": "new",
        "schedule": {"type": "interval"},
        "metadata": {},
    }
    execution = {
        "provider": "configured-primary",
        "model": "configured-model",
        "fallback_attempted": True,
    }

    with patch.object(
        dispatch,
        "_run_scheduler_generation",
        return_value={
            "conversation_id": "synthetic-conversation",
            "response_message_id": "synthetic-message",
            "generation_failure": {
                "error_class": "provider_response_failed",
                "failure_retryable": True,
            },
            "execution": execution,
        },
    ) as generation:
        result = dispatch.dispatch_task(task)

    generation.assert_called_once()
    assert result["generation_failure"]["error_class"] == "provider_response_failed"
    assert result["generation_failure"]["failure_retryable"] is True
    assert result["delivery"]["reason"] == "provider_response_failed"
    assert result["delivery"]["channels"]["workbench"]["reason"] == (
        "provider_response_failed"
    )
    assert result["execution"] == execution


def test_unrecognized_provider_class_stays_closed_without_exposing_raw_error():
    payload = {
        "final": True,
        "responseMessage": {
            "content": [
                {
                    "type": "error",
                    "error_class": "provider_secret_unknown",
                    "error": "Bearer synthetic-secret-do-not-expose",
                }
            ]
        },
    }

    failure = dispatch._extract_scheduled_generation_failure(payload)

    assert failure == {"error_class": "completion_error"}
    assert "synthetic-secret" not in str(failure)
