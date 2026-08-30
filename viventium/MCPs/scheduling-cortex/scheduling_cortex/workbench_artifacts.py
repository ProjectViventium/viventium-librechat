from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict


PERIPHERY_TEMPLATE_MODULES = {
    "workbench_nightly_subconscious_thought_formation_v1": "risk_radar",
    "workbench_daily_health_context_v1": "health_context",
}
MAX_ARTIFACT_BYTES = 2 * 1024 * 1024
MAX_JSON_CANDIDATES = 20
ISOLATED_ARTIFACT_ROOT = "artifacts"
PERIPHERY_WORKSPACE_ROOT = f"{ISOLATED_ARTIFACT_ROOT}/periphery"
PERIPHERY_REQUIRED_FIELDS = (
    "schemaVersion",
    "moduleId",
    "generatedAt",
    "snapshotRef",
    "scheduledRunRef",
    "sourceRefs",
    "confidence",
    "severity",
    "timeSensitivity",
    "ttl",
    "staleAfter",
    "observations",
    "risks",
    "blindSpots",
    "opportunityCosts",
    "opportunities",
    "whatWouldMakeThisWrong",
    "whenToSurface",
    "proposedActions",
    "memoryProposalRefs",
)
PERIPHERY_CONTENT_FIELDS = (
    "observations",
    "risks",
    "blindSpots",
    "opportunityCosts",
    "opportunities",
    "whatWouldMakeThisWrong",
    "whenToSurface",
    "proposedActions",
    "memoryProposalRefs",
)
PERIPHERY_CLAIM_FIELDS = (
    "observations",
    "risks",
    "blindSpots",
    "opportunityCosts",
    "opportunities",
    "whatWouldMakeThisWrong",
    "whenToSurface",
    "proposedActions",
)
PERIPHERY_SOURCE_REF_RE = re.compile(r"[a-z][a-z0-9_-]{1,31}:[a-f0-9]{24}")


def isolated_periphery_contract(template_id: Any) -> Dict[str, Any] | None:
    module_id = PERIPHERY_TEMPLATE_MODULES.get(str(template_id or "").strip())
    if not module_id:
        return None
    return {
        "kind": "periphery_pair",
        "module_id": module_id,
        "workspace_root": PERIPHERY_WORKSPACE_ROOT,
    }


def rebase_isolated_workbench_text(text: Any, my_folder: Any) -> str:
    rendered = str(text or "")
    declared_root = str(my_folder or "").strip()
    if not declared_root:
        return rendered
    return rendered.replace(declared_root, ISOLATED_ARTIFACT_ROOT)


def _get_json(url: str, headers: Dict[str, str], timeout_s: int) -> Dict[str, Any]:
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        payload = json.loads(response.read().decode("utf-8"))
    return payload if isinstance(payload, dict) else {}


def _get_bytes(
    url: str,
    headers: Dict[str, str],
    timeout_s: int,
    max_bytes: int,
) -> bytes:
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        payload = response.read(max_bytes + 1)
    if len(payload) > max_bytes:
        raise ValueError("isolated artifact exceeds the import limit")
    return payload


def _safe_target(root: Path, relative_path: Path) -> Path:
    resolved_root = root.resolve()
    target = root / relative_path
    current = root
    if root.is_symlink():
        raise ValueError("private artifact root may not be a symbolic link")
    for part in relative_path.parts[:-1]:
        current = current / part
        if current.exists() and current.is_symlink():
            raise ValueError("private artifact directory may not be a symbolic link")
    resolved_target = target.resolve(strict=False)
    try:
        resolved_target.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError("private artifact target escaped its root") from exc
    return target


def _ensure_private_directory_chain(root: Path, parent: Path) -> None:
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(root, 0o700)
    relative = parent.relative_to(root)
    current = root
    for part in relative.parts:
        current = current / part
        current.mkdir(exist_ok=True, mode=0o700)
        if current.is_symlink():
            raise ValueError("private artifact directory may not be a symbolic link")
        os.chmod(current, 0o700)


def _atomic_write(path: Path, payload: bytes, *, private_root: Path) -> None:
    _ensure_private_directory_chain(private_root, path.parent)
    handle = tempfile.NamedTemporaryFile(
        mode="wb",
        prefix=f".{path.name}.",
        dir=str(path.parent),
        delete=False,
    )
    temporary = Path(handle.name)
    try:
        with handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _parse_utc_datetime(value: Any) -> datetime | None:
    try:
        parsed = datetime.fromisoformat(str(value or "").replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(timezone.utc)


def _valid_periphery_sidecar(
    sidecar: Any, *, module_id: str, run_id: str
) -> bool:
    """Match the Workbench's schema-v2 readability gate before committing an import."""

    if not isinstance(sidecar, dict):
        return False
    if any(field not in sidecar for field in PERIPHERY_REQUIRED_FIELDS):
        return False
    if sidecar.get("schemaVersion") != 2 or sidecar.get("moduleId") != module_id:
        return False
    generated_at = _parse_utc_datetime(sidecar.get("generatedAt"))
    stale_after = _parse_utc_datetime(sidecar.get("staleAfter"))
    if not generated_at or not stale_after or stale_after <= generated_at:
        return False
    if generated_at > datetime.now(timezone.utc):
        return False
    scheduled_ref = sidecar.get("scheduledRunRef")
    if not isinstance(scheduled_ref, dict) or str(scheduled_ref.get("runId") or "") != run_id:
        return False
    if not re.fullmatch(
        r"snapshot:[0-9TZ]+-[a-f0-9]{12}", str(sidecar.get("snapshotRef") or "")
    ):
        return False
    source_refs = sidecar.get("sourceRefs")
    if not isinstance(source_refs, list) or any(
        not isinstance(ref, str)
        or not PERIPHERY_SOURCE_REF_RE.fullmatch(ref)
        for ref in source_refs
    ):
        return False
    if any(not isinstance(sidecar.get(field), list) for field in PERIPHERY_CONTENT_FIELDS):
        return False
    return True


def _normalize_periphery_source_refs(sidecar: Any) -> Dict[str, Any] | None:
    if not isinstance(sidecar, dict):
        return None
    source_refs = sidecar.get("sourceRefs")
    if not isinstance(source_refs, list):
        return None

    reasons: set[str] = set()
    normalized_top: list[str] = []
    removed_top = 0
    for ref in source_refs:
        if isinstance(ref, str) and PERIPHERY_SOURCE_REF_RE.fullmatch(ref):
            normalized_top.append(ref)
            continue
        removed_top += 1
        reasons.add("invalid_source_ref_format")

    top_level_refs = set(normalized_top)
    removed_nested = 0
    for field in PERIPHERY_CLAIM_FIELDS:
        claims = sidecar.get(field)
        if not isinstance(claims, list):
            continue
        for claim in claims:
            if field == "whenToSurface" and isinstance(claim, str):
                continue
            if not isinstance(claim, dict):
                continue
            claim_refs = claim.get("sourceRefs")
            if not isinstance(claim_refs, list):
                continue
            normalized_claim_refs: list[str] = []
            for ref in claim_refs:
                if isinstance(ref, str) and ref in top_level_refs:
                    normalized_claim_refs.append(ref)
                    continue
                removed_nested += 1
                reasons.add(
                    "invalid_source_ref_format"
                    if not isinstance(ref, str)
                    or not PERIPHERY_SOURCE_REF_RE.fullmatch(ref)
                    else "nested_source_ref_not_top_level"
                )
            if len(normalized_claim_refs) == len(claim_refs):
                continue
            kind = str(claim.get("kind") or "").strip().lower()
            if not normalized_claim_refs and kind not in {
                "no_result",
                "missing_prerequisite",
            }:
                return None
            claim["sourceRefs"] = normalized_claim_refs

    sidecar["sourceRefs"] = normalized_top
    return {
        "applied": bool(removed_top or removed_nested),
        "removedTopLevelSourceRefCount": removed_top,
        "removedNestedSourceRefCount": removed_nested,
        "reasonCodes": sorted(reasons),
    }


def ingest_isolated_periphery_pair(
    *,
    template_id: Any,
    run_id: str,
    worker_id: str,
    my_folder: str,
    glasshive_base_url: str,
    headers: Dict[str, str],
    get_json: Callable[[str, Dict[str, str], int], Dict[str, Any]] = _get_json,
    get_bytes: Callable[[str, Dict[str, str], int, int], bytes] = _get_bytes,
    timeout_s: int = 20,
) -> Dict[str, Any]:
    contract = isolated_periphery_contract(template_id)
    if not contract:
        return {
            "required": False,
            "ok": True,
            "reason": "isolated_artifact_import_not_required",
            "imported": [],
        }
    if not run_id or not worker_id or not my_folder:
        return {
            "required": True,
            "ok": False,
            "reason": "isolated_artifact_import_context_missing",
            "imported": [],
        }

    module_id = str(contract["module_id"])
    escaped_module = re.escape(module_id)
    escaped_root = re.escape(PERIPHERY_WORKSPACE_ROOT)
    path_pattern = re.compile(
        rf"^{escaped_root}/{escaped_module}/(\d{{4}})/(\d{{2}})/"
        rf"(\d{{8}}T\d{{6}}Z\.{escaped_module})\.(json|md)$"
    )
    base_url = glasshive_base_url.rstrip("/")
    encoded_worker = urllib.parse.quote(worker_id, safe="")
    listing = get_json(
        f"{base_url}/v1/workers/{encoded_worker}/artifacts",
        headers,
        timeout_s,
    )
    raw_items = listing.get("items") if isinstance(listing.get("items"), list) else []
    paths: Dict[str, str] = {}
    for item in raw_items:
        if not isinstance(item, dict) or item.get("is_dir") is True:
            continue
        workspace_path = str(item.get("path") or "").strip()
        match = path_pattern.fullmatch(workspace_path)
        if match:
            pair_key = f"{match.group(1)}/{match.group(2)}/{match.group(3)}"
            paths[f"{pair_key}.{match.group(4)}"] = workspace_path

    json_candidates = sorted(
        (key for key in paths if key.endswith(".json")), reverse=True
    )[:MAX_JSON_CANDIDATES]
    selected: tuple[re.Match[str], bytes, bytes, Dict[str, Any] | None] | None = None
    for json_key in json_candidates:
        json_path = paths[json_key]
        match = path_pattern.fullmatch(json_path)
        if not match:
            continue
        pair_key = f"{match.group(1)}/{match.group(2)}/{match.group(3)}"
        md_path = paths.get(f"{pair_key}.md")
        if not md_path:
            continue
        query = urllib.parse.urlencode({"path": json_path})
        json_bytes = get_bytes(
            f"{base_url}/v1/workers/{encoded_worker}/artifacts/download?{query}",
            headers,
            timeout_s,
            MAX_ARTIFACT_BYTES,
        )
        try:
            sidecar = json.loads(json_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        normalization = _normalize_periphery_source_refs(sidecar)
        if normalization is None:
            continue
        if normalization["applied"]:
            source_sha256 = hashlib.sha256(json_bytes).hexdigest()
            json_bytes = (
                json.dumps(sidecar, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8")
                + b"\n"
            )
            normalization = {
                "applied": True,
                "sourceSha256": source_sha256,
                "importedSha256": hashlib.sha256(json_bytes).hexdigest(),
                "removedTopLevelSourceRefCount": normalization[
                    "removedTopLevelSourceRefCount"
                ],
                "removedNestedSourceRefCount": normalization[
                    "removedNestedSourceRefCount"
                ],
                "reasonCodes": normalization["reasonCodes"],
            }
        else:
            normalization = None
        if not _valid_periphery_sidecar(
            sidecar, module_id=module_id, run_id=run_id
        ):
            continue
        md_query = urllib.parse.urlencode({"path": md_path})
        md_bytes = get_bytes(
            f"{base_url}/v1/workers/{encoded_worker}/artifacts/download?{md_query}",
            headers,
            timeout_s,
            MAX_ARTIFACT_BYTES,
        )
        if not md_bytes.strip():
            continue
        selected = (match, json_bytes, md_bytes, normalization)
        break

    if not selected:
        return {
            "required": True,
            "ok": False,
            "reason": (
                "isolated_artifact_listing_truncated"
                if listing.get("truncated") is True or len(raw_items) >= 500
                else "isolated_artifact_pair_missing"
            ),
            "imported": [],
        }

    match, json_bytes, md_bytes, normalization = selected
    relative_dir = Path("periphery") / module_id / match.group(1) / match.group(2)
    json_relative = relative_dir / f"{match.group(3)}.json"
    md_relative = relative_dir / f"{match.group(3)}.md"
    root = Path(my_folder).expanduser()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    json_target = _safe_target(root, json_relative)
    md_target = _safe_target(root, md_relative)
    # Markdown is not a discovery anchor. Commit it first so a later JSON write failure can leave
    # only an ignored orphan instead of a visible sidecar without its required pair.
    _atomic_write(md_target, md_bytes, private_root=root)
    _atomic_write(json_target, json_bytes, private_root=root)
    result = {
        "required": True,
        "ok": True,
        "reason": (
            "isolated_artifact_pair_normalized_and_imported"
            if normalization
            else "isolated_artifact_pair_imported"
        ),
        "imported": [json_relative.as_posix(), md_relative.as_posix()],
    }
    if normalization:
        result["normalization"] = normalization
    return result
