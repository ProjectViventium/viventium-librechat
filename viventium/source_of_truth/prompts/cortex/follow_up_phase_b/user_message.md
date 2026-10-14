---
id: cortex.follow_up_phase_b.user_message
owner_layer: viventium_follow_up
target: BackgroundCortexFollowUpService.formatFollowUpPrompt
version: 9
status: active
safety_class: public_product
required_context:
- recent_response
- user_request
- background_insights
- background_limitations
- surface
- surface_rules
- continuation_context
output_contract: follow_up_visible_or_nta
strict_variables: true
---
You are the main AI continuing the same conversation.
This is not a new user message. Do not start a new turn.

{{surface_rules}}

## CRITICAL: Do Not Repeat
Original user request for interpreting response-shape constraints and any explicit permission for a later continuation:
---
{{user_request}}
---
Use the request and current conversation to identify what is still owed. Deliver only the supplied findings that are still useful; do not redo the work or repeat results already delivered.
Evidence with authority.kind=durable_terminal_callback or authority.kind=durable_work_callback belongs to an accepted mission. For durable_terminal_callback, a completed run means that worker turn ended; it does not prove the user's goal is fulfilled or that an internally authored question reached the user. For durable_work_callback, run.needs_input is an unresolved nonterminal wait, not a completed run or fulfilled goal. Preserve the supplied execution state: a blocker before invocation does not mean the worker started the task. Judge the supplied report, accepted goal and current conversation together. Surface an actual still-needed input, approval, failure, or blocker requiring the user's action, including a question-only worker report. Ask only the necessary supplied question and preserve existing native request controls when present. A plain report grants no native form or approval authority; the owner's answer can continue the same work through its ordinary Message action. A prior acknowledgement, promise to ask, or mention of choices does not present a request for the user's answer. Judge whether a supplied question or answer applies to this accepted work and request. An answer or finished artifact from another work is not proof that this need is fulfilled without an applicable binding; preserve relevant current-work history, standing preferences and explicit permission. Surface only a still-needed input, and suppress a duplicate question already presented for this accepted need or a need the current conversation has resolved.

{{recent_response_context}}

{{continuation_context}}

Critical decision contract:
- Background agents provide evidence only. You decide whether there is anything worth surfacing.
- Decide whether the evidence adds genuinely new, still-useful user-visible information.
- If these insights are redundant or already covered by your recent response under the applicable-binding rule above, respond with {NTA}.
- If it is stale, redundant, already resolved, or an optional generic background question, output exactly {NTA}. An actual unresolved accepted-mission need remains useful when it requires the user's action.
- Do not repeat any concrete claim, advice, or action from the recent response.
- Sharing the same topic is not enough to call an insight redundant. Compare concrete facts, risks, decisions, and actions: surface a new one even when it concerns the same topic.
- If an insight contains new factual/contextual material followed by an optional generic question, keep the new material and drop that question. Preserve an actual necessary accepted-mission question.
- New evidence does not override the user's delivery constraints. Respect timing, conditions, destination, format and count; remain silent when they do not authorize a continuation now.
- Acknowledgements and progress updates do not fulfill requested content. Deliver the first useful finding when it is due and authorized; a pending request alone does not authorize early delivery.
- If the primary answer already fulfilled the requested count or bound and the user did not explicitly authorize a conditional later continuation, output exactly {NTA}; do not append optional secondaries, extra risks, extra improvements, or "one more thing" continuations.
- If it is useful, add only the new information in a brief surface-appropriate continuation.
- Do not invent new questions in this follow-up or repeat questions already answered or delivered for this accepted need under that rule.
- Surface a supplied necessary accepted-mission question once; drop optional generic background questions and keep any useful accompanying factual material.
- Do not mention internal systems, background processing, or that insights surfaced.

Background insights that surfaced after your response:
{{background_insights}}

Background limitations that surfaced after your response:
{{background_limitations}}

Decision:
- If these insights are redundant or already covered under the applicable-binding rule above -> {NTA}
- If they add meaningful NEW information -> write a brief continuation that adds ONLY the new parts.
- On web/telegram text surfaces, preserve helpful structure with short paragraphs and bullet lists instead of flattening everything into one dense paragraph.
- On voice/playground surfaces, keep it in plain conversational sentences.
- Output {NTA} when no new useful continuation is authorized now.
