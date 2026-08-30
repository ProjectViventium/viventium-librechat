import json
from pathlib import Path

from scheduling_cortex.scheduled_failure_contract import (
    load_scheduled_failure_contract,
    resolve_scheduled_failure_contract_path,
)


def _write_contract(path: Path, marker: str) -> None:
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"marker": marker}), encoding="utf-8")


def test_resolves_contract_from_nested_source_checkout(tmp_path: Path) -> None:
    module_path = (
        tmp_path
        / "repo"
        / "viventium"
        / "MCPs"
        / "scheduling-cortex"
        / "scheduling_cortex"
        / "module.py"
    )
    contract_path = (
        tmp_path / "repo" / "viventium" / "source_of_truth" / "scheduled_failure_contract.v1.json"
    )
    _write_contract(contract_path, "source")

    assert resolve_scheduled_failure_contract_path(module_path) == contract_path
    assert load_scheduled_failure_contract(module_path) == {"marker": "source"}


def test_resolves_contract_from_installed_component_layout(tmp_path: Path) -> None:
    component_root = tmp_path / "runtime" / "components" / "scheduling-cortex"
    module_path = component_root / "scheduling_cortex" / "module.py"
    contract_path = (
        component_root
        / "viventium_v0_4"
        / "LibreChat"
        / "viventium"
        / "source_of_truth"
        / "scheduled_failure_contract.v1.json"
    )
    _write_contract(contract_path, "installed")

    assert resolve_scheduled_failure_contract_path(module_path) == contract_path
    assert load_scheduled_failure_contract(module_path) == {"marker": "installed"}
