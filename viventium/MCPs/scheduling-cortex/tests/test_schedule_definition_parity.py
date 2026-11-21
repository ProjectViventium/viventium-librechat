# === VIVENTIUM START ===
# Linked Workbench timing must agree with the clock's durable task after an edit.
# === VIVENTIUM END ===
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.storage import ScheduleStorage, StorageConfig
from test_storage import _build_task


@pytest.fixture
def linked_store(tmp_path):
    store = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    task = _build_task("task-1")
    store.create_task(task)
    for owner, definition_id in (("user-1", "definition-1"), ("other-owner", "foreign-definition")):
        store.create_scheduled_prompt_definition({
            "id": definition_id, "user_id": owner, "task_id": task["id"],
            "title": "Synthetic check-in", "source_prompt_id": None, "template_id": None,
            "prompt_text": task["prompt"], "schedule": task["schedule"], "timezone": "UTC",
            "active": 1, "memory_write_mode": "off", "workspace_alias": "synthetic",
            "my_folder": None, "metadata": {}, "created_at": task["created_at"],
            "updated_at": task["updated_at"],
        })
    return store


def test_task_timing_edit_updates_only_its_owners_linked_definition(linked_store):
    schedule = {"type": "daily", "time": "11:30", "timezone": "America/Toronto"}
    updated_at = "2026-11-14T18:00:00Z"
    linked_store.update_task("user-1", "task-1", {"schedule": schedule, "updated_at": updated_at})

    assert linked_store.get_task("user-1", "task-1")["schedule"] == schedule
    definition = linked_store.get_scheduled_prompt_definition("definition-1")
    assert definition["schedule"] == schedule
    assert definition["timezone"] == schedule["timezone"]
    assert definition["updated_at"] == updated_at
    assert linked_store.get_scheduled_prompt_definition("foreign-definition")["timezone"] == "UTC"


def test_rejected_task_update_does_not_change_linked_timing(linked_store):
    before = linked_store.get_scheduled_prompt_definition("definition-1")
    assert linked_store.update_task("user-1", "task-1", {
        "schedule": {"type": "daily", "time": "11:30", "timezone": "America/Toronto"},
    }, expected_latest_scheduled_run_id="stale-run") is None
    assert linked_store.get_scheduled_prompt_definition("definition-1") == before


def test_timing_edit_rolls_back_if_linked_definition_cannot_be_saved(linked_store):
    before = linked_store.get_task("user-1", "task-1")
    with linked_store._connect() as conn:
        conn.execute("""CREATE TRIGGER reject_timing BEFORE UPDATE OF schedule_json
            ON scheduled_prompt_definitions BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END""")
    with pytest.raises(sqlite3.IntegrityError, match="synthetic write failure"):
        linked_store.update_task("user-1", "task-1", {
            "schedule": {"type": "daily", "time": "11:30", "timezone": "America/Toronto"},
        })
    assert linked_store.get_task("user-1", "task-1") == before


def test_delivery_receipt_update_preserves_timing(linked_store):
    before = linked_store.get_scheduled_prompt_definition("definition-1")
    linked_store.update_task("user-1", "task-1", {"last_status": "success"})
    assert linked_store.get_scheduled_prompt_definition("definition-1") == before
