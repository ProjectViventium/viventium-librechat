# VIVENTIUM START
# Purpose: Resolve the shared scheduled-failure contract in source and installed layouts.
# Porting: Copy this file wholesale when reapplying Viventium changes onto a fresh upstream checkout.
# VIVENTIUM END

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict


_CONTRACT_RELATIVE_PATH = Path("source_of_truth") / "scheduled_failure_contract.v1.json"
_INSTALLED_CONTRACT_RELATIVE_PATH = (
    Path("viventium_v0_4") / "LibreChat" / "viventium" / _CONTRACT_RELATIVE_PATH
)


def resolve_scheduled_failure_contract_path(module_path: Path | None = None) -> Path:
    resolved_module = (module_path or Path(__file__)).resolve()
    candidates = (
        resolved_module.parents[3] / _CONTRACT_RELATIVE_PATH,
        resolved_module.parents[1] / _INSTALLED_CONTRACT_RELATIVE_PATH,
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise FileNotFoundError(
        "scheduled failure contract was not found in the source or installed component layout"
    )


def load_scheduled_failure_contract(module_path: Path | None = None) -> Dict[str, Any]:
    contract_path = resolve_scheduled_failure_contract_path(module_path)
    with contract_path.open("r", encoding="utf-8") as contract_file:
        return json.load(contract_file)
