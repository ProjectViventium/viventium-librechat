/* === VIVENTIUM START ===
 * Feature: Telegram link token model
 * Purpose: Store one-time link tokens for Telegram account linking.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createTelegramLinkToken(db) {
  const connection = db || mongoose;
  if (connection.models.TelegramLinkToken) {
    return connection.models.TelegramLinkToken;
  }

  const schema = new mongoose.Schema(
    {
      tokenHash: { type: String, required: true, index: true, unique: true },
      telegramUserId: { type: String, required: true, index: true },
      telegramUsername: { type: String, default: '' },
      expiresAt: { type: Date, required: true, index: true },
      consumedAt: { type: Date, default: null },
    },
    { timestamps: true },
  );

  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  return connection.model('TelegramLinkToken', schema);
};
