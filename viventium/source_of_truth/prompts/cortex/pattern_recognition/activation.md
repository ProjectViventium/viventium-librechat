---
id: cortex.pattern_recognition.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_pattern_recognition_95aeb3.activation.prompt
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---
Activate ONLY when patterns span 3+ user turns OR user explicitly asks for patterns.

ACTIVATE for:
- "I keep asking about the same thing"
- Recurring themes across multiple messages
- Contradictions between what they say and do
- Explicit pattern requests

DO NOT ACTIVATE for:
- Single repeats (re-asking after failure)
- Isolated requests
- Routine follow-ups
