import hashlib
import json
import os
import sys
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest


ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex import workbench_artifacts
from scheduling_cortex.workbench_artifacts import ingest_isolated_periphery_pair


HEALTH_TEMPLATE = "workbench_daily_health_context_v1"


def _synthetic_pair(run_id: str) -> tuple[str, bytes, str, bytes]:
    stem = "20260818T203000Z.health_context"
    json_path = f"artifacts/periphery/health_context/2026/08/{stem}.json"
    md_path = f"artifacts/periphery/health_context/2026/08/{stem}.md"
    sidecar = {
        "schemaVersion": 2,
        "moduleId": "health_context",
        "generatedAt": "2026-08-18T20:30:00Z",
        "snapshotRef": "snapshot:20260818T200000Z-aaaaaaaaaaaa",
        "scheduledRunRef": {"runId": run_id},
        "sourceRefs": [],
        "confidence": "low",
        "severity": "low",
        "timeSensitivity": "daily",
        "ttl": "P1D",
        "staleAfter": "2026-08-19T20:30:00Z",
        "observations": [],
        "risks": [],
        "blindSpots": [],
        "opportunityCosts": [],
        "opportunities": [],
        "whatWouldMakeThisWrong": [],
        "whenToSurface": [],
        "proposedActions": [],
        "memoryProposalRefs": [],
    }
    return json_path, json.dumps(sidecar).encode("utf-8"), md_path, b"# Health context\n"


def test_imports_only_the_complete_pair_for_the_current_run(tmp_path):
    run_id = "scheduled-run-current"
    json_path, json_bytes, md_path, md_bytes = _synthetic_pair(run_id)
    files = {json_path: json_bytes, md_path: md_bytes}

    def get_json(_url, _headers, _timeout):
        return {
            "items": [
                {"path": "../../outside.json", "is_dir": False},
                {"path": json_path, "is_dir": False},
                {"path": md_path, "is_dir": False},
            ]
        }

    def get_bytes(url, _headers, _timeout, _max_bytes):
        return files[parse_qs(urlsplit(url).query)["path"][0]]

    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id=run_id,
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={"Authorization": "Bearer synthetic"},
        get_json=get_json,
        get_bytes=get_bytes,
    )

    target = tmp_path / "periphery" / "health_context" / "2026" / "08"
    assert result == {
        "required": True,
        "ok": True,
        "reason": "isolated_artifact_pair_imported",
        "imported": [
            "periphery/health_context/2026/08/20260818T203000Z.health_context.json",
            "periphery/health_context/2026/08/20260818T203000Z.health_context.md",
        ],
    }
    assert (target / "20260818T203000Z.health_context.json").read_bytes() == json_bytes
    assert (target / "20260818T203000Z.health_context.md").read_bytes() == md_bytes
    assert not (tmp_path.parent / "outside.json").exists()


def test_normalizes_redundant_snapshot_reference_when_claims_keep_valid_evidence(tmp_path):
    run_id = "scheduled-run-current"
    json_path, json_bytes, md_path, md_bytes = _synthetic_pair(run_id)
    sidecar = json.loads(json_bytes.decode("utf-8"))
    valid_refs = [f"health:{'a' * 24}", f"health:{'b' * 24}"]
    invalid_ref = sidecar["snapshotRef"]
    sidecar["sourceRefs"] = [valid_refs[0], invalid_ref, valid_refs[1]]
    claim_fields = (
        "observations",
        "risks",
        "blindSpots",
        "whatWouldMakeThisWrong",
        "whenToSurface",
    )
    for field in claim_fields:
        sidecar[field] = [
            {
                "kind": "observation",
                "text": f"Synthetic {field} claim.",
                "sourceRefs": [valid_refs[0], invalid_ref],
            }
        ]
    source_bytes = json.dumps(sidecar).encode("utf-8")
    files = {json_path: source_bytes, md_path: md_bytes}

    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id=run_id,
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: {"items": [{"path": json_path}, {"path": md_path}]},
        get_bytes=lambda url, *_args: files[parse_qs(urlsplit(url).query)["path"][0]],
    )

    target = (
        tmp_path
        / "periphery"
        / "health_context"
        / "2026"
        / "08"
        / "20260818T203000Z.health_context.json"
    )
    imported_bytes = target.read_bytes()
    imported = json.loads(imported_bytes.decode("utf-8"))
    assert result["reason"] == "isolated_artifact_pair_normalized_and_imported"
    assert result["normalization"] == {
        "applied": True,
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
        "importedSha256": hashlib.sha256(imported_bytes).hexdigest(),
        "removedTopLevelSourceRefCount": 1,
        "removedNestedSourceRefCount": len(claim_fields),
        "reasonCodes": ["invalid_source_ref_format"],
    }
    assert invalid_ref not in result["normalization"].values()
    assert imported["sourceRefs"] == valid_refs
    for field in claim_fields:
        assert imported[field][0]["sourceRefs"] == [valid_refs[0]]
    assert (
        tmp_path
        / "periphery"
        / "health_context"
        / "2026"
        / "08"
        / "20260818T203000Z.health_context.md"
    ).read_bytes() == md_bytes


def test_normalizes_nested_reference_outside_top_level_when_valid_evidence_remains(tmp_path):
    run_id = "scheduled-run-current"
    json_path, json_bytes, md_path, md_bytes = _synthetic_pair(run_id)
    sidecar = json.loads(json_bytes.decode("utf-8"))
    valid_ref = f"health:{'a' * 24}"
    undeclared_ref = f"health:{'b' * 24}"
    sidecar["sourceRefs"] = [valid_ref]
    sidecar["observations"] = [
        {
            "kind": "observation",
            "text": "Synthetic grounded claim.",
            "sourceRefs": [valid_ref, undeclared_ref],
        }
    ]
    source_bytes = json.dumps(sidecar).encode("utf-8")
    files = {json_path: source_bytes, md_path: md_bytes}

    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id=run_id,
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: {"items": [{"path": json_path}, {"path": md_path}]},
        get_bytes=lambda url, *_args: files[parse_qs(urlsplit(url).query)["path"][0]],
    )

    target = (
        tmp_path
        / "periphery"
        / "health_context"
        / "2026"
        / "08"
        / "20260818T203000Z.health_context.json"
    )
    imported = json.loads(target.read_text(encoding="utf-8"))
    assert result["reason"] == "isolated_artifact_pair_normalized_and_imported"
    assert result["normalization"]["removedTopLevelSourceRefCount"] == 0
    assert result["normalization"]["removedNestedSourceRefCount"] == 1
    assert result["normalization"]["reasonCodes"] == [
        "nested_source_ref_not_top_level"
    ]
    assert imported["observations"][0]["sourceRefs"] == [valid_ref]


def test_rejects_normalization_that_would_leave_a_claim_without_evidence(tmp_path):
    run_id = "scheduled-run-current"
    json_path, json_bytes, md_path, md_bytes = _synthetic_pair(run_id)
    sidecar = json.loads(json_bytes.decode("utf-8"))
    invalid_ref = sidecar["snapshotRef"]
    sidecar["sourceRefs"] = [invalid_ref]
    sidecar["observations"] = [
        {
            "kind": "observation",
            "text": "Synthetic unsupported claim.",
            "sourceRefs": [invalid_ref],
        }
    ]
    files = {json_path: json.dumps(sidecar).encode("utf-8"), md_path: md_bytes}

    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id=run_id,
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: {"items": [{"path": json_path}, {"path": md_path}]},
        get_bytes=lambda url, *_args: files[parse_qs(urlsplit(url).query)["path"][0]],
    )

    assert result["ok"] is False
    assert result["reason"] == "isolated_artifact_pair_missing"
    assert list(tmp_path.rglob("*")) == []


def test_rejects_a_stale_pair_from_another_scheduled_run(tmp_path):
    json_path, json_bytes, md_path, md_bytes = _synthetic_pair("older-run")
    files = {json_path: json_bytes, md_path: md_bytes}

    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id="current-run",
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: {
            "items": [{"path": json_path}, {"path": md_path}]
        },
        get_bytes=lambda url, *_args: files[parse_qs(urlsplit(url).query)["path"][0]],
    )

    assert result["required"] is True
    assert result["ok"] is False
    assert result["reason"] == "isolated_artifact_pair_missing"
    assert list(tmp_path.rglob("*")) == []


def test_rejects_malformed_sidecar_without_writing_a_pair(tmp_path):
    json_path, _json_bytes, md_path, md_bytes = _synthetic_pair("current-run")
    files = {json_path: b"{not-json", md_path: md_bytes}

    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id="current-run",
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: {
            "items": [{"path": json_path}, {"path": md_path}]
        },
        get_bytes=lambda url, *_args: files[
            parse_qs(urlsplit(url).query)["path"][0]
        ],
    )

    assert result["ok"] is False
    assert result["reason"] == "isolated_artifact_pair_missing"
    assert list(tmp_path.rglob("*")) == []


def test_rejects_schema_v2_sidecar_missing_workbench_required_fields(tmp_path):
    json_path, _json_bytes, md_path, md_bytes = _synthetic_pair("current-run")
    minimal = {
        "schemaVersion": 2,
        "moduleId": "health_context",
        "scheduledRunRef": {"runId": "current-run"},
    }
    files = {json_path: json.dumps(minimal).encode("utf-8"), md_path: md_bytes}

    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id="current-run",
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: {"items": [{"path": json_path}, {"path": md_path}]},
        get_bytes=lambda url, *_args: files[parse_qs(urlsplit(url).query)["path"][0]],
    )

    assert result["ok"] is False
    assert result["reason"] == "isolated_artifact_pair_missing"
    assert list(tmp_path.rglob("*")) == []


def test_import_validation_does_not_invent_a_ttl_format_beyond_workbench(tmp_path):
    _json_path, json_bytes, _md_path, _md_bytes = _synthetic_pair("current-run")
    sidecar = json.loads(json_bytes.decode("utf-8"))
    sidecar["ttl"] = "P1W"

    assert workbench_artifacts._valid_periphery_sidecar(
        sidecar,
        module_id="health_context",
        run_id="current-run",
    )


def test_custom_workbench_prompt_does_not_gain_a_host_write_contract(tmp_path):
    result = ingest_isolated_periphery_pair(
        template_id="custom-user-prompt",
        run_id="current-run",
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: (_ for _ in ()).throw(AssertionError("must not fetch")),
        get_bytes=lambda *_args: (_ for _ in ()).throw(AssertionError("must not fetch")),
    )

    assert result == {
        "required": False,
        "ok": True,
        "reason": "isolated_artifact_import_not_required",
        "imported": [],
    }


def test_symlinked_destination_parent_is_rejected(tmp_path):
    run_id = "scheduled-run-current"
    json_path, json_bytes, md_path, md_bytes = _synthetic_pair(run_id)
    files = {json_path: json_bytes, md_path: md_bytes}
    outside = tmp_path.parent / f"{tmp_path.name}-outside"
    outside.mkdir()
    (tmp_path / "periphery").mkdir()
    os.symlink(outside, tmp_path / "periphery" / "health_context")

    with pytest.raises(ValueError, match="symbolic link"):
        ingest_isolated_periphery_pair(
            template_id=HEALTH_TEMPLATE,
            run_id=run_id,
            worker_id="worker-1",
            my_folder=str(tmp_path),
            glasshive_base_url="http://127.0.0.1:8766",
            headers={},
            get_json=lambda *_args: {
                "items": [{"path": json_path}, {"path": md_path}]
            },
            get_bytes=lambda url, *_args: files[
                parse_qs(urlsplit(url).query)["path"][0]
            ],
        )

    assert list(outside.iterdir()) == []


def test_pair_commit_writes_markdown_before_json_discovery_anchor(tmp_path, monkeypatch):
    run_id = "scheduled-run-current"
    json_path, json_bytes, md_path, md_bytes = _synthetic_pair(run_id)
    files = {json_path: json_bytes, md_path: md_bytes}
    writes = []
    real_atomic_write = workbench_artifacts._atomic_write

    def fail_json(path, payload, *, private_root):
        writes.append(path.suffix)
        if path.suffix == ".json":
            raise OSError("synthetic JSON commit failure")
        real_atomic_write(path, payload, private_root=private_root)

    monkeypatch.setattr(workbench_artifacts, "_atomic_write", fail_json)
    with pytest.raises(OSError, match="synthetic JSON commit failure"):
        ingest_isolated_periphery_pair(
            template_id=HEALTH_TEMPLATE,
            run_id=run_id,
            worker_id="worker-1",
            my_folder=str(tmp_path),
            glasshive_base_url="http://127.0.0.1:8766",
            headers={},
            get_json=lambda *_args: {
                "items": [{"path": json_path}, {"path": md_path}]
            },
            get_bytes=lambda url, *_args: files[
                parse_qs(urlsplit(url).query)["path"][0]
            ],
        )

    assert writes == [".md", ".json"]
    target = tmp_path / "periphery" / "health_context" / "2026" / "08"
    assert (target / "20260818T203000Z.health_context.md").exists()
    assert not (target / "20260818T203000Z.health_context.json").exists()


def test_existing_hard_link_is_replaced_without_mutating_its_other_name(tmp_path):
    run_id = "scheduled-run-current"
    json_path, json_bytes, md_path, md_bytes = _synthetic_pair(run_id)
    files = {json_path: json_bytes, md_path: md_bytes}
    target_dir = tmp_path / "periphery" / "health_context" / "2026" / "08"
    target_dir.mkdir(parents=True)
    outside = tmp_path.parent / f"{tmp_path.name}-hard-link-source"
    outside.write_bytes(b"outside sentinel")
    json_target = target_dir / "20260818T203000Z.health_context.json"
    os.link(outside, json_target)

    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id=run_id,
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: {
            "items": [{"path": json_path}, {"path": md_path}]
        },
        get_bytes=lambda url, *_args: files[
            parse_qs(urlsplit(url).query)["path"][0]
        ],
    )

    assert result["ok"] is True
    assert outside.read_bytes() == b"outside sentinel"
    assert json_target.read_bytes() == json_bytes
    assert outside.stat().st_ino != json_target.stat().st_ino


def test_import_hardens_every_destination_directory_to_owner_only(tmp_path):
    run_id = "scheduled-run-current"
    json_path, json_bytes, md_path, md_bytes = _synthetic_pair(run_id)
    files = {json_path: json_bytes, md_path: md_bytes}

    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id=run_id,
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: {"items": [{"path": json_path}, {"path": md_path}]},
        get_bytes=lambda url, *_args: files[parse_qs(urlsplit(url).query)["path"][0]],
    )

    assert result["ok"] is True
    current = tmp_path
    for part in ("periphery", "health_context", "2026", "08"):
        current = current / part
        assert current.stat().st_mode & 0o777 == 0o700


def test_missing_pair_reports_truncated_listing_distinctly(tmp_path):
    result = ingest_isolated_periphery_pair(
        template_id=HEALTH_TEMPLATE,
        run_id="current-run",
        worker_id="worker-1",
        my_folder=str(tmp_path),
        glasshive_base_url="http://127.0.0.1:8766",
        headers={},
        get_json=lambda *_args: {
            "truncated": True,
            "items": [
                {"path": f"reports/synthetic-{index:03d}.txt"}
                for index in range(494)
            ]
        },
        get_bytes=lambda *_args: (_ for _ in ()).throw(AssertionError("must not fetch")),
    )

    assert result["ok"] is False
    assert result["reason"] == "isolated_artifact_listing_truncated"


def test_http_download_enforces_maximum_bytes(monkeypatch):
    class OversizedResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, size):
            assert size == workbench_artifacts.MAX_ARTIFACT_BYTES + 1
            return b"x" * size

    monkeypatch.setattr(
        workbench_artifacts.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: OversizedResponse(),
    )
    with pytest.raises(ValueError, match="exceeds the import limit"):
        workbench_artifacts._get_bytes(
            "http://127.0.0.1:8766/synthetic",
            {},
            1,
            workbench_artifacts.MAX_ARTIFACT_BYTES,
        )
