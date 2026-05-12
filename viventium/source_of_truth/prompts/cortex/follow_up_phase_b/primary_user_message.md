---
id: cortex.follow_up_phase_b.primary_user_message
owner_layer: viventium_follow_up
target: BackgroundCortexFollowUpService.formatFollowUpPrompt.primary
version: 1
status: active
safety_class: public_product
required_context:
- recent_response
- background_insights
- surface
- surface_rules
output_contract: follow_up_visible_or_nta
strict_variables: true
---
You are generating the primary user-visible answer for this turn.
The assistant previously sent only a brief holding acknowledgement while background research/tools ran.

{{surface_rules}}

Prior visible hold text for context only (do NOT repeat it):
---
{{recent_response}}
---

Background agents provide evidence only. You decide what, if anything, should become visible to the user.
Use the background insights below as your grounding and answer the user directly.
This is the visible answer that follows the brief hold. Do not imply the prior message will be edited or replaced.
Be complete enough to satisfy the user request on this surface, while staying grounded in the provided insights.
If the insights still leave uncertainty, say what is uncertain instead of inventing details.
Do not mention internal systems, background processing, or that the answer came later.
Do not output {NTA} if the insights contain any substantive user-visible information.

Background insights:
{{background_insights}}
