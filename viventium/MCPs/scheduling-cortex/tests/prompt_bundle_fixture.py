"""Test-only bundle materialization for the scheduler's runtime reader.

Core owns production compiler validation; a standalone LibreChat clone needs only
its own raw prompt bodies and metadata to exercise the consumer contract.
"""
from pathlib import Path

import yaml


def build_prompt_bundle(root=None):
    source_root = Path(root) if root is not None else Path(__file__).resolve().parents[3] / "source_of_truth" / "prompts" / "scheduler"
    prompts = {}
    for source in sorted(source_root.rglob("*.md")):
        if source.name.upper() == "README.MD":
            continue
        text = source.read_text(encoding="utf-8")
        if not text.startswith("---\n") or "\n---\n" not in text[4:]:
            raise ValueError("Invalid test prompt frontmatter")
        frontmatter, body = text[4:].split("\n---\n", 1)
        metadata = yaml.safe_load(frontmatter)
        prompt_id = metadata.get("id")
        if not prompt_id or prompt_id in prompts:
            raise ValueError("Invalid test prompt identity")
        prompts[prompt_id] = {"metadata": metadata, "body": body.rstrip() + "\n"}
    return {"schema_version": 1, "prompts": prompts}
