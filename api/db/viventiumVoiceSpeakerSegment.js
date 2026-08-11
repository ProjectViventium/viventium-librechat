/* === VIVENTIUM START ===
 * Feature: SpeakerSegmentV1 call-scoped ledger
 * Purpose: Persist attribution and late revisions before transcript coalescing without a backfill.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumVoiceSpeakerSegment(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumVoiceSpeakerSegment) {
    return connection.models.ViventiumVoiceSpeakerSegment;
  }

  const schema = new mongoose.Schema(
    {
      callSessionId: { type: String, required: true, index: true },
      segmentId: { type: String, required: true },
      revision: { type: Number, required: true, default: 0 },
      payload: { type: mongoose.Schema.Types.Mixed, required: true },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { timestamps: true },
  );
  schema.index({ callSessionId: 1, segmentId: 1 }, { unique: true });
  return connection.model('ViventiumVoiceSpeakerSegment', schema);
};
