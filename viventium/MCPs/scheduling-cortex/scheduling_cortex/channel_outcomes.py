# === VIVENTIUM START ===
# Purpose: One owner-channel outcome rule for GlassHive callbacks and restart reconciliation.
# === VIVENTIUM END ===

from __future__ import annotations

from typing import Any, Dict


def _glasshive_callback_delivery_outcome(status: str, event: str) -> str:
    """Owner-channel outcome for a GlassHive lifecycle status, shared by the run and task ledgers."""
    if status in {"completed", "failed"}:
        return "sent" if status == "completed" else "failed"
    if event == "run.needs_input":
        return "action_required"
    return "queued"


def _glasshive_callback_channel_outcomes(
    run: Dict[str, Any],
    *,
    outcome: str,
    reason: str,
) -> Dict[str, Any]:
    """Carry a callback's outcome onto each channel the run was dispatched to.

    Dispatch records every GlassHive channel as queued. Only the parent task ledger used to follow
    the callback, so a run that later completed or failed kept telling the owner it was queued.
    Channels are never invented: a run dispatched without any keeps an empty record.
    """
    existing = run.get("channel_outcomes")
    if not isinstance(existing, dict):
        return {}
    return {
        channel: {
            **(detail if isinstance(detail, dict) else {}),
            "outcome": outcome,
            "reason": reason,
        }
        for channel, detail in existing.items()
    }
