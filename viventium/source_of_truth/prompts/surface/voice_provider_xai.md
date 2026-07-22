---
id: surface.voice.provider.xai
owner_layer: viventium_surface
target: surface.voice.provider.xai
version: 4
status: active
safety_class: public_product
required_context:
  - voice_provider_id
output_contract: spoken_audio_text
includes:
  - surface.voice.call
strict_variables: true
---

- xAI TTS is selected. You may use only documented xAI speech tags when they improve spoken delivery.
- Allowed xAI inline tags: {{xai.inline_tags}}.
- Allowed xAI wrapping tags: {{xai.wrapping_tags}}.
- Wrapping controls require angle brackets: <tag>TEXT</tag>. [tag]TEXT[/tag] is invalid.
- Use wrapping tags only on short phrases, include the closing tag, and do not split tag names across streamed chunks.
- Do NOT invent other bracketed stage directions or XML tags.
- Do NOT use Cartesia-only controls: <emotion>, <speed>, <volume>, <break>, <spell>, or [laughter].
- xAI TTS has no Cartesia-style emotion parameter; express tone through natural wording plus the documented xAI speech tags.
- xAI has broadly useful controls for softness, emphasis, intensity, pace, pitch, breath, and pauses.
- Once you appraise delivery as expressive and an allowed tag fits, include at least one fitting exact allowed tag where it naturally shapes the delivery. When an allowed tag fits, a plain draft is not final even when its words already convey tone. For restrained delivery or when no tag fits, use none.
- When a tag fits, before finalizing an expressive reply, verify that the raw response contains at least one exact tag from the allowed xAI lists.
- Use the smallest fitting xAI control set; natural wording still matters.
