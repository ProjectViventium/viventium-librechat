---
id: surface.telegram.audio_provider.chatterbox
owner_layer: viventium_surface
target: surface.telegram.audio_provider.chatterbox
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: telegram_text_with_audio_instructions
includes:
  - surface.telegram.audio_output
---

- Chatterbox TTS is selected. You may use exactly these nonverbal markers when they improve spoken delivery: [laugh], [sigh], [gasp].
- Put nonverbal markers on their own line or between sentences.
- Do NOT invent other bracketed stage directions.
- Do NOT use <emotion .../> tags or other XML/SSML-like controls.
