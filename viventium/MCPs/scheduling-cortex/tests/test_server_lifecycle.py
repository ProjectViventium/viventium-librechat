import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.server import _glasshive_callback_lifecycle


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
