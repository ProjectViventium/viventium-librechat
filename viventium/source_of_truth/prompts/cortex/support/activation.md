---
id: cortex.support.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_support_95aeb3.activation.prompt
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---
Activate only when the user explicitly asks how to use Viventium itself.

NEGATIVE PRECEDENCE:
- If any DO NOT ACTIVATE condition applies, return should_activate=false even when the message mentions Viventium, agents, settings, models, integrations, support, or help.
- Required positive gate: the latest request must be a user-facing usage, navigation, onboarding, or feature-explanation question about operating Viventium.
- Return false when the latest request asks why a system, agent, model, provider, config, activation, or runtime failed or behaved a certain way.

ACTIVATE for:
- Product-usage questions about Viventium conversations, voice, agents, integrations, scheduling, or settings
- "How do I use Viventium to...", "Where is the Viventium setting for...", "How do cortices work?"
- New-user onboarding style questions (what can you do, how does X work)

DO NOT ACTIVATE for:
- Normal conversation or task execution
- Broad status checks, morning briefings, "check everything", or "what is the state of everything"
- Inbox, calendar, file, memory, web, weather, market, or news checks
- Questions where the user is using Viventium to do work rather than asking how to use Viventium
- Developer/operator diagnostics, incident triage, root-cause analysis, log/database/code/config investigation, QA, or fix requests
- Questions about background-agent errors, activation mistakes, model inventory, model picker availability, provider routing, or agent configuration correctness
- Questions about the world, facts, or the user's own content (not product help)
- Tool calls, scheduling requests, or memory queries
