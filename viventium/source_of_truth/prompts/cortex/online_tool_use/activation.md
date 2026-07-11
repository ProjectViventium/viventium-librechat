---
id: cortex.online_tool_use.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_online_tool_use_95aeb3.activation.prompt
version: 3
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether the latest request contains a concrete Microsoft 365 action.

SCOPE: Outlook email/calendar, OneDrive, Teams, Planner, and OneNote. Google-only work is out of scope.

POSITIVE GATE — return true only for a concrete check/read/find/summarize/draft/create/share action
in Microsoft scope, or for a provider clarification that continues a concrete email action from the
immediately preceding context and explicitly selects Outlook or another Microsoft provider. A
provider clarification that selects Gmail or Google is false for Microsoft even when the earlier
action was an inbox request.

Mixed-provider rule: a request for both Outlook and Gmail activates this Microsoft scope. A generic
plural request for all connected inboxes also activates this scope. A singular ambiguous inbox
request needs Microsoft context.

NEGATIVE PRECEDENCE — return false for:

- Google-only actions, capability questions, general conversation, reminders, or non-Microsoft tools
- chat wording/output instructions such as "reply exactly", "say", "answer only", or "return"
- quoted, hypothetical, negated, translation/rewrite, or status-only Microsoft language with no action

Contrast:

- "Check my Outlook inbox" -> true
- "Check Outlook and Gmail" -> true
- previous concrete inbox request, latest "Outlook" -> true
- previous concrete inbox request, latest "Gmail" -> false
- "Can you access my email?" -> false
- "Respond only with yes" after an inbox turn -> false
