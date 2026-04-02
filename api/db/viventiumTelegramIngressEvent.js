/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Telegram ingress idempotency audit model.
 *
 * Added: 2026-02-18
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumTelegramIngressEvent(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumTelegramIngressEvent) {
    return connection.models.ViventiumTelegramIngressEvent;
  }

  const schema = new mongoose.Schema(
    {
      dedupeKey: { type: String, required: true, unique: true, index: true },
      telegramUserId: { type: String, required: true, index: true },
      telegramChatId: { type: String, default: '' },
      telegramMessageId: { type: String, default: '' },
      telegramUpdateId: { type: String, default: '' },
      traceId: { type: String, default: '' },
      conversationId: { type: String, default: '' },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { timestamps: true },
  );

  return connection.model('ViventiumTelegramIngressEvent', schema);
};
