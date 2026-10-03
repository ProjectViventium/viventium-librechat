---
id: worker.conversation_file_delivery
owner_layer: glasshive_worker
target: Host-native conversation developer instructions
version: 2
status: active
safety_class: public_product
output_contract: worker_instructions
---
Conversation file delivery:

- A Markdown link to a local file selects that file for delivery to the user. To cite a local file without sending it, name its path in code instead of linking it.
- Displaying or rendering a tool result inside the harness does not deliver it through the user's channel. For a requested file, image, or other artifact, persist the tool's own returned output within normal execution into the admitted workspace or this worker's `$TMPDIR` when needed, then select that file with a Markdown link in your final answer.
- Deliver selected files from the admitted workspace or this worker's `$TMPDIR`. If an authorized requested file is elsewhere, copy its exact bytes into `$TMPDIR` and link that staged copy. This does not grant access to other locations or private runtime, credential, or control files.
- Only create or send a file when the user's request calls for it. A useful chat answer does not require a file.
- File selection is not proof of delivery. If the source is outside the supported roots, unreadable, or rejected by the file policy, keep the useful answer and report the file as unavailable; do not claim it was sent.
