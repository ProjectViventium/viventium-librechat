from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Union


@dataclass
class StorageConfig:
    db_path: str
    # === VIVENTIUM START ===
    # Feature: Optional mirror path for durable storage on file shares.
    mirror_db_path: Optional[str] = None
    # Read-only observers must never run schema migration, stale-run reconciliation,
    # mirror restore/sync, or directory creation as a side effect of inspection.
    read_only: bool = False
    # === VIVENTIUM END ===


logger = logging.getLogger(__name__)
_LOCAL_PATH_RE = re.compile(r"(?:/Users|/home|/private/var|/var/folders)/[^\s`'\"<>]+")
_URL_RE = re.compile(r"https?:\/\/[^\s`'\"<>)]*", re.IGNORECASE)
_MONGO_URI_RE = re.compile(r"mongodb(?:\+srv)?:\/\/[^\s`'\"<>]+", re.IGNORECASE)
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE)
_MIRROR_LOCKS_GUARD = threading.Lock()
_MIRROR_LOCKS: dict[str, threading.RLock] = {}


def _mirror_lock_for(db_path: Path, mirror_path: Optional[Path]) -> threading.RLock:
    key = f"{db_path.resolve()}\0{mirror_path.resolve() if mirror_path else ''}"
    with _MIRROR_LOCKS_GUARD:
        return _MIRROR_LOCKS.setdefault(key, threading.RLock())


class ScheduleStorage:
    def __init__(self, config: StorageConfig) -> None:
        self._db_path = Path(config.db_path).expanduser()
        self._read_only = bool(config.read_only)
        if self._read_only:
            if not self._db_path.is_file():
                raise FileNotFoundError(f"scheduling database does not exist: {self._db_path}")
        else:
            self._db_path.parent.mkdir(parents=True, exist_ok=True)
        # === VIVENTIUM NOTE ===
        # Feature: Mirror SQLite DB to shared storage without locking issues.
        self._mirror_path = (
            Path(config.mirror_db_path).expanduser()
            if config.mirror_db_path
            else None
        )
        self._mirror_lock = _mirror_lock_for(self._db_path, self._mirror_path)
        if self._mirror_path and not self._read_only:
            self._mirror_path.parent.mkdir(parents=True, exist_ok=True)
            self._restore_from_mirror()
        # === VIVENTIUM NOTE ===
        if not self._read_only:
            self._init_db()
        # === VIVENTIUM NOTE ===
        # Feature: Ensure mirror contains initialized DB.
        if not self._read_only:
            self._sync_to_mirror()
        # === VIVENTIUM NOTE ===

    @property
    def db_path(self) -> str:
        return str(self._db_path)

    def _connect(self) -> sqlite3.Connection:
        target: str | Path = self._db_path
        connect_kwargs: dict[str, Any] = {}
        if self._read_only:
            target = f"{self._db_path.resolve().as_uri()}?mode=ro"
            connect_kwargs["uri"] = True
        conn = sqlite3.connect(
            target,
            timeout=30,
            check_same_thread=False,
            **connect_kwargs,
        )
        conn.row_factory = sqlite3.Row
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS scheduled_tasks (
                  id TEXT PRIMARY KEY,
                  user_id TEXT NOT NULL,
                  agent_id TEXT NOT NULL,
                  prompt TEXT NOT NULL,
                  schedule_json TEXT NOT NULL,
                  channel TEXT NOT NULL,
                  executor TEXT NOT NULL DEFAULT 'viventium_agent',
                  conversation_policy TEXT NOT NULL DEFAULT 'new',
                  conversation_id TEXT,
                  last_conversation_id TEXT,
                  active INTEGER NOT NULL,
                  created_by TEXT NOT NULL,
                  created_source TEXT NOT NULL,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL,
                  updated_by TEXT NOT NULL,
                  updated_source TEXT NOT NULL,
                  last_run_at TEXT,
                  next_run_at TEXT,
                  last_status TEXT,
                  last_error TEXT,
                  last_delivery_outcome TEXT,
                  last_delivery_reason TEXT,
                  last_delivery_at TEXT,
                  last_generated_text TEXT,
                  last_delivery_json TEXT,
                  metadata_json TEXT
                )
                """
            )
            self._ensure_columns(conn)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_schedules_user ON scheduled_tasks(user_id)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_schedules_next ON scheduled_tasks(next_run_at)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_schedules_channel ON scheduled_tasks(channel)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_schedules_active ON scheduled_tasks(active)"
            )

    def _ensure_columns(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute("PRAGMA table_info(scheduled_tasks)").fetchall()
        existing = {row["name"] for row in rows}
        if "conversation_policy" not in existing:
            conn.execute(
                "ALTER TABLE scheduled_tasks ADD COLUMN conversation_policy TEXT NOT NULL DEFAULT 'new'"
            )
        if "conversation_id" not in existing:
            conn.execute("ALTER TABLE scheduled_tasks ADD COLUMN conversation_id TEXT")
        if "last_conversation_id" not in existing:
            conn.execute("ALTER TABLE scheduled_tasks ADD COLUMN last_conversation_id TEXT")
        # === VIVENTIUM NOTE ===
        # Feature: Persist delivery-state visibility for scheduled runs.
        if "last_delivery_outcome" not in existing:
            conn.execute("ALTER TABLE scheduled_tasks ADD COLUMN last_delivery_outcome TEXT")
        if "last_delivery_reason" not in existing:
            conn.execute("ALTER TABLE scheduled_tasks ADD COLUMN last_delivery_reason TEXT")
        if "last_delivery_at" not in existing:
            conn.execute("ALTER TABLE scheduled_tasks ADD COLUMN last_delivery_at TEXT")
        if "last_generated_text" not in existing:
            conn.execute("ALTER TABLE scheduled_tasks ADD COLUMN last_generated_text TEXT")
        if "last_delivery_json" not in existing:
            conn.execute("ALTER TABLE scheduled_tasks ADD COLUMN last_delivery_json TEXT")
        if "executor" not in existing:
            conn.execute(
                "ALTER TABLE scheduled_tasks ADD COLUMN executor TEXT NOT NULL DEFAULT 'viventium_agent'"
            )
        # === VIVENTIUM NOTE ===
        self._ensure_scheduled_prompt_tables(conn)

    def _ensure_scheduled_prompt_tables(self, conn: sqlite3.Connection) -> None:
        # === VIVENTIUM NOTE ===
        # Feature: Private Prompt Workbench scheduled prompt definitions and run history.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scheduled_prompt_definitions (
              id TEXT PRIMARY KEY,
              user_id TEXT NOT NULL,
              task_id TEXT,
              title TEXT NOT NULL,
              source_prompt_id TEXT,
              template_id TEXT,
              prompt_text TEXT NOT NULL,
              schedule_json TEXT NOT NULL,
              timezone TEXT NOT NULL,
              active INTEGER NOT NULL,
              memory_write_mode TEXT NOT NULL DEFAULT 'off',
              workspace_alias TEXT,
              my_folder TEXT,
              metadata_json TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scheduled_prompt_versions (
              id TEXT PRIMARY KEY,
              definition_id TEXT NOT NULL,
              version_number INTEGER NOT NULL,
              prompt_text TEXT NOT NULL,
              rendered_text TEXT NOT NULL,
              rendered_hash TEXT NOT NULL,
              variable_snapshot_json TEXT NOT NULL,
              variable_snapshot_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY(definition_id) REFERENCES scheduled_prompt_definitions(id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scheduled_prompt_runs (
              run_id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL,
              definition_id TEXT,
              user_id TEXT NOT NULL,
              version_id TEXT,
              due_at TEXT,
              started_at TEXT,
              completed_at TEXT,
              status TEXT NOT NULL,
              executor TEXT NOT NULL,
              rendered_hash TEXT,
              variable_snapshot_hash TEXT,
              glasshive_project_id TEXT,
              glasshive_worker_id TEXT,
              glasshive_run_id TEXT,
              result_summary TEXT,
              error_class TEXT,
              private_detail_path TEXT,
              callback_payload_json TEXT,
              trigger_kind TEXT,
              trigger_source TEXT,
              occurrence_key TEXT,
              lease_owner TEXT,
              lease_until TEXT,
              attempt INTEGER NOT NULL DEFAULT 0,
              disposition TEXT,
              execution_snapshot_json TEXT,
              channel_outcomes_json TEXT,
              interaction_ref TEXT,
              claimed_at TEXT,
              claim_expires_at TEXT,
              attempt_count INTEGER NOT NULL DEFAULT 0,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        self._ensure_scheduled_prompt_run_columns(conn)
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scheduled_terminal_callback_results (
              owner_id TEXT NOT NULL,
              work_id TEXT NOT NULL,
              callback_id TEXT NOT NULL,
              result_revision INTEGER NOT NULL,
              result_digest TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              effect_state TEXT NOT NULL CHECK (
                effect_state IN ('pending', 'applying', 'committed')
              ),
              effect_lease_token TEXT NOT NULL DEFAULT '',
              effect_lease_until TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (owner_id, work_id)
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scheduled_terminal_callback_attempts (
              attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
              owner_id TEXT NOT NULL,
              work_id TEXT NOT NULL,
              callback_id TEXT NOT NULL,
              result_revision INTEGER NOT NULL,
              result_digest TEXT NOT NULL,
              status TEXT NOT NULL,
              current_result_revision INTEGER NOT NULL,
              current_result_digest TEXT NOT NULL,
              created_at TEXT NOT NULL
            )
            """
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scheduled_prompt_definitions_user ON scheduled_prompt_definitions(user_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scheduled_prompt_definitions_task ON scheduled_prompt_definitions(task_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scheduled_prompt_versions_definition ON scheduled_prompt_versions(definition_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scheduled_prompt_runs_task ON scheduled_prompt_runs(task_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scheduled_prompt_runs_definition ON scheduled_prompt_runs(definition_id)"
        )
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_scheduled_prompt_runs_glasshive ON scheduled_prompt_runs(glasshive_run_id)"
        )
        conn.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_prompt_runs_occurrence
            ON scheduled_prompt_runs(occurrence_key)
            WHERE occurrence_key IS NOT NULL
            """
        )
        self._sanitize_existing_scheduled_prompt_runs(conn)
        self._sanitize_existing_scheduled_prompt_snapshots(conn)
        self._reconcile_stale_scheduled_prompt_runs(conn)
        # === VIVENTIUM NOTE ===

    @staticmethod
    def _ensure_scheduled_prompt_run_columns(conn: sqlite3.Connection) -> None:
        existing = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(scheduled_prompt_runs)").fetchall()
        }
        additions = {
            "trigger_kind": "TEXT",
            "trigger_source": "TEXT",
            "occurrence_key": "TEXT",
            "lease_owner": "TEXT",
            "lease_until": "TEXT",
            "attempt": "INTEGER NOT NULL DEFAULT 0",
            "disposition": "TEXT",
            "execution_snapshot_json": "TEXT",
            "channel_outcomes_json": "TEXT",
            "interaction_ref": "TEXT",
            "claimed_at": "TEXT",
            "claim_expires_at": "TEXT",
            "attempt_count": "INTEGER NOT NULL DEFAULT 0",
        }
        for name, definition in additions.items():
            if name not in existing:
                conn.execute(
                    f"ALTER TABLE scheduled_prompt_runs ADD COLUMN {name} {definition}"
                )

    @staticmethod
    def _hash_text(value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]

    @staticmethod
    def _safe_run_text(value: Any, limit: int = 240) -> str:
        text = re.sub(r"\s+", " ", str(value or "")).strip()
        text = _MONGO_URI_RE.sub("<mongo-uri>", text)
        text = _BEARER_RE.sub("Bearer <redacted>", text)
        text = _URL_RE.sub("<url>", text)
        text = _LOCAL_PATH_RE.sub("<local-path>", text)
        return text[:limit] + ("..." if len(text) > limit else "")

    @classmethod
    def _private_rendered_marker(cls, rendered_hash: Any) -> str:
        return f"<private-rendered-prompt hash=\"{str(rendered_hash or '').strip()}\" />"

    @classmethod
    def _private_snapshot_marker(cls, snapshot_hash: Any) -> str:
        snapshot_hash_text = str(snapshot_hash or "").strip()
        return json.dumps(
            {
                "kind": "private-variable-snapshot",
                "hash": snapshot_hash_text,
                "privateDetail": f"private://scheduled-prompt-variable-snapshot/{snapshot_hash_text}",
            },
            sort_keys=True,
        )

    @staticmethod
    def _callback_payload_needs_sanitization(value: Any) -> bool:
        text = str(value or "")
        if not text:
            return False
        if any(token in text for token in ("FINAL REPORT", "full_message", '"message"', '"error"')):
            return True
        return bool(_MONGO_URI_RE.search(text) or _LOCAL_PATH_RE.search(text) or _BEARER_RE.search(text))

    @staticmethod
    def _append_legacy_private_payload(path_value: Any, run_id: str, payload_text: str) -> None:
        path = Path(str(path_value or "")).expanduser()
        if not str(path_value or "").strip():
            return
        try:
            detail = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        except Exception:
            detail = {}
        if not isinstance(detail, dict):
            detail = {}
        legacy = detail.get("legacy_callback_payloads")
        if not isinstance(legacy, list):
            legacy = []
        legacy.append(
            {
                "run_id": run_id,
                "migrated_at": datetime.now(timezone.utc).isoformat(),
                "payload": payload_text,
            }
        )
        detail["legacy_callback_payloads"] = legacy[-20:]
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(detail, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            os.chmod(path, 0o600)
        except OSError:
            return

    @classmethod
    def _sanitized_callback_payload(cls, run_id: str, value: Any, private_detail_path: Any) -> str:
        text = str(value or "")
        if not text:
            return ""
        cls._append_legacy_private_payload(private_detail_path, run_id, text)
        event = "legacy_callback_payload"
        status = "migrated"
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict):
            event = str(payload.get("event") or event)
            status = str(payload.get("status") or status)
        return json.dumps(
            {
                "event": event,
                "status": status,
                "message_hash": cls._hash_text(text),
                "has_private_payload": True,
                "migrated": True,
            },
            sort_keys=True,
        )

    def _sanitize_existing_scheduled_prompt_runs(self, conn: sqlite3.Connection) -> None:
        rows = conn.execute(
            """
            SELECT run_id, result_summary, callback_payload_json, private_detail_path
            FROM scheduled_prompt_runs
            WHERE result_summary IS NOT NULL OR callback_payload_json IS NOT NULL
            """
        ).fetchall()
        for row in rows:
            updates: dict[str, Any] = {}
            safe_summary = self._safe_run_text(row["result_summary"]) if row["result_summary"] else None
            if safe_summary is not None and safe_summary != row["result_summary"]:
                updates["result_summary"] = safe_summary
            if row["callback_payload_json"] and self._callback_payload_needs_sanitization(row["callback_payload_json"]):
                updates["callback_payload_json"] = self._sanitized_callback_payload(
                    str(row["run_id"]),
                    row["callback_payload_json"],
                    row["private_detail_path"],
                )
            if not updates:
                continue
            assignments = ", ".join(f"{key} = :{key}" for key in updates)
            conn.execute(
                f"UPDATE scheduled_prompt_runs SET {assignments} WHERE run_id = :run_id",
                {**updates, "run_id": row["run_id"]},
            )

    def _sanitize_existing_scheduled_prompt_snapshots(self, conn: sqlite3.Connection) -> None:
        version_rows = conn.execute(
            """
            SELECT id, rendered_text, rendered_hash, variable_snapshot_json, variable_snapshot_hash
            FROM scheduled_prompt_versions
            """
        ).fetchall()
        for row in version_rows:
            updates: dict[str, Any] = {}
            rendered_marker = self._private_rendered_marker(row["rendered_hash"])
            snapshot_marker = self._private_snapshot_marker(row["variable_snapshot_hash"])
            if row["rendered_text"] != rendered_marker:
                updates["rendered_text"] = rendered_marker
            if row["variable_snapshot_json"] != snapshot_marker:
                updates["variable_snapshot_json"] = snapshot_marker
            if updates:
                assignments = ", ".join(f"{key} = :{key}" for key in updates)
                conn.execute(
                    f"UPDATE scheduled_prompt_versions SET {assignments} WHERE id = :id",
                    {**updates, "id": row["id"]},
                )

        task_rows = conn.execute(
            """
            SELECT scheduled_tasks.id, scheduled_tasks.prompt, scheduled_tasks.metadata_json,
                   scheduled_prompt_definitions.prompt_text
            FROM scheduled_tasks
            JOIN scheduled_prompt_definitions ON scheduled_prompt_definitions.task_id = scheduled_tasks.id
            """
        ).fetchall()
        for row in task_rows:
            updates = {}
            prompt_text = row["prompt_text"] or row["prompt"]
            if row["prompt"] != prompt_text:
                updates["prompt"] = prompt_text
            try:
                metadata = json.loads(row["metadata_json"] or "{}")
            except json.JSONDecodeError:
                metadata = {}
            if isinstance(metadata, dict):
                wb = metadata.get("workbench_scheduled_prompt")
                if isinstance(wb, dict) and "variable_snapshot_json" in wb:
                    sanitized_wb = dict(wb)
                    snapshot_hash = sanitized_wb.get("variable_snapshot_hash") or ""
                    sanitized_wb.pop("variable_snapshot_json", None)
                    sanitized_wb["variable_snapshot_pointer"] = (
                        f"private://scheduled-prompt-variable-snapshot/{snapshot_hash}"
                    )
                    metadata["workbench_scheduled_prompt"] = sanitized_wb
                    updates["metadata_json"] = json.dumps(metadata)
            if updates:
                assignments = ", ".join(f"{key} = :{key}" for key in updates)
                conn.execute(
                    f"UPDATE scheduled_tasks SET {assignments} WHERE id = :id",
                    {**updates, "id": row["id"]},
                )

    @staticmethod
    def _reconcile_stale_scheduled_prompt_runs(conn: sqlite3.Connection) -> None:
        # === VIVENTIUM START ===
        # Keep the persisted audit disposition consistent with an already-terminal run.
        repaired = conn.execute(
            """
            UPDATE scheduled_prompt_runs
            SET disposition = 'failed'
            WHERE status = 'failed'
              AND COALESCE(disposition, 'running') = 'running'
            """
        )
        if repaired.rowcount:
            logger.info("Repaired %s terminal scheduled prompt disposition(s)", repaired.rowcount)
        # === VIVENTIUM END ===
        try:
            stale_seconds = int(os.getenv("SCHEDULING_STALE_PROMPT_RUN_SECONDS") or 24 * 60 * 60)
        except ValueError:
            stale_seconds = 24 * 60 * 60
        if stale_seconds <= 0:
            return
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=stale_seconds)
        now_iso = now.isoformat().replace("+00:00", "Z")
        cutoff_iso = cutoff.isoformat().replace("+00:00", "Z")
        expired_claims = conn.execute(
            """
            UPDATE scheduled_prompt_runs
            SET status = 'failed',
                completed_at = COALESCE(completed_at, ?),
                error_class = 'stale_claim_recovered',
                result_summary = 'Expired occurrence claim recovered for idempotent retry.',
                updated_at = ?
            WHERE status = 'dispatching'
              AND claim_expires_at IS NOT NULL
              AND claim_expires_at <= ?
            """,
            (now_iso, now_iso, now_iso),
        )
        if expired_claims.rowcount:
            logger.info("Recovered %s expired occurrence claim(s)", expired_claims.rowcount)
        cursor = conn.execute(
            """
            UPDATE scheduled_prompt_runs
            SET status = 'failed',
                completed_at = COALESCE(completed_at, ?),
                error_class = 'stale_run_reconciled',
                result_summary = 'Run did not reach a terminal callback before the recovery window.',
                disposition = 'failed',
                lease_owner = NULL,
                lease_until = NULL,
                updated_at = ?
            WHERE status IN ('queued', 'running')
              AND COALESCE(updated_at, started_at, created_at) < ?
            """,
            (now_iso, now_iso, cutoff_iso),
        )
        if cursor.rowcount:
            logger.info("Reconciled %s stale scheduled prompt run(s)", cursor.rowcount)

    # === VIVENTIUM NOTE ===
    # Feature: Serialize multi-channel values for storage and filter support.
    @staticmethod
    def _serialize_channel(value: Any) -> Any:
        if isinstance(value, (list, tuple, set)):
            return json.dumps(list(value))
        return value

    @staticmethod
    def _deserialize_channel(value: Any) -> Any:
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("[") and text.endswith("]"):
                try:
                    parsed = json.loads(text)
                except Exception:
                    return value
                if isinstance(parsed, list):
                    return parsed
        return value

    @staticmethod
    def _normalize_channel_filter(channel: Optional[Union[str, List[str]]]) -> List[str]:
        if not channel:
            return []
        if isinstance(channel, str):
            return [channel]
        return [value for value in channel if value]
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Mirror helpers for durable storage without direct SQLite locks on shares.
    def _restore_from_mirror(self) -> None:
        if not self._mirror_path or not self._mirror_path.exists():
            return
        with self._mirror_lock:
            try:
                mirror_mtime = self._mirror_path.stat().st_mtime
                local_candidates = [self._db_path, Path(f"{self._db_path}-wal")]
                local_mtime = max(
                    (path.stat().st_mtime for path in local_candidates if path.exists()),
                    default=0.0,
                )
                if self._db_path.exists() and mirror_mtime <= local_mtime:
                    return
                mirror_uri = f"{self._mirror_path.resolve().as_uri()}?mode=ro"
                with sqlite3.connect(mirror_uri, uri=True) as source, self._connect() as destination:
                    integrity = source.execute("PRAGMA quick_check").fetchone()
                    if not integrity or integrity[0] != "ok":
                        raise sqlite3.DatabaseError("scheduling mirror failed integrity check")
                    source.backup(destination)
            except Exception as exc:
                logger.warning(
                    "Failed to restore scheduling DB from mirror %s: %s", self._mirror_path, exc
                )

    def _sync_to_mirror(self) -> None:
        if not self._mirror_path:
            return
        if not self._db_path.exists():
            return
        with self._mirror_lock:
            tmp_path = self._mirror_path.with_name(
                f".{self._mirror_path.name}.{uuid.uuid4().hex}.tmp"
            )
            try:
                with self._connect() as source, sqlite3.connect(tmp_path) as snapshot:
                    source.backup(snapshot)
                    snapshot.execute("PRAGMA optimize")
                os.replace(tmp_path, self._mirror_path)
            except Exception as exc:
                logger.warning(
                    "Failed to sync scheduling DB to mirror %s: %s", self._mirror_path, exc
                )
            finally:
                try:
                    tmp_path.unlink(missing_ok=True)
                except OSError:
                    pass
    # === VIVENTIUM NOTE ===

    def create_task(self, task: Dict[str, Any]) -> Dict[str, Any]:
        payload = dict(task)
        # === VIVENTIUM NOTE ===
        # Feature: Persist channel lists as JSON.
        payload["channel"] = self._serialize_channel(payload.get("channel"))
        # === VIVENTIUM NOTE ===
        # === VIVENTIUM NOTE ===
        # Feature: Backward-compatible defaults for newly added delivery ledger fields.
        payload.setdefault("last_delivery_outcome", None)
        payload.setdefault("last_delivery_reason", None)
        payload.setdefault("last_delivery_at", None)
        payload.setdefault("last_generated_text", None)
        payload["last_delivery_json"] = json.dumps(payload.pop("last_delivery", None))
        payload.setdefault("executor", "viventium_agent")
        # === VIVENTIUM NOTE ===
        schedule_json = json.dumps(payload.pop("schedule"))
        metadata_json = json.dumps(payload.pop("metadata", None))
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scheduled_tasks (
                  id, user_id, agent_id, prompt, schedule_json, channel,
                  executor,
                  conversation_policy, conversation_id, last_conversation_id,
                  active, created_by, created_source, created_at, updated_at,
                  updated_by, updated_source, last_run_at, next_run_at, last_status, last_error,
                  last_delivery_outcome, last_delivery_reason, last_delivery_at, last_generated_text,
                  last_delivery_json, metadata_json
                ) VALUES (
                  :id, :user_id, :agent_id, :prompt, :schedule_json, :channel,
                  :executor,
                  :conversation_policy, :conversation_id, :last_conversation_id,
                  :active, :created_by, :created_source, :created_at, :updated_at,
                  :updated_by, :updated_source, :last_run_at, :next_run_at, :last_status, :last_error,
                  :last_delivery_outcome, :last_delivery_reason, :last_delivery_at, :last_generated_text,
                  :last_delivery_json, :metadata_json
                )
                """,
                {
                    **payload,
                    "schedule_json": schedule_json,
                    "metadata_json": metadata_json,
                },
            )
        # === VIVENTIUM NOTE ===
        # Feature: Mirror updated DB after writes.
        self._sync_to_mirror()
        # === VIVENTIUM NOTE ===
        return task

    def get_task(self, user_id: str, task_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?",
                (task_id, user_id),
            ).fetchone()
        return self._row_to_task(row)

    def list_tasks(
        self,
        user_id: str,
        active_only: bool = False,
        channel: Optional[Union[str, List[str]]] = None,
        agent_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        clauses = ["user_id = ?"]
        params: List[Any] = [user_id]
        if active_only:
            clauses.append("active = 1")
        # === VIVENTIUM NOTE ===
        # Feature: Filter channel against single or multi-channel stored values.
        channel_values = self._normalize_channel_filter(channel)
        if channel_values:
            channel_clauses = []
            for value in channel_values:
                channel_clauses.append("(channel = ? OR channel LIKE ?)")
                params.extend([value, f'%"{value}"%'])
            clauses.append(f"({' OR '.join(channel_clauses)})")
        # === VIVENTIUM NOTE ===
        if agent_id:
            clauses.append("agent_id = ?")
            params.append(agent_id)

        where = " AND ".join(clauses)
        sql = f"SELECT * FROM scheduled_tasks WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._row_to_task(row) for row in rows if row]

    def search_tasks(
        self,
        user_id: str,
        query: str,
        channel: Optional[Union[str, List[str]]] = None,
        agent_id: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        clauses = ["user_id = ?", "prompt LIKE ?"]
        params: List[Any] = [user_id, f"%{query}%"]
        # === VIVENTIUM NOTE ===
        # Feature: Filter channel against single or multi-channel stored values.
        channel_values = self._normalize_channel_filter(channel)
        if channel_values:
            channel_clauses = []
            for value in channel_values:
                channel_clauses.append("(channel = ? OR channel LIKE ?)")
                params.extend([value, f'%"{value}"%'])
            clauses.append(f"({' OR '.join(channel_clauses)})")
        # === VIVENTIUM NOTE ===
        if agent_id:
            clauses.append("agent_id = ?")
            params.append(agent_id)

        where = " AND ".join(clauses)
        sql = f"SELECT * FROM scheduled_tasks WHERE {where} ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [self._row_to_task(row) for row in rows if row]

    # === VIVENTIUM NOTE ===
    # Feature: Return the most recent task by delivery timestamp for visibility tooling.
    def get_latest_delivery_task(
        self,
        user_id: str,
        channel: Optional[Union[str, List[str]]] = None,
        agent_id: Optional[str] = None,
    ) -> Optional[Dict[str, Any]]:
        clauses = ["user_id = ?"]
        params: List[Any] = [user_id]

        channel_values = self._normalize_channel_filter(channel)
        if channel_values:
            channel_clauses = []
            for value in channel_values:
                channel_clauses.append("(channel = ? OR channel LIKE ?)")
                params.extend([value, f'%"{value}"%'])
            clauses.append(f"({' OR '.join(channel_clauses)})")
        if agent_id:
            clauses.append("agent_id = ?")
            params.append(agent_id)

        where = " AND ".join(clauses)
        sql = f"""
            SELECT *
            FROM scheduled_tasks
            WHERE {where}
            ORDER BY
              COALESCE(last_delivery_at, last_run_at, updated_at, created_at) DESC,
              created_at DESC
            LIMIT 1
        """
        with self._connect() as conn:
            row = conn.execute(sql, params).fetchone()
        return self._row_to_task(row)
    # === VIVENTIUM NOTE ===

    def update_task(self, user_id: str, task_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not updates:
            return self.get_task(user_id, task_id)

        payload = dict(updates)
        # === VIVENTIUM NOTE ===
        # Feature: Persist channel lists as JSON on update.
        if "channel" in payload:
            payload["channel"] = self._serialize_channel(payload.get("channel"))
        # === VIVENTIUM NOTE ===
        schedule = payload.pop("schedule", None)
        delivery = payload.pop("last_delivery", None)
        metadata = payload.pop("metadata", None)
        if schedule is not None:
            payload["schedule_json"] = json.dumps(schedule)
        # === VIVENTIUM NOTE ===
        # Feature: Persist structured delivery ledger in JSON.
        if delivery is not None:
            payload["last_delivery_json"] = json.dumps(delivery)
        # === VIVENTIUM NOTE ===
        if metadata is not None:
            payload["metadata_json"] = json.dumps(metadata)

        assignments = ", ".join([f"{key} = ?" for key in payload.keys()])
        params = list(payload.values()) + [task_id, user_id]
        sql = f"UPDATE scheduled_tasks SET {assignments} WHERE id = ? AND user_id = ?"
        with self._connect() as conn:
            conn.execute(sql, params)
        # === VIVENTIUM NOTE ===
        # Feature: Mirror updated DB after writes.
        self._sync_to_mirror()
        # === VIVENTIUM NOTE ===
        return self.get_task(user_id, task_id)

    def deactivate_glasshive_workspace_tasks_for_owner(
        self,
        *,
        user_id: str,
        tenant_id: str,
        updated_at: str,
    ) -> int:
        """Atomically pause this principal's delegated GlassHive definitions only."""

        delivery = json.dumps(
            {
                "outcome": "action_required",
                "reason": "principal_disabled",
                "failure_class": "principal_disabled",
                "generated_text": None,
            }
        )
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            rows = conn.execute(
                """
                SELECT id, metadata_json
                FROM scheduled_tasks
                WHERE user_id = ? AND executor = 'glasshive_workspace' AND active = 1
                """,
                (user_id,),
            ).fetchall()
            task_ids: list[str] = []
            cleaned_metadata_by_id: dict[str, str] = {}
            for row in rows:
                try:
                    metadata = json.loads(row["metadata_json"] or "{}")
                except (TypeError, json.JSONDecodeError):
                    continue
                workspace = (
                    metadata.get("glasshive_workspace_schedule")
                    if isinstance(metadata, dict)
                    else None
                )
                if not isinstance(workspace, dict):
                    continue
                if str(workspace.get("tenant_id") or "local") != tenant_id:
                    continue
                task_id = str(row["id"])
                cleaned_workspace = dict(workspace)
                cleaned_workspace.pop("pending_occurrence_key", None)
                cleaned_metadata = dict(metadata)
                cleaned_metadata["glasshive_workspace_schedule"] = cleaned_workspace
                task_ids.append(task_id)
                cleaned_metadata_by_id[task_id] = json.dumps(cleaned_metadata)
            if task_ids:
                placeholders = ", ".join("?" for _ in task_ids)
                conn.execute(
                    f"""
                    UPDATE scheduled_tasks
                    SET active = 0,
                        next_run_at = NULL,
                        last_status = 'action_required',
                        last_error = 'principal_disabled',
                        last_delivery_outcome = 'action_required',
                        last_delivery_reason = 'principal_disabled',
                        last_delivery_at = ?,
                        last_generated_text = NULL,
                        last_delivery_json = ?,
                        updated_at = ?
                    WHERE id IN ({placeholders}) AND user_id = ?
                    """,
                    (updated_at, delivery, updated_at, *task_ids, user_id),
                )
                for task_id, metadata_json in cleaned_metadata_by_id.items():
                    conn.execute(
                        """
                        UPDATE scheduled_tasks
                        SET metadata_json = ?
                        WHERE id = ? AND user_id = ?
                        """,
                        (metadata_json, task_id, user_id),
                    )
            conn.execute("COMMIT")
        self._sync_to_mirror()
        return len(task_ids)

    def delete_task(self, user_id: str, task_id: str) -> bool:
        with self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM scheduled_tasks WHERE id = ? AND user_id = ?",
                (task_id, user_id),
            )
        # === VIVENTIUM NOTE ===
        # Feature: Mirror updated DB after writes.
        self._sync_to_mirror()
        # === VIVENTIUM NOTE ===
        return cur.rowcount > 0

    def get_due_tasks(self, now_iso: str, limit: int = 200) -> List[Dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM scheduled_tasks
                WHERE active = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
                ORDER BY next_run_at ASC
                LIMIT ?
                """,
                (now_iso, limit),
            ).fetchall()
        return [self._row_to_task(row) for row in rows if row]

    # === VIVENTIUM NOTE ===
    # Feature: Lookup task by metadata template_id for idempotent bootstrap provisioning.
    def find_by_metadata_template(
        self, user_id: str, template_id: str
    ) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_tasks WHERE user_id = ? AND metadata_json LIKE ?",
                (user_id, f'%"template_id": "{template_id}"%'),
            ).fetchone()
        if row:
            return self._row_to_task(row)
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_tasks WHERE user_id = ? AND metadata_json LIKE ?",
                (user_id, f'%"template_id":"{template_id}"%'),
            ).fetchone()
        return self._row_to_task(row)
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Prompt Workbench scheduled prompt private registry.
    @staticmethod
    def _json_or_none(value: Any) -> str | None:
        return json.dumps(value) if value is not None else None

    def create_scheduled_prompt_definition(self, definition: Dict[str, Any]) -> Dict[str, Any]:
        payload = dict(definition)
        payload["schedule_json"] = json.dumps(payload.pop("schedule"))
        payload["metadata_json"] = self._json_or_none(payload.pop("metadata", None))
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scheduled_prompt_definitions (
                  id, user_id, task_id, title, source_prompt_id, template_id,
                  prompt_text, schedule_json, timezone, active, memory_write_mode,
                  workspace_alias, my_folder, metadata_json, created_at, updated_at
                ) VALUES (
                  :id, :user_id, :task_id, :title, :source_prompt_id, :template_id,
                  :prompt_text, :schedule_json, :timezone, :active, :memory_write_mode,
                  :workspace_alias, :my_folder, :metadata_json, :created_at, :updated_at
                )
                """,
                payload,
            )
        self._sync_to_mirror()
        return definition

    def update_scheduled_prompt_definition(self, definition_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not updates:
            return self.get_scheduled_prompt_definition(definition_id)
        payload = dict(updates)
        if "schedule" in payload:
            payload["schedule_json"] = json.dumps(payload.pop("schedule"))
        if "metadata" in payload:
            payload["metadata_json"] = self._json_or_none(payload.pop("metadata"))
        assignments = ", ".join([f"{key} = ?" for key in payload.keys()])
        params = list(payload.values()) + [definition_id]
        with self._connect() as conn:
            conn.execute(
                f"UPDATE scheduled_prompt_definitions SET {assignments} WHERE id = ?",
                params,
            )
        self._sync_to_mirror()
        return self.get_scheduled_prompt_definition(definition_id)

    def delete_scheduled_prompt_definition(self, definition_id: str) -> bool:
        with self._connect() as conn:
            conn.execute(
                "DELETE FROM scheduled_prompt_runs WHERE definition_id = ?",
                (definition_id,),
            )
            conn.execute(
                "DELETE FROM scheduled_prompt_versions WHERE definition_id = ?",
                (definition_id,),
            )
            cur = conn.execute(
                "DELETE FROM scheduled_prompt_definitions WHERE id = ?",
                (definition_id,),
            )
        self._sync_to_mirror()
        return cur.rowcount > 0

    def get_scheduled_prompt_definition(self, definition_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_definitions WHERE id = ?",
                (definition_id,),
            ).fetchone()
        return self._row_to_scheduled_prompt_definition(row)

    def get_scheduled_prompt_definition_by_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_definitions WHERE task_id = ?",
                (task_id,),
            ).fetchone()
        return self._row_to_scheduled_prompt_definition(row)

    def list_scheduled_prompt_definitions(
        self,
        user_id: Optional[str] = None,
        *,
        limit: int = 200,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if user_id:
            clauses.append("user_id = ?")
            params.append(user_id)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.extend([limit, offset])
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM scheduled_prompt_definitions
                {where}
                ORDER BY updated_at DESC
                LIMIT ? OFFSET ?
                """,
                params,
            ).fetchall()
        return [self._row_to_scheduled_prompt_definition(row) for row in rows if row]

    def create_scheduled_prompt_version(self, version: Dict[str, Any]) -> Dict[str, Any]:
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scheduled_prompt_versions (
                  id, definition_id, version_number, prompt_text, rendered_text,
                  rendered_hash, variable_snapshot_json, variable_snapshot_hash, created_at
                ) VALUES (
                  :id, :definition_id, :version_number, :prompt_text, :rendered_text,
                  :rendered_hash, :variable_snapshot_json, :variable_snapshot_hash, :created_at
                )
                """,
                version,
            )
        self._sync_to_mirror()
        return version

    def latest_scheduled_prompt_version(self, definition_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM scheduled_prompt_versions
                WHERE definition_id = ?
                ORDER BY version_number DESC, created_at DESC
                LIMIT 1
                """,
                (definition_id,),
            ).fetchone()
        return self._row_to_scheduled_prompt_version(row)

    def create_scheduled_prompt_run(self, run: Dict[str, Any]) -> Dict[str, Any]:
        payload = dict(run)
        payload.setdefault("trigger_kind", None)
        payload.setdefault("trigger_source", None)
        payload.setdefault("occurrence_key", None)
        payload.setdefault("lease_owner", None)
        payload.setdefault("lease_until", None)
        payload.setdefault("attempt", 0)
        payload.setdefault("disposition", None)
        if "execution_snapshot" in payload:
            payload["execution_snapshot_json"] = self._json_or_none(
                payload.pop("execution_snapshot")
            )
        else:
            payload.setdefault("execution_snapshot_json", None)
        if "channel_outcomes" in payload:
            payload["channel_outcomes_json"] = self._json_or_none(
                payload.pop("channel_outcomes")
            )
        else:
            payload.setdefault("channel_outcomes_json", None)
        payload.setdefault("interaction_ref", None)
        payload.setdefault("claimed_at", None)
        payload.setdefault("claim_expires_at", None)
        payload.setdefault("attempt_count", 0)
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scheduled_prompt_runs (
                  run_id, task_id, definition_id, user_id, version_id, due_at,
                  started_at, completed_at, status, executor, rendered_hash,
                  variable_snapshot_hash, glasshive_project_id, glasshive_worker_id,
                  glasshive_run_id, result_summary, error_class, private_detail_path,
                  callback_payload_json, trigger_kind, trigger_source, occurrence_key,
                  lease_owner, lease_until, attempt, disposition, execution_snapshot_json,
                  channel_outcomes_json, interaction_ref, claimed_at, claim_expires_at,
                  attempt_count, created_at, updated_at
                ) VALUES (
                  :run_id, :task_id, :definition_id, :user_id, :version_id, :due_at,
                  :started_at, :completed_at, :status, :executor, :rendered_hash,
                  :variable_snapshot_hash, :glasshive_project_id, :glasshive_worker_id,
                  :glasshive_run_id, :result_summary, :error_class, :private_detail_path,
                  :callback_payload_json, :trigger_kind, :trigger_source, :occurrence_key,
                  :lease_owner, :lease_until, :attempt, :disposition, :execution_snapshot_json,
                  :channel_outcomes_json, :interaction_ref, :claimed_at, :claim_expires_at,
                  :attempt_count, :created_at, :updated_at
                )
                """,
                payload,
            )
        self._sync_to_mirror()
        return payload

    @staticmethod
    def scheduled_prompt_occurrence_key(task_id: str, due_at: str) -> str:
        due_value = str(due_at).strip()
        try:
            due = datetime.fromisoformat(due_value.replace("Z", "+00:00"))
            if due.tzinfo is not None:
                due_value = due.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        except ValueError:
            pass
        canonical = f"{str(task_id).strip()}\0{due_value}"
        return f"schedule:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"

    def claim_scheduled_prompt_occurrence(
        self,
        *,
        task_id: str,
        user_id: str,
        executor: str,
        due_at: str,
        lease_owner: str,
        now: str,
        lease_seconds: int,
        definition_id: Optional[str] = None,
        version_id: Optional[str] = None,
        trigger_kind: str = "scheduled",
        trigger_source: str = "scheduler_loop",
    ) -> Dict[str, Any]:
        occurrence_key = self.scheduled_prompt_occurrence_key(task_id, due_at)
        now_dt = datetime.fromisoformat(str(now).replace("Z", "+00:00"))
        if now_dt.tzinfo is None:
            now_dt = now_dt.replace(tzinfo=timezone.utc)
        now_utc = now_dt.astimezone(timezone.utc)
        now_iso = now_utc.isoformat().replace("+00:00", "Z")
        lease_until = now_utc + timedelta(seconds=max(1, lease_seconds))
        lease_until_iso = lease_until.isoformat().replace("+00:00", "Z")
        run: Optional[Dict[str, Any]] = None
        claimed = False
        reason = ""
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            occurrence = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE occurrence_key = ?",
                (occurrence_key,),
            ).fetchone()
            if occurrence is not None:
                occurrence_data = dict(occurrence)
                lease_until_value = str(occurrence_data.get("lease_until") or "").strip()
                try:
                    existing_lease_until = datetime.fromisoformat(
                        lease_until_value.replace("Z", "+00:00")
                    )
                    if existing_lease_until.tzinfo is None:
                        existing_lease_until = existing_lease_until.replace(tzinfo=timezone.utc)
                    lease_is_active = existing_lease_until.astimezone(timezone.utc) > now_utc
                except ValueError:
                    lease_is_active = False
                if lease_until_value and lease_is_active:
                    run = occurrence_data
                    reason = "occurrence_already_claimed"
                elif str(occurrence_data.get("status") or "") in {
                    "completed",
                    "failed",
                    "cancelled",
                    "missed",
                }:
                    run = occurrence_data
                    reason = "occurrence_already_terminal"
                else:
                    conn.execute(
                        """
                        UPDATE scheduled_prompt_runs
                        SET lease_owner = ?, lease_until = ?, attempt = COALESCE(attempt, 0) + 1,
                            status = 'claimed', disposition = 'running', started_at = ?,
                            completed_at = NULL, error_class = NULL, updated_at = ?
                        WHERE occurrence_key = ?
                        """,
                        (lease_owner, lease_until_iso, now_iso, now_iso, occurrence_key),
                    )
                    run = dict(
                        conn.execute(
                            "SELECT * FROM scheduled_prompt_runs WHERE occurrence_key = ?",
                            (occurrence_key,),
                        ).fetchone()
                    )
                    claimed = True
                    reason = "lease_recovered"
            else:
                active = conn.execute(
                    """
                    SELECT * FROM scheduled_prompt_runs
                    WHERE task_id = ? AND lease_until IS NOT NULL
                      AND julianday(lease_until) > julianday(?)
                      AND status IN ('claimed', 'running', 'dispatching', 'queued')
                    ORDER BY lease_until DESC LIMIT 1
                    """,
                    (task_id, now_iso),
                ).fetchone()
                if active is not None:
                    run = dict(active)
                    reason = "task_has_active_occurrence"
                else:
                    run_id = f"sp_run_{uuid.uuid4().hex}"
                    conn.execute(
                        """
                        INSERT INTO scheduled_prompt_runs (
                          run_id, task_id, definition_id, user_id, version_id, due_at,
                          started_at, completed_at, status, executor, rendered_hash,
                          variable_snapshot_hash, glasshive_project_id, glasshive_worker_id,
                          glasshive_run_id, result_summary, error_class, private_detail_path,
                          callback_payload_json, trigger_kind, trigger_source, occurrence_key,
                          lease_owner, lease_until, attempt, disposition, execution_snapshot_json,
                          channel_outcomes_json, interaction_ref, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'claimed', ?, NULL, NULL, NULL,
                                  NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, 1,
                                  'running', NULL, NULL, NULL, ?, ?)
                        """,
                        (
                            run_id,
                            task_id,
                            definition_id,
                            user_id,
                            version_id,
                            due_at,
                            now_iso,
                            executor,
                            trigger_kind,
                            trigger_source,
                            occurrence_key,
                            lease_owner,
                            lease_until_iso,
                            now_iso,
                            now_iso,
                        ),
                    )
                    run = dict(
                        conn.execute(
                            "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?", (run_id,)
                        ).fetchone()
                    )
                    claimed = True
                    reason = "claimed"
        if claimed:
            self._sync_to_mirror()
        return {
            "claimed": claimed,
            "reason": reason,
            "occurrence_key": occurrence_key,
            "run": self._row_to_scheduled_prompt_run_dict(run),
        }

    def claim_scheduled_prompt_run(
        self,
        run: Dict[str, Any],
        *,
        claimed_at: str,
        claim_expires_at: str,
    ) -> Dict[str, Any]:
        """Atomically reserve or recover one deterministic occurrence dispatch."""

        payload = {
            **run,
            "claimed_at": claimed_at,
            "claim_expires_at": claim_expires_at,
            "attempt_count": 1,
        }
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?",
                (payload["run_id"],),
            ).fetchone()
            claimed = False
            reason = ""
            if row is None:
                columns = tuple(payload.keys())
                placeholders = ", ".join("?" for _ in columns)
                conn.execute(
                    f"INSERT INTO scheduled_prompt_runs ({', '.join(columns)}) VALUES ({placeholders})",
                    tuple(payload[column] for column in columns),
                )
                claimed = True
            else:
                current = dict(row)
                status = str(current.get("status") or "")
                active_expiry = str(current.get("claim_expires_at") or "")
                if str(current.get("glasshive_run_id") or ""):
                    reason = "occurrence_already_reserved"
                elif status in {"completed", "skipped"}:
                    reason = "occurrence_terminal"
                elif status in {"queued", "running"}:
                    reason = "occurrence_active"
                elif status == "dispatching" and active_expiry and active_expiry > claimed_at:
                    reason = "occurrence_claim_active"
                else:
                    conn.execute(
                        """
                        UPDATE scheduled_prompt_runs
                        SET status = 'dispatching', started_at = ?, completed_at = NULL,
                            result_summary = NULL, error_class = NULL,
                            claimed_at = ?, claim_expires_at = ?,
                            attempt_count = COALESCE(attempt_count, 0) + 1,
                            updated_at = ?
                        WHERE run_id = ?
                        """,
                        (
                            payload["started_at"],
                            claimed_at,
                            claim_expires_at,
                            payload["updated_at"],
                            payload["run_id"],
                        ),
                    )
                    claimed = True
            selected = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?",
                (payload["run_id"],),
            ).fetchone()
            conn.execute("COMMIT")
        self._sync_to_mirror()
        return {
            "claimed": claimed,
            "reason": reason,
            "run": self._row_to_scheduled_prompt_run(selected),
        }

    def update_scheduled_prompt_run(self, run_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not updates:
            return self.get_scheduled_prompt_run(run_id)
        payload = dict(updates)
        if "execution_snapshot" in payload:
            payload["execution_snapshot_json"] = self._json_or_none(
                payload.pop("execution_snapshot")
            )
        if "channel_outcomes" in payload:
            payload["channel_outcomes_json"] = self._json_or_none(
                payload.pop("channel_outcomes")
            )
        if str(payload.get("status") or "") in {"completed", "failed", "cancelled", "missed"}:
            payload.setdefault("lease_owner", None)
            payload.setdefault("lease_until", None)
        assignments = ", ".join([f"{key} = ?" for key in payload.keys()])
        params = list(payload.values()) + [run_id]
        with self._connect() as conn:
            conn.execute(
                f"UPDATE scheduled_prompt_runs SET {assignments} WHERE run_id = ?",
                params,
            )
        self._sync_to_mirror()
        return self.get_scheduled_prompt_run(run_id)

    def update_scheduled_prompt_run_if_current(
        self,
        run_id: str,
        updates: Dict[str, Any],
        *,
        expected_status: str,
        expected_error_class: Optional[str],
    ) -> Dict[str, Any]:
        payload = dict(updates)
        if "execution_snapshot" in payload:
            payload["execution_snapshot_json"] = self._json_or_none(
                payload.pop("execution_snapshot")
            )
        if "channel_outcomes" in payload:
            payload["channel_outcomes_json"] = self._json_or_none(
                payload.pop("channel_outcomes")
            )
        if str(payload.get("status") or "") in {
            "completed",
            "failed",
            "cancelled",
            "missed",
        }:
            payload["lease_owner"] = None
            payload["lease_until"] = None
        updated = False
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            current_matches = bool(
                current is not None
                and str(current["status"] or "") == str(expected_status or "")
                and current["error_class"] == expected_error_class
            )
            if current_matches and payload:
                assignments = ", ".join(f"{key} = ?" for key in payload)
                conn.execute(
                    f"UPDATE scheduled_prompt_runs SET {assignments} WHERE run_id = ?",
                    list(payload.values()) + [run_id],
                )
                updated = True
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
            conn.execute("COMMIT")
        if updated:
            self._sync_to_mirror()
        return {"updated": updated, "run": self._row_to_scheduled_prompt_run(row)}

    @staticmethod
    def _parse_terminal_instant(value: Any) -> Optional[datetime]:
        text = str(value or "").strip()
        if not text:
            return None
        try:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _scheduled_terminal_callback_identity(
        *,
        owner_id: str,
        work_id: str,
        payload: Dict[str, Any],
        callback_contract: str,
    ) -> Dict[str, Any]:
        clean_owner = str(owner_id or "").strip()
        clean_work = str(work_id or "").strip()
        if (
            not clean_owner
            or not clean_work
            or len(clean_owner) > 512
            or len(clean_work) > 512
            or any(ord(character) < 33 for character in clean_owner + clean_work)
            or not isinstance(payload, dict)
        ):
            raise ValueError("Terminal callback owner/work scope is invalid")
        if callback_contract == "glasshive_terminal_result_v1":
            supplied_owner = str(payload.get("user_id") or "").strip()
            occurrence_key = str(payload.get("occurrence_key") or "").strip()
            callback_id = str(payload.get("callback_id") or "").strip()
            result_digest = str(payload.get("result_digest") or "").strip()
            result_revision = payload.get("result_revision")
            if (
                str(payload.get("callback_contract") or "").strip() != callback_contract
                or supplied_owner != clean_owner
                or not occurrence_key
                or re.fullmatch(r"cb_terminal_[0-9a-f]{64}", callback_id) is None
                or not isinstance(result_revision, int)
                or isinstance(result_revision, bool)
                or not 1 <= result_revision <= 9_223_372_036_854_775_807
                or re.fullmatch(r"sha256:[0-9a-f]{64}", result_digest) is None
            ):
                raise ValueError("Terminal callback result identity is invalid")
        else:
            supplied_owner = str(payload.get("user_id") or "").strip()
            supplied_message_id = str(payload.get("message_id") or "").strip()
            supplied_run_id = str(payload.get("scheduled_prompt_run_id") or "").strip()
            supplied_work = supplied_run_id or supplied_message_id
            event = str(payload.get("event") or "").strip()
            result_state = str(payload.get("result_state") or "").strip()
            expected_state = {
                "run.completed": "completed",
                "run.failed": "failed",
                "run.cancelled": "cancelled",
                "run.interrupted": "cancelled",
            }.get(event)
            callback_id = str(payload.get("callback_id") or "").strip()
            run_id = str(payload.get("run_id") or "").strip()
            ended_at = str(payload.get("result_ended_at") or "").strip()
            result_digest = str(payload.get("result_digest") or "").strip()
            result_revision = payload.get("result_revision")
            attempt_value = payload.get("attempt_number")
            attempt_number = 0 if attempt_value is None else attempt_value
            valid_attempt = (
                attempt_number == 0
                or isinstance(attempt_number, int)
                and not isinstance(attempt_number, bool)
                and 1 <= attempt_number <= 9_223_372_036_854_775_807
            )
            if (
                supplied_owner != clean_owner
                or supplied_work != clean_work
                or supplied_message_id and supplied_message_id != clean_work
                or supplied_run_id and supplied_run_id != clean_work
                or expected_state is None
                or result_state != expected_state
                or not run_id
                or not ended_at
                or not valid_attempt
                or not isinstance(result_revision, int)
                or isinstance(result_revision, bool)
                or not 1 <= result_revision <= 9_223_372_036_854_775_807
                or re.fullmatch(r"sha256:[0-9a-f]{64}", result_digest) is None
            ):
                raise ValueError("Terminal callback result identity is invalid")
            material = ":".join(
                (
                    run_id,
                    result_state,
                    ended_at,
                    str(attempt_number),
                    str(result_revision),
                    result_digest,
                )
            )
            expected_callback_id = "cb_terminal_" + hashlib.sha256(
                material.encode("utf-8")
            ).hexdigest()
            if callback_id != expected_callback_id:
                raise ValueError("Terminal callback result identity is invalid")
        return {
            "owner_id": clean_owner,
            "work_id": clean_work,
            "callback_id": callback_id,
            "result_revision": result_revision,
            "result_digest": result_digest,
            "payload_json": json.dumps(
                payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
            ),
        }

    def accept_scheduled_terminal_callback_result(
        self,
        *,
        owner_id: str,
        work_id: str,
        payload: Dict[str, Any],
        callback_contract: str = "",
    ) -> Dict[str, Any]:
        identity = self._scheduled_terminal_callback_identity(
            owner_id=owner_id,
            work_id=work_id,
            payload=payload,
            callback_contract=str(callback_contract or "").strip(),
        )
        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                "SELECT * FROM scheduled_terminal_callback_results WHERE owner_id = ? AND work_id = ?",
                (identity["owner_id"], identity["work_id"]),
            ).fetchone()
            current_revision = int(current["result_revision"] or 0) if current else 0
            lease_until = (
                self._parse_terminal_instant(current["effect_lease_until"])
                if current
                else None
            )
            effects_in_progress = bool(
                current
                and str(current["effect_state"] or "") == "applying"
                and lease_until is not None
                and lease_until > datetime.now(timezone.utc)
            )
            if current and identity["result_revision"] > current_revision and effects_in_progress:
                status = "effects_in_progress"
            elif current is None or identity["result_revision"] > current_revision:
                status = "accepted"
                conn.execute(
                    """
                    INSERT INTO scheduled_terminal_callback_results (
                      owner_id, work_id, callback_id, result_revision, result_digest,
                      payload_json, effect_state, effect_lease_token, effect_lease_until, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '', NULL, ?)
                    ON CONFLICT(owner_id, work_id) DO UPDATE SET
                      callback_id = excluded.callback_id,
                      result_revision = excluded.result_revision,
                      result_digest = excluded.result_digest,
                      payload_json = excluded.payload_json,
                      effect_state = 'pending', effect_lease_token = '',
                      effect_lease_until = NULL, updated_at = excluded.updated_at
                    WHERE excluded.result_revision > scheduled_terminal_callback_results.result_revision
                    """,
                    (
                        identity["owner_id"], identity["work_id"], identity["callback_id"],
                        identity["result_revision"], identity["result_digest"],
                        identity["payload_json"], now,
                    ),
                )
            elif identity["result_revision"] < current_revision:
                status = "superseded"
            elif (
                identity["callback_id"] != str(current["callback_id"] or "")
                or identity["result_digest"] != str(current["result_digest"] or "")
            ):
                status = "conflict"
            elif str(current["effect_state"] or "") == "committed":
                status = "idempotent"
            else:
                status = "replay_pending"
            current = conn.execute(
                "SELECT * FROM scheduled_terminal_callback_results WHERE owner_id = ? AND work_id = ?",
                (identity["owner_id"], identity["work_id"]),
            ).fetchone()
            if current is None:
                conn.execute("ROLLBACK")
                raise RuntimeError("Terminal callback receiver CAS did not persist")
            current_revision = int(current["result_revision"] or 0)
            current_digest = str(current["result_digest"] or "")
            conn.execute(
                """
                INSERT INTO scheduled_terminal_callback_attempts (
                  owner_id, work_id, callback_id, result_revision, result_digest,
                  status, current_result_revision, current_result_digest, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identity["owner_id"], identity["work_id"], identity["callback_id"],
                    identity["result_revision"], identity["result_digest"], status,
                    current_revision, current_digest, now,
                ),
            )
            conn.execute("COMMIT")
        self._sync_to_mirror()
        return {
            "http_status": 425 if status == "effects_in_progress" else 200
            if status in {"accepted", "idempotent", "replay_pending"} else 409,
            "callback_status": status,
            "callback_id": identity["callback_id"],
            "result_revision": identity["result_revision"],
            "result_digest": identity["result_digest"],
            "current_result_revision": current_revision,
            "current_result_digest": current_digest,
            "current_callback_id": str(current["callback_id"] or ""),
        }

    def claim_scheduled_terminal_callback_effect(
        self,
        *,
        owner_id: str,
        work_id: str,
        result_revision: int,
        result_digest: str,
        lease_seconds: int = 60,
    ) -> Dict[str, Any]:
        now = datetime.now(timezone.utc)
        lease_until = (now + timedelta(seconds=max(1, lease_seconds))).isoformat()
        lease_token = "receiver_" + uuid.uuid4().hex
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM scheduled_terminal_callback_results WHERE owner_id = ? AND work_id = ?",
                (str(owner_id), str(work_id)),
            ).fetchone()
            current_lease_until = (
                self._parse_terminal_instant(row["effect_lease_until"]) if row else None
            )
            lease_expired = bool(
                row and str(row["effect_state"] or "") == "applying"
                and (current_lease_until is None or current_lease_until <= now)
            )
            exact = bool(
                row and int(row["result_revision"] or 0) == result_revision
                and str(row["result_digest"] or "") == str(result_digest)
            )
            claimed = False
            if exact and (str(row["effect_state"] or "") == "pending" or lease_expired):
                cursor = conn.execute(
                    """
                    UPDATE scheduled_terminal_callback_results
                    SET effect_state = 'applying', effect_lease_token = ?,
                        effect_lease_until = ?, updated_at = ?
                    WHERE owner_id = ? AND work_id = ? AND result_revision = ?
                      AND result_digest = ? AND effect_state != 'committed'
                    """,
                    (lease_token, lease_until, now.isoformat(), str(owner_id), str(work_id),
                     result_revision, str(result_digest)),
                )
                claimed = cursor.rowcount == 1
            conn.execute("COMMIT")
        if claimed:
            self._sync_to_mirror()
        return {"claimed": claimed, "lease_token": lease_token if claimed else ""}

    def scheduled_terminal_callback_effect_is_current(
        self,
        *,
        owner_id: str,
        work_id: str,
        result_revision: int,
        result_digest: str,
        lease_token: str,
    ) -> bool:
        now = datetime.now(timezone.utc)
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_terminal_callback_results WHERE owner_id = ? AND work_id = ?",
                (str(owner_id), str(work_id)),
            ).fetchone()
        lease_until = self._parse_terminal_instant(row["effect_lease_until"]) if row else None
        return bool(
            row and int(row["result_revision"] or 0) == result_revision
            and str(row["result_digest"] or "") == str(result_digest)
            and str(row["effect_state"] or "") == "applying"
            and hmac.compare_digest(str(row["effect_lease_token"] or ""), str(lease_token or ""))
            and lease_until is not None and lease_until > now
        )

    def complete_scheduled_terminal_callback_effect(
        self,
        *,
        owner_id: str,
        work_id: str,
        result_revision: int,
        result_digest: str,
        lease_token: str,
    ) -> bool:
        now_value = datetime.now(timezone.utc)
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM scheduled_terminal_callback_results WHERE owner_id = ? AND work_id = ?",
                (str(owner_id), str(work_id)),
            ).fetchone()
            lease_until = self._parse_terminal_instant(row["effect_lease_until"]) if row else None
            exact = bool(
                row and int(row["result_revision"] or 0) == result_revision
                and str(row["result_digest"] or "") == str(result_digest)
                and str(row["effect_state"] or "") == "applying"
                and hmac.compare_digest(str(row["effect_lease_token"] or ""), str(lease_token or ""))
                and lease_until is not None and lease_until > now_value
            )
            cursor = conn.execute(
                """
                UPDATE scheduled_terminal_callback_results
                SET effect_state = 'committed', effect_lease_token = '',
                    effect_lease_until = NULL, updated_at = ?
                WHERE owner_id = ? AND work_id = ? AND result_revision = ?
                  AND result_digest = ? AND effect_state = 'applying' AND effect_lease_token = ?
                """,
                (now_value.isoformat(), str(owner_id), str(work_id), result_revision,
                 str(result_digest), str(lease_token)),
            ) if exact else None
            conn.execute("COMMIT")
        changed = bool(cursor is not None and cursor.rowcount == 1)
        if changed:
            self._sync_to_mirror()
        return changed

    def release_scheduled_terminal_callback_effect(
        self,
        *,
        owner_id: str,
        work_id: str,
        result_revision: int,
        result_digest: str,
        lease_token: str,
    ) -> bool:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.execute(
                """
                UPDATE scheduled_terminal_callback_results
                SET effect_state = 'pending', effect_lease_token = '',
                    effect_lease_until = NULL, updated_at = ?
                WHERE owner_id = ? AND work_id = ? AND result_revision = ?
                  AND result_digest = ? AND effect_state = 'applying' AND effect_lease_token = ?
                """,
                (datetime.now(timezone.utc).isoformat(), str(owner_id), str(work_id),
                 result_revision, str(result_digest), str(lease_token)),
            )
            conn.execute("COMMIT")
        if cursor.rowcount:
            self._sync_to_mirror()
        return cursor.rowcount == 1

    def get_scheduled_terminal_callback_result(
        self, *, owner_id: str, work_id: str
    ) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_terminal_callback_results WHERE owner_id = ? AND work_id = ?",
                (str(owner_id), str(work_id)),
            ).fetchone()
        return dict(row) if row is not None else None

    def link_scheduled_prompt_glasshive_run(
        self,
        run_id: str,
        glasshive_run_id: str,
        *,
        queued_summary: str,
        updated_at: str,
    ) -> Optional[Dict[str, Any]]:
        """Link dispatch identity without overwriting an already-terminal callback."""

        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT status FROM scheduled_prompt_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            if row is None:
                conn.execute("ROLLBACK")
                return None
            if str(row["status"] or "") in {"completed", "failed"}:
                conn.execute(
                    """
                    UPDATE scheduled_prompt_runs
                    SET glasshive_run_id = ?, updated_at = ?
                    WHERE run_id = ?
                    """,
                    (glasshive_run_id, updated_at, run_id),
                )
            else:
                conn.execute(
                    """
                    UPDATE scheduled_prompt_runs
                    SET status = 'queued', glasshive_run_id = ?, result_summary = ?, updated_at = ?
                    WHERE run_id = ?
                    """,
                    (glasshive_run_id, queued_summary, updated_at, run_id),
                )
            linked = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            conn.execute("COMMIT")
        self._sync_to_mirror()
        return self._row_to_scheduled_prompt_run(linked)

    def get_scheduled_prompt_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        return self._row_to_scheduled_prompt_run(row)

    def get_scheduled_prompt_run_by_occurrence_key(
        self, occurrence_key: str
    ) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE occurrence_key = ?",
                (occurrence_key,),
            ).fetchone()
        return self._row_to_scheduled_prompt_run(row)

    def get_scheduled_prompt_run_by_glasshive_run(self, glasshive_run_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE glasshive_run_id = ?",
                (glasshive_run_id,),
            ).fetchone()
        return self._row_to_scheduled_prompt_run(row)

    def list_scheduled_prompt_runs(
        self,
        *,
        definition_id: Optional[str] = None,
        task_id: Optional[str] = None,
        trigger_kind: Optional[str] = None,
        trigger_source: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Dict[str, Any]]:
        clauses: list[str] = []
        params: list[Any] = []
        if definition_id:
            clauses.append("definition_id = ?")
            params.append(definition_id)
        if task_id:
            clauses.append("task_id = ?")
            params.append(task_id)
        if trigger_kind:
            clauses.append("trigger_kind = ?")
            params.append(trigger_kind)
        if trigger_source:
            clauses.append("trigger_source = ?")
            params.append(trigger_source)
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.extend([limit, offset])
        with self._connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM scheduled_prompt_runs
                {where}
                ORDER BY COALESCE(started_at, created_at) DESC
                LIMIT ? OFFSET ?
                """,
                params,
            ).fetchall()
        return [self._row_to_scheduled_prompt_run(row) for row in rows if row]

    def _row_to_scheduled_prompt_definition(self, row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
        if row is None:
            return None
        data = dict(row)
        data["schedule"] = json.loads(data.pop("schedule_json"))
        metadata_json = data.pop("metadata_json")
        data["metadata"] = json.loads(metadata_json) if metadata_json else None
        data["active"] = bool(data.get("active"))
        return data

    def _row_to_scheduled_prompt_version(self, row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
        if row is None:
            return None
        data = dict(row)
        snapshot_json = data.get("variable_snapshot_json")
        data["variable_snapshot"] = json.loads(snapshot_json) if snapshot_json else None
        return data

    def _row_to_scheduled_prompt_run(self, row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
        if row is None:
            return None
        return self._row_to_scheduled_prompt_run_dict(dict(row))

    @staticmethod
    def _row_to_scheduled_prompt_run_dict(data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if data is None:
            return None
        data = dict(data)
        callback_json = data.get("callback_payload_json")
        data["callback_payload"] = json.loads(callback_json) if callback_json else None
        execution_json = data.get("execution_snapshot_json")
        data["execution_snapshot"] = json.loads(execution_json) if execution_json else None
        channel_json = data.get("channel_outcomes_json")
        data["channel_outcomes"] = json.loads(channel_json) if channel_json else None
        return data
    # === VIVENTIUM NOTE ===

    def _row_to_task(self, row: Optional[sqlite3.Row]) -> Optional[Dict[str, Any]]:
        if row is None:
            return None
        data = dict(row)
        data["schedule"] = json.loads(data.pop("schedule_json"))
        # === VIVENTIUM NOTE ===
        # Feature: Deserialize stored channel lists.
        data["channel"] = self._deserialize_channel(data.get("channel"))
        # === VIVENTIUM NOTE ===
        metadata_json = data.pop("metadata_json")
        data["metadata"] = json.loads(metadata_json) if metadata_json else None
        # === VIVENTIUM NOTE ===
        # Feature: Expose parsed delivery ledger to MCP callers.
        last_delivery_json = data.pop("last_delivery_json", None)
        data["last_delivery"] = json.loads(last_delivery_json) if last_delivery_json else None
        # === VIVENTIUM NOTE ===
        if not data.get("conversation_policy"):
            data["conversation_policy"] = "new"
        if not data.get("executor"):
            data["executor"] = "viventium_agent"
        return data
