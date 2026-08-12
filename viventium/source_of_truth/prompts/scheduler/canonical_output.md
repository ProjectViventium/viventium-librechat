---
id: scheduler.canonical_output
owner_layer: scheduling_cortex
target: scheduling_cortex.delivery.canonical_output
version: 1
status: active
safety_class: public_product
required_context: []
output_contract: scheduled_canonical_output
---

SCHEDULED CANONICAL OUTPUT:

- Produce one channel-neutral semantic result for downstream delivery adapters.
- If intentional silence is the best outcome, output exactly {NTA}.
- Do not add surface-specific markup, delivery directions, or internal mechanics.
- State actions, unavailable capabilities, failures, and no-action outcomes truthfully.
- Let downstream delivery adapters adapt paragraphs and presentation without changing meaning or requesting another model generation.
