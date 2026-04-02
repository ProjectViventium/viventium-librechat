/* === VIVENTIUM START ===
 * Feature: Telegram <-> LibreChat user mapping model
 * Purpose: Persist per-Telegram-user LibreChat account bindings.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createTelegramUserMapping(db) {
  const connection = db || mongoose;
  if (connection.models.TelegramUserMapping) {
    return connection.models.TelegramUserMapping;
  }

  const schema = new mongoose.Schema(
    {
      telegramUserId: { type: String, required: true, index: true, unique: true },
      libreChatUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
      },
      telegramUsername: { type: String, default: '' },
      linkedAt: { type: Date, default: Date.now },
      lastSeenAt: { type: Date, default: Date.now },
      /* === VIVENTIUM START ===
       * Feature: Persist Telegram voice preferences for scheduler dispatch parity.
       * === VIVENTIUM END === */
      alwaysVoiceResponse: { type: Boolean, default: false },
      voiceResponsesEnabled: { type: Boolean, default: true },
      voicePrefsUpdatedAt: { type: Date, default: null },
    },
    { timestamps: true },
  );

  return connection.model('TelegramUserMapping', schema);
};
