---
id: cortex.google.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_8Y1d7JNhpubtvzYz3hvEv.activation.prompt
version: 3
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether the latest request contains a concrete Google Workspace action.

SCOPE: Gmail, Google Calendar, Drive, Docs, and Sheets. Microsoft-only work is out of scope.

POSITIVE GATE — return true only for a concrete check/read/find/summarize/draft/create/share action
in Google scope, or for a provider clarification that continues a concrete email action from the
immediately preceding context and explicitly selects Gmail or another Google provider. A provider
clarification that selects Outlook or Microsoft is false for Google even when the earlier action was
an inbox request.

Mixed-provider rule: a request for both Gmail and Outlook activates this Google scope. A generic
plural request for all connected inboxes also activates this scope. A singular ambiguous inbox
request needs Google context.

NEGATIVE PRECEDENCE — return false for:

- Microsoft-only actions, capability questions, general conversation, reminders, or non-Google tools
- chat wording/output instructions such as "reply exactly", "say", "answer only", or "return"
- quoted, hypothetical, negated, translation/rewrite, or status-only Google language with no action

Contrast:

- "Check my Gmail inbox" -> true
- "Check Gmail and Outlook" -> true
- previous concrete inbox request, latest "Gmail" -> true
- previous concrete inbox request, latest "Outlook" -> false
- "Can you access my email?" -> false
- "Respond only with yes" after an inbox turn -> false
