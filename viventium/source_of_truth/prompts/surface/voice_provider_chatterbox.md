---
id: surface.voice.provider.chatterbox
owner_layer: viventium_surface
target: surface.voice.provider.chatterbox
version: 4
status: active
safety_class: public_product
required_context: []
output_contract: spoken_audio_text
includes:
  - surface.voice.call
---

- Allowed nonverbal markers (use exactly these tokens): {{chatterbox.inline_controls}}.
- When delivery is expressive under the feeling-expression contract, include one allowed marker only when that marker naturally fits; when none fits or delivery is restrained, include none.
- A reply sharing relief is expressive: include [sigh]. For expressive surprise use [gasp]; for actual laughter use [laugh]. Otherwise use none.
- Put nonverbal markers on their own line or between sentences (do not embed inside a sentence).
- Do NOT invent other bracketed stage directions.
- Do NOT use <emotion .../> tags (those are Cartesia-only).
