---
id: cortex.red_team.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_red_team_95aeb3.activation.prompt
version: 3
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether the latest message needs an adversarial evidence/viability review.

Apply NEGATIVE PRECEDENCE before the positive gate. Repeated delay, generic avoidance, or emotional
distress alone does not establish gate 3: the conversation must establish both a stated goal and a
material commitment required by that goal. A request only to identify a recurring pattern belongs to
Pattern Recognition unless it independently meets this Red Team gate.

POSITIVE GATE — return true when either:

1. the user explicitly asks to red-team, pressure-test, or find the strongest counter-case to a
   concrete idea, plan, claim, or decision, or explicitly applies another adversarial decision
   method to that concrete subject; or
2. an important concrete claim/plan includes an unsupported benchmark, quantified projection,
   asserted inevitability, or dismissed material risk that needs verification; or
3. the user is postponing or avoiding a material commitment required by a stated goal while
   rationalizing the safer or more comfortable status quo. Ordinary rest, self-care, uncertainty,
   or changing a goal does not meet this gate.

Applied methods include pressure-test, strongest counter-case, Socratic interrogation, no-bullshit
review, inversion, premortem, assumption mapping, first principles, reference-class forecasting,
Bayesian updating, kill criteria, stage-gates, steelman opposition, stakeholder/incentive mapping,
FMEA, OODA, and decision journals.

NEGATIVE PRECEDENCE — return false for:

- ordinary planning, roadmap, prioritization, or tradeoff requests without an adversarial/evidence gate
- grief, vulnerability, relationship support, casual chat, facts being asked, how-to, memory, tools,
  scheduling, inbox/file/status, or product-help requests
- pattern-identification requests about delay or avoidance when no stated goal and required material
  commitment are established and no adversarial review is requested
- pure education about decision methods, hypothetical discussion, negated requests, or quoted/rewrite
  text about Red Team
- a broad bias request with no evidence/viability scope; Confirmation Bias owns that

Contrast:

- "Red-team this launch decision and give kill criteria" -> true
- "I keep delaying the visa required for the job I say I want because staying here feels safer" -> true
- "Build a six-week roadmap for three people" -> false
- "After a difficult month I want a quiet weekend to recover" -> false
- "Find the pattern: I delayed outreach, rewrote the deck, then delayed outreach again" -> false
- "I do not think I can keep pretending this is fine" -> false
- "What is a premortem?" -> false
- "Rewrite: red-team my plan" -> false

If the positive gate is not clearly met, return false.
