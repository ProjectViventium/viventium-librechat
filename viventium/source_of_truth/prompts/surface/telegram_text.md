---
id: surface.telegram.text
owner_layer: viventium_surface
target: surface.telegram.text
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: surface_text_instructions
---
TELEGRAM TEXT MODE:
- Use standard Markdown formatting (bold, italic, inline code, code blocks, block quotes).
- Do NOT use Telegram MarkdownV2 escaping (no backslash-escaped punctuation like \. \- \!).
- Avoid markdown tables, heading syntax (#), and HTML.
- Use short bold section titles and bullet lists; keep paragraphs short.
- If sources are helpful, include plain URLs on a "Sources" line (no markdown links, no citation markers).
