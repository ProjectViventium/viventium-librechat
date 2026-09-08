"""Scheduling tests exercise the installed bundle schema using in-repo prompt fixtures."""

import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from prompt_bundle_fixture import build_prompt_bundle


@pytest.fixture(scope="session")
def scheduler_compiled_bundle(tmp_path_factory):
    path = tmp_path_factory.mktemp("scheduler-prompts") / "prompt-bundle.json"
    path.write_text(json.dumps(build_prompt_bundle()))
    return path


@pytest.fixture(autouse=True)
def scheduler_prompt_environment(monkeypatch, scheduler_compiled_bundle):
    monkeypatch.setenv("VIVENTIUM_PROMPT_BUNDLE_PATH", str(scheduler_compiled_bundle))
