# === VIVENTIUM START ===
# Purpose: Viventium addition in private LibreChat fork (new file).
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# === VIVENTIUM END ===

import os
import json
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from io import BytesIO
from urllib.error import HTTPError, URLError
from unittest.mock import MagicMock, patch
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex import dispatch


class DispatchWorkbenchTests(unittest.TestCase):
    def setUp(self):
        os.environ['WPR_MODEL_HOST_CODEX_CLI'] = 'gpt-managed-test'
        os.environ['WPR_CODEX_CLI_REASONING_EFFORT'] = 'xhigh'
        os.environ['SCHEDULER_LIBRECHAT_SECRET'] = 'scheduler-secret'
        os.environ['WPR_MODEL_CLAUDE_CODE'] = 'claude-managed-test'
        os.environ['WPR_CLAUDE_CODE_EFFORT'] = 'max'

    def tearDown(self):
        os.environ.pop('WPR_CODEX_CLI_REASONING_EFFORT', None)
        os.environ.pop('WPR_MODEL_HOST_CODEX_CLI', None)
        os.environ.pop('SCHEDULER_LIBRECHAT_SECRET', None)
        os.environ.pop('WPR_CLAUDE_CODE_EFFORT', None)
        os.environ.pop('WPR_MODEL_CLAUDE_CODE', None)

    def test_private_run_detail_patch_reports_durable_success(self):
        with tempfile.TemporaryDirectory() as directory:
            detail_path = Path(directory) / 'run.json'
            detail_path.write_text(json.dumps({'existing': True}), encoding='utf-8')

            persisted = dispatch._patch_private_run_detail(
                str(detail_path),
                {'runtime_recovery': {'to_execution_mode': 'docker'}},
            )

            self.assertTrue(persisted)
            self.assertEqual(
                json.loads(detail_path.read_text(encoding='utf-8')),
                {
                    'existing': True,
                    'runtime_recovery': {'to_execution_mode': 'docker'},
                },
            )
            self.assertEqual(detail_path.stat().st_mode & 0o777, 0o600)

    @staticmethod
    def worker_response(worker_id, execution_mode, profile='codex-cli', model='gpt-managed-test'):
        return {
            'worker_id': worker_id,
            'execution_mode': execution_mode,
            'profile': profile,
            'model': model,
        }

    def test_nested_fastapi_error_preserves_parallel_isolation_classification(self):
        payload = {
            'detail': {
                'code': 'parallel_execution_isolation_required',
                'message': 'Host mission roots require isolated execution.',
                'reason': 'host_mission',
            }
        }
        error = HTTPError(
            'http://127.0.0.1:8766/v1/projects/project-1/workers/find-or-resume',
            409,
            'Conflict',
            {},
            BytesIO(json.dumps(payload).encode('utf-8')),
        )

        parsed = dispatch._format_http_error('POST', error.url, error)

        self.assertEqual(parsed.failure_class, 'parallel_execution_isolation_required')
        self.assertEqual(parsed.detail, 'Host mission roots require isolated execution.')
        self.assertEqual(parsed.reason, 'host_mission')
        self.assertIn('parallel_execution_isolation_required', str(parsed))

    def test_parallel_isolation_conflict_recovers_even_with_a_host_workspace_root(self):
        error = dispatch.HttpJsonError(
            'isolated execution required',
            status=409,
            method='POST',
            path='/v1/projects/project-1/workers/find-or-resume',
            failure_class='parallel_execution_isolation_required',
        )

        self.assertTrue(
            dispatch._can_recover_workbench_host_dependency_to_docker(
                error,
                execution_mode='host',
                workspace_root='/private/host/workspace',
                artifact_contract={
                    'kind': 'periphery_pair',
                    'module_id': 'health_context',
                },
            )
        )

    def test_parallel_isolation_conflict_does_not_recover_an_unregistered_contract(self):
        error = dispatch.HttpJsonError(
            'isolated execution required',
            status=409,
            method='POST',
            path='/v1/projects/project-1/workers/find-or-resume',
            failure_class='parallel_execution_isolation_required',
        )

        self.assertFalse(
            dispatch._can_recover_workbench_host_dependency_to_docker(
                error,
                execution_mode='host',
                workspace_root='/private/host/workspace',
                artifact_contract=None,
            )
        )
        self.assertFalse(
            dispatch._can_recover_workbench_host_dependency_to_docker(
                error,
                execution_mode='host',
                workspace_root='/private/host/workspace',
                artifact_contract={'kind': 'periphery_pair'},
                memory_write_mode='propose',
            )
        )

    def test_glasshive_execution_mode_fails_closed_on_unknown_value(self):
        with self.assertRaisesRegex(RuntimeError, 'Unsupported GlassHive execution mode'):
            dispatch._glasshive_execution_mode({'execution_mode': 'workstation-ish'})

    def test_isolated_workbench_text_rebases_only_the_declared_private_folder(self):
        rendered = (
            '<local.viventium.my_folder>\n/private/user/my_folder\n'
            '</local.viventium.my_folder>\nWrite under /private/user/my_folder/periphery.'
        )

        rebased = dispatch._isolated_workbench_text(rendered, '/private/user/my_folder')

        self.assertNotIn('/private/user/my_folder', rebased)
        self.assertIn('artifacts/periphery', rebased)

    def test_glasshive_bootstrap_normalizes_legacy_max_codex_effort(self):
        bundle = dispatch._glasshive_bootstrap_bundle(
            {'id': 'task-1', 'user_id': 'user-1', 'prompt': 'Synthetic prompt'},
            {'reasoning_effort': 'max'},
            'run-1',
        )

        self.assertEqual(bundle['env']['WPR_CODEX_CLI_REASONING_EFFORT'], 'xhigh')

    def test_registered_source_prompt_id_is_passively_exposed_from_structured_metadata(self):
        task = {
            'metadata': {
                'workbench_scheduled_prompt': {
                    'source_prompt_id': 'scheduler.consciousness_continuity_opportunity',
                },
            },
        }

        self.assertEqual(
            dispatch._declared_scheduler_source_prompt_id(task),
            'scheduler.consciousness_continuity_opportunity',
        )
        self.assertIsNone(
            dispatch._declared_scheduler_source_prompt_id(
                {'metadata': {'source_prompt_id': 'scheduler.unregistered-selector'}}
            )
        )

    def test_glasshive_bootstrap_prefers_compiled_codex_effort(self):
        bundle = dispatch._glasshive_bootstrap_bundle(
            {'id': 'task-1', 'user_id': 'user-1', 'prompt': 'Synthetic prompt'},
            {'reasoning_effort': 'high'},
            'run-1',
        )

        self.assertEqual(bundle['env']['WPR_CODEX_CLI_REASONING_EFFORT'], 'xhigh')

    def test_glasshive_bootstrap_isolates_managed_codex_from_ambient_user_config(self):
        os.environ['WPR_MODEL_HOST_CODEX_CLI'] = 'gpt-managed-test'
        bundle = dispatch._glasshive_bootstrap_bundle(
            {'id': 'task-1', 'user_id': 'user-1', 'prompt': 'Synthetic prompt'},
            {'reasoning_effort': 'high'},
            'run-1',
        )

        self.assertEqual(bundle['env']['WPR_MODEL_HOST_CODEX_CLI'], 'gpt-managed-test')
        self.assertEqual(bundle['env']['WPR_CODEX_CLI_REASONING_EFFORT'], 'xhigh')
        self.assertEqual(bundle['env']['WPR_CODEX_CLI_IGNORE_USER_CONFIG'], 'true')

    def test_glasshive_docker_bootstrap_requests_exact_server_authority(self):
        bundle = dispatch._glasshive_bootstrap_bundle(
            {'id': 'task-1', 'user_id': 'user-1', 'prompt': 'Synthetic prompt'},
            {
                'execution_profile': 'codex-cli',
                'execution_model': 'gpt-managed-test',
                'reasoning_effort': 'xhigh',
                'fallback_worker_profile': 'claude-code',
                'fallback_worker_model': 'claude-managed-test',
                'fallback_reasoning_effort': 'max',
            },
            'run-1',
            execution_mode='docker',
        )

        self.assertEqual(
            bundle['viventium_execution_authority_request'],
            {
                'version': 1,
                'kind': 'prompt_workbench_scheduled',
                'execution_mode': 'docker',
                'primary': {
                    'worker_profile': 'codex-cli',
                    'model': 'gpt-managed-test',
                    'reasoning_effort': 'xhigh',
                },
                'fallback': {
                    'worker_profile': 'claude-code',
                    'model': 'claude-managed-test',
                    'reasoning_effort': 'max',
                },
            },
        )
        self.assertEqual(
            bundle['env'],
            {
                'WPR_CODEX_CLI_REASONING_EFFORT': 'xhigh',
                'WPR_CLAUDE_CODE_EFFORT': 'max',
            },
        )
        self.assertNotIn('execution_policy', bundle)
        self.assertNotIn('viventium_launch_authority', bundle)

    def test_glasshive_bootstrap_uses_persisted_tuple_when_compiled_policy_is_absent(self):
        os.environ.pop('WPR_MODEL_HOST_CODEX_CLI', None)
        os.environ.pop('WPR_MODEL_CODEX_CLI', None)
        os.environ.pop('WPR_CODEX_CLI_REASONING_EFFORT', None)
        bundle = dispatch._glasshive_bootstrap_bundle(
            {'id': 'task-1', 'user_id': 'user-1', 'prompt': 'Synthetic prompt'},
            {'execution_model': 'gpt-stale', 'reasoning_effort': 'high'},
            'run-1',
        )

        self.assertEqual(bundle['env']['WPR_MODEL_HOST_CODEX_CLI'], 'gpt-stale')
        self.assertEqual(bundle['env']['WPR_CODEX_CLI_REASONING_EFFORT'], 'high')

    def test_glasshive_bootstrap_fails_closed_when_codex_tuple_is_absent(self):
        os.environ.pop('WPR_MODEL_HOST_CODEX_CLI', None)
        os.environ.pop('WPR_MODEL_CODEX_CLI', None)
        os.environ.pop('WPR_CODEX_CLI_REASONING_EFFORT', None)

        with self.assertRaisesRegex(RuntimeError, 'requires WPR_MODEL_HOST_CODEX_CLI'):
            dispatch._glasshive_bootstrap_bundle(
                {'id': 'task-1', 'user_id': 'user-1', 'prompt': 'Synthetic prompt'},
                {},
                'run-1',
            )

    def test_workbench_refresh_preserves_dispatched_occurrence(self):
        dispatched_at = '2026-07-14T03:41:27Z'
        persisted_next_run = '2026-07-14T07:00:00Z'
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': 'Template {{memory.current}}',
            'next_run_at': dispatched_at,
            '_scheduled_prompt_run_id': 'preclaimed-run',
            '_scheduled_prompt_occurrence_key': 'schedule:occurrence-1',
            '_scheduled_prompt_trigger_kind': 'scheduled',
            '_scheduled_prompt_trigger_source': 'scheduler_loop',
            'metadata': {},
        }
        wb = {'definition_id': 'definition-1'}
        definition = {
            'id': 'definition-1',
            'user_id': 'user-1',
            'prompt_text': 'Template {{memory.current}}',
            'metadata': {
                'execution': {
                    'fallback_worker_profile': 'claude-code',
                    'fallback_worker_model': 'claude-managed-test',
                    'fallback_reasoning_effort': 'max',
                }
            },
        }
        storage = MagicMock()
        storage.get_scheduled_prompt_definition.return_value = definition
        storage.latest_scheduled_prompt_version.return_value = None
        storage.update_task.return_value = {
            'id': task['id'],
            'user_id': task['user_id'],
            'prompt': task['prompt'],
            'next_run_at': persisted_next_run,
            'metadata': task['metadata'],
        }
        renderer = MagicMock()
        renderer.render_variables.return_value = {
            'rendered': 'Template rendered now',
            'renderedHash': 'rendered-hash',
            'variableSnapshotJson': '{}',
            'variableSnapshotHash': 'snapshot-hash',
        }

        with patch.object(dispatch, '_import_workbench_scheduled_prompts', return_value=renderer):
            refreshed_task, _ = dispatch._refresh_workbench_rendered_prompt(storage, task, wb)

        self.assertEqual(refreshed_task['next_run_at'], dispatched_at)
        self.assertEqual(refreshed_task['prompt'], 'Template rendered now')
        self.assertEqual(refreshed_task['_scheduled_prompt_run_id'], 'preclaimed-run')
        self.assertEqual(
            refreshed_task['_scheduled_prompt_occurrence_key'],
            'schedule:occurrence-1',
        )
        self.assertEqual(refreshed_task['_scheduled_prompt_trigger_kind'], 'scheduled')
        self.assertEqual(refreshed_task['_scheduled_prompt_trigger_source'], 'scheduler_loop')
        self.assertEqual(
            refreshed_task['metadata']['workbench_scheduled_prompt'][
                'fallback_worker_profile'
            ],
            'claude-code',
        )
        self.assertEqual(
            refreshed_task['metadata']['workbench_scheduled_prompt'][
                'fallback_worker_model'
            ],
            'claude-managed-test',
        )
        self.assertEqual(
            refreshed_task['metadata']['workbench_scheduled_prompt'][
                'fallback_reasoning_effort'
            ],
            'max',
        )

    def test_glasshive_scheduled_dispatch_fails_closed_if_refresh_drops_preclaim(self):
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': 'Template {{memory.current}}',
            'next_run_at': '2026-08-11T07:00:00Z',
            '_scheduled_prompt_run_id': 'preclaimed-run',
            '_scheduled_prompt_occurrence_key': 'schedule:occurrence-1',
            '_scheduled_prompt_trigger_kind': 'scheduled',
            '_scheduled_prompt_trigger_source': 'scheduler_loop',
            'metadata': {'workbench_scheduled_prompt': {'definition_id': 'definition-1'}},
        }
        refreshed_task = {
            key: value for key, value in task.items() if not key.startswith('_scheduled_prompt_')
        }
        wb = task['metadata']['workbench_scheduled_prompt']
        storage = MagicMock()

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_refresh_workbench_rendered_prompt', return_value=(refreshed_task, wb)
        ), patch.object(dispatch, '_glasshive_callback_secret', return_value='secret'), patch.object(
            dispatch, '_write_private_run_detail', return_value='private://detail'
        ):
            with self.assertRaisesRegex(RuntimeError, 'scheduled preclaim'):
                dispatch._dispatch_glasshive_task(task)

        storage.create_scheduled_prompt_run.assert_not_called()
        storage.update_scheduled_prompt_run.assert_not_called()

    def test_templated_glasshive_dispatch_reuses_preclaim_after_persisted_refresh(self):
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': 'Template {{memory.current}}',
            'next_run_at': '2026-08-11T07:00:00Z',
            '_scheduled_prompt_run_id': 'preclaimed-run',
            '_scheduled_prompt_occurrence_key': 'schedule:occurrence-1',
            '_scheduled_prompt_trigger_kind': 'scheduled',
            '_scheduled_prompt_trigger_source': 'scheduler_loop',
            'metadata': {'workbench_scheduled_prompt': {'definition_id': 'definition-1'}},
        }
        definition = {
            'id': 'definition-1',
            'user_id': 'user-1',
            'prompt_text': 'Template {{memory.current}}',
            'metadata': {},
        }
        storage = MagicMock()
        storage.get_scheduled_prompt_definition.return_value = definition
        storage.latest_scheduled_prompt_version.return_value = None
        storage.update_task.return_value = {
            'id': task['id'],
            'user_id': task['user_id'],
            'prompt': task['prompt'],
            'next_run_at': '2026-08-12T07:00:00Z',
            'metadata': task['metadata'],
        }
        renderer = MagicMock()
        renderer.render_variables.return_value = {
            'rendered': 'Template rendered now',
            'renderedHash': 'rendered-hash',
            'variableSnapshotJson': '{}',
            'variableSnapshotHash': 'snapshot-hash',
        }

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_import_workbench_scheduled_prompts', return_value=renderer
        ), patch.object(dispatch, '_glasshive_callback_secret', return_value='secret'), patch.object(
            dispatch, '_write_private_run_detail', return_value='private://detail'
        ), patch.dict(os.environ, {'SCHEDULER_GLASSHIVE_DISABLE_DISPATCH': '1'}, clear=False):
            result = dispatch._dispatch_glasshive_task(task)

        self.assertEqual(result['scheduled_prompt_run_id'], 'preclaimed-run')
        storage.create_scheduled_prompt_run.assert_not_called()
        dispatching = next(
            call.args[1]
            for call in storage.update_scheduled_prompt_run.call_args_list
            if call.args[1].get('status') == 'dispatching'
        )
        self.assertEqual(
            dispatching['execution_snapshot']['dispatch_idempotency_key'],
            'schedule:occurrence-1',
        )
        self.assertEqual(dispatching['trigger_kind'], 'scheduled')
        self.assertEqual(dispatching['trigger_source'], 'scheduler_loop')

    def test_glasshive_dispatch_updates_preclaimed_run_instead_of_creating_a_second_row(self):
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': 'Synthetic prompt',
            'next_run_at': '2026-08-10T12:00:00Z',
            '_scheduled_prompt_run_id': 'preclaimed-run',
            'metadata': {'workbench_scheduled_prompt': {'definition_id': 'definition-1'}},
        }
        wb = task['metadata']['workbench_scheduled_prompt']
        storage = MagicMock()

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_refresh_workbench_rendered_prompt', return_value=(task, wb)
        ), patch.object(dispatch, '_glasshive_callback_secret', return_value='secret'), patch.object(
            dispatch, '_write_private_run_detail', return_value='private://detail'
        ), patch.dict(os.environ, {'SCHEDULER_GLASSHIVE_DISABLE_DISPATCH': '1'}, clear=False):
            result = dispatch._dispatch_glasshive_task(task)

        storage.create_scheduled_prompt_run.assert_not_called()
        self.assertTrue(
            any(
                call.args[0] == 'preclaimed-run' and call.args[1].get('status') == 'dispatching'
                for call in storage.update_scheduled_prompt_run.call_args_list
            )
        )
        self.assertEqual(result['scheduled_prompt_run_id'], 'preclaimed-run')
        dispatching = next(
            call.args[1]
            for call in storage.update_scheduled_prompt_run.call_args_list
            if call.args[1].get('status') == 'dispatching'
        )
        self.assertEqual(dispatching['execution_snapshot']['executor'], 'glasshive_host')
        self.assertEqual(dispatching['execution_snapshot']['reasoning_effort'], 'xhigh')
        self.assertEqual(result['execution']['executor'], 'glasshive_host')

    def test_glasshive_execution_audits_declared_registered_source_prompt_id(self):
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': 'Synthetic prompt',
            'next_run_at': '2026-08-10T12:00:00Z',
            '_scheduled_prompt_run_id': 'preclaimed-run',
            'metadata': {
                'workbench_scheduled_prompt': {
                    'definition_id': 'definition-1',
                    'source_prompt_id': 'scheduler.consciousness_continuity_opportunity',
                },
            },
        }
        wb = task['metadata']['workbench_scheduled_prompt']
        storage = MagicMock()

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_refresh_workbench_rendered_prompt', return_value=(task, wb)
        ), patch.object(dispatch, '_glasshive_callback_secret', return_value='secret'), patch.object(
            dispatch, '_write_private_run_detail', return_value='private://detail'
        ), patch.dict(os.environ, {'SCHEDULER_GLASSHIVE_DISABLE_DISPATCH': '1'}, clear=False):
            result = dispatch._dispatch_glasshive_task(task)

        self.assertEqual(
            result['execution']['source_prompt_id'],
            'scheduler.consciousness_continuity_opportunity',
        )

    def test_glasshive_assign_lost_response_reconciles_without_second_assignment(self):
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': 'Synthetic prompt',
            'next_run_at': '2026-08-10T12:00:00Z',
            '_scheduled_prompt_run_id': 'preclaimed-run',
            '_scheduled_prompt_occurrence_key': 'occurrence-key-1',
            'metadata': {'workbench_scheduled_prompt': {'definition_id': 'definition-1'}},
        }
        wb = task['metadata']['workbench_scheduled_prompt']
        storage = MagicMock()

        def post(url, _payload, _headers, _timeout):
            if url.endswith('/find-or-resume'):
                return self.worker_response('worker-1', 'host')
            if url.endswith('/assign'):
                raise URLError('response lost after accept')
            raise AssertionError(url)

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_refresh_workbench_rendered_prompt', return_value=(task, wb)
        ), patch.object(dispatch, '_glasshive_callback_secret', return_value='secret'), patch.object(
            dispatch, '_write_private_run_detail', return_value='private://detail'
        ), patch.object(dispatch, '_ensure_glasshive_project', return_value='project-1'), patch.object(
            dispatch, '_post_json', side_effect=post
        ) as post_json, patch.object(
            dispatch, '_get_json', return_value={'run_id': 'glasshive-run-1'}
        ) as reconcile:
            result = dispatch._dispatch_glasshive_task(task)

        self.assertEqual(result['glasshive_run_id'], 'glasshive-run-1')
        self.assertEqual(sum(call.args[0].endswith('/assign') for call in post_json.call_args_list), 1)
        self.assertIn('occurrence-key-1', reconcile.call_args.args[0])

    def test_glasshive_dispatch_delegates_just_in_time_capabilities_without_credentials(self):
        storage = MagicMock()
        storage.get_scheduled_prompt_definition.return_value = {
            'id': 'definition-1',
            'prompt_text': 'Synthetic prompt',
            'metadata': {},
        }
        calls = []
        worker_payloads = []

        def fake_post(url, payload, _headers, _timeout):
            if url.endswith('/workers/find-or-resume'):
                calls.append('worker')
                worker_payloads.append(payload)
                return self.worker_response('worker-1', 'host')
            if url.endswith('/assign'):
                calls.append('assign')
                return {'run_id': 'glasshive-run-1'}
            raise AssertionError(url)

        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': 'Synthetic prompt',
            'next_run_at': '2026-08-05T12:00:00Z',
            'metadata': {
                'workbench_scheduled_prompt': {
                    'definition_id': 'definition-1',
                    'execution_profile': 'codex-cli',
                    'execution_mode': 'host',
                    'required_capability_servers': ['ms-365'],
                }
            },
        }
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                'VIVENTIUM_PRIVATE_USER_DATA_DIR': temp_dir,
                'SCHEDULER_LIBRECHAT_SECRET': 'scheduler-secret',
                'SCHEDULING_GLASSHIVE_CALLBACK_SECRET': 'callback-secret',
            },
        ), patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_ensure_glasshive_project', side_effect=lambda *_args: calls.append('project') or 'project-1'
        ), patch.object(dispatch, '_post_json', side_effect=fake_post):
            result = dispatch._dispatch_glasshive_task(task)
            created_run = storage.create_scheduled_prompt_run.call_args.args[0]
            private_detail = json.loads(Path(created_run['private_detail_path']).read_text())

        self.assertEqual(calls, ['project', 'worker', 'assign'])
        self.assertEqual(result['glasshive_run_id'], 'glasshive-run-1')
        self.assertNotIn('GLASSHIVE_CAPABILITY_BROKER_TOKEN', json.dumps(worker_payloads[0]))
        self.assertNotIn('glasshive_capability_grant', private_detail)
        self.assertNotIn('GLASSHIVE_CAPABILITY_BROKER_TOKEN', json.dumps(created_run))
        self.assertNotIn('GLASSHIVE_CAPABILITY_BROKER_TOKEN', json.dumps(private_detail))

    def test_glasshive_dispatch_records_runtime_capability_failure(self):
        storage = MagicMock()
        storage.get_scheduled_prompt_definition.return_value = {
            'id': 'definition-1',
            'prompt_text': 'Synthetic prompt',
            'metadata': {},
        }
        action_required = dispatch.HttpJsonError(
            'Reconnect the required account',
            status=409,
            method='POST',
            path='/api/viventium/scheduler/glasshive-capabilities/grant',
            reason='connected_account_action_required',
            failure_class='connected_account_action_required',
            failure_retryable=False,
        )
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': 'Synthetic prompt',
            'metadata': {
                'workbench_scheduled_prompt': {
                    'definition_id': 'definition-1',
                    'execution_profile': 'codex-cli',
                    'execution_mode': 'host',
                    'required_capability_servers': ['ms-365'],
                }
            },
        }
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ,
            {
                'VIVENTIUM_PRIVATE_USER_DATA_DIR': temp_dir,
                'SCHEDULING_GLASSHIVE_CALLBACK_SECRET': 'callback-secret',
            },
        ), patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_post_json', side_effect=action_required
        ), patch.object(dispatch, '_ensure_glasshive_project', return_value='project-1'):
            with self.assertRaises(dispatch.HttpJsonError):
                dispatch._dispatch_glasshive_task(task)

        failed_update = storage.update_scheduled_prompt_run.call_args_list[-1].args[1]
        self.assertEqual(failed_update['status'], 'failed')
        self.assertEqual(failed_update['error_class'], 'connected_account_action_required')

    def test_parallel_isolation_conflict_retries_in_docker_with_rebased_artifacts(self):
        host_root = '/private/user/workspace'
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': f'Write under {host_root}/periphery/health_context.',
            'next_run_at': '2026-08-19T10:15:00Z',
            '_scheduled_prompt_run_id': 'scheduled-run-1',
            '_scheduled_prompt_occurrence_key': 'occurrence-key-1',
            'metadata': {
                'workbench_scheduled_prompt': {
                    'definition_id': 'definition-1',
                    'template_id': 'workbench_daily_health_context_v1',
                    'workspace_root': '/private/host/repository',
                    'my_folder': host_root,
                    'execution_mode': 'host',
                    'fallback_worker_profile': 'claude-code',
                    'fallback_worker_model': 'claude-managed-test',
                    'fallback_reasoning_effort': 'max',
                }
            },
        }
        wb = task['metadata']['workbench_scheduled_prompt']
        storage = MagicMock()
        post_payloads = []

        def post(url, payload, _headers, _timeout):
            post_payloads.append((url, payload))
            if url.endswith('/find-or-resume') and payload['execution_mode'] == 'host':
                self.assertNotIn('fallback_worker_profile', payload)
                self.assertNotIn(
                    'viventium_execution_authority_request',
                    payload['bootstrap_bundle'],
                )
                raise dispatch.HttpJsonError(
                    'isolated execution required',
                    status=409,
                    method='POST',
                    path='/v1/projects/project-1/workers/find-or-resume',
                    failure_class='parallel_execution_isolation_required',
                )
            if url.endswith('/find-or-resume'):
                self.assertEqual(payload['execution_mode'], 'docker')
                self.assertEqual(payload['workspace_root'], '')
                self.assertNotIn('fallback_worker_profile', payload)
                self.assertEqual(
                    payload['bootstrap_bundle'][
                        'viventium_execution_authority_request'
                    ],
                    {
                        'version': 1,
                        'kind': 'prompt_workbench_scheduled',
                        'execution_mode': 'docker',
                        'primary': {
                            'worker_profile': 'codex-cli',
                            'model': 'gpt-managed-test',
                            'reasoning_effort': 'xhigh',
                        },
                        'fallback': {
                            'worker_profile': 'claude-code',
                            'model': 'claude-managed-test',
                            'reasoning_effort': 'max',
                        },
                    },
                )
                self.assertNotIn('execution_policy', payload['bootstrap_bundle'])
                self.assertNotIn('viventium_launch_authority', payload['bootstrap_bundle'])
                rendered = payload['bootstrap_bundle']['files'][0]['content']
                self.assertNotIn(host_root, rendered)
                self.assertIn('artifacts/periphery/health_context', rendered)
                return self.worker_response('worker-docker', 'docker')
            if url.endswith('/assign'):
                self.assertNotIn(host_root, payload['instruction'])
                self.assertIn('relative `artifacts/` root', payload['instruction'])
                return {'run_id': 'glasshive-run-1'}
            raise AssertionError(url)

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_refresh_workbench_rendered_prompt', return_value=(task, wb)
        ), patch.object(dispatch, '_glasshive_callback_secret', return_value='secret'), patch.object(
            dispatch, '_write_private_run_detail', return_value='/private/detail.json'
        ), patch.object(
            dispatch, '_patch_private_run_detail', return_value=True
        ) as patch_detail, patch.object(
            dispatch, '_ensure_glasshive_project', return_value='project-1'
        ), patch.object(dispatch, '_post_json', side_effect=post):
            result = dispatch._dispatch_glasshive_task(task)

        self.assertEqual(
            result['delivery']['reason'], 'glasshive_runtime_recovered_run_queued'
        )
        self.assertEqual(len([url for url, _ in post_payloads if url.endswith('/find-or-resume')]), 2)
        recovery = patch_detail.call_args.args[1]['runtime_recovery']
        self.assertEqual(recovery['reason_class'], 'parallel_execution_isolation_required')
        self.assertEqual(recovery['artifact_return']['module_id'], 'health_context')
        queued = next(
            call.args[1]
            for call in storage.update_scheduled_prompt_run.call_args_list
            if call.args[1].get('status') == 'queued'
        )
        self.assertEqual(queued['execution_snapshot']['effective_execution_mode'], 'docker')
        self.assertEqual(result['execution']['effective_execution_mode'], 'docker')
        self.assertEqual(
            result['execution']['runtime_recovery']['reason_class'],
            'parallel_execution_isolation_required',
        )

    def test_assign_time_parallel_isolation_conflict_rebinds_before_docker_retry(self):
        host_root = '/private/user/workspace'
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': f'Write under {host_root}/periphery/health_context.',
            'next_run_at': '2026-08-19T10:15:00Z',
            '_scheduled_prompt_run_id': 'scheduled-run-1',
            '_scheduled_prompt_occurrence_key': 'occurrence-key-1',
            'metadata': {
                'workbench_scheduled_prompt': {
                    'definition_id': 'definition-1',
                    'template_id': 'workbench_daily_health_context_v1',
                    'workspace_root': '/private/host/repository',
                    'my_folder': host_root,
                    'execution_mode': 'host',
                    'fallback_worker_profile': 'claude-code',
                    'fallback_worker_model': 'claude-managed-test',
                    'fallback_reasoning_effort': 'max',
                }
            },
        }
        wb = task['metadata']['workbench_scheduled_prompt']
        storage = MagicMock()
        workers = []

        def post(url, payload, _headers, _timeout):
            if url.endswith('/find-or-resume'):
                worker_id = (
                    'worker-docker'
                    if payload['execution_mode'] == 'docker'
                    else 'worker-host'
                )
                workers.append(worker_id)
                if payload['execution_mode'] == 'docker':
                    self.assertNotIn('fallback_worker_profile', payload)
                    self.assertEqual(
                        payload['bootstrap_bundle'][
                            'viventium_execution_authority_request'
                        ]['fallback'],
                        {
                            'worker_profile': 'claude-code',
                            'model': 'claude-managed-test',
                            'reasoning_effort': 'max',
                        },
                    )
                return self.worker_response(
                    worker_id,
                    'docker' if worker_id == 'worker-docker' else 'host',
                )
            if url.endswith('/workers/worker-host/assign'):
                raise dispatch.HttpJsonError(
                    'isolated execution required',
                    status=409,
                    method='POST',
                    path='/v1/workers/worker-host/assign',
                    failure_class='parallel_execution_isolation_required',
                )
            if url.endswith('/workers/worker-docker/assign'):
                self.assertIn('relative `artifacts/` root', payload['instruction'])
                raise URLError('response lost after recovered assignment accepted')
            raise AssertionError(url)

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_refresh_workbench_rendered_prompt', return_value=(task, wb)
        ), patch.object(dispatch, '_glasshive_callback_secret', return_value='secret'), patch.object(
            dispatch, '_write_private_run_detail', return_value='/private/detail.json'
        ), patch.object(
            dispatch, '_patch_private_run_detail', return_value=True
        ), patch.object(
            dispatch, '_ensure_glasshive_project', return_value='project-1'
        ), patch.object(dispatch, '_post_json', side_effect=post), patch.object(
            dispatch, '_get_json', return_value={'run_id': 'glasshive-run-1'}
        ) as reconcile:
            result = dispatch._dispatch_glasshive_task(task)

        self.assertEqual(workers, ['worker-host', 'worker-docker'])
        bindings = [
            call.args[1].get('glasshive_worker_id')
            for call in storage.update_scheduled_prompt_run.call_args_list
            if call.args[1].get('glasshive_worker_id')
        ]
        self.assertEqual(bindings[:2], ['worker-host', 'worker-docker'])
        self.assertEqual(result['execution']['effective_execution_mode'], 'docker')
        self.assertIn('worker-docker', reconcile.call_args.args[0])

    def test_declared_docker_mode_uses_one_artifact_contract_for_bootstrap_and_assignment(self):
        host_root = '/private/user/workspace'
        task = {
            'id': 'task-1',
            'user_id': 'user-1',
            'prompt': f'Write under {host_root}/periphery/health_context.',
            'next_run_at': '2026-08-19T10:15:00Z',
            '_scheduled_prompt_run_id': 'scheduled-run-1',
            'metadata': {
                'workbench_scheduled_prompt': {
                    'definition_id': 'definition-1',
                    'template_id': 'workbench_daily_health_context_v1',
                    'my_folder': host_root,
                    'execution_mode': 'docker',
                    'memory_write_mode': 'off',
                    'fallback_worker_profile': 'claude-code',
                    'fallback_worker_model': 'claude-managed-test',
                    'fallback_reasoning_effort': 'max',
                }
            },
        }
        wb = task['metadata']['workbench_scheduled_prompt']
        storage = MagicMock()

        def post(url, payload, _headers, _timeout):
            if url.endswith('/find-or-resume'):
                rendered = payload['bootstrap_bundle']['files'][0]['content']
                self.assertNotIn(host_root, rendered)
                self.assertIn('artifacts/periphery/health_context', rendered)
                self.assertNotIn('fallback_worker_profile', payload)
                self.assertEqual(
                    payload['bootstrap_bundle'][
                        'viventium_execution_authority_request'
                    ]['fallback'],
                    {
                        'worker_profile': 'claude-code',
                        'model': 'claude-managed-test',
                        'reasoning_effort': 'max',
                    },
                )
                self.assertNotIn('execution_policy', payload['bootstrap_bundle'])
                self.assertNotIn('viventium_launch_authority', payload['bootstrap_bundle'])
                return self.worker_response('worker-docker', 'docker')
            if url.endswith('/assign'):
                self.assertNotIn(host_root, payload['instruction'])
                self.assertIn('relative `artifacts/` root', payload['instruction'])
                return {'run_id': 'glasshive-run-1'}
            raise AssertionError(url)

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch, '_refresh_workbench_rendered_prompt', return_value=(task, wb)
        ), patch.object(dispatch, '_glasshive_callback_secret', return_value='secret'), patch.object(
            dispatch, '_write_private_run_detail', return_value='/private/detail.json'
        ) as private_writer, patch.object(
            dispatch, '_ensure_glasshive_project', return_value='project-1'
        ), patch.object(dispatch, '_post_json', side_effect=post):
            result = dispatch._dispatch_glasshive_task(task)

        detail = private_writer.call_args.args[1]
        self.assertEqual(detail['artifact_return']['module_id'], 'health_context')
        self.assertEqual(result['delivery']['reason'], 'glasshive_isolated_run_queued')
        self.assertEqual(result['execution']['effective_execution_mode'], 'docker')
        self.assertNotIn('runtime_recovery', result['execution'])

    def test_workbench_worker_tuple_mismatch_fails_closed(self):
        expected = {
            'profile': 'codex-cli',
            'model': 'gpt-managed-test',
            'execution_mode': 'docker',
        }

        for worker in (
            {'worker_id': 'worker-missing'},
            self.worker_response('worker-profile', 'docker', profile='claude-code'),
            self.worker_response('worker-model', 'docker', model='wrong-model'),
            self.worker_response('worker-mode', 'host'),
        ):
            with self.subTest(worker=worker):
                with self.assertRaisesRegex(RuntimeError, 'tuple mismatch'):
                    dispatch._verify_workbench_worker_tuple(worker, expected)


class DispatchTelegramTests(unittest.TestCase):
    def setUp(self):
        os.environ['SCHEDULER_LIBRECHAT_SECRET'] = 'scheduler_secret'
        os.environ['SCHEDULER_TELEGRAM_SECRET'] = 'telegram_secret'
        os.environ['SCHEDULER_TELEGRAM_BOT_TOKEN'] = 'bot_token'

    def tearDown(self):
        os.environ.pop('SCHEDULER_LIBRECHAT_SECRET', None)
        os.environ.pop('SCHEDULER_TELEGRAM_SECRET', None)
        os.environ.pop('SCHEDULER_TELEGRAM_BOT_TOKEN', None)
        os.environ.pop('SCHEDULER_PROMPT_PREFIX', None)
        os.environ.pop('SCHEDULER_TELEGRAM_INSIGHT_FALLBACK', None)
        os.environ.pop('VIVENTIUM_TELEGRAM_INSIGHT_FALLBACK', None)
        os.environ.pop('SCHEDULER_FOLLOWUP_TIMEOUT_S', None)
        os.environ.pop('SCHEDULER_FOLLOWUP_TOTAL_WAIT_S', None)
        os.environ.pop('SCHEDULER_FOLLOWUP_ACTIVE_GRACE_S', None)
        os.environ.pop('SCHEDULER_TELEGRAM_FOLLOWUP_TIMEOUT_S', None)
        os.environ.pop('SCHEDULER_TELEGRAM_FOLLOWUP_GRACE_S', None)
        os.environ.pop('VIVENTIUM_TELEGRAM_FOLLOWUP_TIMEOUT_S', None)
        os.environ.pop('VIVENTIUM_TELEGRAM_FOLLOWUP_GRACE_S', None)

    def test_core_accept_lost_response_reconciles_by_occurrence_without_second_generation(self):
        task = {
            'id': 'task-core-reconcile',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'synthetic prompt',
            'channel': 'librechat',
            'conversation_policy': 'new',
            '_scheduled_prompt_occurrence_key': 'occurrence-core-1',
            'metadata': None,
        }
        with patch.object(
            dispatch, '_post_json', side_effect=URLError('response lost after accept')
        ) as post_json, patch.object(
            dispatch,
            '_get_json',
            return_value={'streamId': 'stream-existing', 'conversationId': 'conversation-existing'},
        ) as reconcile, patch.object(
            dispatch, '_stream_scheduler_response', return_value=('canonical', 'message-1', '')
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': '', 'canonical_text_source': ''},
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

        self.assertEqual(result['conversation_id'], 'conversation-existing')
        self.assertEqual(post_json.call_count, 1)
        self.assertIn('occurrence-core-1', reconcile.call_args.args[0])
        self.assertEqual(post_json.call_args.args[1]['idempotencyKey'], 'occurrence-core-1')

    def test_scheduler_generation_keeps_logical_turn_from_chat_accept_response(self):
        task = {
            'id': 'task-logical-turn',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'synthetic prompt',
            'channel': ['librechat', 'telegram'],
            'conversation_policy': 'new',
            'metadata': None,
        }
        with patch.object(
            dispatch,
            '_post_json',
            return_value={
                'streamId': 'stream-1',
                'conversationId': 'conversation-1',
                'logical_turn_id': 'turn-from-accept',
                'revision': 4,
            },
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('canonical', 'message-1', '', {}),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': '', 'canonical_text_source': ''},
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

        self.assertEqual(result['logical_turn_id'], 'turn-from-accept')
        self.assertEqual(result['revision'], 4)

    def test_resolve_telegram_identity_uses_metadata(self):
        task = {
            'user_id': 'user_1',
            'metadata': {
                'telegram_user_id': 'tg-1',
                'telegram_chat_id': 'chat-1',
            },
        }
        with patch.object(dispatch, '_post_json') as mock_post:
            user_id, chat_id, voice_preferences = dispatch._resolve_telegram_identity(
                task,
                'http://localhost:3080',
                10,
            )
            mock_post.assert_not_called()
            self.assertEqual(user_id, 'tg-1')
            self.assertEqual(chat_id, 'chat-1')
            self.assertFalse(voice_preferences['always_voice_response'])
            self.assertTrue(voice_preferences['voice_responses_enabled'])

    def test_resolve_telegram_identity_calls_scheduler(self):
        task = {'user_id': 'user_1', 'metadata': None}

        def fake_post(url, payload, headers, timeout_s):
            self.assertIn('/api/viventium/scheduler/telegram/resolve', url)
            self.assertEqual(payload.get('userId'), 'user_1')
            return {
                'telegram_user_id': 'tg-2',
                'telegram_chat_id': 'tg-2',
                'voice_preferences': {
                    'always_voice_response': True,
                    'voice_responses_enabled': True,
                },
            }

        with patch.object(dispatch, '_post_json', side_effect=fake_post):
            user_id, chat_id, voice_preferences = dispatch._resolve_telegram_identity(
                task,
                'http://localhost:3080',
                10,
            )
            self.assertEqual(user_id, 'tg-2')
            self.assertEqual(chat_id, 'tg-2')
            self.assertTrue(voice_preferences['always_voice_response'])
            self.assertTrue(voice_preferences['voice_responses_enabled'])

    # === VIVENTIUM NOTE ===
    # Feature: Inject configurable prefix for scheduled prompts.
    def test_compose_prompt_injects_prefix(self):
        os.environ['SCHEDULER_PROMPT_PREFIX'] = (
            '<!--viv_internal:brew_begin-->\n'
            '## Background Processing (Brewing)\n'
            "You're seeing a scheduled self-prompt (not user input). "
            'Treat it like you just remembered something or something just came to you from yourself.'
        )
        task = {'prompt': 'Take vitamin C'}
        composed = dispatch._compose_prompt(task)
        self.assertIn('Background Processing (Brewing)', composed)
        self.assertIn('scheduled self-prompt', composed)
        self.assertIn('live external facts', composed)
        self.assertIn('verified tool/cortex result', composed)
        self.assertIn('omit that section', composed)
        self.assertIn('Take vitamin C', composed)
        self.assertTrue(composed.startswith('<!--viv_internal:brew_begin-->'))
    # === VIVENTIUM NOTE ===

    def test_compose_prompt_uses_default_prefix_when_env_missing(self):
        task = {'prompt': 'Take vitamin C'}
        composed = dispatch._compose_prompt(task)
        self.assertIn('Background Processing (Brewing)', composed)
        self.assertIn('scheduled self-prompt', composed)
        self.assertIn('Scheduled Run Context (Deterministic)', composed)
        self.assertIn('scheduled_due_local_date', composed)
        self.assertIn('live external facts', composed)
        self.assertIn('verified tool/cortex result', composed)
        self.assertIn('omit that section', composed)
        self.assertIn('Take vitamin C', composed)
        self.assertTrue(composed.startswith('<!--viv_internal:brew_begin-->'))

    def test_compose_prompt_injects_due_local_date_and_calendar_window(self):
        task = {
            'id': 'task-context',
            'prompt': 'Prepare the morning briefing.',
            'schedule': {'type': 'daily', 'time': '08:00', 'timezone': 'America/Los_Angeles'},
            'next_run_at': '2026-06-15T15:00:00Z',
        }

        composed = dispatch._compose_prompt(
            task,
            now_utc=datetime(2026, 6, 15, 15, 0, 26, tzinfo=timezone.utc),
        )

        self.assertIn('Scheduled Run Context (Deterministic)', composed)
        self.assertIn('scheduled_due_at_utc: 2026-06-15T15:00:00Z', composed)
        self.assertIn('scheduled_due_local_date: Monday, June 15, 2026', composed)
        self.assertIn('scheduled_due_local_date_iso: 2026-06-15', composed)
        self.assertIn('schedule_timezone: America/Los_Angeles', composed)
        self.assertIn('calendar_window_utc_start: 2026-06-15T07:00:00Z', composed)
        self.assertIn('calendar_window_utc_end_exclusive: 2026-06-16T07:00:00Z', composed)
        self.assertIn('Do not carry forward dates', composed)
        self.assertIn('calendar, email, tasks', composed)

    def test_scheduled_date_guard_corrects_opening_wrong_day(self):
        task = {
            'schedule': {'type': 'daily', 'time': '08:00', 'timezone': 'America/Los_Angeles'},
            'next_run_at': '2026-06-15T15:00:00Z',
        }
        context = dispatch._build_scheduled_run_context(
            task,
            now_utc=datetime(2026, 6, 15, 15, 0, 26, tzinfo=timezone.utc),
        )

        final_text, followup_text, guard = dispatch._apply_scheduled_date_guard(
            'Monday, June 16. Here is the briefing.',
            '',
            context,
        )

        self.assertIn('Monday, June 15, 2026. Here is the briefing.', final_text)
        self.assertEqual(followup_text, '')
        self.assertEqual(guard['final']['status'], 'corrected')
        self.assertEqual(guard['final']['expected'], 'Monday, June 15, 2026')
        self.assertEqual(guard['final']['claim'], 'Monday, June 16')

    def test_scheduled_date_guard_does_not_rewrite_event_date_in_opening_sentence(self):
        task = {
            'schedule': {'type': 'daily', 'time': '08:00', 'timezone': 'America/Los_Angeles'},
            'next_run_at': '2026-06-15T15:00:00Z',
        }
        context = dispatch._build_scheduled_run_context(
            task,
            now_utc=datetime(2026, 6, 15, 15, 0, 26, tzinfo=timezone.utc),
        )
        original = 'Good morning. Your flight Tuesday, June 16 is confirmed.'

        final_text, followup_text, guard = dispatch._apply_scheduled_date_guard(
            original,
            '',
            context,
        )

        self.assertEqual(final_text, original)
        self.assertEqual(followup_text, '')
        self.assertEqual(guard['final']['status'], 'mismatch_unmodified')
        self.assertEqual(guard['final']['reason'], 'opening_date_not_leading')

    def test_compose_prompt_does_not_double_prefix_existing_scheduled_prompt(self):
        existing = (
            '<!--viv_internal:brew_begin-->\n'
            '## Background Processing (Brewing)\n'
            'This is a scheduled self-prompt.\n\n'
            'Take vitamin C'
        )
        task = {'prompt': existing}
        composed = dispatch._compose_prompt(task)
        self.assertTrue(composed.startswith(existing))
        self.assertEqual(composed.count('<!--viv_internal:brew_begin-->'), 1)
        self.assertIn('live external facts', composed)
        self.assertIn('verified tool/cortex result', composed)
        self.assertIn('omit that section', composed)

    def test_late_delivery_notice_is_prepended_to_visible_delivery(self):
        task = {
            'id': 'task-late',
            'user_id': 'user_1',
            'metadata': {
                'scheduler_misfire': {
                    'mode': 'catch_up',
                    'due_at': '2026-02-13T19:00:00Z',
                    'due_at_local': '2026-02-13 19:00 UTC',
                    'delivered_at': '2026-02-13T20:24:52Z',
                    'late_seconds': 5092,
                    'late_minutes': 85,
                    'max_late_s': 43200,
                },
            },
        }
        visibility = dispatch._prepare_generated_visibility(
            task,
            'Meditate before the day runs away.',
            '',
        )

        patched = dispatch._apply_late_delivery_notice(task, visibility)

        self.assertTrue(
            patched['final_text'].startswith(
                'Late reminder: originally scheduled for 2026-02-13 19:00 UTC; '
                'delivered 85 minutes late.'
            )
        )
        self.assertEqual(patched['generated_text'], patched['final_text'])
        librechat_detail = dispatch._build_librechat_delivery_detail(patched)
        self.assertEqual(librechat_detail.get('late_delivery', {}).get('late_seconds'), 5092)

        with patch.object(dispatch, '_resolve_telegram_identity') as mock_identity, patch.object(
            dispatch,
            '_send_telegram_voice_or_text',
        ) as mock_send:
            mock_identity.return_value = ('tg-1', 'chat-1', {'voice_responses_enabled': False})

            telegram_detail = dispatch._deliver_telegram_generated_text(
                task,
                'http://localhost:3080',
                10,
                None,
                patched,
            )

        mock_send.assert_called_once()
        sent_text = mock_send.call_args.args[1]
        self.assertTrue(sent_text.startswith('Late reminder: originally scheduled for 2026-02-13 19:00 UTC'))
        self.assertEqual(telegram_detail.get('late_delivery', {}).get('late_minutes'), 85)

    def test_silent_telegram_fanout_does_not_require_identity_or_transport(self):
        task = {'id': 'task-silent'}
        visibility = dispatch._prepare_generated_visibility(task, '', '')

        with patch.object(dispatch, '_resolve_telegram_identity') as identity, patch.object(
            dispatch,
            '_send_telegram_voice_or_text',
        ) as send:
            detail = dispatch._deliver_telegram_generated_text(
                task,
                'http://localhost:3080',
                10,
                None,
                visibility,
            )

        identity.assert_not_called()
        send.assert_not_called()
        self.assertEqual(detail['outcome'], 'suppressed')
        self.assertEqual(detail['reason'], 'empty')

    def test_dispatch_task_sends_telegram_message(self):
        task = {
            'id': 'task-1',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-1',
                'final_text': 'final response',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-3', 'tg-3', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_called_once()
            args, _kwargs = mock_send.call_args
            self.assertEqual(args[0], 'tg-3')
            self.assertEqual(args[1], 'final response')
            self.assertEqual(result.get('conversation_id'), 'new')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), 'final response')
        # === VIVENTIUM NOTE ===

    def test_format_insight_fallback_is_human_like(self):
        insights = [
            {'cortex_name': 'Online Tool Use', 'insight': 'First insight.'},
            {'cortex_name': 'Pattern Recognition', 'insight': 'Second insight.'},
        ]
        text = dispatch._format_insight_fallback(insights)
        self.assertIn('First insight.', text)
        self.assertIn('Second insight.', text)
        self.assertNotIn('Background insights', text)
        self.assertNotIn('Online Tool Use', text)
        self.assertNotIn('Pattern Recognition', text)

    # === VIVENTIUM NOTE ===
    # Feature: Ensure scheduled Telegram dispatch sends background follow-ups.
    def test_dispatch_task_sends_followup_from_stream(self):
        task = {
            'id': 'task-2',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-2',
                'final_text': 'final response',
                'followup_text': 'follow-up',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-4', 'tg-4', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            self.assertEqual(mock_send.call_count, 2)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'final response')
            self.assertEqual(mock_send.call_args_list[1].args[1], 'follow-up')
            self.assertEqual(result.get('conversation_id'), 'new')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), 'final response')

    def test_post_json_surfaces_scheduler_auth_reason(self):
        error = HTTPError(
            url='http://localhost:3080/api/viventium/scheduler/chat',
            code=401,
            msg='Unauthorized',
            hdrs=None,
            fp=BytesIO(b'{"error":"Unauthorized scheduler gateway","reason":"secret_mismatch"}'),
        )

        with patch('urllib.request.urlopen', side_effect=error):
            with self.assertRaisesRegex(
                RuntimeError,
                r'HTTP 401 \(secret_mismatch\): Unauthorized scheduler gateway',
            ):
                dispatch._post_json(
                    'http://localhost:3080/api/viventium/scheduler/chat',
                    {'userId': 'user_1'},
                    {'x-viventium-scheduler-secret': 'bad'},
                    10,
                )

    def test_run_scheduler_generation_promotes_canonical_parent_text(self):
        task = {
            'id': 'task-canonical',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'librechat',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-canonical', 'conversationId': 'conv-canonical'},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('{NTA}', 'msg-canonical', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': 'Fresh canonical summary'},
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(result.get('conversation_id'), 'conv-canonical')
            self.assertEqual(result.get('response_message_id'), 'msg-canonical')
            self.assertEqual(result.get('final_text'), 'Fresh canonical summary')
            self.assertEqual(result.get('final_text_source'), 'canonical_parent')
            self.assertEqual(result.get('followup_text'), '')

    def test_run_scheduler_generation_posts_scheduler_run_context(self):
        task = {
            'id': 'task-run-context',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'prepare morning briefing',
            'channel': 'telegram',
            'conversation_policy': 'same',
            'schedule': {'type': 'daily', 'time': '08:00', 'timezone': 'America/Los_Angeles'},
            'next_run_at': '2026-06-15T15:00:00Z',
            'metadata': {
                'source_prompt_id': 'scheduler.consciousness_continuity_opportunity',
                'recurrence_state_v1': {
                    'version': 1,
                    'last_run_at': '2026-06-14T15:00:00Z',
                    'outcome': 'sent',
                    'reason': 'delivered',
                    'result_excerpt': 'Yesterday was clear.',
                    'result_sha256': 'a' * 64,
                },
            },
        }
        seen_payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            seen_payloads.append(payload)
            return {'streamId': 'stream-run-context', 'conversationId': 'conv-run-context'}

        with patch.dict(
            os.environ,
            {
                'VIVENTIUM_SCHEDULED_AGENT_PROVIDER': 'openai',
                'VIVENTIUM_SCHEDULED_AGENT_MODEL': 'gpt-5.6-sol',
                'VIVENTIUM_SCHEDULED_AGENT_REASONING_EFFORT': 'xhigh',
            },
            clear=False,
        ), patch.object(
            dispatch,
            '_utc_now',
            return_value=datetime(2026, 6, 15, 15, 0, 26, tzinfo=timezone.utc),
        ), patch.object(
            dispatch,
            '_post_json',
            side_effect=fake_post,
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('Monday, June 15, 2026. Clear.', 'msg-run-context', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': ''},
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'conv-1')

        payload = seen_payloads[0]
        self.assertEqual(payload['clientTimestamp'], '2026-06-15T15:00:26Z')
        self.assertEqual(payload['scheduledDueAt'], '2026-06-15T15:00:00Z')
        self.assertEqual(payload['schedulerRunContext']['scheduled_due_local_date'], 'Monday, June 15, 2026')
        self.assertEqual(payload['schedulerRunContext']['scheduled_due_local_date_iso'], '2026-06-15')
        self.assertNotIn('model', payload)
        self.assertNotIn('reasoning_effort', payload)
        self.assertEqual(
            payload['sourcePromptId'],
            'scheduler.consciousness_continuity_opportunity',
        )
        self.assertNotIn('scheduledAgentExecution', payload)
        self.assertIn('Scheduled Run Context (Deterministic)', payload['text'])
        self.assertEqual(payload['titleText'], 'prepare morning briefing')
        self.assertEqual(payload['recurrenceState']['version'], 1)
        self.assertEqual(payload['recurrenceState']['result_excerpt'], 'Yesterday was clear.')
        self.assertNotIn(dispatch.BREW_PROMPT_MARKER, payload['titleText'])
        self.assertNotIn('model', result['execution'])
        self.assertNotIn('reasoning_effort', result['execution'])
        self.assertEqual(
            result['execution']['source_prompt_id'],
            'scheduler.consciousness_continuity_opportunity',
        )
        self.assertEqual(result['date_guard']['final']['status'], 'passed')

    def test_run_scheduler_generation_projects_structured_qa_provenance(self):
        task = {
            'id': 'task-qa',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'synthetic QA schedule',
            'channel': 'librechat',
            'conversation_policy': 'new',
            '_scheduled_prompt_run_id': 'run-qa-123',
            'metadata': {'qa_disposable': True},
        }
        seen_payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            seen_payloads.append(payload)
            return {'streamId': 'stream-qa', 'conversationId': 'conv-qa'}

        with patch.object(dispatch, '_post_json', side_effect=fake_post), patch.object(
            dispatch,
            '_get_json',
            return_value={'externalWork': {}},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('QA completed.', 'msg-qa', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': ''},
        ):
            dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

        self.assertTrue(seen_payloads[0]['viventiumQaRun'])
        self.assertEqual(seen_payloads[0]['viventiumQaRunId'], 'run-qa-123')

        task['metadata'] = {}
        seen_payloads.clear()
        with patch.object(dispatch, '_post_json', side_effect=fake_post), patch.object(
            dispatch,
            '_get_json',
            return_value={'externalWork': {}},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('Normal completed.', 'msg-normal', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': ''},
        ):
            dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

        self.assertNotIn('viventiumQaRun', seen_payloads[0])
        self.assertNotIn('viventiumQaRunId', seen_payloads[0])

    def test_run_scheduler_generation_projects_channel_contract_and_reads_external_work(self):
        task = {
            'id': 'task-external-work',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'delegate a synthetic long mission',
            'channel': ['telegram', 'librechat'],
            'conversation_policy': 'new',
            '_scheduled_prompt_occurrence_key': 'schedule:occurrence-external',
            'metadata': None,
        }
        seen_payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            seen_payloads.append(payload)
            return {'streamId': 'stream-external', 'conversationId': 'conv-external'}

        with patch.object(dispatch, '_post_json', side_effect=fake_post), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('Mission accepted.', 'msg-external', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': ''},
        ), patch.object(
            dispatch,
            '_get_json',
            return_value={
                'state': 'accepted',
                'externalWork': {
                    'requiredTotal': 1,
                    'requiredTerminal': 0,
                    'allRequiredTerminal': False,
                    'state': 'waiting_external',
                },
            },
        ) as reconcile:
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

        self.assertEqual(seen_payloads[0]['deliveryChannels'], ['telegram', 'librechat'])
        self.assertEqual(seen_payloads[0]['idempotencyKey'], 'schedule:occurrence-external')
        self.assertIn('/api/viventium/scheduler/dispatches/', reconcile.call_args.args[0])
        self.assertEqual(result['external_work']['state'], 'waiting_external')
        self.assertEqual(result['external_work']['requiredTotal'], 1)

    def test_legacy_scheduled_agent_environment_cannot_override_main_agent(self):
        with patch.dict(
            os.environ,
            {
                'VIVENTIUM_SCHEDULED_AGENT_PROVIDER': 'openai',
                'VIVENTIUM_SCHEDULED_AGENT_MODEL': 'gpt-5.6-sol',
                'VIVENTIUM_SCHEDULED_AGENT_REASONING_EFFORT': '',
            },
            clear=False,
        ):
            self.assertFalse(hasattr(dispatch, '_scheduled_agent_execution'))

    def test_run_scheduler_generation_omits_execution_when_policy_is_unset(self):
        task = {
            'id': 'task-no-execution-policy',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'prepare a synthetic briefing',
            'channel': 'librechat',
            'conversation_policy': 'new',
            'metadata': None,
        }
        seen_payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            seen_payloads.append(payload)
            return {'streamId': 'stream-no-policy', 'conversationId': 'conv-no-policy'}

        with patch.dict(
            os.environ,
            {
                'VIVENTIUM_SCHEDULED_AGENT_PROVIDER': '',
                'VIVENTIUM_SCHEDULED_AGENT_MODEL': '',
                'VIVENTIUM_SCHEDULED_AGENT_REASONING_EFFORT': '',
            },
            clear=False,
        ), patch.object(
            dispatch,
            '_post_json',
            side_effect=fake_post,
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('Synthetic response', 'msg-no-policy', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': ''},
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

        payload = seen_payloads[0]
        self.assertNotIn('scheduledAgentExecution', payload)
        self.assertNotIn('model', payload)
        self.assertNotIn('reasoning_effort', payload)
        self.assertEqual(result['execution'], {})

    def test_run_scheduler_generation_corrects_delivery_without_persisting_history(self):
        task = {
            'id': 'task-run-context-corrected',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'prepare morning briefing',
            'channel': 'telegram',
            'conversation_policy': 'same',
            'schedule': {'type': 'daily', 'time': '08:00', 'timezone': 'America/Los_Angeles'},
            'next_run_at': '2026-06-15T15:00:00Z',
            'metadata': None,
        }
        seen_posts = []

        def fake_post(url, payload, _headers, _timeout_s):
            seen_posts.append((url, payload))
            if url.endswith('/api/viventium/scheduler/chat'):
                return {'streamId': 'stream-run-context', 'conversationId': 'conv-run-context'}
            self.fail(f'unexpected post url: {url}')

        with patch.object(
            dispatch,
            '_utc_now',
            return_value=datetime(2026, 6, 15, 15, 0, 26, tzinfo=timezone.utc),
        ), patch.object(
            dispatch,
            '_post_json',
            side_effect=fake_post,
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('Monday, June 16. Wrong day.', 'msg-run-context', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={'followup_text': '', 'canonical_text': ''},
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'conv-1')

        self.assertEqual(len(seen_posts), 1)
        self.assertTrue(seen_posts[0][0].endswith('/api/viventium/scheduler/chat'))
        self.assertEqual(result['final_text'], 'Monday, June 15, 2026. Wrong day.')
        self.assertEqual(result['date_guard']['final']['status'], 'corrected')
        self.assertNotIn('persisted_message', result['date_guard'])

    def test_scheduler_stream_returns_on_final_event_without_linger(self):
        seen = {}

        def fake_payloads(url, headers, timeout_s):
            seen['url'] = url
            seen['headers'] = headers
            seen['timeout_s'] = timeout_s
            yield json.dumps(
                {
                    'event': 'on_message_delta',
                    'data': {'delta': {'content': [{'text': 'partial'}]}},
                }
            )
            yield json.dumps(
                {
                    'final': True,
                    'responseMessage': {
                        'messageId': 'msg-final',
                        'text': 'Final scheduled text',
                    },
                }
            )
            raise AssertionError('stream reader should stop after final event')

        with patch.object(dispatch, '_iter_sse_payloads', side_effect=fake_payloads):
            final_text, response_message_id, followup_text = dispatch._stream_scheduler_response(
                'http://localhost:3080',
                'stream-final',
                'user_1',
                'secret',
                120,
            )

        self.assertEqual(final_text, 'Final scheduled text')
        self.assertEqual(response_message_id, 'msg-final')
        self.assertEqual(followup_text, '')
        self.assertNotIn('linger=', seen['url'])
        self.assertIn('/api/viventium/scheduler/stream/stream-final', seen['url'])

    def test_scheduler_stream_preserves_safe_structured_generation_failure(self):
        def fake_payloads(_url, _headers, _timeout_s):
            yield json.dumps(
                {
                    'final': True,
                    'responseMessage': {
                        'messageId': 'msg-provider-error',
                        'text': '',
                        'content': [
                            {
                                'type': 'error',
                                'error': 'Bearer synthetic-private-provider-detail',
                                'error_class': 'provider_unauthorized',
                                'failure_retryable': False,
                            }
                        ],
                    },
                }
            )

        with patch.object(dispatch, '_iter_sse_payloads', side_effect=fake_payloads):
            result = dispatch._stream_scheduler_response(
                'http://localhost:3080',
                'stream-provider-error',
                'user_1',
                'secret',
                120,
                return_metadata=True,
            )

        self.assertEqual(result[:3], ('', 'msg-provider-error', ''))
        self.assertEqual(
            result[3].get('generation_failure'),
            {'error_class': 'provider_unauthorized', 'failure_retryable': False},
        )
        self.assertNotIn('synthetic-private-provider-detail', str(result))

    def test_scheduled_failure_notice_never_claims_an_unscheduled_retry(self):
        notice = dispatch._scheduled_generation_failure_notice(
            'provider_rate_limited',
            False,
        )

        self.assertIn('no automatic retry is scheduled', notice)
        self.assertNotIn('remain available for retry', notice)

        missing_auth = dispatch._scheduled_generation_failure_notice(
            'provider_auth_missing',
            False,
            'terminal_action_required',
        )
        self.assertIn('provider connection is missing', missing_auth)
        self.assertIn('action is required', missing_auth)

        self.assertIn(
            'will retry automatically',
            dispatch._scheduled_generation_failure_notice(
                'provider_rate_limited',
                True,
                'retry_scheduled',
            ),
        )
        self.assertIn(
            'next scheduled occurrence remains',
            dispatch._scheduled_generation_failure_notice(
                'provider_rate_limited',
                True,
                'next_occurrence_only',
            ),
        )

    def test_one_time_retry_transition_and_notice_share_the_exact_retry_time(self):
        task = {
            'id': 'task-retry-time',
            'schedule': {'type': 'once', 'at': '2026-08-20T14:00:00Z', 'timezone': 'UTC'},
            'metadata': {},
            '_scheduled_prompt_attempted_at': '2026-08-20T14:00:00Z',
            '_scheduled_prompt_retry_delay_s': 300,
        }

        transition = dispatch.resolve_scheduled_failure_transition(
            task,
            'provider_rate_limited',
            True,
        )
        notice = dispatch._scheduled_generation_failure_notice(
            'provider_rate_limited',
            transition['retryable'],
            transition['retry_disposition'],
            transition.get('next_attempt_at'),
        )

        self.assertEqual(transition['next_attempt_at'], '2026-08-20T14:05:00Z')
        self.assertIn('2026-08-20T14:05:00Z', notice)

    def test_run_scheduler_generation_returns_structured_provider_failure_without_polling(self):
        task = {
            'id': 'task-provider-error',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'perform required external work',
            'channel': ['librechat', 'telegram'],
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-provider-error', 'conversationId': 'conv-provider-error'},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=(
                '',
                'msg-provider-error',
                '',
                {'generation_failure': {'error_class': 'provider_unauthorized'}},
            ),
        ), patch.object(dispatch, '_poll_scheduler_followup') as poll, patch.object(
            dispatch,
            '_get_json',
            return_value={'externalWork': {}},
        ):
            result = dispatch._run_scheduler_generation(
                task,
                'http://localhost:3080',
                10,
                'new',
            )

        self.assertEqual(
            result.get('generation_failure'),
            {'error_class': 'provider_unauthorized'},
        )
        self.assertEqual(result.get('conversation_id'), 'conv-provider-error')
        self.assertEqual(result.get('response_message_id'), 'msg-provider-error')
        poll.assert_not_called()

    def test_scheduled_generation_default_stream_window_supports_xhigh_runs(self):
        task = {
            'id': 'task-xhigh-window',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'appraise current state',
            'channel': 'workbench',
            'conversation_policy': 'same',
            'metadata': None,
        }

        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('SCHEDULER_STREAM_TIMEOUT_S', None)
            with patch.object(
                dispatch,
                '_post_json',
                return_value={'streamId': 'stream-xhigh-window', 'conversationId': 'conv-1'},
            ), patch.object(
                dispatch,
                '_stream_scheduler_response',
                return_value=('{NTA}', 'msg-xhigh-window', ''),
            ) as stream_response, patch.object(
                dispatch,
                '_poll_scheduler_followup',
                return_value={'followup_text': '', 'canonical_text': ''},
            ):
                dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'conv-1')

        self.assertEqual(stream_response.call_args.args[4], 600)

    def test_scheduled_generation_timeout_explicitly_cancels_model_authoring(self):
        task = {
            'id': 'task-timeout-cancel',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'appraise current state',
            'channel': 'workbench',
            'conversation_policy': 'same',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            side_effect=[
                {'streamId': 'stream-timeout', 'conversationId': 'conv-1'},
                {'success': True, 'cancelled': 'stream-timeout'},
            ],
        ) as post_json, patch.object(
            dispatch,
            '_stream_scheduler_response',
            side_effect=TimeoutError('scheduled stream timed out'),
        ):
            with self.assertRaisesRegex(TimeoutError, 'scheduled stream timed out'):
                dispatch._run_scheduler_generation(
                    task,
                    'http://localhost:3080',
                    10,
                    'conv-1',
                )

        cancel_call = post_json.call_args_list[1]
        self.assertEqual(
            cancel_call.args[0],
            'http://localhost:3080/api/viventium/scheduler/stream/stream-timeout/cancel',
        )
        self.assertEqual(cancel_call.args[1], {'userId': 'user_1', 'reason': 'stream_timeout'})
        self.assertEqual(
            cancel_call.args[2]['X-VIVENTIUM-SCHEDULER-SECRET'],
            'scheduler_secret',
        )

    def test_telegram_stream_returns_on_final_event_without_linger(self):
        seen = {}

        def fake_payloads(url, headers, timeout_s):
            seen['url'] = url
            seen['headers'] = headers
            seen['timeout_s'] = timeout_s
            yield json.dumps(
                {
                    'event': 'on_message_delta',
                    'data': {'delta': {'content': [{'text': 'partial'}]}},
                }
            )
            yield json.dumps(
                {
                    'final': True,
                    'responseMessage': {
                        'messageId': 'msg-telegram-final',
                        'text': 'Final Telegram text',
                    },
                }
            )
            raise AssertionError('telegram stream reader should stop after final event')

        with patch.object(dispatch, '_iter_sse_payloads', side_effect=fake_payloads):
            final_text, response_message_id, followup_text = dispatch._stream_telegram_response(
                'http://localhost:3080',
                'stream-telegram-final',
                'tg-user',
                'tg-chat',
                'secret',
                120,
            )

        self.assertEqual(final_text, 'Final Telegram text')
        self.assertEqual(response_message_id, 'msg-telegram-final')
        self.assertEqual(followup_text, '')
        self.assertNotIn('linger=', seen['url'])
        self.assertIn('/api/viventium/telegram/stream/stream-telegram-final', seen['url'])

    def test_run_scheduler_generation_marks_promoted_deferred_fallback_source(self):
        task = {
            'id': 'task-canonical-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-canonical-fallback', 'conversationId': 'conv-canonical-fallback'},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('{NTA}', 'msg-canonical-fallback', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={
                'followup_text': '',
                'canonical_text': 'Best-effort fallback summary',
                'canonical_text_source': 'deferred_fallback',
                'canonical_text_fallback_reason': 'insight_fallback',
            },
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(result.get('final_text'), 'Best-effort fallback summary')
            self.assertEqual(result.get('final_text_source'), 'deferred_fallback')
            self.assertEqual(result.get('final_text_fallback_reason'), 'insight_fallback')

    def test_run_scheduler_generation_preserves_empty_scheduled_fallback_reason(self):
        task = {
            'id': 'task-empty-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-empty-fallback', 'conversationId': 'conv-empty-fallback'},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('{NTA}', 'msg-empty-fallback', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={
                'followup_text': '',
                'canonical_text': '',
                'canonical_text_source': 'deferred_fallback',
                'canonical_text_fallback_reason': 'empty_deferred_response',
            },
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(result.get('final_text'), '{NTA}')
            self.assertEqual(result.get('suppressed_fallback_reason'), 'empty_deferred_response')

    def test_run_scheduler_generation_dedupes_matching_followup_text(self):
        task = {
            'id': 'task-canonical-dedupe',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'librechat',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-canonical-dedupe', 'conversationId': 'conv-canonical-dedupe'},
        ), patch.object(
            dispatch,
            '_stream_scheduler_response',
            return_value=('{NTA}', 'msg-canonical-dedupe', ''),
        ), patch.object(
            dispatch,
            '_poll_scheduler_followup',
            return_value={
                'followup_text': 'Fresh canonical summary',
                'canonical_text': 'Fresh canonical summary',
            },
        ):
            result = dispatch._run_scheduler_generation(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(result.get('final_text'), 'Fresh canonical summary')
            self.assertEqual(result.get('followup_text'), '')

    def test_scheduler_followup_poll_uses_telegram_parity_settings_for_telegram_tasks(self):
        task = {
            'id': 'task-followup-telegram',
            'channel': ['telegram', 'librechat'],
        }

        with patch.object(
            dispatch,
            '_poll_followup_state',
            return_value={'followup_text': '', 'canonical_text': ''},
        ) as mock_poll:
            dispatch._poll_scheduler_followup(
                task,
                'http://localhost:3080',
                'msg-telegram',
                'user-1',
                'conv-1',
                'scheduler_secret',
                10,
            )

        kwargs = mock_poll.call_args.kwargs
        self.assertEqual(kwargs['timeout_s'], 210.0)
        self.assertEqual(kwargs['grace_s'], 8.0)
        self.assertFalse(kwargs['allow_insight_fallback'])
        self.assertIn('scheduleId=task-followup-telegram', kwargs['url'])

    def test_scheduler_followup_poll_uses_short_defaults_without_telegram(self):
        task = {
            'id': 'task-followup-librechat',
            'channel': ['librechat'],
        }

        with patch.object(
            dispatch,
            '_poll_followup_state',
            return_value={'followup_text': '', 'canonical_text': ''},
        ) as mock_poll:
            dispatch._poll_scheduler_followup(
                task,
                'http://localhost:3080',
                'msg-librechat',
                'user-1',
                'conv-1',
                'scheduler_secret',
                10,
            )

        kwargs = mock_poll.call_args.kwargs
        self.assertEqual(kwargs['timeout_s'], 18.0)
        self.assertEqual(kwargs['grace_s'], 18.0)
        self.assertFalse(kwargs['allow_insight_fallback'])

    def test_scheduler_followup_poll_allows_opt_in_insight_fallback_for_telegram_tasks(self):
        os.environ['SCHEDULER_TELEGRAM_INSIGHT_FALLBACK'] = '1'
        task = {
            'id': 'task-followup-fallback',
            'channel': ['telegram'],
        }

        with patch.object(
            dispatch,
            '_poll_followup_state',
            return_value={'followup_text': '', 'canonical_text': ''},
        ) as mock_poll:
            dispatch._poll_scheduler_followup(
                task,
                'http://localhost:3080',
                'msg-telegram',
                'user-1',
                'conv-1',
                'scheduler_secret',
                10,
            )

        kwargs = mock_poll.call_args.kwargs
        self.assertTrue(kwargs['allow_insight_fallback'])

    def test_poll_followup_state_preserves_canonical_fallback_provenance(self):
        with patch.object(
            dispatch,
            '_get_json',
            return_value={
                'canonicalText': '',
                'canonicalTextSource': 'deferred_fallback',
                'canonicalTextFallbackReason': 'empty_deferred_response',
                'followUp': None,
                'cortexParts': [],
            },
        ):
            result = dispatch._poll_followup_state(
                url='http://localhost:3080/api/viventium/scheduler/cortex/msg-1',
                headers={},
                http_timeout_s=1,
                interval_s=0.01,
                grace_s=0,
                timeout_s=0.01,
                allow_insight_fallback=False,
                warning_prefix='Scheduler',
            )

        self.assertEqual(result.get('canonical_text'), '')
        self.assertEqual(result.get('canonical_text_source'), 'deferred_fallback')
        self.assertEqual(result.get('canonical_text_fallback_reason'), 'empty_deferred_response')

    def test_dispatch_task_defaults_to_all_channels(self):
        task = {
            'id': 'task-4',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': None,
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-1',
                'response_message_id': 'msg-4',
                'final_text': 'hello there',
                'followup_text': '',
            },
        ) as mock_run, patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            return_value={'outcome': 'sent', 'reason': 'delivered', 'generated_text': 'hello there'},
        ) as mock_tg:
            result = dispatch.dispatch_task(task)

            self.assertEqual(mock_run.call_count, 1)
            self.assertEqual(mock_tg.call_count, 1)
            self.assertEqual(result.get('conversation_id'), 'lc-1')

    def test_dispatch_task_uses_compiled_librechat_origin_when_scheduler_url_is_unset(self):
        task = {
            'id': 'task-compiled-origin',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': ['librechat'],
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.dict(
            os.environ,
            {'VIVENTIUM_LIBRECHAT_ORIGIN': 'http://127.0.0.1:3180/'},
            clear=True,
        ), patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-compiled-origin',
                'response_message_id': 'msg-compiled-origin',
                'final_text': 'hello there',
                'followup_text': '',
            },
        ) as mock_run:
            dispatch.dispatch_task(task)

        self.assertEqual(mock_run.call_args.args[1], 'http://127.0.0.1:3180')

    def test_dispatch_task_fan_out_for_channel_list(self):
        task = {
            'id': 'task-5',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': ['telegram', 'librechat'],
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-2',
                'response_message_id': 'msg-5',
                'final_text': 'hello there',
                'followup_text': '',
            },
        ) as mock_run, patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            return_value={'outcome': 'sent', 'reason': 'delivered', 'generated_text': 'hello there'},
        ) as mock_tg:
            result = dispatch.dispatch_task(task)

            self.assertEqual(mock_run.call_count, 1)
            self.assertEqual(mock_tg.call_count, 1)
            self.assertIn('channel_results', result)
            self.assertIn('telegram', result.get('channel_results', {}))
            self.assertIn('librechat', result.get('channel_results', {}))
            self.assertEqual(result.get('conversation_id'), 'lc-2')
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Ensure scheduled Telegram Markdown is rendered safely.
    def test_render_telegram_markdown_converts_basic_markdown(self):
        text = "**Bold**\n- item\n`code`"
        rendered = dispatch.render_telegram_markdown(text)
        self.assertIn("<b>Bold</b>", rendered)
        self.assertIn("• item", rendered)
        self.assertIn("<code>code</code>", rendered)

    def test_render_telegram_markdown_inbox_sample(self):
        text = "**Daily Inbox Check**  \n*America/Toronto, ~7AM*  \n\n**Recent Activity**"
        rendered = dispatch.render_telegram_markdown(text)
        self.assertNotIn("**", rendered)
        self.assertIn("<b>Daily Inbox Check</b>", rendered)

    def test_render_telegram_markdown_preserves_intraword_underscores(self):
        text = "SAME_CONTINUITY_OK snake_case A__B__C"
        rendered = dispatch.render_telegram_markdown(text)
        self.assertEqual(rendered, text)

    def test_render_telegram_markdown_keeps_delimited_underscore_emphasis(self):
        rendered = dispatch.render_telegram_markdown("Use _italic_ and __bold__ here")
        self.assertEqual(rendered, "Use <i>italic</i> and <b>bold</b> here")

    def test_send_telegram_message_does_not_retry_after_ambiguous_transport_error(self):
        payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            payloads.append(dict(payload))
            raise RuntimeError("response lost after accept")

        with patch.object(dispatch, '_post_json', side_effect=fake_post):
            with self.assertRaisesRegex(RuntimeError, 'response lost after accept'):
                dispatch._send_telegram_message('tg-1', '**Bold**', 10)

        self.assertEqual(payloads[0].get('parse_mode'), 'HTML')
        self.assertEqual(len(payloads), 1)
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Telegram ok=false should trigger plain-text fallback.
    def test_send_telegram_message_fallbacks_on_ok_false(self):
        payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            payloads.append(dict(payload))
            if len(payloads) == 1:
                return {"ok": False, "description": "Bad Request: can't parse entities"}
            return {"ok": True}

        with patch.object(dispatch, '_post_json', side_effect=fake_post):
            dispatch._send_telegram_message('tg-1', '**Bold**', 10)

        self.assertEqual(payloads[0].get('parse_mode'), 'HTML')
        self.assertNotIn('parse_mode', payloads[1])
        self.assertNotIn('<b>', payloads[1].get('text', ''))
    # === VIVENTIUM NOTE ===

    def test_send_telegram_message_returns_durable_telegram_id(self):
        with patch.object(
            dispatch,
            '_post_json',
            return_value={'ok': True, 'result': {'message_id': 91}},
        ):
            self.assertEqual(dispatch._send_telegram_message('tg-1', 'hello', 10), '91')

    def test_scheduler_delivery_ack_includes_every_telegram_chunk(self):
        captured = {}

        def fake_post(url, payload, headers, timeout_s):
            captured.update(url=url, payload=payload, headers=headers, timeout_s=timeout_s)
            return {'acknowledged': True}

        with patch.dict(
            os.environ,
            {'VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET': 'adapter-secret'},
            clear=False,
        ), patch.object(dispatch, '_post_json', side_effect=fake_post):
            status = dispatch._ack_scheduler_telegram_delivery(
                base_url='http://localhost:3080',
                logical_turn_id='turn-1',
                revision=2,
                telegram_chat_id='chat-1',
                telegram_message_ids=['90', '91'],
                timeout_s=15,
                schedule_id='schedule-1',
                schedule_run_id='run-1',
            )

        self.assertEqual(status, 'recorded')
        self.assertEqual(
            captured['payload']['presentation_refs'],
            ['telegram:chat-1:90', 'telegram:chat-1:91'],
        )
        self.assertEqual(captured['payload']['presentation_ref'], 'telegram:chat-1:91')
        self.assertEqual(captured['payload']['source_kind'], 'schedule_result')
        self.assertEqual(captured['payload']['schedule_id'], 'schedule-1')
        self.assertEqual(captured['payload']['schedule_run_id'], 'run-1')

    def test_scheduled_telegram_delivery_reuses_receipt_without_resending(self):
        task = {
            'id': 'schedule-1',
            '_scheduled_prompt_run_id': 'run-1',
            '_scheduled_prompt_occurrence_key': 'occurrence-1',
        }
        visibility = dispatch._prepare_generated_visibility(task, 'already delivered', '')
        storage = MagicMock()
        storage.claim_scheduled_prompt_delivery.return_value = {
            'claimed': False,
            'reason': 'already_sent',
            'delivery_key': 'delivery-1',
            'delivery': {'state': 'sent', 'message_id': '91'},
        }

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-1', 'chat-1', {'voice_responses_enabled': False}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as send:
            detail = dispatch._deliver_telegram_generated_text(
                task,
                'http://localhost:3080',
                10,
                None,
                visibility,
            )

        send.assert_not_called()
        self.assertEqual(detail['outcome'], 'sent')
        self.assertEqual(detail['telegram_message_ids'], ['91'])
        self.assertEqual(detail['delivery_receipt_state'], 'confirmed')

    def test_scheduled_telegram_delivery_stops_on_ambiguous_prior_send(self):
        task = {
            'id': 'schedule-2',
            '_scheduled_prompt_run_id': 'run-2',
            '_scheduled_prompt_occurrence_key': 'occurrence-2',
        }
        visibility = dispatch._prepare_generated_visibility(task, 'possibly delivered', '')
        storage = MagicMock()
        storage.claim_scheduled_prompt_delivery.return_value = {
            'claimed': False,
            'reason': 'delivery_unknown',
            'delivery_key': 'delivery-2',
            'delivery': {'state': 'delivery_unknown', 'message_id': None},
        }

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-1', 'chat-1', {'voice_responses_enabled': False}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as send:
            detail = dispatch._deliver_telegram_generated_text(
                task,
                'http://localhost:3080',
                10,
                None,
                visibility,
            )

        send.assert_not_called()
        self.assertEqual(detail['outcome'], 'delivery_unknown')
        self.assertEqual(detail['reason'], 'telegram_delivery_ambiguous')
        self.assertEqual(detail['delivery_receipt_state'], 'unknown')

    def test_scheduled_telegram_send_without_receipt_is_marked_unknown(self):
        task = {
            'id': 'schedule-3',
            '_scheduled_prompt_run_id': 'run-3',
            '_scheduled_prompt_occurrence_key': 'occurrence-3',
        }
        visibility = dispatch._prepare_generated_visibility(task, 'send this', '')
        storage = MagicMock()
        storage.claim_scheduled_prompt_delivery.return_value = {
            'claimed': True,
            'reason': 'claimed',
            'delivery_key': 'delivery-3',
            'delivery': {'state': 'claimed'},
        }

        with patch.object(dispatch, '_scheduler_storage', return_value=storage), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-1', 'chat-1', {'voice_responses_enabled': False}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text', return_value=None):
            detail = dispatch._deliver_telegram_generated_text(
                task,
                'http://localhost:3080',
                10,
                None,
                visibility,
            )

        storage.mark_scheduled_prompt_delivery_unknown.assert_called_once()
        self.assertEqual(detail['outcome'], 'delivery_unknown')
        self.assertEqual(detail['delivery_receipt_state'], 'unknown')

    # === VIVENTIUM NOTE ===
    # Feature: Scheduler Telegram path must strip internal recall/tool artifacts.
    def test_sanitize_telegram_text_strips_internal_surface_artifacts(self):
        text = """
<turn timestamp="2026-02-24T13:30:03.504Z" role="user">what should be my priority</turn>
<turn timestamp="2026-02-24T13:30:36.704Z" role="AI">Passport renewal's on for Thursday.</turn>

─────────────────
Tool: file_search, File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt
Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)
Relevance: 1.0967
Content: <turn timestamp="2026-02-22T23:19:11.562Z" role="AI">Archived text</turn>
"""
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertIn("Passport renewal's on for Thursday.", cleaned)
        self.assertNotIn("what should be my priority", cleaned)
        self.assertNotIn("Tool:", cleaned)
        self.assertNotIn("File:", cleaned)
        self.assertNotIn("Anchor:", cleaned)
        self.assertNotIn("Relevance:", cleaned)
        self.assertNotIn("<turn", cleaned)

    def test_send_telegram_message_strips_internal_surface_artifacts(self):
        payloads = []

        def fake_post(_url, payload, _headers, _timeout_s):
            payloads.append(dict(payload))
            return {"ok": True}

        text = """
Tool: file_search, File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt
Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)
Relevance: 1.1568
Content: <turn timestamp="2026-02-25T00:00:06.441Z" role="AI">Archived text</turn>
"""
        with patch.object(dispatch, '_post_json', side_effect=fake_post):
            dispatch._send_telegram_message('tg-1', text, 10)

        self.assertEqual(len(payloads), 1)
        sent_text = payloads[0].get('text', '')
        self.assertNotIn('Tool:', sent_text)
        self.assertNotIn('Anchor:', sent_text)
        self.assertNotIn('Relevance:', sent_text)
        self.assertNotIn('<turn', sent_text)

    def test_sanitize_strips_real_heartbeat_leak(self):
        """Regression: exact artifact pattern that leaked in a previous heartbeat run."""
        text = (
            "Flights are locked, team. Momentum is real now. "
            "Correction: The application path is the actual legal thread.\n\n"
            "─────────────────\n"
            "File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt\n"
            "Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)\n"
            "Relevance: 0.4496\n"
            "Content: Less granular neighbourhood filtering. Reviews less reliable.\n\n"
            "─────────────────\n"
            "Tool: file_search, File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt\n"
            "Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)\n"
            "Relevance: 1.1568\n"
            'Content: <turn timestamp="2026-02-25T00:00:06.441Z" '
            'conversation="f64e64ca-ee18-412a-8ce0-9d13754b979b" role="AI">\n'
            "Post-Gym Protocol SF Housing: Post-gym, hit Airbnb for Potrero Hill\n"
            "</turn>\n\n"
            "─────────────────\n"
            "File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt\n"
            "Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)\n"
            "Relevance: 0.9082\n"
            "Content: 100% not going to mission its infested with poop\n\n"
            "─────────────────\n"
        )
        cleaned = dispatch._sanitize_telegram_text(text)
        # Model response preserved
        self.assertIn("Flights are locked, team", cleaned)
        self.assertIn("application path", cleaned)
        # All recall artifacts stripped
        self.assertNotIn("Tool:", cleaned)
        self.assertNotIn("File:", cleaned)
        self.assertNotIn("Anchor:", cleaned)
        self.assertNotIn("Relevance:", cleaned)
        self.assertNotIn("Content:", cleaned)
        self.assertNotIn("<turn", cleaned)
        self.assertNotIn("</turn>", cleaned)
        self.assertNotIn("conversation-recall", cleaned)
        self.assertNotIn("infested with poop", cleaned)
        # Preserved assistant turn content (if any) is clean
        self.assertNotIn("Post-Gym Protocol", cleaned)

    def test_sanitize_strips_consecutive_recall_blocks_with_mixed_separators(self):
        """Multiple recall blocks with varied separator patterns all get stripped."""
        text = (
            "Here is a clean response.\n\n"
            "Tool: file_search, File: recall-file.txt\n"
            "Anchor: (recall-file.txt)\n"
            "Relevance: 0.8\n"
            "Content: Some archived content\n\n"
            "─────────────────\n"
            "File: another-file.txt\n"
            "Anchor: (another-file.txt)\n"
            "Relevance: 0.6\n"
            "Content: More archived stuff\n"
        )
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertIn("Here is a clean response", cleaned)
        self.assertNotIn("file_search", cleaned)
        self.assertNotIn("Anchor:", cleaned)
        self.assertNotIn("archived", cleaned)

    def test_sanitize_strips_tool_error_line_variant(self):
        text = "Tool: file_search, File search encountered errors or timed out. Please try again or rephrase your query."
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertEqual(cleaned, "")

    def test_sanitize_keeps_text_while_stripping_tool_error_line(self):
        text = (
            "Quick pulse.\n"
            "Tool: file_search, File search encountered errors or timed out. Please try again or rephrase your query.\n"
            "Stay focused."
        )
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertIn("Quick pulse.", cleaned)
        self.assertIn("Stay focused.", cleaned)
        self.assertNotIn("Tool:", cleaned)
        self.assertNotIn("file_search", cleaned)

    def test_sanitize_strips_markdownv2_backslash_escapes(self):
        """Regression: models sometimes emit MarkdownV2 escapes that leak as literal backslashes."""
        text = (
            "You two look class\\. Heading to get roasted, then? "
            "Avery's glasses are a proper vibe\\. "
            "Hope the TTC isn't too much of a buzzkill after that Rumble energy earlier\\. "
            "Enjoy being the best\\-looking founders in the room\\. 🎤🏙️🥂"
        )
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertNotIn("\\.", cleaned)
        self.assertNotIn("\\-", cleaned)
        self.assertIn("class.", cleaned)
        self.assertIn("vibe.", cleaned)
        self.assertIn("best-looking", cleaned)
        self.assertIn("room.", cleaned)
        self.assertIn("🎤🏙️🥂", cleaned)

    def test_sanitize_strips_mixed_markdownv2_escapes(self):
        """MarkdownV2 escapes all 17 special chars — verify we strip them all."""
        text = "Test\\! with\\# many\\.escaped\\- chars\\= and\\| pipes\\{curly\\}"
        cleaned = dispatch._sanitize_telegram_text(text)
        self.assertNotIn("\\!", cleaned)
        self.assertNotIn("\\#", cleaned)
        self.assertNotIn("\\.", cleaned)
        self.assertNotIn("\\-", cleaned)
        self.assertNotIn("\\=", cleaned)
        self.assertNotIn("\\|", cleaned)
        self.assertNotIn("\\{", cleaned)
        self.assertNotIn("\\}", cleaned)
        self.assertIn("Test!", cleaned)
        self.assertIn("with#", cleaned)
        self.assertIn("many.escaped-", cleaned)

    def test_render_telegram_markdown_unescapes_markdownv2(self):
        """End-to-end: MarkdownV2 escapes in model output should not appear in rendered HTML."""
        text = "Great vibe\\. Best\\-looking spot in town\\!"
        rendered = dispatch.render_telegram_markdown(text)
        self.assertNotIn("\\.", rendered)
        self.assertNotIn("\\-", rendered)
        self.assertNotIn("\\!", rendered)
        self.assertIn("vibe.", rendered)
        self.assertIn("Best-looking", rendered)
        # Should be valid HTML output
        self.assertNotIn("\\", rendered)
    # === VIVENTIUM NOTE ===

    # === VIVENTIUM NOTE ===
    # Feature: Empty/whitespace final_text treated as intentional silence (no placeholder).
    def test_dispatch_telegram_suppresses_empty_final_text(self):
        """Empty final_text should not produce '(No response generated.)' — it should be silent."""
        task = {
            'id': 'task-empty',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-e',
                'final_text': '',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-e', 'tg-e', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('conversation_id'), 'new')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty')

    def test_dispatch_telegram_suppresses_whitespace_final_text(self):
        """Whitespace-only final_text should be treated as silence."""
        task = {
            'id': 'task-ws',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-ws',
                'final_text': '   \n  ',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-ws', 'tg-ws', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty')

    def test_dispatch_telegram_marks_visible_deferred_fallback_as_degraded(self):
        task = {
            'id': 'task-visible-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-visible-fallback',
                'final_text': 'Best-effort fallback summary',
                'followup_text': '',
                'final_text_source': 'deferred_fallback',
                'final_text_fallback_reason': 'insight_fallback',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-fallback', 'tg-fallback', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_called_once()
            self.assertEqual(mock_send.call_args.args[1], 'Best-effort fallback summary')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'fallback_delivered')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:insight_fallback')
            telegram_delivery = result.get('delivery', {}).get('channels', {}).get('telegram', {})
            self.assertTrue(telegram_delivery.get('fallback_delivered'))

    def test_dispatch_telegram_suppresses_empty_scheduled_deferred_fallback(self):
        task = {
            'id': 'task-empty-scheduled-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-empty-scheduled-fallback',
                'final_text': '{NTA}',
                'followup_text': '',
                'suppressed_fallback_reason': 'empty_deferred_response',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-empty-fallback', 'tg-empty-fallback', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty_deferred_response')

    def test_dispatch_telegram_suppresses_nta_final_text(self):
        """NTA final_text should be suppressed (existing behavior, regression guard)."""
        task = {
            'id': 'task-nta',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-nta',
                'final_text': '{NTA}',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-nta', 'tg-nta', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:nta')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), '{NTA}')
            self.assertEqual(
                result.get('delivery', {}).get('channels', {}).get('telegram', {}).get('final_generated_text'),
                '{NTA}',
            )

    def test_dispatch_telegram_suppresses_artifact_only_final_text(self):
        """Artifact-only final_text should be treated as empty after sanitization."""
        task = {
            'id': 'task-artifact',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        artifact = (
            "Tool: file_search, File: viventium-conversation-recall-1772215565687-75fz28gg4hb.txt\n"
            "Anchor: (viventium-conversation-recall-1772215565687-75fz28gg4hb.txt)\n"
            "Relevance: 1.1568\n"
            "Content: <turn timestamp=\"2026-02-25T00:00:06.441Z\" role=\"AI\">Archived text</turn>"
        )

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-art',
                'final_text': artifact,
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-art', 'tg-art', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty')
            self.assertIsNone(result.get('delivery', {}).get('generated_text'))
            self.assertIsNone(
                result.get('delivery', {}).get('channels', {}).get('telegram', {}).get('final_generated_text'),
            )

    def test_dispatch_telegram_suppresses_tool_error_only_final_text(self):
        """Tool-surface error lines must not be sent to Telegram."""
        task = {
            'id': 'task-tool-error',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        tool_error = "Tool: file_search, File search encountered errors or timed out. Please try again or rephrase your query."

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-tool',
                'final_text': tool_error,
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-tool', 'tg-tool', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:empty')
            self.assertIsNone(result.get('delivery', {}).get('generated_text'))

    def test_dispatch_telegram_any_scheduled_nta_remains_suppressed_with_stale_metadata(self):
        """Any scheduled prompt with NTA must stay silent, regardless of legacy metadata."""
        task = {
            'id': 'task-passive-check',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check whether there is anything new worth surfacing',
            'channel': 'telegram',
            'conversation_policy': 'same',
            'next_run_at': '2026-02-13T20:00:00Z',
            'schedule': {'type': 'cron', 'cron': '*/30 9-21 * * *', 'timezone': 'America/Toronto'},
            'metadata': {'name': 'Passive Check', 'heartbeat_quiet_streak': 99},
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'conv-passive',
                'response_message_id': 'msg-passive',
                'final_text': '{NTA}',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-passive', 'tg-passive', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'telegram:nta')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), '{NTA}')
            telegram_detail = result.get('delivery', {}).get('channels', {}).get('telegram', {})
            self.assertFalse(telegram_detail.get('sent_final'))
            self.assertFalse(telegram_detail.get('sent_followup'))
            self.assertEqual(telegram_detail.get('final_generated_text'), '{NTA}')

    def test_dispatch_telegram_explicit_reminder_still_sends_visible_text(self):
        """Removing synthetic status pings must not silence legitimate visible scheduled output."""
        task = {
            'id': 'task-reminder',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'remind me to stretch',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': {'name': 'Reminder'},
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'conv-reminder',
                'response_message_id': 'msg-reminder',
                'final_text': 'Stretch now.',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-reminder', 'tg-reminder', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            self.assertEqual(mock_send.call_count, 1)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'Stretch now.')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'delivered')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), 'Stretch now.')

    def test_dispatch_telegram_still_sends_followup_when_final_suppressed(self):
        """Even when final_text is suppressed, a non-empty follow-up should still deliver."""
        task = {
            'id': 'task-fu',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'new',
                'response_message_id': 'msg-fu',
                'final_text': '{NTA}',
                'followup_text': 'Here are your insights...',
            },
        ), patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-fu', 'tg-fu', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch.dispatch_task(task)

            # Only the follow-up should be sent, not the NTA final
            self.assertEqual(mock_send.call_count, 1)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'Here are your insights...')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), 'Here are your insights...')

    def test_dispatch_telegram_uses_canonical_parent_text_when_initial_final_suppressed(self):
        task = {
            'id': 'task-canonical-tg',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-canonical', 'tg-canonical', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-tg-canonical', 'conversationId': 'conv-tg-canonical'},
        ), patch.object(
            dispatch,
            '_stream_telegram_response',
            return_value=('{NTA}', 'msg-tg-canonical', ''),
        ), patch.object(
            dispatch,
            '_poll_telegram_followup',
            return_value={'followup_text': '', 'canonical_text': 'Inbox summary from canonical parent'},
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch._dispatch_telegram(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(mock_send.call_count, 1)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'Inbox summary from canonical parent')
            self.assertEqual(result.get('conversation_id'), 'conv-tg-canonical')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), 'Inbox summary from canonical parent')
            self.assertEqual(result.get('delivery', {}).get('final_generated_text'), 'Inbox summary from canonical parent')
            self.assertTrue(result.get('delivery', {}).get('sent_final'))

    def test_legacy_dispatch_telegram_marks_visible_deferred_fallback_as_degraded(self):
        task = {
            'id': 'task-legacy-visible-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-legacy-fallback', 'tg-legacy-fallback', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-legacy-fallback', 'conversationId': 'conv-legacy-fallback'},
        ), patch.object(
            dispatch,
            '_stream_telegram_response',
            return_value=('{NTA}', 'msg-legacy-fallback', ''),
        ), patch.object(
            dispatch,
            '_poll_telegram_followup',
            return_value={
                'followup_text': '',
                'canonical_text': 'Best-effort fallback summary',
                'canonical_text_source': 'deferred_fallback',
                'canonical_text_fallback_reason': 'insight_fallback',
            },
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch._dispatch_telegram(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(mock_send.call_count, 1)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'Best-effort fallback summary')
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'fallback_delivered')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'insight_fallback')
            self.assertTrue(result.get('delivery', {}).get('fallback_delivered'))

    def test_legacy_dispatch_telegram_suppresses_empty_scheduled_deferred_fallback(self):
        task = {
            'id': 'task-legacy-empty-fallback',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-legacy-empty', 'tg-legacy-empty', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-legacy-empty', 'conversationId': 'conv-legacy-empty'},
        ), patch.object(
            dispatch,
            '_stream_telegram_response',
            return_value=('{NTA}', 'msg-legacy-empty', ''),
        ), patch.object(
            dispatch,
            '_poll_telegram_followup',
            return_value={
                'followup_text': '',
                'canonical_text': '',
                'canonical_text_source': 'deferred_fallback',
                'canonical_text_fallback_reason': 'empty_deferred_response',
            },
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch._dispatch_telegram(task, 'http://localhost:3080', 10, 'new')

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'empty_deferred_response')
            self.assertFalse(result.get('delivery', {}).get('fallback_delivered'))

    def test_legacy_dispatch_telegram_any_scheduled_nta_remains_suppressed_with_stale_metadata(self):
        task = {
            'id': 'task-legacy-passive-check',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check whether there is anything new worth surfacing',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': {'name': 'Passive Check', 'heartbeat_quiet_streak': 99},
        }

        with patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-legacy-passive', 'tg-legacy-passive', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-legacy-passive', 'conversationId': 'conv-legacy-passive'},
        ), patch.object(
            dispatch,
            '_stream_telegram_response',
            return_value=('{NTA}', 'msg-legacy-passive', ''),
        ), patch.object(
            dispatch,
            '_poll_telegram_followup',
            return_value={'followup_text': '', 'canonical_text': ''},
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch._dispatch_telegram(task, 'http://localhost:3080', 10, 'new')

            mock_send.assert_not_called()
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'suppressed')
            self.assertEqual(result.get('delivery', {}).get('reason'), 'nta')
            self.assertEqual(result.get('delivery', {}).get('generated_text'), '{NTA}')
            self.assertFalse(result.get('delivery', {}).get('sent_final'))
            self.assertFalse(result.get('delivery', {}).get('sent_followup'))

    def test_dispatch_telegram_dedupes_matching_followup_text(self):
        task = {
            'id': 'task-canonical-tg-dedupe',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'check my inbox',
            'channel': 'telegram',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_resolve_telegram_identity',
            return_value=('tg-canonical', 'tg-canonical', {'always_voice_response': False, 'voice_responses_enabled': True}),
        ), patch.object(
            dispatch,
            '_post_json',
            return_value={'streamId': 'stream-tg-dedupe', 'conversationId': 'conv-tg-dedupe'},
        ), patch.object(
            dispatch,
            '_stream_telegram_response',
            return_value=('{NTA}', 'msg-tg-dedupe', ''),
        ), patch.object(
            dispatch,
            '_poll_telegram_followup',
            return_value={
                'followup_text': 'Inbox summary from canonical parent',
                'canonical_text': 'Inbox summary from canonical parent',
            },
        ), patch.object(dispatch, '_send_telegram_voice_or_text') as mock_send:
            result = dispatch._dispatch_telegram(task, 'http://localhost:3080', 10, 'new')

            self.assertEqual(mock_send.call_count, 1)
            self.assertEqual(mock_send.call_args_list[0].args[1], 'Inbox summary from canonical parent')
            self.assertEqual(result.get('delivery', {}).get('followup_generated_text'), None)
            self.assertFalse(result.get('delivery', {}).get('sent_followup'))
    # === VIVENTIUM NOTE ===


class DispatchBestEffortFanoutTests(unittest.TestCase):
    """Tests for best-effort multi-channel dispatch (partial success semantics)."""

    def setUp(self):
        os.environ['SCHEDULER_LIBRECHAT_SECRET'] = 'scheduler_secret'
        os.environ['SCHEDULER_TELEGRAM_SECRET'] = 'telegram_secret'
        os.environ['SCHEDULER_TELEGRAM_BOT_TOKEN'] = 'bot_token'

    def tearDown(self):
        os.environ.pop('SCHEDULER_LIBRECHAT_SECRET', None)
        os.environ.pop('SCHEDULER_TELEGRAM_SECRET', None)
        os.environ.pop('SCHEDULER_TELEGRAM_BOT_TOKEN', None)

    def test_structured_generation_failure_notifies_telegram_and_stays_failed(self):
        task = {
            'id': 'task-provider-failure-fanout',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'perform required external work',
            'channel': ['librechat', 'telegram'],
            'conversation_policy': 'new',
            'metadata': None,
        }
        captured_visibility = {}

        def deliver(_task, _base_url, _timeout_s, _message_id, visibility):
            captured_visibility.update(visibility)
            return {
                'channel': 'telegram',
                'outcome': 'sent',
                'reason': 'delivered',
                'generated_text': visibility.get('generated_text'),
            }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'conv-provider-failure',
                'response_message_id': 'msg-provider-failure',
                'generation_failure': {'error_class': 'provider_unauthorized'},
                'execution': {'provider': 'openai', 'model': 'synthetic-model'},
            },
        ), patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            side_effect=deliver,
        ):
            result = dispatch.dispatch_task(task)

        self.assertEqual(result['delivery']['outcome'], 'failed')
        self.assertEqual(result['delivery']['reason'], 'provider_unauthorized')
        self.assertEqual(result['generation_failure']['error_class'], 'provider_unauthorized')
        self.assertFalse(result['generation_failure']['failure_retryable'])
        self.assertEqual(
            result['generation_failure']['transition']['retry_disposition'],
            'next_occurrence_only',
        )
        self.assertEqual(result['delivery']['channels']['librechat']['outcome'], 'failed')
        self.assertEqual(result['delivery']['channels']['telegram']['outcome'], 'sent')
        self.assertEqual(result['delivery']['channels']['telegram']['reason'], 'action_required')
        self.assertIn('Reconnect it in Settings', captured_visibility['final_text'])
        self.assertNotIn('synthetic-private', str(result))

    def test_pre_generation_exception_uses_the_same_failure_notice_contract(self):
        task = {
            'id': 'task-pre-generation-failure',
            'user_id': 'user_1',
            'agent_id': 'agent-missing',
            'prompt': 'perform required external work',
            'channel': ['telegram'],
            'conversation_policy': 'new',
            'schedule': {'type': 'interval', 'interval': {'every': 1, 'unit': 'hour'}},
            'metadata': {},
        }

        with patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            return_value={'channel': 'telegram', 'outcome': 'sent', 'reason': 'delivered'},
        ) as deliver:
            result = dispatch.scheduled_failure_result(task, 'RuntimeError')

        deliver.assert_called_once()
        self.assertEqual(result['generation_failure']['error_class'], 'completion_error')
        self.assertEqual(
            result['generation_failure']['transition']['retry_disposition'],
            'next_occurrence_only',
        )
        self.assertEqual(result['delivery']['channels']['telegram']['outcome'], 'sent')
        self.assertIn('next scheduled occurrence remains', result['delivery']['generated_text'])
        self.assertEqual(
            result['generation_failure']['transition']['reported_failure_classes'],
            ['completion_error'],
        )

    def test_legacy_error_without_delivery_receipt_does_not_suppress_first_notice(self):
        task = {
            'id': 'task-legacy-unreported-failure',
            'user_id': 'user_1',
            'agent_id': 'agent-missing',
            'prompt': 'perform required external work',
            'channel': ['telegram'],
            'conversation_policy': 'new',
            'schedule': {'type': 'interval', 'interval': {'every': 1, 'unit': 'hour'}},
            'last_status': 'error',
            'last_error': 'completion_error',
            'metadata': {},
        }

        with patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            return_value={'channel': 'telegram', 'outcome': 'sent', 'reason': 'delivered'},
        ) as deliver:
            result = dispatch.scheduled_failure_result(task, 'RuntimeError')

        deliver.assert_called_once()
        self.assertFalse(
            result['generation_failure']['transition']['already_reported_in_health_epoch']
        )
        self.assertEqual(
            result['generation_failure']['transition']['reported_failure_classes'],
            ['completion_error'],
        )

    def test_failed_failure_notice_delivery_is_not_marked_reported(self):
        task = {
            'id': 'task-failure-notice-delivery-failed',
            'user_id': 'user_1',
            'agent_id': 'agent-missing',
            'prompt': 'perform required external work',
            'channel': ['telegram'],
            'conversation_policy': 'new',
            'schedule': {'type': 'interval', 'interval': {'every': 1, 'unit': 'hour'}},
            'metadata': {},
        }

        with patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            side_effect=RuntimeError('synthetic delivery failure'),
        ):
            result = dispatch.scheduled_failure_result(task, 'RuntimeError')

        self.assertEqual(result['delivery']['channels']['telegram']['outcome'], 'failed')
        self.assertEqual(
            result['generation_failure']['transition']['reported_failure_classes'],
            [],
        )

    def test_repeated_same_root_generation_failure_coalesces_telegram_notice(self):
        task = {
            'id': 'task-provider-failure-repeat',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'perform required external work',
            'channel': ['telegram'],
            'conversation_policy': 'new',
            'schedule': {'type': 'cron', 'expression': '0 * * * *'},
            'last_status': 'error',
            'last_error': 'provider_rate_limited',
            'metadata': {
                'scheduled_failure_state_v1': {
                    'version': 1,
                    'error_class': 'provider_rate_limited',
                    'health_epoch': 'health-epoch-1',
                    'consecutive_count': 1,
                    'same_root_count': 1,
                    'reported_failure_classes': ['provider_rate_limited'],
                },
            },
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'conv-provider-failure',
                'response_message_id': 'msg-provider-failure',
                'generation_failure': {
                    'error_class': 'provider_rate_limited',
                    'failure_retryable': True,
                },
            },
        ), patch.object(dispatch, '_deliver_telegram_generated_text') as deliver:
            result = dispatch.dispatch_task(task)

        deliver.assert_not_called()
        telegram = result['delivery']['channels']['telegram']
        self.assertEqual(telegram['outcome'], 'suppressed')
        self.assertEqual(telegram['reason'], 'same_root_already_reported')
        self.assertIsNone(result['delivery']['generated_text'])

    def test_partial_success_telegram_fails_librechat_succeeds(self):
        task = {
            'id': 'task-partial-1',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'morning briefing',
            'channel': ['librechat', 'telegram'],
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-ok',
                'response_message_id': 'msg-partial-1',
                'final_text': 'Good morning!',
                'followup_text': '',
            },
        ), patch.object(
            dispatch,
            '_deliver_telegram_generated_text',
            side_effect=RuntimeError('Telegram identity not found'),
        ):
            result = dispatch.dispatch_task(task)

            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')
            self.assertIn('channel_errors', result)
            self.assertIn('telegram', result['channel_errors'])
            self.assertEqual(
                result['channel_errors']['telegram'],
                {
                    'outcome': 'failed',
                    'reason': 'channel_dispatch_failed',
                    'error_class': 'RuntimeError',
                },
            )
            self.assertEqual(
                result['delivery']['channels']['telegram'],
                result['channel_errors']['telegram'],
            )
            self.assertNotIn('identity', str(result))

    def test_structured_superseded_generation_is_not_delivered_as_failure_or_silence(self):
        task = {
            'id': 'task-superseded',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'obsolete scheduled prompt',
            'channel': ['librechat', 'telegram'],
            'conversation_policy': 'same',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-same',
                'response_message_id': 'msg-obsolete',
                'final_text': 'stale result',
                'followup_text': '',
                'disposition': 'superseded',
                'superseded': True,
            },
        ), patch.object(dispatch, '_deliver_telegram_generated_text') as telegram:
            result = dispatch.dispatch_task(task)

        telegram.assert_not_called()
        self.assertEqual(result['delivery']['outcome'], 'superseded')
        self.assertEqual(result['delivery']['channels']['librechat']['outcome'], 'superseded')
        self.assertEqual(result['delivery']['channels']['telegram']['outcome'], 'superseded')
        self.assertNotIn('channel_errors', result)

    def test_generation_failure_raises_runtime_error(self):
        task = {
            'id': 'task-generate-fail',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'morning briefing',
            'channel': ['telegram'],
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(dispatch, '_run_scheduler_generation', side_effect=RuntimeError('scheduler down')):
            with self.assertRaises(RuntimeError) as ctx:
                dispatch.dispatch_task(task)
            self.assertIn('scheduler down', str(ctx.exception).lower())

    def test_single_channel_success_no_channel_errors_key(self):
        task = {
            'id': 'task-clean',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'hello',
            'channel': 'librechat',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-clean',
                'response_message_id': 'msg-clean',
                'final_text': 'Hi',
                'followup_text': '',
            },
        ):
            result = dispatch.dispatch_task(task)

            self.assertNotIn('channel_errors', result)
            self.assertEqual(result.get('delivery', {}).get('outcome'), 'sent')

    def test_workbench_only_channel_is_silent_audit_not_dispatch_failure(self):
        task = {
            'id': 'task-audit-only',
            'user_id': 'user_1',
            'agent_id': 'agent-1',
            'prompt': 'inspect state',
            'channel': 'workbench',
            'conversation_policy': 'new',
            'metadata': None,
        }

        with patch.object(
            dispatch,
            '_run_scheduler_generation',
            return_value={
                'conversation_id': 'lc-audit',
                'response_message_id': 'msg-audit',
                'final_text': 'Private audit result',
                'followup_text': '',
            },
        ):
            result = dispatch.dispatch_task(task)

        self.assertEqual(result['delivery']['outcome'], 'audit_only')
        self.assertEqual(
            result['delivery']['channels']['workbench'],
            {
                'outcome': 'audit_only',
                'reason': 'workbench_channel_is_audit_only',
                'generated_text': None,
            },
        )


if __name__ == '__main__':
    unittest.main()
