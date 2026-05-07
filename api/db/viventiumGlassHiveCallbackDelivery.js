/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Durable GlassHive surface callback delivery ledger.
 *
 * Added: 2026-05-06
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumGlassHiveCallbackDelivery(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumGlassHiveCallbackDelivery) {
    return connection.models.ViventiumGlassHiveCallbackDelivery;
  }

  const schema = new mongoose.Schema(
    {
      deliveryKey: { type: String, required: true, unique: true, index: true },
      deliveryId: { type: String, required: true, unique: true, index: true },
      callbackId: { type: String, default: '', index: true },
      callbackKey: { type: String, default: '', index: true },
      callbackMessageId: { type: String, required: true, index: true },
      userId: { type: String, required: true, index: true },
      conversationId: { type: String, required: true, index: true },
      requestedParentMessageId: { type: String, default: '', index: true },
      anchorMessageId: { type: String, default: '', index: true },
      surface: { type: String, required: true, index: true },
      event: { type: String, required: true, index: true },
      workerId: { type: String, default: '', index: true },
      runId: { type: String, default: '', index: true },
      status: {
        type: String,
        required: true,
        enum: ['pending', 'claimed', 'sent', 'failed', 'suppressed'],
        default: 'pending',
        index: true,
      },
      text: { type: String, default: '' },
      fullText: { type: String, default: '' },
      telegramChatId: { type: String, default: '', index: true },
      telegramUserId: { type: String, default: '', index: true },
      telegramMessageId: { type: String, default: '' },
      voiceCallSessionId: { type: String, default: '', index: true },
      voiceRequestId: { type: String, default: '' },
      claimId: { type: String, default: '', index: true },
      claimOwner: { type: String, default: '' },
      claimedAt: { type: Date, default: null },
      leaseExpiresAt: { type: Date, default: null, index: true },
      sentAt: { type: Date, default: null },
      failedAt: { type: Date, default: null },
      suppressedAt: { type: Date, default: null },
      retryCount: { type: Number, default: 0 },
      nextAttemptAt: { type: Date, default: null, index: true },
      lastError: { type: String, default: '' },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { timestamps: true },
  );

  schema.index({ surface: 1, status: 1, nextAttemptAt: 1, createdAt: 1 });
  schema.index({ surface: 1, status: 1, leaseExpiresAt: 1 });
  schema.index({ userId: 1, conversationId: 1, callbackMessageId: 1 });

  return connection.model('ViventiumGlassHiveCallbackDelivery', schema);
};
