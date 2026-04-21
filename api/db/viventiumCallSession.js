/* === VIVENTIUM START ===
 * Feature: Voice call session persistence (Mongo TTL)
 * Purpose: Store LiveKit voice call sessions across process restarts.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumCallSession(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumCallSession) {
    return connection.models.ViventiumCallSession;
  }

  /* === VIVENTIUM START ===
   * Feature: Modern playground voice-route persistence
   * Purpose: Store per-call requested STT/TTS selections alongside the voice call session.
   * === VIVENTIUM END === */
  const voiceRouteSelectionSchema = new mongoose.Schema(
    {
      provider: { type: String, default: null },
      variant: { type: String, default: null },
    },
    { _id: false },
  );

  const voiceRouteStateSchema = new mongoose.Schema(
    {
      stt: { type: voiceRouteSelectionSchema, default: null },
      tts: { type: voiceRouteSelectionSchema, default: null },
    },
    { _id: false },
  );

  const schema = new mongoose.Schema(
    {
      callSessionId: { type: String, required: true, index: true, unique: true },
      userId: { type: String, required: true, index: true },
      agentId: { type: String, required: true },
      conversationId: { type: String, required: true },
      roomName: { type: String, required: true },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      wingModeEnabled: { type: Boolean, default: null },
      shadowModeEnabled: { type: Boolean, default: null },
      requestedVoiceRoute: { type: voiceRouteStateSchema, default: null },
      // === VIVENTIUM NOTE ===
      // Feature: Voice worker lease + dispatch idempotency fields
      // Purpose: Ensure one active worker per call session and atomic dispatch creation.
      activeJobId: { type: String, default: null },
      activeWorkerId: { type: String, default: null },
      leaseExpiresAt: { type: Date, default: null },
      dispatchClaimId: { type: String, default: null },
      dispatchClaimedAt: { type: Date, default: null },
      dispatchConfirmedAt: { type: Date, default: null },
      dispatchRoomName: { type: String, default: null },
      dispatchAgentName: { type: String, default: null },
      dispatchLastError: { type: String, default: null },
      dispatchLastErrorAt: { type: Date, default: null },
      // === VIVENTIUM NOTE ===
    },
    { timestamps: true },
  );
  return connection.model('ViventiumCallSession', schema);
};
