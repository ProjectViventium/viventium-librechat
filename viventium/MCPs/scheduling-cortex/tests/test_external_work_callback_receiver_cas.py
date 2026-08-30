# VIVENTIUM START
# Purpose: Prove the Core scheduler outbox contract is fenced at its real receiver endpoint.
# Porting: Copy with the scheduling-cortex terminal callback result ledger.
# VIVENTIUM END

from __future__ import annotations

import os
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Lock
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


TERMINAL_CONTRACT = "glasshive_terminal_result_v1"
SECRET = "synthetic-scheduler-secret"
OCCURRENCE_KEY = "occurrence-core-sender-cas"
OWNER_ID = "owner-core-sender-cas"
RUN_ID = "scheduled-run-core-sender-cas"


def external_payload(
    *,
    revision: int,
    digest_character: str,
    state: str,
    required_failed: int,
) -> dict[str, object]:
    return {
        "callback_contract": TERMINAL_CONTRACT,
        "source": "glasshive",
        "event": "run.completed",
        "occurrence_key": OCCURRENCE_KEY,
        "user_id": OWNER_ID,
        "required_total": 1,
        "required_terminal": 1,
        "required_failed": required_failed,
        "all_required_terminal": True,
        "state": state,
        "callback_id": f"cb_terminal_{digest_character * 64}",
        "result_revision": revision,
        "result_digest": f"sha256:{digest_character * 64}",
    }


class ExternalWorkCallbackReceiverCASTests(TestCase):
    def make_storage(self, directory: str) -> ScheduleStorage:
        return ScheduleStorage(
            StorageConfig(db_path=str(Path(directory) / "schedules.db"))
        )

    def make_run(
        self, storage: ScheduleStorage, *, executor: str = "glasshive_host"
    ) -> None:
        now = "2026-08-23T20:00:00+00:00"
        storage.create_scheduled_prompt_run(
            {
                "run_id": RUN_ID,
                "task_id": "task-core-sender-cas",
                "user_id": OWNER_ID,
                "due_at": now,
                "started_at": now,
                "completed_at": None,
                "status": "running",
                "executor": executor,
                "result_summary": "Running.",
                "error_class": None,
                "disposition": "running",
                "occurrence_key": OCCURRENCE_KEY,
                "created_at": now,
                "updated_at": now,
            }
        )

    def client(self, storage: ScheduleStorage):
        if TestClient is None:
            self.skipTest("starlette[testclient] is unavailable")
        mcp = build_server(storage)
        if hasattr(mcp, "http_app"):
            return TestClient(mcp.http_app(transport="streamable-http"))
        self.skipTest("FastMCP ASGI app is unavailable")

    def post(self, client, payload: dict[str, object]):
        headers = {
            "x-viventium-scheduler-secret": SECRET,
            "x-viventium-callback-contract": str(
                payload.get("callback_contract") or ""
            ),
        }
        for header, field in (
            ("x-viventium-callback-id", "callback_id"),
            ("x-viventium-result-revision", "result_revision"),
            ("x-viventium-result-digest", "result_digest"),
        ):
            if field in payload:
                headers[header] = str(payload[field])
        return client.post(
            "/internal/scheduled-prompts/external-work-callback",
            json=payload,
            headers=headers,
        )

    def test_paused_a_is_rejected_after_b_wins_and_only_b_creates_the_effect(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            storage_a = self.make_storage(directory)
            self.make_run(storage_a)
            storage_b = self.make_storage(directory)
            client_a = self.client(storage_a)
            client_b = self.client(storage_b)
            callback_a = external_payload(
                revision=1,
                digest_character="a",
                state="completed-a",
                required_failed=0,
            )
            callback_b = external_payload(
                revision=2,
                digest_character="b",
                state="failed-b",
                required_failed=1,
            )
            a_paused = Event()
            resume_a = Event()
            original_lookup = storage_a.get_scheduled_prompt_run_by_occurrence_key
            effects: list[str] = []
            effects_lock = Lock()

            def paused_lookup(occurrence_key: str):
                a_paused.set()
                self.assertTrue(resume_a.wait(timeout=5))
                return original_lookup(occurrence_key)

            def record_effect(storage: ScheduleStorage):
                original = storage.update_scheduled_prompt_run_if_current

                def wrapped(*arguments, **keywords):
                    snapshot = dict(keywords.get("updates") or arguments[1]).get(
                        "execution_snapshot"
                    )
                    with effects_lock:
                        effects.append(
                            str((snapshot or {}).get("external_work", {}).get("state"))
                        )
                    return original(*arguments, **keywords)

                return wrapped

            with (
                patch.dict(
                    os.environ,
                    {"VIVENTIUM_SCHEDULER_SECRET": SECRET},
                    clear=False,
                ),
                patch.object(
                    storage_a,
                    "get_scheduled_prompt_run_by_occurrence_key",
                    side_effect=paused_lookup,
                ),
                patch.object(
                    storage_a,
                    "update_scheduled_prompt_run_if_current",
                    side_effect=record_effect(storage_a),
                ),
                patch.object(
                    storage_b,
                    "update_scheduled_prompt_run_if_current",
                    side_effect=record_effect(storage_b),
                ),
                ThreadPoolExecutor(max_workers=1) as pool,
            ):
                response_a_future = pool.submit(self.post, client_a, callback_a)
                self.assertTrue(a_paused.wait(timeout=5))
                response_b = self.post(client_b, callback_b)
                resume_a.set()
                response_a = response_a_future.result(timeout=5)

            self.assertEqual(response_b.status_code, 200)
            self.assertEqual(response_b.json()["callback_status"], "accepted")
            self.assertEqual(response_a.status_code, 409)
            self.assertEqual(response_a.json()["callback_status"], "superseded")
            self.assertEqual(effects, ["failed-b"])
            persisted = self.make_storage(directory).get_scheduled_prompt_run(RUN_ID)
            self.assertEqual(persisted["status"], "failed")
            self.assertEqual(
                persisted["execution_snapshot"]["external_work"]["state"],
                "failed-b",
            )

    def test_duplicate_exact_b_is_idempotent_and_has_one_effect(self) -> None:
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            client = self.client(storage)
            callback_b = external_payload(
                revision=2,
                digest_character="b",
                state="failed-b",
                required_failed=1,
            )
            effect_count = 0
            original = storage.update_scheduled_prompt_run_if_current

            def count_effect(*arguments, **keywords):
                nonlocal effect_count
                effect_count += 1
                return original(*arguments, **keywords)

            with (
                patch.dict(
                    os.environ,
                    {"VIVENTIUM_SCHEDULER_SECRET": SECRET},
                    clear=False,
                ),
                patch.object(
                    storage,
                    "update_scheduled_prompt_run_if_current",
                    side_effect=count_effect,
                ),
            ):
                first = self.post(client, callback_b)
                duplicate = self.post(client, callback_b)

            self.assertEqual(first.status_code, 200)
            self.assertEqual(first.json()["callback_status"], "accepted")
            self.assertEqual(duplicate.status_code, 200)
            self.assertEqual(duplicate.json()["callback_status"], "idempotent")
            self.assertEqual(effect_count, 1)

    def test_same_revision_different_digest_and_older_revision_are_rejected(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            client = self.client(storage)
            callback_b = external_payload(
                revision=2,
                digest_character="b",
                state="failed-b",
                required_failed=1,
            )
            conflict = external_payload(
                revision=2,
                digest_character="c",
                state="completed-conflict",
                required_failed=0,
            )
            older = external_payload(
                revision=1,
                digest_character="a",
                state="completed-old",
                required_failed=0,
            )

            with patch.dict(
                os.environ,
                {"VIVENTIUM_SCHEDULER_SECRET": SECRET},
                clear=False,
            ):
                accepted = self.post(client, callback_b)
                rejected_conflict = self.post(client, conflict)
                rejected_older = self.post(client, older)

            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(rejected_conflict.status_code, 409)
            self.assertEqual(rejected_conflict.json()["callback_status"], "conflict")
            self.assertEqual(rejected_older.status_code, 409)
            self.assertEqual(rejected_older.json()["callback_status"], "superseded")
            persisted = storage.get_scheduled_prompt_run(RUN_ID)
            self.assertEqual(
                persisted["execution_snapshot"]["external_work"]["state"],
                "failed-b",
            )

    def test_terminal_contract_without_identity_fails_closed(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            client = self.client(storage)
            missing_identity = external_payload(
                revision=1,
                digest_character="a",
                state="completed-missing-identity",
                required_failed=0,
            )
            for field in (
                "callback_contract",
                "callback_id",
                "result_revision",
                "result_digest",
            ):
                missing_identity.pop(field)

            with patch.dict(
                os.environ,
                {"VIVENTIUM_SCHEDULER_SECRET": SECRET},
                clear=False,
            ):
                rejected = self.post(client, missing_identity)

            self.assertEqual(rejected.status_code, 400)
            self.assertEqual(rejected.json()["reason"], "invalid_terminal_identity")
            unchanged = storage.get_scheduled_prompt_run(RUN_ID)
            self.assertEqual(unchanged["status"], "running")
            self.assertNotIn("external_work", unchanged.get("execution_snapshot") or {})

    def test_non_boolean_terminal_aggregate_never_mutates_the_occurrence(self) -> None:
        for field in ("allRequiredTerminal", "all_required_terminal"):
            with self.subTest(field=field), TemporaryDirectory() as directory:
                storage = self.make_storage(directory)
                self.make_run(storage)
                client = self.client(storage)
                payload = external_payload(
                    revision=1,
                    digest_character="a",
                    state="completed-invalid-boolean",
                    required_failed=0,
                )
                payload.pop("allRequiredTerminal", None)
                payload.pop("all_required_terminal", None)
                payload[field] = 1

                with patch.dict(
                    os.environ,
                    {"VIVENTIUM_SCHEDULER_SECRET": SECRET},
                    clear=False,
                ):
                    rejected = self.post(client, payload)

                self.assertEqual(rejected.status_code, 400)
                self.assertEqual(
                    rejected.json()["reason"], "invalid_all_required_terminal"
                )
                unchanged = storage.get_scheduled_prompt_run(RUN_ID)
                self.assertEqual(unchanged["status"], "running")
                self.assertNotIn(
                    "external_work", unchanged.get("execution_snapshot") or {}
                )

    def test_explicit_legacy_payload_is_accepted(self) -> None:
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage, executor="legacy_external")
            client = self.client(storage)
            legacy = {
                "source": "legacy_external_work",
                "event": "external_work.progress",
                "occurrence_key": OCCURRENCE_KEY,
                "user_id": OWNER_ID,
                "required_total": 1,
                "required_terminal": 0,
                "required_failed": 0,
                "all_required_terminal": False,
                "state": "legacy-waiting",
            }

            with patch.dict(
                os.environ,
                {"VIVENTIUM_SCHEDULER_SECRET": SECRET},
                clear=False,
            ):
                accepted_legacy = self.post(client, legacy)

            self.assertEqual(accepted_legacy.status_code, 200)
            self.assertEqual(
                accepted_legacy.json()["callback_status"], "legacy_accepted"
            )

    def test_explicit_legacy_payload_cannot_overwrite_a_terminal_glasshive_winner(
        self,
    ) -> None:
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            client = self.client(storage)
            callback_b = external_payload(
                revision=2,
                digest_character="b",
                state="failed-b",
                required_failed=1,
            )
            legacy = {
                "source": "legacy_external_work",
                "event": "external_work.progress",
                "occurrence_key": OCCURRENCE_KEY,
                "user_id": OWNER_ID,
                "required_total": 1,
                "required_terminal": 0,
                "required_failed": 0,
                "all_required_terminal": False,
                "state": "legacy-waiting",
            }

            with patch.dict(
                os.environ,
                {"VIVENTIUM_SCHEDULER_SECRET": SECRET},
                clear=False,
            ):
                accepted_b = self.post(client, callback_b)
                rejected_legacy = self.post(client, legacy)

            self.assertEqual(accepted_b.status_code, 200)
            self.assertEqual(rejected_legacy.status_code, 400)
            self.assertEqual(
                rejected_legacy.json()["reason"], "legacy_callback_not_allowed"
            )
            persisted = storage.get_scheduled_prompt_run(RUN_ID)
            self.assertEqual(persisted["status"], "failed")
            self.assertEqual(
                persisted["execution_snapshot"]["external_work"]["state"],
                "failed-b",
            )

    def test_legacy_terminal_flag_requires_an_explicit_false_boolean(self) -> None:
        cases = (
            ("numeric", 1, 400, "running", False),
            ("string", "false", 400, "running", False),
            ("missing", None, 400, "running", False),
            ("true", True, 400, "running", False),
            ("false", False, 200, "waiting_external", True),
        )
        for label, raw_flag, status_code, expected_status, should_mutate in cases:
            with self.subTest(label=label), TemporaryDirectory() as directory:
                storage = self.make_storage(directory)
                self.make_run(storage, executor="legacy_external")
                client = self.client(storage)
                legacy = {
                    "source": "legacy_external_work",
                    "event": "external_work.progress",
                    "occurrence_key": OCCURRENCE_KEY,
                    "user_id": OWNER_ID,
                    "required_total": 1,
                    "required_terminal": 0,
                    "required_failed": 0,
                    "state": "legacy-waiting",
                }
                if label != "missing":
                    legacy["all_required_terminal"] = raw_flag

                with patch.dict(
                    os.environ,
                    {"VIVENTIUM_SCHEDULER_SECRET": SECRET},
                    clear=False,
                ):
                    response = self.post(client, legacy)

                self.assertEqual(response.status_code, status_code)
                persisted = storage.get_scheduled_prompt_run(RUN_ID)
                self.assertEqual(persisted["status"], expected_status)
                external_work = (persisted.get("execution_snapshot") or {}).get(
                    "external_work"
                )
                self.assertEqual(external_work is not None, should_mutate)

    def test_restart_preserves_b_as_winner(self) -> None:
        with TemporaryDirectory() as directory:
            storage = self.make_storage(directory)
            self.make_run(storage)
            callback_b = external_payload(
                revision=2,
                digest_character="b",
                state="failed-b",
                required_failed=1,
            )
            callback_a = external_payload(
                revision=1,
                digest_character="a",
                state="completed-old",
                required_failed=0,
            )

            with patch.dict(
                os.environ,
                {"VIVENTIUM_SCHEDULER_SECRET": SECRET},
                clear=False,
            ):
                accepted = self.post(self.client(storage), callback_b)
                restarted = self.make_storage(directory)
                duplicate = self.post(self.client(restarted), callback_b)
                older = self.post(self.client(restarted), callback_a)

            self.assertEqual(accepted.status_code, 200)
            self.assertEqual(duplicate.status_code, 200)
            self.assertEqual(duplicate.json()["callback_status"], "idempotent")
            self.assertEqual(older.status_code, 409)
            self.assertEqual(older.json()["callback_status"], "superseded")
            current = restarted.get_scheduled_terminal_callback_result(
                owner_id=OWNER_ID,
                work_id=RUN_ID,
            )
            self.assertEqual(current["result_revision"], 2)
            self.assertEqual(current["result_digest"], callback_b["result_digest"])
