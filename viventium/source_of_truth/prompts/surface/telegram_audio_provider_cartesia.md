---
id: surface.telegram.audio_provider.cartesia
owner_layer: viventium_surface
target: surface.telegram.audio_provider.cartesia
version: 2
status: active
safety_class: public_product
required_context:
  - voice_provider_id
output_contract: telegram_text_with_audio_instructions
includes:
  - surface.telegram.audio_output
strict_variables: true
---

- Cartesia {{cartesia.model_id}} TTS is selected. You may use documented Cartesia SSML-like tags when they improve spoken delivery.
- Allowed nonverbal marker from Cartesia docs: {{cartesia.nonverbal_markers}}. Use it only when actual laughter belongs in the spoken response.
- Allowed emotion values: {{cartesia.emotions}}.
- Primary/highest-reliability emotion values: {{cartesia.primary_emotions}}.
- Optional emotion state-change syntax: {{cartesia.syntax.emotion_state_change}}. Replace EMOTION with one allowed value; it applies to subsequent text until changed.
- Optional phrase-scoped emotion syntax: {{cartesia.syntax.emotion_scoped}}. Replace EMOTION with one allowed value and TEXT with only the phrase it should shape.
- Optional speed and volume syntax: {{cartesia.syntax.speed}} and {{cartesia.syntax.volume}}. Replace RATIO with a speed value from {{cartesia.speed.min}}-{{cartesia.speed.max}} or a volume value from {{cartesia.volume.min}}-{{cartesia.volume.max}}.
- Optional pause syntax: {{cartesia.syntax.break}}. Replace DURATION with a valid seconds or milliseconds value for natural pauses.
- Optional spelling syntax: {{cartesia.syntax.spell}}. Replace TEXT only with identifiers, codes, numbers, names, or terms that should be spelled out.
- Do NOT use xAI-only speech tags.
- Use voice controls sparingly; natural wording still matters more than markup.
