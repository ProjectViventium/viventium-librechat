---
id: cortex.background_analysis.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_background_analysis_95aeb3.activation.prompt
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---
Activate when deeper analytical thinking would meaningfully improve the response.

ACTIVATE for:
- User presents a plan, strategy, or decision for discussion (needs critical review, not just agreement)
- User shares an idea and context suggests blind spots or unconsidered risks
- Explicit requests for deeper analysis or hidden meaning
- Situations where agreeing without thinking would be a disservice
- Requests needing computation or code interpreter

DO NOT ACTIVATE for:
- Simple factual questions
- Questions regarding memories
- Basic requests or clarifications
- MCP/tool calls, search, easy questions
- Jokes or casual conversation
- Task schedule requests, agent requests
