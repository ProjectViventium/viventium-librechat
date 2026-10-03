/* === VIVENTIUM START === Committed delivery coverage of one accepted Telegram input. */
const { telegramInputConversationGeneration } = require('@librechat/api');

/** The committed Main presentation that covered this exact accepted input. */
function committedDeliveryFilter(record) {
  return {
    user: record.libreChatUserId,
    conversationId: record.conversationId,
    isCreatedByUser: false,
    unfinished: { $ne: true },
    'metadata.viventium.deliveryAcknowledgement.state': 'committed',
    'metadata.viventium.deliverySourceCoverage.source_order_scope': record.sourceOrderScope,
    'metadata.viventium.deliverySourceCoverage.source_conversation_generation': {
      $in: [
        ...new Set([
          telegramInputConversationGeneration(record),
          // The same fresh conversation is subsequently addressed by its canonical
          // ID. Both names belong to this retained source and captured generation.
          telegramInputConversationGeneration({
            ...record,
            requestedConversationId: record.conversationId,
          }),
        ]),
      ],
    },
    'metadata.viventium.deliverySourceCoverage.sources': {
      $elemMatch: {
        source_event_id: record.sourceEventId,
        source_message_id: record.sourceMessageId,
        source_sequence: record.sourceSequence,
        // An input not bound to its own started stream settles only through the answer that
        // authored it; another answer never silently covers an author that never ran.
        ...(record.state === 'admitted' ? {} : { owned: { $ne: false } }),
      },
    },
    $expr: {
      $and: [
        {
          $eq: [
            '$metadata.viventium.deliverySourceCoverage.logical_turn_id',
            '$metadata.viventium.deliveryAcknowledgement.logical_turn_id',
          ],
        },
        {
          $eq: [
            '$metadata.viventium.deliverySourceCoverage.revision',
            '$metadata.viventium.deliveryAcknowledgement.revision',
          ],
        },
      ],
    },
  };
}

module.exports = { committedDeliveryFilter };
/* === VIVENTIUM END === */
