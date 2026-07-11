from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
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
    # === VIVENTIUM END ===


logger = logging.getLogger(__name__)
_LOCAL_PATH_RE = re.compile(r"(?:/Users|/home|/private/var|/var/folders)/[^\s`'\"<>]+")
_URL_RE = re.compile(r"https?:\/\/[^\s`'\"<>)]*", re.IGNORECASE)
_MONGO_URI_RE = re.compile(r"mongodb(?:\+srv)?:\/\/[^\s`'\"<>]+", re.IGNORECASE)
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE)


class ScheduleStorage:
    def __init__(self, config: StorageConfig) -> None:
        self._db_path = Path(config.db_path).expanduser()
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        # === VIVENTIUM NOTE ===
        # Feature: Mirror SQLite DB to shared storage without locking issues.
        self._mirror_path = (
            Path(config.mirror_db_path).expanduser()
            if config.mirror_db_path
            else None
        )
        if self._mirror_path:
            self._mirror_path.parent.mkdir(parents=True, exist_ok=True)
            self._restore_from_mirror()
        # === VIVENTIUM NOTE ===
        self._init_db()
        # === VIVENTIUM NOTE ===
        # Feature: Ensure mirror contains initialized DB.
        self._sync_to_mirror()
        # === VIVENTIUM NOTE ===

    @property
    def db_path(self) -> str:
        return str(self._db_path)

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self._db_path, timeout=30, check_same_thread=False)
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
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
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
        self._sanitize_existing_scheduled_prompt_runs(conn)
        self._sanitize_existing_scheduled_prompt_snapshots(conn)
        self._reconcile_stale_scheduled_prompt_runs(conn)
        # === VIVENTIUM NOTE ===

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
        cursor = conn.execute(
            """
            UPDATE scheduled_prompt_runs
            SET status = 'failed',
                completed_at = COALESCE(completed_at, ?),
                error_class = 'stale_run_reconciled',
                result_summary = 'Run did not reach a terminal callback before the recovery window.',
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
        try:
            if not self._db_path.exists():
                tmp_path = self._db_path.with_suffix(self._db_path.suffix + ".tmp")
                shutil.copy2(self._mirror_path, tmp_path)
                os.replace(tmp_path, self._db_path)
                return
            mirror_mtime = self._mirror_path.stat().st_mtime
            local_mtime = self._db_path.stat().st_mtime
            if mirror_mtime > local_mtime:
                tmp_path = self._db_path.with_suffix(self._db_path.suffix + ".tmp")
                shutil.copy2(self._mirror_path, tmp_path)
                os.replace(tmp_path, self._db_path)
        except Exception as exc:
            logger.warning(
                "Failed to restore scheduling DB from mirror %s: %s", self._mirror_path, exc
            )

    def _sync_to_mirror(self) -> None:
        if not self._mirror_path:
            return
        if not self._db_path.exists():
            return
        try:
            tmp_path = self._mirror_path.with_suffix(self._mirror_path.suffix + ".tmp")
            shutil.copy2(self._db_path, tmp_path)
            os.replace(tmp_path, self._mirror_path)
        except Exception as exc:
            logger.warning(
                "Failed to sync scheduling DB to mirror %s: %s", self._mirror_path, exc
            )
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
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scheduled_prompt_runs (
                  run_id, task_id, definition_id, user_id, version_id, due_at,
                  started_at, completed_at, status, executor, rendered_hash,
                  variable_snapshot_hash, glasshive_project_id, glasshive_worker_id,
                  glasshive_run_id, result_summary, error_class, private_detail_path,
                  callback_payload_json, created_at, updated_at
                ) VALUES (
                  :run_id, :task_id, :definition_id, :user_id, :version_id, :due_at,
                  :started_at, :completed_at, :status, :executor, :rendered_hash,
                  :variable_snapshot_hash, :glasshive_project_id, :glasshive_worker_id,
                  :glasshive_run_id, :result_summary, :error_class, :private_detail_path,
                  :callback_payload_json, :created_at, :updated_at
                )
                """,
                run,
            )
        self._sync_to_mirror()
        return run

    def update_scheduled_prompt_run(self, run_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not updates:
            return self.get_scheduled_prompt_run(run_id)
        payload = dict(updates)
        assignments = ", ".join([f"{key} = ?" for key in payload.keys()])
        params = list(payload.values()) + [run_id]
        with self._connect() as conn:
            conn.execute(
                f"UPDATE scheduled_prompt_runs SET {assignments} WHERE run_id = ?",
                params,
            )
        self._sync_to_mirror()
        return self.get_scheduled_prompt_run(run_id)

    def get_scheduled_prompt_run(self, run_id: str) -> Optional[Dict[str, Any]]:
        with self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?",
                (run_id,),
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
        data = dict(row)
        callback_json = data.get("callback_payload_json")
        data["callback_payload"] = json.loads(callback_json) if callback_json else None
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
