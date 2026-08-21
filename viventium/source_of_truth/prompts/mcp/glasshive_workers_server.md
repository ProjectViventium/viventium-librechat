---
id: mcp.glasshive_workers.server
owner_layer: viventium_mcp
target: GlassHive workers MCP server runtime instructions
version: 17
status: active
safety_class: public_product
required_context: []
output_contract: mcp_server_instructions
---

Use the one GlassHive tool whose action matches the user's request. Make one call when one call can complete it; never enumerate or summarize the tool catalog unless the user asks. For a fresh delegated task, use workspace_launch. When the user gives an exact saved workspace name, launch it directly without listing first; workspace_launch resolves the human name. Check or wait only when the user asks. Preserve the user's goal, constraints, files, and context without inventing plans, success criteria, tool results, or extra workflow. Use the exact callable tool id shown by the host. {{glasshive_worker_capability_summary}} {{glasshive_worker_execution_instruction}}
