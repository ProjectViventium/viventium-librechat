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
      /* === VIVENTIUM START ===
       * Feature: Durable Telegram turn authority.
       * Purpose: Route late background delivery to the exact accepted owner/stream/topic without
       * inferring identity from a current chat mapping or a process-local listener.
       * === VIVENTIUM END === */
      libreChatUserId: { type: String, default: '', index: true },
      streamId: { type: String, default: '', index: true },
      telegramMessageThreadId: { type: String, default: '' },
      sourceSequence: { type: Number, min: 1, default: null },
      sourceOrderScope: { type: String, default: '' },
      sourceEventId: { type: String, default: '', index: true },
      authorityBoundAt: { type: Date, default: null, index: true },
      /* === VIVENTIUM END === */
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { timestamps: true },
  );

  schema.index(
    { streamId: 1 },
    {
      unique: true,
      partialFilterExpression: { authorityBoundAt: { $type: 'date' } },
      name: 'viventium_telegram_bound_stream_unique',
    },
  );

  return connection.model('ViventiumTelegramIngressEvent', schema);
};
