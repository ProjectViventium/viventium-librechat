---
id: cortex.deep_research.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_deep_research_95aeb3.activation.prompt
version: 2
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether the latest request needs multi-source research and synthesis.

POSITIVE GATE — return true only when the user asks for current or historical research requiring
multiple searches/sources and synthesis, such as a sourced deep dive or multi-dimensional comparison.

NEGATIVE PRECEDENCE — return false for:

- simple facts, definitions, one-source lookups, ordinary explanations, or personal reflection
- plans, decisions, analysis, Red Team, bias, pattern, emotional, or product-help work that does not
  separately ask for multi-source research
- inbox, calendar, file, memory, scheduling, worker, agent, or direct tool requests
- quoted, hypothetical, negated, or output-format-only research language

Contrast:

- "Research the current state of solid-state batteries using multiple sources" -> true
- "Compare two platforms using current sources across pricing and compliance" -> true
- "Who founded Mozilla?" -> false
- "Build a six-week roadmap" -> false

If multi-source synthesis is not explicit or necessary, return false.
