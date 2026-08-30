# VIVENTIUM START
# Tests: Scheduling Cortex MCP prompt ownership contract.
# VIVENTIUM END

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.server import (
    SCHEDULING_CORTEX_INSTRUCTIONS,
    _serialize_periphery_list_for_agent,
    _serialize_periphery_read_for_agent,
    build_server,
)
from scheduling_cortex import dispatch

SHARED_ROOT = ROOT.parents[3] / "shared"
if str(SHARED_ROOT) not in sys.path:
    sys.path.insert(0, str(SHARED_ROOT))
from scheduler_prompt_contract import (  # noqa: E402
    CONSCIOUSNESS_CONTINUITY_OPPORTUNITY_PROMPT_ID,
    SCHEDULER_RUN_ENVELOPE_PROMPT_ID,
    SCHEDULER_RUN_ENVELOPE_TEMPLATE,
    render_scheduler_run_envelope,
)
from scheduling_cortex.models import CreateScheduleArgs, UpdateScheduleArgs
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
        "current turn before stating them",
        "never infer them from conversation history",
        "private periphery",
        "do not inspect periphery by default",
        "persisted main agent configuration from agent builder",
        "including its configured fallback",
        "glasshive_host is a separate explicit workbench executor",
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
        "periphery_list",
        "periphery_read",
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


def test_create_description_makes_one_time_schedule_discriminator_explicit(tmp_path: Path) -> None:
    mcp = _build_test_server(tmp_path)
    description = str(_tools_by_name(mcp)["schedule_create"].description or "").lower()

    assert "schedule.type" in description
    assert "'once'" in description
    assert "run_at" in description
    assert "timezone" in description


def test_create_description_marks_glasshive_host_as_workbench_reserved(tmp_path: Path) -> None:
    mcp = _build_test_server(tmp_path)
    description = str(_tools_by_name(mcp)["schedule_create"].description or "").lower()

    assert "glasshive_host" in description
    assert "reserved" in description
    assert "workbench" in description


def test_create_rejects_unowned_glasshive_host_schedule_before_persisting(tmp_path: Path) -> None:
    mcp = _build_test_server(tmp_path)
    create = _tools_by_name(mcp)["schedule_create"]

    with pytest.raises(ValueError, match="reserved for Prompt Workbench"):
        create.fn(
            CreateScheduleArgs(
                user_id="user-1",
                agent_id="agent-1",
                created_by="agent:agent-1",
                prompt="ordinary request",
                schedule={"type": "daily", "time": "09:00", "timezone": "UTC"},
                executor="glasshive_host",
            )
        )


def test_update_can_pause_failed_past_one_time_schedule(tmp_path: Path) -> None:
    storage = ScheduleStorage(StorageConfig(db_path=str(tmp_path / "schedules.db")))
    storage.create_task(
        {
            "id": "past-once",
            "user_id": "user-1",
            "agent_id": "agent-1",
            "prompt": "past fixture",
            "schedule": {
                "type": "once",
                "run_at": "2020-01-01T00:00:00Z",
                "timezone": "UTC",
            },
            "channel": "telegram",
            "executor": "viventium_agent",
            "conversation_policy": "new",
            "conversation_id": None,
            "last_conversation_id": None,
            "active": 1,
            "created_by": "agent:agent-1",
            "created_source": "agent",
            "created_at": "2020-01-01T00:00:00Z",
            "updated_at": "2020-01-01T00:00:00Z",
            "updated_by": "agent:agent-1",
            "updated_source": "agent",
            "last_run_at": "2020-01-01T00:00:00Z",
            "next_run_at": "2020-01-01T00:00:00Z",
            "last_status": "error",
            "last_error": "completion_error",
            "metadata": {},
        }
    )
    update = _tools_by_name(build_server(storage))["schedule_update"]

    result = update.fn(
        UpdateScheduleArgs(
            user_id="user-1",
            task_id="past-once",
            active=False,
            updated_by="agent:agent-1",
        )
    )

    assert result["success"] is True
    assert result["task"]["active"] is False


def test_registry_source_shared_artifact_and_runtime_scheduler_envelope_are_equal() -> None:
    source = (
        ROOT.parents[1]
        / "source_of_truth"
        / "prompts"
        / "scheduler"
        / "run_envelope.md"
    )
    registry = ROOT.parents[1] / "source_of_truth" / "prompts" / "registry.yaml"
    source_text = source.read_text(encoding="utf-8")
    source_body = source_text.split("---", 2)[-1].strip()
    registry_text = registry.read_text(encoding="utf-8")
    context = "- scheduled_due_at_utc: 2026-08-10T12:00:00Z"

    assert "scheduler.run_envelope:" in registry_text
    assert "path: viventium_v0_4/shared/scheduler_prompt_contract.py" in registry_text
    assert "selector: SCHEDULER_RUN_ENVELOPE_TEMPLATE" in registry_text
    assert source_body == SCHEDULER_RUN_ENVELOPE_TEMPLATE
    assert dispatch.SCHEDULER_RUN_ENVELOPE_TEMPLATE is SCHEDULER_RUN_ENVELOPE_TEMPLATE
    assert dispatch.render_scheduler_run_envelope is render_scheduler_run_envelope
    assert dispatch._default_scheduler_run_envelope(context) == render_scheduler_run_envelope(context)


def test_registry_source_shared_artifact_and_runtime_continuity_id_are_equal() -> None:
    source = (
        ROOT.parents[1]
        / "source_of_truth"
        / "prompts"
        / "scheduler"
        / "consciousness_continuity_opportunity.md"
    )
    registry = ROOT.parents[1] / "source_of_truth" / "prompts" / "registry.yaml"
    source_text = source.read_text(encoding="utf-8")
    registry_text = registry.read_text(encoding="utf-8")

    assert "id: scheduler.consciousness_continuity_opportunity" in source_text
    assert "scheduler.consciousness_continuity_opportunity:" in registry_text
    assert "selector: CONSCIOUSNESS_CONTINUITY_OPPORTUNITY_PROMPT_ID" in registry_text
    assert SCHEDULER_RUN_ENVELOPE_PROMPT_ID == "scheduler.run_envelope"
    assert CONSCIOUSNESS_CONTINUITY_OPPORTUNITY_PROMPT_ID == (
        "scheduler.consciousness_continuity_opportunity"
    )
    assert dispatch.SCHEDULER_RUN_ENVELOPE_PROMPT_ID is SCHEDULER_RUN_ENVELOPE_PROMPT_ID
    assert dispatch.CONSCIOUSNESS_CONTINUITY_OPPORTUNITY_PROMPT_ID is (
        CONSCIOUSNESS_CONTINUITY_OPPORTUNITY_PROMPT_ID
    )


def test_full_detail_read_description_keeps_raw_fields_private(tmp_path: Path) -> None:
    mcp = _build_test_server(tmp_path)
    tools = _tools_by_name(mcp)

    description = str(tools["schedule_get"].description or "").lower()

    assert "private verification" in description
    assert "ordinary user-facing replies must translate" in description
    assert "avoid raw prompt text" in description
    assert "metadata keys" in description


def test_periphery_list_is_compact_and_hides_storage_details() -> None:
    raw = {
        "index": {
            "artifactCount": 9,
            "invalidArtifactCount": 1,
            "qualityCounts": {"passed": 2, "legacy": 7},
        },
        "artifacts": [
            {
                "artifactId": "artifact-current",
                "moduleId": "risk_radar",
                "generatedAt": "2026-07-11T07:00:00Z",
                "confidence": "medium",
                "severity": "high",
                "timeSensitivity": "high",
                "stale": False,
                "qualityStatus": "passed",
                "sourceRefCount": 3,
                "sourceRefsResolvedCount": 3,
                "sourceRefsUnresolvedCount": 0,
                "claimsGroundedCount": 7,
                "claimsUngroundedCount": 0,
                "relativePath": "risk_radar/2026/07/private.json",
                "scheduledRunRefHash": "private-run-hash",
            },
            {
                "artifactId": "artifact-history",
                "moduleId": "risk_radar",
                "generatedAt": "2026-06-11T07:00:00Z",
                "stale": True,
                "qualityStatus": "legacy",
                "relativePath": "risk_radar/2026/06/private.json",
            },
            {
                "artifactId": "artifact-current-older",
                "moduleId": "risk_radar",
                "generatedAt": "2026-07-10T07:00:00Z",
                "stale": False,
                "qualityStatus": "passed",
            },
            {
                "artifactId": "artifact-health-current",
                "moduleId": "health_pressure",
                "generatedAt": "2026-07-11T06:00:00Z",
                "stale": False,
                "qualityStatus": "passed",
            },
        ],
        "invalidArtifacts": [{"relativePath": "private-invalid.json", "reason": "invalid_json"}],
    }

    result = _serialize_periphery_list_for_agent(raw)
    encoded = json.dumps(result)

    assert result["currentInsights"][0]["insightRef"] == "artifact-current"
    assert result["currentInsights"][1]["insightRef"] == "artifact-health-current"
    assert len(result["currentInsights"]) == 2
    assert result["historicalInsights"][0]["insightRef"] == "artifact-history"
    assert result["totals"] == {
        "insights": 9,
        "invalid": 1,
        "quality": {"passed": 2, "legacy": 7},
    }
    assert "relativePath" not in encoded
    assert "scheduledRunRef" not in encoded
    assert "private-run-hash" not in encoded
    assert "private-invalid.json" not in encoded
    assert "artifact-current-older" not in encoded


def test_periphery_list_surfaces_private_artifact_access_blockers_without_paths() -> None:
    raw = {
        "index": {
            "status": "blocked",
            "blockedReasons": ["private_permissions_unavailable"],
            "artifactCount": 0,
            "invalidArtifactCount": 1,
            "qualityCounts": {},
        },
        "artifacts": [],
        "invalidArtifacts": [
            {
                "relativePath": "health_context/2026/08/private.json",
                "reason": "private_permissions_unavailable",
            }
        ],
    }

    result = _serialize_periphery_list_for_agent(raw)
    encoded = json.dumps(result)

    assert result["availability"] == {
        "status": "blocked",
        "reasons": ["private_permissions_unavailable"],
        "blockedCount": 1,
        "guidance": [
            "Private insight permissions could not be verified; check ownership and filesystem support."
        ],
    }
    assert "health_context/2026/08/private.json" not in encoded


def test_periphery_list_keeps_available_insights_when_one_private_artifact_is_withheld() -> None:
    raw = {
        "index": {
            "status": "degraded",
            "blockedReasons": ["unsafe_hard_link"],
            "blockedArtifactCount": 1,
            "artifactCount": 1,
            "invalidArtifactCount": 1,
            "qualityCounts": {"passed": 1},
        },
        "artifacts": [
            {
                "artifactId": "artifact-current",
                "moduleId": "health_context",
                "generatedAt": "2026-08-10T16:02:38Z",
                "qualityStatus": "passed",
                "stale": False,
            }
        ],
        "invalidArtifacts": [{"relativePath": "private.json", "reason": "unsafe_hard_link"}],
    }

    result = _serialize_periphery_list_for_agent(raw)
    encoded = json.dumps(result)

    assert result["availability"]["status"] == "degraded"
    assert result["availability"]["blockedCount"] == 1
    assert result["currentInsights"][0]["insightRef"] == "artifact-current"
    assert "restore it as a normal private file" in result["availability"]["guidance"][0]
    assert "private.json" not in encoded


def test_periphery_read_keeps_evidence_but_hides_internal_references() -> None:
    raw = {
        "artifact": {
            "artifactId": "artifact-current",
            "relativePath": "risk_radar/2026/07/private.json",
            "stale": False,
            "qualityStatus": "passed",
            "sourceRefCount": 2,
            "sourceRefsResolvedCount": 2,
            "sourceRefsUnresolvedCount": 0,
            "claimsGroundedCount": 2,
            "claimsUngroundedCount": 0,
            "qualityReasons": [],
            "snapshotRefHash": "private-snapshot-hash",
            "scheduledRunRefHash": "private-run-hash",
        },
        "sidecar": {
            "schemaVersion": 2,
            "moduleId": "risk_radar",
            "generatedAt": "2026-07-11T07:00:00Z",
            "snapshotRef": "snapshot:private",
            "scheduledRunRef": {"runId": "private-run-id"},
            "sourceRefs": ["message:private-one", "schedule:private-two"],
            "confidence": "medium",
            "severity": "high",
            "timeSensitivity": "high",
            "staleAfter": "2026-07-13T07:00:00Z",
            "observations": [
                {
                    "kind": "observation",
                    "text": "A recent action remains unverified.",
                    "sourceRefs": ["message:private-one"],
                }
            ],
            "risks": [
                {
                    "kind": "inference",
                    "text": "Delay may compound.",
                    "sourceRefs": ["message:private-one", "schedule:private-two"],
                }
            ],
            "blindSpots": [],
            "opportunityCosts": [],
            "opportunities": [],
            "whatWouldMakeThisWrong": [],
            "whenToSurface": [],
            "proposedActions": [],
            "memoryProposalRefs": [],
        },
        "markdown": "# Private duplicate body",
    }

    result = _serialize_periphery_read_for_agent(raw)
    encoded = json.dumps(result)

    assert result["insight"]["observations"] == [
        {
            "kind": "observation",
            "text": "A recent action remains unverified.",
            "evidenceCount": 1,
        }
    ]
    assert result["insight"]["risks"][0]["evidenceCount"] == 2
    assert result["insight"]["evidenceQuality"]["resolvedEvidence"] == 2
    assert result["insight"]["qualityReasons"] == []
    for forbidden in (
        "relativePath",
        "snapshotRef",
        "scheduledRunRef",
        "message:private-one",
        "schedule:private-two",
        "private-run-id",
        "Private duplicate body",
    ):
        assert forbidden not in encoded
