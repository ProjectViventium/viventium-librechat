from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import calendar
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

SCHEDULED_RUN_CONTEXT_CONTRACT_LINE = (
    "Use `scheduled_due_local_date` as the anchor date for this run. Do not carry forward dates "
    "or day labels from earlier messages in the conversation, and do not use the next recurrence "
    "as today's date."
)

# === VIVENTIUM START ===
# Feature: Multi-channel dispatch support.
from .models import AVAILABLE_CHANNELS, DEFAULT_DELIVERY_CHANNELS
from .glasshive_assertions import ASSERTION_HEADER, mint_workspace_run_assertion
from .storage import ScheduleStorage, StorageConfig
from .utils import ensure_timezone, parse_iso, to_utc_iso
from .workbench_artifacts import (
    isolated_periphery_contract,
    rebase_isolated_workbench_text,
)
# === VIVENTIUM END ===

# === VIVENTIUM NOTE ===
# Feature: Markdown → Telegram HTML conversion (replaces fragile MarkdownV2).
# HTML only needs 3 characters escaped (<, >, &) vs MarkdownV2's 17.
# === VIVENTIUM NOTE ===

# === VIVENTIUM NOTE ===
# Feature: No-response tag ({NTA}) suppression for scheduled dispatch.
def _find_shared_path(start_path: Path) -> Optional[Path]:
    for parent in [start_path] + list(start_path.parents):
        candidate = parent / "shared"
        if (candidate / "scheduler_prompt_contract.py").is_file():
            return candidate
    return None


_SHARED_PATH = _find_shared_path(Path(__file__).resolve())  # .../viventium_v0_4/shared
if _SHARED_PATH and str(_SHARED_PATH) not in sys.path:
    sys.path.insert(0, str(_SHARED_PATH))

from scheduler_prompt_contract import (
    CONSCIOUSNESS_CONTINUITY_OPPORTUNITY_PROMPT_ID,
    SCHEDULER_RUN_ENVELOPE_PROMPT_ID,
    SCHEDULER_RUN_ENVELOPE_TEMPLATE,
    render_scheduler_run_envelope,
)

_ENVELOPE_LINES = SCHEDULER_RUN_ENVELOPE_TEMPLATE.splitlines()
BREW_PROMPT_MARKER = _ENVELOPE_LINES[0]
BREW_PROMPT_HEADER = _ENVELOPE_LINES[1]
SCHEDULED_RUN_CONTEXT_HEADER = next(
    line for line in _ENVELOPE_LINES if line.startswith("## Scheduled Run Context")
)
LIVE_FACT_CONTRACT_LINE = next(
    line for line in _ENVELOPE_LINES if line.startswith("For live external facts")
)
DEFAULT_SCHEDULER_PROMPT_PREFIX = SCHEDULER_RUN_ENVELOPE_TEMPLATE.split(
    f"\n\n{SCHEDULED_RUN_CONTEXT_HEADER}", 1
)[0]

try:
    from no_response import is_no_response_only, strip_trailing_nta
    from insights import format_insights_fallback_text
    from internal_surface_artifacts import strip_internal_surface_artifacts
except Exception:
    _NO_RESPONSE_TAG_RE = re.compile(r"^\s*\{\s*NTA\s*\}\s*$", re.IGNORECASE)
    _NO_RESPONSE_PHRASES = {
        "nothing new to add.",
        "nothing new to add",
        "nothing to add.",
        "nothing to add",
    }
    _NO_RESPONSE_VARIANT_MAX_LEN = 200
    _NO_RESPONSE_VARIANT_RE = re.compile(
        r"^\s*nothing\s+(?:new\s+)?to\s+add"
        r"(?:\s*(?:\(\s*)?(?:right\s+now|for\s+now|at\s+this\s+time|at\s+the\s+moment|currently|so\s+far|yet|today)(?:\s*\))?)?"
        r"(?:\s*,?\s*(?:sorry|thanks|thank\s+you))?"
        r"\s*[.!?]*\s*$",
        re.IGNORECASE,
    )

    def is_no_response_only(text: Optional[str]) -> bool:
        if not isinstance(text, str):
            return False
        trimmed = text.strip()
        if not trimmed:
            return False
        if _NO_RESPONSE_TAG_RE.match(trimmed):
            return True
        lowered = trimmed.lower()
        if lowered in _NO_RESPONSE_PHRASES:
            return True
        if len(trimmed) <= _NO_RESPONSE_VARIANT_MAX_LEN and _NO_RESPONSE_VARIANT_RE.match(trimmed):
            return True
        return False

    _TRAILING_NTA_RE_FALLBACK = re.compile(r"\s*\{\s*NTA\s*\}\s*$", re.IGNORECASE)

    def strip_trailing_nta(text: Optional[str]) -> str:
        if not isinstance(text, str):
            return text or ""
        if is_no_response_only(text):
            return text
        return _TRAILING_NTA_RE_FALLBACK.sub("", text).rstrip()

    def format_insights_fallback_text(
        insights: Optional[list[Dict[str, Any]]],
        *,
        voice_mode: bool = False,
    ) -> str:
        if not insights:
            return ""
        texts: list[str] = []
        for item in insights:
            if not isinstance(item, dict):
                continue
            text = item.get("insight") or ""
            if not isinstance(text, str):
                continue
            cleaned = text.strip()
            if cleaned:
                texts.append(cleaned)
        if not texts:
            return ""
        return " ".join(texts) if voice_mode else "\n\n".join(texts)

    _FALLBACK_TURN_BLOCK_RE = re.compile(
        r"<turn\b(?P<attrs>[^>]*)>(?P<body>[\s\S]*?)</turn>",
        re.IGNORECASE,
    )
    _FALLBACK_TURN_ROLE_RE = re.compile(
        r"""\brole\s*=\s*(?:"|')?(?P<role>[a-zA-Z_]+)(?:"|')?""",
        re.IGNORECASE,
    )
    _FALLBACK_TURN_TAG_RE = re.compile(r"</?turn\b[^>]*>", re.IGNORECASE)
    _FALLBACK_RECALL_DUMP_BLOCK_RE = re.compile(
        r"""
        (?:^|\n)
        (?:[ \t]*[─—-]{5,}[ \t]*\n)?
        (?:
          [ \t]*Tool:[ \t]*[^\n]*,\s*File:[ \t]*[^\n]+\n
          |(?:[ \t]*Tool:[ \t]*[^\n]*\n)?[ \t]*File:[ \t]*[^\n]+\n
        )
        [ \t]*Anchor:[ \t]*[^\n]+\n
        [ \t]*Relevance:[ \t]*[^\n]+\n
        [ \t]*Content:[ \t]*[\s\S]*?
        (?=
          (?:\n[ \t]*[─—-]{5,}[ \t]*(?:\n|$))
          |(?:\n[ \t]*(?:Tool:[ \t]*[^\n]*,\s*File:[ \t]*[^\n]+|(?:Tool:[ \t]*[^\n]*\n)?[ \t]*File:[ \t]*[^\n]+)\n[ \t]*Anchor:)
          |\Z
        )
        """,
        re.IGNORECASE | re.VERBOSE,
    )
    _FALLBACK_RECALL_META_LINE_RE = re.compile(
        r"(?im)^[ \t]*(?:Tool:[ \t]*[^\n]*,\s*File:[ \t]*[^\n]*|Anchor:[ \t]*[^\n]*|Relevance:[ \t]*[-+]?\d*\.?\d+|Content:[ \t]*(?:<turn\b[^\n]*|$))[ \t]*$",
    )

    def strip_internal_surface_artifacts(
        text: Optional[str],
        *,
        keep_assistant_turn_content: bool = True,
    ) -> str:
        if not isinstance(text, str) or not text:
            return ""

        def _turn_repl(match: re.Match) -> str:
            if not keep_assistant_turn_content:
                return "\n"
            attrs = match.group("attrs") or ""
            body = (match.group("body") or "").strip()
            role_match = _FALLBACK_TURN_ROLE_RE.search(attrs)
            role = (role_match.group("role") if role_match else "").lower()
            if role in {"ai", "assistant", "model"} and body:
                return f"\n{body}\n"
            return "\n"

        cleaned = _FALLBACK_TURN_BLOCK_RE.sub(_turn_repl, text)
        cleaned = _FALLBACK_TURN_TAG_RE.sub(" ", cleaned)
        cleaned = _FALLBACK_RECALL_DUMP_BLOCK_RE.sub("\n", cleaned)
        cleaned = _FALLBACK_RECALL_META_LINE_RE.sub(" ", cleaned)
        cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
        cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
        return cleaned

# === VIVENTIUM NOTE ===


logger = logging.getLogger(__name__)


# Structured provider failures are the only classes the scheduler may persist or fan out.
# Raw provider error prose can contain credentials, request bodies, or private prompts.
SCHEDULED_RUNTIME_PROVIDER_FAILURE_RETRYABILITY = {
    "provider_auth_projection_unavailable": False,
    "provider_content_filter": False,
    "provider_context_limit_exceeded": False,
    "provider_request_rejected": False,
    "provider_response_failed": True,
    "provider_unavailable": True,
}
SCHEDULED_RUNTIME_FAILURE_RETRYABILITY = {
    **SCHEDULED_RUNTIME_PROVIDER_FAILURE_RETRYABILITY,
    "connected_account_action_required": False,
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

_SCHEDULED_FAILURE_CONTRACT_PATH = (
    Path(__file__).resolve().parents[3]
    / "source_of_truth"
    / "scheduled_failure_contract.v1.json"
)
with _SCHEDULED_FAILURE_CONTRACT_PATH.open("r", encoding="utf-8") as _failure_contract_file:
    SCHEDULED_FAILURE_CONTRACT = json.load(_failure_contract_file)
SCHEDULED_GENERATION_FAILURE_CLASSES = frozenset(
    {
        *(SCHEDULED_FAILURE_CONTRACT.get("classes") or {}),
        *SCHEDULED_RUNTIME_FAILURE_RETRYABILITY,
    }
)


def resolve_scheduled_failure_transition(
    task: Dict[str, Any],
    error_class: Any,
    failure_retryable: Optional[bool] = None,
) -> Dict[str, Any]:
    normalized = normalized_scheduled_generation_failure_class(error_class)
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
    prior_reported = {
        normalized_scheduled_generation_failure_class(value)
        for value in (prior.get("reported_failure_classes") or [])
    } if same_health_epoch else set()
    prior_consecutive = int(prior.get("consecutive_count") or 0) if same_health_epoch else 0
    prior_same_root = (
        int(prior.get("same_root_count") or 0)
        if same_health_epoch and prior.get("error_class") == normalized
        else 0
    )
    consecutive_count = prior_consecutive + 1
    same_root_count = prior_same_root + 1
    schedule_type = str((task.get("schedule") or {}).get("type") or "").strip().lower()
    max_once_attempts = max(1, int(SCHEDULED_FAILURE_CONTRACT.get("one_time_max_attempts") or 3))
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
        health_epoch = str(task.get("_scheduled_prompt_run_id") or task.get("last_run_at") or "failure")
    # A prior error is not evidence that its user-visible notice was delivered. The
    # delivery owner adds the current class only after Telegram confirms delivery.
    reported = sorted(prior_reported)
    next_attempt_at = None
    if retry_disposition == "retry_scheduled":
        try:
            attempted_at = parse_iso(
                str(task.get("_scheduled_prompt_attempted_at") or ""),
                ensure_timezone("UTC"),
            )
        except (TypeError, ValueError):
            attempted_at = None
        try:
            retry_delay_s = max(1, int(task.get("_scheduled_prompt_retry_delay_s") or 0))
        except (TypeError, ValueError):
            retry_delay_s = 0
        if attempted_at is not None and retry_delay_s > 0:
            next_attempt_at = to_utc_iso(attempted_at + timedelta(seconds=retry_delay_s))
    return {
        "version": 1,
        "error_class": normalized,
        "retryable": retryable,
        "retry_disposition": retry_disposition,
        "coalescing_key": f"{task.get('id') or 'schedule'}:{health_epoch}:{normalized}",
        "health_epoch": health_epoch,
        "consecutive_count": consecutive_count,
        "same_root_count": same_root_count,
        "reported_failure_classes": reported,
        "already_reported_in_health_epoch": normalized in prior_reported,
        **({"next_attempt_at": next_attempt_at} if next_attempt_at else {}),
    }


def normalized_scheduled_generation_failure_class(value: Any) -> str:
    candidate = str(value or "").strip().lower()
    if candidate in SCHEDULED_GENERATION_FAILURE_CLASSES:
        return candidate
    return "completion_error"


def _extract_scheduled_generation_failure(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if not payload.get("final"):
        return None
    response = payload.get("responseMessage")
    if not isinstance(response, dict):
        return None
    content = response.get("content")
    if isinstance(content, dict):
        content = [content]
    if not isinstance(content, list):
        return None
    for part in reversed(content):
        if not isinstance(part, dict) or str(part.get("type") or "").strip() != "error":
            continue
        error_class = normalized_scheduled_generation_failure_class(
            part.get("error_class") or part.get("errorClass") or part.get("error_code")
        )
        retryable = _http_payload_retryable(part)
        if retryable is None:
            retryable = _http_payload_retryable(response)
        return {
            "error_class": error_class,
            **({"failure_retryable": retryable} if retryable is not None else {}),
        }
    return None


def _scheduled_generation_failure_notice(
    error_class: Any,
    failure_retryable: Optional[bool] = None,
    retry_disposition: str = "no_retry",
    next_attempt_at: Any = None,
) -> str:
    normalized = normalized_scheduled_generation_failure_class(error_class)
    retry_time = str(next_attempt_at or "").strip()
    terminal_suffix = {
        "retry_scheduled": (
            f" This one-time occurrence will retry automatically at {retry_time}."
            if retry_time
            else " This one-time occurrence will retry automatically."
        ),
        "next_occurrence_only": " This occurrence ended; the next scheduled occurrence remains.",
        "paused": " This schedule is paused.",
        "terminal_action_required": " This occurrence ended; action is required before it can run again.",
    }.get(
        retry_disposition,
        " This occurrence ended; no automatic retry is scheduled."
        if failure_retryable is not True
        else " This occurrence ended; retry it after the provider recovers.",
    )
    messages = {
        "provider_auth_projection_unavailable": (
            "Scheduled work could not start because the configured model account "
            "could not be made available to its worker. Reconnect the account and retry."
        ),
        "provider_auth_missing": (
            "Scheduled work could not start because the model provider connection is missing. "
            "Connect it in Settings > Account > Connected Accounts."
        ),
        "provider_unauthorized": (
            "Scheduled work could not start because the model provider connection needs "
            "attention. Reconnect it in Settings > Account > Connected Accounts."
        ),
        "provider_connected_account_reconnect_required": (
            "Scheduled work could not start because a connected model provider needs to be "
            "reconnected in Settings > Account > Connected Accounts."
        ),
        "provider_access_denied": (
            "Scheduled work could not start because the model provider denied access. Check "
            "the selected model and account permissions."
        ),
        "provider_quota_exhausted": (
            "Scheduled work could not start because the model provider quota is exhausted. "
            "Restore quota before another run."
        ),
        "provider_rate_limited": (
            "Scheduled work was rate-limited by the model provider."
        ),
        "provider_request_rejected": (
            "Scheduled work was rejected by the configured model provider. Check "
            "the selected provider, model, and request settings."
        ),
        "provider_response_failed": (
            "Scheduled work ended because the configured model provider did not "
            "complete its response."
        ),
        "provider_unavailable": (
            "Scheduled work could not run because the configured model provider "
            "is temporarily unavailable."
        ),
        "provider_response_deadline_exceeded": (
            "Scheduled work exceeded the model response deadline."
        ),
        "provider_timeout": (
            "Scheduled work timed out while contacting the model provider."
        ),
        "timeout": (
            "Scheduled work timed out before completion."
        ),
        "context_length_exceeded": (
            "Scheduled work was too large for the selected model context. Shorten the task or "
            "choose a compatible model."
        ),
        "provider_context_limit_exceeded": (
            "Scheduled work was too large for the configured model context. "
            "Reduce the request context before retrying."
        ),
        "provider_content_filter": (
            "Scheduled work was stopped by the configured model provider's "
            "content filter. Review the request before retrying."
        ),
        "glasshive_runtime_unavailable": (
            "Scheduled work could not start because its worker runtime was unavailable."
        ),
        "glasshive_worker_quota_exceeded": (
            "Scheduled work could not start because the available worker capacity is full."
        ),
        "host_capacity": (
            "Scheduled work could not start because the worker host had no available capacity."
        ),
        "orphaned_user_not_found": (
            "This schedule stopped because its owner account no longer exists."
        ),
        "parallel_execution_isolation_required": (
            "Scheduled work requires an authorized isolated execution environment."
        ),
        "runtime_dependency_missing": (
            "Scheduled work could not start because a required worker dependency is unavailable."
        ),
        "runtime_io_failed": (
            "Scheduled work stopped because the worker runtime could not complete an input or output operation."
        ),
        "runtime_sandbox_unavailable": (
            "Scheduled work could not start because its isolated worker environment was unavailable."
        ),
        "scheduler_gateway_unavailable": (
            "Scheduled work could not start because the local conversation service was unavailable."
        ),
        "unsupported_runtime_configuration": (
            "Scheduled work could not start because its worker configuration is unsupported."
        ),
    }
    message = messages.get(
        normalized,
        "Scheduled work could not be completed by the model provider.",
    )
    return f"{message}{terminal_suffix}"


# === VIVENTIUM START ===
# Feature: Preserve scheduler-private occurrence identity across persisted Workbench refreshes.
_SCHEDULED_PROMPT_RUNTIME_FIELDS = (
    "_scheduled_prompt_run_id",
    "_scheduled_prompt_occurrence_key",
    "_scheduled_prompt_trigger_kind",
    "_scheduled_prompt_trigger_source",
)


def _scheduled_prompt_runtime_context(task: Dict[str, Any]) -> Dict[str, Any]:
    return {field: task[field] for field in _SCHEDULED_PROMPT_RUNTIME_FIELDS if field in task}


def _restore_scheduled_prompt_runtime_context(
    persisted_task: Dict[str, Any],
    runtime_task: Dict[str, Any],
) -> Dict[str, Any]:
    restored = dict(persisted_task)
    for field in _SCHEDULED_PROMPT_RUNTIME_FIELDS:
        restored.pop(field, None)
    restored.update(_scheduled_prompt_runtime_context(runtime_task))
    return restored


def _scheduled_preclaim_context(
    task: Dict[str, Any],
    *,
    required: bool = False,
) -> Optional[Dict[str, str]]:
    context = {
        field: str(task.get(field) or "").strip()
        for field in _SCHEDULED_PROMPT_RUNTIME_FIELDS
    }
    has_scheduler_trigger = (
        context["_scheduled_prompt_trigger_kind"] == "scheduled"
        or context["_scheduled_prompt_trigger_source"] == "scheduler_loop"
    )
    if not required and not has_scheduler_trigger:
        return None
    if (
        context["_scheduled_prompt_run_id"]
        and context["_scheduled_prompt_occurrence_key"]
        and context["_scheduled_prompt_trigger_kind"] == "scheduled"
        and context["_scheduled_prompt_trigger_source"] == "scheduler_loop"
    ):
        return context
    raise RuntimeError(
        "scheduled preclaim context is incomplete; refusing an unkeyed GlassHive dispatch"
    )
# === VIVENTIUM END ===


def _declared_scheduler_source_prompt_id(task: Dict[str, Any]) -> Optional[str]:
    """Expose recognized structured prompt provenance without activating a policy."""

    metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    workbench = (
        metadata.get("workbench_scheduled_prompt")
        if isinstance(metadata.get("workbench_scheduled_prompt"), dict)
        else {}
    )
    declared = str(
        task.get("source_prompt_id")
        or workbench.get("source_prompt_id")
        or metadata.get("source_prompt_id")
        or ""
    ).strip()
    if declared == CONSCIOUSNESS_CONTINUITY_OPPORTUNITY_PROMPT_ID:
        return CONSCIOUSNESS_CONTINUITY_OPPORTUNITY_PROMPT_ID
    return None


# === VIVENTIUM NOTE ===
# Feature: Telegram MarkdownV2 conversion for scheduled dispatch.
# Purpose: Convert standard Markdown to Telegram-safe MarkdownV2 and strip citations.
# === VIVENTIUM NOTE ===
_CITATION_COMPOSITE_RE = re.compile(
    r"(?:\\ue200|ue200|\ue200).*?(?:\\ue201|ue201|\ue201)",
    re.IGNORECASE,
)
_CITATION_STANDALONE_RE = re.compile(
    r"(?:\\ue202|ue202|\ue202)turn\d+[A-Za-z]+\d+",
    re.IGNORECASE,
)
_CITATION_CLEANUP_RE = re.compile(
    r"(?:\\ue2(?:00|01|02|03|04|06)|ue2(?:00|01|02|03|04|06)|[\ue200-\ue206])",
    re.IGNORECASE,
)
_BRACKET_CITATION_RE = re.compile(r"\[(\d{1,3})\](?=\s|$)")
_FENCED_CODE_RE = re.compile(r"```(\w*)\n([\s\S]*?)```", re.MULTILINE)
_INLINE_CODE_RE = re.compile(r"`([^`\n]+?)`")
_LINK_RE = re.compile(r"!?\[([^\]]*)\]\(([^)]+)\)")
_BOLD_ASTERISK_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
# Underscore emphasis follows the CommonMark intraword rule: underscores inside
# identifiers such as SAME_CONTINUITY_OK are literal characters, not markup.
_BOLD_UNDERSCORE_RE = re.compile(
    r"(?<![\w_])__(?![_\s])(.+?)(?<![_\s])__(?![\w_])",
    re.DOTALL,
)
_ITALIC_ASTERISK_RE = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)")
_ITALIC_UNDERSCORE_RE = re.compile(
    r"(?<![\w_])_(?![_\s])(.+?)(?<![_\s])_(?![\w_])",
    re.DOTALL,
)
_STRIKETHROUGH_RE = re.compile(r"~~(.+?)~~")
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
_BLOCKQUOTE_RE = re.compile(r"^>\s?(.*)$", re.MULTILINE)
_BULLET_RE = re.compile(r"^(\s*)[-*]\s+", re.MULTILINE)
_HR_RE = re.compile(r"^---+$", re.MULTILINE)
_INTERNAL_SURFACE_LINE_RE = re.compile(
    r"(?im)^\s*(?:Tool|File|Anchor|Relevance|Content):\s.*$"
)
_INTERNAL_SURFACE_SEPARATOR_RE = re.compile(r"(?m)^\s*[─-]{3,}\s*$")
_MARKDOWN_V2_UNESCAPE_RE = re.compile(r"\\([_*\[\]()~`>#+\-=|{}.!])")


def _sanitize_scheduled_text(text: str) -> str:
    if not text:
        return ""
    # Keep parity with Telegram bridge/voice sanitizer so scheduled delivery
    # and delivery ledgers never leak raw recall/tool wrappers or citations.
    cleaned = strip_internal_surface_artifacts(text, keep_assistant_turn_content=True)
    cleaned = _CITATION_COMPOSITE_RE.sub(" ", cleaned)
    cleaned = _CITATION_STANDALONE_RE.sub(" ", cleaned)
    cleaned = _CITATION_CLEANUP_RE.sub(" ", cleaned)
    cleaned = _BRACKET_CITATION_RE.sub(" ", cleaned)
    cleaned = _INTERNAL_SURFACE_LINE_RE.sub(" ", cleaned)
    cleaned = _INTERNAL_SURFACE_SEPARATOR_RE.sub(" ", cleaned)
    cleaned = re.sub(r"(?i)</?turn\b[^>]*>", " ", cleaned)
    # Strip MarkdownV2 backslash escapes (\. \- \! etc.) that models sometimes emit.
    cleaned = _MARKDOWN_V2_UNESCAPE_RE.sub(r"\1", cleaned)
    cleaned = re.sub(r"[ \t]{2,}", " ", cleaned)
    return cleaned.strip()


def _sanitize_telegram_text(text: str) -> str:
    return _sanitize_scheduled_text(text)


def _strip_html_tags(text: str) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"<[^>]+>", "", text)
    cleaned = cleaned.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"')
    return cleaned.strip()


def _strip_markdown(text: str) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"```[\s\S]*?```", " ", text)
    cleaned = re.sub(r"`([^`]+)`", r"\1", cleaned)
    cleaned = re.sub(r"\[([^\]]+)\]\([^\)]+\)", r"\1", cleaned)
    cleaned = re.sub(r"[\*_~]+", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def _escape_html(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _escape_html_attr(text: str) -> str:
    return _escape_html(text).replace('"', "&quot;")


# === VIVENTIUM NOTE ===
# Feature: Markdown → Telegram HTML conversion (replaces MarkdownV2).
# HTML parse mode only needs 3 characters escaped (<, >, &) vs MarkdownV2's 17.
# Unclosed HTML tags degrade gracefully instead of causing total parse failure.
def render_telegram_markdown(text: str) -> str:
    cleaned = _sanitize_telegram_text(text)
    if not cleaned:
        return ""

    placeholders: dict[str, str] = {}
    _counter = [0]

    def _store(html: str) -> str:
        key = f"\x00PH{_counter[0]}\x00"
        _counter[0] += 1
        placeholders[key] = html
        return key

    def _replace_fenced_code(m: re.Match) -> str:
        lang = m.group(1) or ""
        code = _escape_html(m.group(2))
        if lang:
            return _store(f'<pre><code class="language-{_escape_html_attr(lang)}">{code}</code></pre>')
        return _store(f"<pre><code>{code}</code></pre>")

    def _replace_inline_code(m: re.Match) -> str:
        return _store(f"<code>{_escape_html(m.group(1))}</code>")

    def _replace_link(m: re.Match) -> str:
        label = _escape_html(m.group(1))
        url = _escape_html_attr(m.group(2))
        return _store(f'<a href="{url}">{label}</a>')

    result = cleaned
    result = _FENCED_CODE_RE.sub(_replace_fenced_code, result)
    result = _INLINE_CODE_RE.sub(_replace_inline_code, result)
    result = _LINK_RE.sub(_replace_link, result)
    result = _BOLD_ASTERISK_RE.sub(lambda m: _store(f"<b>{_escape_html(m.group(1))}</b>"), result)
    result = _BOLD_UNDERSCORE_RE.sub(lambda m: _store(f"<b>{_escape_html(m.group(1))}</b>"), result)
    result = _STRIKETHROUGH_RE.sub(lambda m: _store(f"<s>{_escape_html(m.group(1))}</s>"), result)
    result = _ITALIC_ASTERISK_RE.sub(lambda m: _store(f"<i>{_escape_html(m.group(1))}</i>"), result)
    result = _ITALIC_UNDERSCORE_RE.sub(lambda m: _store(f"<i>{_escape_html(m.group(1))}</i>"), result)
    result = _HEADING_RE.sub(lambda m: _store(f"\n<b>{_escape_html(m.group(2))}</b>\n"), result)

    result = _BULLET_RE.sub(lambda m: f"{m.group(1)}• ", result)
    result = _HR_RE.sub("─────────────────", result)

    bq_lines: list[str] = []
    out_lines: list[str] = []
    for line in result.split("\n"):
        bq = _BLOCKQUOTE_RE.match(line)
        if bq:
            bq_lines.append(bq.group(1))
        else:
            if bq_lines:
                out_lines.append(_store(f"<blockquote>{_escape_html(chr(10).join(bq_lines))}</blockquote>"))
                bq_lines = []
            out_lines.append(line)
    if bq_lines:
        out_lines.append(_store(f"<blockquote>{_escape_html(chr(10).join(bq_lines))}</blockquote>"))
    result = "\n".join(out_lines)

    result = _escape_html(result)

    for key, value in placeholders.items():
        result = result.replace(key, value)
    result = re.sub(r"\n{3,}", "\n\n", result)
    return result.strip()
# === VIVENTIUM NOTE ===


class HttpJsonError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status: int,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        reason: str = "",
        detail: str = "",
        failure_class: str = "",
        failure_retryable: Optional[bool] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.method = method
        self.path = path
        self.payload = payload or {}
        self.reason = reason
        self.detail = detail
        self.failure_class = failure_class
        self.failure_retryable = failure_retryable


def scheduled_exception_failure(task: Dict[str, Any], exc: Exception) -> Dict[str, Any]:
    """Classify trusted exception structure without inspecting provider or prompt prose."""

    executor = str(task.get("executor") or "viventium_agent").strip()
    payload = getattr(exc, "payload", None)
    payload = payload if isinstance(payload, dict) else {}
    declared_class = str(getattr(exc, "failure_class", "") or "").strip().lower()
    declared_reason = str(getattr(exc, "reason", "") or "").strip().lower()
    if (
        isinstance(exc, HttpJsonError)
        and exc.status == 404
        and str(exc.path or "").strip().lower()
        == "/api/viventium/scheduler/chat"
        and "user_not_found" in {declared_class, declared_reason}
    ):
        failure_class = "orphaned_user_not_found"
    elif declared_class in SCHEDULED_GENERATION_FAILURE_CLASSES:
        failure_class = declared_class
    elif isinstance(exc, urllib.error.URLError):
        failure_class = (
            "glasshive_runtime_unavailable"
            if executor == "glasshive_host"
            else "scheduler_gateway_unavailable"
        )
    elif isinstance(exc, TimeoutError):
        failure_class = "timeout"
    elif isinstance(exc, HttpJsonError) and exc.status in {502, 503, 504}:
        failure_class = (
            "glasshive_runtime_unavailable"
            if executor == "glasshive_host"
            else "scheduler_gateway_unavailable"
        )
    else:
        failure_class = normalized_scheduled_generation_failure_class(declared_class)

    retryable = getattr(exc, "failure_retryable", None)
    if not isinstance(retryable, bool):
        retryable = _http_payload_retryable(payload)
    failure: Dict[str, Any] = {"error_class": failure_class}
    if isinstance(retryable, bool):
        failure["failure_retryable"] = retryable

    route_decision = str(payload.get("provider_route_decision") or "").strip()
    if route_decision in SCHEDULED_PROVIDER_ROUTE_DECISIONS:
        failure["provider_route_decision"] = route_decision
    return failure


def _scheduled_channel_exception_failure(
    task: Dict[str, Any], exc: Exception
) -> Dict[str, Any]:
    failure = scheduled_exception_failure(task, exc)
    error_class = failure["error_class"]
    if error_class == "completion_error":
        return {
            "outcome": "failed",
            "reason": "channel_dispatch_failed",
            "error_class": type(exc).__name__,
        }
    transition = resolve_scheduled_failure_transition(
        task, error_class, failure.get("failure_retryable")
    )
    return {
        "outcome": "failed",
        "reason": error_class,
        "error_class": error_class,
        "failure_retryable": transition["retryable"],
    }


def _http_payload_text(payload: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, (dict, list, tuple, set)):
            continue
        text = str(value or "").strip()
        if text:
            return text
    return ""


def _http_payload_retryable(payload: Dict[str, Any]) -> Optional[bool]:
    if "failure_retryable" not in payload:
        return None
    value = payload.get("failure_retryable")
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value != 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off", ""}:
            return False
    return None


def _format_http_error(method: str, url: str, error: urllib.error.HTTPError) -> HttpJsonError:
    body_text = ""
    payload: Optional[Dict[str, Any]] = None
    try:
        raw_body = error.read()
    except Exception:
        raw_body = b""

    if raw_body:
        body_text = raw_body.decode("utf-8", errors="replace").strip()

    error_message = error.reason or error.msg or "Request failed"
    reason = ""
    detail = ""
    failure_class = ""
    failure_retryable: Optional[bool] = None
    if body_text:
        try:
            parsed_payload = json.loads(body_text)
        except json.JSONDecodeError:
            error_message = body_text
        else:
            if isinstance(parsed_payload, dict):
                payload = parsed_payload
                nested_detail = (
                    payload.get("detail")
                    if isinstance(payload.get("detail"), dict)
                    else {}
                )
                detail = _http_payload_text(
                    nested_detail, "message", "detail", "error"
                ) or _http_payload_text(payload, "detail", "message", "error")
                failure_class = _http_payload_text(
                    payload, "failure_class"
                ) or _http_payload_text(nested_detail, "failure_class", "code")
                reason = _http_payload_text(
                    payload, "reason", "status"
                ) or _http_payload_text(nested_detail, "reason", "status")
                failure_retryable = _http_payload_retryable(payload)
                if failure_retryable is None:
                    failure_retryable = _http_payload_retryable(nested_detail)
                error_message = detail or _http_payload_text(payload, "error") or error_message
            else:
                error_message = body_text

    parsed = urllib.parse.urlparse(url)
    path = parsed.path or url
    classification = failure_class or reason
    reason_suffix = f" ({classification})" if classification else ""
    return HttpJsonError(
        f"{method} {path} failed: HTTP {error.code}{reason_suffix}: {error_message}",
        status=error.code,
        method=method,
        path=path,
        payload=payload,
        reason=reason,
        detail=detail,
        failure_class=failure_class,
        failure_retryable=failure_retryable,
    )


def _post_json(url: str, payload: Dict[str, Any], headers: Dict[str, str], timeout_s: int) -> Dict[str, Any]:
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = resp.read().decode("utf-8")
            if not data:
                return {}
            return json.loads(data)
    except urllib.error.HTTPError as error:
        raise _format_http_error("POST", url, error) from error


def _post_bytes(url: str, payload: bytes, headers: Dict[str, str], timeout_s: int) -> bytes:
    req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            return resp.read()
    except urllib.error.HTTPError as error:
        raise _format_http_error("POST", url, error) from error


def _post_multipart(
    url: str,
    *,
    fields: Dict[str, str],
    file_field: str,
    filename: str,
    file_bytes: bytes,
    file_content_type: str,
    timeout_s: int,
) -> Dict[str, Any]:
    boundary = f"----VIVENTIUM{int(time.time() * 1000)}{os.getpid()}"
    body = bytearray()
    for key, value in fields.items():
        body.extend(f"--{boundary}\r\n".encode("utf-8"))
        body.extend(
            f'Content-Disposition: form-data; name="{key}"\r\n\r\n'.encode("utf-8")
        )
        body.extend(str(value).encode("utf-8"))
        body.extend(b"\r\n")
    body.extend(f"--{boundary}\r\n".encode("utf-8"))
    body.extend(
        (
            f'Content-Disposition: form-data; name="{file_field}"; '
            f'filename="{filename}"\r\n'
        ).encode("utf-8")
    )
    body.extend(f"Content-Type: {file_content_type}\r\n\r\n".encode("utf-8"))
    body.extend(file_bytes)
    body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("utf-8"))

    headers = {"Content-Type": f"multipart/form-data; boundary={boundary}"}
    response = _post_bytes(url, bytes(body), headers, timeout_s)
    if not response:
        return {}
    try:
        return json.loads(response.decode("utf-8"))
    except Exception:
        return {}


# === VIVENTIUM NOTE ===
# Feature: Telegram follow-up polling helpers for scheduled dispatch.
# Purpose: Mirror LibreChat Telegram bridge behavior for background insights.
# === VIVENTIUM NOTE ===
def _get_json(url: str, headers: Dict[str, str], timeout_s: int) -> Dict[str, Any]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout_s) as resp:
            data = resp.read().decode("utf-8")
            if not data:
                return {}
            return json.loads(data)
    except urllib.error.HTTPError as error:
        raise _format_http_error("GET", url, error) from error


def _get_scheduler_secret() -> str:
    return os.getenv("SCHEDULER_LIBRECHAT_SECRET") or os.getenv("VIVENTIUM_SCHEDULER_SECRET") or ""


def _get_telegram_secret() -> str:
    return os.getenv("SCHEDULER_TELEGRAM_SECRET") or os.getenv("VIVENTIUM_TELEGRAM_SECRET") or ""


def _get_telegram_bot_token() -> str:
    return os.getenv("SCHEDULER_TELEGRAM_BOT_TOKEN") or os.getenv("BOT_TOKEN") or ""


# === VIVENTIUM START ===
# Rationale: ensure scheduled prompts use the shipped self-prompt by default and avoid
# double-prefixing stored prompts that already contain the scheduler contract.
def _get_prompt_prefix() -> str:
    prefix = (
        os.getenv("SCHEDULER_PROMPT_PREFIX")
        or os.getenv("SCHEDULING_PROMPT_PREFIX")
        or DEFAULT_SCHEDULER_PROMPT_PREFIX
    )
    return prefix.strip()


def _looks_like_scheduled_self_prompt(text: str) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return (
        BREW_PROMPT_MARKER.lower() in lowered
        or BREW_PROMPT_HEADER.lower() in lowered
        or "scheduled self-prompt" in lowered
    )


def _has_live_fact_contract(text: str) -> bool:
    if not isinstance(text, str):
        return False
    lowered = text.lower()
    return (
        "live external facts" in lowered
        and "verified tool/cortex result" in lowered
        and "omit that section" in lowered
    )


def _ensure_live_fact_contract(text: str) -> str:
    cleaned = (text or "").strip()
    if _has_live_fact_contract(cleaned):
        return cleaned
    if not cleaned:
        return LIVE_FACT_CONTRACT_LINE
    return f"{cleaned}\n\n{LIVE_FACT_CONTRACT_LINE}"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _task_schedule_timezone(task: Dict[str, Any]) -> str:
    schedule = task.get("schedule") if isinstance(task.get("schedule"), dict) else {}
    raw_timezone = str(schedule.get("timezone") or "UTC").strip() or "UTC"
    try:
        ensure_timezone(raw_timezone)
    except Exception:
        return "UTC"
    return raw_timezone


def _parse_scheduled_due_at(task: Dict[str, Any], now_utc: datetime) -> datetime:
    raw_due_at = str(task.get("next_run_at") or "").strip()
    if raw_due_at:
        try:
            return parse_iso(raw_due_at, timezone.utc).astimezone(timezone.utc)
        except Exception:
            logger.warning(
                "[scheduling-cortex] Invalid next_run_at for scheduled run context: task_id=%s",
                task.get("id"),
            )
    return now_utc.astimezone(timezone.utc)


def _format_local_date_label(value: datetime) -> str:
    return f"{value.strftime('%A, %B')} {value.day}, {value.year}"


def _build_scheduled_run_context(
    task: Dict[str, Any],
    *,
    now_utc: Optional[datetime] = None,
) -> Dict[str, str]:
    now = (now_utc or _utc_now()).astimezone(timezone.utc)
    schedule = task.get("schedule") if isinstance(task.get("schedule"), dict) else {}
    timezone_name = _task_schedule_timezone(task)
    tz = ensure_timezone(timezone_name)
    due_at_utc = _parse_scheduled_due_at(task, now)
    due_local = due_at_utc.astimezone(tz)
    current_local = now.astimezone(tz)
    window_start_local = datetime(
        due_local.year,
        due_local.month,
        due_local.day,
        tzinfo=tz,
    )
    window_end_local = window_start_local + timedelta(days=1)

    return {
        "run_started_at_utc": to_utc_iso(now),
        "scheduled_due_at_utc": to_utc_iso(due_at_utc),
        "scheduled_due_local": due_local.isoformat(),
        "scheduled_due_local_date": _format_local_date_label(due_local),
        "scheduled_due_local_date_iso": due_local.date().isoformat(),
        "schedule_timezone": timezone_name,
        "current_schedule_local_time": current_local.isoformat(),
        "calendar_window_local_start": window_start_local.isoformat(),
        "calendar_window_local_end_exclusive": window_end_local.isoformat(),
        "calendar_window_utc_start": to_utc_iso(window_start_local),
        "calendar_window_utc_end_exclusive": to_utc_iso(window_end_local),
        "schedule_type": str(schedule.get("type") or "").strip(),
        "schedule_time": str(schedule.get("time") or "").strip(),
    }


def _has_scheduled_run_context(text: str) -> bool:
    return isinstance(text, str) and SCHEDULED_RUN_CONTEXT_HEADER.lower() in text.lower()


def _format_scheduled_run_context_block(run_context: Dict[str, str]) -> str:
    fields = [
        "run_started_at_utc",
        "scheduled_due_at_utc",
        "scheduled_due_local",
        "scheduled_due_local_date",
        "scheduled_due_local_date_iso",
        "schedule_timezone",
        "current_schedule_local_time",
        "calendar_window_local_start",
        "calendar_window_local_end_exclusive",
        "calendar_window_utc_start",
        "calendar_window_utc_end_exclusive",
        "schedule_type",
        "schedule_time",
    ]
    lines = [SCHEDULED_RUN_CONTEXT_HEADER]
    for field in fields:
        value = str(run_context.get(field) or "").strip()
        if value:
            lines.append(f"- {field}: {value}")
    lines.append(SCHEDULED_RUN_CONTEXT_CONTRACT_LINE)
    lines.append(
        "For calendar/email/task sections, use the calendar window above and verified tool/cortex "
        "results. If those results are unavailable, do not invent events, tasks, or day-specific plans."
    )
    return "\n".join(lines)


def _default_scheduler_run_envelope(scheduled_run_context: str) -> str:
    context = str(scheduled_run_context or "").strip()
    if context.startswith(SCHEDULED_RUN_CONTEXT_HEADER):
        context = context[len(SCHEDULED_RUN_CONTEXT_HEADER) :].lstrip()
    return render_scheduler_run_envelope(context)


_WEEKDAY_NAME_TO_INDEX = {calendar.day_name[index].lower(): index for index in range(7)}
_MONTH_NAME_TO_INDEX = {calendar.month_name[index].lower(): index for index in range(1, 13)}
_MONTH_NAME_TO_INDEX.update({calendar.month_abbr[index].lower(): index for index in range(1, 13)})
_OPENING_DATE_CLAIM_RE = re.compile(
    r"""
    (?P<weekday>Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)
    [,\s]+
    (?P<month>January|February|March|April|May|June|July|August|September|October|November|December|
       Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)
    \s+
    (?P<day>\d{1,2})
    (?:,?\s+(?P<year>\d{4}))?
    """,
    re.IGNORECASE | re.VERBOSE,
)


def _opening_date_window(text: str) -> Tuple[str, int]:
    if not isinstance(text, str) or not text.strip():
        return "", 0
    left_stripped = text.lstrip()
    offset = len(text) - len(left_stripped)
    first_line = left_stripped.splitlines()[0]
    return first_line[:220], offset


def _expected_due_local_date(run_context: Dict[str, str]) -> Optional[datetime]:
    raw_due_local = str(run_context.get("scheduled_due_local") or "").strip()
    if not raw_due_local:
        return None
    try:
        return datetime.fromisoformat(raw_due_local)
    except ValueError:
        return None


def _scheduled_date_guard_for_text(
    text: str,
    run_context: Dict[str, str],
) -> Tuple[str, Dict[str, str]]:
    due_local = _expected_due_local_date(run_context)
    if due_local is None or not isinstance(text, str) or not text.strip():
        return text, {"status": "not_applicable"}

    window, offset = _opening_date_window(text)
    match = _OPENING_DATE_CLAIM_RE.search(window)
    expected_label = str(run_context.get("scheduled_due_local_date") or "").strip()
    if not match:
        return text, {"status": "no_opening_date_claim", "expected": expected_label}

    original_claim = match.group(0).strip()
    if match.start() != 0:
        return text, {
            "status": "mismatch_unmodified",
            "expected": expected_label,
            "claim": original_claim,
            "reason": "opening_date_not_leading",
        }

    weekday = match.group("weekday")
    month = match.group("month")
    day = int(match.group("day"))
    year = int(match.group("year") or due_local.year)
    claimed_weekday = _WEEKDAY_NAME_TO_INDEX.get(weekday.lower())
    claimed_month = _MONTH_NAME_TO_INDEX.get(month.lower())
    expected_tuple = (due_local.year, due_local.month, due_local.day, due_local.weekday())
    claimed_tuple = (year, claimed_month, day, claimed_weekday)

    if claimed_tuple == expected_tuple:
        return text, {"status": "passed", "expected": expected_label, "claim": original_claim}

    if not expected_label:
        return text, {"status": "mismatch_unmodified", "claim": original_claim}

    corrected = text[: offset + match.start()] + expected_label + text[offset + match.end() :]
    return corrected, {
        "status": "corrected",
        "expected": expected_label,
        "claim": original_claim,
    }


def _apply_scheduled_date_guard(
    final_text: str,
    followup_text: str,
    run_context: Dict[str, str],
) -> Tuple[str, str, Dict[str, str]]:
    final_text, final_guard = _scheduled_date_guard_for_text(final_text, run_context)
    followup_text, followup_guard = _scheduled_date_guard_for_text(followup_text, run_context)
    if final_guard.get("status") == "corrected" or followup_guard.get("status") == "corrected":
        logger.warning(
            "[scheduling-cortex] Corrected scheduled generated opening date claim: expected=%s final_status=%s followup_status=%s",
            final_guard.get("expected") or followup_guard.get("expected"),
            final_guard.get("status"),
            followup_guard.get("status"),
        )
    return final_text, followup_text, {
        "final": final_guard,
        "followup": followup_guard,
    }


def _compose_prompt(
    task: Dict[str, Any],
    *,
    run_context: Optional[Dict[str, str]] = None,
    now_utc: Optional[datetime] = None,
) -> str:
    base = (task.get("prompt") or "").strip()
    prefix = _get_prompt_prefix()
    custom_prefix = str(
        os.getenv("SCHEDULER_PROMPT_PREFIX")
        or os.getenv("SCHEDULING_PROMPT_PREFIX")
        or ""
    ).strip()
    context = run_context or _build_scheduled_run_context(task, now_utc=now_utc)
    context_block = "" if _has_scheduled_run_context(base) else _format_scheduled_run_context_block(context)
    parts: list[str] = []
    base_has_scheduler_prefix = _looks_like_scheduled_self_prompt(base)
    if not base_has_scheduler_prefix and context_block and not custom_prefix:
        parts.append(_default_scheduler_run_envelope(context_block))
        context_block = ""
    elif prefix and not base_has_scheduler_prefix:
        parts.append(prefix)
    if base and base_has_scheduler_prefix:
        parts.append(base)
    if context_block:
        parts.append(context_block)
    if base and not base_has_scheduler_prefix:
        parts.append(base)
    composed = "\n\n".join(part for part in parts if part).strip()
    return _ensure_live_fact_contract(composed)


def _scheduler_late_delivery(task: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    metadata = task.get("metadata")
    if not isinstance(metadata, dict):
        return None
    late_delivery = metadata.get("scheduler_misfire")
    if isinstance(late_delivery, dict) and late_delivery.get("mode") == "catch_up":
        return late_delivery
    return None


def _format_late_delivery_notice(late_delivery: Dict[str, Any]) -> str:
    due_at = str(late_delivery.get("due_at_local") or late_delivery.get("due_at") or "the original time")
    try:
        late_minutes = int(late_delivery.get("late_minutes") or 0)
    except (TypeError, ValueError):
        late_minutes = 0
    if late_minutes <= 0:
        late_text = "less than a minute late"
    elif late_minutes == 1:
        late_text = "1 minute late"
    else:
        late_text = f"{late_minutes} minutes late"
    return f"Late reminder: originally scheduled for {due_at}; delivered {late_text}."


def _prepend_late_delivery_notice(text: object, notice: str) -> str:
    cleaned = str(text or "").strip()
    if not cleaned:
        return ""
    if cleaned.startswith(notice):
        return cleaned
    return f"{notice}\n\n{cleaned}"
# === VIVENTIUM END ===


def _coerce_id(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (int, float)):
        return str(int(value))
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def _coerce_bool(value: Any, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off", ""}:
            return False
        return default
    return bool(value)


def _resolve_telegram_identity(
    task: Dict[str, Any],
    base_url: str,
    timeout_s: int,
) -> Tuple[str, str, Dict[str, bool]]:
    metadata = task.get("metadata") or {}
    telegram_user_id = _coerce_id(
        metadata.get("telegram_user_id") or metadata.get("telegramUserId")
    )
    telegram_chat_id = _coerce_id(
        metadata.get("telegram_chat_id") or metadata.get("telegramChatId")
    )
    voice_preferences: Dict[str, bool] = {
        "always_voice_response": _coerce_bool(
            metadata.get("always_voice_response")
            if isinstance(metadata, dict)
            else None,
            False,
        ),
        "voice_responses_enabled": _coerce_bool(
            metadata.get("voice_responses_enabled")
            if isinstance(metadata, dict)
            else None,
            True,
        ),
    }

    if not telegram_user_id:
        scheduler_secret = _get_scheduler_secret()
        if not scheduler_secret:
            raise RuntimeError("SCHEDULER_LIBRECHAT_SECRET is required to resolve Telegram mapping")
        headers = {
            "Content-Type": "application/json",
            "X-VIVENTIUM-SCHEDULER-SECRET": scheduler_secret,
        }
        response = _post_json(
            f"{base_url}/api/viventium/scheduler/telegram/resolve",
            {"userId": task.get("user_id")},
            headers,
            timeout_s,
        )
        telegram_user_id = _coerce_id(
            response.get("telegram_user_id") or response.get("telegramUserId")
        )
        telegram_chat_id = _coerce_id(
            response.get("telegram_chat_id") or response.get("telegramChatId")
        )
        response_voice_preferences = response.get("voice_preferences")
        if isinstance(response_voice_preferences, dict):
            voice_preferences = {
                "always_voice_response": _coerce_bool(
                    response_voice_preferences.get("always_voice_response"),
                    False,
                ),
                "voice_responses_enabled": _coerce_bool(
                    response_voice_preferences.get("voice_responses_enabled"),
                    True,
                ),
            }

    if not telegram_chat_id:
        telegram_chat_id = telegram_user_id

    return telegram_user_id, telegram_chat_id, voice_preferences


def _should_send_scheduler_voice(text: str, voice_preferences: Dict[str, bool]) -> bool:
    if not text or not text.strip():
        return False
    voice_enabled = _coerce_bool(
        (voice_preferences or {}).get("voice_responses_enabled"),
        True,
    )
    if not voice_enabled:
        return False
    always_voice = _coerce_bool(
        (voice_preferences or {}).get("always_voice_response"),
        False,
    )
    return always_voice


def _synthesize_tts(text: str, timeout_s: int) -> Optional[bytes]:
    if not text or not text.strip():
        return None

    api_key = (os.getenv("CARTESIA_API_KEY") or "").strip()
    voice_id = (
        os.getenv("VIVENTIUM_CARTESIA_VOICE_ID")
        or os.getenv("CARTESIA_VOICE_ID")
        or ""
    ).strip()
    if not api_key or not voice_id:
        return None

    api_url = (
        os.getenv("VIVENTIUM_CARTESIA_API_URL")
        or "https://api.cartesia.ai/tts/bytes"
    ).strip()
    api_version = (os.getenv("VIVENTIUM_CARTESIA_API_VERSION") or "2024-06-10").strip()
    model_id = (os.getenv("VIVENTIUM_CARTESIA_MODEL_ID") or "sonic-2").strip()
    emotion = (os.getenv("VIVENTIUM_CARTESIA_EMOTION") or "neutral").strip()
    sample_rate = int(os.getenv("VIVENTIUM_CARTESIA_SAMPLE_RATE", "24000") or "24000")
    speed = float(os.getenv("VIVENTIUM_CARTESIA_SPEED", "0.9") or "0.9")
    volume = float(os.getenv("VIVENTIUM_CARTESIA_VOLUME", "0.15") or "0.15")

    payload = {
        "model_id": model_id,
        "transcript": text,
        "voice": {"mode": "id", "id": voice_id},
        "output_format": {
            "container": "wav",
            "encoding": "pcm_s16le",
            "sample_rate": sample_rate,
        },
        "language": "en",
        "speed": "normal",
        "generation_config": {
            "speed": speed,
            "volume": volume,
            "emotion": emotion,
        },
    }
    headers = {
        "Cartesia-Version": api_version,
        "X-API-Key": api_key,
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    try:
        return _post_bytes(
            api_url,
            json.dumps(payload).encode("utf-8"),
            headers,
            timeout_s,
        )
    except Exception as exc:
        logger.warning("Scheduler Cartesia TTS failed: %s", exc)
        return None


def _iter_sse_payloads(
    url: str,
    headers: Dict[str, str],
    timeout_s: int,
) -> Iterable[str]:
    req = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:
        buffer: list[str] = []
        for raw in resp:
            line = raw.decode("utf-8", errors="ignore").rstrip("\r\n")
            if not line:
                if buffer:
                    data = "\n".join(buffer)
                    buffer = []
                    if data:
                        yield data
                continue
            if line.startswith("data:"):
                buffer.append(line[len("data:") :].lstrip())


# === VIVENTIUM NOTE ===
# Feature: Telegram follow-up parsing + polling primitives.
_CORTEX_PART_TYPES = {"cortex_activation", "cortex_brewing", "cortex_insight"}
_ACTIVE_CORTEX_STATUSES = {"activating", "brewing"}


def _parse_positive_float(value: Optional[str], fallback: float) -> float:
    try:
        num = float(value) if value is not None else fallback
        if num > 0 and num != float("inf"):
            return num
    except Exception:
        pass
    return fallback


def _extract_response_message_id(payload: Dict[str, Any]) -> str:
    if not payload.get("final"):
        return ""
    response = payload.get("responseMessage")
    if isinstance(response, dict):
        message_id = response.get("messageId")
        if isinstance(message_id, str) and message_id:
            return message_id
    message_id = payload.get("responseMessageId")
    if isinstance(message_id, str) and message_id:
        return message_id
    return ""


def _extract_followup_text(payload: Dict[str, Any]) -> str:
    if payload.get("event") != "on_cortex_followup":
        return ""
    data = payload.get("data")
    if not isinstance(data, dict):
        return ""
    text = data.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    return ""


def _extract_cortex_parts(content: Any) -> list[Dict[str, Any]]:
    if not isinstance(content, list):
        return []
    return [
        part
        for part in content
        if isinstance(part, dict) and part.get("type") in _CORTEX_PART_TYPES
    ]


def _extract_canonical_text(state: Dict[str, Any]) -> str:
    text = state.get("canonicalText")
    if isinstance(text, str) and text.strip():
        return text.strip()
    return ""


def _extract_canonical_text_source(state: Dict[str, Any]) -> str:
    for key in ("canonicalTextSource", "canonical_text_source"):
        value = state.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _extract_canonical_text_fallback_reason(state: Dict[str, Any]) -> str:
    for key in ("canonicalTextFallbackReason", "canonical_text_fallback_reason"):
        value = state.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _is_fallback_text_source(source: Any) -> bool:
    return str(source or "").strip() in {
        "deferred_fallback",
        "insight_fallback",
        "cortex_insight_fallback",
    }


def _fallback_reason(reason: Any, default: str = "deferred_fallback") -> str:
    value = str(reason or "").strip()
    return value or default


def _has_active_cortex(parts: list[Dict[str, Any]]) -> bool:
    return any(part.get("status") in _ACTIVE_CORTEX_STATUSES for part in parts)


def _extract_completed_cortex_insights(parts: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
    insights: list[Dict[str, Any]] = []
    for part in parts:
        if part.get("type") != "cortex_insight":
            continue
        if part.get("status") != "complete":
            continue
        insight = part.get("insight")
        if not isinstance(insight, str) or not insight.strip():
            continue
        insights.append(
            {
                "cortex_id": part.get("cortex_id") or part.get("cortexId") or "",
                "cortex_name": part.get("cortex_name") or part.get("cortexName") or "Background Insight",
                "insight": insight.strip(),
            }
        )
    return insights


def _is_suppressed_generated_text(text: str, sanitizer) -> bool:
    cleaned = strip_trailing_nta(text) if text else text
    cleaned = sanitizer(cleaned) if cleaned else cleaned
    return is_no_response_only(cleaned) or not str(cleaned or "").strip()


def _texts_match_after_sanitization(final_text: str, followup_text: str, sanitizer) -> bool:
    cleaned_final = strip_trailing_nta(final_text) if final_text else final_text
    cleaned_final = sanitizer(cleaned_final) if cleaned_final else cleaned_final
    cleaned_followup = strip_trailing_nta(followup_text) if followup_text else followup_text
    cleaned_followup = sanitizer(cleaned_followup) if cleaned_followup else cleaned_followup
    return bool(cleaned_final) and bool(cleaned_followup) and cleaned_final == cleaned_followup


def _format_insight_fallback(insights: list[Dict[str, Any]]) -> str:
    # Human-like delivery: surface only the insight text (no system preambles, no cortex labels).
    return format_insights_fallback_text(insights, voice_mode=False).strip()
# === VIVENTIUM NOTE ===


# === VIVENTIUM START ===
# Rationale: scheduler follow-up polling should preserve Telegram parity only when the
# task actually targets Telegram, without overfitting other scheduled surfaces.
def _env_flag_enabled(*names: str) -> bool:
    for name in names:
        if (os.getenv(name) or "").strip() == "1":
            return True
    return False


def _task_targets_telegram(task: Dict[str, Any]) -> bool:
    try:
        channels = _normalize_dispatch_channels(task.get("channel"))
    except Exception:
        channels = list(AVAILABLE_CHANNELS)
    return "telegram" in channels


def _scheduler_followup_poll_config(task: Dict[str, Any]) -> Dict[str, Any]:
    prefer_telegram_parity = _task_targets_telegram(task)

    interval_s = _parse_positive_float(
        os.getenv("SCHEDULER_FOLLOWUP_INTERVAL_S")
        or (os.getenv("SCHEDULER_TELEGRAM_FOLLOWUP_INTERVAL_S") if prefer_telegram_parity else "")
        or (os.getenv("VIVENTIUM_TELEGRAM_FOLLOWUP_INTERVAL_S") if prefer_telegram_parity else ""),
        1.5,
    )
    timeout_s = _parse_positive_float(
        os.getenv("SCHEDULER_FOLLOWUP_TIMEOUT_S")
        or os.getenv("SCHEDULER_FOLLOWUP_TOTAL_WAIT_S")
        or (os.getenv("SCHEDULER_TELEGRAM_FOLLOWUP_TIMEOUT_S") if prefer_telegram_parity else "")
        or (os.getenv("VIVENTIUM_TELEGRAM_FOLLOWUP_TIMEOUT_S") if prefer_telegram_parity else ""),
        210.0 if prefer_telegram_parity else 18.0,
    )
    grace_default = 8.0 if prefer_telegram_parity else timeout_s
    grace_s = _parse_positive_float(
        os.getenv("SCHEDULER_FOLLOWUP_ACTIVE_GRACE_S")
        or (os.getenv("SCHEDULER_TELEGRAM_FOLLOWUP_GRACE_S") if prefer_telegram_parity else "")
        or (os.getenv("VIVENTIUM_TELEGRAM_FOLLOWUP_GRACE_S") if prefer_telegram_parity else ""),
        grace_default,
    )
    if timeout_s < grace_s:
        timeout_s = grace_s

    return {
        "interval_s": interval_s,
        "grace_s": grace_s,
        "timeout_s": timeout_s,
        "allow_insight_fallback": prefer_telegram_parity
        and _env_flag_enabled("SCHEDULER_TELEGRAM_INSIGHT_FALLBACK", "VIVENTIUM_TELEGRAM_INSIGHT_FALLBACK"),
    }


def _poll_followup_state(
    *,
    url: str,
    headers: Dict[str, str],
    http_timeout_s: int,
    interval_s: float,
    grace_s: float,
    timeout_s: float,
    allow_insight_fallback: bool,
    warning_prefix: str,
) -> Dict[str, str]:
    deadline = time.monotonic() + timeout_s
    grace_start = time.monotonic()
    last_parts: list[Dict[str, Any]] = []
    last_canonical_text = ""
    last_canonical_text_source = ""
    last_canonical_text_fallback_reason = ""

    while time.monotonic() < deadline:
        try:
            state = _get_json(url, headers, http_timeout_s)
        except Exception as exc:
            logger.warning("%s follow-up poll failed: %s", warning_prefix, exc)
            time.sleep(interval_s)
            continue
        if not isinstance(state, dict):
            time.sleep(interval_s)
            continue
        canonical_text = _extract_canonical_text(state)
        canonical_text_source = _extract_canonical_text_source(state)
        canonical_text_fallback_reason = _extract_canonical_text_fallback_reason(state)
        if canonical_text_source:
            last_canonical_text_source = canonical_text_source
        if canonical_text_fallback_reason:
            last_canonical_text_fallback_reason = canonical_text_fallback_reason
        if canonical_text:
            last_canonical_text = canonical_text
        follow_up = state.get("followUp")
        if isinstance(follow_up, dict):
            text = follow_up.get("text")
            if isinstance(text, str) and text.strip():
                return {
                    "followup_text": text.strip(),
                    "canonical_text": last_canonical_text,
                    "followup_text_source": "followup",
                    "canonical_text_source": last_canonical_text_source,
                    "canonical_text_fallback_reason": last_canonical_text_fallback_reason,
                }

        parts = _extract_cortex_parts(state.get("cortexParts"))
        if parts:
            last_parts = parts
            if _has_active_cortex(parts):
                grace_start = time.monotonic()

        if time.monotonic() - grace_start >= grace_s:
            break

        time.sleep(interval_s)

    if allow_insight_fallback:
        insights = _extract_completed_cortex_insights(last_parts)
        if insights:
            return {
                "followup_text": _format_insight_fallback(insights),
                "canonical_text": last_canonical_text,
                "followup_text_source": "cortex_insight_fallback",
                "followup_text_fallback_reason": "insight_fallback",
                "canonical_text_source": last_canonical_text_source,
                "canonical_text_fallback_reason": last_canonical_text_fallback_reason,
            }
    return {
        "followup_text": "",
        "canonical_text": last_canonical_text,
        "canonical_text_source": last_canonical_text_source,
        "canonical_text_fallback_reason": last_canonical_text_fallback_reason,
    }
# === VIVENTIUM END ===


def _collect_text_parts(content: Any) -> str:
    parts: list[str] = []
    if isinstance(content, dict):
        content = [content]
    if not isinstance(content, list):
        return ""
    for part in content:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if isinstance(text, str) and text:
            parts.append(text)
            continue
        if isinstance(text, dict):
            value = text.get("value")
            if isinstance(value, str) and value:
                parts.append(value)
    return "".join(parts)


def _extract_final_response_text(payload: Dict[str, Any]) -> str:
    if not payload.get("final"):
        return ""
    response = payload.get("responseMessage")
    if isinstance(response, dict):
        text = response.get("text")
        if isinstance(text, str) and text.strip():
            return text.strip()
        content_text = _collect_text_parts(response.get("content"))
        if content_text.strip():
            return content_text.strip()
    text = payload.get("text")
    if isinstance(text, str) and text.strip():
        return text.strip()
    return ""


def _extract_text_deltas(payload: Dict[str, Any]) -> list[str]:
    if payload.get("event") != "on_message_delta":
        return []
    data = payload.get("data")
    if not isinstance(data, dict):
        return []
    delta = data.get("delta")
    if not isinstance(delta, dict):
        return []
    content = delta.get("content")
    text = _collect_text_parts(content)
    return [text] if text else []


def _stream_telegram_response(
    base_url: str,
    stream_id: str,
    telegram_user_id: str,
    telegram_chat_id: str,
    secret: str,
    timeout_s: int,
) -> Tuple[str, str, str]:
    # === VIVENTIUM NOTE ===
    # Feature: Capture final response metadata from Telegram streams.
    # Follow-ups are polled after the final event so a successful delivery never waits
    # on an open SSE stream.
    # === VIVENTIUM NOTE ===
    params_data = {"telegramUserId": telegram_user_id, "telegramChatId": telegram_chat_id}
    params = urllib.parse.urlencode(params_data)
    url = f"{base_url}/api/viventium/telegram/stream/{stream_id}?{params}"
    headers = {"X-VIVENTIUM-TELEGRAM-SECRET": secret}
    chunks: list[str] = []
    final_text = ""
    response_message_id = ""
    followup_text = ""
    for raw in _iter_sse_payloads(url, headers, timeout_s):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        if "error" in payload:
            raise RuntimeError(payload.get("error") or "Telegram stream error")
        if not response_message_id:
            response_message_id = _extract_response_message_id(payload)
        if not followup_text:
            followup_text = _extract_followup_text(payload)
        if not final_text:
            final_text = _extract_final_response_text(payload)
        if not final_text:
            chunks.extend([c for c in _extract_text_deltas(payload) if c])
        if payload.get("final"):
            break
    if not final_text:
        final_text = "".join(chunks).strip()
    return final_text.strip(), response_message_id, followup_text.strip()


# === VIVENTIUM NOTE ===
# Feature: Canonical scheduler-run stream capture for single-run multi-channel dispatch.
def _scheduled_execution_receipt(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        return {}

    def safe_value(candidate: Dict[str, Any], *keys: str) -> str:
        for key in keys:
            raw = candidate.get(key)
            if not isinstance(raw, str):
                continue
            value = raw.strip()
            if value and len(value) <= 256 and all(ord(char) >= 32 for char in value):
                return value
        return ""

    def server_authored_execution(value: Any) -> bool:
        return bool(
            isinstance(value, dict)
            and type(value.get("version")) is int
            and value.get("version") == 1
            and safe_value(value, "provider")
            and safe_value(value, "model")
            and isinstance(value.get("fallbackUsed"), bool)
        )

    receipt: Dict[str, Any] = {}
    candidates = [
        value
        for key in ("execution_receipt", "executionReceipt")
        if isinstance(value := payload.get(key), dict)
    ]
    viventium = payload.get("viventium")
    if isinstance(viventium, dict) and server_authored_execution(
        scheduled_execution := viventium.get("scheduledExecution")
    ):
        candidates.append(scheduled_execution)
    execution = payload.get("execution")
    if isinstance(execution, dict) and (
        server_authored_execution(execution)
        or any(
            key in execution
            for key in (
                "effective_model",
                "effectiveModel",
                "effective_reasoning_effort",
                "effectiveReasoningEffort",
            )
        )
    ):
        candidates.append(execution)

    for candidate in candidates:
        model = safe_value(candidate, "effective_model", "effectiveModel", "model")
        effort = safe_value(
            candidate,
            "effective_reasoning_effort",
            "effectiveReasoningEffort",
            "reasoning_effort",
            "reasoningEffort",
        )
        provider = safe_value(candidate, "effective_provider", "effectiveProvider", "provider")
        route_decision = safe_value(candidate, "provider_route_decision", "providerRouteDecision")
        fallback_used = candidate.get("fallbackUsed", candidate.get("fallback_used"))
        fallback_reason = safe_value(candidate, "fallbackReason", "fallback_reason")
        if model:
            receipt["effective_model"] = model
        if effort:
            receipt["effective_reasoning_effort"] = effort
        if provider:
            receipt["provider"] = provider
        if route_decision in SCHEDULED_PROVIDER_ROUTE_DECISIONS:
            receipt["provider_route_decision"] = route_decision
        if isinstance(fallback_used, bool):
            receipt["fallback_used"] = fallback_used
            if (
                fallback_used
                and fallback_reason
                and normalized_scheduled_generation_failure_class(fallback_reason)
                == fallback_reason
            ):
                receipt["fallback_reason"] = fallback_reason
    return receipt


def _stream_scheduler_response(
    base_url: str,
    stream_id: str,
    user_id: str,
    secret: str,
    timeout_s: int,
    return_metadata: bool = False,
) -> Tuple[str, str, str] | Tuple[str, str, str, Dict[str, Any]]:
    params_data = {"userId": str(user_id)}
    params = urllib.parse.urlencode(params_data)
    url = f"{base_url}/api/viventium/scheduler/stream/{stream_id}?{params}"
    headers = {"X-VIVENTIUM-SCHEDULER-SECRET": secret}
    chunks: list[str] = []
    final_text = ""
    response_message_id = ""
    followup_text = ""
    stream_metadata: Dict[str, Any] = {}
    for raw in _iter_sse_payloads(url, headers, timeout_s):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        if "error" in payload:
            declared_error_class = (
                payload.get("error_class")
                or payload.get("errorClass")
                or payload.get("failure_class")
                or payload.get("failureClass")
                or payload.get("error_code")
                or payload.get("code")
            )
            if not declared_error_class:
                raise RuntimeError(payload.get("error") or "Scheduler stream error")
            failure_retryable = _http_payload_retryable(payload)
            stream_metadata["generation_failure"] = {
                "error_class": normalized_scheduled_generation_failure_class(
                    declared_error_class
                ),
                **(
                    {"failure_retryable": failure_retryable}
                    if failure_retryable is not None
                    else {}
                ),
            }
            if not payload.get("final"):
                continue
        if (
            payload.get("superseded") is True
            or payload.get("disposition") == "superseded"
            or payload.get("state") == "superseded"
        ):
            stream_metadata["superseded"] = True
        generation_failure = _extract_scheduled_generation_failure(payload)
        if generation_failure is not None:
            stream_metadata["generation_failure"] = generation_failure
        response_message = payload.get("responseMessage")
        response_metadata = (
            response_message.get("metadata")
            if isinstance(response_message, dict)
            else None
        )
        if payload.get("final") is True:
            for candidate in (payload, response_message, response_metadata):
                execution_receipt = _scheduled_execution_receipt(candidate)
                if execution_receipt:
                    stream_metadata["execution_receipt"] = {
                        **stream_metadata.get("execution_receipt", {}),
                        **execution_receipt,
                    }
        for field in ("logical_turn_id", "revision"):
            if payload.get(field) is not None:
                stream_metadata[field] = payload[field]
        if not response_message_id:
            response_message_id = _extract_response_message_id(payload)
        if not followup_text:
            followup_text = _extract_followup_text(payload)
        if not final_text:
            final_text = _extract_final_response_text(payload)
        if not final_text:
            chunks.extend([c for c in _extract_text_deltas(payload) if c])
        if payload.get("final"):
            break
    if not final_text:
        final_text = "".join(chunks).strip()
    base_result = (final_text.strip(), response_message_id, followup_text.strip())
    return (*base_result, stream_metadata) if return_metadata else base_result


def _poll_scheduler_followup(
    task: Dict[str, Any],
    base_url: str,
    message_id: str,
    user_id: str,
    conversation_id: Optional[str],
    secret: str,
    http_timeout_s: int,
) -> Dict[str, str]:
    if not message_id:
        return {"followup_text": "", "canonical_text": "", "canonical_text_source": ""}

    poll_config = _scheduler_followup_poll_config(task)
    params = {"userId": str(user_id)}
    if conversation_id:
        params["conversationId"] = str(conversation_id)
    schedule_id = task.get("id")
    if schedule_id:
        params["scheduleId"] = str(schedule_id)
    url = f"{base_url}/api/viventium/scheduler/cortex/{message_id}?{urllib.parse.urlencode(params)}"
    headers = {"X-VIVENTIUM-SCHEDULER-SECRET": secret}
    return _poll_followup_state(
        url=url,
        headers=headers,
        http_timeout_s=http_timeout_s,
        interval_s=poll_config["interval_s"],
        grace_s=poll_config["grace_s"],
        timeout_s=poll_config["timeout_s"],
        allow_insight_fallback=poll_config["allow_insight_fallback"],
        warning_prefix="Scheduler",
    )


def _scheduled_conversation_title_source(task: Dict[str, Any]) -> str:
    source = str(task.get("prompt") or "").strip()
    if not source or _looks_like_scheduled_self_prompt(source):
        return "Scheduled Background Processing"
    return source[:2000]


def _run_scheduler_generation(
    task: Dict[str, Any],
    base_url: str,
    timeout_s: int,
    conversation_id: str,
) -> Dict[str, Any]:
    secret = (
        os.getenv("SCHEDULER_LIBRECHAT_SECRET")
        or os.getenv("VIVENTIUM_SCHEDULER_SECRET")
        or ""
    )
    if not secret:
        raise RuntimeError(
            "SCHEDULER_LIBRECHAT_SECRET or VIVENTIUM_SCHEDULER_SECRET is required for scheduler dispatch"
        )

    schedule = task.get("schedule") or {}
    run_context = _build_scheduled_run_context(task)
    source_prompt_id = _declared_scheduler_source_prompt_id(task)
    idempotency_key = str(
        task.get("_scheduled_prompt_occurrence_key")
        or task.get("_scheduled_prompt_run_id")
        or ""
    ).strip()
    metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    recurrence_state = metadata.get("recurrence_state_v1")
    bounded_recurrence_state: Dict[str, Any] = {}
    if isinstance(recurrence_state, dict) and recurrence_state.get("version") == 1:
        result_sha256 = str(recurrence_state.get("result_sha256") or "").strip().lower()
        bounded_recurrence_state = {
            "version": 1,
            "last_run_at": str(recurrence_state.get("last_run_at") or "")[:40],
            "outcome": str(recurrence_state.get("outcome") or "")[:40],
            "reason": str(recurrence_state.get("reason") or "")[:160],
            "result_excerpt": str(recurrence_state.get("result_excerpt") or "")[:2000],
            "result_sha256": result_sha256 if re.fullmatch(r"[a-f0-9]{64}", result_sha256) else "",
            "conversation_id": str(recurrence_state.get("conversation_id") or "")[:256],
            "occurrence_count": max(0, int(recurrence_state.get("occurrence_count") or 0)),
        }
    payload = {
        "userId": task.get("user_id"),
        "agentId": task.get("agent_id"),
        "text": _compose_prompt(task, run_context=run_context),
        # The execution prompt includes the private scheduler envelope. Give the gateway a
        # separate, bounded task source for user-visible conversation-title generation.
        "titleText": _scheduled_conversation_title_source(task),
        "conversationId": conversation_id,
        "scheduleId": task.get("id"),
        "scheduleRunId": task.get("_scheduled_prompt_run_id"),
        "clientTimezone": schedule.get("timezone") or "UTC",
        "clientTimestamp": run_context.get("run_started_at_utc"),
        "scheduledDueAt": run_context.get("scheduled_due_at_utc"),
        "schedulerRunContext": run_context,
        "deliveryChannels": _normalize_dispatch_channels(task.get("channel")),
        **({"recurrenceState": bounded_recurrence_state} if bounded_recurrence_state else {}),
    }
    # QA provenance is explicit scheduler-owned metadata. Never infer it from a task title or
    # prompt. Real scheduled work stays eligible for Main continuity; disposable harness runs do
    # not enter owner recall, memory, or continuity.
    if metadata.get("qa_disposable") is True:
        qa_run_id = str(
            task.get("_scheduled_prompt_run_id")
            or idempotency_key
            or task.get("id")
            or ""
        ).strip()
        payload["viventiumQaRun"] = True
        if qa_run_id:
            payload["viventiumQaRunId"] = qa_run_id[:128]
    if idempotency_key:
        payload["idempotencyKey"] = idempotency_key
        payload["source_event_id"] = idempotency_key
    if source_prompt_id:
        payload["sourcePromptId"] = source_prompt_id
    headers = {
        "Content-Type": "application/json",
        "X-VIVENTIUM-SCHEDULER-SECRET": secret,
    }
    chat_url = f"{base_url}/api/viventium/scheduler/chat"
    try:
        response = _post_json(chat_url, payload, headers, timeout_s)
    except (urllib.error.URLError, TimeoutError):
        if not idempotency_key:
            raise
        reconcile_url = (
            f"{base_url}/api/viventium/scheduler/dispatches/"
            f"{urllib.parse.quote(idempotency_key, safe='')}?"
            f"{urllib.parse.urlencode({'userId': str(task.get('user_id') or '')})}"
        )
        try:
            response = _get_json(reconcile_url, headers, timeout_s)
        except HttpJsonError as error:
            if error.status != 404:
                raise
            response = _post_json(chat_url, payload, headers, timeout_s)
        else:
            if str(response.get("state") or "").strip().lower() == "reserved":
                response = _post_json(chat_url, payload, headers, timeout_s)
    stream_id = response.get("streamId") or response.get("stream_id")
    if not stream_id:
        raise RuntimeError("Scheduler dispatch missing streamId")
    # Scheduled Main may inherit a long-running Agent Builder route. Keep the wait below the
    # scheduler's 15-minute lease; the bounded worker pool prevents one long generation from
    # blocking other schedules.
    stream_timeout_s = int(os.getenv("SCHEDULER_STREAM_TIMEOUT_S", "600"))
    try:
        streamed = _stream_scheduler_response(
            base_url,
            stream_id,
            str(task.get("user_id") or ""),
            secret,
            stream_timeout_s,
            return_metadata=True,
        )
    except TimeoutError:
        # A scheduled model turn is authoring, not an independently committed external effect.
        # Explicitly cancel it when the scheduler's bounded wait expires so an unfinished
        # placeholder cannot keep running forever after the ledger truthfully records failure.
        cancel_url = (
            f"{base_url}/api/viventium/scheduler/stream/"
            f"{urllib.parse.quote(str(stream_id), safe='')}/cancel"
        )
        try:
            _post_json(
                cancel_url,
                {"userId": str(task.get("user_id") or ""), "reason": "stream_timeout"},
                headers,
                min(max(1, timeout_s), 10),
            )
        except Exception as cancel_error:
            logger.warning(
                "Scheduler timed-out stream cancellation failed for %s: %s",
                stream_id,
                cancel_error,
            )
        raise
    final_text, response_message_id, followup_text = streamed[:3]
    stream_metadata = streamed[3] if len(streamed) > 3 and isinstance(streamed[3], dict) else {}
    # Acceptance identifies the intended route, not the completed attempt: Main may still
    # select its configured fallback. Only a producer-issued stream receipt is effective.
    execution_receipt = _scheduled_execution_receipt(stream_metadata)
    # The accept response owns the logical-turn receipt. Stream metadata repeats it for
    # response-loss reconciliation, but a normal successful stream must not erase it.
    if stream_metadata.get("logical_turn_id") is None:
        stream_metadata["logical_turn_id"] = response.get("logical_turn_id")
    if stream_metadata.get("revision") is None:
        stream_metadata["revision"] = response.get("revision")
    resolved_conversation_id = _extract_conversation_id(response, conversation_id)
    generation_failure = (
        stream_metadata.get("generation_failure")
        if isinstance(stream_metadata.get("generation_failure"), dict)
        else None
    )
    if generation_failure is not None:
        error_class = normalized_scheduled_generation_failure_class(
            generation_failure.get("error_class")
        )
        failure_retryable = generation_failure.get("failure_retryable")
        external_work: Dict[str, Any] = {}
        if idempotency_key:
            reconcile_url = (
                f"{base_url}/api/viventium/scheduler/dispatches/"
                f"{urllib.parse.quote(idempotency_key, safe='')}?"
                f"{urllib.parse.urlencode({'userId': str(task.get('user_id') or '')})}"
            )
            reconciled = _get_json(reconcile_url, headers, timeout_s)
            if isinstance(reconciled.get("externalWork"), dict):
                external_work = dict(reconciled["externalWork"])
        return {
            "conversation_id": resolved_conversation_id,
            "response_message_id": response_message_id or None,
            "final_text": "",
            "followup_text": "",
            "generation_failure": {
                "error_class": error_class,
                **(
                    {"failure_retryable": failure_retryable}
                    if isinstance(failure_retryable, bool)
                    else {}
                ),
            },
            "logical_turn_id": stream_metadata.get("logical_turn_id"),
            "revision": stream_metadata.get("revision"),
            "external_work": external_work,
            "execution": {
                **execution_receipt,
                **({"source_prompt_id": source_prompt_id} if source_prompt_id else {}),
            },
        }
    polled_state = {"followup_text": "", "canonical_text": "", "canonical_text_source": ""}
    final_text_source = "stream_final" if str(final_text or "").strip() else ""
    final_text_fallback_reason = ""
    followup_text_source = "stream_followup" if str(followup_text or "").strip() else ""
    followup_text_fallback_reason = ""
    suppressed_fallback_reason = ""
    if not followup_text:
        polled_state = _poll_scheduler_followup(
            task,
            base_url,
            response_message_id,
            str(task.get("user_id") or ""),
            resolved_conversation_id,
            secret,
            timeout_s,
        )
        followup_text = polled_state.get("followup_text", "").strip()
        if followup_text:
            followup_text_source = str(polled_state.get("followup_text_source") or "followup").strip()
            followup_text_fallback_reason = str(
                polled_state.get("followup_text_fallback_reason") or ""
            ).strip()

    canonical_text = polled_state.get("canonical_text", "").strip()
    canonical_text_source = str(polled_state.get("canonical_text_source") or "").strip()
    canonical_text_fallback_reason = str(
        polled_state.get("canonical_text_fallback_reason") or ""
    ).strip()
    if canonical_text and _is_suppressed_generated_text(final_text, _sanitize_scheduled_text):
        final_text = canonical_text
        final_text_source = canonical_text_source or "canonical_parent"
        final_text_fallback_reason = canonical_text_fallback_reason
    elif not canonical_text and _is_fallback_text_source(canonical_text_source):
        suppressed_fallback_reason = _fallback_reason(canonical_text_fallback_reason)
    if _texts_match_after_sanitization(final_text, followup_text, _sanitize_scheduled_text):
        followup_text = ""
        followup_text_source = ""
        followup_text_fallback_reason = ""
    final_text, followup_text, date_guard = _apply_scheduled_date_guard(
        final_text,
        followup_text,
        run_context,
    )

    external_work: Dict[str, Any] = {}
    if idempotency_key:
        reconcile_url = (
            f"{base_url}/api/viventium/scheduler/dispatches/"
            f"{urllib.parse.quote(idempotency_key, safe='')}?"
            f"{urllib.parse.urlencode({'userId': str(task.get('user_id') or '')})}"
        )
        reconciled = _get_json(reconcile_url, headers, timeout_s)
        if isinstance(reconciled.get("externalWork"), dict):
            external_work = dict(reconciled["externalWork"])

    return {
        "conversation_id": resolved_conversation_id,
        "response_message_id": response_message_id or None,
        "final_text": final_text.strip(),
        "followup_text": followup_text.strip(),
        "final_text_source": final_text_source,
        "final_text_fallback_reason": final_text_fallback_reason,
        "followup_text_source": followup_text_source,
        "followup_text_fallback_reason": followup_text_fallback_reason,
        "suppressed_fallback_reason": suppressed_fallback_reason,
        "date_guard": date_guard,
        "superseded": bool(stream_metadata.get("superseded")),
        "disposition": "superseded" if stream_metadata.get("superseded") else "",
        "logical_turn_id": stream_metadata.get("logical_turn_id"),
        "revision": stream_metadata.get("revision"),
        "external_work": external_work,
        "execution": {
            **execution_receipt,
            **({"source_prompt_id": source_prompt_id} if source_prompt_id else {}),
        },
    }


# === VIVENTIUM NOTE ===
# Feature: Poll LibreChat follow-up endpoint for scheduled Telegram runs.
def _poll_telegram_followup(
    base_url: str,
    message_id: str,
    telegram_user_id: str,
    telegram_chat_id: str,
    conversation_id: Optional[str],
    schedule_id: Optional[str],
    secret: str,
    http_timeout_s: int,
) -> Dict[str, str]:
    if not message_id:
        return {"followup_text": "", "canonical_text": "", "canonical_text_source": ""}

    interval_s = _parse_positive_float(
        os.getenv("SCHEDULER_TELEGRAM_FOLLOWUP_INTERVAL_S")
        or os.getenv("VIVENTIUM_TELEGRAM_FOLLOWUP_INTERVAL_S"),
        1.5,
    )
    grace_s = _parse_positive_float(
        os.getenv("SCHEDULER_TELEGRAM_FOLLOWUP_GRACE_S")
        or os.getenv("VIVENTIUM_TELEGRAM_FOLLOWUP_GRACE_S"),
        8.0,
    )
    timeout_s = _parse_positive_float(
        os.getenv("SCHEDULER_TELEGRAM_FOLLOWUP_TIMEOUT_S")
        or os.getenv("VIVENTIUM_TELEGRAM_FOLLOWUP_TIMEOUT_S"),
        210.0,
    )
    if timeout_s < grace_s:
        timeout_s = grace_s
    allow_insight_fallback = (
        (os.getenv("SCHEDULER_TELEGRAM_INSIGHT_FALLBACK") or "").strip() == "1"
        or (os.getenv("VIVENTIUM_TELEGRAM_INSIGHT_FALLBACK") or "").strip() == "1"
    )

    headers = {"X-VIVENTIUM-TELEGRAM-SECRET": secret}
    params = {"telegramUserId": telegram_user_id, "telegramChatId": telegram_chat_id}
    if conversation_id and conversation_id != "new":
        params["conversationId"] = conversation_id
    if schedule_id:
        params["scheduleId"] = str(schedule_id)
    url = f"{base_url}/api/viventium/telegram/cortex/{message_id}?{urllib.parse.urlencode(params)}"

    return _poll_followup_state(
        url=url,
        headers=headers,
        http_timeout_s=http_timeout_s,
        interval_s=interval_s,
        grace_s=grace_s,
        timeout_s=timeout_s,
        allow_insight_fallback=allow_insight_fallback,
        warning_prefix="Telegram",
    )
# === VIVENTIUM NOTE ===


def _split_telegram_message(text: str, limit: int = 4000) -> list[str]:
    if not text:
        return []
    if len(text) <= limit:
        return [text]
    parts: list[str] = []
    remaining = text
    while remaining:
        if len(remaining) <= limit:
            parts.append(remaining)
            break
        split_at = remaining.rfind("\n", 0, limit)
        if split_at <= 0:
            split_at = limit
        chunk = remaining[:split_at].strip()
        if chunk:
            parts.append(chunk)
        remaining = remaining[split_at:].lstrip()
    return parts


def _telegram_message_id(response: Any) -> Optional[str]:
    if not isinstance(response, dict) or response.get("ok") is False:
        return None
    result = response.get("result")
    if not isinstance(result, dict):
        return None
    message_id = str(result.get("message_id") or "").strip()
    return message_id or None


def _send_telegram_message(chat_id: str, text: str, timeout_s: int) -> Optional[str]:
    token = _get_telegram_bot_token()
    if not token:
        raise RuntimeError("SCHEDULER_TELEGRAM_BOT_TOKEN or BOT_TOKEN is required for Telegram delivery")
    if not text:
        return None
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    headers = {"Content-Type": "application/json"}
    rendered = render_telegram_markdown(text)
    if not rendered:
        rendered = _strip_markdown(_sanitize_telegram_text(text))
    payload = {
        "chat_id": str(chat_id),
        "text": rendered,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    response = _post_json(url, payload, headers, timeout_s)
    # === VIVENTIUM NOTE ===
    # Feature: Retry only Telegram's explicit parse rejection. A transport exception can
    # mean Telegram accepted the first send and its response was lost; retrying would spam.
    if isinstance(response, dict) and response.get("ok") is False:
        description = str(response.get("description") or "")
        logger.warning("Telegram send failed (ok=false): %s", description)
        if "parse" in description.lower():
            payload.pop("parse_mode", None)
            payload["text"] = _strip_html_tags(rendered) or _strip_markdown(_sanitize_telegram_text(text))
            return _telegram_message_id(_post_json(url, payload, headers, timeout_s))
        raise RuntimeError(description or "Telegram send failed")
    # === VIVENTIUM NOTE ===
    return _telegram_message_id(response)


def _send_telegram_audio(chat_id: str, audio_bytes: bytes, timeout_s: int) -> Optional[str]:
    token = _get_telegram_bot_token()
    if not token:
        raise RuntimeError("SCHEDULER_TELEGRAM_BOT_TOKEN or BOT_TOKEN is required for Telegram delivery")
    if not audio_bytes:
        raise RuntimeError("Audio payload is empty")
    url = f"https://api.telegram.org/bot{token}/sendAudio"
    fields = {
        "chat_id": str(chat_id),
        "title": "Voice",
    }
    response = _post_multipart(
        url,
        fields=fields,
        file_field="audio",
        filename="voice.wav",
        file_bytes=audio_bytes,
        file_content_type="audio/wav",
        timeout_s=timeout_s,
    )
    if isinstance(response, dict) and response.get("ok") is False:
        description = str(response.get("description") or "")
        raise TelegramDefiniteRejection(description or "Telegram sendAudio failed")
    return _telegram_message_id(response)


class TelegramDefiniteRejection(RuntimeError):
    """Telegram explicitly rejected a request, so a fallback cannot duplicate it."""


def _send_telegram_voice_or_text(
    chat_id: str,
    text: str,
    timeout_s: int,
    voice_preferences: Dict[str, bool],
) -> Optional[str]:
    if not text:
        return None
    if not _should_send_scheduler_voice(text, voice_preferences):
        return _send_telegram_message(chat_id, text, timeout_s)

    audio_bytes = _synthesize_tts(text, timeout_s)
    if audio_bytes:
        try:
            return _send_telegram_audio(chat_id, audio_bytes, timeout_s)
        except TelegramDefiniteRejection as exc:
            logger.warning("Telegram sendAudio failed, falling back to text: %s", exc)

    return _send_telegram_message(chat_id, text, timeout_s)


def _resolve_conversation_id(task: Dict[str, Any]) -> str:
    policy = (task.get("conversation_policy") or "new").lower()
    metadata = task.get("metadata") or {}
    conversation_id = task.get("conversation_id") or metadata.get("conversation_id")
    if policy == "same" and conversation_id:
        return conversation_id
    if policy == "same":
        return "new"
    return "new"


def _extract_conversation_id(response: Dict[str, Any], fallback: Optional[str]) -> Optional[str]:
    conversation_id = response.get("conversationId") or response.get("conversation_id")
    if conversation_id:
        return conversation_id
    if fallback and fallback != "new":
        return fallback
    return None


# === VIVENTIUM NOTE ===
# Feature: Support channel lists and default fan-out.
def _parse_channel_value(value: Any) -> Any:
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


def _normalize_dispatch_channels(value: Any) -> list[str]:
    if value is None:
        return list(DEFAULT_DELIVERY_CHANNELS)
    normalized_value = _parse_channel_value(value)
    if isinstance(normalized_value, str):
        raw_values = [normalized_value]
    elif isinstance(normalized_value, (list, tuple, set)):
        raw_values = list(normalized_value)
    else:
        raw_values = [normalized_value]

    channels: list[str] = []
    seen = set()
    for item in raw_values:
        key = str(item).strip().lower()
        if not key:
            continue
        if key not in AVAILABLE_CHANNELS:
            raise RuntimeError(f"Unsupported channel: {item}")
        if key not in seen:
            channels.append(key)
            seen.add(key)

    if not channels:
        raise RuntimeError("channel must include at least one valid entry")
    return channels


def _dispatch_telegram(
    task: Dict[str, Any],
    base_url: str,
    timeout_s: int,
    conversation_id: str,
) -> Dict[str, Any]:
    secret = _get_telegram_secret()
    if not secret:
        raise RuntimeError("SCHEDULER_TELEGRAM_SECRET is required for Telegram dispatch")

    telegram_user_id, telegram_chat_id, voice_preferences = _resolve_telegram_identity(
        task,
        base_url,
        timeout_s,
    )
    if not telegram_user_id:
        raise RuntimeError("telegram_user_id is required for Telegram dispatch")
    if not telegram_chat_id:
        raise RuntimeError("telegram_chat_id is required for Telegram dispatch")

    # === VIVENTIUM NOTE ===
    # Feature: Pass schedule timezone as clientTimezone for time context injection.
    # This mirrors how the web client sends Intl.DateTimeFormat().resolvedOptions().timeZone
    # === VIVENTIUM NOTE ===
    schedule = task.get("schedule") or {}
    payload = {
        "text": _compose_prompt(task),
        "agentId": task.get("agent_id"),
        "conversationId": conversation_id,
        "telegramUserId": str(telegram_user_id),
        "telegramChatId": str(telegram_chat_id),
        "scheduleId": task.get("id"),
        "clientTimezone": schedule.get("timezone") or "UTC",
    }
    headers = {
        "Content-Type": "application/json",
        "X-VIVENTIUM-TELEGRAM-SECRET": secret,
    }
    response = _post_json(f"{base_url}/api/viventium/telegram/chat", payload, headers, timeout_s)
    stream_id = response.get("streamId") or response.get("stream_id")
    if not stream_id:
        raise RuntimeError("Telegram dispatch missing streamId")
    stream_timeout_s = int(os.getenv("SCHEDULER_TELEGRAM_STREAM_TIMEOUT_S", "120"))
    final_text, response_message_id, followup_text = _stream_telegram_response(
        base_url,
        stream_id,
        str(telegram_user_id),
        str(telegram_chat_id),
        secret,
        stream_timeout_s,
    )
    raw_final_text = final_text.strip() if isinstance(final_text, str) else ""
    raw_followup_text = followup_text.strip() if isinstance(followup_text, str) else ""
    send_timeout_s = int(os.getenv("SCHEDULER_TELEGRAM_SEND_TIMEOUT_S", "15"))
    # === VIVENTIUM NOTE ===
    # Feature: Allow intentional silence for passive/background runs via {NTA}.
    # Empty or whitespace-only output is treated as intentional silence (nothing to report),
    # not as a failure.  This removes the hardcoded "(No response generated.)" placeholder
    # that was surfacing noise on Telegram for scheduled runs with nothing to say.
    #
    # Strip trailing {NTA} from content+tag responses before the suppression check.
    # The model sometimes generates content then appends {NTA}; strip the tag so it
    # doesn't leak into the visible Telegram message.
    final_text = strip_trailing_nta(final_text) if final_text else final_text
    final_text = _sanitize_telegram_text(final_text) if final_text else final_text
    suppress_final = is_no_response_only(final_text) or not str(final_text or "").strip()
    final_suppress_reason = "nta" if is_no_response_only(final_text) else "empty"
    if suppress_final:
        logger.info(
            "[scheduling-cortex] Suppressing scheduled Telegram delivery (no-response): task_id=%s reason=%s",
            task.get("id") or "unknown",
            final_suppress_reason,
        )
        final_text = ""
    sent_final_message = False
    if final_text:
        for part in _split_telegram_message(final_text):
            _send_telegram_voice_or_text(
                str(telegram_chat_id),
                part,
                send_timeout_s,
                voice_preferences,
            )
        sent_final_message = True

    resolved_conversation_id = _extract_conversation_id(response, conversation_id)
    # === VIVENTIUM NOTE ===
    # Feature: Telegram follow-up delivery for scheduled prompts.
    # === VIVENTIUM NOTE ===
    followup_text = strip_trailing_nta(followup_text) if followup_text else followup_text
    followup_text = _sanitize_telegram_text(followup_text) if followup_text else followup_text
    followup_suppressed = is_no_response_only(followup_text)
    if followup_suppressed:
        raw_followup_text = followup_text.strip() if isinstance(followup_text, str) else ""
        followup_text = ""

    polled_state = {"followup_text": "", "canonical_text": "", "canonical_text_source": ""}
    final_text_source = "stream_final" if str(final_text or "").strip() else ""
    final_text_fallback_reason = ""
    followup_text_source = "stream_followup" if str(followup_text or "").strip() else ""
    followup_text_fallback_reason = ""
    suppressed_fallback_reason = ""
    if not followup_text and not followup_suppressed:
        polled_state = _poll_telegram_followup(
            base_url,
            response_message_id,
            str(telegram_user_id),
            str(telegram_chat_id),
            resolved_conversation_id,
            str(task.get("id") or ""),
            secret,
            timeout_s,
        )
        polled_followup_text = polled_state.get("followup_text", "")
        if isinstance(polled_followup_text, str) and polled_followup_text.strip():
            followup_text = polled_followup_text
            raw_followup_text = polled_followup_text.strip()
            followup_text_source = str(polled_state.get("followup_text_source") or "followup").strip()
            followup_text_fallback_reason = str(
                polled_state.get("followup_text_fallback_reason") or ""
            ).strip()
    followup_text = strip_trailing_nta(followup_text) if followup_text else followup_text
    followup_text = _sanitize_telegram_text(followup_text) if followup_text else followup_text
    followup_suppressed = followup_suppressed or is_no_response_only(followup_text)
    followup_suppress_reason = "nta" if followup_suppressed else ("empty" if not str(followup_text or "").strip() else "")
    if followup_suppressed:
        raw_followup_text = followup_text.strip() if isinstance(followup_text, str) else raw_followup_text
        followup_text = ""

    canonical_final_text = polled_state.get("canonical_text", "").strip()
    canonical_final_source = str(polled_state.get("canonical_text_source") or "").strip()
    canonical_final_fallback_reason = str(
        polled_state.get("canonical_text_fallback_reason") or ""
    ).strip()
    if canonical_final_text and _is_suppressed_generated_text(final_text, _sanitize_telegram_text):
        final_text = _sanitize_telegram_text(strip_trailing_nta(canonical_final_text))
        raw_final_text = final_text.strip()
        suppress_final = False
        final_suppress_reason = ""
        final_text_source = canonical_final_source or "canonical_parent"
        final_text_fallback_reason = canonical_final_fallback_reason
    elif not canonical_final_text and _is_fallback_text_source(canonical_final_source):
        suppressed_fallback_reason = _fallback_reason(canonical_final_fallback_reason)
    if _texts_match_after_sanitization(final_text, followup_text, _sanitize_telegram_text):
        followup_text = ""
        raw_followup_text = ""
        followup_suppressed = False
        followup_suppress_reason = ""
        followup_text_source = ""
        followup_text_fallback_reason = ""

    if (
        suppress_final
        and suppressed_fallback_reason
    ):
        final_suppress_reason = suppressed_fallback_reason

    if final_text and not sent_final_message:
        for part in _split_telegram_message(final_text):
            _send_telegram_voice_or_text(
                str(telegram_chat_id),
                part,
                send_timeout_s,
                voice_preferences,
            )
        sent_final_message = True

    if followup_text:
        for part in _split_telegram_message(followup_text):
            _send_telegram_voice_or_text(
                str(telegram_chat_id),
                part,
                send_timeout_s,
                voice_preferences,
            )
    sent_final = sent_final_message
    sent_followup = bool(followup_text)

    def _suppressed_marker(raw_text: str, suppress_reason: str) -> Optional[str]:
        cleaned_raw = raw_text.strip() if isinstance(raw_text, str) else ""
        if not cleaned_raw:
            return None
        if suppress_reason == "nta" and is_no_response_only(cleaned_raw):
            return cleaned_raw
        return None

    final_visible_text = final_text.strip() if isinstance(final_text, str) and final_text.strip() else ""
    followup_visible_text = (
        followup_text.strip() if isinstance(followup_text, str) and followup_text.strip() else ""
    )

    generated_text: Optional[str] = None
    if final_visible_text:
        generated_text = final_visible_text
    elif followup_visible_text:
        generated_text = followup_visible_text
    else:
        generated_text = _suppressed_marker(raw_final_text, final_suppress_reason) or _suppressed_marker(
            raw_followup_text,
            followup_suppress_reason,
        )
    if sent_final or sent_followup:
        fallback_delivered = (
            (sent_final and _is_fallback_text_source(final_text_source))
            or (sent_followup and _is_fallback_text_source(followup_text_source))
        )
        if fallback_delivered:
            outcome = "fallback_delivered"
            reason = _fallback_reason(final_text_fallback_reason or followup_text_fallback_reason)
        else:
            outcome = "sent"
            reason = "delivered"
    elif raw_final_text or raw_followup_text:
        outcome = "suppressed"
        if raw_final_text and not sent_final:
            reason = final_suppress_reason or "suppressed"
        else:
            reason = followup_suppress_reason or "suppressed"
    else:
        outcome = "suppressed"
        reason = "empty"

    return {
        "conversation_id": resolved_conversation_id,
        # === VIVENTIUM NOTE ===
        # Feature: Return generated-vs-delivered details for NTA/empty visibility.
        "delivery": {
            "channel": "telegram",
            "outcome": outcome,
            "reason": reason,
            "generated_text": generated_text,
            "final_generated_text": final_visible_text
            or _suppressed_marker(raw_final_text, final_suppress_reason),
            "followup_generated_text": followup_visible_text
            or _suppressed_marker(raw_followup_text, followup_suppress_reason),
            "sent_final": sent_final,
            "sent_followup": sent_followup,
            "response_message_id": response_message_id or None,
            "final_text_source": final_text_source,
            "followup_text_source": followup_text_source,
            "fallback_delivered": outcome == "fallback_delivered",
        },
        # === VIVENTIUM NOTE ===
    }


def _select_conversation_id(channel_results: Dict[str, Dict[str, Any]]) -> Optional[str]:
    librechat_result = channel_results.get("librechat") or {}
    librechat_conversation = librechat_result.get("conversation_id")
    if librechat_conversation:
        return librechat_conversation
    for result in channel_results.values():
        conversation_id = result.get("conversation_id")
        if conversation_id:
            return conversation_id
    return None
# === VIVENTIUM NOTE ===


# === VIVENTIUM START ===
# Feature: Prompt Workbench scheduled prompts execute GlassHive directly.
def _sha256_prefix(value: str, length: int = 16) -> str:
    import hashlib

    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def _scheduler_storage() -> ScheduleStorage:
    db_path = os.getenv("SCHEDULING_DB_PATH")
    if not db_path:
        db_path = str(
            _app_support_dir()
            / "state"
            / "runtime"
            / "isolated"
            / "scheduling"
            / "schedules.db"
        )
    mirror_path = os.getenv("SCHEDULING_DB_MIRROR_PATH")
    return ScheduleStorage(StorageConfig(db_path=db_path, mirror_db_path=mirror_path))


def _app_support_dir() -> Path:
    return Path(
        os.getenv("VIVENTIUM_APP_SUPPORT_DIR")
        or (Path.home() / "Library" / "Application Support" / "Viventium")
    ).expanduser()


def _private_workbench_run_dir() -> Path:
    root = Path(os.getenv("VIVENTIUM_PRIVATE_USER_DATA_DIR") or (_app_support_dir() / "private-user-data"))
    path = root.expanduser() / "prompt-workbench" / "scheduled-runs"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _glasshive_base_url() -> str:
    return (
        os.getenv("GLASSHIVE_RUNTIME_URL")
        or os.getenv("WPR_API_URL")
        or os.getenv("GLASSHIVE_RUNTIME_BASE_URL")
        or os.getenv("WPR_MCP_BASE_URL")
        or "http://127.0.0.1:8766"
    ).rstrip("/")


def _glasshive_headers() -> Dict[str, str]:
    headers = {"Content-Type": "application/json"}
    token = (os.getenv("WPR_API_TOKEN") or os.getenv("GLASSHIVE_API_TOKEN") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
        headers["X-WPR-Token"] = token
    return headers


def _glasshive_callback_secret() -> str:
    return (
        os.getenv("SCHEDULING_GLASSHIVE_CALLBACK_SECRET")
        or os.getenv("VIVENTIUM_GLASSHIVE_CALLBACK_SECRET")
        or os.getenv("SCHEDULER_LIBRECHAT_SECRET")
        or os.getenv("VIVENTIUM_SCHEDULER_SECRET")
        or ""
    ).strip()


def _glasshive_callback_url() -> str:
    explicit = (os.getenv("SCHEDULING_GLASSHIVE_CALLBACK_URL") or "").strip()
    if explicit:
        return explicit
    scheduling_mcp_url = (os.getenv("SCHEDULING_MCP_URL") or "").strip()
    if scheduling_mcp_url:
        parsed = urllib.parse.urlsplit(scheduling_mcp_url)
        path = parsed.path.rstrip("/")
        if path.endswith("/mcp"):
            path = path[:-4]
        path = f"{path}/internal/scheduled-prompts/glasshive-callback"
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))
    port = (
        os.getenv("VIVENTIUM_SCHEDULING_MCP_PORT")
        or os.getenv("SCHEDULING_MCP_PORT")
        or os.getenv("SCHEDULER_PORT")
        or "7010"
    ).strip()
    return f"http://127.0.0.1:{port}/internal/scheduled-prompts/glasshive-callback"


def _workbench_metadata(task: Dict[str, Any]) -> Dict[str, Any]:
    metadata = task.get("metadata")
    if not isinstance(metadata, dict):
        return {}
    nested = metadata.get("workbench_scheduled_prompt")
    return nested if isinstance(nested, dict) else {}


def _glasshive_workspace_schedule_metadata(task: Dict[str, Any]) -> Dict[str, Any]:
    metadata = task.get("metadata")
    if not isinstance(metadata, dict):
        return {}
    nested = metadata.get("glasshive_workspace_schedule")
    return nested if isinstance(nested, dict) else {}


_CODEX_REASONING_EFFORTS = {"none", "minimal", "low", "medium", "high", "xhigh"}


def _workbench_codex_reasoning_effort(value: Any = None) -> str:
    configured = str(os.getenv("WPR_CODEX_CLI_REASONING_EFFORT") or "").strip().lower()
    if configured in _CODEX_REASONING_EFFORTS:
        return configured
    requested = str(value or "").strip().lower()
    return requested if requested in _CODEX_REASONING_EFFORTS else ""


def _workbench_codex_model(value: Any = None) -> str:
    return str(
        os.getenv("WPR_MODEL_HOST_CODEX_CLI")
        or os.getenv("WPR_MODEL_CODEX_CLI")
        or value
        or ""
    ).strip()


def _import_workbench_scheduled_prompts() -> Any:
    # VIVENTIUM START: Prefer an already-installed Workbench package so side-by-side
    # release worktrees and installed layouts do not depend on repository ancestry.
    try:
        from prompt_workbench import scheduled_prompts as workbench_scheduled_prompts

        return workbench_scheduled_prompts
    except ModuleNotFoundError as exc:
        if exc.name not in {"prompt_workbench", "prompt_workbench.scheduled_prompts"}:
            raise
    # VIVENTIUM END

    current = Path(__file__).resolve()
    for parent in current.parents:
        backend_root = parent / "viventium_v0_4" / "prompt-workbench" / "backend"
        if backend_root.is_dir():
            if str(parent) not in sys.path:
                sys.path.insert(0, str(parent))
            if str(backend_root) not in sys.path:
                sys.path.insert(0, str(backend_root))
            from prompt_workbench import scheduled_prompts as workbench_scheduled_prompts

            return workbench_scheduled_prompts
    raise RuntimeError("Prompt Workbench backend is unavailable for scheduled prompt rendering")


def _refresh_workbench_rendered_prompt(
    storage: ScheduleStorage,
    task: Dict[str, Any],
    wb: Dict[str, Any],
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    dispatched_occurrence = task.get("next_run_at")
    definition_id = str(wb.get("definition_id") or "").strip()
    if not definition_id:
        raise RuntimeError("Workbench scheduled prompt metadata missing definition_id; refusing stale dispatch")
    definition = storage.get_scheduled_prompt_definition(definition_id)
    if not definition:
        raise RuntimeError(
            f"Workbench scheduled prompt definition {definition_id} unavailable; refusing stale dispatch"
        )
    prompt_text = str(definition.get("prompt_text") or "")
    if "{{" not in prompt_text:
        return task, wb

    renderer = _import_workbench_scheduled_prompts()
    user_id = str(task.get("user_id") or definition.get("user_id") or "")
    render_payload = renderer.render_variables(
        prompt_text,
        user_id=user_id,
        email=None,
        snapshot_mode="create",
    )
    rendered = str(render_payload.get("rendered") or "")
    if not rendered:
        raise RuntimeError("Prompt Workbench scheduled prompt rendered empty at dispatch time")

    now_iso = to_utc_iso(datetime.now(timezone.utc))
    latest_version = storage.latest_scheduled_prompt_version(definition_id)
    rendered_hash = str(render_payload.get("renderedHash") or _sha256_prefix(rendered))
    snapshot_json = str(render_payload.get("variableSnapshotJson") or "{}")
    snapshot_hash = str(render_payload.get("variableSnapshotHash") or _sha256_prefix(snapshot_json))
    rendered_marker = f"<private-rendered-prompt hash=\"{rendered_hash}\" />"
    snapshot_marker = json.dumps(
        {
            "kind": "private-variable-snapshot",
            "hash": snapshot_hash,
            "privateDetail": f"private://scheduled-prompt-variable-snapshot/{snapshot_hash}",
        },
        sort_keys=True,
    )
    version = latest_version
    if not latest_version or str(latest_version.get("rendered_hash") or "") != rendered_hash:
        version_number = int((latest_version or {}).get("version_number") or 0) + 1
        version = {
            "id": f"spv_{uuid.uuid4().hex}",
            "definition_id": definition_id,
            "version_number": version_number,
            "prompt_text": prompt_text,
            "rendered_text": rendered_marker,
            "rendered_hash": rendered_hash,
            "variable_snapshot_json": snapshot_marker,
            "variable_snapshot_hash": snapshot_hash,
            "created_at": now_iso,
        }
        storage.create_scheduled_prompt_version(version)

    metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    definition_metadata = definition.get("metadata") if isinstance(definition.get("metadata"), dict) else {}
    execution_metadata = definition_metadata.get("execution") if isinstance(definition_metadata.get("execution"), dict) else {}
    patched_metadata = dict(metadata)
    if execution_metadata:
        patched_metadata["execution"] = execution_metadata
    patched_wb = dict(wb)
    execution_profile = str(
        execution_metadata.get("execution_profile")
        or wb.get("execution_profile")
        or "codex-cli"
    ).strip()
    execution_model = str(
        execution_metadata.get("execution_model") or wb.get("execution_model") or ""
    ).strip()
    reasoning_effort = str(
        execution_metadata.get("reasoning_effort") or wb.get("reasoning_effort") or ""
    ).strip()
    execution_model = _glasshive_profile_model(execution_profile, execution_model)
    reasoning_effort = _glasshive_profile_reasoning_effort(
        execution_profile, reasoning_effort
    )
    fallback_worker_route = _glasshive_fallback_worker_route(
        {
            "execution_profile": execution_profile,
            "fallback_worker_profile": execution_metadata.get(
                "fallback_worker_profile"
            )
            or wb.get("fallback_worker_profile"),
            "fallback_worker_model": execution_metadata.get(
                "fallback_worker_model"
            )
            or wb.get("fallback_worker_model"),
            "fallback_reasoning_effort": execution_metadata.get(
                "fallback_reasoning_effort"
            )
            or wb.get("fallback_reasoning_effort"),
        }
    )

    patched_wb.update(
        {
            "definition_id": definition_id,
            "version_id": (version or {}).get("id"),
            "title": definition.get("title") or wb.get("title"),
            "template_id": definition.get("template_id") or wb.get("template_id"),
            "source_prompt_id": definition.get("source_prompt_id") or wb.get("source_prompt_id"),
            "rendered_hash": rendered_hash,
            "variable_snapshot_hash": snapshot_hash,
            "variable_snapshot_json": snapshot_json,
            "variable_snapshot_pointer": f"private://scheduled-prompt-variable-snapshot/{snapshot_hash}",
            "periphery_snapshot_ref": str(
                (render_payload.get("peripherySnapshotManifest") or {}).get("snapshotRef") or ""
            ),
            "periphery_snapshot_json": render_payload.get("privatePeripherySnapshotJson"),
            "memory_write_mode": definition.get("memory_write_mode") or wb.get("memory_write_mode") or "off",
            "workspace_alias": definition.get("workspace_alias") or wb.get("workspace_alias"),
            "my_folder": definition.get("my_folder") or wb.get("my_folder"),
            "executor": execution_metadata.get("executor") or wb.get("executor") or task.get("executor"),
            "glasshive_worker_strategy": execution_metadata.get("glasshive_worker_strategy") or wb.get("glasshive_worker_strategy") or "same_worker",
            "execution_profile": execution_profile,
            "execution_mode": execution_metadata.get("execution_mode") or wb.get("execution_mode") or "host",
            "execution_model": execution_model,
            "reasoning_effort": reasoning_effort,
            "workspace_root": execution_metadata.get("workspace_root") or wb.get("workspace_root"),
        }
    )
    for field in (
        "fallback_worker_profile",
        "fallback_worker_model",
        "fallback_reasoning_effort",
    ):
        if field in fallback_worker_route:
            patched_wb[field] = fallback_worker_route[field]
        else:
            patched_wb.pop(field, None)
    persisted_wb = dict(patched_wb)
    persisted_wb.pop("variable_snapshot_json", None)
    persisted_wb.pop("periphery_snapshot_json", None)
    patched_metadata["workbench_scheduled_prompt"] = persisted_wb
    updated_task = storage.update_task(
        user_id,
        str(task.get("id") or ""),
        {
            "prompt": prompt_text,
            "metadata": patched_metadata,
            "updated_at": now_iso,
            "updated_by": "agent:scheduling-cortex",
            "updated_source": "runtime",
        },
    )
    runtime_metadata = dict(patched_metadata)
    runtime_metadata["workbench_scheduled_prompt"] = patched_wb
    if updated_task:
        patched_task = _restore_scheduled_prompt_runtime_context(updated_task, task)
        patched_task["next_run_at"] = dispatched_occurrence
        patched_task["prompt"] = rendered
        patched_task["metadata"] = runtime_metadata
        return patched_task, patched_wb
    patched_task = dict(task)
    patched_task["prompt"] = rendered
    patched_task["metadata"] = runtime_metadata
    return patched_task, patched_wb


def _write_private_run_detail(run_id: str, payload: Dict[str, Any]) -> str:
    path = _private_workbench_run_dir() / f"{run_id}.json"
    _replace_private_run_detail(path, payload)
    return str(path)


def _replace_private_run_detail(path: Path, payload: Dict[str, Any]) -> None:
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix=f".{path.name}.",
        dir=str(path.parent),
        delete=False,
    )
    temporary = Path(handle.name)
    try:
        with handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _patch_private_run_detail(path_value: str, updates: Dict[str, Any]) -> bool:
    path = Path(str(path_value or "")).expanduser()
    if not path_value or not path.exists():
        return False
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        current = {}
    if not isinstance(current, dict):
        current = {}
    current.update(updates)
    _replace_private_run_detail(path, current)
    return True


_LOCAL_PATH_RE = re.compile(r"(?:/Users|/home|/private/var|/var/folders)/[^\s`'\"<>]+")
_URL_RE = re.compile(r"https?:\/\/[^\s`'\"<>)]*", re.IGNORECASE)
_MONGO_URI_RE = re.compile(r"mongodb(?:\+srv)?:\/\/[^\s`'\"<>]+", re.IGNORECASE)
_BEARER_RE = re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.IGNORECASE)


def _safe_result_summary(text: Any, limit: int = 2000) -> str:
    value = str(text or "").strip()
    value = _MONGO_URI_RE.sub("<mongo-uri>", value)
    value = _BEARER_RE.sub("Bearer <redacted>", value)
    value = _URL_RE.sub("<url>", value)
    value = _LOCAL_PATH_RE.sub("<local-path>", value)
    value = re.sub(r"\s+", " ", value).strip()
    if len(value) <= limit:
        return value
    return value[: limit - 1].rstrip() + "..."


def _scheduled_prompt_error_class(exc: Exception, task: Optional[Dict[str, Any]] = None) -> str:
    if task is not None:
        return str(scheduled_exception_failure(task, exc)["error_class"])
    if isinstance(exc, HttpJsonError) and exc.failure_class:
        candidate = _safe_result_summary(exc.failure_class, limit=128)
        if re.fullmatch(r"[a-z0-9_.:-]{1,128}", candidate):
            return candidate
        return "glasshive_http_error"
    return exc.__class__.__name__


def _glasshive_execution_profile(wb: Dict[str, Any]) -> str:
    return str(wb.get("execution_profile") or "codex-cli").strip() or "codex-cli"


_GLASSHIVE_WORKER_PROFILES = {"codex-cli", "claude-code", "openclaw-general"}


def _glasshive_fallback_worker_profile(wb: Dict[str, Any]) -> str:
    primary_profile = _glasshive_execution_profile(wb)
    fallback_profile = str(wb.get("fallback_worker_profile") or "").strip()
    if (
        fallback_profile not in _GLASSHIVE_WORKER_PROFILES
        or fallback_profile == primary_profile
    ):
        return ""
    return fallback_profile


def _glasshive_profile_model(profile: str, value: Any = None) -> str:
    clean_profile = str(profile or "").strip()
    if clean_profile == "codex-cli":
        return _workbench_codex_model(value)
    if clean_profile == "claude-code":
        return str(os.getenv("WPR_MODEL_CLAUDE_CODE") or value or "").strip()
    return str(value or "").strip()


def _glasshive_profile_reasoning_effort(profile: str, value: Any = None) -> str:
    clean_profile = str(profile or "").strip()
    if clean_profile == "codex-cli":
        return _workbench_codex_reasoning_effort(value)
    if clean_profile == "claude-code":
        configured = str(os.getenv("WPR_CLAUDE_CODE_EFFORT") or "").strip().lower()
        if configured in {"default", "max"}:
            return configured
        requested = str(value or "").strip().lower()
        return requested if requested in {"default", "max"} else ""
    return str(value or "").strip().lower()


def _glasshive_fallback_worker_route(wb: Dict[str, Any]) -> Dict[str, str]:
    fallback_profile = _glasshive_fallback_worker_profile(wb)
    if not fallback_profile:
        return {}
    fallback_model = _glasshive_profile_model(
        fallback_profile, wb.get("fallback_worker_model")
    )
    fallback_effort = _glasshive_profile_reasoning_effort(
        fallback_profile, wb.get("fallback_reasoning_effort")
    )
    if not fallback_model or not fallback_effort:
        raise RuntimeError(
            "Prompt Workbench fallback automation requires an exact model and reasoning effort"
        )
    return {
        "fallback_worker_profile": fallback_profile,
        "fallback_worker_model": fallback_model,
        "fallback_reasoning_effort": fallback_effort,
    }


def _glasshive_execution_model(wb: Dict[str, Any]) -> str:
    profile = _glasshive_execution_profile(wb)
    return _glasshive_profile_model(profile, wb.get("execution_model"))


def _verify_workbench_worker_tuple(
    worker: Dict[str, Any], expected: Dict[str, str]
) -> None:
    mismatches = {
        field: {
            "expected": str(expected.get(field) or ""),
            "actual": str(worker.get(field) or ""),
        }
        for field in ("profile", "model", "execution_mode")
        if str(worker.get(field) or "") != str(expected.get(field) or "")
    }
    if mismatches:
        fields = ", ".join(sorted(mismatches))
        raise RuntimeError(
            f"GlassHive Workbench worker tuple mismatch for: {fields}"
        )


def _glasshive_execution_mode(wb: Dict[str, Any]) -> str:
    mode = str(wb.get("execution_mode") or "host").strip().lower() or "host"
    if mode not in {"host", "docker"}:
        raise RuntimeError(f"Unsupported GlassHive execution mode: {mode}")
    return mode


def _glasshive_execution_backend(wb: Dict[str, Any]) -> str:
    return str(wb.get("execution_backend") or wb.get("backend") or "openclaw").strip() or "openclaw"


# === VIVENTIUM START ===
# Feature: Private Scheduling Cortex detail updates.
def _patch_private_run_detail(path_value: str, updates: Dict[str, Any]) -> None:
    path = Path(str(path_value or "")).expanduser()
    if not path_value or not path.exists():
        return
    try:
        current = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        current = {}
    if not isinstance(current, dict):
        current = {}
    current.update(updates)
    path.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
# === VIVENTIUM END ===


def _can_recover_workbench_host_dependency_to_docker(
    exc: Exception,
    *,
    execution_mode: str,
    workspace_root: str,
    artifact_contract: Dict[str, Any] | None = None,
    memory_write_mode: str = "off",
    my_folder: str = "",
) -> bool:
    if not isinstance(exc, HttpJsonError):
        return False
    if exc.failure_class not in {
        "runtime_dependency_missing",
        "parallel_execution_isolation_required",
    }:
        return False
    if execution_mode != "host":
        return False
    if exc.failure_class == "runtime_dependency_missing" and workspace_root:
        return False
    has_supported_artifact_return = bool(artifact_contract) and memory_write_mode == "off"
    if exc.failure_class == "parallel_execution_isolation_required":
        return has_supported_artifact_return
    # The established dependency-missing fallback may still return the worker's final report for
    # a custom memory-off prompt. Memory proposal/apply modes remain on the host because their
    # governed writeback contract is not available inside an isolated workspace.
    return memory_write_mode == "off"


def _isolated_workbench_text(text: Any, my_folder: Any) -> str:
    return rebase_isolated_workbench_text(text, my_folder)


def _glasshive_instruction(
    task: Dict[str, Any], wb: Dict[str, Any], *, isolated_artifacts: bool = False
) -> str:
    memory_mode = str(wb.get("memory_write_mode") or "off").strip()
    my_folder = str(wb.get("my_folder") or "").strip()
    rendered = str(task.get("prompt") or "").strip()
    if isolated_artifacts:
        rendered = _isolated_workbench_text(rendered, my_folder)
    governance = [
        "You are executing a Prompt Workbench scheduled prompt through GlassHive.",
        "Use the rendered prompt and provided snapshot files as the source of truth.",
        "Do not request or use raw Mongo credentials. Database-facing context has already been resolved server-side.",
        f"Memory write mode: {memory_mode}.",
        "If memory write mode is off, do not modify account memory.",
        "If memory write mode is propose, write governed memory proposals only.",
        "If memory write mode is apply_governed, write structured proposals; Scheduling Cortex/Workbench applies them through governed Viventium/LibreChat memory methods. Never direct-write memory collections.",
    ]
    if isolated_artifacts:
        governance.append(
            "This run is isolated. Write declared user-facing artifacts under the relative `artifacts/` root; Scheduling Cortex validates and imports supported artifact contracts after completion."
        )
    elif my_folder:
        governance.append(f"Private scratchpad folder: {my_folder}")
        governance.append(
            "For memory proposals, write UTF-8 JSON under that folder named memory-proposals-yyyymmddHHmm.json with an actions array of set/delete objects."
        )
    governance.append("End every run with a concise `FINAL REPORT:` section.")
    return "\n".join(governance).strip() + "\n\n" + rendered + "\n"


def _glasshive_bootstrap_bundle(
    task: Dict[str, Any],
    wb: Dict[str, Any],
    run_id: str,
    *,
    isolated_artifacts: bool = False,
    execution_mode: str = "host",
) -> Dict[str, Any]:
    rendered = str(task.get("prompt") or "")
    if isolated_artifacts:
        rendered = _isolated_workbench_text(rendered, wb.get("my_folder"))
    snapshot_json = str(wb.get("variable_snapshot_json") or "{}")
    execution_profile = str(wb.get("execution_profile") or "codex-cli").strip()
    execution_model = _glasshive_profile_model(
        execution_profile, wb.get("execution_model")
    )
    reasoning_effort = _glasshive_profile_reasoning_effort(
        execution_profile, wb.get("reasoning_effort")
    )
    if not execution_model:
        if execution_profile == "codex-cli":
            raise RuntimeError(
                "Prompt Workbench Codex automation requires "
                "WPR_MODEL_HOST_CODEX_CLI or execution_model"
            )
        raise RuntimeError(
            "Prompt Workbench automation requires an exact configured execution model"
        )
    if not reasoning_effort:
        if execution_profile == "codex-cli":
            raise RuntimeError(
                "Prompt Workbench Codex automation requires "
                "WPR_CODEX_CLI_REASONING_EFFORT or reasoning_effort"
            )
        raise RuntimeError(
            "Prompt Workbench automation requires an exact configured reasoning effort"
        )
    fallback_worker_route = _glasshive_fallback_worker_route(wb)
    callbacks = {
        "events_webhook_url": _glasshive_callback_url(),
        "hmac_secret": _glasshive_callback_secret(),
        "user_id": str(task.get("user_id") or ""),
        "conversation_id": f"workbench-scheduled-prompt:{task.get('id')}",
        "parent_message_id": f"scheduled-prompt:{task.get('id')}",
        "message_id": run_id,
        "surface": "workbench",
        "scheduled_prompt_run_id": run_id,
        "scheduled_prompt_task_id": str(task.get("id") or ""),
    }
    projected_files: list[Dict[str, Any]] = [
        {
            "scope": "workspace",
            "path": "scheduled-prompt/rendered-prompt.md",
            "content": rendered,
        },
        {
            "scope": "workspace",
            "path": "scheduled-prompt/variable-snapshot.json",
            "content": snapshot_json,
        },
        {
            "scope": "workspace",
            "path": "scheduled-prompt/run-context.json",
            "content": json.dumps(
                {
                    "scheduledRunRef": {
                        "runId": run_id,
                        "taskId": str(task.get("id") or ""),
                        "definitionId": str(wb.get("definition_id") or ""),
                    },
                    "snapshotRef": str(wb.get("periphery_snapshot_ref") or ""),
                },
                indent=2,
                sort_keys=True,
            ),
        },
    ]
    periphery_snapshot_json = str(wb.get("periphery_snapshot_json") or "").strip()
    if periphery_snapshot_json:
        projected_files.append(
            {
                "scope": "workspace",
                "path": "scheduled-prompt/periphery-snapshot.json",
                "content": periphery_snapshot_json,
            }
        )
    projected_files.extend(
        [
            {
                "scope": "workspace",
                "path": "scheduled-prompt/run-contract.md",
                "content": (
                    "# Run Contract\n\n"
                    "- Execute the rendered prompt.\n"
                    "- Use `work-log.md` for private notes.\n"
                    "- Write text files as UTF-8. If browser-checking markdown, serve it through `python3 scheduled-prompt/utf8_static_server.py` so the browser receives an explicit UTF-8 charset.\n"
                    + (
                        "- This isolated run may only return the declared supported artifact contract; do not create memory proposals.\n"
                        if isolated_artifacts
                        else "- If you produce memory changes, write `memory-proposals-yyyymmddHHmm.json` in my_folder with `{ \"actions\": [{ \"action\": \"set\", \"key\": \"context\", \"value\": \"...\", \"reason\": \"...\" }] }`.\n"
                    )
                    +
                    "- End with `FINAL REPORT:` containing outcome, artifacts, blockers, and next decision.\n"
                ),
            },
            {
                "scope": "workspace",
                "path": "scheduled-prompt/utf8_static_server.py",
                "content": (
                    "from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer\n\n"
                    "class Handler(SimpleHTTPRequestHandler):\n"
                    "    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8'}\n\n"
                    "if __name__ == '__main__':\n"
                    "    ThreadingHTTPServer(('127.0.0.1', 8765), Handler).serve_forever()\n"
                ),
            },
        ]
    )
    clean_execution_mode = str(execution_mode or "host").strip().lower()
    bootstrap_env: Dict[str, str] = {}
    if clean_execution_mode == "host" and execution_profile == "codex-cli":
        bootstrap_env = {
            "WPR_MODEL_HOST_CODEX_CLI": execution_model,
            "WPR_CODEX_CLI_REASONING_EFFORT": reasoning_effort,
            "WPR_CODEX_CLI_IGNORE_USER_CONFIG": "true",
        }
    if clean_execution_mode == "docker":
        primary_effort_env = (
            "WPR_CODEX_CLI_REASONING_EFFORT"
            if execution_profile == "codex-cli"
            else "WPR_CLAUDE_CODE_EFFORT"
        )
        bootstrap_env[primary_effort_env] = reasoning_effort
        fallback_profile = fallback_worker_route.get("fallback_worker_profile")
        if fallback_profile:
            fallback_effort_env = (
                "WPR_CODEX_CLI_REASONING_EFFORT"
                if fallback_profile == "codex-cli"
                else "WPR_CLAUDE_CODE_EFFORT"
            )
            bootstrap_env[fallback_effort_env] = fallback_worker_route[
                "fallback_reasoning_effort"
            ]
    bundle = {
        "callbacks": callbacks,
        "env": bootstrap_env,
        "agents_md": (
            "This is a Viventium Prompt Workbench scheduled prompt worker. "
            "Keep raw prompt/result details inside the private GlassHive workspace and end with FINAL REPORT."
        ),
        "codex_md": (
            "Use full local capabilities available to this GlassHive workspace. "
            "Respect governed memory writeback and do not direct-write parent databases."
        ),
        "files": projected_files,
    }
    if clean_execution_mode == "docker":
        bundle["viventium_execution_authority_request"] = {
            "version": 1,
            "kind": "prompt_workbench_scheduled",
            "execution_mode": "docker",
            "primary": {
                "worker_profile": execution_profile,
                "model": execution_model,
                "reasoning_effort": reasoning_effort,
            },
            **(
                {
                    "fallback": {
                        "worker_profile": fallback_worker_route[
                            "fallback_worker_profile"
                        ],
                        "model": fallback_worker_route["fallback_worker_model"],
                        "reasoning_effort": fallback_worker_route[
                            "fallback_reasoning_effort"
                        ],
                    }
                }
                if fallback_worker_route
                else {}
            ),
        }
    return bundle


def _ensure_glasshive_project(storage: ScheduleStorage, task: Dict[str, Any], wb: Dict[str, Any]) -> str:
    base_url = _glasshive_base_url()
    timeout_s = int(os.getenv("SCHEDULER_GLASSHIVE_HTTP_TIMEOUT_S", "20"))

    def project_exists(candidate_id: str) -> bool:
        try:
            _get_json(
                f"{base_url}/v1/projects/{urllib.parse.quote(candidate_id)}",
                _glasshive_headers(),
                timeout_s,
            )
        except HttpJsonError as exc:
            if exc.status == 404:
                return False
            raise
        except urllib.error.URLError:
            raise
        return True

    definition_id = str(wb.get("definition_id") or "").strip()
    definition = storage.get_scheduled_prompt_definition(definition_id) if definition_id else None
    definition_metadata = definition.get("metadata") if isinstance(definition, dict) and isinstance(definition.get("metadata"), dict) else {}
    task_metadata = task.get("metadata") if isinstance(task.get("metadata"), dict) else {}
    wb_metadata = task_metadata.get("workbench_scheduled_prompt") if isinstance(task_metadata.get("workbench_scheduled_prompt"), dict) else {}

    def persist_project_id(project_id: str) -> None:
        if definition_id and definition:
            patched_metadata = dict(definition_metadata)
            if patched_metadata.get("glasshive_project_id") != project_id:
                patched_metadata["glasshive_project_id"] = project_id
                storage.update_scheduled_prompt_definition(
                    definition_id,
                    {"metadata": patched_metadata, "updated_at": to_utc_iso(datetime.now(timezone.utc))},
                )
        if wb_metadata and wb_metadata.get("glasshive_project_id") != project_id:
            patched_task_metadata = dict(task_metadata)
            patched_wb_metadata = dict(wb_metadata)
            patched_wb_metadata["glasshive_project_id"] = project_id
            patched_task_metadata["workbench_scheduled_prompt"] = patched_wb_metadata
            storage.update_task(
                str(task.get("user_id") or ""),
                str(task.get("id") or ""),
                {"metadata": patched_task_metadata, "updated_at": to_utc_iso(datetime.now(timezone.utc))},
            )

    project_id = str(wb.get("glasshive_project_id") or "").strip()
    if project_id and project_exists(project_id):
        persist_project_id(project_id)
        return project_id
    project_id = str(definition_metadata.get("glasshive_project_id") or "").strip()
    if project_id and project_exists(project_id):
        persist_project_id(project_id)
        return project_id
    title = str(wb.get("title") or "Workbench Scheduled Prompt").strip()
    project = _post_json(
        f"{base_url}/v1/projects",
        {
            "owner_id": str(task.get("user_id") or "workbench"),
            "title": title,
            "goal": "Execute private Prompt Workbench scheduled prompts.",
            "default_worker_profile": _glasshive_execution_profile(wb),
        },
        _glasshive_headers(),
        int(os.getenv("SCHEDULER_GLASSHIVE_HTTP_TIMEOUT_S", "20")),
    )
    project_id = str(project.get("project_id") or "").strip()
    if not project_id:
        raise RuntimeError("GlassHive project creation did not return project_id")
    persist_project_id(project_id)
    return project_id


def _dispatch_glasshive_task(task: Dict[str, Any]) -> Dict[str, Any]:
    wb = _workbench_metadata(task)
    if not wb:
        raise RuntimeError("glasshive_host executor requires workbench_scheduled_prompt metadata")
    if not _glasshive_callback_secret():
        raise RuntimeError("SCHEDULING_GLASSHIVE_CALLBACK_SECRET is required for signed GlassHive callbacks")

    expected_preclaim = _scheduled_preclaim_context(task)
    storage = _scheduler_storage()
    task, wb = _refresh_workbench_rendered_prompt(storage, task, wb)
    if expected_preclaim is not None:
        refreshed_preclaim = _scheduled_preclaim_context(task, required=True)
        if refreshed_preclaim != expected_preclaim:
            raise RuntimeError(
                "scheduled preclaim context changed during Workbench refresh; "
                "refusing an unkeyed GlassHive dispatch"
            )
    trigger_kind = str(task.get("_scheduled_prompt_trigger_kind") or "unknown")
    trigger_source = str(task.get("_scheduled_prompt_trigger_source") or "unverified_caller")
    now = datetime.now(timezone.utc)
    now_iso = to_utc_iso(now)
    execution_mode = _glasshive_execution_mode(wb)
    memory_write_mode = str(wb.get("memory_write_mode") or "off").strip() or "off"
    my_folder = str(wb.get("my_folder") or "").strip()
    supported_artifact_contract = isolated_periphery_contract(wb.get("template_id"))
    artifact_return_contract = (
        supported_artifact_contract
        if execution_mode == "docker" and memory_write_mode == "off"
        else None
    )
    execution_snapshot = {
        "executor": "glasshive_host",
        "dispatch_idempotency_key": str(
            task.get("_scheduled_prompt_occurrence_key")
            or task.get("_scheduled_prompt_run_id")
            or ""
        ),
        "model": _glasshive_execution_model(wb),
        "reasoning_effort": _glasshive_profile_reasoning_effort(
            _glasshive_execution_profile(wb), wb.get("reasoning_effort")
        ),
        "profile": _glasshive_execution_profile(wb),
        "backend": _glasshive_execution_backend(wb),
        "execution_mode": execution_mode,
        **(
            {"source_prompt_id": source_prompt_id}
            if (source_prompt_id := _declared_scheduler_source_prompt_id(task))
            else {}
        ),
    }
    fallback_worker_route = _glasshive_fallback_worker_route(wb)
    execution_snapshot.update(fallback_worker_route)
    preclaimed_run_id = str(task.get("_scheduled_prompt_run_id") or "").strip()
    run_id = preclaimed_run_id or f"sp_run_{uuid.uuid4().hex}"
    rendered_text = str(task.get("prompt") or "")
    rendered_hash = str(wb.get("rendered_hash") or _sha256_prefix(rendered_text))
    snapshot_hash = str(wb.get("variable_snapshot_hash") or "")
    private_detail_path = _write_private_run_detail(
        run_id,
        {
            "run_id": run_id,
            "task_id": task.get("id"),
            "definition_id": wb.get("definition_id"),
            "version_id": wb.get("version_id"),
            "template_id": wb.get("template_id"),
            "created_at": now_iso,
            "user_id": str(task.get("user_id") or ""),
            "memory_write_mode": wb.get("memory_write_mode") or "off",
            "my_folder": wb.get("my_folder"),
            "rendered_prompt": rendered_text,
            "variable_snapshot_json": wb.get("variable_snapshot_json"),
            "periphery_snapshot_ref": wb.get("periphery_snapshot_ref"),
            "trigger_kind": trigger_kind,
            "trigger_source": trigger_source,
            **(
                {"artifact_return": artifact_return_contract}
                if artifact_return_contract
                else {}
            ),
        },
    )
    run_record = {
            "run_id": run_id,
            "task_id": str(task.get("id") or ""),
            "definition_id": wb.get("definition_id"),
            "user_id": str(task.get("user_id") or ""),
            "version_id": wb.get("version_id"),
            "due_at": str(task.get("next_run_at") or now_iso),
            "started_at": now_iso,
            "completed_at": None,
            "status": "dispatching",
            "executor": "glasshive_host",
            "rendered_hash": rendered_hash,
            "variable_snapshot_hash": snapshot_hash,
            "glasshive_project_id": None,
            "glasshive_worker_id": None,
            "glasshive_run_id": None,
            "result_summary": None,
            "error_class": None,
            "private_detail_path": private_detail_path,
            "callback_payload_json": None,
            "trigger_kind": trigger_kind,
            "trigger_source": trigger_source,
            "execution_snapshot": execution_snapshot,
            "created_at": now_iso,
            "updated_at": now_iso,
        }
    if preclaimed_run_id:
        storage.update_scheduled_prompt_run(
            run_id,
            {
                key: value
                for key, value in run_record.items()
                if key not in {"run_id", "task_id", "user_id", "created_at"}
            },
        )
    else:
        storage.create_scheduled_prompt_run(run_record)

    if (os.getenv("SCHEDULER_GLASSHIVE_DISABLE_DISPATCH") or "").strip() == "1":
        storage.update_scheduled_prompt_run(
            run_id,
            {
                "status": "queued",
                "result_summary": "GlassHive dispatch disabled by test environment.",
                "updated_at": to_utc_iso(datetime.now(timezone.utc)),
            },
        )
        return {
            "delivery": {
                "outcome": "queued",
                "reason": "glasshive_dispatch_disabled",
                "generated_text": None,
                "channels": {"workbench": {"outcome": "queued", "reason": "test_disabled"}},
            },
            "scheduled_prompt_run_id": run_id,
            "execution": execution_snapshot,
        }

    try:
        if execution_mode == "docker" and my_folder and not artifact_return_contract:
            raise RuntimeError(
                "Isolated Workbench execution requires a declared artifact return contract "
                "and memory_write_mode=off when a private host folder is configured"
            )
        base_url = _glasshive_base_url()
        timeout_s = int(os.getenv("SCHEDULER_GLASSHIVE_HTTP_TIMEOUT_S", "20"))
        execution_profile = _glasshive_execution_profile(wb)
        execution_mode = _glasshive_execution_mode(wb)
        project_id = _ensure_glasshive_project(storage, task, wb)
        alias = str(wb.get("workspace_alias") or f"workbench-scheduled-{str(wb.get('definition_id') or task.get('id'))[:12]}")
        if str(wb.get("glasshive_worker_strategy") or "same_worker").strip() == "new_worker_each_run":
            alias = f"{alias}-{run_id[-8:]}"
        workspace_root = str(wb.get("workspace_root") or "").strip()
        isolated_artifacts = bool(artifact_return_contract)
        worker_payload = {
            "owner_id": str(task.get("user_id") or "workbench"),
            "name": str(wb.get("title") or "Workbench Scheduled Prompt"),
            "role": "Execute private Prompt Workbench scheduled prompts for Viventium.",
            "profile": execution_profile,
            "backend": _glasshive_execution_backend(wb),
            "execution_mode": execution_mode,
            "alias": alias,
            "workspace_root": workspace_root,
            "bootstrap_profile": "prompt-workbench-scheduled-v1",
            "bootstrap_bundle": _glasshive_bootstrap_bundle(
                task,
                wb,
                run_id,
                isolated_artifacts=isolated_artifacts,
                execution_mode=execution_mode,
            ),
        }
        runtime_recovery: Dict[str, Any] | None = None
        find_or_resume_url = f"{base_url}/v1/projects/{urllib.parse.quote(project_id)}/workers/find-or-resume"

        def recover_worker_to_docker(exc: HttpJsonError) -> Dict[str, Any]:
            nonlocal artifact_return_contract, execution_mode, isolated_artifacts
            nonlocal runtime_recovery, worker_payload, workspace_root
            if not _can_recover_workbench_host_dependency_to_docker(
                exc,
                execution_mode=execution_mode,
                workspace_root=workspace_root,
                artifact_contract=supported_artifact_contract,
                memory_write_mode=memory_write_mode,
                my_folder=my_folder,
            ):
                raise exc
            artifact_return_contract = (
                supported_artifact_contract if memory_write_mode == "off" else None
            )
            isolated_artifacts = bool(artifact_return_contract)
            runtime_recovery = {
                "from_execution_mode": "host",
                "to_execution_mode": "docker",
                "reason_class": exc.failure_class,
                "artifact_return": artifact_return_contract,
            }
            worker_payload = dict(worker_payload)
            worker_payload["execution_mode"] = "docker"
            worker_payload["workspace_root"] = ""
            worker_payload["bootstrap_bundle"] = _glasshive_bootstrap_bundle(
                task,
                wb,
                run_id,
                isolated_artifacts=isolated_artifacts,
                execution_mode="docker",
            )
            detail_updates: Dict[str, Any] = {"runtime_recovery": runtime_recovery}
            if artifact_return_contract:
                detail_updates["artifact_return"] = artifact_return_contract
            recovery_recorded = _patch_private_run_detail(
                private_detail_path,
                detail_updates,
            )
            if not recovery_recorded:
                raise RuntimeError(
                    "Isolated Workbench recovery could not persist its private artifact contract"
                )
            recovered = _post_json(
                find_or_resume_url,
                worker_payload,
                _glasshive_headers(),
                timeout_s,
            )
            execution_mode = "docker"
            workspace_root = ""
            return recovered

        try:
            worker = _post_json(
                find_or_resume_url,
                worker_payload,
                _glasshive_headers(),
                timeout_s,
            )
        except HttpJsonError as exc:
            worker = recover_worker_to_docker(exc)
        _verify_workbench_worker_tuple(
            worker,
            {
                "profile": execution_profile,
                "model": str(execution_snapshot.get("model") or ""),
                "execution_mode": execution_mode,
            },
        )
        worker_id = str(worker.get("worker_id") or "").strip()
        if not worker_id:
            raise RuntimeError("GlassHive worker find-or-resume did not return worker_id")
        dispatch_key = str(
            task.get("_scheduled_prompt_occurrence_key")
            or task.get("_scheduled_prompt_run_id")
            or run_id
        ).strip()
        def assignment_request() -> tuple[str, Dict[str, str], Dict[str, Any]]:
            url = f"{base_url}/v1/workers/{urllib.parse.quote(worker_id)}/assign"
            headers = _glasshive_headers()
            headers["X-GlassHive-Idempotency-Key"] = dispatch_key
            payload = {
                "instruction": _glasshive_instruction(
                    task,
                    wb,
                    isolated_artifacts=isolated_artifacts,
                )
            }
            return url, headers, payload

        def assign_with_reconciliation() -> Dict[str, Any]:
            assign_url, assign_headers, assign_payload = assignment_request()
            try:
                return _post_json(
                    assign_url, assign_payload, assign_headers, timeout_s
                )
            except (urllib.error.URLError, TimeoutError):
                reconcile_url = (
                    f"{base_url}/v1/workers/{urllib.parse.quote(worker_id)}/"
                    "assignments/by-idempotency/"
                    f"{urllib.parse.quote(dispatch_key, safe='')}"
                )
                try:
                    return _get_json(reconcile_url, assign_headers, timeout_s)
                except HttpJsonError as error:
                    if error.status != 404:
                        raise
                    return _post_json(
                        assign_url, assign_payload, assign_headers, timeout_s
                    )

        effective_execution_snapshot = {
            **execution_snapshot,
            "effective_execution_mode": execution_mode,
            **({"runtime_recovery": runtime_recovery} if runtime_recovery else {}),
        }
        # Bind the worker before assignment. GlassHive may emit a signed queued/started callback
        # immediately after accepting the POST, and the callback must never race this identity.
        storage.update_scheduled_prompt_run(
            run_id,
            {
                "status": "dispatching",
                "glasshive_project_id": project_id,
                "glasshive_worker_id": worker_id,
                "execution_snapshot": effective_execution_snapshot,
                "updated_at": to_utc_iso(datetime.now(timezone.utc)),
            },
        )
        try:
            run = assign_with_reconciliation()
        except HttpJsonError as exc:
            worker = recover_worker_to_docker(exc)
            _verify_workbench_worker_tuple(
                worker,
                {
                    "profile": execution_profile,
                    "model": str(execution_snapshot.get("model") or ""),
                    "execution_mode": execution_mode,
                },
            )
            worker_id = str(worker.get("worker_id") or "").strip()
            if not worker_id:
                raise RuntimeError("GlassHive recovery did not return worker_id")
            effective_execution_snapshot = {
                **execution_snapshot,
                "effective_execution_mode": execution_mode,
                "runtime_recovery": runtime_recovery,
            }
            storage.update_scheduled_prompt_run(
                run_id,
                {
                    "status": "dispatching",
                    "glasshive_project_id": project_id,
                    "glasshive_worker_id": worker_id,
                    "execution_snapshot": effective_execution_snapshot,
                    "updated_at": to_utc_iso(datetime.now(timezone.utc)),
                },
            )
            run = assign_with_reconciliation()
        glasshive_run_id = str(run.get("run_id") or "").strip()
        if not glasshive_run_id:
            raise RuntimeError("GlassHive assign did not return run_id")
        storage.update_scheduled_prompt_run(
            run_id,
            {
                "status": "queued",
                "glasshive_project_id": project_id,
                "glasshive_worker_id": worker_id,
                "glasshive_run_id": glasshive_run_id,
                "result_summary": "GlassHive run queued after host runtime recovery to docker."
                if runtime_recovery
                else (
                    "GlassHive isolated run queued."
                    if execution_mode == "docker"
                    else "GlassHive host run queued."
                ),
                "execution_snapshot": effective_execution_snapshot,
                "updated_at": to_utc_iso(datetime.now(timezone.utc)),
            },
        )
        delivery_reason = (
            "glasshive_runtime_recovered_run_queued"
            if runtime_recovery
            else (
                "glasshive_isolated_run_queued"
                if execution_mode == "docker"
                else "glasshive_host_run_queued"
            )
        )
        return {
            "delivery": {
                "outcome": "queued",
                "reason": delivery_reason,
                "generated_text": None,
                "channels": {
                    "workbench": {
                        "outcome": "queued",
                        "reason": delivery_reason,
                        "scheduled_prompt_run_id": run_id,
                        "glasshive_run_id": glasshive_run_id,
                        **({"runtime_recovery": runtime_recovery} if runtime_recovery else {}),
                    }
                },
            },
            "scheduled_prompt_run_id": run_id,
            "glasshive_run_id": glasshive_run_id,
            "execution": effective_execution_snapshot,
        }
    except Exception as exc:
        failure = scheduled_exception_failure(task, exc)
        failure_snapshot = {
            **execution_snapshot,
            **(
                {"provider_route_decision": failure["provider_route_decision"]}
                if failure.get("provider_route_decision")
                else {}
            ),
        }
        storage.update_scheduled_prompt_run(
            run_id,
            {
                "status": "failed",
                "completed_at": to_utc_iso(datetime.now(timezone.utc)),
                "error_class": _scheduled_prompt_error_class(exc, task),
                "result_summary": _safe_result_summary(str(exc)),
                "execution_snapshot": failure_snapshot,
                "updated_at": to_utc_iso(datetime.now(timezone.utc)),
            },
        )
        raise


def _dispatch_glasshive_workspace_task(task: Dict[str, Any]) -> Dict[str, Any]:
    workspace = _glasshive_workspace_schedule_metadata(task)
    if not workspace:
        raise RuntimeError("glasshive_workspace executor requires structured workspace metadata")
    task_id = str(task.get("id") or "").strip()
    due_at = str(task.get("next_run_at") or to_utc_iso(datetime.now(timezone.utc))).strip()
    occurrence_key = str(
        workspace.get("pending_occurrence_key")
        or workspace.get("manual_occurrence_key")
        or due_at
    ).strip()
    digest = hashlib.sha256(f"{task_id}\0{occurrence_key}".encode("utf-8")).hexdigest()
    scheduled_run_id = f"sp_run_{digest[:32]}"
    storage = _scheduler_storage()
    existing = storage.get_scheduled_prompt_run(scheduled_run_id)
    if existing and str(existing.get("glasshive_run_id") or "").strip():
        return {
            "delivery": {
                "outcome": str(existing.get("status") or "queued"),
                "reason": "glasshive_workspace_run_already_reserved",
                "generated_text": None,
            },
            "scheduled_prompt_run_id": scheduled_run_id,
            "glasshive_run_id": existing.get("glasshive_run_id"),
        }

    now_dt = datetime.now(timezone.utc)
    now = to_utc_iso(now_dt)
    try:
        claim_seconds = int(os.getenv("SCHEDULING_OCCURRENCE_CLAIM_SECONDS") or 300)
    except ValueError:
        claim_seconds = 300
    claim_seconds = max(30, min(claim_seconds, 900))
    claim_expires_at = to_utc_iso(now_dt + timedelta(seconds=claim_seconds))
    private_detail_path = str((existing or {}).get("private_detail_path") or "").strip()
    claim = storage.claim_scheduled_prompt_run(
        {
            "run_id": scheduled_run_id,
            "task_id": task_id,
            "definition_id": None,
            "user_id": str(task.get("user_id") or ""),
            "version_id": None,
            "due_at": due_at,
            "started_at": now,
            "completed_at": None,
            "status": "dispatching",
            "executor": "glasshive_workspace",
            "rendered_hash": hashlib.sha256(str(task.get("prompt") or "").encode("utf-8")).hexdigest(),
            "variable_snapshot_hash": None,
            "glasshive_project_id": str(workspace.get("project_id") or ""),
            "glasshive_worker_id": str(workspace.get("worker_id") or ""),
            "glasshive_run_id": None,
            "result_summary": None,
            "error_class": None,
            "private_detail_path": private_detail_path,
            "callback_payload_json": None,
            "created_at": now,
            "updated_at": now,
        },
        claimed_at=now,
        claim_expires_at=claim_expires_at,
    )
    claimed_run = claim.get("run") if isinstance(claim.get("run"), dict) else {}
    if not claim.get("claimed"):
        glasshive_run_id = str(claimed_run.get("glasshive_run_id") or "").strip()
        if glasshive_run_id:
            return {
                "delivery": {
                    "outcome": str(claimed_run.get("status") or "queued"),
                    "reason": "glasshive_workspace_run_already_reserved",
                    "generated_text": None,
                },
                "scheduled_prompt_run_id": scheduled_run_id,
                "glasshive_run_id": glasshive_run_id,
            }
        reason = str(claim.get("reason") or "occurrence_claim_active")
        terminal = reason == "occurrence_terminal"
        return {
            "delivery": {
                "outcome": str(claimed_run.get("status") or "dispatching"),
                "reason": reason,
                "generated_text": None,
            },
            "scheduled_prompt_run_id": scheduled_run_id,
            "glasshive_run_id": None,
            "deferred": not terminal,
            "retry_at": claimed_run.get("claim_expires_at") if not terminal else None,
        }
    try:
        if not private_detail_path:
            private_detail_path = _write_private_run_detail(
                scheduled_run_id,
                {
                    "scheduled_prompt_run_id": scheduled_run_id,
                    "task_id": task_id,
                    "executor": "glasshive_workspace",
                    "created_at": now,
                    "user_id": str(task.get("user_id") or ""),
                },
            )
            storage.update_scheduled_prompt_run(
                scheduled_run_id,
                {
                    "private_detail_path": private_detail_path,
                    "updated_at": to_utc_iso(datetime.now(timezone.utc)),
                },
            )
        headers = _glasshive_headers()
        scheduler_secret = str(os.getenv("VIVENTIUM_SCHEDULER_SECRET") or "").strip()
        if not scheduler_secret:
            raise RuntimeError("VIVENTIUM_SCHEDULER_SECRET is required for workspace recurrence")
        execution_mode = str(workspace.get("execution_mode") or "docker").strip().lower()
        if execution_mode not in {"host", "docker"}:
            raise RuntimeError("GlassHive workspace recurrence execution mode is invalid")
        request_payload = {
            "occurrence_id": scheduled_run_id,
            "task_id": task_id,
            "tenant_id": str(workspace.get("tenant_id") or "local"),
            "owner_id": str(task.get("user_id") or ""),
            "project_id": str(workspace.get("project_id") or ""),
            "worker_id": str(workspace.get("worker_id") or ""),
            "execution_mode": execution_mode,
            "instruction": str(task.get("prompt") or ""),
        }
        headers[ASSERTION_HEADER] = mint_workspace_run_assertion(
            secret=scheduler_secret,
            request_payload=request_payload,
        )
        run = _post_json(
            f"{_glasshive_base_url()}/internal/scheduling-cortex/workspace-runs",
            request_payload,
            headers,
            int(os.getenv("SCHEDULER_GLASSHIVE_HTTP_TIMEOUT_S", "20")),
        )
        glasshive_run_id = str(run.get("run_id") or "").strip()
        if not glasshive_run_id:
            raise RuntimeError("GlassHive workspace dispatch did not return run_id")
        storage.link_scheduled_prompt_glasshive_run(
            scheduled_run_id,
            glasshive_run_id,
            queued_summary="GlassHive workspace run queued.",
            updated_at=to_utc_iso(datetime.now(timezone.utc)),
        )
        return {
            "delivery": {
                "outcome": "queued",
                "reason": "glasshive_workspace_run_queued",
                "generated_text": None,
            },
            "scheduled_prompt_run_id": scheduled_run_id,
            "glasshive_run_id": glasshive_run_id,
        }
    except Exception as exc:
        failure_retryable = getattr(exc, "failure_retryable", None)
        retryable = failure_retryable is not False
        failed_at = to_utc_iso(datetime.now(timezone.utc))
        storage.update_scheduled_prompt_run(
            scheduled_run_id,
            {
                "status": "retryable" if retryable else "failed",
                "completed_at": None if retryable else failed_at,
                "claim_expires_at": failed_at if retryable else claim_expires_at,
                "result_summary": _safe_result_summary(str(exc)),
                "error_class": _scheduled_prompt_error_class(exc),
                "updated_at": failed_at,
            },
        )
        raise
# === VIVENTIUM END ===


def _prepare_generated_visibility(
    task: Dict[str, Any],
    final_text: str,
    followup_text: str,
    final_text_source: str = "",
    final_text_fallback_reason: str = "",
    followup_text_source: str = "",
    followup_text_fallback_reason: str = "",
    suppressed_fallback_reason: str = "",
    date_guard: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    raw_final_text = final_text.strip() if isinstance(final_text, str) else ""
    raw_followup_text = followup_text.strip() if isinstance(followup_text, str) else ""

    final_text = strip_trailing_nta(final_text) if final_text else final_text
    final_text = _sanitize_scheduled_text(final_text) if final_text else final_text
    suppress_final = is_no_response_only(final_text) or not str(final_text or "").strip()
    final_suppress_reason = "nta" if is_no_response_only(final_text) else "empty"
    if suppress_final:
        final_text = ""
    if suppress_final and suppressed_fallback_reason:
        final_suppress_reason = _fallback_reason(suppressed_fallback_reason)

    followup_text = strip_trailing_nta(followup_text) if followup_text else followup_text
    followup_text = _sanitize_scheduled_text(followup_text) if followup_text else followup_text
    followup_suppressed = is_no_response_only(followup_text)
    if followup_suppressed:
        raw_followup_text = followup_text.strip() if isinstance(followup_text, str) else ""
        followup_text = ""

    followup_suppress_reason = "nta" if followup_suppressed else (
        "empty" if not str(followup_text or "").strip() else ""
    )

    final_visible_text = final_text.strip() if isinstance(final_text, str) and final_text.strip() else ""
    followup_visible_text = (
        followup_text.strip() if isinstance(followup_text, str) and followup_text.strip() else ""
    )

    def _suppressed_marker(raw_text: str, suppress_reason: str) -> Optional[str]:
        cleaned_raw = raw_text.strip() if isinstance(raw_text, str) else ""
        if not cleaned_raw:
            return None
        if suppress_reason == "nta" and is_no_response_only(cleaned_raw):
            return cleaned_raw
        return None

    generated_text: Optional[str] = None
    if final_visible_text:
        generated_text = final_visible_text
    elif followup_visible_text:
        generated_text = followup_visible_text
    else:
        generated_text = _suppressed_marker(raw_final_text, final_suppress_reason) or _suppressed_marker(
            raw_followup_text,
            followup_suppress_reason,
        )
    fallback_delivered = (
        (bool(final_visible_text) and _is_fallback_text_source(final_text_source))
        or (bool(followup_visible_text) and _is_fallback_text_source(followup_text_source))
    )
    fallback_reason = ""
    if fallback_delivered:
        fallback_reason = _fallback_reason(final_text_fallback_reason or followup_text_fallback_reason)

    return {
        "raw_final_text": raw_final_text,
        "raw_followup_text": raw_followup_text,
        "final_text": final_visible_text,
        "followup_text": followup_visible_text,
        "final_suppress_reason": final_suppress_reason,
        "followup_suppress_reason": followup_suppress_reason,
        "generated_text": generated_text,
        "final_text_source": final_text_source,
        "followup_text_source": followup_text_source,
        "fallback_delivered": fallback_delivered,
        "fallback_reason": fallback_reason,
        "date_guard": date_guard or {},
    }


def _apply_late_delivery_notice(
    task: Dict[str, Any],
    visibility: Dict[str, Any],
) -> Dict[str, Any]:
    late_delivery = _scheduler_late_delivery(task)
    if not late_delivery:
        return visibility

    notice = _format_late_delivery_notice(late_delivery)
    patched = dict(visibility)
    if str(patched.get("final_text") or "").strip():
        patched["final_text"] = _prepend_late_delivery_notice(patched.get("final_text"), notice)
        patched["generated_text"] = patched["final_text"]
    elif str(patched.get("followup_text") or "").strip():
        patched["followup_text"] = _prepend_late_delivery_notice(patched.get("followup_text"), notice)
        patched["generated_text"] = patched["followup_text"]
    patched["late_delivery"] = late_delivery
    return patched


def _build_librechat_delivery_detail(visibility: Dict[str, Any]) -> Dict[str, Any]:
    final_visible_text = visibility.get("final_text") or ""
    followup_visible_text = visibility.get("followup_text") or ""
    raw_final_text = visibility.get("raw_final_text") or ""
    raw_followup_text = visibility.get("raw_followup_text") or ""
    final_suppress_reason = visibility.get("final_suppress_reason") or ""
    followup_suppress_reason = visibility.get("followup_suppress_reason") or ""

    if final_visible_text or followup_visible_text:
        if visibility.get("fallback_delivered"):
            outcome = "fallback_delivered"
            reason = _fallback_reason(visibility.get("fallback_reason"))
        else:
            outcome = "sent"
            reason = "delivered"
    elif raw_final_text or raw_followup_text:
        outcome = "suppressed"
        if raw_final_text:
            reason = final_suppress_reason or "suppressed"
        else:
            reason = followup_suppress_reason or "suppressed"
    else:
        outcome = "suppressed"
        reason = "empty"

    def _suppressed_marker(raw_text: str, suppress_reason: str) -> Optional[str]:
        cleaned_raw = raw_text.strip() if isinstance(raw_text, str) else ""
        if not cleaned_raw:
            return None
        if suppress_reason == "nta" and is_no_response_only(cleaned_raw):
            return cleaned_raw
        return None

    detail = {
        "channel": "librechat",
        "outcome": outcome,
        "reason": reason,
        "generated_text": visibility.get("generated_text"),
        "final_generated_text": final_visible_text
        or _suppressed_marker(raw_final_text, final_suppress_reason),
        "followup_generated_text": followup_visible_text
        or _suppressed_marker(raw_followup_text, followup_suppress_reason),
        "final_text_source": visibility.get("final_text_source") or "",
        "followup_text_source": visibility.get("followup_text_source") or "",
        "fallback_delivered": bool(visibility.get("fallback_delivered")),
    }
    late_delivery = visibility.get("late_delivery")
    if isinstance(late_delivery, dict):
        detail["late_delivery"] = late_delivery
    date_guard = visibility.get("date_guard")
    if isinstance(date_guard, dict) and date_guard:
        detail["date_guard"] = date_guard
    return detail


def _ack_scheduler_telegram_delivery(
    *,
    base_url: str,
    logical_turn_id: Any,
    revision: Any,
    telegram_chat_id: Any,
    telegram_message_ids: Any,
    timeout_s: int,
    schedule_id: Any = None,
    schedule_run_id: Any = None,
) -> str:
    adapter_secret = str(os.getenv("VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET") or "").strip()
    turn_id = str(logical_turn_id or "").strip()
    chat_id = str(telegram_chat_id or "").strip()
    message_ids = [
        str(value).strip()
        for value in (telegram_message_ids if isinstance(telegram_message_ids, list) else [])
        if str(value).strip()
    ]
    try:
        normalized_revision = int(revision)
    except (TypeError, ValueError):
        return "unavailable"
    if not adapter_secret or not turn_id or not chat_id or not message_ids:
        return "unavailable"
    refs = [f"telegram:{chat_id}:{message_id}" for message_id in message_ids]
    payload = {
        "logical_turn_id": turn_id,
        "revision": normalized_revision,
        "state": "committed",
        "presentation_ref": refs[-1],
        "presentation_refs": refs,
        "source_kind": "schedule_result",
    }
    normalized_schedule_id = str(schedule_id or "").strip()
    normalized_schedule_run_id = str(schedule_run_id or "").strip()
    if normalized_schedule_id:
        payload["schedule_id"] = normalized_schedule_id
    if normalized_schedule_run_id:
        payload["schedule_run_id"] = normalized_schedule_run_id
    response = _post_json(
        f"{base_url.rstrip('/')}/api/viventium/interactions/delivery-ack",
        payload,
        {
            "Content-Type": "application/json",
            "x-viventium-adapter-secret": adapter_secret,
        },
        min(max(1, timeout_s), 10),
    )
    return (
        "recorded"
        if isinstance(response, dict) and response.get("acknowledged") is True
        else str((response or {}).get("error") or "unavailable")
    )


def _deliver_telegram_generated_text(
    task: Dict[str, Any],
    base_url: str,
    timeout_s: int,
    response_message_id: Optional[str],
    visibility: Dict[str, Any],
) -> Dict[str, Any]:
    final_text = visibility.get("final_text") or ""
    followup_text = visibility.get("followup_text") or ""
    send_timeout_s = int(os.getenv("SCHEDULER_TELEGRAM_SEND_TIMEOUT_S", "15"))

    telegram_user_id = None
    telegram_chat_id = None
    voice_preferences: Dict[str, Any] = {}
    telegram_message_ids: list[str] = []
    delivery_receipt_state = "not_applicable"
    delivery_unknown_reason = ""
    if final_text or followup_text:
        telegram_user_id, telegram_chat_id, voice_preferences = _resolve_telegram_identity(
            task,
            base_url,
            timeout_s,
        )
        if not telegram_user_id:
            raise RuntimeError("telegram_user_id is required for Telegram dispatch")
        if not telegram_chat_id:
            raise RuntimeError("telegram_chat_id is required for Telegram dispatch")

    parts = _split_telegram_message(final_text) + _split_telegram_message(followup_text)
    run_id = str(task.get("_scheduled_prompt_run_id") or "").strip()
    occurrence_key = str(task.get("_scheduled_prompt_occurrence_key") or "").strip()
    if run_id and parts and not _get_telegram_bot_token():
        raise RuntimeError(
            "SCHEDULER_TELEGRAM_BOT_TOKEN or BOT_TOKEN is required for Telegram delivery"
        )
    delivery_storage = _scheduler_storage() if run_id and parts else None
    delivery_lease_owner = f"telegram:{uuid.uuid4().hex}"
    for part_index, part in enumerate(parts):
        delivery_key = ""
        if delivery_storage is not None:
            payload_hash = _sha256_prefix(
                json.dumps(
                    {
                        "chat_id": str(telegram_chat_id),
                        "text": part,
                        "voice_preferences": voice_preferences,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                length=64,
            )
            claim = delivery_storage.claim_scheduled_prompt_delivery(
                run_id=run_id,
                occurrence_key=occurrence_key or None,
                channel="telegram",
                part_index=part_index,
                payload_hash=payload_hash,
                lease_owner=delivery_lease_owner,
                now=to_utc_iso(datetime.now(timezone.utc)),
                lease_seconds=max(30, send_timeout_s + 15),
            )
            delivery_key = str(claim.get("delivery_key") or "")
            if not claim.get("claimed"):
                persisted = claim.get("delivery") if isinstance(claim.get("delivery"), dict) else {}
                persisted_message_id = str(persisted.get("message_id") or "").strip()
                if claim.get("reason") == "already_sent" and persisted_message_id:
                    telegram_message_ids.append(persisted_message_id)
                    delivery_receipt_state = "confirmed"
                    continue
                delivery_receipt_state = "unknown"
                delivery_unknown_reason = str(claim.get("reason") or "delivery_unknown")
                break
        try:
            sent_message_id = _send_telegram_voice_or_text(
                str(telegram_chat_id),
                part,
                send_timeout_s,
                voice_preferences,
            )
        except Exception as exc:
            if delivery_storage is not None and delivery_key:
                delivery_storage.mark_scheduled_prompt_delivery_unknown(
                    delivery_key=delivery_key,
                    lease_owner=delivery_lease_owner,
                    now=to_utc_iso(datetime.now(timezone.utc)),
                    error_class=type(exc).__name__,
                )
                delivery_receipt_state = "unknown"
                delivery_unknown_reason = "transport_response_missing"
                break
            raise
        normalized_message_id = (
            str(sent_message_id).strip()
            if isinstance(sent_message_id, (str, int)) and str(sent_message_id).strip()
            else ""
        )
        if not normalized_message_id:
            if delivery_storage is not None and delivery_key:
                delivery_storage.mark_scheduled_prompt_delivery_unknown(
                    delivery_key=delivery_key,
                    lease_owner=delivery_lease_owner,
                    now=to_utc_iso(datetime.now(timezone.utc)),
                    error_class="telegram_receipt_missing",
                )
                delivery_receipt_state = "unknown"
                delivery_unknown_reason = "telegram_receipt_missing"
                break
            continue
        if delivery_storage is not None and delivery_key:
            completed = delivery_storage.complete_scheduled_prompt_delivery(
                delivery_key=delivery_key,
                lease_owner=delivery_lease_owner,
                message_id=normalized_message_id,
                now=to_utc_iso(datetime.now(timezone.utc)),
            )
            persisted = (
                completed.get("delivery")
                if isinstance(completed.get("delivery"), dict)
                else {}
            )
            if not completed.get("updated") and str(persisted.get("state") or "") != "sent":
                delivery_receipt_state = "unknown"
                delivery_unknown_reason = "receipt_commit_conflict"
                break
        telegram_message_ids.append(normalized_message_id)
        delivery_receipt_state = "confirmed"

    raw_final_text = visibility.get("raw_final_text") or ""
    raw_followup_text = visibility.get("raw_followup_text") or ""
    sent_final = bool(final_text) and delivery_receipt_state != "unknown"
    sent_followup = bool(followup_text) and delivery_receipt_state != "unknown"

    def _suppressed_marker(raw_text: str, suppress_reason: str) -> Optional[str]:
        cleaned_raw = raw_text.strip() if isinstance(raw_text, str) else ""
        if not cleaned_raw:
            return None
        if suppress_reason == "nta" and is_no_response_only(cleaned_raw):
            return cleaned_raw
        return None

    if delivery_receipt_state == "unknown":
        outcome = "delivery_unknown"
        reason = "telegram_delivery_ambiguous"
    elif sent_final or sent_followup:
        if visibility.get("fallback_delivered"):
            outcome = "fallback_delivered"
            reason = _fallback_reason(visibility.get("fallback_reason"))
        else:
            outcome = "sent"
            reason = "delivered"
    elif raw_final_text or raw_followup_text:
        outcome = "suppressed"
        if raw_final_text and not sent_final:
            reason = visibility.get("final_suppress_reason") or "suppressed"
        else:
            reason = visibility.get("followup_suppress_reason") or "suppressed"
    else:
        outcome = "suppressed"
        reason = "empty"

    detail = {
        "channel": "telegram",
        "outcome": outcome,
        "reason": reason,
        "generated_text": visibility.get("generated_text"),
        "final_generated_text": final_text
        or _suppressed_marker(raw_final_text, visibility.get("final_suppress_reason") or ""),
        "followup_generated_text": followup_text
        or _suppressed_marker(raw_followup_text, visibility.get("followup_suppress_reason") or ""),
        "sent_final": sent_final,
        "sent_followup": sent_followup,
        "response_message_id": response_message_id or None,
        "final_text_source": visibility.get("final_text_source") or "",
        "followup_text_source": visibility.get("followup_text_source") or "",
        "fallback_delivered": bool(visibility.get("fallback_delivered")),
        "delivery_receipt_state": delivery_receipt_state,
    }
    if delivery_unknown_reason:
        detail["delivery_unknown_reason"] = delivery_unknown_reason
    if telegram_chat_id:
        detail["telegram_chat_id"] = str(telegram_chat_id)
    if telegram_message_ids:
        detail["telegram_message_ids"] = telegram_message_ids
    late_delivery = visibility.get("late_delivery")
    if isinstance(late_delivery, dict):
        detail["late_delivery"] = late_delivery
    date_guard = visibility.get("date_guard")
    if isinstance(date_guard, dict) and date_guard:
        detail["date_guard"] = date_guard
    return detail


def scheduled_failure_result(
    task: Dict[str, Any],
    error_class: Any,
    failure_retryable: Optional[bool] = None,
    generation_result: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Close every scheduler failure through the same user-visible transition contract."""
    generation = generation_result if isinstance(generation_result, dict) else {}
    normalized = normalized_scheduled_generation_failure_class(error_class)
    transition = resolve_scheduled_failure_transition(task, normalized, failure_retryable)
    notice = _scheduled_generation_failure_notice(
        normalized,
        transition["retryable"],
        transition["retry_disposition"],
        transition.get("next_attempt_at"),
    )
    channels = _normalize_dispatch_channels(task.get("channel"))
    base_url = (
        os.getenv("SCHEDULER_LIBRECHAT_URL")
        or os.getenv("VIVENTIUM_LIBRECHAT_ORIGIN")
        or "http://localhost:3080"
    ).rstrip("/")
    timeout_s = int(os.getenv("SCHEDULER_HTTP_TIMEOUT_S", "15"))
    failure_channels: Dict[str, Dict[str, Any]] = {}
    channel_errors: Dict[str, Dict[str, Any]] = {}
    if "librechat" in channels:
        failure_channels["librechat"] = {
            "channel": "librechat",
            "outcome": "failed",
            "reason": normalized,
            "generated_text": None,
            "response_message_id": generation.get("response_message_id"),
        }
    if "telegram" in channels:
        if transition["already_reported_in_health_epoch"]:
            failure_channels["telegram"] = {
                "channel": "telegram",
                "outcome": "suppressed",
                "reason": "same_root_already_reported",
                "generated_text": None,
            }
        else:
            try:
                visibility = _prepare_generated_visibility(task, notice, "")
                telegram_detail = _deliver_telegram_generated_text(
                    task,
                    base_url,
                    timeout_s,
                    generation.get("response_message_id"),
                    visibility,
                )
                telegram_detail["delivery_ack_status"] = _ack_scheduler_telegram_delivery(
                    base_url=base_url,
                    logical_turn_id=generation.get("logical_turn_id"),
                    revision=generation.get("revision"),
                    telegram_chat_id=telegram_detail.get("telegram_chat_id"),
                    telegram_message_ids=telegram_detail.get("telegram_message_ids"),
                    schedule_id=task.get("id"),
                    schedule_run_id=task.get("_scheduled_prompt_run_id"),
                    timeout_s=timeout_s,
                )
                telegram_detail["reason"] = "action_required"
                failure_channels["telegram"] = telegram_detail
                if telegram_detail.get("outcome") in {"sent", "fallback_delivered"}:
                    transition["reported_failure_classes"] = sorted(
                        set(transition.get("reported_failure_classes") or []) | {normalized}
                    )
            except Exception as exc:
                channel_errors["telegram"] = _scheduled_channel_exception_failure(task, exc)
                failure_channels["telegram"] = channel_errors["telegram"]
                logger.warning(
                    "[scheduling-cortex] Failure notice delivery failed: "
                    "channel=%s task_id=%s error_class=%s",
                    "telegram",
                    task.get("id") or "unknown",
                    channel_errors["telegram"]["error_class"],
                )
    if "workbench" in channels:
        failure_channels["workbench"] = {
            "channel": "workbench",
            "outcome": "failed",
            "reason": normalized,
            "generated_text": None,
        }
    response: Dict[str, Any] = {
        "conversation_id": generation.get("conversation_id"),
        "response_message_id": generation.get("response_message_id"),
        "generation_failure": {
            "error_class": normalized,
            "failure_retryable": transition["retryable"],
            "transition": transition,
        },
        "delivery": {
            "outcome": "failed",
            "reason": normalized,
            "generated_text": (
                notice
                if failure_channels.get("telegram", {}).get("outcome")
                in {"sent", "fallback_delivered"}
                else None
            ),
            "channels": failure_channels,
        },
    }
    if channel_errors:
        response["channel_errors"] = channel_errors
    for key in ("execution", "external_work"):
        value = generation.get(key)
        if isinstance(value, dict) and value:
            response[key] = value
    return response


def dispatch_task(task: Dict[str, Any]) -> Dict[str, Any]:
    executor = str(task.get("executor") or "viventium_agent").strip()
    wb = _workbench_metadata(task)
    if wb and executor != "glasshive_host":
        storage = _scheduler_storage()
        task, wb = _refresh_workbench_rendered_prompt(storage, task, wb)
    if executor == "glasshive_host":
        return _dispatch_glasshive_task(task)
    if executor == "glasshive_workspace":
        return _dispatch_glasshive_workspace_task(task)
    if executor != "viventium_agent":
        raise RuntimeError(f"Unsupported schedule executor: {executor}")

    # === VIVENTIUM NOTE ===
    # Feature: Single-run scheduled generation with multi-channel fan-out.
    # Purpose: One scheduler tick must produce one canonical agent run, then fan the same
    # result out to requested delivery channels. This prevents same-conversation loops and
    # keeps generated-vs-delivered ledgers truthful across channels.
    channels = _normalize_dispatch_channels(task.get("channel"))
    # === VIVENTIUM NOTE ===
    base_url = (
        os.getenv("SCHEDULER_LIBRECHAT_URL")
        or os.getenv("VIVENTIUM_LIBRECHAT_ORIGIN")
        or "http://localhost:3080"
    ).rstrip("/")
    timeout_s = int(os.getenv("SCHEDULER_HTTP_TIMEOUT_S", "15"))
    conversation_id = _resolve_conversation_id(task)

    channel_results: Dict[str, Dict[str, Any]] = {}
    errors: Dict[str, Dict[str, Any]] = {}
    generation_result = _run_scheduler_generation(task, base_url, timeout_s, conversation_id)
    resolved_conversation_id = generation_result.get("conversation_id")
    generation_failure = (
        generation_result.get("generation_failure")
        if isinstance(generation_result.get("generation_failure"), dict)
        else None
    )
    if generation_failure is not None:
        error_class = normalized_scheduled_generation_failure_class(
            generation_failure.get("error_class")
        )
        failure_retryable = generation_failure.get("failure_retryable")
        return scheduled_failure_result(
            task,
            error_class,
            failure_retryable if isinstance(failure_retryable, bool) else None,
            generation_result,
        )
    if generation_result.get("superseded") or generation_result.get("disposition") == "superseded":
        superseded_channels = {
            channel: {"outcome": "superseded", "reason": "newer_stable_turn"}
            for channel in channels
        }
        return {
            "conversation_id": resolved_conversation_id,
            "delivery": {
                "outcome": "superseded",
                "reason": "newer_stable_turn",
                "generated_text": None,
                "channels": superseded_channels,
            },
            "logical_turn_id": generation_result.get("logical_turn_id"),
            "revision": generation_result.get("revision"),
        }
    visibility = _prepare_generated_visibility(
        task,
        str(generation_result.get("final_text") or ""),
        str(generation_result.get("followup_text") or ""),
        final_text_source=str(generation_result.get("final_text_source") or ""),
        final_text_fallback_reason=str(generation_result.get("final_text_fallback_reason") or ""),
        followup_text_source=str(generation_result.get("followup_text_source") or ""),
        followup_text_fallback_reason=str(generation_result.get("followup_text_fallback_reason") or ""),
        suppressed_fallback_reason=str(generation_result.get("suppressed_fallback_reason") or ""),
        date_guard=generation_result.get("date_guard") if isinstance(generation_result.get("date_guard"), dict) else None,
    )
    visibility = _apply_late_delivery_notice(task, visibility)

    if "librechat" in channels:
        channel_results["librechat"] = {
            "conversation_id": resolved_conversation_id,
            "delivery": _build_librechat_delivery_detail(visibility),
        }

    if "telegram" in channels:
        try:
            telegram_detail = _deliver_telegram_generated_text(
                task,
                base_url,
                timeout_s,
                generation_result.get("response_message_id"),
                visibility,
            )
            telegram_detail["delivery_ack_status"] = _ack_scheduler_telegram_delivery(
                base_url=base_url,
                logical_turn_id=generation_result.get("logical_turn_id"),
                revision=generation_result.get("revision"),
                telegram_chat_id=telegram_detail.get("telegram_chat_id"),
                telegram_message_ids=telegram_detail.get("telegram_message_ids"),
                schedule_id=task.get("id"),
                schedule_run_id=task.get("_scheduled_prompt_run_id"),
                timeout_s=timeout_s,
            )
            channel_results["telegram"] = {
                "conversation_id": resolved_conversation_id,
                "delivery": telegram_detail,
            }
        except Exception as exc:
            errors["telegram"] = _scheduled_channel_exception_failure(task, exc)
            logger.warning(
                "[scheduling-cortex] Channel dispatch failed (best-effort continues): "
                "channel=%s task_id=%s error_class=%s",
                "telegram",
                task.get("id") or "unknown",
                errors["telegram"]["error_class"],
            )

    if "workbench" in channels:
        channel_results["workbench"] = {
            "conversation_id": resolved_conversation_id,
            "delivery": {
                "outcome": "audit_only",
                "reason": "workbench_channel_is_audit_only",
                "generated_text": None,
            },
        }

    # === VIVENTIUM NOTE ===
    # Feature: Best-effort multi-channel dispatch.
    # Scheduler generation is canonical. Requested channel delivery still succeeds if at
    # least one requested channel delivered or intentionally suppressed with a truthful ledger.
    if not channel_results:
        classes = ", ".join(
            sorted({str(error.get("error_class") or "Error") for error in errors.values()})
        )
        raise RuntimeError(f"Dispatch failed for all channels ({classes or 'Error'})")
    if errors:
        logger.info(
            "[scheduling-cortex] Partial dispatch success: task_id=%s succeeded=%s failed=%s",
            task.get("id") or "unknown",
            list(channel_results.keys()),
            list(errors.keys()),
        )
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Aggregate per-channel delivery visibility into a single task-level summary.
    delivery_by_channel: Dict[str, Dict[str, Any]] = {}
    generated_text: Optional[str] = None
    saw_sent = False
    saw_fallback_delivered = False
    saw_audit_only = False
    saw_delivery_unknown = False
    suppress_reasons: list[str] = []
    fallback_reasons: list[str] = []
    saw_non_failed = False
    for channel, result in channel_results.items():
        detail = result.get("delivery") if isinstance(result, dict) else None
        if isinstance(detail, dict):
            delivery_by_channel[channel] = detail
            outcome = str(detail.get("outcome") or "").strip().lower()
            reason = str(detail.get("reason") or "").strip()
            if outcome == "sent":
                saw_sent = True
                saw_non_failed = True
            elif outcome == "fallback_delivered":
                saw_fallback_delivered = True
                saw_non_failed = True
                if reason:
                    fallback_reasons.append(f"{channel}:{reason}")
            elif outcome == "suppressed":
                saw_non_failed = True
                if reason:
                    suppress_reasons.append(f"{channel}:{reason}")
            elif outcome == "audit_only":
                saw_audit_only = True
                saw_non_failed = True
            elif outcome == "delivery_unknown":
                saw_delivery_unknown = True
                saw_non_failed = True
            elif outcome:
                saw_non_failed = True
            if not generated_text:
                text = detail.get("generated_text")
                if isinstance(text, str) and text.strip():
                    generated_text = text.strip()
    delivery_by_channel.update(errors)
    if saw_sent:
        delivery_outcome = "sent"
        delivery_reason = "delivered"
    elif saw_fallback_delivered:
        delivery_outcome = "fallback_delivered"
        delivery_reason = "; ".join(fallback_reasons) if fallback_reasons else "deferred_fallback"
    elif saw_delivery_unknown:
        delivery_outcome = "delivery_unknown"
        delivery_reason = "telegram_delivery_ambiguous"
    elif saw_audit_only:
        delivery_outcome = "audit_only"
        delivery_reason = "workbench_channel_is_audit_only"
    elif saw_non_failed:
        delivery_outcome = "suppressed"
        delivery_reason = "; ".join(suppress_reasons) if suppress_reasons else "suppressed"
    else:
        delivery_outcome = "unknown"
        delivery_reason = "no_delivery_details"

    response: Dict[str, Any] = {
        "conversation_id": resolved_conversation_id or _select_conversation_id(channel_results),
        "delivery": {
            "outcome": delivery_outcome,
            "reason": delivery_reason,
            "generated_text": generated_text,
            "channels": delivery_by_channel,
        },
    }
    execution = generation_result.get("execution")
    if isinstance(execution, dict) and execution:
        response["execution"] = execution
    # === VIVENTIUM NOTE ===
    # Feature: Per-channel error ledger for partial success visibility.
    if errors:
        response["channel_errors"] = errors
    # === VIVENTIUM NOTE ===
    if len(channel_results) > 1:
        response["channel_results"] = channel_results
    return response
