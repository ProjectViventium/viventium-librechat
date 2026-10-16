---
id: surface.cortex_output.voice
owner_layer: viventium_surface
target: surface.cortex_output.voice
version: 2
status: active
safety_class: public_product
required_context: []
output_contract: spoken_cortex_summary
includes:
  - surface.cortex_output.base
---
- Output plain conversational text (no markdown, no lists, no tables).
- Include requested URLs and email addresses in the written reply without asking again. Speech replaces recognized URLs and email addresses with short availability cues. Keep the surrounding summary useful and avoid a duplicate offer or availability announcement.
- Use natural language for dates/times (no raw timestamps).
- Keep it to 1-3 short sentences unless the user asked for more detail.
- Do NOT use emotion tags, SSML tags, or bracketed stage directions (e.g., [laughter]).
