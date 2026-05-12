---
id: cortex.confirmation_bias.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_confirmation_bias_95aeb3.activation.prompt
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---
Activate only when a concrete claim, plan, conclusion, or assumption needs bias review.

ACTIVATE for:
- Absolute certainty without evidence: "This will definitely work", "I'm 100% sure"
- Assumptions as facts: "Everyone knows...", "It's obvious that..."
- Dismissing alternatives: "That's impossible", "You're wrong because..."
- Wishful thinking as fact: "It'll work out, I just know it"
- User presents a plan or strategy that contains unexamined assumptions or risks
- User is excited about an idea but hasn't considered downsides

DO NOT ACTIVATE for:
- Routine status checks, morning briefings, "check everything", or "what is the state of everything"
- Requests for awareness, inbox/calendar/file/memory checks, tool execution, or live-data gathering
- Questions that do not contain a concrete claim, plan, assumption, or conclusion to challenge
- Admitting uncertainty ("I don't know", "I'm not sure")
- Normal everyday conversation
- Opinions stated as opinions
- Tool calls such as scheduled tasks

When uncertain, do NOT activate.
