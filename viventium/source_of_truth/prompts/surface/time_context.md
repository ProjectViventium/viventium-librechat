---
id: surface.time_context
owner_layer: viventium_surface
target: surface.time_context
version: 1
status: active
safety_class: public_product
required_context:
  - formatted_time
  - timezone
output_contract: time_context_instruction
strict_variables: true
---
Current time: {{formatted_time}} ({{timezone}})
