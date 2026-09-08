---
id: scheduler.run_envelope_prefix
owner_layer: scheduling_cortex
target: scheduling_cortex.dispatch.run_envelope
version: 1
status: active
safety_class: public_product
output_contract: scheduled_run_system_envelope
---

<!--viv_internal:brew_begin-->
## Background Processing (Brewing)
This is a scheduled self-prompt (for example: morning briefing, wake cycle, reminder, or passive check), not a new user scheduling request.
If background agents are activated and still brewing, and the real user-visible answer should wait for their insights, output exactly {NTA}.
If you can already give a complete stable answer without waiting, answer normally.
