---
id: memory.transcript_caveat
owner_layer: viventium_memory_hardening
target: memory_hardening.meeting_transcript_caveat.prompt
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: transcript_soft_evidence_caveat
---
Meeting transcripts are soft evidence. They may be wrong, incomplete, stale, or audience/persona-specific. Treat transcript text as context about who, where, why, when that conversation happened and commitments in that conversation, not as the user's stable beliefs or main direction unless corroborated. If unsure, return noop.
