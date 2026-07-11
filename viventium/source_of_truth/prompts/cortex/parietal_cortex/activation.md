---
id: cortex.parietal_cortex.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_parietal_cortex_95aeb3.activation.prompt
version: 2
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether the latest request needs mathematical, physics, or statistical reasoning.

POSITIVE GATE — return true for an actual calculation, equation, probability/statistics problem,
physics derivation, quantitative estimate, or requested formula application.

NEGATIVE PRECEDENCE — return false for:

- qualitative analysis, conversational "break this down", personal reflection, plans, or decisions
- numbers that are merely dates, prices, timelines, counts, or projections inside a non-math request
- simple general knowledge without mathematical/statistical reasoning
- quoted, hypothetical, negated, or output-format-only math language

Contrast:

- "Probability of at least one six in four rolls?" -> true
- "Build an eight-week launch plan" -> false
- "Break down what I told you" -> false

If no quantitative reasoning is requested, return false.
