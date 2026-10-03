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
      requestedConversationId: { type: String },
      conversationGeneration: { type: String },
      sourceMessageId: { type: String },
      mediaGroupId: { type: String },
      inputState: {
        type: String,
        enum: ['preparing', 'ready', 'admitted', 'failed', 'completed', 'cancelled'],
      },
      inputClaimToken: { type: String },
      inputLeaseUntil: { type: Number, min: 0 },
      inputRetryAt: { type: Number, min: 0 },
      inputAttempts: { type: Number, min: 0 },
      inputFailureCode: { type: String },
      inputPreparedDigest: { type: String },
      inputRegistrationId: { type: String },
      inputPrimarySourceEventId: { type: String },
      inputRelatedSourceEventIds: { type: [String], default: undefined },
      inputFailures: {
        type: [new mongoose.Schema({ code: String, at: Number }, { _id: false })],
        default: undefined,
      },
      /* === VIVENTIUM END === */
      expiresAt: {
        type: Date,
        required: function () {
          return !this.inputState || ['completed', 'cancelled'].includes(this.inputState);
        },
        index: { expireAfterSeconds: 0 },
      },
    },
    { timestamps: true },
  );

  schema.index(
    { sourceEventId: 1 },
    {
      unique: true,
      partialFilterExpression: { inputState: { $type: 'string' } },
      name: 'viventium_telegram_prepared_source_unique',
    },
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
