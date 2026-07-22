---
id: cortex.confirmation_bias.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_confirmation_bias_95aeb3.activation.prompt
version: 7
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether the latest message contains a concrete bias signal worth challenging.

Apply NEGATIVE PRECEDENCE before the positive gate. Asking for an adversarial method such as Red Team,
premortem, strongest counter-case, or kill criteria does not by itself establish confirmation bias.
However, return true when that same latest message independently contains a positive bias signal;
an explicit Red Team request never cancels an explicit or concrete bias signal.

SUBJECT GATE — first identify a claim, conclusion, or assumption the user actually endorses. If there
is none, return false. Observations about another person's words or behavior are not the user's
conclusion, and an open question about what those observations might mean is evidence-seeking rather
than confirmation bias.

Hard check before `true`: identify the user's endorsed conclusion in the latest message. Reported
speech from another person cannot satisfy this check. If the user only describes that person's words
and behavior and asks what they may mean, return false.

POSITIVE GATE — return true only when the latest request contains a concrete claim, plan, conclusion, or assumption plus
at least one of these signals:

- unsupported certainty or inevitability
- an assumption presented as fact
- dismissal of alternatives or contrary evidence
- wishful thinking, one-example generalization, or an explicit request to identify confirmation bias

A plan, decision, excitement, or request for advice by itself is not a bias signal.
Likewise, an open question about what the user may be missing is not a biased conclusion. The latest
message must contain an actual unsupported claim or assumption made by the user.

NEGATIVE PRECEDENCE — return false for:

- admitted uncertainty, open questions, ordinary opinions, or evidence-seeking language
- routine status/briefing, inbox/calendar/file/memory, tool, live-data, or scheduling requests
- routine status checks such as "check everything" or "what is the state of everything", and
  requests whose purpose is live-data gathering
- explicit Red Team, planning, pattern, emotional, or product-help requests without a separate bias signal
- repeated delay, avoidance, or other behavior described only so the assistant can find a pattern;
  behavior is not a bias claim unless the latest message also asserts a biased conclusion or assumption
- a mismatch between another person's words and communication style, or a request to interpret what
  that person may feel or leave unsaid; an emotional cue is not a bias signal unless the latest message
  also asserts an unsupported conclusion about it
- quoted, hypothetical, negated, or output-format-only bias language

Contrast:

- "One enthusiastic buyer proves the whole market wants it" -> true
- "Red-team this and call out my confirmation bias: one buyer proves the market wants it" -> true
- "Red-team this launch decision and give kill criteria" -> false
- "Run a premortem and find the strongest counter-argument" -> false
- "Help me choose between two hiring plans" -> false
- "Find the pattern: I delayed outreach, rewrote the deck, then delayed outreach again" -> false
- "They say everything is okay, but their communication changed; what might I be missing?" -> false;
  this asks for emotional or relational inference and contains no user-endorsed conclusion
- "I am not sure; what evidence would reduce uncertainty?" -> false

If uncertain, return false.
