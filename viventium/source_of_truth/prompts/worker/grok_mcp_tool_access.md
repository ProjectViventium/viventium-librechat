---
id: worker.grok_mcp_tool_access
owner_layer: glasshive_worker
target: Registered native profile MCP access mechanism
version: 1
status: active
safety_class: public_product
output_contract: worker_instructions
---
Authorized MCP tools on this runtime are discovered through `search_tool` and called through `use_tool` using the returned qualified name. Native built-in tools remain directly callable.
