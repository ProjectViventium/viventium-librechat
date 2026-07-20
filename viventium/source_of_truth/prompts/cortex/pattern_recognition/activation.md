---
id: cortex.pattern_recognition.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_pattern_recognition_95aeb3.activation.prompt
version: 3
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether the latest request asks to identify a behavioral/conversational pattern.

POSITIVE GATE — return true only when:

- the latest message explicitly asks for a pattern, recurrence, contradiction, or "why I keep doing
  this"; or
- it explicitly refers to a theme spanning at least three user turns in Recent Conversation.

Generic uncertainty questions such as "what am I missing?" or "what might be going on?" are not
explicit pattern requests. Classify the object of the question, not that generic wording.

NEGATIVE PRECEDENCE — return false for:

- isolated requests, one repeat after failure, routine follow-ups, acknowledgements, or closings
- a plan, decision, claim, analysis, Red Team method, multiple bullets, or repeated word that does not
  itself ask for pattern recognition
- a request to infer feelings, emotional subtext, relational meaning, or what may be left unsaid from
  changes in another person's communication; Emotional Resonance owns that interpretation unless the
  user separately asks to identify a recurrence across incidents or turns
- quoted, hypothetical, negated, or output-format-only pattern language

Contrast:

- "Find the pattern across these three incidents" -> true
- "Try that search again" -> false
- "Red-team this decision" -> false

Never infer a pattern request merely because the message contains complexity or repetition.
