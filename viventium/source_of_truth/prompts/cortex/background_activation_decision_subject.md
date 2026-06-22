---
id: cortex.background_activation_decision_subject
owner_layer: viventium_cortex_activation
target: viventium.background_cortices.activation_subject_rule.prompt
version: 2
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_subject_instructions
---
Judge activation only for the latest human/user message shown in "Latest User Intent".

Use earlier "Recent Conversation" turns only to resolve references in that latest message.

Never activate only because an older user request appears in history; that older request was already handled by its own turn.

Before deciding, ask: "Does LatestUserMessage itself ask this cortex to do work, or does it explicitly refer to continuing that same work?"

If LatestUserMessage is only a simple reply, acknowledgement, test instruction, correction, thanks, provider clarification, or output-only instruction, return should_activate=false unless that latest message itself meets this cortex's activation criteria.

Output-only instructions include requests to reply with exact text, markers, labels, acknowledgements, confirmations, or test tokens. Older history cannot turn an output-only latest message into a new activation.

Ignore activation words that appear only in Recent Conversation. Words such as red-team, pressure-test, challenge, plan, launch, pattern, strategy, or bias count only when they appear in LatestUserMessage or when LatestUserMessage explicitly refers back to them.
