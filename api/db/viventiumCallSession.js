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
      /* === VIVENTIUM START ===
       * Feature: server-owned LiveKit launch identity
       * Purpose: Persist the immutable gateway and owner participant identity so refresh/rejoin
       * token minting never trusts browser-selected room, agent, or participant values.
       * === VIVENTIUM END === */
      gatewayAgentName: { type: String, default: null },
      ownerParticipantIdentity: { type: String, default: null },
      /* === VIVENTIUM START ===
       * Feature: browser-scoped call capability
       * Purpose: A call-session identifier is routing metadata, not browser authority. Persist
       * only the SHA-256 digest and expiry of the one-time launch capability.
       * === VIVENTIUM END === */
      browserCapabilityHash: { type: String, maxlength: 64, default: null, select: false },
      browserCapabilityExpiresAt: { type: Date, default: null, select: false },
      browserCapabilityVersion: { type: Number, default: null, select: false },
      browserCapabilityScope: { type: String, maxlength: 40, default: null, select: false },
      /* === VIVENTIUM START ===
       * Feature: one-time Telegram call launch exchange
       * Purpose: Telegram buttons may be forwarded or cached outside the browser. Persist only a
       * short-lived launch-token digest and atomically exchange it once for browser authority.
       * === VIVENTIUM END === */
      browserLaunchCapabilityHash: { type: String, maxlength: 64, default: null, select: false },
      browserLaunchCapabilityExpiresAt: { type: Date, default: null, select: false },
      browserLaunchCapabilityVersion: { type: Number, default: null, select: false },
      browserLaunchCapabilityScope: { type: String, maxlength: 40, default: null, select: false },
      browserLaunchCapabilityUsedAt: { type: Date, default: null, select: false },
      browserLaunchIdempotencyHash: { type: String, maxlength: 64, default: null, select: false },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
      wingModeEnabled: { type: Boolean, default: null },
      shadowModeEnabled: { type: Boolean, default: null },
      /* === VIVENTIUM START ===
       * Feature: Listen-Only Mode
       * Purpose: Persist the listening-only call state separately from Wing Mode so the voice
       * route can bypass live generation while still saving transcript evidence.
       * === VIVENTIUM END === */
      listenOnlyModeEnabled: { type: Boolean, default: null },
      /* === VIVENTIUM START ===
       * Feature: VoiceCallStateV1
       * Purpose: Additive canonical mode/status; legacy booleans remain for reversible rollout.
       * === VIVENTIUM END === */
      mode: { type: String, enum: ['call', 'wing', 'listen_only'], default: 'call' },
      callStatus: {
        type: String,
        enum: [
          'created',
          'connecting',
          'listening',
          'speaking',
          'working',
          'needs_input',
          'degraded',
          'failed',
          'ended',
        ],
        default: 'created',
      },
      callModeRevision: { type: Number, default: 0 },
      /* === VIVENTIUM START ===
       * Feature: structured voice provider failure state
       * Purpose: Persist a bounded, user-safe failure classification without raw provider errors,
       * secrets, model payloads, or stack traces.
       * === VIVENTIUM END === */
      callFailure: {
        type: new mongoose.Schema(
          {
            code: {
              type: String,
              enum: ['no_route', 'provider_failure', 'gateway_down'],
              required: true,
            },
            message: { type: String, maxlength: 300, required: true },
            retryable: { type: Boolean, required: true },
            modality: { type: String, enum: ['stt', 'tts'], default: null },
            provider: { type: String, maxlength: 80, default: null },
            phase: { type: String, enum: ['initialization', 'runtime'], default: null },
            fatal: { type: Boolean, default: true },
            reportedAt: { type: Date, required: true },
          },
          { _id: false },
        ),
        default: null,
      },
      /* === VIVENTIUM START ===
       * Feature: SpeakerSessionStateV1 downgrade tombstone
       * Purpose: Preserve session-wide shared-microphone abstention even if individual segment
       * revision pages arrive late or are unavailable to the post-call memory hardener.
       * === VIVENTIUM END === */
      speakerSessionRevision: { type: Number, default: null },
      speakerAttributionState: {
        type: String,
        enum: ['single_speaker', 'shared_mic_unverified'],
        default: null,
      },
      speakerDetectedAt: { type: Date, default: null },
      speakerSourceTrackSid: { type: String, default: null },
      speakerSharedTrackSids: {
        type: [{ type: String, maxlength: 160 }],
        default: undefined,
      },
      speakerSourceParticipantIdentity: { type: String, default: null },
      speakerSharedParticipantIdentities: {
        type: [{ type: String, maxlength: 160 }],
        default: undefined,
      },
      /* === VIVENTIUM START ===
       * Feature: voice-memory speaker evidence epoch
       * Purpose: Fence post-call memory finalization against concurrent speaker tombstones and
       * segment revisions. A final classification is authoritative only for the exact epoch it
       * reconciled; any later speaker mutation increments the epoch before touching evidence.
       * === VIVENTIUM END === */
      speakerEvidenceEpoch: { type: Number, default: 0 },
      memoryFinalizationLeaseId: { type: String, default: null },
      memoryFinalizationLeaseExpiresAt: { type: Date, default: null },
      memoryFinalizedEvidenceEpoch: { type: Number, default: null },
      memoryFinalizedAt: { type: Date, default: null },
      requestedVoiceRoute: { type: voiceRouteStateSchema, default: null },
      // === VIVENTIUM NOTE ===
      // Feature: Voice worker lease + dispatch idempotency fields
      // Purpose: Ensure one active worker per call session and atomic dispatch creation.
      activeJobId: { type: String, default: null },
      activeWorkerId: { type: String, default: null },
      leaseExpiresAt: { type: Date, default: null },
      dispatchClaimId: { type: String, default: null },
      dispatchAttemptId: { type: String, default: null },
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
