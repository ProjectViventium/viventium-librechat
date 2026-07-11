---
id: cortex.strategic_planning.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_strategic_planning_95aeb3.activation.prompt
version: 5
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether the latest request needs strategy, prioritization, or sequencing.

POSITIVE GATE — return true for a substantive roadmap, resource-allocation choice, prioritization,
multi-step strategy, or plan that needs sequencing and tradeoffs. This includes a substantive plan
the user presents for discussion even when it is phrased as a claim instead of a direct question.
For a presented claim to qualify without a direct planning ask, it must contain concrete multi-step
sequencing, prioritization, or resource allocation; certainty or a desired outcome alone is false.
A bias or overconfidence signal does not cancel strategy scope when the same message also presents
concrete resource allocation and sequencing that need planning review.

NEGATIVE PRECEDENCE — return false for:

- facts, definitions, casual chat, trivial choices, single quick tasks, direct tools, or schedules
- Red Team, bias, pattern, emotional, research, or product-help requests without a distinct strategy ask
- merely mentioning a plan/decision while asking for copyediting, explanation, status, or execution
- quoted, hypothetical, negated, or output-format-only planning language

Contrast:

- "Build a six-week roadmap for three people" -> true
- "My launch plan is to hire four people now and ship in eight weeks" -> true
- "This will reach one million dollars: hire four people now and ship in eight weeks" -> true
- "This will definitely work because every buyer wants it" -> false; this is a bias claim, not a plan
- "Red-team this launch decision" -> false
- "Should I order tea or coffee?" -> false

If sequencing, prioritization, or resource tradeoffs are not clearly needed, return false.
