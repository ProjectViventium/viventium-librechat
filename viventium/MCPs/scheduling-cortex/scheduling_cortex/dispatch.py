from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Tuple

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - Python < 3.9 fallback
    ZoneInfo = None  # type: ignore

# === VIVENTIUM START ===
# Rationale: ship a default scheduled self-prompt contract so scheduler runs preserve
# Phase A / Phase B parity even when env overrides are absent.
BREW_PROMPT_MARKER = "<!--viv_internal:brew_begin-->"
BREW_PROMPT_HEADER = "## Background Processing (Brewing)"
SCHEDULED_SELF_PROMPT_LINE = (
    "This is a scheduled self-prompt (morning briefing, wake cycle, heartbeat), "
    "not a new user scheduling request."
)
DEFAULT_SCHEDULER_PROMPT_PREFIX = "\n".join(
    [
        BREW_PROMPT_MARKER,
        BREW_PROMPT_HEADER,
        SCHEDULED_SELF_PROMPT_LINE,
        (
            "If background agents are activated and still brewing, and the real user-visible answer "
            "should wait for their insights, output exactly {NTA}."
        ),
        "If you can already give a complete stable answer without waiting, answer normally.",
        "Do not mention internal mechanics or talk about scheduling.",
    ]
)
# === VIVENTIUM END ===

# === VIVENTIUM START ===
# Feature: Multi-channel dispatch support.
from .models import AVAILABLE_CHANNELS
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
        if candidate.is_dir():
            return candidate
    return None


_SHARED_PATH = _find_shared_path(Path(__file__).resolve())  # .../viventium_v0_4/shared
if _SHARED_PATH and str(_SHARED_PATH) not in sys.path:
    sys.path.insert(0, str(_SHARED_PATH))

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
_BOLD_UNDERSCORE_RE = re.compile(r"__(.+?)__", re.DOTALL)
_ITALIC_ASTERISK_RE = re.compile(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)")
_ITALIC_UNDERSCORE_RE = re.compile(r"(?<!_)_(?!_)(.+?)(?<!_)_(?!_)")
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


def _format_http_error(method: str, url: str, error: urllib.error.HTTPError) -> RuntimeError:
    body_text = ""
    try:
        raw_body = error.read()
    except Exception:
        raw_body = b""

    if raw_body:
        body_text = raw_body.decode("utf-8", errors="replace").strip()

    error_message = error.reason or error.msg or "Request failed"
    reason = ""
    if body_text:
        try:
            payload = json.loads(body_text)
        except json.JSONDecodeError:
            error_message = body_text
        else:
            error_message = str(payload.get("error") or error_message)
            reason = str(payload.get("reason") or "")

    parsed = urllib.parse.urlparse(url)
    path = parsed.path or url
    reason_suffix = f" ({reason})" if reason else ""
    return RuntimeError(f"{method} {path} failed: HTTP {error.code}{reason_suffix}: {error_message}")


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


def _compose_prompt(task: Dict[str, Any]) -> str:
    base = (task.get("prompt") or "").strip()
    prefix = _get_prompt_prefix()
    if not prefix or _looks_like_scheduled_self_prompt(base):
        return base
    if not base:
        return prefix
    return f"{prefix}\n\n{base}"
# === VIVENTIUM END ===


# === VIVENTIUM NOTE ===
# Feature: Heartbeat keepalive guardrail.
# Purpose: prevent long silent `{NTA}` streaks on high-frequency heartbeat tasks.
# === VIVENTIUM NOTE ===
def _parse_utc_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _is_heartbeat_task(task: Dict[str, Any]) -> bool:
    metadata = task.get("metadata")
    if not isinstance(metadata, dict):
        return False
    name = str(metadata.get("name") or "").strip().lower()
    return name == "heartbeat"


def _get_heartbeat_quiet_streak(task: Dict[str, Any]) -> int:
    metadata = task.get("metadata")
    if not isinstance(metadata, dict):
        return 0
    raw = metadata.get("heartbeat_quiet_streak")
    try:
        streak = int(raw)
    except (TypeError, ValueError):
        return 0
    return max(0, streak)


def _heartbeat_keepalive_threshold() -> int:
    raw = str(os.getenv("SCHEDULER_HEARTBEAT_KEEPALIVE_STREAK", "3")).strip()
    try:
        value = int(raw)
    except ValueError:
        value = 3
    return max(2, value)


def _format_heartbeat_next_check(task: Dict[str, Any], now_utc: datetime) -> str:
    next_run = _parse_utc_iso(task.get("next_run_at"))
    if not next_run:
        return "the next cycle"
    schedule = task.get("schedule") or {}
    tz_name = schedule.get("timezone") if isinstance(schedule, dict) else None
    tz_name = str(tz_name or "UTC")
    if ZoneInfo is None:
        return f"{next_run.astimezone(timezone.utc).strftime('%H:%M')} UTC"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = timezone.utc
        tz_name = "UTC"
    local_next = next_run.astimezone(tz)
    now_local = now_utc.astimezone(tz)
    if local_next.date() == now_local.date():
        return f"{local_next.strftime('%H:%M')} {tz_name}"
    return f"{local_next.strftime('%a %H:%M')} {tz_name}"


def _build_heartbeat_keepalive(task: Dict[str, Any], now_utc: datetime) -> str:
    next_check = _format_heartbeat_next_check(task, now_utc)
    return (
        "Quick pulse: I'm here and tracking things with you. "
        f"No urgent change this cycle. Next check around {next_check}."
    )


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
        if canonical_text:
            last_canonical_text = canonical_text
        follow_up = state.get("followUp")
        if isinstance(follow_up, dict):
            text = follow_up.get("text")
            if isinstance(text, str) and text.strip():
                return {
                    "followup_text": text.strip(),
                    "canonical_text": last_canonical_text,
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
            }
    return {"followup_text": "", "canonical_text": last_canonical_text}
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
    # Feature: Extend stream for follow-ups and capture response metadata.
    # === VIVENTIUM NOTE ===
    params_data = {"telegramUserId": telegram_user_id, "telegramChatId": telegram_chat_id}
    linger_grace_s = _parse_positive_float(
        os.getenv("SCHEDULER_TELEGRAM_FOLLOWUP_GRACE_S")
        or os.getenv("VIVENTIUM_TELEGRAM_FOLLOWUP_GRACE_S"),
        8.0,
    )
    if linger_grace_s > 0:
        params_data["linger"] = "true"
        params_data["lingerMs"] = str(int(linger_grace_s * 1000))
    params = urllib.parse.urlencode(params_data)
    url = f"{base_url}/api/viventium/telegram/stream/{stream_id}?{params}"
    headers = {"X-VIVENTIUM-TELEGRAM-SECRET": secret}
    chunks: list[str] = []
    final_text = ""
    response_message_id = ""
    followup_text = ""
    saw_final = False
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
            saw_final = True
        if saw_final and followup_text:
            break
    if not final_text:
        final_text = "".join(chunks).strip()
    return final_text.strip(), response_message_id, followup_text.strip()


# === VIVENTIUM NOTE ===
# Feature: Canonical scheduler-run stream capture for single-run multi-channel dispatch.
def _stream_scheduler_response(
    base_url: str,
    stream_id: str,
    user_id: str,
    secret: str,
    timeout_s: int,
) -> Tuple[str, str, str]:
    params_data = {"userId": str(user_id)}
    linger_grace_s = _parse_positive_float(
        os.getenv("SCHEDULER_FOLLOWUP_GRACE_S")
        or os.getenv("VIVENTIUM_SCHEDULER_FOLLOWUP_GRACE_S"),
        8.0,
    )
    if linger_grace_s > 0:
        params_data["linger"] = "true"
        params_data["lingerMs"] = str(int(linger_grace_s * 1000))
    params = urllib.parse.urlencode(params_data)
    url = f"{base_url}/api/viventium/scheduler/stream/{stream_id}?{params}"
    headers = {"X-VIVENTIUM-SCHEDULER-SECRET": secret}
    chunks: list[str] = []
    final_text = ""
    response_message_id = ""
    followup_text = ""
    saw_final = False
    for raw in _iter_sse_payloads(url, headers, timeout_s):
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        if "error" in payload:
            raise RuntimeError(payload.get("error") or "Scheduler stream error")
        if not response_message_id:
            response_message_id = _extract_response_message_id(payload)
        if not followup_text:
            followup_text = _extract_followup_text(payload)
        if not final_text:
            final_text = _extract_final_response_text(payload)
        if not final_text:
            chunks.extend([c for c in _extract_text_deltas(payload) if c])
        if payload.get("final"):
            saw_final = True
        if saw_final and followup_text:
            break
    if not final_text:
        final_text = "".join(chunks).strip()
    return final_text.strip(), response_message_id, followup_text.strip()


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
        return {"followup_text": "", "canonical_text": ""}

    poll_config = _scheduler_followup_poll_config(task)
    params = {"userId": str(user_id)}
    if conversation_id:
        params["conversationId"] = str(conversation_id)
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
    payload = {
        "userId": task.get("user_id"),
        "agentId": task.get("agent_id"),
        "text": _compose_prompt(task),
        "conversationId": conversation_id,
        "scheduleId": task.get("id"),
        "clientTimezone": schedule.get("timezone") or "UTC",
    }
    headers = {
        "Content-Type": "application/json",
        "X-VIVENTIUM-SCHEDULER-SECRET": secret,
    }
    response = _post_json(f"{base_url}/api/viventium/scheduler/chat", payload, headers, timeout_s)
    stream_id = response.get("streamId") or response.get("stream_id")
    if not stream_id:
        raise RuntimeError("Scheduler dispatch missing streamId")
    stream_timeout_s = int(os.getenv("SCHEDULER_STREAM_TIMEOUT_S", "120"))
    final_text, response_message_id, followup_text = _stream_scheduler_response(
        base_url,
        stream_id,
        str(task.get("user_id") or ""),
        secret,
        stream_timeout_s,
    )
    resolved_conversation_id = _extract_conversation_id(response, conversation_id)
    polled_state = {"followup_text": "", "canonical_text": ""}
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

    canonical_text = polled_state.get("canonical_text", "").strip()
    if canonical_text and _is_suppressed_generated_text(final_text, _sanitize_scheduled_text):
        final_text = canonical_text
    if _texts_match_after_sanitization(final_text, followup_text, _sanitize_scheduled_text):
        followup_text = ""

    return {
        "conversation_id": resolved_conversation_id,
        "response_message_id": response_message_id or None,
        "final_text": final_text.strip(),
        "followup_text": followup_text.strip(),
    }


# === VIVENTIUM NOTE ===
# Feature: Poll LibreChat follow-up endpoint for scheduled Telegram runs.
def _poll_telegram_followup(
    base_url: str,
    message_id: str,
    telegram_user_id: str,
    telegram_chat_id: str,
    conversation_id: Optional[str],
    secret: str,
    http_timeout_s: int,
) -> Dict[str, str]:
    if not message_id:
        return {"followup_text": "", "canonical_text": ""}

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


def _send_telegram_message(chat_id: str, text: str, timeout_s: int) -> None:
    token = _get_telegram_bot_token()
    if not token:
        raise RuntimeError("SCHEDULER_TELEGRAM_BOT_TOKEN or BOT_TOKEN is required for Telegram delivery")
    if not text:
        return
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
    try:
        response = _post_json(url, payload, headers, timeout_s)
        # === VIVENTIUM NOTE ===
        # Feature: Detect Telegram ok=false responses and fallback to plain text.
        if isinstance(response, dict) and response.get("ok") is False:
            description = str(response.get("description") or "")
            logger.warning("Telegram send failed (ok=false): %s", description)
            if "parse" in description.lower():
                payload.pop("parse_mode", None)
                payload["text"] = _strip_html_tags(rendered) or _strip_markdown(_sanitize_telegram_text(text))
                _post_json(url, payload, headers, timeout_s)
                return
            raise RuntimeError(description or "Telegram send failed")
        # === VIVENTIUM NOTE ===
    except Exception:
        payload.pop("parse_mode", None)
        payload["text"] = _strip_html_tags(rendered) or _strip_markdown(_sanitize_telegram_text(text))
        _post_json(url, payload, headers, timeout_s)


def _send_telegram_audio(chat_id: str, audio_bytes: bytes, timeout_s: int) -> None:
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
        raise RuntimeError(description or "Telegram sendAudio failed")


def _send_telegram_voice_or_text(
    chat_id: str,
    text: str,
    timeout_s: int,
    voice_preferences: Dict[str, bool],
) -> bool:
    if not text:
        return False
    if not _should_send_scheduler_voice(text, voice_preferences):
        _send_telegram_message(chat_id, text, timeout_s)
        return False

    audio_bytes = _synthesize_tts(text, timeout_s)
    if audio_bytes:
        try:
            _send_telegram_audio(chat_id, audio_bytes, timeout_s)
            return True
        except Exception as exc:
            logger.warning("Telegram sendAudio failed, falling back to text: %s", exc)

    _send_telegram_message(chat_id, text, timeout_s)
    return False


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
        return list(AVAILABLE_CHANNELS)
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


def _dispatch_librechat(
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
            "SCHEDULER_LIBRECHAT_SECRET or VIVENTIUM_SCHEDULER_SECRET is required for LibreChat dispatch"
        )

    # === VIVENTIUM NOTE ===
    # Feature: Pass schedule timezone as clientTimezone for time context injection.
    # This mirrors how the web client sends Intl.DateTimeFormat().resolvedOptions().timeZone
    # === VIVENTIUM NOTE ===
    schedule = task.get("schedule") or {}
    payload = {
        "userId": task.get("user_id"),
        "agentId": task.get("agent_id"),
        "text": _compose_prompt(task),
        "conversationId": conversation_id,
        "scheduleId": task.get("id"),
        "clientTimezone": schedule.get("timezone") or "UTC",
    }
    headers = {
        "Content-Type": "application/json",
        "X-VIVENTIUM-SCHEDULER-SECRET": secret,
    }
    response = _post_json(f"{base_url}/api/viventium/scheduler/chat", payload, headers, timeout_s)
    response_text = response.get("text") if isinstance(response, dict) else None
    generated_text = response_text.strip() if isinstance(response_text, str) and response_text.strip() else None
    return {
        "conversation_id": _extract_conversation_id(response, conversation_id),
        # === VIVENTIUM NOTE ===
        # Feature: Return delivery visibility metadata to scheduler persistence layer.
        "delivery": {
            "channel": "librechat",
            "outcome": "accepted",
            "reason": "librechat_pipeline_started",
            "generated_text": generated_text,
        },
        # === VIVENTIUM NOTE ===
    }


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
    now_utc = datetime.now(timezone.utc)
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

    polled_state = {"followup_text": "", "canonical_text": ""}
    if not followup_text and not followup_suppressed:
        polled_state = _poll_telegram_followup(
            base_url,
            response_message_id,
            str(telegram_user_id),
            str(telegram_chat_id),
            resolved_conversation_id,
            secret,
            timeout_s,
        )
        polled_followup_text = polled_state.get("followup_text", "")
        if isinstance(polled_followup_text, str) and polled_followup_text.strip():
            followup_text = polled_followup_text
            raw_followup_text = polled_followup_text.strip()
    followup_text = strip_trailing_nta(followup_text) if followup_text else followup_text
    followup_text = _sanitize_telegram_text(followup_text) if followup_text else followup_text
    followup_suppressed = followup_suppressed or is_no_response_only(followup_text)
    followup_suppress_reason = "nta" if followup_suppressed else ("empty" if not str(followup_text or "").strip() else "")
    if followup_suppressed:
        raw_followup_text = followup_text.strip() if isinstance(followup_text, str) else raw_followup_text
        followup_text = ""

    canonical_final_text = polled_state.get("canonical_text", "").strip()
    if canonical_final_text and _is_suppressed_generated_text(final_text, _sanitize_telegram_text):
        final_text = _sanitize_telegram_text(strip_trailing_nta(canonical_final_text))
        raw_final_text = final_text.strip()
        suppress_final = False
        final_suppress_reason = ""
    if _texts_match_after_sanitization(final_text, followup_text, _sanitize_telegram_text):
        followup_text = ""
        raw_followup_text = ""
        followup_suppressed = False
        followup_suppress_reason = ""

    heartbeat_keepalive_sent = False
    if (
        suppress_final
        and final_suppress_reason == "nta"
        and not str(followup_text or "").strip()
        and _is_heartbeat_task(task)
    ):
        prior_streak = _get_heartbeat_quiet_streak(task)
        threshold = _heartbeat_keepalive_threshold()
        # Send a concise keepalive after repeated heartbeat no-response suppressions.
        if prior_streak >= (threshold - 1):
            keepalive_text = _build_heartbeat_keepalive(task, now_utc)
            followup_text = keepalive_text
            raw_followup_text = keepalive_text
            followup_suppressed = False
            followup_suppress_reason = ""
            heartbeat_keepalive_sent = True
            logger.info(
                "[scheduling-cortex] Heartbeat keepalive override sent: task_id=%s prior_streak=%s threshold=%s",
                task.get("id") or "unknown",
                prior_streak,
                threshold,
            )

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
        outcome = "sent"
        reason = "heartbeat_keepalive" if heartbeat_keepalive_sent else "delivered"
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


def _prepare_generated_visibility(
    task: Dict[str, Any],
    final_text: str,
    followup_text: str,
) -> Dict[str, Any]:
    raw_final_text = final_text.strip() if isinstance(final_text, str) else ""
    raw_followup_text = followup_text.strip() if isinstance(followup_text, str) else ""

    final_text = strip_trailing_nta(final_text) if final_text else final_text
    final_text = _sanitize_scheduled_text(final_text) if final_text else final_text
    suppress_final = is_no_response_only(final_text) or not str(final_text or "").strip()
    final_suppress_reason = "nta" if is_no_response_only(final_text) else "empty"
    if suppress_final:
        final_text = ""

    followup_text = strip_trailing_nta(followup_text) if followup_text else followup_text
    followup_text = _sanitize_scheduled_text(followup_text) if followup_text else followup_text
    followup_suppressed = is_no_response_only(followup_text)
    if followup_suppressed:
        raw_followup_text = followup_text.strip() if isinstance(followup_text, str) else ""
        followup_text = ""

    followup_suppress_reason = "nta" if followup_suppressed else (
        "empty" if not str(followup_text or "").strip() else ""
    )

    heartbeat_keepalive_sent = False
    now_utc = datetime.now(timezone.utc)
    if (
        suppress_final
        and final_suppress_reason == "nta"
        and not str(followup_text or "").strip()
        and _is_heartbeat_task(task)
    ):
        prior_streak = _get_heartbeat_quiet_streak(task)
        threshold = _heartbeat_keepalive_threshold()
        if prior_streak >= (threshold - 1):
            keepalive_text = _build_heartbeat_keepalive(task, now_utc)
            followup_text = keepalive_text
            raw_followup_text = keepalive_text
            followup_suppressed = False
            followup_suppress_reason = ""
            heartbeat_keepalive_sent = True
            logger.info(
                "[scheduling-cortex] Heartbeat keepalive override sent: task_id=%s prior_streak=%s threshold=%s",
                task.get("id") or "unknown",
                prior_streak,
                threshold,
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

    return {
        "raw_final_text": raw_final_text,
        "raw_followup_text": raw_followup_text,
        "final_text": final_visible_text,
        "followup_text": followup_visible_text,
        "final_suppress_reason": final_suppress_reason,
        "followup_suppress_reason": followup_suppress_reason,
        "generated_text": generated_text,
        "heartbeat_keepalive_sent": heartbeat_keepalive_sent,
    }


def _build_librechat_delivery_detail(visibility: Dict[str, Any]) -> Dict[str, Any]:
    final_visible_text = visibility.get("final_text") or ""
    followup_visible_text = visibility.get("followup_text") or ""
    raw_final_text = visibility.get("raw_final_text") or ""
    raw_followup_text = visibility.get("raw_followup_text") or ""
    final_suppress_reason = visibility.get("final_suppress_reason") or ""
    followup_suppress_reason = visibility.get("followup_suppress_reason") or ""

    if final_visible_text or followup_visible_text:
        outcome = "sent"
        reason = "heartbeat_keepalive" if visibility.get("heartbeat_keepalive_sent") else "delivered"
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

    return {
        "channel": "librechat",
        "outcome": outcome,
        "reason": reason,
        "generated_text": visibility.get("generated_text"),
        "final_generated_text": final_visible_text
        or _suppressed_marker(raw_final_text, final_suppress_reason),
        "followup_generated_text": followup_visible_text
        or _suppressed_marker(raw_followup_text, followup_suppress_reason),
    }


def _deliver_telegram_generated_text(
    task: Dict[str, Any],
    base_url: str,
    timeout_s: int,
    response_message_id: Optional[str],
    visibility: Dict[str, Any],
) -> Dict[str, Any]:
    telegram_user_id, telegram_chat_id, voice_preferences = _resolve_telegram_identity(
        task,
        base_url,
        timeout_s,
    )
    if not telegram_user_id:
        raise RuntimeError("telegram_user_id is required for Telegram dispatch")
    if not telegram_chat_id:
        raise RuntimeError("telegram_chat_id is required for Telegram dispatch")

    final_text = visibility.get("final_text") or ""
    followup_text = visibility.get("followup_text") or ""
    send_timeout_s = int(os.getenv("SCHEDULER_TELEGRAM_SEND_TIMEOUT_S", "15"))

    if final_text:
        for part in _split_telegram_message(final_text):
            _send_telegram_voice_or_text(
                str(telegram_chat_id),
                part,
                send_timeout_s,
                voice_preferences,
            )

    if followup_text:
        for part in _split_telegram_message(followup_text):
            _send_telegram_voice_or_text(
                str(telegram_chat_id),
                part,
                send_timeout_s,
                voice_preferences,
            )

    raw_final_text = visibility.get("raw_final_text") or ""
    raw_followup_text = visibility.get("raw_followup_text") or ""
    sent_final = bool(final_text)
    sent_followup = bool(followup_text)

    def _suppressed_marker(raw_text: str, suppress_reason: str) -> Optional[str]:
        cleaned_raw = raw_text.strip() if isinstance(raw_text, str) else ""
        if not cleaned_raw:
            return None
        if suppress_reason == "nta" and is_no_response_only(cleaned_raw):
            return cleaned_raw
        return None

    if sent_final or sent_followup:
        outcome = "sent"
        reason = "heartbeat_keepalive" if visibility.get("heartbeat_keepalive_sent") else "delivered"
    elif raw_final_text or raw_followup_text:
        outcome = "suppressed"
        if raw_final_text and not sent_final:
            reason = visibility.get("final_suppress_reason") or "suppressed"
        else:
            reason = visibility.get("followup_suppress_reason") or "suppressed"
    else:
        outcome = "suppressed"
        reason = "empty"

    return {
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
    }


def dispatch_task(task: Dict[str, Any]) -> Dict[str, Any]:
    # === VIVENTIUM NOTE ===
    # Feature: Single-run scheduled generation with multi-channel fan-out.
    # Purpose: One scheduler tick must produce one canonical agent run, then fan the same
    # result out to requested delivery channels. This prevents same-conversation loops and
    # keeps generated-vs-delivered ledgers truthful across channels.
    channels = _normalize_dispatch_channels(task.get("channel"))
    # === VIVENTIUM NOTE ===
    base_url = os.getenv("SCHEDULER_LIBRECHAT_URL", "http://localhost:3080").rstrip("/")
    timeout_s = int(os.getenv("SCHEDULER_HTTP_TIMEOUT_S", "15"))
    conversation_id = _resolve_conversation_id(task)

    channel_results: Dict[str, Dict[str, Any]] = {}
    errors: Dict[str, str] = {}
    generation_result = _run_scheduler_generation(task, base_url, timeout_s, conversation_id)
    resolved_conversation_id = generation_result.get("conversation_id")
    visibility = _prepare_generated_visibility(
        task,
        str(generation_result.get("final_text") or ""),
        str(generation_result.get("followup_text") or ""),
    )

    if "librechat" in channels:
        channel_results["librechat"] = {
            "conversation_id": resolved_conversation_id,
            "delivery": _build_librechat_delivery_detail(visibility),
        }

    if "telegram" in channels:
        try:
            channel_results["telegram"] = {
                "conversation_id": resolved_conversation_id,
                "delivery": _deliver_telegram_generated_text(
                    task,
                    base_url,
                    timeout_s,
                    generation_result.get("response_message_id"),
                    visibility,
                ),
            }
        except Exception as exc:
            errors["telegram"] = str(exc)
            logger.warning(
                "[scheduling-cortex] Channel dispatch failed (best-effort continues): "
                "channel=%s task_id=%s error=%s",
                "telegram",
                task.get("id") or "unknown",
                exc,
            )

    # === VIVENTIUM NOTE ===
    # Feature: Best-effort multi-channel dispatch.
    # Scheduler generation is canonical. Requested channel delivery still succeeds if at
    # least one requested channel delivered or intentionally suppressed with a truthful ledger.
    if not channel_results:
        detail = "; ".join([f"{name}: {error}" for name, error in errors.items()])
        raise RuntimeError(f"Dispatch failed for all channels: {detail}")
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
    saw_heartbeat_keepalive = False
    suppress_reasons: list[str] = []
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
                if reason == "heartbeat_keepalive":
                    saw_heartbeat_keepalive = True
            elif outcome == "suppressed":
                saw_non_failed = True
                if reason:
                    suppress_reasons.append(f"{channel}:{reason}")
            elif outcome:
                saw_non_failed = True
            if not generated_text:
                text = detail.get("generated_text")
                if isinstance(text, str) and text.strip():
                    generated_text = text.strip()
    if saw_sent:
        delivery_outcome = "sent"
        delivery_reason = "heartbeat_keepalive" if saw_heartbeat_keepalive else "delivered"
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
    # === VIVENTIUM NOTE ===
    # Feature: Per-channel error ledger for partial success visibility.
    if errors:
        response["channel_errors"] = errors
    # === VIVENTIUM NOTE ===
    if len(channel_results) > 1:
        response["channel_results"] = channel_results
    return response
