"""An uncertain scheduled delivery is never resent, stays named, and the owner is told once."""

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex import dispatch
from scheduling_cortex.scheduler import SchedulerEngine, dispatch_run_ledger_updates
from scheduling_cortex.storage import ScheduleStorage, StorageConfig

USER_ID = "user-1"
IDENTITY = ("tg-3", "tg-3", {"always_voice_response": False, "voice_responses_enabled": True})
GENERATION = {
    "conversation_id": "conv-1",
    "response_message_id": "msg-1",
    "final_text": "Your 9:00 reminder: water the plants.",
    "followup_text": "",
}


def _iso(value: datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def _task(task_id: str, **overrides) -> dict:
    task = {
        "id": task_id,
        "user_id": USER_ID,
        "agent_id": "agent-1",
        "prompt": "Reminder",
        "schedule": {"type": "daily", "time": "09:00", "timezone": "UTC"},
        "channel": "telegram",
        "conversation_policy": "same",
        "conversation_id": None,
        "last_conversation_id": None,
        "active": 1,
        "created_by": "agent:agent-1",
        "created_source": "agent",
        "created_at": "2026-02-13T18:00:00Z",
        "updated_at": "2026-02-13T18:00:00Z",
        "updated_by": "agent:agent-1",
        "updated_source": "agent",
        "last_run_at": None,
        "next_run_at": "2026-02-13T19:00:00Z",
        "last_status": None,
        "last_error": None,
        "metadata": None,
    }
    task.update(overrides)
    return task


def _stopped_mid_send(tmp_path, monkeypatch, *, confirm_send: bool):
    """A run that claimed its Telegram part, then the scheduler process stopped."""

    monkeypatch.setenv("SCHEDULING_STALE_PROMPT_RUN_SECONDS", "")
    db_path = str(tmp_path / "schedules.db")
    storage = ScheduleStorage(StorageConfig(db_path=db_path))
    now = datetime.now(timezone.utc).replace(microsecond=0)
    stale_at = _iso(now - timedelta(minutes=30))
    task = _task(
        "task-stopped",
        created_at=stale_at,
        last_status="running",
        next_run_at=_iso(now + timedelta(hours=23)),
    )
    storage.create_task(task)
    claimed = storage.claim_scheduled_prompt_occurrence(
        task_id=task["id"],
        user_id=USER_ID,
        executor="viventium_agent",
        due_at=stale_at,
        lease_owner="scheduler:stopped",
        now=stale_at,
        lease_seconds=24 * 60 * 60,
    )
    run = claimed["run"]
    storage.update_scheduled_prompt_run(run["run_id"], {"status": "dispatching", "updated_at": stale_at})
    part = storage.claim_scheduled_prompt_delivery(
        run_id=run["run_id"],
        occurrence_key=run["occurrence_key"],
        channel="telegram",
        part_index=0,
        payload_hash="payload-0",
        lease_owner="telegram:stopped",
        now=stale_at,
        lease_seconds=30,
    )
    if confirm_send:
        storage.complete_scheduled_prompt_delivery(
            delivery_key=part["delivery_key"],
            lease_owner="telegram:stopped",
            message_id="tg-message-1",
            now=stale_at,
        )
    restarted = ScheduleStorage(StorageConfig(db_path=db_path))
    return restarted, task, run, now


def test_stop_after_telegram_accepted_closes_unconfirmed_without_resend(tmp_path, monkeypatch):
    storage, task, run, now = _stopped_mid_send(tmp_path, monkeypatch, confirm_send=False)

    recovered = storage.get_scheduled_prompt_run(run["run_id"])
    parent = storage.get_task(USER_ID, task["id"])
    assert recovered["status"] == "completed"
    assert recovered["disposition"] == "partial"
    assert recovered["error_class"] == "delivery_unknown"
    assert recovered["execution_snapshot"]["unconfirmed_delivery_notice"] == {
        "state": "pending",
        "channels": ["telegram"],
    }
    assert parent["last_status"] == "partial_success"
    assert parent["last_delivery_outcome"] == "delivery_unknown"
    assert parent["last_delivery_reason"] == (
        "send_receipt_missing_after_lease; delivery unconfirmed on telegram, not resent"
    )

    resend = storage.claim_scheduled_prompt_delivery(
        run_id=run["run_id"],
        occurrence_key=run["occurrence_key"],
        channel="telegram",
        part_index=0,
        payload_hash="payload-0",
        lease_owner="telegram:restarted",
        now=_iso(now),
        lease_seconds=30,
    )
    assert resend["claimed"] is False
    assert resend["reason"] == "delivery_unknown"
    replay = storage.claim_scheduled_prompt_occurrence(
        task_id=task["id"],
        user_id=USER_ID,
        executor="viventium_agent",
        due_at=run["due_at"],
        lease_owner="scheduler:restarted",
        now=_iso(now),
        lease_seconds=15 * 60,
    )
    assert replay["claimed"] is False
    assert replay["reason"] == "occurrence_already_terminal"
    assert len(storage.list_scheduled_prompt_runs(task_id=task["id"])) == 1
    assert [row["run_id"] for row in storage.list_pending_unconfirmed_delivery_notices()] == [
        run["run_id"]
    ]


def test_live_send_lease_leaves_the_run_for_a_later_pass(tmp_path, monkeypatch):
    monkeypatch.setenv("SCHEDULING_STALE_PROMPT_RUN_SECONDS", "")
    db_path = str(tmp_path / "schedules.db")
    storage = ScheduleStorage(StorageConfig(db_path=db_path))
    now = datetime.now(timezone.utc).replace(microsecond=0)
    stale_at = _iso(now - timedelta(minutes=30))
    task = _task("task-live-send", created_at=stale_at, last_status="running")
    storage.create_task(task)
    run = storage.claim_scheduled_prompt_occurrence(
        task_id=task["id"],
        user_id=USER_ID,
        executor="viventium_agent",
        due_at=stale_at,
        lease_owner="scheduler:stopped",
        now=stale_at,
        lease_seconds=24 * 60 * 60,
    )["run"]
    storage.update_scheduled_prompt_run(run["run_id"], {"status": "dispatching", "updated_at": stale_at})
    storage.claim_scheduled_prompt_delivery(
        run_id=run["run_id"],
        occurrence_key=run["occurrence_key"],
        channel="telegram",
        part_index=0,
        payload_hash="payload-0",
        lease_owner="telegram:live",
        now=_iso(now),
        lease_seconds=45,
    )

    restarted = ScheduleStorage(StorageConfig(db_path=db_path))
    untouched = restarted.get_scheduled_prompt_run(run["run_id"])
    assert untouched["status"] == "dispatching"
    assert "unconfirmed_delivery_notice" not in (untouched["execution_snapshot"] or {})
    assert restarted.list_pending_unconfirmed_delivery_notices() == []
    live = restarted.claim_scheduled_prompt_delivery(
        run_id=run["run_id"],
        occurrence_key=run["occurrence_key"],
        channel="telegram",
        part_index=0,
        payload_hash="payload-0",
        lease_owner="telegram:other",
        now=_iso(now),
        lease_seconds=45,
    )
    assert live["reason"] == "delivery_claim_active"

    with restarted._connect() as conn:
        ScheduleStorage._reconcile_stale_scheduled_prompt_runs(conn, now=now + timedelta(minutes=2))
    settled = restarted.get_scheduled_prompt_run(run["run_id"])
    assert settled["status"] == "completed"
    assert settled["disposition"] == "partial"
    assert settled["execution_snapshot"]["unconfirmed_delivery_notice"]["state"] == "pending"
    assert [row["run_id"] for row in restarted.list_pending_unconfirmed_delivery_notices()] == [
        run["run_id"]
    ]
    after_expiry = restarted.claim_scheduled_prompt_delivery(
        run_id=run["run_id"],
        occurrence_key=run["occurrence_key"],
        channel="telegram",
        part_index=0,
        payload_hash="payload-0",
        lease_owner="telegram:later",
        now=_iso(now + timedelta(minutes=2)),
        lease_seconds=45,
    )
    assert after_expiry["reason"] == "delivery_unknown"


def test_stop_after_confirmed_send_closes_delivered_without_notice(tmp_path, monkeypatch):
    storage, task, run, _now = _stopped_mid_send(tmp_path, monkeypatch, confirm_send=True)

    recovered = storage.get_scheduled_prompt_run(run["run_id"])
    parent = storage.get_task(USER_ID, task["id"])
    assert recovered["status"] == "completed"
    assert recovered["disposition"] == "delivered"
    assert recovered["error_class"] is None
    assert "unconfirmed_delivery_notice" not in (recovered["execution_snapshot"] or {})
    assert parent["last_status"] == "success"
    assert parent["last_delivery_outcome"] == "sent"
    assert storage.list_pending_unconfirmed_delivery_notices() == []


def test_owner_notice_closes_once(tmp_path, monkeypatch):
    storage, _task_row, run, now = _stopped_mid_send(tmp_path, monkeypatch, confirm_send=False)

    assert storage.record_unconfirmed_delivery_notice(
        run["run_id"], outcome="sent", reason="delivered", now=_iso(now)
    )
    assert not storage.record_unconfirmed_delivery_notice(
        run["run_id"], outcome="failed", reason="late", now=_iso(now)
    )
    notice = storage.get_scheduled_prompt_run(run["run_id"])["execution_snapshot"][
        "unconfirmed_delivery_notice"
    ]
    assert notice["state"] == "sent"
    assert storage.list_pending_unconfirmed_delivery_notices() == []


def test_mixed_delivery_names_unconfirmed_telegram_and_replay_never_resends(tmp_path):
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _task(
        "task-mixed",
        channel=["librechat", "telegram"],
        conversation_policy="new",
        _scheduled_prompt_run_id="run-mixed",
        _scheduled_prompt_occurrence_key="occurrence-mixed",
    )
    with patch.object(dispatch, "_run_scheduler_generation", return_value=dict(GENERATION)), patch.object(
        dispatch, "_resolve_telegram_identity", return_value=IDENTITY
    ), patch.object(dispatch, "_scheduler_storage", return_value=storage), patch.object(
        dispatch, "_get_telegram_bot_token", return_value="token"
    ), patch.object(
        dispatch, "_ack_scheduler_telegram_delivery", return_value="unavailable"
    ), patch.object(
        dispatch, "_send_telegram_voice_or_text", side_effect=TimeoutError("read timed out")
    ) as send:
        first = dispatch.dispatch_task(task)
        replay = dispatch.dispatch_task(task)

    assert send.call_count == 1
    for result in (first, replay):
        assert result["delivery"]["outcome"] == "sent"
        assert result["delivery"]["unconfirmed_channels"] == ["telegram"]
        assert result["delivery"]["channels"]["telegram"]["outcome"] == "delivery_unknown"


def test_owner_notice_is_sent_once_on_its_own_ledger_key(tmp_path):
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    content = storage.claim_scheduled_prompt_delivery(
        run_id="run-notice",
        occurrence_key="occurrence-notice",
        channel="telegram",
        part_index=0,
        payload_hash="content",
        lease_owner="telegram:first",
        now="2026-09-15T10:00:00Z",
        lease_seconds=30,
    )
    storage.mark_scheduled_prompt_delivery_unknown(
        delivery_key=content["delivery_key"],
        lease_owner="telegram:first",
        now="2026-09-15T10:00:05Z",
        error_class="transport_response_missing",
    )
    task = _task(
        "task-notice",
        _scheduled_prompt_run_id="run-notice",
        _scheduled_prompt_occurrence_key="occurrence-notice",
    )
    with patch.object(dispatch, "_resolve_telegram_identity", return_value=IDENTITY), patch.object(
        dispatch, "_scheduler_storage", return_value=storage
    ), patch.object(dispatch, "_get_telegram_bot_token", return_value="token"), patch.object(
        dispatch, "_send_telegram_voice_or_text", return_value="tg-notice-1"
    ) as send:
        first = dispatch.deliver_unconfirmed_delivery_notice(task, conversation_saved=True)
        repeat = dispatch.deliver_unconfirmed_delivery_notice(task, conversation_saved=True)

    assert send.call_count == 1
    text = send.call_args.args[1]
    assert "didn't send it again" in text
    assert "saved in its Viventium conversation" in text
    assert first == {"outcome": "sent", "reason": "delivered"}
    assert repeat["outcome"] == "sent"
    still_unknown = storage.claim_scheduled_prompt_delivery(
        run_id="run-notice",
        occurrence_key="occurrence-notice",
        channel="telegram",
        part_index=0,
        payload_hash="content",
        lease_owner="telegram:later",
        now="2026-09-15T10:10:00Z",
        lease_seconds=30,
    )
    assert still_unknown["reason"] == "delivery_unknown"


def test_run_ledger_marks_unconfirmed_delivery_partial_and_owes_one_notice():
    task = {"id": "task-ledger", "executor": "viventium_agent"}
    mixed = {
        "conversation_id": "conv-1",
        "delivery": {
            "outcome": "sent",
            "reason": "delivered",
            "unconfirmed_channels": ["telegram"],
            "channels": {
                "librechat": {"outcome": "sent"},
                "telegram": {"outcome": "delivery_unknown"},
            },
        },
    }
    updates = dispatch_run_ledger_updates(task, mixed)
    assert updates["disposition"] == "partial"
    assert updates["execution_snapshot"]["unconfirmed_delivery_notice"] == {
        "state": "pending",
        "channels": ["telegram"],
    }

    closed = dispatch_run_ledger_updates(
        task,
        mixed,
        existing_execution={"unconfirmed_delivery_notice": {"state": "sent", "channels": ["telegram"]}},
    )
    assert closed["execution_snapshot"]["unconfirmed_delivery_notice"]["state"] == "sent"

    telegram_only = dispatch_run_ledger_updates(
        task,
        {
            "delivery": {
                "outcome": "delivery_unknown",
                "reason": "telegram_delivery_ambiguous",
                "unconfirmed_channels": ["telegram"],
                "channels": {"telegram": {"outcome": "delivery_unknown"}},
            }
        },
    )
    assert telegram_only["disposition"] == "partial"
    assert telegram_only["execution_snapshot"]["unconfirmed_delivery_notice"]["state"] == "pending"

    delivered = dispatch_run_ledger_updates(
        task, {"delivery": {"outcome": "sent", "channels": {"telegram": {"outcome": "sent"}}}}
    )
    assert delivered["disposition"] == "delivered"
    assert "unconfirmed_delivery_notice" not in delivered["execution_snapshot"]


def test_notice_sweep_tells_the_owner_once(tmp_path, monkeypatch):
    storage, _task_row, run, now = _stopped_mid_send(tmp_path, monkeypatch, confirm_send=False)
    engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)

    with patch(
        "scheduling_cortex.scheduler.deliver_unconfirmed_delivery_notice",
        return_value={"outcome": "sent", "reason": "delivered"},
    ) as notice:
        engine._deliver_pending_unconfirmed_notices(now)
        engine._deliver_pending_unconfirmed_notices(now)

    notice.assert_called_once()
    assert notice.call_args.args[0]["_scheduled_prompt_run_id"] == run["run_id"]
    assert notice.call_args.args[0]["_scheduled_prompt_occurrence_key"] == run["occurrence_key"]
    assert notice.call_args.kwargs["conversation_saved"] is False
    state = storage.get_scheduled_prompt_run(run["run_id"])["execution_snapshot"][
        "unconfirmed_delivery_notice"
    ]["state"]
    assert state == "sent"


def test_scheduled_mixed_delivery_records_partial_success_and_owes_notice(tmp_path):
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    storage.create_task(_task("task-e2e"))
    task = storage.get_task(USER_ID, "task-e2e")
    engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
    due = datetime(2026, 2, 13, 19, 0, tzinfo=timezone.utc)

    with patch(
        "scheduling_cortex.scheduler.dispatch_task",
        return_value={
            "conversation_id": "conv-1",
            "delivery": {
                "outcome": "sent",
                "reason": "delivered",
                "unconfirmed_channels": ["telegram"],
                "channels": {
                    "librechat": {"outcome": "sent"},
                    "telegram": {"outcome": "delivery_unknown", "reason": "telegram_delivery_ambiguous"},
                },
            },
        },
    ):
        engine._process_task(task, due)

    parent = storage.get_task(USER_ID, "task-e2e")
    assert parent["last_status"] == "partial_success"
    assert parent["last_delivery_reason"] == "delivered; delivery unconfirmed on telegram, not resent"
    runs = storage.list_scheduled_prompt_runs(task_id="task-e2e")
    assert len(runs) == 1
    assert runs[0]["disposition"] == "partial"
    assert [row["run_id"] for row in storage.list_pending_unconfirmed_delivery_notices()] == [
        runs[0]["run_id"]
    ]
