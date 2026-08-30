from __future__ import annotations

import json
import os
import re
import sys
from typing import Any

from .personal_account_cleanup import ScheduleCleanupRepository
from .storage import ScheduleStorage, StorageConfig, default_scheduling_db_path


_MAX_INPUT_BYTES = 2_000_000
_SAFE_ERROR = re.compile(r"^cleanup_[a-z0-9_]{1,120}$")


def _read_request() -> dict[str, Any]:
    payload = sys.stdin.buffer.read(_MAX_INPUT_BYTES + 1)
    if not payload or len(payload) > _MAX_INPUT_BYTES:
        raise ValueError("cleanup_schedule_bridge_input_invalid")
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("cleanup_schedule_bridge_input_invalid") from exc
    if not isinstance(value, dict) or set(value) != {"action", "request"}:
        raise ValueError("cleanup_schedule_bridge_input_invalid")
    if not isinstance(value.get("request"), dict):
        raise ValueError("cleanup_schedule_bridge_input_invalid")
    return value


def _storage() -> ScheduleStorage:
    return ScheduleStorage(
        StorageConfig(
            db_path=os.getenv("SCHEDULING_DB_PATH") or default_scheduling_db_path(),
            mirror_db_path=os.getenv("SCHEDULING_DB_MIRROR_PATH") or None,
        )
    )


def execute(value: dict[str, Any]) -> dict[str, Any]:
    repository = ScheduleCleanupRepository(_storage())
    request = value["request"]
    if value["action"] == "tombstone_exact":
        return repository.tombstone_exact(request)
    if value["action"] == "verify_operation":
        targets = request.get("targets")
        if not isinstance(targets, list):
            raise ValueError("cleanup_schedule_targets_invalid")
        resource_ids = []
        for target in targets:
            if not isinstance(target, dict) or target.get("kind") != "schedule":
                raise ValueError("cleanup_schedule_targets_invalid")
            resource_ids.append(str(target.get("resourceId") or ""))
        return repository.verify_operation(
            owner_id=str(request.get("ownerId") or ""),
            operation_id=str(request.get("operationId") or ""),
            resource_ids=resource_ids,
            nonce_hash=str(request.get("nonceHash") or ""),
        )
    raise ValueError("cleanup_schedule_bridge_action_invalid")


def main() -> int:
    try:
        result = execute(_read_request())
    except ValueError as exc:
        code = str(exc)
        safe_code = code if _SAFE_ERROR.fullmatch(code) else "cleanup_schedule_bridge_rejected"
        print(json.dumps({"status": "error", "code": safe_code}, separators=(",", ":")))
        return 2
    except Exception:
        print(
            json.dumps(
                {"status": "error", "code": "cleanup_schedule_bridge_unavailable"},
                separators=(",", ":"),
            )
        )
        return 3
    print(json.dumps({"status": "ok", "result": result}, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
