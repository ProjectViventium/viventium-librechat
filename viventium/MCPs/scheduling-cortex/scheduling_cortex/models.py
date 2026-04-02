from __future__ import annotations

from typing import Literal, Optional, Dict, Any, List, Union

from pydantic import BaseModel, Field, field_validator, model_validator

from .utils import ensure_timezone, parse_time, normalize_days

# === VIVENTIUM START ===
# Feature: Multi-channel scheduling support.
ChannelLiteral = Literal["telegram", "librechat"]
ChannelList = List[ChannelLiteral]
ChannelValue = Union[ChannelLiteral, ChannelList]
AVAILABLE_CHANNELS: tuple[ChannelLiteral, ...] = ("telegram", "librechat")
# === VIVENTIUM END ===


class IntervalRule(BaseModel):
    every: int = Field(..., ge=1, description="Interval quantity")
    unit: Literal["minute", "hour", "day", "week"]


class ScheduleRule(BaseModel):
    type: Literal["once", "daily", "weekdays", "weekly", "monthly", "interval", "cron"]
    time: Optional[str] = Field(None, description="HH:MM 24-hour format")
    timezone: str = Field("UTC", description="IANA timezone name")
    days_of_week: Optional[List[str]] = None
    day_of_month: Optional[int] = Field(None, ge=1, le=31)
    interval: Optional[IntervalRule] = None
    run_at: Optional[str] = Field(None, description="ISO datetime for once schedules")
    cron: Optional[str] = Field(None, description="Cron expression")
    start_at: Optional[str] = Field(None, description="ISO datetime anchor for intervals")

    @field_validator("timezone")
    @classmethod
    def _validate_timezone(cls, value: str) -> str:
        ensure_timezone(value)
        return value

    @field_validator("time")
    @classmethod
    def _validate_time(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        parse_time(value)
        return value

    @field_validator("days_of_week")
    @classmethod
    def _validate_days(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return value
        normalize_days(value)
        return value

    @model_validator(mode="after")
    def _validate_required_fields(self) -> "ScheduleRule":
        if self.type == "once" and not self.run_at:
            raise ValueError("run_at is required for once schedules")
        if self.type in {"daily", "weekdays", "weekly", "monthly"} and not self.time:
            raise ValueError("time is required for daily/weekly/monthly schedules")
        if self.type == "weekly" and not self.days_of_week:
            raise ValueError("days_of_week is required for weekly schedules")
        if self.type == "monthly" and not self.day_of_month:
            raise ValueError("day_of_month is required for monthly schedules")
        if self.type == "interval" and not self.interval:
            raise ValueError("interval is required for interval schedules")
        if self.type == "cron" and not self.cron:
            raise ValueError("cron is required for cron schedules")
        return self


class CreateScheduleArgs(BaseModel):
    # === VIVENTIUM NOTE ===
    # Feature: Clarify auto-injected fields, channel defaults, and conversation policy behavior.
    user_id: Optional[str] = Field(
        None,
        description="LibreChat user id (auto-injected from X-Viventium-User-Id if omitted)",
    )
    agent_id: Optional[str] = Field(
        None,
        description="LibreChat agent id (auto-injected from X-Viventium-Agent-Id or VIVENTIUM_MAIN_AGENT_ID)",
    )
    prompt: str = Field(
        ...,
        min_length=1,
        description=(
            "Write the reminder/message as a note to yourself (the agent). "
            "A fixed scheduled self-prompt prefix is injected automatically."
        ),
    )
    schedule: ScheduleRule
    channel: Optional[ChannelValue] = Field(
        None,
        description=(
            "Delivery channel(s): 'telegram' | 'librechat' or a list of both. "
            "Defaults to all available channels when omitted. Example: ['telegram', 'librechat']"
        ),
    )
    conversation_policy: Literal["new", "same"] = Field(
        "new",
        description=(
            "Conversation handling: 'new' starts a fresh thread each run; "
            "'same' reuses conversation_id when available (first run uses new and stores id)"
        ),
    )
    conversation_id: Optional[str] = Field(
        None,
        description="Conversation id to reuse when conversation_policy='same' (optional)",
    )
    # === VIVENTIUM NOTE ===
    created_by: Optional[str] = Field(
        None,
        description="creator id, must be agent:<id> (auto-injected when omitted)",
    )
    created_source: Optional[Literal["user", "agent"]] = "user"
    metadata: Optional[Dict[str, Any]] = None
    active: bool = True

    @field_validator("created_by")
    @classmethod
    def _validate_created_by(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        if not value.startswith("agent:"):
            raise ValueError("created_by must be agent:<id>")
        return value

    # === VIVENTIUM NOTE ===
    # Feature: Ensure provided channel lists are non-empty.
    @field_validator("channel")
    @classmethod
    def _validate_channel(cls, value: Optional[ChannelValue]) -> Optional[ChannelValue]:
        if isinstance(value, list) and not value:
            raise ValueError("channel list cannot be empty")
        return value
    # === VIVENTIUM NOTE ===


class UpdateScheduleArgs(BaseModel):
    # === VIVENTIUM NOTE ===
    # Feature: Clarify auto-injected fields and channel/conversation behavior.
    user_id: Optional[str] = Field(
        None,
        description="LibreChat user id (auto-injected from X-Viventium-User-Id if omitted)",
    )
    task_id: str
    prompt: Optional[str] = None
    agent_id: Optional[str] = None
    schedule: Optional[ScheduleRule] = None
    channel: Optional[ChannelValue] = Field(
        None,
        description=(
            "Delivery channel(s) override: 'telegram' | 'librechat' or list. "
            "Example: ['telegram']"
        ),
    )
    conversation_policy: Optional[Literal["new", "same"]] = Field(
        None,
        description=(
            "Conversation handling override: 'new' resets per run; "
            "'same' reuses conversation_id when available"
        ),
    )
    conversation_id: Optional[str] = Field(
        None, description="Conversation id override (used when conversation_policy='same')"
    )
    # === VIVENTIUM NOTE ===
    active: Optional[bool] = None
    metadata: Optional[Dict[str, Any]] = None
    updated_by: Optional[str] = Field(
        None, description="editor id, must be agent:<id> (auto-injected when omitted)"
    )
    updated_source: Optional[Literal["user", "agent"]] = "user"

    @field_validator("updated_by")
    @classmethod
    def _validate_updated_by(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        if not value.startswith("agent:"):
            raise ValueError("updated_by must be agent:<id>")
        return value

    # === VIVENTIUM NOTE ===
    # Feature: Ensure provided channel lists are non-empty.
    @field_validator("channel")
    @classmethod
    def _validate_channel(cls, value: Optional[ChannelValue]) -> Optional[ChannelValue]:
        if isinstance(value, list) and not value:
            raise ValueError("channel list cannot be empty")
        return value
    # === VIVENTIUM NOTE ===


class GetScheduleArgs(BaseModel):
    # === VIVENTIUM NOTE ===
    # Feature: Clarify auto-injected user_id.
    user_id: Optional[str] = Field(
        None,
        description="LibreChat user id (auto-injected from X-Viventium-User-Id if omitted)",
    )
    # === VIVENTIUM NOTE ===
    task_id: str


class DeleteScheduleArgs(BaseModel):
    # === VIVENTIUM NOTE ===
    # Feature: Clarify auto-injected user_id.
    user_id: Optional[str] = Field(
        None,
        description="LibreChat user id (auto-injected from X-Viventium-User-Id if omitted)",
    )
    # === VIVENTIUM NOTE ===
    task_id: str


class ListScheduleArgs(BaseModel):
    # === VIVENTIUM NOTE ===
    # Feature: Clarify auto-injected user_id and channel filtering behavior.
    user_id: Optional[str] = Field(
        None,
        description="LibreChat user id (auto-injected from X-Viventium-User-Id if omitted)",
    )
    active_only: bool = False
    channel: Optional[ChannelValue] = Field(
        None,
        description="Filter by channel(s): 'telegram' | 'librechat' or list",
    )
    # === VIVENTIUM NOTE ===
    agent_id: Optional[str] = None
    limit: int = Field(50, ge=1, le=500)
    offset: int = Field(0, ge=0)

    # === VIVENTIUM NOTE ===
    # Feature: Ensure provided channel lists are non-empty.
    @field_validator("channel")
    @classmethod
    def _validate_channel(cls, value: Optional[ChannelValue]) -> Optional[ChannelValue]:
        if isinstance(value, list) and not value:
            raise ValueError("channel list cannot be empty")
        return value
    # === VIVENTIUM NOTE ===


class SearchScheduleArgs(BaseModel):
    # === VIVENTIUM NOTE ===
    # Feature: Clarify auto-injected user_id and channel filtering behavior.
    user_id: Optional[str] = Field(
        None,
        description="LibreChat user id (auto-injected from X-Viventium-User-Id if omitted)",
    )
    query: str = Field(..., min_length=1)
    channel: Optional[ChannelValue] = Field(
        None,
        description="Filter by channel(s): 'telegram' | 'librechat' or list",
    )
    # === VIVENTIUM NOTE ===
    agent_id: Optional[str] = None
    limit: int = Field(50, ge=1, le=500)
    offset: int = Field(0, ge=0)

    # === VIVENTIUM NOTE ===
    # Feature: Ensure provided channel lists are non-empty.
    @field_validator("channel")
    @classmethod
    def _validate_channel(cls, value: Optional[ChannelValue]) -> Optional[ChannelValue]:
        if isinstance(value, list) and not value:
            raise ValueError("channel list cannot be empty")
        return value
    # === VIVENTIUM NOTE ===


class PreviewScheduleArgs(BaseModel):
    # === VIVENTIUM NOTE ===
    # Feature: Clarify auto-injected user_id.
    user_id: Optional[str] = Field(
        None,
        description="LibreChat user id (auto-injected from X-Viventium-User-Id if omitted)",
    )
    # === VIVENTIUM NOTE ===
    task_id: str
    count: int = Field(3, ge=1, le=10)


class LastDeliveryArgs(BaseModel):
    # === VIVENTIUM NOTE ===
    # Feature: Delivery visibility lookup for last scheduled run outcome.
    user_id: Optional[str] = Field(
        None,
        description="LibreChat user id (auto-injected from X-Viventium-User-Id if omitted)",
    )
    # === VIVENTIUM NOTE ===
    task_id: Optional[str] = Field(
        None,
        description="Specific task id to inspect. If omitted, returns most recent matching task.",
    )
    channel: Optional[ChannelValue] = Field(
        None,
        description="Optional channel filter: 'telegram' | 'librechat' or list",
    )
    agent_id: Optional[str] = None

    @field_validator("channel")
    @classmethod
    def _validate_channel(cls, value: Optional[ChannelValue]) -> Optional[ChannelValue]:
        if isinstance(value, list) and not value:
            raise ValueError("channel list cannot be empty")
        return value


class ScheduleTask(BaseModel):
    id: str
    user_id: str
    agent_id: str
    prompt: str
    schedule: ScheduleRule
    # === VIVENTIUM NOTE ===
    # Feature: Tasks may target one or multiple channels.
    channel: ChannelValue
    # === VIVENTIUM NOTE ===
    conversation_policy: Literal["new", "same"]
    conversation_id: Optional[str] = None
    last_conversation_id: Optional[str] = None
    active: bool
    created_by: str
    created_source: str
    created_at: str
    updated_at: str
    updated_by: str
    updated_source: str
    last_run_at: Optional[str] = None
    next_run_at: Optional[str] = None
    last_status: Optional[str] = None
    last_error: Optional[str] = None
    # === VIVENTIUM NOTE ===
    # Feature: Persist and expose delivery ledger for scheduled-run visibility.
    last_delivery_outcome: Optional[str] = None
    last_delivery_reason: Optional[str] = None
    last_delivery_at: Optional[str] = None
    last_generated_text: Optional[str] = None
    last_delivery: Optional[Dict[str, Any]] = None
    # === VIVENTIUM NOTE ===
    metadata: Optional[Dict[str, Any]] = None
