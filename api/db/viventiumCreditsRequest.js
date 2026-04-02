/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Credits purchase request audit model
 *
 * Added: 2026-02-18
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumCreditsRequest(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumCreditsRequest) {
    return connection.models.ViventiumCreditsRequest;
  }

  const schema = new mongoose.Schema(
    {
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
      },
      email: { type: String, default: '' },
      name: { type: String, default: '' },
      ip: { type: String, default: '' },
      continentCode: { type: String, default: '' },
      continentName: { type: String, default: '' },
      countryCode: { type: String, default: '' },
      country: { type: String, default: '' },
      city: { type: String, default: '' },
      status: { type: String, default: 'requested' },
      notifiedAdmin: { type: Boolean, default: false },
    },
    { timestamps: true },
  );

  return connection.model('ViventiumCreditsRequest', schema);
};
