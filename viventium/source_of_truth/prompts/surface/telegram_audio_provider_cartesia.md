---
id: surface.telegram.audio_provider.cartesia
owner_layer: viventium_surface
target: surface.telegram.audio_provider.cartesia
version: 1
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
- Optional speed/volume control: use <speed ratio="1.1"/> or <volume ratio="0.9"/> before a sentence; speed must be {{cartesia.speed.min}}-{{cartesia.speed.max}} and volume must be {{cartesia.volume.min}}-{{cartesia.volume.max}}.
- Use <break time="1s"/> for natural pauses and <spell>ABC123</spell> only for identifiers that should be spelled out.
- Do NOT use xAI-only speech tags.
- Use voice controls sparingly; natural wording still matters more than markup.
