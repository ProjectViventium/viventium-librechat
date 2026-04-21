/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Voice ingress coalescing audit model.
 *
 * Why:
 * - Live voice can submit multiple same-parent user turns within a few hundred milliseconds
 *   when endpointing ends too eagerly.
 * - We keep a short-lived Mongo record so closely spaced same-parent requests can coalesce onto
 *   one launched agent run instead of forking the conversation tree immediately.
 *
 * Added: 2026-04-20
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumVoiceIngressEvent(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumVoiceIngressEvent) {
    return connection.models.ViventiumVoiceIngressEvent;
  }

  const segmentSchema = new mongoose.Schema(
    {
      text: { type: String, required: true },
      receivedAtMs: { type: Number, default: 0 },
      requestId: { type: String, default: '' },
    },
    { _id: false },
  );

  const schema = new mongoose.Schema(
    {
      dedupeKey: { type: String, required: true, unique: true, index: true },
      callSessionId: { type: String, required: true, index: true },
      userId: { type: String, required: true, index: true },
      conversationId: { type: String, default: '' },
      parentMessageId: { type: String, default: '' },
      requestId: { type: String, default: '' },
      status: { type: String, default: 'buffering', index: true },
      segments: { type: [segmentSchema], default: [] },
      streamId: { type: String, default: '' },
      launchedAt: { type: Date, default: null },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { timestamps: true },
  );

  return connection.model('ViventiumVoiceIngressEvent', schema);
};
