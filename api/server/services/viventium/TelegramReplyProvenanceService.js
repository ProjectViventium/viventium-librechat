/* === VIVENTIUM START === Thin legacy adapter for typed Telegram reply provenance. === */
const { createTelegramReplyProvenanceService } = require('@librechat/api');
const { logger } = require('@librechat/data-schemas');
const { ViventiumGlassHiveCallbackDelivery, Message } = require('~/db/models');

module.exports = createTelegramReplyProvenanceService({
  ReceiptModel: ViventiumGlassHiveCallbackDelivery,
  MessageModel: Message,
  logger,
});
/* === VIVENTIUM END === */
