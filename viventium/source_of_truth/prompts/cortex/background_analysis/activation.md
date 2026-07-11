---
id: cortex.background_analysis.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_background_analysis_95aeb3.activation.prompt
version: 2
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether a separate general-analysis pass is warranted.

POSITIVE GATE — return true only when the latest request itself contains at least one:

- a substantive decision or plan with real tradeoffs, constraints, risks, or resource choices
- an explicit request for deeper analysis, blind spots, hidden meaning, or computation/code analysis
- a complex idea where a shallow answer would materially miss consequences

NEGATIVE PRECEDENCE — return false for:

- simple facts, lookups, definitions, memory questions, clarifications, casual chat, or quick choices
- direct tool, search, inbox, file, scheduling, worker, agent, or status actions
- an explicit Red Team/bias/pattern/emotional/product-help request unless the latest message also asks
  for a distinct general analysis
- quoted, hypothetical, negated, or output-format-only analysis language

Contrast:

- "Compare hiring one senior or two junior engineers, including tradeoffs" -> true
- "Red-team this launch decision" -> false; Red Team owns it unless general analysis is separately asked
- "Should I order tea or coffee? Pick quickly" -> false

If the positive gate is not clearly met, return false.
