# === VIVENTIUM START ===
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# === VIVENTIUM END ===

import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.scheduler import SchedulerEngine
from scheduling_cortex.storage import ScheduleStorage, StorageConfig


def _seed_task(storage: ScheduleStorage, task_id: str = "task-1") -> dict:
    task = {
        "id": task_id,
        "user_id": "user-1",
        "agent_id": "agent-1",
        "prompt": "Daily reflection",
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


if __name__ == "__main__":
    unittest.main()
