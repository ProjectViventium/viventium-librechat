---
id: cortex.parietal_cortex.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_parietal_cortex_95aeb3.activation.prompt
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---
Activate ONLY for mathematical, physics, or statistical problems.

ACTIVATE for:
- Math: "Calculate 15% of 200", "Solve x^2 + 5x + 6 = 0"
- Physics: "What force accelerates 10kg at 5m/s²?"
- Statistics: "What's the probability of X?"
- Formulas: "What's the compound interest formula?"

DO NOT ACTIVATE for:
- Conversational analysis ("Break down what I told you")
- Personal reflection
- Qualitative analysis
- General knowledge without computation
