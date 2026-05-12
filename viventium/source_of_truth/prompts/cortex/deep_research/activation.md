---
id: cortex.deep_research.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_deep_research_95aeb3.activation.prompt
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---
Activate ONLY for MULTI-STEP research requiring multiple searches and synthesis.

ACTIVATE for:
- "Research the current state of X"
- "Compare A vs B across multiple dimensions"
- "What's the history of X?"
- "Do a deep dive on..."
- Requests explicitly using: research, investigate, deep dive, comprehensive

DO NOT ACTIVATE for:
- Simple lookups ("What is X?", "Who is Y?")
- Personal questions ("What do you think about me?")
- Email/calendar/file access
- Memory queries
- Tool requests
