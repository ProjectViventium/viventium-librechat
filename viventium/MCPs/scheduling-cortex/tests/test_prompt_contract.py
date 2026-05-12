# VIVENTIUM START
# Tests: Scheduling Cortex MCP prompt ownership contract.
# VIVENTIUM END

from __future__ import annotations

import asyncio
from pathlib import Path

from scheduling_cortex.server import SCHEDULING_CORTEX_INSTRUCTIONS, build_server
from scheduling_cortex.storage import ScheduleStorage, StorageConfig


def _build_test_server(tmp_path: Path):
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    return build_server(storage)


def _tools_by_name(mcp) -> dict:
    if hasattr(mcp, "get_tools"):
        return asyncio.run(mcp.get_tools())
    if hasattr(mcp, "list_tools"):
        return {tool.name: tool for tool in asyncio.run(mcp.list_tools())}
    return mcp._tool_manager._tools


def test_server_instructions_cover_prompt_ownership_contract() -> None:
    text = SCHEDULING_CORTEX_INSTRUCTIONS.lower()

    expected = [
        "what it does",
        "when to use",
        "when not to use",
        "user_id and agent_id are injected",
        "timezone",
        "{nta}",
        "summary-safe",
        "morning_briefing_default_v1",
        "do not branch on prompt text",
        "structured fields",
    ]

    for phrase in expected:
        assert phrase in text


def test_server_instructions_forbid_user_facing_internal_schedule_leaks() -> None:
    text = SCHEDULING_CORTEX_INSTRUCTIONS.lower()

    expected = [
        "user-facing replies must translate tool output into plain outcomes",
        "do not expose task ids",
        "raw prompt text",
        "metadata keys/flags",
        "private evidence",
        "without quoting stored prompt text or naming storage fields",
    ]

    for phrase in expected:
        assert phrase in text


def test_fastmcp_server_exposes_top_level_instructions(tmp_path: Path) -> None:
    mcp = _build_test_server(tmp_path)

    assert getattr(mcp, "instructions", None) == SCHEDULING_CORTEX_INSTRUCTIONS


def test_tool_descriptions_cover_mcp_checklist(tmp_path: Path) -> None:
    mcp = _build_test_server(tmp_path)
    tools = _tools_by_name(mcp)

    assert {
        "schedule_create",
        "schedule_get",
        "schedule_list",
        "schedule_search",
        "schedule_last_delivery",
        "schedule_update",
        "schedule_delete",
        "schedule_preview_next",
    }.issubset(tools.keys())

    checklist = [
        "what it does:",
        "when to use:",
        "when not to use:",
        "inputs:",
        "returns:",
        "failure modes:",
        "idempotency and duplicate prevention:",
        "delayed callback behavior:",
    ]

    for name, tool in tools.items():
        description = str(tool.description or "").lower()
        for phrase in checklist:
            assert phrase in description, f"{name} missing {phrase}"


def test_create_and_update_descriptions_prevent_duplicate_starter_briefings(tmp_path: Path) -> None:
    mcp = _build_test_server(tmp_path)
    tools = _tools_by_name(mcp)

    create_description = tools["schedule_create"].description
    update_description = tools["schedule_update"].description
    combined = f"{SCHEDULING_CORTEX_INSTRUCTIONS}\n{create_description}\n{update_description}".lower()

    assert "morning_briefing_default_v1" in combined
    assert "starter" in combined
    assert "duplicate" in combined


def test_full_detail_read_description_keeps_raw_fields_private(tmp_path: Path) -> None:
    mcp = _build_test_server(tmp_path)
    tools = _tools_by_name(mcp)

    description = str(tools["schedule_get"].description or "").lower()

    assert "private verification" in description
    assert "ordinary user-facing replies must translate" in description
    assert "avoid raw prompt text" in description
    assert "metadata keys" in description
