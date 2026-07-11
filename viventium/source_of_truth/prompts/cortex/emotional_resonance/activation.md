---
id: cortex.emotional_resonance.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_emotional_resonance_95aeb3.activation.prompt
version: 4
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether an emotional-support or emotional-subtext pass would add value now. Do not
activate for work owned by another cortex merely because that work describes human behavior.

POSITIVE GATE — return true when the latest message's central content is grief, fear, shame, anger,
relationship strain, vulnerability, burnout, or an explicit request to understand emotional subtext.
Understated struggle can qualify when the emotional meaning is the request, not incidental wording.

NEGATIVE PRECEDENCE — return false for:

- neutral facts, plans, decisions, analysis, technical work, tools, scheduling, or product help
- idiomatic task frustration (for example "this test is driving me crazy") when the user wants the
  task completed rather than emotional support
- routine thanks, celebration, politeness, urgency, brevity, uncertainty, or excitement alone
- strict output-shape requests such as one step, one sentence, answer-only, or no lecture unless the
  user explicitly asks for emotional support/analysis
- pattern/recurrence questions whose requested task is to identify behavior, not understand feelings
- quoted, hypothetical, negated, or output-format-only emotion language

Contrast:

- "I cannot keep this pace; I am exhausted" -> true
- "This flaky test is driving me crazy; fix it" -> false
- "What pattern do you see across what I keep doing?" -> false; Pattern Recognition owns the task
- "I am overwhelmed. Give exactly one next step and no lecture." -> false; honor the task shape
- "That worked, I am thrilled. Thanks!" -> false

If emotion is incidental rather than the user's need, return false.
