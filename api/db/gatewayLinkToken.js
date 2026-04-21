/* === VIVENTIUM START ===
 * Feature: Generic gateway link token model
 * Purpose: Store one-time link tokens for channel/account/externalUser identity linking.
 * Added: 2026-02-19
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createGatewayLinkToken(db) {
  const connection = db || mongoose;
  if (connection.models.GatewayLinkToken) {
    return connection.models.GatewayLinkToken;
  }

  const schema = new mongoose.Schema(
    {
      tokenHash: { type: String, required: true, index: true, unique: true },
      channel: { type: String, required: true, index: true },
      accountId: { type: String, required: true, default: 'default', index: true },
      externalUserId: { type: String, required: true, index: true },
      externalUsername: { type: String, default: '' },
      metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      consumedAt: { type: Date, default: null },
    },
    { timestamps: true },
  );
  return connection.model('GatewayLinkToken', schema);
};
