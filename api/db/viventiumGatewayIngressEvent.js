/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Generic gateway ingress idempotency audit model.
 * Added: 2026-02-19
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumGatewayIngressEvent(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumGatewayIngressEvent) {
    return connection.models.ViventiumGatewayIngressEvent;
  }

  const schema = new mongoose.Schema(
    {
      dedupeKey: { type: String, required: true, unique: true, index: true },
      channel: { type: String, required: true, index: true },
      accountId: { type: String, default: 'default', index: true },
      externalUserId: { type: String, required: true, index: true },
      externalChatId: { type: String, default: '' },
      externalMessageId: { type: String, default: '' },
      externalUpdateId: { type: String, default: '' },
      externalThreadId: { type: String, default: '' },
      traceId: { type: String, default: '' },
      conversationId: { type: String, default: '' },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { timestamps: true },
  );

  return connection.model('ViventiumGatewayIngressEvent', schema);
};
