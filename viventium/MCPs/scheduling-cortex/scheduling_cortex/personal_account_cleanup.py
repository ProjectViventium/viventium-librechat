from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
import struct
from datetime import datetime
from typing import Any, Mapping, Sequence

from .storage import ScheduleStorage


_HASH = re.compile(r"^[a-f0-9]{64}$")
_PREFIXED_HASH = re.compile(r"^sha256:[a-f0-9]{64}$")
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$")
_STATE_HASH_PREFIX = "viventium.cleanup.state.v1|"
_MAX_SAFE_INTEGER = (1 << 53) - 1


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _safe_equal(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode("utf-8"), right.encode("utf-8"))


def _encode_cleanup_state(value: Any) -> str:
    if value is None:
        return "n;"
    if isinstance(value, bool):
        return "b1;" if value else "b0;"
    if isinstance(value, int):
        if -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER:
            return f"i{value};"
        try:
            value = float(value)
        except OverflowError as exc:
            raise ValueError("cleanup_state_number_invalid") from exc
    if isinstance(value, float):
        if value != value or value in {float("inf"), float("-inf")}:
            return "n;"
        if value.is_integer() and -_MAX_SAFE_INTEGER <= value <= _MAX_SAFE_INTEGER:
            return f"i{int(value)};"
        return f"f{struct.pack('>d', value).hex()};"
    if isinstance(value, str):
        payload = value.encode("utf-8")
        return f"s{len(payload)}:{payload.hex()};"
    if isinstance(value, list):
        return f"a{len(value)}[" + "".join(_encode_cleanup_state(item) for item in value) + "]"
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ValueError("cleanup_state_object_key_invalid")
        keys = sorted(value, key=lambda key: key.encode("utf-8"))
        return (
            f"o{len(keys)}{{"
            + "".join(_encode_cleanup_state(key) + _encode_cleanup_state(value[key]) for key in keys)
            + "}"
        )
    raise ValueError("cleanup_state_value_invalid")


def _require_safe_id(value: Any, label: str) -> str:
    normalized = str(value or "")
    if not _SAFE_ID.fullmatch(normalized) or normalized in {"all", "*", ".", ".."}:
        raise ValueError(f"{label}_invalid")
    return normalized


def _require_hash(value: Any, label: str) -> str:
    normalized = str(value or "")
    if not _HASH.fullmatch(normalized):
        raise ValueError(f"{label}_invalid")
    return normalized


def _require_prefixed_hash(value: Any, label: str) -> str:
    normalized = str(value or "")
    if not _PREFIXED_HASH.fullmatch(normalized):
        raise ValueError(f"{label}_invalid")
    return normalized


def _require_utc_timestamp(value: Any, label: str) -> str:
    normalized = str(value or "")
    if not normalized.endswith("Z"):
        raise ValueError(f"{label}_invalid")
    try:
        parsed = datetime.fromisoformat(normalized[:-1] + "+00:00")
    except ValueError as exc:
        raise ValueError(f"{label}_invalid") from exc
    if parsed.utcoffset() is None or parsed.utcoffset().total_seconds() != 0:
        raise ValueError(f"{label}_invalid")
    return normalized


def owner_scope_hash(owner_id: str) -> str:
    owner = _require_safe_id(owner_id, "cleanup_owner_id")
    return f"sha256:{_sha256(owner)}"


def schedule_state_sha256(source: Mapping[str, Any]) -> str:
    state = {
        "kind": source.get("kind"),
        "ownerId": source.get("ownerId"),
        "payload": source.get("payload"),
        "resourceId": source.get("resourceId"),
        "revision": source.get("revision"),
        "updatedAt": source.get("updatedAt"),
    }
    return _sha256(_STATE_HASH_PREFIX + _encode_cleanup_state(state))


def _resource_hash(resource_id: str) -> str:
    return _sha256(resource_id)


def _operation_hash(operation_id: str) -> str:
    return _sha256(operation_id)


class ScheduleCleanupRepository:
    """Exact, owner-bound schedule tombstones for reviewed cleanup operations."""

    def __init__(self, storage: ScheduleStorage) -> None:
        self._storage = storage
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        with self._storage._connect() as connection:
            columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(scheduled_tasks)").fetchall()
            }
            if "cleanup_revision" not in columns:
                connection.execute(
                    "ALTER TABLE scheduled_tasks "
                    "ADD COLUMN cleanup_revision INTEGER NOT NULL DEFAULT 0"
                )
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS scheduled_task_cleanup_tombstones (
                  owner_scope_hash TEXT NOT NULL,
                  resource_id_hash TEXT NOT NULL,
                  operation_id_hash TEXT NOT NULL,
                  plan_sha256 TEXT NOT NULL,
                  backup_receipt_sha256 TEXT NOT NULL,
                  review_set_sha256 TEXT NOT NULL,
                  review_binding_sha256 TEXT NOT NULL,
                  state_sha256 TEXT NOT NULL,
                  preimage_sha256 TEXT NOT NULL,
                  run_nonce_hash TEXT NOT NULL,
                  prior_revision INTEGER NOT NULL,
                  revision INTEGER NOT NULL,
                  expected_updated_at TEXT NOT NULL,
                  tombstoned_at TEXT NOT NULL,
                  receipt_sha256 TEXT NOT NULL,
                  PRIMARY KEY (owner_scope_hash, resource_id_hash)
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX IF NOT EXISTS idx_schedule_cleanup_operation
                ON scheduled_task_cleanup_tombstones(
                  owner_scope_hash,
                  operation_id_hash
                )
                """
            )
        self._storage._sync_to_mirror()

    def _source_from_row(self, row: sqlite3.Row) -> dict[str, Any]:
        task = self._storage._row_to_task(row)
        if task is None:
            raise ValueError("cleanup_schedule_target_not_found")
        payload = dict(task)
        revision = int(payload.pop("cleanup_revision", 0))
        return {
            "kind": "schedule",
            "ownerId": str(payload.get("user_id") or ""),
            "resourceId": str(payload.get("id") or ""),
            "revision": revision,
            "updatedAt": str(payload.get("updated_at") or ""),
            "payload": payload,
        }

    def read_active_source(self, owner_id: str, resource_id: str) -> dict[str, Any]:
        owner = _require_safe_id(owner_id, "cleanup_owner_id")
        resource = _require_safe_id(resource_id, "cleanup_resource_id")
        with self._storage._connect() as connection:
            row = connection.execute(
                "SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?",
                (resource, owner),
            ).fetchone()
        if row is None:
            raise ValueError("cleanup_schedule_target_not_found")
        return self._source_from_row(row)

    @staticmethod
    def _validate_request(request: Mapping[str, Any]) -> dict[str, Any]:
        operation_id = _require_safe_id(request.get("operationId"), "cleanup_operation_id")
        owner_id = _require_safe_id(request.get("ownerId"), "cleanup_owner_id")
        supplied_owner_hash = _require_prefixed_hash(
            request.get("ownerScopeHash"), "cleanup_owner_scope_hash"
        )
        if not _safe_equal(supplied_owner_hash, owner_scope_hash(owner_id)):
            raise ValueError("cleanup_owner_scope_mismatch")

        target_value = request.get("target")
        if not isinstance(target_value, Mapping):
            raise ValueError("cleanup_schedule_target_invalid")
        if target_value.get("kind") != "schedule":
            raise ValueError("cleanup_schedule_target_kind_mismatch")
        resource_id = _require_safe_id(
            target_value.get("resourceId"), "cleanup_resource_id"
        )
        revision = target_value.get("expectedRevision")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
            raise ValueError("cleanup_schedule_revision_invalid")
        expected_updated_at = _require_utc_timestamp(
            target_value.get("expectedUpdatedAt"), "cleanup_schedule_updated_at"
        )
        state_sha256 = _require_hash(
            target_value.get("stateSha256"), "cleanup_schedule_state_sha256"
        )
        preimage_sha256 = _require_hash(
            target_value.get("preimageSha256"), "cleanup_schedule_preimage_sha256"
        )
        if not _safe_equal(state_sha256, preimage_sha256):
            raise ValueError("cleanup_schedule_preimage_state_mismatch")

        return {
            "operation_id": operation_id,
            "owner_id": owner_id,
            "owner_scope_hash": supplied_owner_hash,
            "resource_id": resource_id,
            "resource_id_hash": _resource_hash(resource_id),
            "operation_id_hash": _operation_hash(operation_id),
            "plan_sha256": _require_hash(
                request.get("planSha256"), "cleanup_schedule_plan_sha256"
            ),
            "backup_receipt_sha256": _require_hash(
                request.get("backupReceiptSha256"),
                "cleanup_schedule_backup_receipt_sha256",
            ),
            "review_set_sha256": _require_hash(
                request.get("reviewSetSha256"), "cleanup_schedule_review_set_sha256"
            ),
            "review_binding_sha256": _require_hash(
                target_value.get("reviewBindingSha256"),
                "cleanup_schedule_review_binding_sha256",
            ),
            "state_sha256": state_sha256,
            "preimage_sha256": preimage_sha256,
            "run_nonce_hash": _require_prefixed_hash(
                target_value.get("runNonceHash"), "cleanup_schedule_nonce_hash"
            ),
            "expected_revision": revision,
            "expected_updated_at": expected_updated_at,
            "tombstoned_at": _require_utc_timestamp(
                request.get("tombstonedAt"), "cleanup_schedule_tombstoned_at"
            ),
        }

    @staticmethod
    def _binding_matches(row: sqlite3.Row, binding: Mapping[str, Any]) -> bool:
        exact_fields = (
            "owner_scope_hash",
            "resource_id_hash",
            "operation_id_hash",
            "plan_sha256",
            "backup_receipt_sha256",
            "review_set_sha256",
            "review_binding_sha256",
            "state_sha256",
            "preimage_sha256",
            "run_nonce_hash",
            "expected_updated_at",
            "tombstoned_at",
        )
        return all(_safe_equal(str(row[field]), str(binding[field])) for field in exact_fields) and int(
            row["prior_revision"]
        ) == int(binding["expected_revision"])

    @staticmethod
    def _result(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "applied": True,
            "revision": int(row["revision"]),
            "tombstonedAt": str(row["tombstoned_at"]),
            "receiptSha256": str(row["receipt_sha256"]),
        }

    def tombstone_exact(self, request: Mapping[str, Any]) -> dict[str, Any]:
        binding = self._validate_request(request)
        with self._storage._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute(
                """
                SELECT * FROM scheduled_task_cleanup_tombstones
                WHERE owner_scope_hash = ? AND resource_id_hash = ?
                """,
                (binding["owner_scope_hash"], binding["resource_id_hash"]),
            ).fetchone()
            if existing is not None:
                if not self._binding_matches(existing, binding):
                    raise ValueError("cleanup_schedule_tombstone_conflict")
                return self._result(existing)

            row = connection.execute(
                "SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?",
                (binding["resource_id"], binding["owner_id"]),
            ).fetchone()
            if row is None:
                raise ValueError("cleanup_schedule_target_not_found")
            source = self._source_from_row(row)
            current_digest = schedule_state_sha256(source)
            if (
                source["revision"] != binding["expected_revision"]
                or source["updatedAt"] != binding["expected_updated_at"]
                or not _safe_equal(current_digest, binding["state_sha256"])
            ):
                raise ValueError("cleanup_schedule_state_conflict")
            if bool(source["payload"].get("active")):
                raise ValueError("cleanup_schedule_still_active")

            receipt_payload = {
                "backupReceiptSha256": binding["backup_receipt_sha256"],
                "operationIdHash": binding["operation_id_hash"],
                "ownerScopeHash": binding["owner_scope_hash"],
                "planSha256": binding["plan_sha256"],
                "preimageSha256": binding["preimage_sha256"],
                "resourceIdHash": binding["resource_id_hash"],
                "reviewBindingSha256": binding["review_binding_sha256"],
                "reviewSetSha256": binding["review_set_sha256"],
                "revision": binding["expected_revision"] + 1,
                "runNonceHash": binding["run_nonce_hash"],
                "stateSha256": binding["state_sha256"],
                "tombstonedAt": binding["tombstoned_at"],
            }
            receipt_sha256 = _sha256(_canonical_json(receipt_payload))
            connection.execute(
                """
                INSERT INTO scheduled_task_cleanup_tombstones (
                  owner_scope_hash, resource_id_hash, operation_id_hash,
                  plan_sha256, backup_receipt_sha256, review_set_sha256,
                  review_binding_sha256, state_sha256, preimage_sha256,
                  run_nonce_hash, prior_revision, revision,
                  expected_updated_at, tombstoned_at, receipt_sha256
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    binding["owner_scope_hash"],
                    binding["resource_id_hash"],
                    binding["operation_id_hash"],
                    binding["plan_sha256"],
                    binding["backup_receipt_sha256"],
                    binding["review_set_sha256"],
                    binding["review_binding_sha256"],
                    binding["state_sha256"],
                    binding["preimage_sha256"],
                    binding["run_nonce_hash"],
                    binding["expected_revision"],
                    binding["expected_revision"] + 1,
                    binding["expected_updated_at"],
                    binding["tombstoned_at"],
                    receipt_sha256,
                ),
            )
            deleted = connection.execute(
                """
                DELETE FROM scheduled_tasks
                WHERE id = ? AND user_id = ?
                  AND cleanup_revision = ? AND updated_at = ?
                """,
                (
                    binding["resource_id"],
                    binding["owner_id"],
                    binding["expected_revision"],
                    binding["expected_updated_at"],
                ),
            )
            if deleted.rowcount != 1:
                raise ValueError("cleanup_schedule_state_conflict")
            stored = connection.execute(
                """
                SELECT * FROM scheduled_task_cleanup_tombstones
                WHERE owner_scope_hash = ? AND resource_id_hash = ?
                """,
                (binding["owner_scope_hash"], binding["resource_id_hash"]),
            ).fetchone()
        self._storage._sync_to_mirror()
        if stored is None:
            raise ValueError("cleanup_schedule_tombstone_unverified")
        return self._result(stored)

    def verify_operation(
        self,
        *,
        owner_id: str,
        operation_id: str,
        resource_ids: Sequence[str],
        nonce_hash: str,
    ) -> dict[str, int]:
        owner = _require_safe_id(owner_id, "cleanup_owner_id")
        operation = _require_safe_id(operation_id, "cleanup_operation_id")
        nonce = _require_prefixed_hash(nonce_hash, "cleanup_schedule_nonce_hash")
        resources = [_require_safe_id(value, "cleanup_resource_id") for value in resource_ids]
        if len(resources) != len(set(resources)):
            raise ValueError("cleanup_schedule_targets_invalid")
        expected_hashes = sorted(_resource_hash(value) for value in resources)
        owner_hash = owner_scope_hash(owner)
        with self._storage._connect() as connection:
            rows = connection.execute(
                """
                SELECT resource_id_hash, run_nonce_hash
                FROM scheduled_task_cleanup_tombstones
                WHERE owner_scope_hash = ? AND operation_id_hash = ?
                ORDER BY resource_id_hash
                """,
                (owner_hash, _operation_hash(operation)),
            ).fetchall()
            found_hashes = [str(row["resource_id_hash"]) for row in rows]
            source_count = sum(
                int(
                    connection.execute(
                        "SELECT COUNT(*) FROM scheduled_tasks WHERE id = ? AND user_id = ?",
                        (resource, owner),
                    ).fetchone()[0]
                )
                for resource in resources
            )
        if (
            found_hashes != expected_hashes
            or source_count != 0
            or any(not _safe_equal(str(row["run_nonce_hash"]), nonce) for row in rows)
        ):
            raise ValueError("cleanup_schedule_residue")
        return {"verifiedCount": len(rows)}
