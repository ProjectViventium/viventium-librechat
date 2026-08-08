# === VIVENTIUM START ===
# Purpose: Mint short-lived, request-bound assertions for delegated GlassHive occurrences.
# === VIVENTIUM END ===

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

ASSERTION_HEADER = "X-Viventium-Scheduler-Assertion"
ASSERTION_ISSUER = "viventium:scheduling-cortex"
ASSERTION_AUDIENCE = "glasshive:workspace-run"
ASSERTION_SCOPE = "workspace:run"
ASSERTION_MAX_TTL_SECONDS = 120


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _workspace_subject(request_payload: dict[str, Any]) -> dict[str, str]:
    instruction = str(request_payload.get("instruction") or "")
    bootstrap_bundle = request_payload.get("bootstrap_bundle")
    canonical_bundle = json.dumps(
        bootstrap_bundle if isinstance(bootstrap_bundle, dict) else {},
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return {
        "occurrence_id": str(request_payload.get("occurrence_id") or ""),
        "task_id": str(request_payload.get("task_id") or ""),
        "tenant_id": str(request_payload.get("tenant_id") or ""),
        "owner_id": str(request_payload.get("owner_id") or ""),
        "project_id": str(request_payload.get("project_id") or ""),
        "worker_id": str(request_payload.get("worker_id") or ""),
        "execution_mode": str(request_payload.get("execution_mode") or ""),
        "instruction_sha256": hashlib.sha256(instruction.encode("utf-8")).hexdigest(),
        "bootstrap_bundle_sha256": hashlib.sha256(canonical_bundle.encode("utf-8")).hexdigest(),
    }


def mint_workspace_run_assertion(
    *,
    secret: str,
    request_payload: dict[str, Any],
    issued_at: int | None = None,
    ttl_seconds: int = 90,
) -> str:
    normalized_secret = str(secret or "").strip()
    if not normalized_secret:
        raise RuntimeError("VIVENTIUM_SCHEDULER_SECRET is required for workspace recurrence")
    issued = int(time.time()) if issued_at is None else int(issued_at)
    ttl = max(30, min(int(ttl_seconds), ASSERTION_MAX_TTL_SECONDS))
    claims: dict[str, Any] = {
        "v": 1,
        "iss": ASSERTION_ISSUER,
        "aud": ASSERTION_AUDIENCE,
        "scope": ASSERTION_SCOPE,
        "iat": issued,
        "exp": issued + ttl,
        "jti": secrets.token_urlsafe(18),
        **_workspace_subject(request_payload),
    }
    encoded_claims = _base64url_encode(
        json.dumps(claims, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    )
    signature = hmac.new(
        normalized_secret.encode("utf-8"),
        encoded_claims.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return f"{encoded_claims}.{_base64url_encode(signature)}"
