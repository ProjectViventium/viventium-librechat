---
id: scheduler.run_context_contract
owner_layer: scheduling_cortex
target: scheduling_cortex.dispatch.run_envelope
version: 1
status: active
safety_class: public_product
output_contract: scheduled_run_system_envelope
---

Use `scheduled_due_local_date` as the anchor date for this run. Do not carry forward dates or day labels from earlier messages in the conversation, and do not use the next recurrence as today's date.
For calendar/email/task sections, use the calendar window above and verified tool/cortex results. If those results are unavailable, do not invent events, tasks, or day-specific plans.
