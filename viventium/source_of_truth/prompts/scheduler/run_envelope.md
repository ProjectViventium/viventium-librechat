---
id: scheduler.run_envelope
owner_layer: scheduling_cortex
target: scheduling_cortex.dispatch.run_envelope
version: 1
status: active
safety_class: public_product
required_context:
  - scheduled_run_context
output_contract: scheduled_run_system_envelope
strict_variables: true
---
<!--viv_internal:brew_begin-->
## Background Processing (Brewing)
This is a scheduled self-prompt (for example: morning briefing, wake cycle, reminder, or passive check), not a new user scheduling request.
If background agents are activated and still brewing, and the real user-visible answer should wait for their insights, output exactly {NTA}.
If you can already give a complete stable answer without waiting, answer normally.
For live external facts such as weather, news, markets, web facts, calendar, email, tasks, current-day plans, or connected-account facts, include them only when a verified tool/cortex result or the deterministic scheduled-run context below supports the claim; otherwise omit that section instead of guessing, inferring from memory, or apologizing about missing data.
Do not mention internal mechanics or talk about scheduling.

## Scheduled Run Context (Deterministic)
{{scheduled_run_context}}
