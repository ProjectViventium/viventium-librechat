from __future__ import annotations

import json
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

from scheduling_cortex.personal_account_cleanup import (
    ScheduleCleanupRepository,
    owner_scope_hash,
    schedule_state_sha256,
)
from scheduling_cortex.storage import ScheduleStorage, StorageConfig


OWNER = "owner-cleanup-1"
OTHER_OWNER = "owner-cleanup-2"
OPERATION = "cleanup-operation-1"
HASH_A = "a" * 64
HASH_B = "b" * 64
AT = "2026-08-25T16:00:00Z"


def task(task_id: str, owner_id: str, prompt: str) -> dict:
    return {
        "id": task_id,
        "user_id": owner_id,
        "agent_id": "agent-1",
        "prompt": prompt,
        "schedule": {"type": "daily", "time": "09:00", "timezone": "UTC"},
        "channel": "telegram",
        "conversation_policy": "new",
        "conversation_id": None,
        "last_conversation_id": None,
        "active": 0,
        "created_by": "agent:agent-1",
        "created_source": "agent",
        "created_at": AT,
        "updated_at": AT,
        "updated_by": "agent:agent-1",
        "updated_source": "agent",
        "last_run_at": None,
        "next_run_at": "2026-08-26T09:00:00Z",
        "last_status": None,
        "last_error": None,
        "metadata": {"qaRun": True, "private": "synthetic marker"},
    }


def request(source: dict, **overrides: object) -> dict:
    digest = schedule_state_sha256(source)
    value = {
        "operationId": OPERATION,
        "ownerId": OWNER,
        "ownerScopeHash": owner_scope_hash(OWNER),
        "planSha256": HASH_A,
        "backupReceiptSha256": HASH_B,
        "reviewSetSha256": HASH_A,
        "target": {
            "kind": "schedule",
            "resourceId": source["resourceId"],
            "expectedRevision": source["revision"],
            "expectedUpdatedAt": source["updatedAt"],
            "stateSha256": digest,
            "preimageSha256": digest,
            "reviewBindingSha256": HASH_A,
            "runNonceHash": "sha256:" + HASH_B,
        },
        "tombstonedAt": "2026-08-25T16:05:00Z",
    }
    value.update(overrides)
    return value


def test_schedule_state_hash_matches_the_shared_unicode_and_number_contract() -> None:
    source = {
        "kind": "schedule",
        "ownerId": "owner-1",
        "resourceId": "schedule-1",
        "revision": 3,
        "updatedAt": "2026-08-25T15:00:00Z",
        "payload": {
            "text": "café 🐝",
            "scores": [1, 1.5, 0.000001, 9007199254740992],
            "ok": True,
            "none": None,
        },
    }

    assert schedule_state_sha256(source) == (
        "f176486c11ffcead81783148cdeb61933067e0bb02e2a45d5f905143997dd7f3"
    )


@pytest.fixture()
def cleanup(tmp_path: Path) -> tuple[ScheduleStorage, ScheduleCleanupRepository, Path]:
    path = tmp_path / "schedules.db"
    storage = ScheduleStorage(StorageConfig(db_path=str(path)))
    return storage, ScheduleCleanupRepository(storage), path


def test_exact_revision_safe_tombstone_preserves_other_owner_and_scrubs_content(cleanup) -> None:
    storage, repository, path = cleanup
    storage.create_task(task("schedule-cleanup-1", OWNER, "private synthetic reminder"))
    storage.create_task(task("schedule-preserved-1", OTHER_OWNER, "genuine reminder"))
    source = repository.read_active_source(OWNER, "schedule-cleanup-1")

    result = repository.tombstone_exact(request(source))

    assert result == {
        "applied": True,
        "revision": 1,
        "tombstonedAt": "2026-08-25T16:05:00Z",
        "receiptSha256": result["receiptSha256"],
    }
    assert len(result["receiptSha256"]) == 64
    assert storage.get_task(OWNER, "schedule-cleanup-1") is None
    assert storage.get_task(OTHER_OWNER, "schedule-preserved-1")["prompt"] == "genuine reminder"
    with sqlite3.connect(path) as connection:
        tombstone = connection.execute(
            "SELECT * FROM scheduled_task_cleanup_tombstones"
        ).fetchone()
        serialized = json.dumps(tombstone)
        assert connection.execute(
            "SELECT COUNT(*) FROM scheduled_tasks WHERE user_id = ?", (OWNER,)
        ).fetchone()[0] == 0
    assert "private synthetic reminder" not in serialized
    assert "synthetic marker" not in serialized
    assert OWNER not in serialized


def test_stale_state_or_revision_cannot_remove_a_newer_schedule(cleanup) -> None:
    storage, repository, _path = cleanup
    storage.create_task(task("schedule-cleanup-1", OWNER, "reviewed synthetic reminder"))
    source = repository.read_active_source(OWNER, "schedule-cleanup-1")
    storage.update_task(
        OWNER,
        "schedule-cleanup-1",
        {"prompt": "newer genuine edit", "updated_at": "2026-08-25T16:01:00Z"},
    )

    with pytest.raises(ValueError, match="cleanup_schedule_state_conflict"):
        repository.tombstone_exact(request(source))
    assert storage.get_task(OWNER, "schedule-cleanup-1")["prompt"] == "newer genuine edit"


def test_active_schedule_fails_closed_before_any_tombstone(cleanup) -> None:
    storage, repository, _path = cleanup
    active = task("schedule-cleanup-1", OWNER, "active synthetic reminder")
    active["active"] = 1
    storage.create_task(active)
    source = repository.read_active_source(OWNER, "schedule-cleanup-1")

    with pytest.raises(ValueError, match="cleanup_schedule_still_active"):
        repository.tombstone_exact(request(source))
    assert storage.get_task(OWNER, "schedule-cleanup-1")["active"] == 1


def test_exact_replay_is_idempotent_but_different_binding_fails_closed(cleanup) -> None:
    storage, repository, _path = cleanup
    storage.create_task(task("schedule-cleanup-1", OWNER, "synthetic reminder"))
    source = repository.read_active_source(OWNER, "schedule-cleanup-1")
    payload = request(source)
    first = repository.tombstone_exact(payload)
    replay = repository.tombstone_exact(payload)

    assert replay == first
    with pytest.raises(ValueError, match="cleanup_schedule_tombstone_conflict"):
        repository.tombstone_exact({**payload, "operationId": "different-operation"})


def test_delayed_verification_requires_exact_owner_operation_nonce_and_targets(cleanup) -> None:
    storage, repository, _path = cleanup
    storage.create_task(task("schedule-cleanup-1", OWNER, "synthetic reminder"))
    source = repository.read_active_source(OWNER, "schedule-cleanup-1")
    repository.tombstone_exact(request(source))

    assert repository.verify_operation(
        owner_id=OWNER,
        operation_id=OPERATION,
        resource_ids=["schedule-cleanup-1"],
        nonce_hash="sha256:" + HASH_B,
    ) == {"verifiedCount": 1}
    with pytest.raises(ValueError, match="cleanup_schedule_residue"):
        repository.verify_operation(
            owner_id=OWNER,
            operation_id=OPERATION,
            resource_ids=["schedule-cleanup-1"],
            nonce_hash="sha256:" + HASH_A,
        )


def test_delayed_verification_accepts_an_exact_empty_schedule_scope(cleanup) -> None:
    _storage, repository, _path = cleanup

    assert repository.verify_operation(
        owner_id=OWNER,
        operation_id=OPERATION,
        resource_ids=[],
        nonce_hash="sha256:" + HASH_B,
    ) == {"verifiedCount": 0}


def test_source_uses_one_exact_delete_not_a_broad_database_delete() -> None:
    source = (
        Path(__file__).resolve().parents[1]
        / "scheduling_cortex"
        / "personal_account_cleanup.py"
    ).read_text(encoding="utf-8")
    normalized = " ".join(source.split())

    assert "DELETE FROM scheduled_tasks WHERE id = ? AND user_id = ?" in normalized
    assert "cleanup_revision = ? AND updated_at = ?" in normalized
    assert "DELETE FROM scheduled_tasks WHERE user_id = ?" not in normalized
    assert "DROP TABLE" not in source.upper()


def test_process_bridge_uses_stdin_and_exact_owner_bound_schedule(tmp_path: Path) -> None:
    path = tmp_path / "schedules.db"
    storage = ScheduleStorage(StorageConfig(db_path=str(path)))
    repository = ScheduleCleanupRepository(storage)
    storage.create_task(task("schedule-cleanup-bridge-1", OWNER, "synthetic bridge"))
    source = repository.read_active_source(OWNER, "schedule-cleanup-bridge-1")
    payload = request(source, tombstonedAt="2026-08-25T16:05:01Z")
    environment = {
        **os.environ,
        "SCHEDULING_DB_PATH": str(path),
        "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
    }

    completed = subprocess.run(
        [sys.executable, "-m", "scheduling_cortex.personal_account_cleanup_bridge"],
        input=json.dumps({"action": "tombstone_exact", "request": payload}),
        text=True,
        capture_output=True,
        env=environment,
        check=False,
    )

    assert completed.returncode == 0
    result = json.loads(completed.stdout)
    assert result["status"] == "ok"
    assert result["result"]["applied"] is True
    with pytest.raises(ValueError, match="cleanup_schedule_target_not_found"):
        repository.read_active_source(OWNER, "schedule-cleanup-bridge-1")


def test_process_bridge_rejects_invalid_action_without_echoing_input(tmp_path: Path) -> None:
    completed = subprocess.run(
        [sys.executable, "-m", "scheduling_cortex.personal_account_cleanup_bridge"],
        input=json.dumps(
            {"action": "broad_delete", "request": {"privateText": "must-not-return"}}
        ),
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "SCHEDULING_DB_PATH": str(tmp_path / "schedules.db"),
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
        },
        check=False,
    )

    assert completed.returncode == 2
    assert json.loads(completed.stdout) == {
        "status": "error",
        "code": "cleanup_schedule_bridge_action_invalid",
    }
    assert "must-not-return" not in completed.stdout
    assert completed.stderr == ""
