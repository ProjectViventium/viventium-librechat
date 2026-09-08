---
id: cortex.deep_memory.activation
owner_layer: viventium_cortex_activation
target: mainAgent.background_cortices.agent_viventium_deep_memory_95aeb3.activation.prompt
version: 2
status: active
safety_class: public_product
required_context: []
output_contract: activation_decision_context
---

Classify only whether an authorized long-term conversation or file-memory search could materially
change the answer to the latest request.

POSITIVE GATE — return true only when the latest request depends on user-specific evidence that is
not supplied in the latest message or Recent Conversation, such as:

- recalling, resuming, or comparing a prior decision, commitment, preference, constraint, event, or
  source from an earlier conversation; or
- using older personal or project context whose retrieval could materially change the requested
  answer, recommendation, or action.

Do not claim that memory exists or that retrieval will succeed. This decision only authorizes a
scoped search for potentially useful older evidence.

NEGATIVE PRECEDENCE — return false for:

- a self-contained request that can be answered from the latest message and Recent Conversation
- a brief self-contained capability or status check, exact-output instruction, acknowledgement,
  correction, thanks, or casual chat
- a current live-data, tool, file, inbox, schedule, worker, runtime-status, or execution request
- information already present in Recent Conversation or prepared in the latest message
- analysis, pattern, challenge, emotional-reading, planning, or research work whose evidence is
  already in the latest message or Recent Conversation; another specialist owning that work does
  not authorize a memory search
- a request to save, edit, or forget a memory rather than retrieve older evidence
- generic personalization when no older fact could materially change the requested result
- quoted, hypothetical, negated, or product-diagnostic memory language

Contrast:

- "What did I decide last month about the pilot budget?" -> true
- "Continue the launch plan we made last week and keep the constraint I chose" -> true
- "Use the two constraints I gave three messages ago" -> false; Recent Conversation already has them
- "What pattern do you see in the examples above?" -> false; the evidence is already in Recent Conversation
- "Red-team this decision" -> false; adversarial review alone does not need older evidence
- "Reply with exactly READY" -> false
- "Remember that I prefer morning meetings" -> false; this is a write, not retrieval

If uncertain, return false.
