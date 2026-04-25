# === VIVENTIUM START ===
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# === VIVENTIUM END ===

import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.scheduler import SchedulerEngine, SCHEDULER_MISFIRE_KEY
from scheduling_cortex.storage import ScheduleStorage, StorageConfig


def _seed_task(
    storage: ScheduleStorage,
    task_id: str = "task-1",
    *,
    schedule: dict | None = None,
    created_source: str = "agent",
    metadata: dict | None = None,
    next_run_at: str = "2026-02-13T19:00:00Z",
) -> dict:
    task = {
        "id": task_id,
        "user_id": "user-1",
        "agent_id": "agent-1",
        "prompt": "Daily reflection",
        "schedule": schedule or {"type": "daily", "time": "09:00", "timezone": "UTC"},
        "channel": "telegram",
        "conversation_policy": "same",
        "conversation_id": None,
        "last_conversation_id": None,
        "active": 1,
        "created_by": "agent:agent-1",
        "created_source": created_source,
        "created_at": "2026-02-13T18:00:00Z",
        "updated_at": "2026-02-13T18:00:00Z",
        "updated_by": "agent:agent-1",
        "updated_source": created_source,
        "last_run_at": None,
        "next_run_at": next_run_at,
        "last_status": None,
        "last_error": None,
        "metadata": metadata,
    }
    storage.create_task(task)
    created = storage.get_task("user-1", task_id)
    assert created is not None
    return created


class SchedulerDeliveryPersistenceTests(unittest.TestCase):
    def test_update_after_success_records_delivery_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-success")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-123",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "telegram:nta",
                        "generated_text": "{NTA}",
                        "channels": {"telegram": {"outcome": "suppressed", "reason": "nta"}},
                    },
                },
            )

            updated = storage.get_task("user-1", "task-success")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("conversation_id"), "conv-123")
            self.assertEqual(updated.get("last_conversation_id"), "conv-123")
            self.assertEqual(updated.get("last_delivery_outcome"), "suppressed")
            self.assertEqual(updated.get("last_delivery_reason"), "telegram:nta")
            self.assertEqual(updated.get("last_generated_text"), "{NTA}")
            self.assertEqual(updated.get("last_delivery", {}).get("channels", {}).get("telegram", {}).get("reason"), "nta")

    def test_update_after_success_tracks_heartbeat_quiet_streak(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-heartbeat")
            task["metadata"] = {"name": "Heartbeat", "heartbeat_quiet_streak": 2}
            storage.update_task(task["user_id"], task["id"], {"metadata": task["metadata"]})
            task = storage.get_task(task["user_id"], task["id"])
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 30, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-heartbeat-1",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "telegram:nta",
                        "generated_text": "{NTA}",
                    },
                },
            )

            suppressed = storage.get_task("user-1", "task-heartbeat")
            self.assertEqual(
                suppressed.get("metadata", {}).get("heartbeat_quiet_streak"),
                3,
            )

            engine._update_after_success(
                suppressed,
                now,
                {
                    "conversation_id": "conv-heartbeat-2",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "heartbeat_keepalive",
                        "generated_text": "Quick pulse",
                    },
                },
            )

            sent = storage.get_task("user-1", "task-heartbeat")
            self.assertEqual(sent.get("metadata", {}).get("heartbeat_quiet_streak"), 0)
            self.assertEqual(sent.get("metadata", {}).get("heartbeat_last_pulse_at"), "2026-02-13T19:30:00Z")

    def test_update_after_success_tracks_heartbeat_quiet_streak_on_empty_suppression(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-heartbeat-empty")
            task["metadata"] = {"name": "Heartbeat", "heartbeat_quiet_streak": 1}
            storage.update_task(task["user_id"], task["id"], {"metadata": task["metadata"]})
            task = storage.get_task(task["user_id"], task["id"])
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 30, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-heartbeat-empty",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "telegram:empty",
                        "generated_text": None,
                    },
                },
            )

            suppressed = storage.get_task("user-1", "task-heartbeat-empty")
            self.assertEqual(
                suppressed.get("metadata", {}).get("heartbeat_quiet_streak"),
                2,
            )

    def test_update_after_failure_records_failed_delivery_metadata(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-fail")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_failure(task, now, "telegram:timeout")

            updated = storage.get_task("user-1", "task-fail")
            self.assertEqual(updated.get("last_status"), "error")
            self.assertEqual(updated.get("last_error"), "telegram:timeout")
            self.assertEqual(updated.get("last_delivery_outcome"), "failed")
            self.assertEqual(updated.get("last_delivery_reason"), "telegram:timeout")
            self.assertIsNone(updated.get("last_generated_text"))
            self.assertEqual(updated.get("last_delivery", {}).get("outcome"), "failed")

    def test_update_after_success_records_fallback_delivery_as_degraded_outcome(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-fallback")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-fallback",
                    "delivery": {
                        "outcome": "fallback_delivered",
                        "reason": "telegram:insight_fallback",
                        "generated_text": "Best-effort fallback summary",
                        "channels": {
                            "telegram": {
                                "outcome": "fallback_delivered",
                                "reason": "insight_fallback",
                                "fallback_delivered": True,
                            },
                        },
                    },
                },
            )

            updated = storage.get_task("user-1", "task-fallback")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("last_delivery_outcome"), "fallback_delivered")
            self.assertEqual(updated.get("last_delivery_reason"), "telegram:insight_fallback")
            self.assertEqual(updated.get("last_generated_text"), "Best-effort fallback summary")
            self.assertEqual(
                updated.get("last_delivery", {}).get("degradation", {}).get("type"),
                "deferred_fallback",
            )

    def test_update_after_success_records_suppressed_deferred_fallback_as_degraded(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-suppressed-fallback")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-suppressed-fallback",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "telegram:empty_deferred_response",
                        "generated_text": "{NTA}",
                        "channels": {
                            "telegram": {
                                "outcome": "suppressed",
                                "reason": "empty_deferred_response",
                            },
                        },
                    },
                },
            )

            updated = storage.get_task("user-1", "task-suppressed-fallback")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("last_delivery_outcome"), "suppressed")
            self.assertEqual(updated.get("last_delivery_reason"), "telegram:empty_deferred_response")
            self.assertEqual(
                updated.get("last_delivery", {}).get("degradation", {}).get("reason"),
                "telegram:empty_deferred_response",
            )

    def test_update_after_success_reads_deferred_fallback_from_channel_detail(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-channel-fallback")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-channel-fallback",
                    "delivery": {
                        "outcome": "suppressed",
                        "reason": "suppressed",
                        "generated_text": "{NTA}",
                        "channels": {
                            "telegram": {
                                "outcome": "suppressed",
                                "reason": "empty_deferred_response",
                            },
                        },
                    },
                },
            )

            updated = storage.get_task("user-1", "task-channel-fallback")
            self.assertEqual(updated.get("last_delivery_outcome"), "suppressed")
            self.assertEqual(
                updated.get("last_delivery", {}).get("degradation", {}).get("reason"),
                "telegram:empty_deferred_response",
            )


    def test_update_after_success_with_partial_channel_errors(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-partial")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-partial",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "generated_text": "Good morning!",
                        "channels": {"librechat": {"outcome": "sent", "reason": "delivered"}},
                    },
                    "channel_errors": {"telegram": "Telegram identity not found"},
                },
            )

            updated = storage.get_task("user-1", "task-partial")
            self.assertEqual(updated.get("last_status"), "partial_success")
            self.assertEqual(updated.get("conversation_id"), "conv-partial")
            self.assertIn("channel_errors", updated.get("last_delivery_reason", ""))
            self.assertIn("telegram", updated.get("last_delivery_reason", ""))
            delivery = updated.get("last_delivery", {})
            self.assertIn("channel_errors", delivery)
            self.assertIn("telegram", delivery["channel_errors"])

    def test_update_after_success_without_channel_errors_stays_success(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(storage, "task-clean")
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 19, 0, 0, tzinfo=timezone.utc)

            engine._update_after_success(
                task,
                now,
                {
                    "conversation_id": "conv-clean",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "generated_text": "Hello!",
                    },
                },
            )

            updated = storage.get_task("user-1", "task-clean")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertNotIn("channel_errors", updated.get("last_delivery_reason", ""))

    def test_user_once_misfire_within_window_dispatches_catch_up(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-late-catch-up",
                schedule={"type": "once", "run_at": "2026-02-13T19:00:00", "timezone": "UTC"},
                created_source="user",
                next_run_at="2026-02-13T19:00:00Z",
            )
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
                catch_up_max_late_s=43200,
            )
            now = datetime(2026, 2, 13, 20, 24, 52, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                mock_dispatch.return_value = {
                    "conversation_id": "conv-late",
                    "delivery": {
                        "outcome": "sent",
                        "reason": "delivered",
                        "generated_text": "Meditate now.",
                    },
                }

                engine._process_task(task, now)

            mock_dispatch.assert_called_once()
            dispatched_task = mock_dispatch.call_args.args[0]
            late_delivery = dispatched_task.get("metadata", {}).get(SCHEDULER_MISFIRE_KEY)
            self.assertEqual(late_delivery.get("mode"), "catch_up")
            self.assertEqual(late_delivery.get("due_at"), "2026-02-13T19:00:00Z")
            self.assertEqual(late_delivery.get("late_seconds"), 5092)
            self.assertEqual(late_delivery.get("late_minutes"), 85)

            updated = storage.get_task("user-1", "task-late-catch-up")
            self.assertEqual(updated.get("last_status"), "success")
            self.assertEqual(updated.get("last_delivery_outcome"), "sent")
            self.assertEqual(updated.get("last_delivery_reason"), "delivered_late")
            self.assertEqual(updated.get("active"), 0)
            self.assertIsNone(updated.get("next_run_at"))
            self.assertEqual(updated.get("last_delivery", {}).get("late_delivery", {}).get("late_seconds"), 5092)

    def test_user_once_misfire_beyond_window_marks_missed_with_ledger(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-too-late",
                schedule={"type": "once", "run_at": "2026-02-13T07:30:00", "timezone": "UTC"},
                created_source="user",
                next_run_at="2026-02-13T07:30:00Z",
            )
            engine = SchedulerEngine(
                storage,
                poll_interval_s=30,
                misfire_grace_s=900,
                retry_delay_s=300,
                catch_up_max_late_s=3600,
            )
            now = datetime(2026, 2, 13, 9, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                engine._process_task(task, now)

            mock_dispatch.assert_not_called()
            updated = storage.get_task("user-1", "task-too-late")
            self.assertEqual(updated.get("last_status"), "missed")
            self.assertEqual(updated.get("last_delivery_outcome"), "missed")
            self.assertEqual(updated.get("last_delivery_reason"), "catch_up_window_exceeded")
            self.assertEqual(updated.get("last_delivery_at"), "2026-02-13T09:00:00Z")
            self.assertEqual(updated.get("active"), 0)
            self.assertIsNone(updated.get("next_run_at"))
            delivery = updated.get("last_delivery", {})
            self.assertEqual(delivery.get("outcome"), "missed")
            self.assertEqual(delivery.get("due_at"), "2026-02-13T07:30:00Z")
            self.assertEqual(delivery.get("late_seconds"), 5400)
            self.assertEqual(delivery.get("policy", {}).get("mode"), "catch_up")

    def test_recurring_misfire_uses_strict_missed_ledger_without_catch_up(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-recurring-late",
                schedule={"type": "daily", "time": "19:00", "timezone": "UTC"},
                created_source="agent",
                next_run_at="2026-02-13T19:00:00Z",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 20, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                engine._process_task(task, now)

            mock_dispatch.assert_not_called()
            updated = storage.get_task("user-1", "task-recurring-late")
            self.assertEqual(updated.get("last_status"), "missed")
            self.assertEqual(updated.get("last_delivery_outcome"), "missed")
            self.assertEqual(updated.get("last_delivery_reason"), "misfire_grace_exceeded")
            self.assertEqual(updated.get("active"), 1)
            self.assertEqual(updated.get("next_run_at"), "2026-02-14T19:00:00Z")
            self.assertEqual(updated.get("last_delivery", {}).get("policy", {}).get("mode"), "strict")

    def test_metadata_strict_policy_overrides_user_once_catch_up_default(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            storage = ScheduleStorage(StorageConfig(db_path=str(Path(tmpdir) / "schedules.db")))
            task = _seed_task(
                storage,
                "task-user-strict",
                schedule={"type": "once", "run_at": "2026-02-13T19:00:00", "timezone": "UTC"},
                created_source="user",
                metadata={"misfire_policy": {"mode": "strict"}},
                next_run_at="2026-02-13T19:00:00Z",
            )
            engine = SchedulerEngine(storage, poll_interval_s=30, misfire_grace_s=900, retry_delay_s=300)
            now = datetime(2026, 2, 13, 20, 0, 0, tzinfo=timezone.utc)

            with patch("scheduling_cortex.scheduler.dispatch_task") as mock_dispatch:
                engine._process_task(task, now)

            mock_dispatch.assert_not_called()
            updated = storage.get_task("user-1", "task-user-strict")
            self.assertEqual(updated.get("last_status"), "missed")
            self.assertEqual(updated.get("last_delivery_reason"), "misfire_grace_exceeded")
            self.assertEqual(updated.get("last_delivery", {}).get("policy", {}).get("mode"), "strict")


if __name__ == "__main__":
    unittest.main()
