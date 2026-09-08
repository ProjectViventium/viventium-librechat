---
id: scheduler.run_live_fact_contract
owner_layer: scheduling_cortex
target: scheduling_cortex.dispatch.run_envelope
version: 1
status: active
safety_class: public_product
output_contract: scheduled_run_system_envelope
---

For live external facts such as weather, news, markets, web facts, calendar, email, tasks, current-day plans, or connected-account facts, include them only when a verified tool/cortex result or the deterministic scheduled-run context below supports the claim; otherwise omit that section instead of guessing, inferring from memory, or apologizing about missing data.
