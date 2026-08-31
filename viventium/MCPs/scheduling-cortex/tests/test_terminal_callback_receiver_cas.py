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
from datetime import datetime, timezone
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

    def test_committed_newer_result_rejects_late_lower_revision(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            newer = terminal_payload(revision=2, digest_character="b")
            older = terminal_payload(
                revision=1,
                digest_character="a",
                event="run.failed",
            )

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                accepted = self.post(client, secret, newer)
                rejected = self.post(client, secret, older)

            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(accepted.json()["callback_status"], "accepted")
            self.assertEqual(rejected.status_code, 409)
            self.assertEqual(rejected.json()["callback_status"], "superseded")
            self.assertEqual(rejected.json()["current_result_revision"], 2)
            persisted = storage.get_scheduled_prompt_run("scheduled-run-1")
            self.assertEqual(persisted["status"], "completed")
            private = json.loads(detail.read_text(encoding="utf-8"))
            self.assertEqual(len(private["callbacks"]), 1)

    def test_signed_legacy_terminal_callback_remains_accepted(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            client = self.client(storage)
            legacy = {
                "callback_id": "cb_legacy_synthetic",
                "callback_ts": 1787515200,
                "event": "run.completed",
                "message": "Synthetic legacy terminal result.",
                "message_id": "scheduled-run-1",
                "run_id": "glasshive-run-1",
                "user_id": "owner-a",
                "worker_id": "worker-1",
            }

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                response = self.post(client, secret, legacy)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["callback_status"], "legacy_accepted")
            self.assertTrue(response.json()["callback_persisted"])
            self.assertEqual(
                storage.get_scheduled_prompt_run("scheduled-run-1")["status"],
                "completed",
            )
            receiver = storage.get_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1"
            )
            self.assertEqual(receiver["result_revision"], 0)
            self.assertEqual(receiver["effect_state"], "committed")

    def test_legacy_terminal_optional_identity_fields_may_be_absent(self) -> None:
        secret = "synthetic-callback-secret"
        base = {
            "callback_id": "cb_legacy_synthetic",
            "event": "run.completed",
            "message": "Synthetic legacy terminal result.",
            "message_id": "scheduled-run-1",
            "run_id": "glasshive-run-1",
            "user_id": "owner-a",
            "worker_id": "worker-1",
        }
        for omitted_field in ("callback_id", "user_id", "message_id"):
            with self.subTest(omitted_field=omitted_field), TemporaryDirectory() as directory:
                storage = self.make_storage(directory)
                self.make_run(storage)
                client = self.client(storage)
                payload = {
                    key: value
                    for key, value in base.items()
                    if key != omitted_field
                }
                with patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ):
                    response = self.post(client, secret, payload)

                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    response.json()["callback_status"], "legacy_accepted"
                )
                receiver = storage.get_scheduled_terminal_callback_result(
                    owner_id="owner-a", work_id="scheduled-run-1"
                )
                self.assertEqual(receiver["result_revision"], 0)
                self.assertEqual(receiver["effect_state"], "committed")

    def test_legacy_terminal_rejects_wrong_optional_owner_or_work(self) -> None:
        secret = "synthetic-callback-secret"
        base = {
            "callback_id": "cb_legacy_synthetic",
            "event": "run.completed",
            "message": "Synthetic legacy terminal result.",
            "message_id": "scheduled-run-1",
            "run_id": "glasshive-run-1",
            "user_id": "owner-a",
            "worker_id": "worker-1",
        }
        for override in (
            {"user_id": "owner-other"},
            {"message_id": "scheduled-run-other"},
        ):
            with self.subTest(override=override), TemporaryDirectory() as directory:
                storage = self.make_storage(directory)
                self.make_run(storage)
                client = self.client(storage)
                with patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ):
                    response = self.post(client, secret, {**base, **override})

                self.assertEqual(response.status_code, 400)
                self.assertEqual(
                    response.json()["reason"], "invalid_terminal_identity"
                )
                self.assertEqual(
                    storage.get_scheduled_prompt_run("scheduled-run-1")["status"],
                    "running",
                )

    def test_legacy_terminal_callback_loses_race_to_canonical_winner(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            memory_folder = Path(directory) / "memory"
            memory_folder.mkdir()
            (memory_folder / "synthetic-memory-proposal.json").write_text(
                "{}\n", encoding="utf-8"
            )
            detail.write_text(
                json.dumps(
                    {
                        "memory_write_mode": "apply_governed",
                        "my_folder": str(memory_folder),
                        "user_id": "owner-a",
                    }
                ),
                encoding="utf-8",
            )
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            legacy = {
                "callback_id": "cb_legacy_synthetic",
                "event": "run.completed",
                "message": "Synthetic stale legacy result.",
                "message_id": "scheduled-run-1",
                "run_id": "glasshive-run-1",
                "user_id": "owner-a",
                "worker_id": "worker-1",
            }
            canonical = terminal_payload(revision=2, digest_character="b")
            original_claim = storage.claim_legacy_scheduled_terminal_callback_effect
            winner_installed = False

            def canonical_wins_before_legacy_claim(**arguments):
                nonlocal winner_installed
                if not winner_installed:
                    winner_installed = True
                    accepted = storage.accept_scheduled_terminal_callback_result(
                        owner_id="owner-a",
                        work_id="scheduled-run-1",
                        payload=canonical,
                    )
                    self.assertEqual(accepted["callback_status"], "accepted")
                return original_claim(**arguments)

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch.object(
                    storage,
                    "claim_legacy_scheduled_terminal_callback_effect",
                    side_effect=canonical_wins_before_legacy_claim,
                ),
                patch.object(
                    storage,
                    "update_task",
                    wraps=storage.update_task,
                ) as parent_update,
                patch("scheduling_cortex.server.subprocess.run") as helper,
            ):
                response = self.post(client, secret, legacy)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["callback_status"], "legacy_ignored")
            self.assertFalse(response.json()["callback_persisted"])
            persisted = storage.get_scheduled_prompt_run("scheduled-run-1")
            self.assertEqual(persisted["status"], "running")
            private = json.loads(detail.read_text(encoding="utf-8"))
            self.assertNotIn("callbacks", private)
            self.assertNotIn("memory_apply", private)
            parent_update.assert_not_called()
            helper.assert_not_called()
            receiver = storage.get_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1"
            )
            self.assertEqual(receiver["result_revision"], 2)
            self.assertEqual(receiver["effect_state"], "pending")

    def test_legacy_terminal_after_canonical_completion_is_ignored(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            canonical = terminal_payload(revision=1, digest_character="a")
            legacy = {
                "callback_id": "cb_legacy_synthetic",
                "event": "run.failed",
                "message": "Synthetic late legacy failure.",
                "message_id": "scheduled-run-1",
                "run_id": "glasshive-run-1",
                "user_id": "owner-a",
                "worker_id": "worker-1",
            }

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                accepted = self.post(client, secret, canonical)
                ignored = self.post(client, secret, legacy)

            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(ignored.status_code, 200)
            self.assertEqual(ignored.json()["callback_status"], "legacy_ignored")
            self.assertFalse(ignored.json()["callback_persisted"])
            persisted = storage.get_scheduled_prompt_run("scheduled-run-1")
            self.assertEqual(persisted["status"], "completed")
            private = json.loads(detail.read_text(encoding="utf-8"))
            self.assertEqual(len(private["callbacks"]), 1)

    def test_legacy_completion_applies_governed_memory_after_lifecycle_cas(
        self,
    ) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            memory_folder = Path(directory) / "memory"
            memory_folder.mkdir()
            (memory_folder / "synthetic-memory-proposal.json").write_text(
                "{}\n", encoding="utf-8"
            )
            detail.write_text(
                json.dumps(
                    {
                        "memory_write_mode": "apply_governed",
                        "my_folder": str(memory_folder),
                        "user_id": "owner-a",
                    }
                ),
                encoding="utf-8",
            )
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            legacy = {
                "callback_ts": 1787515200,
                "event": "run.completed",
                "message": "Synthetic legacy memory result.",
                "run_id": "glasshive-run-1",
                "worker_id": "worker-1",
            }

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch("scheduling_cortex.server.subprocess.run") as helper,
            ):
                helper.return_value.returncode = 2
                helper.return_value.stdout = json.dumps(
                    {"ok": False, "reason": "synthetic_policy_blocked"}
                )
                response = self.post(client, secret, legacy)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["callback_status"], "legacy_accepted")
            helper.assert_called_once()
            self.assertIn("--apply", helper.call_args.args[0])
            persisted = storage.get_scheduled_prompt_run("scheduled-run-1")
            self.assertEqual(persisted["status"], "completed")
            self.assertEqual(persisted["error_class"], "synthetic_policy_blocked")
            self.assertIn("synthetic_policy_blocked", persisted["result_summary"])
            self.assertEqual(
                persisted["callback_payload"]["memory_apply_reason"],
                "synthetic_policy_blocked",
            )
            private = json.loads(detail.read_text(encoding="utf-8"))
            self.assertEqual(
                private["memory_apply"],
                {"ok": False, "reason": "synthetic_policy_blocked"},
            )
            self.assertNotIn("memory_apply_terminal_result", private)

    def test_legacy_memory_retry_resumes_checkpoint_under_revision_zero_lease(
        self,
    ) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            memory_folder = Path(directory) / "memory"
            memory_folder.mkdir()
            (memory_folder / "synthetic-memory-proposal.json").write_text(
                "{}\n", encoding="utf-8"
            )
            detail.write_text(
                json.dumps(
                    {
                        "memory_write_mode": "apply_governed",
                        "my_folder": str(memory_folder),
                        "user_id": "owner-a",
                    }
                ),
                encoding="utf-8",
            )
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            legacy = {
                "callback_ts": 1787515200,
                "event": "run.completed",
                "message": "Synthetic legacy memory result.",
                "run_id": "glasshive-run-1",
                "worker_id": "worker-1",
            }
            original_cas = storage.update_scheduled_prompt_run_if_current
            cas_calls = 0

            def lose_memory_result_cas(*args, **kwargs):
                nonlocal cas_calls
                cas_calls += 1
                if cas_calls == 2:
                    return {
                        "updated": False,
                        "run": storage.get_scheduled_prompt_run(
                            "scheduled-run-1"
                        ),
                    }
                return original_cas(*args, **kwargs)

            legacy_claim = storage.claim_legacy_scheduled_terminal_callback_effect(
                owner_id="owner-a",
                work_id="scheduled-run-1",
                payload=legacy,
            )
            self.assertTrue(legacy_claim["claimed"])
            self.assertEqual(
                legacy_claim["callback_id"],
                "cb_legacy_be7bad1ef2aaf9e78d3ee97965d58ab85719836e276337c0807eb078817c3b91",
            )
            canonical = terminal_payload(revision=2, digest_character="b")

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch("scheduling_cortex.server.subprocess.run") as helper,
                patch.object(
                    storage,
                    "update_scheduled_prompt_run_if_current",
                    side_effect=lose_memory_result_cas,
                ),
                patch.object(
                    storage,
                    "update_task",
                    wraps=storage.update_task,
                ) as parent_update,
            ):
                helper.return_value.returncode = 0
                helper.return_value.stdout = json.dumps({"ok": True})
                canonical_blocked = self.post(client, secret, canonical)
                self.assertTrue(
                    storage.release_scheduled_terminal_callback_effect(
                        owner_id="owner-a",
                        work_id="scheduled-run-1",
                        result_revision=0,
                        result_digest=str(legacy_claim["result_digest"]),
                        lease_token=str(legacy_claim["lease_token"]),
                    )
                )
                first = self.post(client, secret, legacy)
                retried = self.post(
                    client,
                    secret,
                    {**legacy, "callback_ts": 1787515201},
                )

            self.assertEqual(canonical_blocked.status_code, 425)
            self.assertEqual(
                canonical_blocked.json()["callback_status"],
                "effects_in_progress",
            )
            self.assertEqual(first.status_code, 503)
            self.assertEqual(first.json()["status"], "error")
            self.assertEqual(
                first.json()["reason"], "memory_effect_result_not_persisted"
            )
            self.assertTrue(first.json()["retryable"])
            self.assertEqual(retried.status_code, 200)
            self.assertEqual(retried.json()["callback_status"], "legacy_accepted")
            helper.assert_called_once()
            parent_update.assert_called_once()
            private = json.loads(detail.read_text(encoding="utf-8"))
            self.assertEqual(private["memory_apply"], {"ok": True})
            self.assertNotIn("memory_apply_terminal_result", private)
            self.assertIn("memory_apply_legacy_callback", private)
            self.assertEqual(len(private["callbacks"]), 1)
            receiver = storage.get_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1"
            )
            self.assertEqual(receiver["result_revision"], 0)
            self.assertEqual(receiver["effect_state"], "committed")

    def test_committed_canonical_failure_blocks_legacy_completion_repair(
        self,
    ) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            canonical_failure = {
                **terminal_payload(
                    revision=1,
                    digest_character="a",
                    event="run.failed",
                ),
                "failure_class": "isolated_artifact_import_failed",
            }
            legacy_completion = {
                "callback_id": "cb_legacy_synthetic",
                "event": "run.completed",
                "message": "Synthetic stale legacy completion.",
                "message_id": "scheduled-run-1",
                "run_id": "glasshive-run-1",
                "user_id": "owner-a",
                "worker_id": "worker-1",
            }

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                failed = self.post(client, secret, canonical_failure)
                ignored = self.post(client, secret, legacy_completion)

            self.assertEqual(failed.status_code, 200)
            self.assertEqual(ignored.status_code, 200)
            self.assertEqual(ignored.json()["callback_status"], "legacy_ignored")
            self.assertFalse(ignored.json()["callback_persisted"])
            persisted = storage.get_scheduled_prompt_run("scheduled-run-1")
            self.assertEqual(persisted["status"], "failed")
            self.assertEqual(
                persisted["error_class"], "isolated_artifact_import_failed"
            )
            receiver = storage.get_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1"
            )
            self.assertEqual(receiver["effect_state"], "committed")
            private = json.loads(detail.read_text(encoding="utf-8"))
            self.assertEqual(len(private["callbacks"]), 1)

    def test_partial_canonical_terminal_identity_cannot_downgrade_to_legacy(
        self,
    ) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            client = self.client(storage)
            partial = {
                "callback_id": "cb_legacy_synthetic",
                "event": "run.completed",
                "message_id": "scheduled-run-1",
                "result_revision": 1,
                "run_id": "glasshive-run-1",
                "user_id": "owner-a",
                "worker_id": "worker-1",
            }

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                response = self.post(client, secret, partial)

            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["reason"], "invalid_terminal_identity")
            self.assertEqual(
                storage.get_scheduled_prompt_run("scheduled-run-1")["status"],
                "running",
            )

    def test_terminal_callback_waits_for_glasshive_run_binding(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            storage.update_scheduled_prompt_run(
                "scheduled-run-1", {"glasshive_run_id": None}
            )
            client = self.client(storage)
            callback = terminal_payload(revision=1, digest_character="a")

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                response = self.post(client, secret, callback)

            self.assertEqual(response.status_code, 425)
            self.assertEqual(response.json()["reason"], "run_binding_pending")
            self.assertTrue(response.json()["retryable"])
            self.assertEqual(
                storage.get_scheduled_prompt_run("scheduled-run-1")["status"],
                "running",
            )

    def test_terminal_callback_waits_for_glasshive_worker_binding(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            storage.update_scheduled_prompt_run(
                "scheduled-run-1", {"glasshive_worker_id": None}
            )
            client = self.client(storage)
            callback = terminal_payload(revision=1, digest_character="a")

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                response = self.post(client, secret, callback)

            self.assertEqual(response.status_code, 425)
            self.assertEqual(response.json()["reason"], "worker_binding_pending")
            self.assertTrue(response.json()["retryable"])
            self.assertEqual(
                storage.get_scheduled_prompt_run("scheduled-run-1")["status"],
                "running",
            )

    def test_non_ascii_worker_binding_is_rejected_without_server_error(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            client = self.client(storage)
            callback = {
                **terminal_payload(revision=1, digest_character="a"),
                "worker_id": "synthetic-wørker",
            }

            with patch.dict(
                os.environ,
                {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                clear=False,
            ):
                response = self.post(client, secret, callback)

            self.assertEqual(response.status_code, 409)
            self.assertEqual(response.json()["reason"], "worker_mismatch")

    def test_a_is_rejected_when_b_wins_between_accept_and_effect_claim(self) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            callback_a = terminal_payload(revision=1, digest_character="a")
            callback_b = terminal_payload(revision=2, digest_character="b")
            accept = storage.accept_scheduled_terminal_callback_result
            claim = storage.claim_scheduled_terminal_callback_effect

            def b_wins_before_claim(**arguments):
                accepted_b = accept(
                    owner_id="owner-a",
                    work_id="scheduled-run-1",
                    payload=callback_b,
                )
                self.assertEqual(accepted_b["callback_status"], "accepted")
                return claim(**arguments)

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch.object(
                    storage,
                    "claim_scheduled_terminal_callback_effect",
                    side_effect=b_wins_before_claim,
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

    def test_losing_lifecycle_cas_has_no_memory_parent_or_periphery_effects(
        self,
    ) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            my_folder = Path(directory) / "my-folder"
            my_folder.mkdir()
            (my_folder / "memory-proposal.json").write_text("{}\n", encoding="utf-8")
            detail.write_text(
                json.dumps(
                    {
                        "memory_write_mode": "apply_governed",
                        "my_folder": str(my_folder),
                        "user_id": "owner-a",
                    }
                ),
                encoding="utf-8",
            )
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            callback = terminal_payload(revision=1, digest_character="a")
            current_run = storage.get_scheduled_prompt_run("scheduled-run-1")

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch.object(
                    storage,
                    "update_scheduled_prompt_run_if_current",
                    return_value={"updated": False, "run": current_run},
                ),
                patch.object(storage, "update_task") as parent_update,
                patch("scheduling_cortex.server.subprocess.run") as memory_process,
                patch(
                    "scheduling_cortex.server._refresh_workbench_periphery_index"
                ) as periphery_refresh,
            ):
                memory_process.return_value.returncode = 0
                memory_process.return_value.stdout = '{"ok": true}'
                response = self.post(client, secret, callback)

            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["reason"], "callback_effect_not_persisted")
            memory_process.assert_not_called()
            parent_update.assert_not_called()
            periphery_refresh.assert_not_called()
            after_loss = json.loads(detail.read_text(encoding="utf-8"))
            self.assertNotIn("callbacks", after_loss)

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch("scheduling_cortex.server.subprocess.run") as retry_memory,
            ):
                retry_memory.return_value.returncode = 0
                retry_memory.return_value.stdout = '{"ok": true}'
                retry = self.post(client, secret, callback)

            self.assertEqual(retry.status_code, 200)
            self.assertEqual(retry.json()["callback_status"], "accepted")
            retry_memory.assert_called_once()
            after_retry = json.loads(detail.read_text(encoding="utf-8"))
            self.assertEqual(len(after_retry["callbacks"]), 1)

    def test_failed_memory_result_cas_is_retryable_without_duplicate_effects(
        self,
    ) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            detail = Path(directory) / "private-detail.json"
            my_folder = Path(directory) / "my-folder"
            my_folder.mkdir()
            (my_folder / "memory-proposal.json").write_text("{}\n", encoding="utf-8")
            detail.write_text(
                json.dumps(
                    {
                        "memory_write_mode": "apply_governed",
                        "my_folder": str(my_folder),
                        "user_id": "owner-a",
                    }
                ),
                encoding="utf-8",
            )
            self.make_run(storage, detail_path=detail)
            client = self.client(storage)
            callback = terminal_payload(revision=1, digest_character="a")
            update_if_current = storage.update_scheduled_prompt_run_if_current
            update_calls = 0

            def lose_memory_result_update(*arguments, **keywords):
                nonlocal update_calls
                update_calls += 1
                if update_calls == 1:
                    return update_if_current(*arguments, **keywords)
                return {
                    "updated": False,
                    "run": storage.get_scheduled_prompt_run("scheduled-run-1"),
                }

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch.object(
                    storage,
                    "update_scheduled_prompt_run_if_current",
                    side_effect=lose_memory_result_update,
                ),
                patch.object(storage, "update_task") as parent_update,
                patch("scheduling_cortex.server.subprocess.run") as memory_process,
                patch(
                    "scheduling_cortex.server._refresh_workbench_periphery_index"
                ) as periphery_refresh,
            ):
                memory_process.return_value.returncode = 0
                memory_process.return_value.stdout = '{"ok": true}'
                response = self.post(client, secret, callback)

            self.assertEqual(response.status_code, 503)
            self.assertEqual(
                response.json()["reason"], "memory_effect_result_not_persisted"
            )
            self.assertTrue(response.json()["lifecycle_persisted"])
            self.assertTrue(response.json()["memory_effect_applied"])
            memory_process.assert_called_once()
            parent_update.assert_not_called()
            periphery_refresh.assert_not_called()
            receiver = storage.get_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1"
            )
            self.assertEqual(receiver["effect_state"], "pending")
            after_failure = json.loads(detail.read_text(encoding="utf-8"))
            self.assertEqual(len(after_failure["callbacks"]), 1)

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch("scheduling_cortex.server.subprocess.run") as retry_memory,
                patch(
                    "scheduling_cortex.server._refresh_workbench_periphery_index"
                ) as retry_periphery,
            ):
                retry = self.post(client, secret, callback)

            self.assertEqual(retry.status_code, 200)
            self.assertEqual(retry.json()["callback_status"], "accepted")
            retry_memory.assert_not_called()
            retry_periphery.assert_called_once()
            after_retry = json.loads(detail.read_text(encoding="utf-8"))
            self.assertEqual(len(after_retry["callbacks"]), 1)
            receiver = storage.get_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1"
            )
            self.assertEqual(receiver["effect_state"], "committed")

    def test_newer_run_created_during_parent_update_blocks_stale_parent_write(
        self,
    ) -> None:
        secret = "synthetic-callback-secret"
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            client = self.client(storage)
            callback = terminal_payload(revision=1, digest_character="a")
            update_task = storage.update_task
            # Equal semantic timestamps exercise insertion order, independent of lexical IDs.
            newer_started = "2026-08-23T19:59:00+00:00"

            def newer_run_wins(user_id, task_id, updates, **keywords):
                storage.create_scheduled_prompt_run(
                    {
                        "run_id": "000-newer-run",
                        "task_id": "task-1",
                        "user_id": "owner-a",
                        "due_at": newer_started,
                        "started_at": newer_started,
                        "completed_at": newer_started,
                        "status": "failed",
                        "executor": "glasshive_host",
                        "result_summary": "Newer run failed.",
                        "error_class": "newer_failure",
                        "disposition": "failed",
                        "created_at": newer_started,
                        "updated_at": newer_started,
                    }
                )
                update_task(
                    user_id,
                    task_id,
                    {
                        "last_run_at": newer_started,
                        "last_status": "error",
                        "last_error": "newer_failure",
                        "last_delivery_reason": "newer_failure",
                    },
                )
                return update_task(user_id, task_id, updates, **keywords)

            with (
                patch.dict(
                    os.environ,
                    {"SCHEDULING_GLASSHIVE_CALLBACK_SECRET": secret},
                    clear=False,
                ),
                patch.object(storage, "update_task", side_effect=newer_run_wins),
            ):
                response = self.post(client, secret, callback)

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["parent_update"], "fenced")
            self.assertTrue(response.json()["callback_persisted"])
            parent = storage.get_task("owner-a", "task-1")
            self.assertEqual(parent["last_run_at"], newer_started)
            self.assertEqual(parent["last_status"], "error")
            self.assertEqual(parent["last_error"], "newer_failure")
            self.assertEqual(parent["last_delivery_reason"], "newer_failure")

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
            leased = storage.get_scheduled_terminal_callback_result(
                owner_id="owner-a", work_id="scheduled-run-1"
            )
            lease_until = datetime.fromisoformat(str(leased["effect_lease_until"]))
            self.assertGreater(
                (lease_until - datetime.now(timezone.utc)).total_seconds(),
                90,
            )
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
