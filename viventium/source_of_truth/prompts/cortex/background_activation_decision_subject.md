---
id: cortex.background_activation_decision_subject
owner_layer: viventium_cortex_activation
target: viventium.background_cortices.activation_subject_rule.prompt
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_subject_instructions
---
Judge activation only for the latest human/user message shown in "Latest User Intent".

Use earlier "Recent Conversation" turns only to resolve references in that latest message.

Never activate only because an older user request appears in history; that older request was already handled by its own turn.

If the latest user message is a simple reply, acknowledgement, test instruction, correction, thanks, provider clarification, or output-only instruction that does not itself meet this cortex's activation criteria, return should_activate=false even when older history would have activated.
