from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import shutil
import sqlite3
import sys
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Union

from .scheduled_failure_contract import load_scheduled_failure_contract


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
ACTIVE_SCHEDULED_PROMPT_RUN_STATUSES = (
    "claimed",
    "dispatching",
    "queued",
    "running",
    "waiting_external",
)
TERMINAL_SCHEDULED_PROMPT_RUN_STATUSES = (
    "completed",
    "failed",
    "cancelled",
    "missed",
)
DEFAULT_SCHEDULED_PROMPT_RECOVERY_SECONDS = 15 * 60
DEFAULT_EXTERNAL_WORK_STALE_SECONDS = 24 * 60 * 60
SCHEDULER_DEFERRED_OCCURRENCE_KEY = "scheduler_deferred_occurrence_v1"
SCHEDULER_MISFIRE_KEY = "scheduler_misfire"
NON_STRUCTURAL_SCHEDULE_METADATA_KEYS = frozenset(
    {
        SCHEDULER_DEFERRED_OCCURRENCE_KEY,
        SCHEDULER_MISFIRE_KEY,
        "recurrence_state_v1",
        "scheduled_failure_state_v1",
        "heartbeat_quiet_streak",
        "heartbeat_last_pulse_at",
    }
)

# Keep stale-run recovery independent of the dispatch module. Importing dispatch pulls in the
# parent runtime prompt contract, which is not present in a standalone LibreChat checkout.
SCHEDULED_RUNTIME_FAILURE_RETRYABILITY = {
    "provider_auth_projection_unavailable": False,
    "provider_content_filter": False,
    "provider_context_limit_exceeded": False,
    "provider_request_rejected": False,
    "provider_response_failed": True,
    "provider_unavailable": True,
    "glasshive_runtime_unavailable": True,
    "glasshive_worker_quota_exceeded": False,
    "host_capacity": True,
    "orphaned_user_not_found": False,
    "parallel_execution_isolation_required": False,
    "runtime_dependency_missing": False,
    "runtime_io_failed": True,
    "runtime_sandbox_unavailable": True,
    "scheduler_gateway_unavailable": True,
    "unsupported_runtime_configuration": False,
}
SCHEDULED_PROVIDER_ROUTE_DECISIONS = frozenset(
    {
        "fallback_selected",
        "fallback_unavailable",
        "primary_selected",
        "skipped_unhealthy",
        "waiting_primary_health",
    }
)
SCHEDULED_FAILURE_CONTRACT = load_scheduled_failure_contract()
SCHEDULED_GENERATION_FAILURE_CLASSES = frozenset(
    {
        *(SCHEDULED_FAILURE_CONTRACT.get("classes") or {}),
        *SCHEDULED_RUNTIME_FAILURE_RETRYABILITY,
    }
)


def _normalized_scheduled_generation_failure_class(value: Any) -> str:
    candidate = str(value or "").strip().lower()
    if candidate in SCHEDULED_GENERATION_FAILURE_CLASSES:
        return candidate
    return "completion_error"


def _resolve_scheduled_failure_transition(
    task: Dict[str, Any],
    error_class: Any,
    failure_retryable: Optional[bool] = None,
) -> Dict[str, Any]:
    normalized = _normalized_scheduled_generation_failure_class(error_class)
    class_contract = (SCHEDULED_FAILURE_CONTRACT.get("classes") or {}).get(normalized) or {}
    retryable = (
        failure_retryable
        if isinstance(failure_retryable, bool)
        else bool(
            class_contract.get(
                "retryable",
                SCHEDULED_RUNTIME_FAILURE_RETRYABILITY.get(normalized, False),
            )
        )
    )
    metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    prior = (
        metadata.get("scheduled_failure_state_v1")
        if isinstance(metadata.get("scheduled_failure_state_v1"), dict)
        else {}
    )
    same_health_epoch = str(task.get("last_status") or "").strip().lower() == "error"
    prior_reported = (
        {
            _normalized_scheduled_generation_failure_class(value)
            for value in (prior.get("reported_failure_classes") or [])
        }
        if same_health_epoch
        else set()
    )
    prior_consecutive = int(prior.get("consecutive_count") or 0) if same_health_epoch else 0
    prior_same_root = (
        int(prior.get("same_root_count") or 0)
        if same_health_epoch and prior.get("error_class") == normalized
        else 0
    )
    consecutive_count = prior_consecutive + 1
    same_root_count = prior_same_root + 1
    schedule_type = str((task.get("schedule") or {}).get("type") or "").strip().lower()
    max_once_attempts = max(
        1, int(SCHEDULED_FAILURE_CONTRACT.get("one_time_max_attempts") or 3)
    )
    if normalized == "orphaned_user_not_found":
        retry_disposition = "terminal_action_required"
    elif schedule_type == "once":
        retry_disposition = (
            "retry_scheduled"
            if retryable and consecutive_count < max_once_attempts
            else "terminal_action_required"
        )
    else:
        retry_disposition = "next_occurrence_only"
    health_epoch = str(prior.get("health_epoch") or "").strip() if same_health_epoch else ""
    if not health_epoch:
        health_epoch = str(
            task.get("_scheduled_prompt_run_id") or task.get("last_run_at") or "failure"
        )
    return {
        "version": 1,
        "error_class": normalized,
        "retryable": retryable,
        "retry_disposition": retry_disposition,
        "coalescing_key": f"{task.get('id') or 'schedule'}:{health_epoch}:{normalized}",
        "health_epoch": health_epoch,
        "consecutive_count": consecutive_count,
        "same_root_count": same_root_count,
        "reported_failure_classes": sorted(prior_reported),
        "already_reported_in_health_epoch": normalized in prior_reported,
    }


def default_scheduling_db_path() -> str:
    """Resolve the one standalone/local scheduling database used by every owner."""
    state_root = str(os.getenv("VIVENTIUM_STATE_ROOT") or "").strip()
    if state_root:
        return str(Path(state_root).expanduser() / "scheduling" / "schedules.db")
    configured_root = str(os.getenv("VIVENTIUM_APP_SUPPORT_DIR") or "").strip()
    if configured_root:
        app_support_root = Path(configured_root).expanduser()
    elif sys.platform == "darwin":
        app_support_root = Path.home() / "Library" / "Application Support" / "Viventium"
    elif sys.platform == "win32":
        local_app_data = str(os.getenv("LOCALAPPDATA") or "").strip()
        app_support_root = (
            Path(local_app_data) / "Viventium"
            if local_app_data
            else Path.home() / "AppData" / "Local" / "Viventium"
        )
    else:
        xdg_data_home = str(os.getenv("XDG_DATA_HOME") or "").strip()
        app_support_root = (
            Path(xdg_data_home) / "Viventium"
            if xdg_data_home
            else Path.home() / ".local" / "share" / "Viventium"
        )
    return str(
        app_support_root
        / "state"
        / "runtime"
        / "isolated"
        / "scheduling"
        / "schedules.db"
    )


def scheduled_prompt_stale_seconds(
    default: int = DEFAULT_EXTERNAL_WORK_STALE_SECONDS,
) -> int:
    try:
        return max(
            1,
            int(os.getenv("SCHEDULING_STALE_PROMPT_RUN_SECONDS") or default),
        )
    except ValueError:
        return default


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
                  metadata_json TEXT,
                  structural_fingerprint TEXT NOT NULL DEFAULT ''
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
            conn.execute(
                """
                CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_structural_fingerprint
                ON scheduled_tasks(user_id, structural_fingerprint)
                WHERE structural_fingerprint != ''
                """
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
        if "structural_fingerprint" not in existing:
            conn.execute(
                "ALTER TABLE scheduled_tasks "
                "ADD COLUMN structural_fingerprint TEXT NOT NULL DEFAULT ''"
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
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        # === VIVENTIUM START ===
        # Feature: Receiver-owned monotonic GlassHive terminal callback authority.
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
        # === VIVENTIUM END ===
        run_columns = {
            row["name"] for row in conn.execute("PRAGMA table_info(scheduled_prompt_runs)").fetchall()
        }
        if "trigger_kind" not in run_columns:
            conn.execute("ALTER TABLE scheduled_prompt_runs ADD COLUMN trigger_kind TEXT")
        if "trigger_source" not in run_columns:
            conn.execute("ALTER TABLE scheduled_prompt_runs ADD COLUMN trigger_source TEXT")
        additive_run_columns = {
            "occurrence_key": "TEXT",
            "lease_owner": "TEXT",
            "lease_until": "TEXT",
            "attempt": "INTEGER NOT NULL DEFAULT 0",
            "disposition": "TEXT",
            "execution_snapshot_json": "TEXT",
            "channel_outcomes_json": "TEXT",
            "interaction_ref": "TEXT",
        }
        for column, declaration in additive_run_columns.items():
            if column not in run_columns:
                conn.execute(
                    f"ALTER TABLE scheduled_prompt_runs ADD COLUMN {column} {declaration}"
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
        # === VIVENTIUM START ===
        # Feature: Durable per-part delivery claims for non-idempotent transports.
        # Purpose: A process crash after Telegram accepts a message but before the
        # scheduler stores its response must not cause an automatic duplicate send.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS scheduled_prompt_deliveries (
              delivery_key TEXT PRIMARY KEY,
              run_id TEXT NOT NULL,
              occurrence_key TEXT,
              channel TEXT NOT NULL,
              part_index INTEGER NOT NULL,
              payload_hash TEXT NOT NULL,
              state TEXT NOT NULL,
              lease_owner TEXT,
              lease_until TEXT,
              message_id TEXT,
              sent_at TEXT,
              unknown_at TEXT,
              error_class TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              UNIQUE(run_id, channel, part_index)
            )
            """
        )
        conn.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_scheduled_prompt_deliveries_run
            ON scheduled_prompt_deliveries(run_id, channel, part_index)
            """
        )
        # === VIVENTIUM END ===
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
    def _trusted_terminal_failure_evidence(value: Any) -> Dict[str, Any]:
        if isinstance(value, str):
            try:
                payload = json.loads(value)
            except (TypeError, json.JSONDecodeError):
                return {}
        else:
            payload = value
        if not isinstance(payload, dict) or payload.get("event") != "run.failed":
            return {}

        failure_class = str(
            payload.get("failure_class") or payload.get("failure_code") or ""
        ).strip().lower()
        if (
            not failure_class
            or _normalized_scheduled_generation_failure_class(failure_class)
            != failure_class
        ):
            return {}
        evidence: Dict[str, Any] = {"failure_class": failure_class}
        retryable = payload.get("failure_retryable")
        if isinstance(retryable, bool):
            evidence["failure_retryable"] = retryable
        route_decision = str(payload.get("provider_route_decision") or "").strip()
        if route_decision in SCHEDULED_PROVIDER_ROUTE_DECISIONS:
            evidence["provider_route_decision"] = route_decision
        return evidence

    @staticmethod
    def _failure_transition_snapshot(
        task: Dict[str, Any], evidence: Dict[str, Any]
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        transition = _resolve_scheduled_failure_transition(
            task,
            evidence["failure_class"],
            evidence.get("failure_retryable"),
        )
        compact = {
            "version": 1,
            "error_class": transition["error_class"],
            "retryable": transition["retryable"],
            "retry_disposition": transition["retry_disposition"],
        }
        return transition, compact

    @classmethod
    def _reconcile_stale_scheduled_prompt_runs(
        cls,
        conn: sqlite3.Connection,
        *,
        now: Optional[datetime] = None,
        task_id: Optional[str] = None,
        exclude_run_id: Optional[str] = None,
    ) -> None:
        # === VIVENTIUM START ===
        # Keep the persisted audit disposition consistent with an already-terminal run.
        if task_id is None:
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
        stale_seconds = cls._scheduled_prompt_stale_seconds()
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        cutoff = now - timedelta(seconds=stale_seconds)
        now_iso = now.isoformat().replace("+00:00", "Z")
        cutoff_iso = cutoff.isoformat().replace("+00:00", "Z")
        scope = ""
        params: list[Any] = [cutoff_iso]
        if task_id is not None:
            scope += (
                " AND runs.task_id = ?"
                " AND runs.lease_until IS NOT NULL"
                " AND julianday(runs.lease_until) > julianday(?)"
            )
            params.extend((task_id, now_iso))
        if exclude_run_id is not None:
            scope += " AND runs.run_id != ?"
            params.append(exclude_run_id)
        stale_runs = conn.execute(
            f"""
            SELECT runs.*, terminal.payload_json AS terminal_payload_json
            FROM scheduled_prompt_runs AS runs
            LEFT JOIN scheduled_terminal_callback_results AS terminal
              ON terminal.owner_id = runs.user_id
             AND terminal.work_id = runs.run_id
            WHERE runs.status IN ('claimed', 'dispatching', 'queued', 'running', 'waiting_external')
              AND COALESCE(runs.updated_at, runs.started_at, runs.created_at) < ?
              {scope}
            """,
            params,
        ).fetchall()
        reconciled_count = 0
        for run in stale_runs:
            run_data = dict(run)
            evidence = cls._trusted_terminal_failure_evidence(
                run["terminal_payload_json"]
            )
            if cls._has_bound_external_worker(run_data) and not evidence:
                continue
            if cls._has_live_external_work_lease(run_data, now):
                continue
            failure_class = evidence.get("failure_class") or "stale_run_reconciled"
            summary = (
                f"Recovered signed terminal worker failure ({failure_class})."
                if evidence
                else "Run did not reach a terminal callback before the recovery window."
            )
            execution_json = str(run["execution_snapshot_json"] or "{}")
            try:
                execution_snapshot = json.loads(execution_json)
            except json.JSONDecodeError:
                execution_snapshot = {}
            if not isinstance(execution_snapshot, dict):
                execution_snapshot = {}
            callback_payload_json = run["callback_payload_json"]
            task_row = conn.execute(
                "SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?",
                (run["task_id"], run["user_id"]),
            ).fetchone()
            task = (
                {
                    "id": task_row["id"],
                    "schedule": json.loads(task_row["schedule_json"]),
                    "metadata": json.loads(task_row["metadata_json"] or "{}"),
                    "last_status": task_row["last_status"],
                }
                if task_row is not None
                else {"id": run["task_id"], "schedule": {"type": "daily"}}
            )
            task_metadata = dict(task.get("metadata") or {})
            delivery = {
                "outcome": "failed",
                "reason": failure_class,
                "scheduled_prompt_run_id": run["run_id"],
                "glasshive_run_id": run["glasshive_run_id"],
            }
            if evidence:
                transition, compact = cls._failure_transition_snapshot(
                    task, evidence
                )
                execution_snapshot["scheduled_failure_state_v1"] = compact
                if evidence.get("provider_route_decision"):
                    execution_snapshot["provider_route_decision"] = evidence[
                        "provider_route_decision"
                    ]
                callback_payload_json = json.dumps(
                    {
                        "event": "run.failed",
                        "status": "failed",
                        "recovered_from_terminal_callback": True,
                        **evidence,
                    }
                )
                task_metadata["scheduled_failure_state_v1"] = transition
                delivery["failure_transition_v1"] = transition
            parent_started_at = (
                cls._parse_utc_instant(task_row["last_run_at"])
                if task_row is not None and task_row["last_run_at"]
                else None
            )
            run_started_at = cls._parse_utc_instant(run["started_at"])
            owns_parent_occurrence = (
                task_row is not None
                and str(task_row["last_status"] or "").strip() == "running"
                and (
                    not task_row["last_run_at"]
                    or (
                        parent_started_at is not None
                        and run_started_at is not None
                        and parent_started_at == run_started_at
                    )
                )
            )
            if owns_parent_occurrence:
                conn.execute(
                    """
                    UPDATE scheduled_tasks
                    SET last_status = 'error', last_error = ?,
                        last_delivery_outcome = 'failed', last_delivery_reason = ?,
                        last_delivery_at = ?, last_delivery_json = ?, metadata_json = ?,
                        updated_at = ?
                    WHERE id = ? AND user_id = ?
                    """,
                    (
                        failure_class,
                        failure_class,
                        now_iso,
                        json.dumps(delivery),
                        json.dumps(task_metadata),
                        now_iso,
                        run["task_id"],
                        run["user_id"],
                    ),
                )
            conn.execute(
                """
                UPDATE scheduled_prompt_runs
                SET status = 'failed', completed_at = COALESCE(completed_at, ?),
                    error_class = ?, result_summary = ?, disposition = 'failed',
                    lease_owner = NULL, lease_until = NULL,
                    execution_snapshot_json = ?, callback_payload_json = ?, updated_at = ?
                WHERE run_id = ? AND user_id = ?
                """,
                (
                    now_iso,
                    failure_class,
                    summary,
                    json.dumps(execution_snapshot),
                    callback_payload_json,
                    now_iso,
                    run["run_id"],
                    run["user_id"],
                ),
            )
            reconciled_count += 1
        if reconciled_count:
            logger.info("Reconciled %s stale scheduled prompt run(s)", reconciled_count)

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

    @classmethod
    def _structural_fingerprint(cls, task: Dict[str, Any]) -> str:
        channels = task.get("channel")
        if isinstance(channels, str):
            decoded = cls._deserialize_channel(channels)
            channels = decoded if isinstance(decoded, list) else [decoded]
        elif not isinstance(channels, (list, tuple, set)):
            channels = []
        metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
        structural_metadata = {
            key: value
            for key, value in metadata.items()
            if key not in NON_STRUCTURAL_SCHEDULE_METADATA_KEYS
        }
        body = {
            "version": 1,
            "user_id": str(task.get("user_id") or ""),
            "agent_id": str(task.get("agent_id") or ""),
            "prompt": str(task.get("prompt") or ""),
            "schedule": task.get("schedule") or {},
            "channel": sorted(str(value) for value in channels if value),
            "executor": str(task.get("executor") or "viventium_agent"),
            "conversation_policy": str(task.get("conversation_policy") or "new"),
            "conversation_id": str(task.get("conversation_id") or ""),
            "metadata": structural_metadata,
        }
        canonical = json.dumps(body, separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
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
        structural_fingerprint = self._structural_fingerprint(task)
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
        payload["structural_fingerprint"] = structural_fingerprint
        stored_task: Dict[str, Any] | None = None
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute(
                """
                SELECT * FROM scheduled_tasks
                WHERE user_id = ? AND structural_fingerprint = ?
                LIMIT 1
                """,
                (str(task.get("user_id") or ""), structural_fingerprint),
            ).fetchone()
            if existing is None:
                legacy_rows = conn.execute(
                    """
                    SELECT * FROM scheduled_tasks
                    WHERE user_id = ? AND agent_id = ?
                    """,
                    (str(task.get("user_id") or ""), str(task.get("agent_id") or "")),
                ).fetchall()
                for legacy_row in legacy_rows:
                    legacy_task = self._row_to_task(legacy_row)
                    if legacy_task and self._structural_fingerprint(legacy_task) == structural_fingerprint:
                        existing = legacy_row
                        break
            if existing is not None:
                stored_task = self._row_to_task(existing)
            else:
                conn.execute(
                    """
                    INSERT INTO scheduled_tasks (
                      id, user_id, agent_id, prompt, schedule_json, channel,
                      executor,
                      conversation_policy, conversation_id, last_conversation_id,
                      active, created_by, created_source, created_at, updated_at,
                      updated_by, updated_source, last_run_at, next_run_at, last_status, last_error,
                      last_delivery_outcome, last_delivery_reason, last_delivery_at, last_generated_text,
                      last_delivery_json, metadata_json, structural_fingerprint
                    ) VALUES (
                      :id, :user_id, :agent_id, :prompt, :schedule_json, :channel,
                      :executor,
                      :conversation_policy, :conversation_id, :last_conversation_id,
                      :active, :created_by, :created_source, :created_at, :updated_at,
                      :updated_by, :updated_source, :last_run_at, :next_run_at, :last_status, :last_error,
                      :last_delivery_outcome, :last_delivery_reason, :last_delivery_at, :last_generated_text,
                      :last_delivery_json, :metadata_json, :structural_fingerprint
                    )
                    """,
                    {
                        **payload,
                        "schedule_json": schedule_json,
                        "metadata_json": metadata_json,
                    },
                )
                stored_task = task
        # === VIVENTIUM NOTE ===
        # Feature: Mirror updated DB after writes.
        self._sync_to_mirror()
        # === VIVENTIUM NOTE ===
        return stored_task or task

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
        # Search is a user-facing retrieval operation, so a natural paraphrase must not become a
        # false claim that no schedule exists. Prefer the exact phrase, then require at least two
        # matching lexical terms for multi-word queries. This remains ordinary storage search; it
        # does not infer intent or branch scheduler behavior from prompt text.
        normalized_query = " ".join(str(query or "").strip().casefold().split())

        def like_pattern(value: str) -> str:
            escaped = value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            return f"%{escaped}%"

        lexical_terms: List[str] = []
        for term in "".join(
            character if character.isalnum() else " " for character in normalized_query
        ).split():
            if len(term) < 3 or term in lexical_terms:
                continue
            lexical_terms.append(term)
            if len(lexical_terms) >= 12:
                break

        phrase_pattern = like_pattern(normalized_query)
        token_patterns = [like_pattern(term) for term in lexical_terms]
        clauses = ["user_id = ?"]
        params: List[Any] = [user_id]
        order_params: List[Any] = []
        if token_patterns:
            token_score = " + ".join(
                "CASE WHEN LOWER(prompt) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END"
                for _ in token_patterns
            )
            threshold = min(2, len(token_patterns))
            clauses.append(
                f"(LOWER(prompt) LIKE ? ESCAPE '\\' OR ({token_score}) >= ?)"
            )
            params.extend([phrase_pattern, *token_patterns, threshold])
            order_expression = (
                f"CASE WHEN LOWER(prompt) LIKE ? ESCAPE '\\' THEN 100 ELSE 0 END + "
                f"({token_score})"
            )
            order_params.extend([phrase_pattern, *token_patterns])
        else:
            clauses.append("LOWER(prompt) LIKE ? ESCAPE '\\'")
            params.append(phrase_pattern)
            order_expression = "created_at"
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
        sql = (
            f"SELECT * FROM scheduled_tasks WHERE {where} "
            f"ORDER BY {order_expression} DESC, created_at DESC LIMIT ? OFFSET ?"
        )
        params.extend(order_params)
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
        delivery = payload.get("last_delivery")
        if (
            payload.get("last_status") == "error"
            and isinstance(delivery, dict)
            and delivery.get("outcome") == "failed"
            and (scheduled_run_id := str(delivery.get("scheduled_prompt_run_id") or "").strip())
        ):
            scheduled_run = self.get_scheduled_prompt_run(scheduled_run_id)
            if (
                scheduled_run is not None
                and scheduled_run.get("user_id") == user_id
                and scheduled_run.get("task_id") == task_id
            ):
                evidence = self._trusted_terminal_failure_evidence(
                    scheduled_run.get("callback_payload")
                )
                if evidence.get("failure_class") == scheduled_run.get("error_class"):
                    existing = self.get_task(user_id, task_id)
                    if existing is not None:
                        transition, _ = self._failure_transition_snapshot(existing, evidence)
                        metadata = dict(existing.get("metadata") or {})
                        metadata["scheduled_failure_state_v1"] = transition
                        payload["metadata"] = metadata
                        payload["last_error"] = evidence["failure_class"]
                        payload["last_delivery_reason"] = evidence["failure_class"]
                        payload["last_delivery"] = {
                            **delivery,
                            "reason": evidence["failure_class"],
                            "failure_transition_v1": transition,
                            **(
                                {
                                    "provider_route_decision": evidence[
                                        "provider_route_decision"
                                    ]
                                }
                                if evidence.get("provider_route_decision")
                                else {}
                            ),
                        }
        structural_fields = {
            "agent_id",
            "prompt",
            "schedule",
            "channel",
            "executor",
            "conversation_policy",
            "conversation_id",
            "metadata",
        }
        if structural_fields.intersection(payload):
            existing_task = self.get_task(user_id, task_id)
            if existing_task is None:
                return None
            merged_task = {**existing_task, **payload, "user_id": user_id}
            payload["structural_fingerprint"] = self._structural_fingerprint(merged_task)
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

    def _prepare_scheduled_prompt_run(self, run: Dict[str, Any]) -> Dict[str, Any]:
        payload = dict(run)
        for field in (
            "definition_id",
            "version_id",
            "completed_at",
            "rendered_hash",
            "variable_snapshot_hash",
            "glasshive_project_id",
            "glasshive_worker_id",
            "glasshive_run_id",
            "result_summary",
            "error_class",
            "private_detail_path",
            "callback_payload_json",
        ):
            payload.setdefault(field, None)
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
        return payload

    @staticmethod
    def _insert_scheduled_prompt_run(
        conn: sqlite3.Connection,
        payload: Dict[str, Any],
    ) -> None:
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
            ) VALUES (
              :run_id, :task_id, :definition_id, :user_id, :version_id, :due_at,
              :started_at, :completed_at, :status, :executor, :rendered_hash,
              :variable_snapshot_hash, :glasshive_project_id, :glasshive_worker_id,
              :glasshive_run_id, :result_summary, :error_class, :private_detail_path,
              :callback_payload_json, :trigger_kind, :trigger_source, :occurrence_key,
              :lease_owner, :lease_until, :attempt, :disposition, :execution_snapshot_json,
              :channel_outcomes_json, :interaction_ref, :created_at, :updated_at
            )
            """,
            payload,
        )

    def create_scheduled_prompt_run(self, run: Dict[str, Any]) -> Dict[str, Any]:
        payload = self._prepare_scheduled_prompt_run(run)
        with self._connect() as conn:
            self._insert_scheduled_prompt_run(conn, payload)
        self._sync_to_mirror()
        return payload

    # === VIVENTIUM START ===
    # Feature: Atomic Workbench manual-run receipt and scheduler exclusion lease.
    def claim_manual_scheduled_prompt_run(
        self,
        run: Dict[str, Any],
        *,
        lease_owner: str,
        now: str,
        lease_seconds: int,
    ) -> Dict[str, Any]:
        payload = self._prepare_scheduled_prompt_run(run)
        now_dt = self._parse_utc_instant(now) or datetime.now(timezone.utc)
        now_iso = now_dt.isoformat().replace("+00:00", "Z")
        payload["lease_owner"] = str(lease_owner).strip()
        payload["lease_until"] = (
            now_dt + timedelta(seconds=max(1, int(lease_seconds)))
        ).isoformat().replace("+00:00", "Z")
        payload["attempt"] = max(1, int(payload.get("attempt") or 0))
        claimed = False
        reason = ""
        row: Optional[sqlite3.Row] = None
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = self._active_scheduled_prompt_run_for_task(
                conn,
                task_id=str(payload.get("task_id") or ""),
                now=now_dt,
            )
            if row is not None:
                reason = "task_has_active_occurrence"
            else:
                self._insert_scheduled_prompt_run(conn, payload)
                row = conn.execute(
                    "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?",
                    (str(payload.get("run_id") or ""),),
                ).fetchone()
                claimed = True
                reason = "claimed"
        if claimed:
            self._sync_to_mirror()
        return {
            "claimed": claimed,
            "reason": reason,
            "run": self._row_to_scheduled_prompt_run_dict(dict(row) if row is not None else {}),
        }
    # === VIVENTIUM END ===

    # === VIVENTIUM START ===
    # Feature: Crash-safe scheduled delivery ledger.
    @staticmethod
    def _scheduled_prompt_delivery_key(run_id: str, channel: str, part_index: int) -> str:
        canonical = f"{str(run_id).strip()}\0{str(channel).strip()}\0{int(part_index)}"
        return f"delivery:{hashlib.sha256(canonical.encode('utf-8')).hexdigest()}"

    @staticmethod
    def _parse_utc_instant(value: Any) -> Optional[datetime]:
        try:
            parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)

    def claim_scheduled_prompt_delivery(
        self,
        *,
        run_id: str,
        occurrence_key: Optional[str],
        channel: str,
        part_index: int,
        payload_hash: str,
        lease_owner: str,
        now: str,
        lease_seconds: int,
    ) -> Dict[str, Any]:
        delivery_key = self._scheduled_prompt_delivery_key(run_id, channel, part_index)
        now_dt = self._parse_utc_instant(now) or datetime.now(timezone.utc)
        now_iso = now_dt.isoformat().replace("+00:00", "Z")
        lease_until_iso = (now_dt + timedelta(seconds=max(1, lease_seconds))).isoformat().replace(
            "+00:00", "Z"
        )
        claimed = False
        reason = ""
        row: Optional[sqlite3.Row] = None
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_deliveries WHERE delivery_key = ?",
                (delivery_key,),
            ).fetchone()
            if row is None:
                conn.execute(
                    """
                    INSERT INTO scheduled_prompt_deliveries (
                      delivery_key, run_id, occurrence_key, channel, part_index,
                      payload_hash, state, lease_owner, lease_until, message_id,
                      sent_at, unknown_at, error_class, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?, ?, NULL, NULL, NULL, NULL, ?, ?)
                    """,
                    (
                        delivery_key,
                        str(run_id).strip(),
                        str(occurrence_key or "").strip() or None,
                        str(channel).strip(),
                        int(part_index),
                        str(payload_hash).strip(),
                        str(lease_owner).strip(),
                        lease_until_iso,
                        now_iso,
                        now_iso,
                    ),
                )
                claimed = True
                reason = "claimed"
            else:
                existing = dict(row)
                state = str(existing.get("state") or "").strip()
                if str(existing.get("payload_hash") or "") != str(payload_hash).strip():
                    conn.execute(
                        """
                        UPDATE scheduled_prompt_deliveries
                        SET state = 'delivery_unknown', lease_owner = NULL, lease_until = NULL,
                            unknown_at = COALESCE(unknown_at, ?), error_class = 'payload_conflict',
                            updated_at = ?
                        WHERE delivery_key = ?
                        """,
                        (now_iso, now_iso, delivery_key),
                    )
                    reason = "payload_conflict"
                elif state == "sent":
                    reason = "already_sent"
                elif state == "delivery_unknown":
                    reason = "delivery_unknown"
                else:
                    lease_until = self._parse_utc_instant(existing.get("lease_until"))
                    if lease_until is not None and lease_until > now_dt:
                        reason = "delivery_claim_active"
                    else:
                        conn.execute(
                            """
                            UPDATE scheduled_prompt_deliveries
                            SET state = 'delivery_unknown', lease_owner = NULL, lease_until = NULL,
                                unknown_at = COALESCE(unknown_at, ?),
                                error_class = 'send_receipt_missing_after_lease', updated_at = ?
                            WHERE delivery_key = ?
                            """,
                            (now_iso, now_iso, delivery_key),
                        )
                        reason = "delivery_unknown"
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_deliveries WHERE delivery_key = ?",
                (delivery_key,),
            ).fetchone()
        self._sync_to_mirror()
        return {
            "claimed": claimed,
            "reason": reason,
            "delivery_key": delivery_key,
            "delivery": dict(row) if row is not None else None,
        }

    def complete_scheduled_prompt_delivery(
        self,
        *,
        delivery_key: str,
        lease_owner: str,
        message_id: str,
        now: str,
    ) -> Dict[str, Any]:
        updated = False
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE scheduled_prompt_deliveries
                SET state = 'sent', message_id = ?, sent_at = ?, lease_owner = NULL,
                    lease_until = NULL, error_class = NULL, updated_at = ?
                WHERE delivery_key = ? AND state = 'claimed' AND lease_owner = ?
                """,
                (str(message_id).strip(), now, now, delivery_key, str(lease_owner).strip()),
            )
            updated = cursor.rowcount == 1
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_deliveries WHERE delivery_key = ?",
                (delivery_key,),
            ).fetchone()
        if updated:
            self._sync_to_mirror()
        return {"updated": updated, "delivery": dict(row) if row is not None else None}

    def mark_scheduled_prompt_delivery_unknown(
        self,
        *,
        delivery_key: str,
        lease_owner: str,
        now: str,
        error_class: str,
    ) -> Dict[str, Any]:
        updated = False
        with self._connect() as conn:
            cursor = conn.execute(
                """
                UPDATE scheduled_prompt_deliveries
                SET state = 'delivery_unknown', unknown_at = COALESCE(unknown_at, ?),
                    lease_owner = NULL, lease_until = NULL, error_class = ?, updated_at = ?
                WHERE delivery_key = ? AND state = 'claimed' AND lease_owner = ?
                """,
                (now, str(error_class).strip() or "send_receipt_missing", now, delivery_key, str(lease_owner).strip()),
            )
            updated = cursor.rowcount == 1
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_deliveries WHERE delivery_key = ?",
                (delivery_key,),
            ).fetchone()
        if updated:
            self._sync_to_mirror()
        return {"updated": updated, "delivery": dict(row) if row is not None else None}
    # === VIVENTIUM END ===

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

    @staticmethod
    def _scheduled_prompt_stale_seconds() -> int:
        return scheduled_prompt_stale_seconds(DEFAULT_SCHEDULED_PROMPT_RECOVERY_SECONDS)

    @staticmethod
    def _has_bound_external_worker(run: Dict[str, Any]) -> bool:
        return (
            str(run.get("status") or "").strip() in {"queued", "running"}
            and str(run.get("executor") or "").strip() == "glasshive_host"
            and bool(str(run.get("glasshive_run_id") or "").strip())
            and bool(
                str(run.get("lease_owner") or "").strip()
                or str(run.get("occurrence_key") or "").strip()
            )
        )

    @classmethod
    def _has_live_external_work_lease(
        cls,
        run: Dict[str, Any],
        now: datetime,
    ) -> bool:
        if (
            str(run.get("status") or "") != "waiting_external"
            or not str(run.get("lease_owner") or "").strip()
        ):
            return False
        lease_until = cls._parse_utc_instant(run.get("lease_until"))
        if lease_until is None or lease_until <= now.astimezone(timezone.utc):
            return False

        execution = run.get("execution_snapshot")
        if not isinstance(execution, dict):
            try:
                execution = json.loads(str(run.get("execution_snapshot_json") or "{}"))
            except (TypeError, json.JSONDecodeError):
                return False
        if not isinstance(execution, dict):
            return False
        external = execution.get("external_work")
        if not isinstance(external, dict):
            return False
        try:
            required_total = int(external.get("requiredTotal") or 0)
        except (TypeError, ValueError):
            return False
        return required_total > 0 and external.get("allRequiredTerminal") is not True

    @classmethod
    def _scheduled_prompt_run_is_active(
        cls,
        run: Dict[str, Any],
        now: datetime,
    ) -> bool:
        if str(run.get("status") or "") not in ACTIVE_SCHEDULED_PROMPT_RUN_STATUSES:
            return False
        if cls._has_bound_external_worker(run):
            return True
        now_utc = now.astimezone(timezone.utc)
        heartbeat = cls._parse_utc_instant(
            run.get("updated_at") or run.get("started_at") or run.get("created_at")
        )
        heartbeat_is_fresh = bool(
            heartbeat is not None
            and heartbeat >= now_utc - timedelta(seconds=cls._scheduled_prompt_stale_seconds())
        )
        lease_until = cls._parse_utc_instant(run.get("lease_until"))
        if lease_until is not None and lease_until > now_utc:
            return heartbeat_is_fresh or cls._has_live_external_work_lease(run, now_utc)
        return (
            str(run.get("status") or "") == "waiting_external"
            and run.get("lease_until") is None
            and heartbeat_is_fresh
        )

    @classmethod
    def _active_scheduled_prompt_run_for_task(
        cls,
        conn: sqlite3.Connection,
        *,
        task_id: str,
        now: datetime,
        exclude_run_id: Optional[str] = None,
    ) -> Optional[sqlite3.Row]:
        now_utc = now.astimezone(timezone.utc)
        cls._reconcile_stale_scheduled_prompt_runs(
            conn,
            now=now_utc,
            task_id=task_id,
            exclude_run_id=exclude_run_id,
        )
        now_iso = now_utc.isoformat().replace("+00:00", "Z")
        cutoff_iso = (
            now_utc - timedelta(seconds=cls._scheduled_prompt_stale_seconds())
        ).isoformat().replace("+00:00", "Z")
        placeholders = ", ".join("?" for _ in ACTIVE_SCHEDULED_PROMPT_RUN_STATUSES)
        exclusion = " AND run_id != ?" if exclude_run_id else ""
        params: list[Any] = [
            task_id,
            *ACTIVE_SCHEDULED_PROMPT_RUN_STATUSES,
            now_iso,
            cutoff_iso,
        ]
        if exclude_run_id:
            params.append(exclude_run_id)
        rows = conn.execute(
            f"""
            SELECT * FROM scheduled_prompt_runs
            WHERE task_id = ?
              AND status IN ({placeholders})
              AND (
                (lease_until IS NOT NULL AND julianday(lease_until) > julianday(?))
                OR (
                  status = 'waiting_external'
                  AND lease_until IS NULL
                  AND julianday(COALESCE(updated_at, started_at, created_at)) >= julianday(?)
                )
                OR (
                  status IN ('queued', 'running')
                  AND executor = 'glasshive_host'
                  AND NULLIF(TRIM(glasshive_run_id), '') IS NOT NULL
                  AND (
                    NULLIF(TRIM(lease_owner), '') IS NOT NULL
                    OR NULLIF(TRIM(occurrence_key), '') IS NOT NULL
                  )
                )
              )
              {exclusion}
            ORDER BY COALESCE(lease_until, updated_at, started_at, created_at) DESC
            """,
            params,
        ).fetchall()
        return next(
            (row for row in rows if cls._scheduled_prompt_run_is_active(dict(row), now_utc)),
            None,
        )

    def renew_scheduled_prompt_run_lease(
        self,
        run_id: str,
        *,
        lease_owner: str,
        now: str,
        lease_seconds: int,
    ) -> bool:
        now_dt = self._parse_utc_instant(now) or datetime.now(timezone.utc)
        now_iso = now_dt.isoformat().replace("+00:00", "Z")
        lease_until = (
            now_dt + timedelta(seconds=max(1, int(lease_seconds)))
        ).isoformat().replace("+00:00", "Z")
        placeholders = ", ".join("?" for _ in ACTIVE_SCHEDULED_PROMPT_RUN_STATUSES)
        with self._connect() as conn:
            cursor = conn.execute(
                f"""
                UPDATE scheduled_prompt_runs
                SET lease_until = ?, updated_at = ?
                WHERE run_id = ? AND lease_owner = ?
                  AND status IN ({placeholders})
                """,
                (
                    lease_until,
                    now_iso,
                    str(run_id).strip(),
                    str(lease_owner).strip(),
                    *ACTIVE_SCHEDULED_PROMPT_RUN_STATUSES,
                ),
            )
            updated = cursor.rowcount == 1
        if updated:
            self._sync_to_mirror()
        return updated

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
        reconciled = False
        reason = ""
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            occurrence = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE occurrence_key = ?",
                (occurrence_key,),
            ).fetchone()
            if occurrence is not None:
                occurrence_data = dict(occurrence)
                existing_lease_until = self._parse_utc_instant(occurrence_data.get("lease_until"))
                if (
                    str(occurrence_data.get("status") or "")
                    in ACTIVE_SCHEDULED_PROMPT_RUN_STATUSES
                    and str(occurrence_data.get("status") or "") != "claimed"
                    and str(occurrence_data.get("lease_owner") or "") != str(lease_owner or "")
                    and existing_lease_until is not None
                    and existing_lease_until > now_utc
                    and not self._scheduled_prompt_run_is_active(occurrence_data, now_utc)
                ):
                    self._reconcile_stale_scheduled_prompt_runs(
                        conn,
                        now=now_utc,
                        task_id=task_id,
                    )
                    occurrence_data = dict(
                        conn.execute(
                            "SELECT * FROM scheduled_prompt_runs WHERE occurrence_key = ?",
                            (occurrence_key,),
                        ).fetchone()
                    )
                    reconciled = (
                        str(occurrence_data.get("status") or "")
                        in TERMINAL_SCHEDULED_PROMPT_RUN_STATUSES
                    )
                if self._scheduled_prompt_run_is_active(occurrence_data, now_utc):
                    run = occurrence_data
                    reason = "occurrence_already_claimed"
                elif str(occurrence_data.get("status") or "") in TERMINAL_SCHEDULED_PROMPT_RUN_STATUSES:
                    run = occurrence_data
                    reason = "occurrence_already_terminal"
                elif (
                    str(occurrence_data.get("status") or "")
                    in ACTIVE_SCHEDULED_PROMPT_RUN_STATUSES
                    and str(occurrence_data.get("lease_owner") or "") == str(lease_owner or "")
                ):
                    run = occurrence_data
                    reason = "occurrence_already_claimed"
                else:
                    active = self._active_scheduled_prompt_run_for_task(
                        conn,
                        task_id=task_id,
                        now=now_utc,
                        exclude_run_id=str(occurrence_data.get("run_id") or ""),
                    )
                    if active is not None:
                        run = dict(active)
                        reason = "task_has_active_occurrence"
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
                active = self._active_scheduled_prompt_run_for_task(
                    conn,
                    task_id=task_id,
                    now=now_utc,
                )
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
        if claimed or reconciled:
            self._sync_to_mirror()
        return {
            "claimed": claimed,
            "reason": reason,
            "occurrence_key": occurrence_key,
            "run": self._row_to_scheduled_prompt_run_dict(run),
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
        if str(payload.get("status") or "") in TERMINAL_SCHEDULED_PROMPT_RUN_STATUSES:
            payload["lease_owner"] = None
            payload["lease_until"] = None
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
        """Atomically apply callback state only while its observed lifecycle is still current.

        A callback is verified before this method is called, but another verified callback may
        win between the initial lookup and persistence. Comparing the lifecycle fields inside one
        immediate transaction prevents an older callback from overwriting newer terminal evidence.
        """

        payload = dict(updates)
        if "execution_snapshot" in payload:
            payload["execution_snapshot_json"] = self._json_or_none(
                payload.pop("execution_snapshot")
            )
        if "channel_outcomes" in payload:
            payload["channel_outcomes_json"] = self._json_or_none(
                payload.pop("channel_outcomes")
            )
        if str(payload.get("status") or "") in TERMINAL_SCHEDULED_PROMPT_RUN_STATUSES:
            payload["lease_owner"] = None
            payload["lease_until"] = None

        updated = False
        row = None
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            current = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
            current_matches = bool(
                current is not None
                and str(current["status"] or "") == str(expected_status or "")
                and current["error_class"] == expected_error_class
            )
            if current_matches and payload:
                if str(payload.get("status") or "") == "failed":
                    terminal = conn.execute(
                        """
                        SELECT payload_json FROM scheduled_terminal_callback_results
                        WHERE owner_id = ? AND work_id = ?
                        """,
                        (current["user_id"], run_id),
                    ).fetchone()
                    evidence = self._trusted_terminal_failure_evidence(
                        terminal["payload_json"] if terminal is not None else None
                    )
                    if evidence.get("failure_class") == payload.get("error_class"):
                        summary_json = payload.get("callback_payload_json")
                        try:
                            callback_summary = json.loads(str(summary_json or "{}"))
                        except json.JSONDecodeError:
                            callback_summary = {}
                        if not isinstance(callback_summary, dict):
                            callback_summary = {}
                        payload["callback_payload_json"] = json.dumps(
                            {**callback_summary, **evidence}
                        )
                        try:
                            execution_snapshot = json.loads(
                                str(current["execution_snapshot_json"] or "{}")
                            )
                        except json.JSONDecodeError:
                            execution_snapshot = {}
                        if not isinstance(execution_snapshot, dict):
                            execution_snapshot = {}
                        task_row = conn.execute(
                            "SELECT * FROM scheduled_tasks WHERE id = ? AND user_id = ?",
                            (current["task_id"], current["user_id"]),
                        ).fetchone()
                        task = (
                            self._row_to_task(task_row)
                            if task_row is not None
                            else {"id": current["task_id"], "schedule": {"type": "daily"}}
                        )
                        _, compact = self._failure_transition_snapshot(task, evidence)
                        execution_snapshot["scheduled_failure_state_v1"] = compact
                        if evidence.get("provider_route_decision"):
                            execution_snapshot["provider_route_decision"] = evidence[
                                "provider_route_decision"
                            ]
                        payload["execution_snapshot_json"] = json.dumps(execution_snapshot)
                assignments = ", ".join([f"{key} = ?" for key in payload.keys()])
                conn.execute(
                    f"UPDATE scheduled_prompt_runs SET {assignments} WHERE run_id = ?",
                    list(payload.values()) + [run_id],
                )
                updated = True
            row = conn.execute(
                "SELECT * FROM scheduled_prompt_runs WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        if updated:
            self._sync_to_mirror()
        return {
            "updated": updated,
            "run": self._row_to_scheduled_prompt_run(row),
        }

    # === VIVENTIUM START ===
    # Feature: Receiver-side owner/work terminal callback revision CAS.
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
            if (
                str(payload.get("callback_contract") or "").strip()
                != callback_contract
            ):
                raise ValueError("Terminal callback contract is invalid")
            supplied_owner = str(payload.get("user_id") or "").strip()
            occurrence_key = str(payload.get("occurrence_key") or "").strip()
            callback_id = str(payload.get("callback_id") or "").strip()
            result_digest = str(payload.get("result_digest") or "").strip()
            result_revision = payload.get("result_revision")
            if (
                supplied_owner != clean_owner
                or not occurrence_key
                or re.fullmatch(r"cb_terminal_[0-9a-f]{64}", callback_id) is None
                or not isinstance(result_revision, int)
                or isinstance(result_revision, bool)
                or result_revision < 1
                or result_revision > 9_223_372_036_854_775_807
                or re.fullmatch(r"sha256:[0-9a-f]{64}", result_digest) is None
            ):
                raise ValueError("Terminal callback result identity is invalid")
            return {
                "owner_id": clean_owner,
                "work_id": clean_work,
                "callback_id": callback_id,
                "result_revision": result_revision,
                "result_digest": result_digest,
                "payload_json": json.dumps(
                    payload,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
            }
        supplied_owner = str(payload.get("user_id") or "").strip()
        supplied_message_id = str(payload.get("message_id") or "").strip()
        supplied_scheduled_run_id = str(
            payload.get("scheduled_prompt_run_id") or ""
        ).strip()
        supplied_work = supplied_scheduled_run_id or supplied_message_id
        if (
            supplied_owner != clean_owner
            or supplied_work != clean_work
            or (supplied_message_id and supplied_message_id != clean_work)
            or (supplied_scheduled_run_id and supplied_scheduled_run_id != clean_work)
        ):
            raise ValueError("Terminal callback owner/work scope is not exact")
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
        if attempt_value is None:
            attempt_number = 0
        elif (
            isinstance(attempt_value, int)
            and not isinstance(attempt_value, bool)
            and attempt_value > 0
            and attempt_value <= 9_223_372_036_854_775_807
        ):
            attempt_number = attempt_value
        else:
            raise ValueError("Terminal callback attempt identity is invalid")
        if (
            expected_state is None
            or result_state != expected_state
            or not run_id
            or not ended_at
            or not isinstance(result_revision, int)
            or isinstance(result_revision, bool)
            or result_revision < 1
            or result_revision > 9_223_372_036_854_775_807
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
                payload,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
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
                """
                SELECT * FROM scheduled_terminal_callback_results
                WHERE owner_id = ? AND work_id = ?
                """,
                (identity["owner_id"], identity["work_id"]),
            ).fetchone()
            current_revision = int(current["result_revision"] or 0) if current else 0
            current_lease_until = (
                self._parse_utc_instant(current["effect_lease_until"])
                if current
                else None
            )
            effect_in_progress = bool(
                current
                and str(current["effect_state"] or "") == "applying"
                and current_lease_until is not None
                and current_lease_until > datetime.now(timezone.utc)
            )
            if (
                current is not None
                and identity["result_revision"] > current_revision
                and effect_in_progress
            ):
                status = "effects_in_progress"
            elif current is None or identity["result_revision"] > current_revision:
                status = "accepted"
                conn.execute(
                    """
                    INSERT INTO scheduled_terminal_callback_results (
                      owner_id, work_id, callback_id, result_revision,
                      result_digest, payload_json, effect_state,
                      effect_lease_token, effect_lease_until, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '', NULL, ?)
                    ON CONFLICT(owner_id, work_id) DO UPDATE SET
                      callback_id = excluded.callback_id,
                      result_revision = excluded.result_revision,
                      result_digest = excluded.result_digest,
                      payload_json = excluded.payload_json,
                      effect_state = 'pending',
                      effect_lease_token = '',
                      effect_lease_until = NULL,
                      updated_at = excluded.updated_at
                    WHERE excluded.result_revision
                      > scheduled_terminal_callback_results.result_revision
                    """,
                    (
                        identity["owner_id"],
                        identity["work_id"],
                        identity["callback_id"],
                        identity["result_revision"],
                        identity["result_digest"],
                        identity["payload_json"],
                        now,
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
                """
                SELECT * FROM scheduled_terminal_callback_results
                WHERE owner_id = ? AND work_id = ?
                """,
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
                  owner_id, work_id, callback_id, result_revision,
                  result_digest, status, current_result_revision,
                  current_result_digest, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identity["owner_id"],
                    identity["work_id"],
                    identity["callback_id"],
                    identity["result_revision"],
                    identity["result_digest"],
                    status,
                    current_revision,
                    current_digest,
                    now,
                ),
            )
            conn.execute("COMMIT")
        self._sync_to_mirror()
        return {
            "http_status": (
                425
                if status == "effects_in_progress"
                else 200
                if status in {"accepted", "idempotent", "replay_pending"}
                else 409
            ),
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
        now_iso = now.isoformat()
        lease_until = (now + timedelta(seconds=max(1, lease_seconds))).isoformat()
        lease_token = "receiver_" + uuid.uuid4().hex
        claimed = False
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT * FROM scheduled_terminal_callback_results
                WHERE owner_id = ? AND work_id = ?
                """,
                (str(owner_id), str(work_id)),
            ).fetchone()
            lease_expired = bool(
                row
                and str(row["effect_state"] or "") == "applying"
                and (
                    self._parse_utc_instant(row["effect_lease_until"]) is None
                    or self._parse_utc_instant(row["effect_lease_until"]) <= now
                )
            )
            exact = bool(
                row
                and int(row["result_revision"] or 0) == result_revision
                and str(row["result_digest"] or "") == str(result_digest)
            )
            if exact and (str(row["effect_state"] or "") == "pending" or lease_expired):
                cursor = conn.execute(
                    """
                    UPDATE scheduled_terminal_callback_results
                    SET effect_state = 'applying', effect_lease_token = ?,
                        effect_lease_until = ?, updated_at = ?
                    WHERE owner_id = ? AND work_id = ?
                      AND result_revision = ? AND result_digest = ?
                      AND effect_state != 'committed'
                    """,
                    (
                        lease_token,
                        lease_until,
                        now_iso,
                        str(owner_id),
                        str(work_id),
                        result_revision,
                        str(result_digest),
                    ),
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
                """
                SELECT * FROM scheduled_terminal_callback_results
                WHERE owner_id = ? AND work_id = ?
                """,
                (str(owner_id), str(work_id)),
            ).fetchone()
        lease_until = self._parse_utc_instant(row["effect_lease_until"]) if row else None
        return bool(
            row
            and int(row["result_revision"] or 0) == result_revision
            and str(row["result_digest"] or "") == str(result_digest)
            and str(row["effect_state"] or "") == "applying"
            and hmac.compare_digest(
                str(row["effect_lease_token"] or ""), str(lease_token or "")
            )
            and lease_until is not None
            and lease_until > now
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
        now = now_value.isoformat()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                """
                SELECT * FROM scheduled_terminal_callback_results
                WHERE owner_id = ? AND work_id = ?
                """,
                (str(owner_id), str(work_id)),
            ).fetchone()
            lease_until = self._parse_utc_instant(row["effect_lease_until"]) if row else None
            exact_current_lease = bool(
                row
                and int(row["result_revision"] or 0) == result_revision
                and str(row["result_digest"] or "") == str(result_digest)
                and str(row["effect_state"] or "") == "applying"
                and hmac.compare_digest(
                    str(row["effect_lease_token"] or ""), str(lease_token or "")
                )
                and lease_until is not None
                and lease_until > now_value
            )
            if exact_current_lease:
                cursor = conn.execute(
                    """
                    UPDATE scheduled_terminal_callback_results
                    SET effect_state = 'committed', effect_lease_token = '',
                        effect_lease_until = NULL, updated_at = ?
                    WHERE owner_id = ? AND work_id = ?
                      AND result_revision = ? AND result_digest = ?
                      AND effect_state = 'applying' AND effect_lease_token = ?
                    """,
                    (
                        now,
                        str(owner_id),
                        str(work_id),
                        result_revision,
                        str(result_digest),
                        str(lease_token),
                    ),
                )
            else:
                cursor = None
            conn.execute("COMMIT")
        if cursor is not None and cursor.rowcount:
            self._sync_to_mirror()
        return bool(cursor is not None and cursor.rowcount == 1)

    def release_scheduled_terminal_callback_effect(
        self,
        *,
        owner_id: str,
        work_id: str,
        result_revision: int,
        result_digest: str,
        lease_token: str,
    ) -> bool:
        """Release only the exact current effect lease for a safe receiver retry."""

        now = datetime.now(timezone.utc).isoformat()
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            cursor = conn.execute(
                """
                UPDATE scheduled_terminal_callback_results
                SET effect_state = 'pending', effect_lease_token = '',
                    effect_lease_until = NULL, updated_at = ?
                WHERE owner_id = ? AND work_id = ?
                  AND result_revision = ? AND result_digest = ?
                  AND effect_state = 'applying' AND effect_lease_token = ?
                """,
                (
                    now,
                    str(owner_id),
                    str(work_id),
                    result_revision,
                    str(result_digest),
                    str(lease_token),
                ),
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
                """
                SELECT * FROM scheduled_terminal_callback_results
                WHERE owner_id = ? AND work_id = ?
                """,
                (str(owner_id), str(work_id)),
            ).fetchone()
        return dict(row) if row is not None else None
    # === VIVENTIUM END ===

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
