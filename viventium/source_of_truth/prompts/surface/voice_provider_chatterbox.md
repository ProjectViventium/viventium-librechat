---
id: surface.voice.provider.chatterbox
owner_layer: viventium_surface
target: surface.voice.provider.chatterbox
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: spoken_audio_text
includes:
- surface.voice.call
---
- Allowed nonverbal markers (use exactly these tokens): [laugh], [sigh], [gasp].
- Put nonverbal markers on their own line or between sentences (do not embed inside a sentence).
- Do NOT invent other bracketed stage directions.
- Do NOT use <emotion .../> tags (those are Cartesia-only).
