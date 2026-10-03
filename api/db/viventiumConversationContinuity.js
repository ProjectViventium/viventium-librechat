/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Conversation legacy continuity record.
 *
 * One record per owner conversation. It binds a reviewed semantic summary to the exact visible
 * source rows it replaces in Main's message carrier (row ID plus content digest, in order), so
 * a long legacy history is carried as summary plus intact recent rows without rewriting,
 * truncating or resetting the stored conversation. Any change to a covered row invalidates it.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumConversationContinuity(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumConversationContinuity) {
    return connection.models.ViventiumConversationContinuity;
  }

  const coveredRow = new mongoose.Schema(
    {
      id: { type: String, required: true },
      sha256: { type: String, required: true },
    },
    { _id: false },
  );

  const schema = new mongoose.Schema(
    {
      ownerId: { type: String, required: true },
      conversationId: { type: String, required: true },
      version: { type: Number, default: 0, min: 0 },
      status: { type: String, enum: ['empty', 'ready', 'degraded'], default: 'empty' },
      throughMessageId: { type: String, default: '' },
      coveredSource: { type: [coveredRow], default: [] },
      coveredDigest: { type: String, default: '' },
      semanticCompaction: { type: mongoose.Schema.Types.Mixed, default: null },
      semanticReview: { type: mongoose.Schema.Types.Mixed, default: null },
      lease: { type: mongoose.Schema.Types.Mixed, default: null },
      lastError: { type: String, default: '' },
    },
    { timestamps: true, collection: 'viventiumconversationcontinuities', minimize: false },
  );
  schema.index({ ownerId: 1, conversationId: 1 }, { unique: true });

  return connection.model('ViventiumConversationContinuity', schema);
};
