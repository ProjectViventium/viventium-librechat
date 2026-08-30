import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.server import (
    _external_work_callback_updates,
    _glasshive_callback_reconciliation_allowed,
    _glasshive_callback_lifecycle,
)


def test_late_nonterminal_callback_cannot_regress_a_terminal_run():
    completed = {
        "status": "completed",
        "disposition": "delivered",
        "completed_at": "2026-08-11T12:00:00+00:00",
        "error_class": None,
    }

    for event in ("run.queued", "run.waiting_on_capacity", "run.requeued", "run.started"):
        assert _glasshive_callback_lifecycle(completed, event, {}, "later") == (
            "completed",
            "delivered",
            "2026-08-11T12:00:00+00:00",
            None,
        )


def test_terminal_callback_sets_canonical_disposition():
    running = {"status": "running", "disposition": "running"}

    assert _glasshive_callback_lifecycle(running, "run.completed", {}, "now") == (
        "completed",
        "delivered",
        "now",
        None,
    )
    assert _glasshive_callback_lifecycle(
        running,
        "run.interrupted",
        {"failure_class": "user_cancelled"},
        "now",
    ) == ("failed", "cancelled", "now", "user_cancelled")


def test_waiting_on_capacity_remains_retryable_and_queued():
    running = {
        "status": "running",
        "disposition": "running",
        "completed_at": None,
        "error_class": "stale_failure",
    }

    assert _glasshive_callback_lifecycle(
        running,
        "run.waiting_on_capacity",
        {},
        "now",
    ) == ("queued", "running", None, None)


def test_late_failed_callback_cannot_regress_completed_run():
    completed = {
        "status": "completed",
        "disposition": "delivered",
        "completed_at": "2026-08-11T12:00:00+00:00",
        "error_class": None,
    }

    assert _glasshive_callback_lifecycle(
        completed,
        "run.failed",
        {"failure_class": "late_transport_failure"},
        "later",
    ) == (
        "completed",
        "delivered",
        "2026-08-11T12:00:00+00:00",
        None,
    )


def test_required_external_work_repairs_a_prematurely_completed_occurrence():
    prematurely_completed = {
        "status": "completed",
        "disposition": "delivered",
        "completed_at": "2026-08-11T12:00:00+00:00",
    }

    updates = _external_work_callback_updates(
        prematurely_completed,
        {
            "requiredTotal": 2,
            "requiredTerminal": 1,
            "requiredFailed": 0,
            "allRequiredTerminal": False,
        },
        "2026-08-11T12:01:00+00:00",
    )

    assert updates["status"] == "waiting_external"
    assert updates["disposition"] == "running"
    assert updates["completed_at"] is None
    assert "lease_owner" not in updates
    assert "lease_until" not in updates


def test_nonterminal_external_work_callback_preserves_the_existing_lease():
    waiting = {
        "status": "waiting_external",
        "disposition": "running",
        "lease_owner": "scheduler:one",
        "lease_until": "2026-08-11T12:15:00+00:00",
    }

    updates = _external_work_callback_updates(
        waiting,
        {
            "requiredTotal": 2,
            "requiredTerminal": 1,
            "requiredFailed": 0,
            "allRequiredTerminal": False,
        },
        "2026-08-11T12:02:00+00:00",
    )

    assert updates["status"] == "waiting_external"
    assert updates["lease_owner"] == "scheduler:one"
    assert updates["lease_until"] > "2026-08-11T12:15:00+00:00"


def test_external_work_occurrence_completes_only_after_every_required_mission_is_terminal():
    waiting = {"status": "waiting_external", "disposition": "running"}

    updates = _external_work_callback_updates(
        waiting,
        {
            "requiredTotal": 2,
            "requiredTerminal": 2,
            "requiredFailed": 0,
            "allRequiredTerminal": True,
        },
        "2026-08-11T12:02:00+00:00",
    )

    assert updates["status"] == "completed"
    assert updates["disposition"] == "delivered"
    assert updates["completed_at"] == "2026-08-11T12:02:00+00:00"


def test_late_completed_callback_cannot_regress_failed_run():
    failed = {
        "status": "failed",
        "disposition": "failed",
        "completed_at": "2026-08-11T12:00:00+00:00",
        "error_class": "worker_failed",
    }

    assert _glasshive_callback_lifecycle(failed, "run.completed", {}, "later") == (
        "failed",
        "failed",
        "2026-08-11T12:00:00+00:00",
        "worker_failed",
    )


def test_late_completed_callback_repairs_only_a_synthetic_stale_run_failure():
    stale_recovery_failure = {
        "status": "failed",
        "disposition": "failed",
        "completed_at": "2026-08-11T12:00:00+00:00",
        "error_class": "stale_run_reconciled",
    }

    assert _glasshive_callback_reconciliation_allowed(
        stale_recovery_failure, "run.completed"
    )
    assert _glasshive_callback_lifecycle(
        stale_recovery_failure, "run.completed", {}, "later"
    ) == ("completed", "delivered", "later", None)

    assert not _glasshive_callback_reconciliation_allowed(
        stale_recovery_failure, "run.started"
    )
    assert not _glasshive_callback_reconciliation_allowed(
        {**stale_recovery_failure, "error_class": "worker_failed"},
        "run.completed",
    )


def test_duplicate_terminal_callback_is_idempotent():
    completed = {
        "status": "completed",
        "disposition": "delivered",
        "completed_at": "2026-08-11T12:00:00+00:00",
        "error_class": None,
    }

    assert _glasshive_callback_lifecycle(completed, "run.completed", {}, "later") == (
        "completed",
        "delivered",
        "2026-08-11T12:00:00+00:00",
        None,
    )
