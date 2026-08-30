# VIVENTIUM START
# Purpose: Prove receiver-owned monotonic terminal callback acceptance and effect fencing.
# Porting: Copy this file with the scheduling-cortex terminal receiver ledger.
# VIVENTIUM END

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex.server import build_server
from scheduling_cortex.storage import ScheduleStorage, StorageConfig

try:
    from starlette.testclient import TestClient
except ImportError:
    TestClient = None


def terminal_payload(
    *, revision: int, digest_character: str, event: str = "run.completed"
) -> dict[str, object]:
    state = "cancelled" if event in {"run.cancelled", "run.interrupted"} else event[4:]
    result_digest = "sha256:" + digest_character * 64
    ended_at = "2026-08-23T20:00:00+00:00"
    run_id = "glasshive-run-1"
    material = ":".join((run_id, state, ended_at, "0", str(revision), result_digest))
    return {
        "callback_id": "cb_terminal_" + hashlib.sha256(material.encode()).hexdigest(),
        "callback_ts": 1787515200,
        "event": event,
        "message": f"Canonical terminal result {revision}.",
        "message_id": "scheduled-run-1",
        "result_digest": result_digest,
        "result_ended_at": ended_at,
        "result_revision": revision,
        "result_state": state,
        "run_id": run_id,
        "user_id": "owner-a",
        "worker_id": "worker-1",
    }


class TerminalCallbackReceiverCASTests(TestCase):
    def make_storage(self, directory: str) -> ScheduleStorage:
        return ScheduleStorage(
            StorageConfig(db_path=str(Path(directory) / "schedules.db"))
        )

    def make_run(
        self, storage: ScheduleStorage, *, detail_path: Path | None = None
    ) -> None:
        now = "2026-08-23T19:59:00+00:00"
        storage.create_task(
            {
                "id": "task-1",
                "user_id": "owner-a",
                "agent_id": "agent-1",
                "prompt": "Synthetic scheduled task.",
                "schedule": {"type": "daily", "time": "20:00", "timezone": "UTC"},
                "channel": ["workbench"],
                "executor": "glasshive_host",
                "conversation_policy": "new",
                "conversation_id": None,
                "last_conversation_id": None,
                "active": 1,
                "created_by": "agent:agent-1",
                "created_source": "agent",
                "created_at": now,
                "updated_at": now,
                "updated_by": "agent:agent-1",
                "updated_source": "agent",
                "last_run_at": now,
                "next_run_at": None,
                "last_status": "running",
                "last_error": None,
                "metadata": {},
            }
        )
        storage.create_scheduled_prompt_run(
            {
                "run_id": "scheduled-run-1",
                "task_id": "task-1",
                "user_id": "owner-a",
                "due_at": now,
                "started_at": now,
                "completed_at": None,
                "status": "running",
                "executor": "glasshive_host",
                "glasshive_project_id": "project-1",
                "glasshive_worker_id": "worker-1",
                "glasshive_run_id": "glasshive-run-1",
                "result_summary": "Running.",
                "error_class": None,
                "private_detail_path": str(detail_path) if detail_path else None,
                "callback_payload_json": None,
                "disposition": "running",
                "created_at": now,
                "updated_at": now,
            }
        )

    @staticmethod
    def signature(secret: str, raw: bytes, payload: dict[str, object]) -> str:
        binding = f"{payload['worker_id']}:{payload['run_id']}".encode()
        derived = (
            hmac.new(secret.encode(), binding, hashlib.sha256).hexdigest().encode()
        )
        return "sha256=" + hmac.new(derived, raw, hashlib.sha256).hexdigest()

    def client(self, storage: ScheduleStorage):
        if TestClient is None:
            self.skipTest("starlette[testclient] is unavailable")
        mcp = build_server(storage)
        if hasattr(mcp, "http_app"):
            return TestClient(mcp.http_app(transport="streamable-http"))
        self.skipTest("FastMCP ASGI app is unavailable")

    def post(self, client, secret: str, payload: dict[str, object]):
        raw = json.dumps(payload, separators=(",", ":")).encode()
        return client.post(
            "/internal/scheduled-prompts/glasshive-callback",
            content=raw,
            headers={
                "content-type": "application/json",
                "x-glasshive-signature": self.signature(secret, raw, payload),
            },
        )

    def test_a_is_rejected_when_b_wins_before_receiver_acceptance(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            callback_a = terminal_payload(revision=1, digest_character="a")
            callback_b = terminal_payload(revision=2, digest_character="b")
            accept = storage.accept_scheduled_terminal_callback_result

            def b_wins_first(**arguments):
                if arguments["payload"]["result_revision"] == 1:
                    accepted_b = accept(
                        owner_id="owner-a",
                        work_id="scheduled-run-1",
                        payload=callback_b,
                    )
                    self.assertEqual(accepted_b["callback_status"], "accepted")
                return accept(**arguments)

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch.object(
                    storage,
                    "accept_scheduled_terminal_callback_result",
                    side_effect=b_wins_first,
                ),
            ):
                response = self.post(client, secret, callback_a)

            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["callback_status"], "superseded")
            self.assertEqual(response.json()["result_revision"], 1)
            self.assertEqual(response.json()["current_result_revision"], 2)
            self.assertEqual(
                response.json()["current_callback_id"], callback_b["callback_id"]
            )
            self.assertEqual(
                storage.get_scheduled_prompt_run("scheduled-run-1")["status"],
                "running",
            )
            self.assertFalse(detail.exists())
            current = storage.get_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1"
            )
            self.assertEqual(current["result_revision"], 2)

    def test_active_receiver_effect_lease_blocks_newer_result_until_a_commits(
        self,
    ) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            callback_a = terminal_payload(revision=1, digest_character="a")
            callback_b = terminal_payload(
                revision=2, digest_character="b", event="run.cancelled"
            )
            effect_is_current = storage.scheduled_terminal_callback_effect_is_current
            checked = False
            b_decisions: list[dict[str, object]] = []

            def b_wins_before_effect(**arguments):
                nonlocal checked
                if not checked:
                    checked = True
                    accepted_b = storage.accept_scheduled_terminal_callback_result(
                        owner_id="owner-a",
                        work_id="scheduled-run-1",
                        payload=callback_b,
                    )
                    b_decisions.append(accepted_b)
                    self.assertEqual(
                        accepted_b["callback_status"], "effects_in_progress"
                    )
                return effect_is_current(**arguments)

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch.object(
                    storage,
                    "scheduled_terminal_callback_effect_is_current",
                    side_effect=b_wins_before_effect,
                ),
            ):
                response = self.post(client, secret, callback_a)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["callback_status"], "accepted")
            self.assertEqual(b_decisions[0]["http_status"], 425)
            self.assertTrue(detail.exists())
            self.assertEqual(
                storage.get_scheduled_prompt_run("scheduled-run-1")["status"],
                "completed",
            )
            accepted_b = storage.accept_scheduled_terminal_callback_result(
                owner_id="owner-a",
                work_id="scheduled-run-1",
                payload=callback_b,
            )
            self.assertEqual(accepted_b["callback_status"], "accepted")

    def test_route_rejects_wrong_owner_and_work_without_receiver_state(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            callback = terminal_payload(revision=1, digest_character="a")

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                wrong_owner = self.post(
                    client, secret, {**callback, "user_id": "owner-b"}
                )
                wrong_work = self.post(
                    client, secret, {**callback, "message_id": "scheduled-run-2"}
                )

            self.assertEqual(wrong_owner.status_code, 400)
            self.assertEqual(wrong_work.status_code, 400)
            self.assertFalse(detail.exists())
            self.assertIsNone(
                storage.get_scheduled_terminal_callback_result(
                    owner_id="owner-a", work_id="scheduled-run-1"
                )
            )

    def test_storage_is_monotonic_isolated_and_restart_safe(self) -> None:
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            first = terminal_payload(revision=1, digest_character="a")
            accepted = storage.accept_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1", payload=first
            )
            self.assertEqual(accepted["callback_status"], "accepted")
            lease = storage.claim_scheduled_terminal_callback_effect(
                owner_id="owner-a",
                work_id="scheduled-run-1",
                result_revision=1,
                result_digest=first["result_digest"],
            )
            self.assertTrue(lease["claimed"])
            self.assertTrue(
                storage.complete_scheduled_terminal_callback_effect(
                    owner_id="owner-a",
                    work_id="scheduled-run-1",
                    result_revision=1,
                    result_digest=first["result_digest"],
                    lease_token=lease["lease_token"],
                )
            )
            self.assertEqual(
                storage.accept_scheduled_terminal_callback_result(
                    owner_id="owner-a", work_id="scheduled-run-1", payload=first
                )["callback_status"],
                "idempotent",
            )
            conflict = terminal_payload(revision=1, digest_character="c")
            self.assertEqual(
                storage.accept_scheduled_terminal_callback_result(
                    owner_id="owner-a", work_id="scheduled-run-1", payload=conflict
                )["callback_status"],
                "conflict",
            )
            newer = terminal_payload(
                revision=2, digest_character="b", event="run.cancelled"
            )
            self.assertEqual(
                storage.accept_scheduled_terminal_callback_result(
                    owner_id="owner-a", work_id="scheduled-run-1", payload=newer
                )["callback_status"],
                "accepted",
            )
            self.assertEqual(
                storage.accept_scheduled_terminal_callback_result(
                    owner_id="owner-a", work_id="scheduled-run-1", payload=first
                )["callback_status"],
                "superseded",
            )
            isolated = {**first, "user_id": "owner-b", "message_id": "scheduled-run-2"}
            self.assertEqual(
                storage.accept_scheduled_terminal_callback_result(
                    owner_id="owner-b", work_id="scheduled-run-2", payload=isolated
                )["callback_status"],
                "accepted",
            )

            reopened = self.make_storage(directory)
            current = reopened.get_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1"
            )
            self.assertEqual(current["result_revision"], 2)
            self.assertEqual(
                json.loads(current["payload_json"])["result_state"], "cancelled"
            )

    def test_exact_replay_has_one_effect_and_newer_cancelled_payload_wins(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            first = terminal_payload(revision=1, digest_character="a")
            conflict = terminal_payload(revision=1, digest_character="c")
            cancelled = terminal_payload(
                revision=2, digest_character="b", event="run.cancelled"
            )

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                accepted = self.post(client, secret, first)
                reopened = self.make_storage(directory)
                replay_client = self.client(reopened)
                replay = self.post(replay_client, secret, first)
                rejected_conflict = self.post(replay_client, secret, conflict)
                newer = self.post(replay_client, secret, cancelled)

            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(accepted.json()["callback_status"], "accepted")
            self.assertEqual(accepted.json()["callback_id"], first["callback_id"])
            self.assertEqual(accepted.json()["run_id"], first["run_id"])
            self.assertEqual(accepted.json()["result_revision"], 1)
            self.assertEqual(accepted.json()["current_result_revision"], 1)
            self.assertEqual(replay.status_code, 200)
            self.assertEqual(replay.json()["callback_status"], "idempotent")
            self.assertEqual(rejected_conflict.status_code, 409)
            self.assertEqual(rejected_conflict.json()["callback_status"], "conflict")
            self.assertEqual(newer.status_code, 200)
            self.assertEqual(newer.json()["callback_status"], "accepted")
            private = json.loads(detail.read_text(encoding="utf-8"))
            self.assertEqual(len(private["callbacks"]), 2)
            self.assertEqual(
                private["callbacks"][-1]["payload"]["result_state"], "cancelled"
            )
            persisted = storage.get_scheduled_prompt_run("scheduled-run-1")
            self.assertEqual(persisted["disposition"], "cancelled")
            self.assertEqual(
                json.loads(persisted["callback_payload_json"])["event"],
                "run.cancelled",
            )
