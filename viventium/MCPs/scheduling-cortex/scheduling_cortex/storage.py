from __future__ import annotations

import json
import logging
import os
import shutil
import sqlite3
from dataclasses import dataclass
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
        # === VIVENTIUM NOTE ===

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
        # === VIVENTIUM NOTE ===
        schedule_json = json.dumps(payload.pop("schedule"))
        metadata_json = json.dumps(payload.pop("metadata", None))
        with self._connect() as conn:
            conn.execute(
                """
                INSERT INTO scheduled_tasks (
                  id, user_id, agent_id, prompt, schedule_json, channel,
                  conversation_policy, conversation_id, last_conversation_id,
                  active, created_by, created_source, created_at, updated_at,
                  updated_by, updated_source, last_run_at, next_run_at, last_status, last_error,
                  last_delivery_outcome, last_delivery_reason, last_delivery_at, last_generated_text,
                  last_delivery_json, metadata_json
                ) VALUES (
                  :id, :user_id, :agent_id, :prompt, :schedule_json, :channel,
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
        return data
