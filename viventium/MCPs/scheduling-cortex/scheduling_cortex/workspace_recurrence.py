# === VIVENTIUM START ===
# Purpose: Keep GlassHive workspace recurrence semantics structurally aligned with the owning
# GlassHive recurrence contract while Scheduling Cortex remains the single durable clock owner.
# Porting: Keep validation and occurrence behavior in sync with GlassHive recurrence.py.
# === VIVENTIUM END ===

from __future__ import annotations

import hashlib
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter
from dateutil.rrule import rrulestr

RECURRENCE_TYPES = {"once", "daily", "interval", "cron", "rfc5545"}
DST_POLICIES = {"next_valid_earliest", "next_valid_latest"}
OVERLAP_POLICIES = {"skip", "queue"}
CATCH_UP_POLICIES = {"skip", "bounded", "coalesce"}
MIN_INTERVAL_SECONDS = 60
MAX_INTERVAL_SECONDS = 366 * 24 * 60 * 60
MAX_MISFIRE_GRACE_SECONDS = 7 * 24 * 60 * 60
MAX_CATCH_UP_OCCURRENCES = 10
MAX_JITTER_SECONDS = 15 * 60
MAX_RRULE_LENGTH = 2048
MAX_RRULE_PARTS = 32
MAX_RRULE_LIST_VALUES = 64
MAX_RRULE_COUNT = 10_000
MAX_RRULE_INTERVALS = {
    "MINUTELY": 527_040,
    "HOURLY": 8_784,
    "DAILY": 366,
    "WEEKLY": 53,
    "MONTHLY": 1_200,
    "YEARLY": 100,
}


def parse_aware_utc(value: str, *, label: str) -> datetime:
    raw = str(value or "").strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO datetime") from exc
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone offset")
    return parsed.astimezone(timezone.utc)


def _timezone(value: str) -> ZoneInfo:
    name = str(value or "").strip()
    if not name:
        raise ValueError("timezone_name must be an IANA timezone")
    try:
        return ZoneInfo(name)
    except ZoneInfoNotFoundError as exc:
        raise ValueError("timezone_name must be a valid IANA timezone") from exc


def _local_time(value: str) -> time:
    raw = str(value or "").strip()
    try:
        parsed = time.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError("local_time must use HH:MM in 24-hour time") from exc
    if parsed.tzinfo is not None or parsed.second or parsed.microsecond or len(raw) != 5:
        raise ValueError("local_time must use HH:MM in 24-hour time")
    return parsed


def _valid_utc_candidates(local_value: datetime, zone: ZoneInfo) -> list[datetime]:
    candidates: dict[str, datetime] = {}
    for fold in (0, 1):
        candidate = local_value.replace(tzinfo=zone, fold=fold).astimezone(timezone.utc)
        if candidate.astimezone(zone).replace(tzinfo=None) == local_value:
            candidates[candidate.isoformat()] = candidate
    return sorted(candidates.values())


def _schedule_boundary(value: str, *, timezone_name: str, label: str) -> datetime:
    raw = str(value or "").strip()
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{label} must be an ISO datetime") from exc
    if parsed.tzinfo is not None:
        return parsed.astimezone(timezone.utc)
    candidates = _valid_utc_candidates(parsed, _timezone(timezone_name))
    if not candidates:
        raise ValueError(f"{label} is not a valid local time in timezone_name")
    return candidates[0]


def resolve_local_occurrence(
    local_date: date,
    local_time: time,
    *,
    timezone_name: str,
    dst_policy: str,
) -> datetime:
    return _resolve_local_datetime(
        datetime.combine(local_date, local_time),
        timezone_name=timezone_name,
        dst_policy=dst_policy,
    )


def _resolve_local_datetime(
    local_value: datetime,
    *,
    timezone_name: str,
    dst_policy: str,
) -> datetime:
    if local_value.tzinfo is not None:
        raise ValueError("local occurrence must not include a timezone")
    if dst_policy not in DST_POLICIES:
        raise ValueError("DST policy must be next_valid_earliest or next_valid_latest")
    zone = _timezone(timezone_name)
    for minute_offset in range(361):
        candidates = _valid_utc_candidates(local_value + timedelta(minutes=minute_offset), zone)
        if candidates:
            return candidates[-1] if dst_policy.endswith("latest") else candidates[0]
    raise ValueError("local_time cannot be resolved in the configured timezone")


def _next_cron_occurrence(spec: dict[str, object], after: datetime) -> datetime:
    zone = _timezone(str(spec["timezone_name"]))
    cursor = after.astimezone(zone).replace(tzinfo=None)
    iterator = croniter(str(spec["cron_expression"]), cursor)
    for _ in range(16):
        local_candidate = iterator.get_next(datetime)
        occurrence = _resolve_local_datetime(
            local_candidate,
            timezone_name=str(spec["timezone_name"]),
            dst_policy=str(spec["dst_policy"]),
        )
        if occurrence > after:
            return occurrence
    raise ValueError("cron_expression did not produce a future wall-clock occurrence")


def _previous_cron_occurrence(spec: dict[str, object], before: datetime) -> datetime:
    zone = _timezone(str(spec["timezone_name"]))
    cursor = before.astimezone(zone).replace(tzinfo=None)
    iterator = croniter(str(spec["cron_expression"]), cursor)
    for _ in range(16):
        local_candidate = iterator.get_prev(datetime)
        occurrence = _resolve_local_datetime(
            local_candidate,
            timezone_name=str(spec["timezone_name"]),
            dst_policy=str(spec["dst_policy"]),
        )
        if occurrence < before:
            return occurrence
    raise ValueError("cron_expression did not produce a previous wall-clock occurrence")


def _rrule_fields(rule_text: str) -> dict[str, str]:
    text = str(rule_text or "").strip()
    if text.upper().startswith("RRULE:"):
        text = text[6:]
    if not text or len(text) > MAX_RRULE_LENGTH or "\n" in text or "\r" in text:
        raise ValueError("rrule is too complex")
    segments = text.split(";")
    if len(segments) > MAX_RRULE_PARTS:
        raise ValueError("rrule is too complex")
    fields: dict[str, str] = {}
    value_count = 0
    for segment in segments:
        key, separator, value = segment.partition("=")
        key = key.strip().upper()
        value = value.strip().upper()
        if separator != "=" or not key or not value or key in fields:
            raise ValueError("rrule must be a valid RFC 5545 recurrence rule")
        value_count += len(value.split(","))
        if value_count > MAX_RRULE_LIST_VALUES:
            raise ValueError("rrule is too complex")
        fields[key] = value
    frequency = fields.get("FREQ", "")
    if frequency == "SECONDLY":
        raise ValueError("rrule cadence must be at least one minute")
    if frequency not in MAX_RRULE_INTERVALS:
        raise ValueError("rrule must use a supported RFC 5545 frequency")
    try:
        interval = int(fields.get("INTERVAL") or "1")
    except ValueError as exc:
        raise ValueError("rrule must be a valid RFC 5545 recurrence rule") from exc
    if interval < 1 or interval > MAX_RRULE_INTERVALS[frequency]:
        raise ValueError("rrule INTERVAL is outside the supported range")
    by_second = fields.get("BYSECOND", "")
    if by_second and len(by_second.split(",")) > 1:
        raise ValueError("rrule is too complex; subminute expansion is not supported")
    if "COUNT" in fields:
        try:
            count = int(fields["COUNT"])
        except ValueError as exc:
            raise ValueError("rrule must be a valid RFC 5545 recurrence rule") from exc
        if count < 1 or count > MAX_RRULE_COUNT:
            raise ValueError(f"rrule COUNT must be between 1 and {MAX_RRULE_COUNT}")
    return fields


def normalize_recurrence_spec(
    *,
    recurrence_type: str,
    interval_seconds: int | None = None,
    local_time: str = "",
    timezone_name: str = "UTC",
    dst_policy: str = "next_valid_earliest",
    cron_expression: str = "",
    rrule: str = "",
    starts_at: str | None = None,
    ends_at: str | None = None,
    enabled: bool = True,
    overlap_policy: str = "skip",
    misfire_grace_seconds: int = 300,
    catch_up_policy: str = "skip",
    max_catch_up_occurrences: int = 1,
    jitter_seconds: int = 0,
) -> dict[str, object]:
    kind = str(recurrence_type or "").strip().lower()
    if kind not in RECURRENCE_TYPES:
        raise ValueError("recurrence_type must be once, daily, interval, cron, or rfc5545")
    zone_name = str(timezone_name or "").strip()
    _timezone(zone_name)
    overlap = str(overlap_policy or "").strip().lower()
    if overlap not in OVERLAP_POLICIES:
        raise ValueError("overlap_policy must be skip or queue")
    catch_up = str(catch_up_policy or "").strip().lower()
    if catch_up not in CATCH_UP_POLICIES:
        raise ValueError("catch_up_policy must be skip, bounded, or coalesce")
    try:
        grace = int(misfire_grace_seconds)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("misfire_grace_seconds must be an integer") from exc
    if grace < 0 or grace > MAX_MISFIRE_GRACE_SECONDS:
        raise ValueError(
            f"misfire_grace_seconds must be between 0 and {MAX_MISFIRE_GRACE_SECONDS}"
        )
    try:
        catch_up_limit = int(max_catch_up_occurrences)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("max_catch_up_occurrences must be an integer") from exc
    if catch_up_limit < 1 or catch_up_limit > MAX_CATCH_UP_OCCURRENCES:
        raise ValueError(
            f"max_catch_up_occurrences must be between 1 and {MAX_CATCH_UP_OCCURRENCES}"
        )
    try:
        jitter = int(jitter_seconds)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("jitter_seconds must be an integer") from exc
    if jitter < 0 or jitter > MAX_JITTER_SECONDS:
        raise ValueError(f"jitter_seconds must be between 0 and {MAX_JITTER_SECONDS}")
    start = (
        _schedule_boundary(starts_at, timezone_name=zone_name, label="starts_at")
        if starts_at
        else None
    )
    end = (
        _schedule_boundary(ends_at, timezone_name=zone_name, label="ends_at")
        if ends_at
        else None
    )
    if start and end and end < start:
        raise ValueError("ends_at must not be before starts_at")

    normalized: dict[str, object] = {
        "type": "glasshive_recurrence",
        "recurrence_type": kind,
        "interval_seconds": None,
        "local_time": "",
        "timezone_name": zone_name,
        "dst_policy": dst_policy,
        "cron_expression": "",
        "rrule": "",
        "starts_at": start.isoformat() if start else None,
        "ends_at": end.isoformat() if end else None,
        "enabled": bool(enabled),
        "overlap_policy": overlap,
        "misfire_grace_seconds": grace,
        "catch_up_policy": catch_up,
        "max_catch_up_occurrences": catch_up_limit,
        "jitter_seconds": jitter,
    }

    if kind == "once":
        if start is None:
            raise ValueError("once recurrence requires starts_at or first_run_at")
        normalized["dst_policy"] = "elapsed"
        return normalized
    if kind == "interval":
        if isinstance(interval_seconds, bool):
            raise ValueError("interval_seconds must be an integer")
        try:
            seconds = int(interval_seconds or 0)
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError("interval_seconds must be an integer") from exc
        if seconds < MIN_INTERVAL_SECONDS:
            raise ValueError(f"interval_seconds must be at least {MIN_INTERVAL_SECONDS}")
        if seconds > MAX_INTERVAL_SECONDS:
            raise ValueError(f"interval_seconds must be at most {MAX_INTERVAL_SECONDS}")
        if zone_name.upper() != "UTC":
            raise ValueError("interval recurrence uses elapsed UTC time; timezone_name must be UTC")
        normalized.update(
            {"interval_seconds": seconds, "timezone_name": "UTC", "dst_policy": "elapsed"}
        )
        return normalized
    if kind == "cron":
        expression = str(cron_expression or "").strip()
        if len(expression.split()) != 5 or not croniter.is_valid(expression):
            raise ValueError("cron_expression must be a valid cron expression")
        if dst_policy not in DST_POLICIES:
            raise ValueError("DST policy must be next_valid_earliest or next_valid_latest")
        normalized["cron_expression"] = expression
        return normalized
    if kind == "rfc5545":
        rule_text = str(rrule or "").strip()
        if not rule_text:
            raise ValueError("rrule is required for rfc5545 recurrence")
        _rrule_fields(rule_text)
        try:
            rrulestr(
                rule_text,
                dtstart=(start or datetime.now(timezone.utc)).astimezone(_timezone(zone_name)),
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("rrule must be a valid RFC 5545 recurrence rule") from exc
        normalized.update({"rrule": rule_text, "dst_policy": "elapsed"})
        return normalized

    parsed_local_time = _local_time(local_time)
    if dst_policy not in DST_POLICIES:
        raise ValueError("DST policy must be next_valid_earliest or next_valid_latest")
    normalized["local_time"] = parsed_local_time.strftime("%H:%M")
    return normalized


def _bounded_by_end(value: datetime | None, spec: dict[str, object]) -> datetime | None:
    if value is None:
        return None
    ends_at = str(spec.get("ends_at") or "").strip()
    if ends_at and value > parse_aware_utc(ends_at, label="ends_at"):
        return None
    return value


def _rfc_rule(spec: dict[str, object], *, default_start: datetime | None = None):
    zone = _timezone(str(spec.get("timezone_name") or "UTC"))
    starts_at = str(spec.get("starts_at") or "").strip()
    start = (
        parse_aware_utc(starts_at, label="starts_at")
        if starts_at
        else (default_start or datetime.now(timezone.utc))
    )
    return rrulestr(
        str(spec.get("rrule") or ""),
        dtstart=start.replace(second=0, microsecond=0).astimezone(zone),
    )


def _shift_months(value: datetime, months: int) -> datetime:
    month_index = value.year * 12 + value.month - 1 + months
    year, month_zero = divmod(month_index, 12)
    month = month_zero + 1
    return value.replace(year=year, month=month)


def _aligned_month_period(value: datetime, periods: int, interval_months: int) -> datetime:
    """Find a nearby valid period without changing DTSTART's implicit month-day."""

    for rewind in range(min(max(0, periods), 4800) + 1):
        try:
            return _shift_months(value, (periods - rewind) * interval_months)
        except ValueError:
            continue
    raise ValueError("monthly recurrence could not preserve DTSTART alignment")


def _aligned_rfc_anchor(
    spec: dict[str, object],
    *,
    reference: datetime,
    fallback_start: datetime,
    lookback_periods: int,
) -> datetime:
    zone = _timezone(str(spec.get("timezone_name") or "UTC"))
    starts_at = str(spec.get("starts_at") or "").strip()
    anchor = (
        parse_aware_utc(starts_at, label="starts_at")
        if starts_at
        else fallback_start.astimezone(timezone.utc)
    ).astimezone(zone)
    target = reference.astimezone(zone)
    fields = _rrule_fields(str(spec.get("rrule") or ""))
    interval = max(1, int(fields.get("INTERVAL") or "1"))
    frequency = fields.get("FREQ", "")
    if frequency in {"MINUTELY", "HOURLY", "DAILY", "WEEKLY"}:
        seconds = {
            "MINUTELY": 60,
            "HOURLY": 3600,
            "DAILY": 86400,
            "WEEKLY": 7 * 86400,
        }[frequency] * interval
        periods = max(0, int((target - anchor).total_seconds()) // seconds)
        return anchor + timedelta(seconds=max(0, periods - lookback_periods) * seconds)
    if frequency == "MONTHLY":
        months = max(0, (target.year - anchor.year) * 12 + target.month - anchor.month)
        periods = months // interval
        aligned_periods = max(0, periods - lookback_periods)
        return _aligned_month_period(anchor, aligned_periods, interval)
    if frequency == "YEARLY":
        periods = max(0, (target.year - anchor.year) // interval)
        aligned_periods = max(0, periods - lookback_periods)
        return _aligned_month_period(anchor, aligned_periods, interval * 12)
    raise ValueError("rrule frequency is not supported")


def _rfc_occurrence_near(
    spec: dict[str, object],
    *,
    reference: datetime,
    fallback_start: datetime,
    before: bool,
    inclusive: bool,
) -> datetime | None:
    zone = _timezone(str(spec.get("timezone_name") or "UTC"))
    rule = _rfc_rule(spec, default_start=fallback_start)
    if getattr(rule, "_count", None) is not None:
        value = (
            rule.before(reference.astimezone(zone), inc=inclusive)
            if before
            else rule.after(reference.astimezone(zone), inc=inclusive)
        )
        return value.astimezone(timezone.utc) if value else None
    target = reference.astimezone(zone)
    until = getattr(rule, "_until", None)
    if before and isinstance(until, datetime) and target > until:
        target = until
        inclusive = True
    # Expand a bounded window around the target instead of walking from the
    # persisted start. The wider tail covers sparse calendar filters (for
    # example a MINUTELY rule constrained to one day per year) while dense
    # rules resolve in the first one or two iterations.
    for lookback in (1 << exponent for exponent in range(1, 21)):
        near_start = _aligned_rfc_anchor(
            spec,
            reference=target,
            fallback_start=fallback_start,
            lookback_periods=lookback,
        )
        near_rule = rrulestr(str(spec.get("rrule") or ""), dtstart=near_start)
        value = (
            near_rule.before(target, inc=inclusive)
            if before
            else near_rule.after(target, inc=inclusive)
        )
        if value is not None:
            return value.astimezone(timezone.utc)
    return None


def first_occurrence_at(
    spec: dict[str, object],
    *,
    now: datetime,
    first_run_at: str | None = None,
) -> datetime:
    now_utc = now.astimezone(timezone.utc)
    if first_run_at:
        occurrence = parse_aware_utc(first_run_at, label="next_run_at")
        starts_at = str(spec.get("starts_at") or "").strip()
        if starts_at and occurrence < parse_aware_utc(starts_at, label="starts_at"):
            raise ValueError("next_run_at must not be before starts_at")
        bounded = _bounded_by_end(occurrence, spec)
        if bounded is None:
            raise ValueError("recurrence has no occurrence inside its start/end window")
        return bounded
    starts_at = str(spec.get("starts_at") or "").strip()
    start = parse_aware_utc(starts_at, label="starts_at") if starts_at else None
    kind = str(spec["recurrence_type"])
    if kind == "once":
        if start is None:
            raise ValueError("once recurrence requires starts_at")
        return start
    if kind == "interval":
        occurrence = start or now_utc + timedelta(seconds=int(spec["interval_seconds"] or 0))
        bounded = _bounded_by_end(occurrence, spec)
        if bounded is None:
            raise ValueError("recurrence has no occurrence inside its start/end window")
        return bounded
    if kind == "cron":
        occurrence = _next_cron_occurrence(spec, max(now_utc, start or now_utc))
        bounded = _bounded_by_end(occurrence, spec)
        if bounded is None:
            raise ValueError("recurrence has no occurrence inside its start/end window")
        return bounded
    if kind == "rfc5545":
        zone = _timezone(str(spec["timezone_name"]))
        base = max(now_utc, start or now_utc).astimezone(zone)
        occurrence = _rfc_rule(spec, default_start=base).after(base, inc=True)
        bounded = _bounded_by_end(occurrence.astimezone(timezone.utc) if occurrence else None, spec)
        if bounded is None:
            raise ValueError("recurrence has no occurrence inside its start/end window")
        return bounded

    zone = _timezone(str(spec["timezone_name"]))
    search_from = max(now_utc, start or now_utc)
    local_now = search_from.astimezone(zone)
    parsed_local_time = _local_time(str(spec["local_time"]))
    for day_offset in range(3):
        occurrence = resolve_local_occurrence(
            local_now.date() + timedelta(days=day_offset),
            parsed_local_time,
            timezone_name=str(spec["timezone_name"]),
            dst_policy=str(spec["dst_policy"]),
        )
        if occurrence > now_utc and (start is None or occurrence >= start):
            bounded = _bounded_by_end(occurrence, spec)
            if bounded is None:
                raise ValueError("recurrence has no occurrence inside its start/end window")
            return bounded
    raise ValueError("could not resolve the first daily occurrence")


def next_after(spec: dict[str, object], occurrence: datetime) -> datetime | None:
    kind = str(spec["recurrence_type"])
    if kind == "once":
        return None
    if kind == "interval":
        return _bounded_by_end(
            occurrence + timedelta(seconds=int(spec["interval_seconds"] or 0)), spec
        )
    if kind == "daily":
        zone = _timezone(str(spec["timezone_name"]))
        return _bounded_by_end(
            resolve_local_occurrence(
                occurrence.astimezone(zone).date() + timedelta(days=1),
                _local_time(str(spec["local_time"])),
                timezone_name=str(spec["timezone_name"]),
                dst_policy=str(spec["dst_policy"]),
            ),
            spec,
        )
    if kind == "cron":
        return _bounded_by_end(_next_cron_occurrence(spec, occurrence), spec)
    if kind == "rfc5545":
        value = _rfc_occurrence_near(
            spec,
            reference=occurrence,
            fallback_start=occurrence,
            before=False,
            inclusive=False,
        )
        return _bounded_by_end(value, spec)
    raise ValueError("persisted recurrence_type is invalid")


def _previous_before(spec: dict[str, object], occurrence: datetime) -> datetime | None:
    kind = str(spec["recurrence_type"])
    if kind == "interval":
        return occurrence - timedelta(seconds=int(spec["interval_seconds"] or 0))
    if kind == "daily":
        zone = _timezone(str(spec["timezone_name"]))
        return resolve_local_occurrence(
            occurrence.astimezone(zone).date() - timedelta(days=1),
            _local_time(str(spec["local_time"])),
            timezone_name=str(spec["timezone_name"]),
            dst_policy=str(spec["dst_policy"]),
        )
    if kind == "cron":
        return _previous_cron_occurrence(spec, occurrence)
    if kind == "rfc5545":
        return _rfc_occurrence_near(
            spec,
            reference=occurrence,
            fallback_start=occurrence,
            before=True,
            inclusive=False,
        )
    return None


def _latest_due(spec: dict[str, object], next_due: datetime, now: datetime) -> datetime:
    kind = str(spec["recurrence_type"])
    if kind == "once":
        return next_due
    if kind == "interval":
        seconds = int(spec["interval_seconds"] or 0)
        periods = int((now - next_due).total_seconds()) // seconds
        return next_due + timedelta(seconds=periods * seconds)
    if kind == "daily":
        zone = _timezone(str(spec["timezone_name"]))
        local_now = now.astimezone(zone)
        candidate = resolve_local_occurrence(
            local_now.date(),
            _local_time(str(spec["local_time"])),
            timezone_name=str(spec["timezone_name"]),
            dst_policy=str(spec["dst_policy"]),
        )
        if candidate > now:
            candidate = resolve_local_occurrence(
                local_now.date() - timedelta(days=1),
                _local_time(str(spec["local_time"])),
                timezone_name=str(spec["timezone_name"]),
                dst_policy=str(spec["dst_policy"]),
            )
        return max(next_due, candidate)
    if kind == "cron":
        candidate = _previous_cron_occurrence(spec, now + timedelta(microseconds=1))
        return max(next_due, candidate)
    if kind == "rfc5545":
        candidate = _rfc_occurrence_near(
            spec,
            reference=now,
            fallback_start=next_due,
            before=True,
            inclusive=True,
        )
        return max(next_due, candidate) if candidate is not None else next_due
    raise ValueError("persisted recurrence_type is invalid")


def due_occurrences_and_next(
    spec: dict[str, object],
    *,
    next_run_at: str,
    now: datetime,
) -> tuple[list[dict[str, object]], datetime | None]:
    if not bool(spec["enabled"]):
        return [], parse_aware_utc(next_run_at, label="next_run_at")
    now_utc = now.astimezone(timezone.utc)
    next_due = parse_aware_utc(next_run_at, label="next_run_at")
    if next_due > now_utc:
        return [], next_due
    latest = _latest_due(spec, next_due, now_utc)
    following = next_after(spec, latest)
    catch_up = str(spec["catch_up_policy"])
    if catch_up == "bounded":
        values = [latest]
        while len(values) < int(spec["max_catch_up_occurrences"]):
            previous = _previous_before(spec, values[0])
            if previous is None or previous < next_due:
                break
            values.insert(0, previous)
        return [
            {"scheduled_for": value, "state": "pending", "outcome": "pending"}
            for value in values
        ], following
    lateness = max(0, int((now_utc - latest).total_seconds()))
    if catch_up == "skip" and lateness > int(spec["misfire_grace_seconds"]):
        return [
            {"scheduled_for": latest, "state": "skipped", "outcome": "misfire_skipped"}
        ], following
    return [{"scheduled_for": latest, "state": "pending", "outcome": "pending"}], following


def deterministic_jitter_seconds(
    definition_id: str,
    scheduled_for: datetime,
    maximum: int,
) -> int:
    if maximum <= 0:
        return 0
    digest = hashlib.sha256(
        f"{definition_id}\0{scheduled_for.astimezone(timezone.utc).isoformat()}".encode()
    ).digest()
    return int.from_bytes(digest[:8], "big") % (maximum + 1)


def occurrence_run_id(definition_id: str, scheduled_for: datetime) -> str:
    occurrence_key = scheduled_for.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    digest = hashlib.sha256(f"{definition_id}\0{occurrence_key}".encode()).hexdigest()
    return f"sp_run_{digest[:32]}"
