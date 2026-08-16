/* === VIVENTIUM START ===
 * Feature: durable cancellation suppression barrier
 * Purpose: Keep cancellation tombstones independent from the bounded live task cache so task
 * eviction or an API restart cannot allow late output to cross persistence/memory boundaries.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumVoiceTaskSuppression(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumVoiceTaskSuppression) {
    return connection.models.ViventiumVoiceTaskSuppression;
  }
  const schema = new mongoose.Schema(
    {
      taskId: { type: String, required: true, unique: true, index: true },
      streamId: { type: String, default: null, index: true },
      callSessionId: { type: String, required: true, index: true },
      userId: { type: String, required: true, index: true },
      operationId: { type: String, default: null },
      ownerDeliveryPending: { type: Boolean, default: false },
      ownerCancellationAccepted: { type: Boolean, default: false },
      eventId: { type: String, default: null },
      sequence: { type: Number, default: null },
      emittedAt: { type: Date, default: null },
      state: { type: String, default: 'cancelling' },
      conversationId: { type: String, default: null },
      turnId: { type: String, default: null },
      parentTaskId: { type: String, default: null },
      ownerKind: { type: String, default: 'generation_job' },
      ownerId: { type: String, default: null },
      acceptedAt: { type: Date, required: true },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { timestamps: true },
  );
  schema.index({ callSessionId: 1, userId: 1, updatedAt: 1, taskId: 1 });
  return connection.model('ViventiumVoiceTaskSuppression', schema);
};
