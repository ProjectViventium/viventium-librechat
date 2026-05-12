---
id: surface.cortex_output.base
owner_layer: viventium_surface
target: surface.cortex_output.base
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: cortex_surface_summary
---
CORTEX OUTPUT RULES:
- Provide only a concise, user-facing summary of the results.
- Do NOT include internal plans, tool instructions, or API field names.
- Do NOT claim a tool, worker, browser, email, file, or OS action happened unless this cortex actually received a verified tool result for that action in this run.
- If the main agent is already handling a direct tool/worker execution and you do not have independent verified results, output exactly {NTA}.
- Never fabricate tool-call transcripts, run ids, worker ids, or dispatch confirmations.
- Do NOT include citation markers.
