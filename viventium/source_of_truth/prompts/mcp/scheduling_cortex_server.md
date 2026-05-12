---
id: mcp.scheduling_cortex.server
owner_layer: viventium_mcp
target: scheduling-cortex MCP server runtime instructions
version: 7
status: active
safety_class: public_product
required_context: []
output_contract: mcp_server_instructions
---
Scheduling Cortex owns reminders, recurring jobs, and schedule management for Viventium.

What it does:
- Create, update, delete, list, search, inspect, and preview schedules.
- Run schedules later through the configured Viventium agent and channels.
- Track last delivery state, including sent, suppressed, failed, and generated text summaries.

When to use:
- The user asks to remind, follow up later, check back, keep watching, run a recurring task, or change an existing schedule.
- The user asks what reminders/jobs exist, when one will run, or what happened on the last run.
- A starter morning briefing exists and should be changed. Its stable template_id is
  morning_briefing_default_v1.

When not to use:
- Do not use for immediate live work that should happen now.
- Do not create duplicate schedules when an existing task can be found and updated.
- Do not branch on prompt text, schedule name, user identity, or template wording; use declared structured fields, internal task references, filters, and tool evidence.

Inputs and identity:
- user_id and agent_id are injected from request headers when omitted.
- Use the user's timezone in schedule payloads when known; otherwise state uncertainty and use an explicit timezone.
- Channels are "telegram", "librechat", or both.

Output and delivery:
- Tools return structured task or summary objects.
- list/search are summary-safe: they return user-facing schedule state plus an internal task reference for follow-up tool calls. They must not return raw prompt text, metadata, user IDs, agent IDs, conversation policy, creator/updater fields, or delivery payloads.
- Use schedule_get or schedule_last_delivery only when full private verification or diagnostics are needed.
- Scheduled runs may intentionally produce {NTA}; silent no-response delivery is valid and should not be surfaced as a system announcement.
- Delivery can be delayed; do not promise completion until a run or last_delivery record says so.
- User-facing replies must translate tool output into plain outcomes. Do not expose task IDs, raw prompt text, metadata keys/flags, tool function names, channel errors, delivery internals, or server/tool plumbing unless the user explicitly asks for diagnostics.
- When a full-detail read shows internal prompt text or metadata solely to verify state, use it as private evidence. The user-facing answer should say what is already configured or what changed, without quoting stored prompt text or naming storage fields.

Duplicate prevention and idempotency:
- For starter morning briefing, use the summary's starter_morning_briefing flag, template_id
  morning_briefing_default_v1, or a private full-detail read to identify the existing task, then
  update that internal task reference; do not create another starter task.
- For user-authored changes, prefer updating a matching existing task over creating a duplicate when the user's intent is to modify an existing reminder/job.
