/* === VIVENTIUM START ===
 * Feature: Generic gateway external user <-> LibreChat user mapping model
 * Purpose: Persist multi-channel identity bindings (channel + account + externalUserId).
 * Added: 2026-02-19
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createGatewayUserMapping(db) {
  const connection = db || mongoose;
  if (connection.models.GatewayUserMapping) {
    return connection.models.GatewayUserMapping;
  }

  const schema = new mongoose.Schema(
    {
      channel: { type: String, required: true, index: true },
      accountId: { type: String, required: true, default: 'default', index: true },
      externalUserId: { type: String, required: true, index: true },
      externalUsername: { type: String, default: '' },
      libreChatUserId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
      },
      metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
      linkedAt: { type: Date, default: Date.now },
      lastSeenAt: { type: Date, default: Date.now },
    },
    { timestamps: true },
  );

  schema.index({ channel: 1, accountId: 1, externalUserId: 1 }, { unique: true });

  return connection.model('GatewayUserMapping', schema);
};
