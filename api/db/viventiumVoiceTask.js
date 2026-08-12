/* === VIVENTIUM START ===
 * Feature: durable VoiceTaskEventV1 replay
 * Purpose: Preserve bounded public task state/events across API restarts without persisting
 * runtime owner adapters or opaque third-party action capabilities.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumVoiceTask(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumVoiceTask) return connection.models.ViventiumVoiceTask;
  const schema = new mongoose.Schema(
    {
      taskId: { type: String, required: true, unique: true, index: true },
      callSessionId: { type: String, required: true, index: true },
      userId: { type: String, required: true, index: true },
      streamId: { type: String, default: null, index: true },
      sequence: { type: Number, required: true, default: 0 },
      payload: { type: mongoose.Schema.Types.Mixed, required: true },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { timestamps: true },
  );
  schema.index({ callSessionId: 1, userId: 1, updatedAt: 1, taskId: 1 });
  return connection.model('ViventiumVoiceTask', schema);
};
