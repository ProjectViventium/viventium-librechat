from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import sys
import tempfile
import time
from pathlib import Path

_REQUIRED_ISOLATED_PATHS = (
    "HOME",
    "VIVENTIUM_RUNTIME_ROOT",
    "WPR_DB_PATH",
    "VIVENTIUM_ENV_FILE",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_CACHE_HOME",
    "CODEX_HOME",
    "CLAUDE_CONFIG_DIR",
    "GLASSHIVE_LINK_REF_STATE_PATH",
)
if os.environ.get("VIVENTIUM_DISABLE_DEFAULT_RUNTIME_ENV") != "1":
    raise SystemExit("default runtime env must be disabled before GlassHive import")
if any(not os.environ.get(name) for name in _REQUIRED_ISOLATED_PATHS):
    raise SystemExit("isolated GlassHive path environment is incomplete")

os.environ["WPR_RUNTIME_BACKEND"] = "stub"
os.environ["WPR_API_TOKEN"] = "synthetic-service-token"
os.environ["VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET"] = (
    "synthetic-assertion-secret"
)

from fastapi.testclient import TestClient

import workers_projects_runtime.service as service_module
from workers_projects_runtime.api import create_app
from workers_projects_runtime.openclaw_runtime import StubRuntime


API_TOKEN = "synthetic-service-token"
ASSERTION_SECRET = "synthetic-assertion-secret"


def _b64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _service_assertion() -> str:
    issued_at = int(time.time())
    claims = {
        "v": 1,
        "aud": "glasshive-account-api",
        "tenant_id": "tenant-a",
        "owner_id": "owner-a",
        "iat": issued_at,
        "exp": issued_at + 60,
        "nonce": "nonce_superseded_contract",
    }
    encoded = _b64url(
        json.dumps(claims, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )
    signature = _b64url(
        hmac.new(
            ASSERTION_SECRET.encode("utf-8"),
            encoded.encode("ascii"),
            hashlib.sha256,
        ).digest()
    )
    return f"{encoded}.{signature}"


def _headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {API_TOKEN}",
        "X-Viventium-Service-Assertion": _service_assertion(),
    }


def _terminal_generation(store, run_id: str) -> dict[str, str]:
    run = store.get_run(run_id)
    assert run is not None
    return {
        **(store.get_run_retry_generation(run_id) or {}),
        "expected_runtime_invoked_at": str(run.get("runtime_invoked_at") or ""),
    }


def produce(output_path: Path) -> None:
    os.environ["VIVENTIUM_DISABLE_DEFAULT_RUNTIME_ENV"] = "1"
    os.environ["WPR_API_TOKEN"] = API_TOKEN
    os.environ["VIVENTIUM_GLASSHIVE_SERVICE_ASSERTION_SECRET"] = ASSERTION_SECRET
    os.environ["WPR_HOST_MISSION_SLOTS_PER_CLI"] = "8"
    os.environ["WPR_HOST_ACCOUNT_ACTIVE_LIMIT"] = "8"
    service_module.shutil.disk_usage = lambda _path: service_module.shutil._ntuple_diskusage(
        100, 50, 50
    )
    service_module.host_resource_usage = lambda _leases: service_module.HostResourceUsage(
        child_processes=0,
        threads=0,
        available_memory_bytes=16 * 1024**3,
        available_disk_bytes=64 * 1024**3,
    )

    with tempfile.TemporaryDirectory(prefix="glasshive-superseded-contract-") as temp_dir:
        app = create_app(
            db_path=str(Path(temp_dir) / "producer.sqlite3"),
            runtime_backend="stub",
            runtime=StubRuntime(),
        )
        service = app.state.service
        service.executor.submit = lambda *_args, **_kwargs: None
        service.start_assigned_run = lambda _worker_id: None
        service._ensure_worker_processor = lambda _worker_id: None
        with TestClient(app) as client:
            accepted = client.post(
                "/v1/delegations",
                headers={**_headers(), "Idempotency-Key": "superseded-contract"},
                json={
                    "title": "Superseded producer contract",
                    "goal": "Emit the canonical superseded callback history",
                    "instruction": "Create one synthetic HTML artifact.",
                    "profile": "codex-cli",
                    "executionMode": "docker",
                    "workerName": "Synthetic contract worker",
                    "workerRole": "worker",
                    "originSurface": "telegram",
                    "bootstrapBundle": {
                        "callbacks": {
                            "origin_ref": "ghi_superseded_contract_0001",
                            "events_webhook_url": "https://callback.example.invalid/events",
                        }
                    },
                },
            ).json()
            store = service.store
            delegation = store.get_delegation(
                accepted["workRef"], tenant_id="tenant-a", owner_id="owner-a"
            )
            assert delegation is not None
            run_id = str(delegation["current_run_id"])
            worker = store.get_worker(str(delegation["worker_id"]))
            assert worker is not None

            claimed = store.claim_next_queued_run(str(worker["worker_id"]))
            lease = store.get_active_host_run_lease_for_run(run_id)
            assert claimed is not None and lease is not None
            admitted = store.admit_claimed_run(
                run_id,
                lease_id=str(lease["lease_id"]),
                executor_id=str(lease["executor_id"]),
            )
            preflight = store.record_provider_authorization_preflight(
                run_id,
                provider="openai",
                status="authorized",
                failure_class="",
            )
            invoked = store.mark_run_runtime_invoked(
                run_id,
                lease_id=str(lease["lease_id"]),
                executor_id=str(lease["executor_id"]),
            )
            assert admitted is not None and preflight is not None and invoked is not None

            workspace = Path(temp_dir) / "workspace"
            artifact = workspace / "artifacts" / "result.html"
            artifact.parent.mkdir(parents=True)
            artifact.write_text("<html><body>Result B</body></html>", encoding="utf-8")
            store.update_worker(str(worker["worker_id"]), workspace_dir=str(workspace))

            terminal_a = store.finalize_run_if_state(
                run_id,
                "running",
                "completed",
                output_text="FINAL REPORT:\nResult A",
                **_terminal_generation(store, run_id),
            )
            assert terminal_a is not None
            callback_a = service._emit_callback(
                worker,
                "run.completed",
                run=terminal_a,
                message="Result A",
                submit_delivery=False,
            )
            assert callback_a is not None

            terminal_b = store.update_run(
                run_id,
                output_text="FINAL REPORT:\nResult B",
            )
            assert terminal_b is not None
            assert store.claim_pending_callback(str(callback_a["callback_id"])) is None
            stale = store.get_callback_outbox(str(callback_a["callback_id"]))
            assert stale is not None and stale["status"] == "superseded"

            assert service._reconcile_terminal_callback_intents() == 1
            callbacks = store.list_callback_outbox_for_run(
                run_id,
                tenant_id="tenant-a",
                owner_id="owner-a",
                limit=100,
            )
            callback_b = next(
                item
                for item in callbacks
                if item["event_type"] == "run.completed"
                and item["status"] == "pending"
            )
            claimed_b = store.claim_pending_callback(str(callback_b["callback_id"]))
            assert claimed_b is not None
            accepted_b = store.mark_callback_http_accepted(
                str(callback_b["callback_id"]),
                lease_token=str(claimed_b["delivery_lease_token"]),
                delivery_generation=int(claimed_b["delivery_generation"]),
                attempts=1,
                payload_json=str(claimed_b["payload_json"]),
            )
            assert accepted_b is not None and accepted_b["status"] == "http_accepted"

            response = client.get(
                f"/v1/work/{accepted['workRef']}",
                headers=_headers(),
            )
            assert response.status_code == 200
            detail = response.json()
            assert [item["status"] for item in detail["callbackDeliveries"]] == [
                "pending",
                "pending",
                "superseded",
                "pending",
                "delivering",
                "http_accepted",
            ]
            output_path.write_text(
                json.dumps(
                    {
                        "workRef": accepted["workRef"],
                        "runRef": run_id,
                        "detail": detail,
                    },
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                encoding="utf-8",
            )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: glass_hive_superseded_producer.py OUTPUT_PATH")
    produce(Path(sys.argv[1]))
