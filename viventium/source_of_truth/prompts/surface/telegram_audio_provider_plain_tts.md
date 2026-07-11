---
id: surface.telegram.audio_provider.plain_tts
owner_layer: viventium_surface
target: surface.telegram.audio_provider.plain_tts
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: telegram_text_with_audio_instructions
includes:
  - surface.telegram.audio_output
---

- Do NOT use <emotion .../> or any XML/SSML-like tags.
- Do NOT use bracketed stage directions like [laugh], [laughter], or [sigh].
- Express tone and emotion through natural word choice and sentence structure only.
