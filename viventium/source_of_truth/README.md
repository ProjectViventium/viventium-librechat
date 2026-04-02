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
