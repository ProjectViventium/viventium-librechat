/* === VIVENTIUM START ===
 * Feature: Durable source authority for retained Telegram inputs.
 * Purpose: A retained (prepared) Telegram input is admitted through its ingress row, which already
 * carries the verified owner, chat, message and source identity. Once the input's exact stream is
 * admitted, that row is bound as the turn's durable source authority, as a fresh ingress row is
 * bound before authoring. The durable Telegram dispatcher only presents a late follow-up of a turn
 * whose ingress row is bound, so without this a retained turn's follow-up could never reach
 * Telegram. A continued admission of the same stream keeps its first binding time; a row that is
 * not this owner's source on this stream fails closed.
 * === VIVENTIUM END === */
const { ViventiumTelegramIngressEvent } = require('~/db/models');

async function bindRetainedTelegramIngressAuthority({
  ownerId,
  sourceEventId,
  streamId,
  IngressModel = ViventiumTelegramIngressEvent,
}) {
  const owner = String(ownerId || '').trim();
  const source = String(sourceEventId || '').trim();
  const stream = String(streamId || '').trim();
  const result =
    owner && source && stream
      ? await IngressModel.updateOne(
          { sourceEventId: source, libreChatUserId: owner, streamId: stream },
          [{ $set: { authorityBoundAt: { $ifNull: ['$authorityBoundAt', '$$NOW'] } } }],
        )
      : null;
  if (result?.acknowledged === false || Number(result?.matchedCount ?? result?.n ?? 0) < 1) {
    const error = new Error('Retained Telegram input authority could not be bound to its stream');
    error.code = 'TELEGRAM_INGRESS_AUTHORITY_UNAVAILABLE';
    throw error;
  }
}

module.exports = { bindRetainedTelegramIngressAuthority };
