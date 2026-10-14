/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Durable GlassHive surface callback delivery ledger.
 *
 * Added: 2026-05-06
 * === VIVENTIUM END === */
const mongoose = require('mongoose');

module.exports = function createViventiumGlassHiveCallbackDelivery(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumGlassHiveCallbackDelivery) {
    return connection.models.ViventiumGlassHiveCallbackDelivery;
  }

  const workerCompletionBindingSchema = new mongoose.Schema(
    {
      originRef: { type: String, required: true, immutable: true },
      workRef: { type: String, required: true, immutable: true },
      workerId: { type: String, required: true, immutable: true },
      runId: { type: String, required: true, immutable: true },
      callbackRef: { type: String, required: true, immutable: true },
      kind: { type: String, enum: ['nonterminal_attention'], immutable: true },
      event: {
        type: String,
        enum: ['run.needs_input'],
        required: function () {
          return this.kind === 'nonterminal_attention';
        },
        immutable: true,
      },
      workTerminal: {
        type: Boolean,
        required: function () {
          return this.kind === 'nonterminal_attention';
        },
        immutable: true,
      },
      evidenceId: {
        type: String,
        match: /^ghe_[a-f0-9]{32}$/,
        required: function () {
          return this.kind === 'nonterminal_attention';
        },
        immutable: true,
      },
      attemptNumber: {
        type: Number,
        required: function () {
          return this.kind !== 'nonterminal_attention';
        },
        immutable: true,
      },
      resultKey: {
        type: String,
        required: function () {
          return this.kind !== 'nonterminal_attention';
        },
        immutable: true,
      },
      acceptedOperationId: {
        type: String,
        required: function () {
          return this.kind !== 'nonterminal_attention';
        },
        immutable: true,
      },
      terminalCallbackId: {
        type: String,
        required: function () {
          return this.kind !== 'nonterminal_attention';
        },
        immutable: true,
      },
      resultDigest: {
        type: String,
        required: function () {
          return this.kind !== 'nonterminal_attention';
        },
        immutable: true,
      },
      resultRevision: {
        type: Number,
        required: function () {
          return this.kind !== 'nonterminal_attention';
        },
        immutable: true,
      },
      effectGeneration: {
        type: Number,
        required: function () {
          return this.kind !== 'nonterminal_attention';
        },
        immutable: true,
      },
    },
    { _id: false, strict: 'throw' },
  );

  workerCompletionBindingSchema.pre('validate', function (next) {
    const attention = this.kind === 'nonterminal_attention';
    const forbidden = attention
      ? [
          'attemptNumber',
          'resultKey',
          'acceptedOperationId',
          'terminalCallbackId',
          'resultDigest',
          'resultRevision',
          'effectGeneration',
        ]
      : ['event', 'workTerminal', 'evidenceId'];
    for (const field of forbidden)
      if (this[field] !== undefined)
        this.invalidate(field, 'voice_worker_presentation_binding_invalid');
    if (attention && this.workTerminal !== false)
      this.invalidate('workTerminal', 'voice_worker_presentation_binding_invalid');
    next();
  });

  const workerCompletionPresentationSchema = new mongoose.Schema(
    {
      version: { type: Number, required: true, immutable: true },
      presentationRef: { type: String, required: true, immutable: true },
      callSessionId: { type: String, required: true, immutable: true },
      turnId: { type: String, required: true, immutable: true },
      revision: { type: Number, required: true, immutable: true },
      responseMessageId: { type: String, required: true, immutable: true },
      responseDigest: { type: String, required: true, immutable: true },
      bindings: { type: [workerCompletionBindingSchema], required: true, immutable: true },
    },
    { _id: false, strict: 'throw' },
  );

  const workerCompletionEffectLeaseSchema = new mongoose.Schema(
    {
      resultKey: { type: String, required: true },
      acceptedOperationId: { type: String, required: true },
      acceptedOperationGeneration: { type: Number, required: true },
      leaseId: { type: String, required: true },
      generation: { type: Number, required: true },
      resultRevision: { type: Number, required: true },
      callbackId: { type: String, required: true },
      resultDigest: { type: String, required: true },
    },
    { _id: false, strict: 'throw' },
  );

  const nativeInputBindingSchema = new mongoose.Schema(
    {
      version: { type: Number, required: true, enum: [1], immutable: true },
      requestId: { type: String, required: true, maxlength: 512, immutable: true },
      requestFingerprint: {
        type: String,
        required: true,
        match: /^[a-f0-9]{64}$/,
        immutable: true,
      },
      runId: { type: String, required: true, maxlength: 160, immutable: true },
      attemptId: { type: String, required: true, maxlength: 160, immutable: true },
      sessionId: { type: String, required: true, maxlength: 160, immutable: true },
      expiresAt: { type: String, required: true, immutable: true },
    },
    { _id: false, strict: 'throw' },
  );

  const attachmentSchema = new mongoose.Schema(
    {
      user: String,
      file_id: String,
      filename: { type: String, required: true },
      filepath: String,
      bytes: Number,
      type: String,
      source: String,
      object: { type: String, enum: ['file'] },
      messageId: String,
      nativeOutputFile: {
        type: new mongoose.Schema(
          {
            version: { type: Number, enum: [1], required: true },
            status: { type: String, enum: ['available', 'unavailable'], required: true },
            code: {
              type: String,
              required() {
                return this.status === 'unavailable';
              },
            },
            messageId: {
              type: String,
              required() {
                return this.status === 'available';
              },
            },
            downloadUrl: {
              type: String,
              required() {
                return this.status === 'available';
              },
            },
          },
          { _id: false, strict: 'throw' },
        ),
        default: undefined,
      },
    },
    { _id: false, strict: 'throw' },
  );

  const schema = new mongoose.Schema(
    {
      deliveryKey: { type: String, required: true, unique: true, index: true },
      deliveryId: { type: String, required: true, unique: true, index: true },
      callbackId: { type: String, default: '', index: true },
      traceIdentityVerified: { type: Boolean, default: false, immutable: true },
      callbackKey: { type: String, default: '', index: true },
      presentationKind: { type: String, enum: ['', 'main', 'native_input'], default: '' },
      callbackMessageId: { type: String, required: true, index: true },
      /* === VIVENTIUM START ===
       * Feature: General transport-receipt provenance.
       * Purpose: One owner-scoped logical message can map to every Telegram chunk that carried it.
       * === VIVENTIUM END === */
      sourceKind: { type: String, default: 'callback', index: true },
      logicalMessageId: { type: String, default: '', index: true },
      scheduleId: { type: String, default: '', index: true },
      scheduleRunId: { type: String, default: '', index: true },
      originRef: { type: String, default: '', index: true },
      workRef: { type: String, default: '', index: true },
      userId: { type: String, required: true, index: true },
      conversationId: { type: String, required: true, index: true },
      requestedParentMessageId: { type: String, default: '', index: true },
      anchorMessageId: { type: String, default: '', index: true },
      surface: { type: String, required: true, index: true },
      event: { type: String, required: true, index: true },
      workerId: { type: String, default: '', index: true },
      runId: { type: String, default: '', index: true },
      status: {
        type: String,
        required: true,
        enum: [
          'pending',
          'claimed',
          'sent',
          'failed',
          'suppressed',
          'unresolved',
          'delivery_unknown',
          'superseded',
        ],
        default: 'pending',
        index: true,
      },
      text: { type: String, default: '' },
      fullText: { type: String, default: '' },
      attachments: { type: [attachmentSchema], default: [] },
      telegramChatId: { type: String, default: '', index: true },
      telegramUserId: { type: String, default: '', index: true },
      telegramMessageId: { type: String, default: '' },
      telegramMessageThreadId: { type: String, default: '', immutable: true },
      nativeInputBinding: { type: nativeInputBindingSchema, default: null, immutable: true },
      telegramSentMessageIds: { type: [String], default: [], index: true },
      transportReceiptVersion: { type: Number, default: 0 },
      voiceCallSessionId: { type: String, default: '', index: true },
      voiceRequestId: { type: String, default: '' },
      claimId: { type: String, default: '', index: true },
      claimOwner: { type: String, default: '' },
      claimedAt: { type: Date, default: null },
      leaseExpiresAt: { type: Date, default: null, index: true },
      dispatchPermitId: { type: String, default: '', index: true },
      dispatchPermitGeneration: { type: Number, default: 0 },
      dispatchPermitExpiresAt: { type: Date, default: null, index: true },
      sentAt: { type: Date, default: null },
      failedAt: { type: Date, default: null },
      suppressedAt: { type: Date, default: null },
      unknownAt: { type: Date, default: null },
      retryCount: { type: Number, default: 0 },
      nextAttemptAt: { type: Date, default: null, index: true },
      lastError: { type: String, default: '' },
      unresolvedReason: { type: String, default: '' },
      projectionPendingAt: { type: Date, default: null, index: true },
      projectionAppliedAt: { type: Date, default: null },
      projectionNextAttemptAt: { type: Date, default: null, index: true },
      projectionAttempts: { type: Number, default: 0 },
      projectionErrorCode: { type: String, default: '' },
      terminalCallbackResultKey: { type: String, default: '', index: true },
      terminalCallbackAcceptedOperationId: { type: String, default: '' },
      terminalCallbackId: { type: String, default: '' },
      terminalCallbackResultDigest: { type: String, default: '' },
      terminalCallbackResultRevision: { type: Number, default: 0 },
      terminalCallbackEffectGeneration: { type: Number, default: 0 },
      workerCompletionPresentation: {
        type: workerCompletionPresentationSchema,
        default: null,
        immutable: true,
      },
      workerCompletionBindings: {
        type: [workerCompletionBindingSchema],
        default: [],
        immutable: true,
      },
      workerCompletionProjectionAppliedAt: { type: Date, default: null },
      workerCompletionEffectLeases: {
        type: [workerCompletionEffectLeaseSchema],
        default: [],
      },
      workerCompletionTtsCompletedAt: { type: Date, default: null },
      workerCompletionAudioCompletedAt: { type: Date, default: null },
      expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
    },
    { timestamps: true },
  );

  schema.index({ surface: 1, status: 1, nextAttemptAt: 1, createdAt: 1 });
  schema.index({ surface: 1, status: 1, leaseExpiresAt: 1 });
  schema.index({ projectionPendingAt: 1, projectionNextAttemptAt: 1, updatedAt: 1 });
  schema.index({ terminalCallbackResultKey: 1, status: 1, createdAt: 1 });
  schema.index({ userId: 1, conversationId: 1, callbackMessageId: 1 });
  /* === VIVENTIUM START ===
   * Feature: General transport-receipt provenance.
   * === VIVENTIUM END === */
  schema.index({ userId: 1, telegramChatId: 1, telegramSentMessageIds: 1, status: 1 });

  return connection.model('ViventiumGlassHiveCallbackDelivery', schema);
};
