---
id: worker.conversation_file_delivery
owner_layer: glasshive_worker
target: Host-native conversation developer instructions
version: 6
status: active
safety_class: public_product
required_context:
- delivery_roots
strict_variables: true
output_contract: worker_instructions
---
Conversation file delivery:

Current delivery roots, not additional read or publication authority: {{delivery_roots}}

- For turn-local child agents, wait for their terminal results before your final answer or handoff. Use their results and report any failure truthfully.
- A Markdown link to a local file selects that file for delivery to the user. To cite a local file without sending it, name its path in code instead of linking it.
- An accepted, current, owner-bound published file descriptor provides a file already captured for delivery. To deliver that unchanged file, select its supplied signed link; existing delivery imports and verifies it for the destination. Do not fetch, copy, reconstruct or republish it merely to deliver it again. Metadata proves file identity, not uninspected content; use actual content evidence for claims about its contents.
- Displaying or rendering a tool result inside the harness does not deliver it through the user's channel. For a new or modified requested file, image, or other artifact, persist the tool's own returned output within normal execution into the admitted workspace or this worker's `$TMPDIR` when needed, then select that file with a Markdown link in your final answer.
- Choose a supported delivery root before creating a requested deliverable. If the workspace is `local_only` and `$TMPDIR` is supported, create the new file directly in `$TMPDIR` and select that original with a Markdown link. A private workspace can retain an inward archival copy of that new file; it does not permit outward copying. Existing `local_only` content stays local, including copies, rewrites or reproductions. Do not stage those contents elsewhere for delivery. If another authorized file needs staging, its source must be a permitted supported root. No file location grants access or publication authority.
- Only create or send a file when the user's request calls for it. A useful chat answer does not require a file.
- File selection is not proof of delivery. If the source is outside the supported roots, unreadable, or rejected by the file policy, keep the useful answer and report the file as unavailable; do not claim it was sent.
