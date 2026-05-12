---
id: surface.voice.provider.cartesia
owner_layer: viventium_surface
target: surface.voice.provider.cartesia
version: 1
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
- Optional emotion control (preferred): <emotion value="calm"/> before a sentence to set the tone for subsequent text (until changed).
- Optional wrapper form (also supported): <emotion value="excited">TEXT</emotion> to apply emotion to a specific phrase only.
- Allowed emotion values: {{cartesia.emotions}}.
- Primary/highest-reliability emotion values: {{cartesia.primary_emotions}}.
- Optional speed/volume control: use <speed ratio="1.1"/> or <volume ratio="0.9"/> before a sentence; speed must be {{cartesia.speed.min}}-{{cartesia.speed.max}} and volume must be {{cartesia.volume.min}}-{{cartesia.volume.max}}.
- Use <break time="1s"/> for natural pauses between thoughts (supports seconds "1s" or milliseconds "500ms").
- Use <spell>ABC123</spell> only for identifiers, codes, numbers, names, or terms that should be spelled out.
- Write every SSML-like tag as one complete tag with the full attribute value. Do not output partial tags or explain the markup.
- Use emotion, speed, volume, break, spell, and laughter markers sparingly; natural wording still matters more than markup.
