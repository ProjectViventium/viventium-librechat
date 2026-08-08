# === VIVENTIUM START ===
# Purpose: Focused tests for terminal GlassHive capability-grant revocation.
# === VIVENTIUM END ===

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scheduling_cortex import server
from scheduling_cortex.models import CreateScheduleArgs, ScheduleRule, UpdateScheduleArgs


class ScheduledCapabilityAuthoringTests(unittest.TestCase):
    def test_create_contract_normalizes_narrow_capability_selection(self):
        args = CreateScheduleArgs(
            prompt='Create a synthetic report',
            schedule=ScheduleRule(type='interval', interval={'every': 1, 'unit': 'hour'}),
            executor='glasshive_host',
            required_capability_servers=[' ms-365 ', 'atlassian', 'ms-365'],
        )

        self.assertEqual(args.required_capability_servers, ['atlassian', 'ms-365'])
        metadata = server._metadata_with_required_capability_servers(
            args.metadata,
            args.required_capability_servers,
            executor=args.executor,
        )
        self.assertEqual(
            metadata['workbench_scheduled_prompt']['required_capability_servers'],
            ['atlassian', 'ms-365'],
        )

    def test_capability_selection_is_rejected_for_non_glasshive_executor(self):
        with self.assertRaisesRegex(ValueError, 'glasshive_host'):
            server._metadata_with_required_capability_servers(
                None,
                ['ms-365'],
                executor='viventium_agent',
            )

    def test_update_contract_can_clear_the_capability_selection(self):
        args = UpdateScheduleArgs(
            task_id='task-1',
            required_capability_servers=[],
        )
        metadata = {
            'workbench_scheduled_prompt': {
                'required_capability_servers': ['ms-365'],
                'execution_profile': 'codex-cli',
            }
        }

        updated = server._metadata_with_required_capability_servers(
            metadata,
            args.required_capability_servers,
            executor='glasshive_host',
        )

        self.assertNotIn(
            'required_capability_servers',
            updated['workbench_scheduled_prompt'],
        )


if __name__ == '__main__':
    unittest.main()
