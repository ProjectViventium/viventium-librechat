---
id: scheduler.run_envelope
owner_layer: scheduling_cortex
target: scheduling_cortex.dispatch.run_envelope
version: 2
status: active
safety_class: public_product
required_context:
  - scheduled_run_context
output_contract: scheduled_run_system_envelope
strict_variables: true
includes:
  - scheduler.run_envelope_prefix
  - scheduler.run_live_fact_contract
---

Do not mention internal mechanics or talk about scheduling.

## Scheduled Run Context (Deterministic)
{{scheduled_run_context}}
