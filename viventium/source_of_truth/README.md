# Source Of Truth

This directory is the public, contributor-safe source of truth for the default local Viventium
experience that ships with the open-source repo.

Rules:

- Keep these files free of personal, operator-specific, tenant-specific, or deployment-specific data.
- Private carry-over variants belong in:
  `private-companion-repo/curated/configs/librechat/source_of_truth/`
- The compiler and launcher may prefer an explicit private override when present, but open-source
  contributors must never depend on that private path to run, test, or seed the stack.

Files:

- `local.librechat.yaml`: public-safe default LibreChat/Viventium runtime template
- `local.viventium-agents.yaml`: public-safe built-in agent bundle for local installs
- `managed-agent-baseline-migration.json`: content-fingerprinted predecessor baselines used to
  upgrade managed Main, cortex, and handoff Agents without overwriting user edits

## Main continuity compaction: evidence limit

The Main compactor and its semantic reviewer own which durable identifiers the approved summary
carries. The continuity runtime preserves identifiers they supply. If both omit an identifier,
the runtime does not deterministically extract or reinsert it into compacted context. This is a
limit of the current model-owned contract, not a claim of automatic omission recovery.

`ViventiumMainContinuityService.spec.js` now tests exact identifier preservation **when the
approved compaction includes it**. Its earlier omitted-identifier fixture did not match the
implementation and is not evidence that omitted identifiers recover automatically. The corrected
fixture proves preservation only; it does not prove the compactor and reviewer always retain every
important identifier. No identifier-recovery code was added and no test was skipped.
