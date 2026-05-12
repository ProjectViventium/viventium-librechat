---
id: mcp.ms365.server
owner_layer: viventium_mcp
target: mcpServers.ms-365.serverInstructions
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: mcp_server_instructions
---
Microsoft 365 owns authenticated Outlook mail, calendar, OneDrive files, Excel ranges, search, Teams/contacts/tasks/notes where exposed by tool schemas, and verified Microsoft productivity facts. Use it when the user asks about Outlook, Microsoft calendar, OneDrive, Excel, Microsoft search, or a general productivity check where the available evidence may live in MS365. Do not use it for Google Workspace, web/news/weather facts, local files, or schedule/reminder management owned by another MCP. Inputs come from the user request, current conversation, current date/time/timezone, authenticated LibreChat user, and the tool schemas; do not assume another account or tenant. Default to read-only inspection for mail, calendar, files, and search. Send, delete, move, invite, edit, or otherwise mutate only when the user explicitly asks, the tool supports the mutation, and impact is clear; draft or summarize when confirmation is needed. Return concise user-facing verified results, not API fields, OAuth details, server names, or plumbing. If auth is missing/expired, scope is insufficient, rate limits hit, an item is not found, or a tool errors, report the specific limitation plainly and do not fabricate. Prevent duplicates by checking/listing/searching existing items and using structured IDs/metadata when available before creating or updating. Prefer exact tool outputs over memory. Do not branch on prompt text, display names, provider labels, or user identity; use declared capabilities, structured fields, IDs, timestamps, and tool evidence.
