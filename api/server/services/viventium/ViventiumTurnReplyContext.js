/* === VIVENTIUM START ===
 * Feature: Quoted replies of a combined turn.
 * Purpose: The current input's quote and the quote of each other source input this invocation
 * owns reach Main as separate typed capsules, each naming its source S-number the way the rapid
 * source selection does. An additive (response_only) invocation owns its current input and the
 * inputs deferred to it, never an input an earlier revision already authors. The capsules share
 * one reply budget; the current input's quote always comes first.
 * === VIVENTIUM END === */
const { logger } = require('@librechat/data-schemas');
const { ownedInteractionSources } = require('@librechat/api');
const { buildTelegramReplyContextCapsule } = require('./TelegramReplyProvenanceService');

const MAX_TURN_REPLY_CONTEXT_BYTES = 12 * 1024;

function buildTurnReplyContextCapsules(interactionContext, capabilities) {
  const segments = Array.isArray(interactionContext?.source_segments)
    ? interactionContext.source_segments
    : [];
  const owned =
    segments.length > 1 ? ownedInteractionSources(interactionContext, capabilities) : [];
  const currentSourceEventId = interactionContext?.source_event_id;
  const contexts = [];
  if (interactionContext?.reply_context) {
    const current =
      owned.length > 1
        ? owned.find(({ segment }) => segment?.source_event_id === currentSourceEventId)
        : undefined;
    contexts.push({
      ...interactionContext.reply_context,
      ...(current ? { sourceLabel: `S${current.sourceOrdinal}` } : {}),
    });
  }
  for (let position = owned.length - 1; position >= 0; position -= 1) {
    const { sourceOrdinal, segment } = owned[position];
    if (!segment?.reply_context || segment.source_event_id === currentSourceEventId) continue;
    contexts.push({ ...segment.reply_context, sourceLabel: `S${sourceOrdinal}` });
  }
  const capsules = [];
  let bytes = 0;
  for (const [position, context] of contexts.entries()) {
    const capsule = buildTelegramReplyContextCapsule(context);
    if (!capsule) continue;
    const nextBytes = bytes + Buffer.byteLength(capsule, 'utf8') + (capsules.length ? 2 : 0);
    if (capsules.length && nextBytes > MAX_TURN_REPLY_CONTEXT_BYTES) {
      logger.warn('[ViventiumTurnReplyContext] Quoted-reply capsules omitted for the budget', {
        omitted: contexts.length - position,
      });
      break;
    }
    capsules.push(capsule);
    bytes = nextBytes;
  }
  return capsules.join('\n\n');
}

module.exports = { buildTurnReplyContextCapsules };
/* === VIVENTIUM END === */
