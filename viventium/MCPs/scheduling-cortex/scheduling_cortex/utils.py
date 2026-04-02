# VIVENTIUM START
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# VIVENTIUM END

import re
from datetime import datetime, timedelta, timezone
from typing import Iterable, List
from zoneinfo import ZoneInfo

TIME_RE = re.compile(r"^(?:[01]?\d|2[0-3]):[0-5]\d$")
DAY_ALIASES = {
    "mon": 0,
    "monday": 0,
    "tue": 1,
    "tues": 1,
    "tuesday": 1,
    "wed": 2,
    "weds": 2,
    "wednesday": 2,
    "thu": 3,
    "thur": 3,
    "thurs": 3,
    "thursday": 3,
    "fri": 4,
    "friday": 4,
    "sat": 5,
    "saturday": 5,
    "sun": 6,
    "sunday": 6,
}


def ensure_timezone(name: str) -> ZoneInfo:
    try:
        return ZoneInfo(name)
    except Exception as exc:
        raise ValueError(f"Invalid timezone: {name}") from exc


def parse_time(value: str) -> tuple[int, int]:
    if not TIME_RE.match(value or ""):
        raise ValueError("Time must be HH:MM in 24-hour format")
    hour, minute = value.split(":")
    return int(hour), int(minute)


def parse_iso(value: str, default_tz: ZoneInfo) -> datetime:
    if not value:
        raise ValueError("Datetime value is required")
    raw = value.replace("Z", "+00:00")
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=default_tz)
    return dt


def to_utc_iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def normalize_days(days: Iterable[str]) -> List[int]:
    normalized: List[int] = []
    for day in days:
        key = (day or "").strip().lower()
        if key not in DAY_ALIASES:
            raise ValueError(f"Invalid day of week: {day}")
        normalized.append(DAY_ALIASES[key])
    if not normalized:
        raise ValueError("days_of_week cannot be empty")
    return sorted(set(normalized))


def last_day_of_month(year: int, month: int) -> int:
    if month == 12:
        next_month = datetime(year + 1, 1, 1)
    else:
        next_month = datetime(year, month + 1, 1)
    return (next_month - timedelta(days=1)).day
