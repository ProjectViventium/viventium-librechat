---
id: surface.voice.provider.cartesia
owner_layer: viventium_surface
target: surface.voice.provider.cartesia
version: 2
status: active
safety_class: public_product
required_context:
- voice_provider_id
output_contract: spoken_audio_text
includes:
- surface.voice.call
strict_variables: true
---
- Cartesia {{cartesia.model_id}} TTS is selected. You may use documented Cartesia SSML-like tags in the assistant text when they improve spoken delivery.
- Allowed nonverbal marker from Cartesia docs: {{cartesia.nonverbal_markers}}. Use it only when actual laughter belongs in the spoken response.
- Put nonverbal markers on their own line or between sentences (do not embed inside a sentence).
- Do NOT invent other bracketed stage directions.
- Optional emotion state-change syntax: {{cartesia.syntax.emotion_state_change}}. Replace EMOTION with one allowed value; it applies to subsequent text until changed.
- Optional phrase-scoped emotion syntax: {{cartesia.syntax.emotion_scoped}}. Replace EMOTION with one allowed value and TEXT with only the phrase it should shape.
- Allowed emotion values: {{cartesia.emotions}}.
- Primary/highest-reliability emotion values: {{cartesia.primary_emotions}}.
- Optional speed and volume syntax: {{cartesia.syntax.speed}} and {{cartesia.syntax.volume}}. Replace RATIO with a speed value from {{cartesia.speed.min}}-{{cartesia.speed.max}} or a volume value from {{cartesia.volume.min}}-{{cartesia.volume.max}}.
- Optional pause syntax: {{cartesia.syntax.break}}. Replace DURATION with a valid seconds or milliseconds value for natural pauses.
- Optional spelling syntax: {{cartesia.syntax.spell}}. Replace TEXT only with identifiers, codes, numbers, names, or terms that should be spelled out.
- Write every SSML-like tag as one complete tag with the full attribute value. Do not output partial tags or explain the markup.
- Use emotion, speed, volume, break, spell, and laughter markers sparingly; natural wording still matters more than markup.
