/* === VIVENTIUM START ===
 * Feature: Append-only redacted orchestration trace event model.
 * Purpose: Persist hash-chained facts without raw private identifiers or payloads.
 * === VIVENTIUM END === */

import crypto from 'crypto';
import { Schema } from 'mongoose';
import type { Model } from 'mongoose';
import type {
  IOrchestrationTraceFacts,
  IViventiumOrchestrationTraceEvent,
  OrchestrationTraceScope,
} from '~/types/orchestrationTraceEvent';

type UnknownRecord = Record<string, unknown>;

const HASH = /^sha256:[a-f0-9]{64}$/;
const TRACE_SCOPE_LOCK_LEASE_MS = 60_000;
const TRACE_SCOPE_LOCK_WAIT_MS = 15_000;
const TRACE_SCOPE_LOCK_RETRY_MS = 5;
const TRACE_STAGES = [
  'source.bound',
  'prompt.layers.verified',
  'prompt.layers.invalid',
  'launch.prepared',
  'launch.accepted',
  'launch.failed',
  'work.queued',
  'work.claimed',
  'work.admitted',
  'runtime.invoked',
  'work.running',
  'attempt.history.complete',
  'capacity.history.complete',
  'callback.history.complete',
  'work.completed',
  'work.failed',
  'work.cancelled',
  'callback.accepted',
  'callback.delivery.pending',
  'callback.delivery.claimed',
  'callback.delivery.sent',
  'callback.delivery.failed',
  'callback.delivery.suppressed',
  'callback.delivery.unresolved',
  'action.accepted',
  'control.completed',
  'tool.completed',
  'controller.completed',
  'cortex.completed',
  'live_memory.completed',
  'recall.completed',
  'title_model.completed',
  'response.completed',
  'tts.completed',
  'audio.completed',
  'provider.request.forwarded',
  'provider.attempt.completed',
  'provider.fallback.completed',
];
const STATES = [
  'unknown',
  'preparing',
  'accepted',
  'queued',
  'claimed',
  'admitted',
  'running',
  'paused',
  'needs_input',
  'blocked',
  'stopping',
  'settling',
  'completed',
  'failed',
  'cancelled',
];
const SURFACES = ['librechat', 'web', 'telegram', 'voice', 'workbench', 'scheduler'];
const CALLBACK_EVENTS = [
  'main.followup',
  'run.queued',
  'run.requeued',
  'run.capacity_waiting',
  'run.waiting_capacity',
  'run.waiting_on_capacity',
  'run.queue_status',
  'run.claimed',
  'run.admitted',
  'runtime.invoked',
  'run.started',
  'run.resumed',
  'run.paused',
  'run.needs_input',
  'run.blocked',
  'run.stopping',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  'run.authorization_resumed',
  'run.followup_queued',
  'run.orphaned',
  'checkpoint.ready',
  'takeover.requested',
  'worker.ready',
  'worker.paused',
  'worker.interrupted',
  'worker.terminated',
  'worker.resumed_by_alias',
  'worker.message_queued',
  'worker.message',
  'worker.resumed',
  'schedule.queued',
];
const DELIVERY_STATES = [
  'pending',
  'claimed',
  'sent',
  'failed',
  'suppressed',
  'unresolved',
  'delivery_unknown',
];
const EFFECT_PLANES = [
  'control',
  'tool',
  'controller',
  'cortex',
  'liveMemory',
  'recall',
  'titleModel',
  'response',
  'tts',
  'audio',
  'provider',
];
const OUTCOMES = ['accepted', 'completed', 'failed', 'skipped', 'empty'];
const VOICE_ACTIONS = ['queue', 'message', 'steer', 'pause', 'resume', 'stop', 'retry', 'dismiss'];
const PROVIDER_STATUSES = [
  'completed',
  'failed',
  'timeout',
  'rate_limited',
  'unauthorized',
  'cancelled',
];
const ATTEMPT_ROLES = ['primary', 'fallback'];
const safeTokenField = () => ({
  type: String,
  match: /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,159}$/,
  immutable: true,
});
const hashField = () => ({ type: String, match: HASH, immutable: true });
const nonnegativeInteger = {
  type: Number,
  min: 0,
  validate: Number.isSafeInteger,
  immutable: true,
};

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): unknown {
  return isRecord(error) ? error.code : undefined;
}

const factsSchema = new Schema<IOrchestrationTraceFacts>(
  {
    sourceEventRefHash: hashField(),
    logicalTurnRefHash: hashField(),
    workRefHash: hashField(),
    runRefHash: hashField(),
    callbackRefHash: hashField(),
    deliveryRefHash: hashField(),
    callSessionRefHash: hashField(),
    taskRefHash: hashField(),
    streamRefHash: hashField(),
    actionRefHash: hashField(),
    receiptRefHash: hashField(),
    attemptRefHash: hashField(),
    providerRequestRefHash: hashField(),
    primaryAttemptRefHash: hashField(),
    fallbackAttemptRefHash: hashField(),
    responseRefHash: hashField(),
    presentationRefHash: hashField(),
    state: { type: String, enum: STATES, immutable: true },
    surface: { type: String, enum: SURFACES, immutable: true },
    callbackEvent: { type: String, enum: CALLBACK_EVENTS, immutable: true },
    deliveryState: { type: String, enum: DELIVERY_STATES, immutable: true },
    terminal: { type: Boolean, immutable: true },
    attemptNumber: nonnegativeInteger,
    promptLayerContractVersion: { type: Number, enum: [1], immutable: true },
    producerTraceContractVersion: { type: Number, enum: [1, 2], immutable: true },
    promptProducerScope: {
      type: String,
      enum: ['glasshive.worker_prompt_registry'],
      immutable: true,
    },
    unknownPromptLayerCount: nonnegativeInteger,
    producerLifecycleHash: hashField(),
    producerAttemptHistoryHash: hashField(),
    producerCapacityHistoryHash: hashField(),
    producerCallbackHistoryHash: hashField(),
    producerPromptHash: hashField(),
    producerArtifactRefsHash: hashField(),
    candidateDigest: hashField(),
    runtimeOwnerBindingHash: hashField(),
    installedArtifactDigest: hashField(),
    contextSnapshotHash: hashField(),
    capabilitySetHash: hashField(),
    effectPlane: { type: String, enum: EFFECT_PLANES, immutable: true },
    outcome: { type: String, enum: OUTCOMES, immutable: true },
    action: { type: String, enum: VOICE_ACTIONS, immutable: true },
    provider: safeTokenField(),
    model: safeTokenField(),
    providerStatus: { type: String, enum: PROVIDER_STATUSES, immutable: true },
    attemptRole: { type: String, enum: ATTEMPT_ROLES, immutable: true },
    primaryProvider: safeTokenField(),
    primaryModel: safeTokenField(),
    primaryProviderStatus: { type: String, enum: PROVIDER_STATUSES, immutable: true },
    fallbackProvider: safeTokenField(),
    fallbackModel: safeTokenField(),
    fallbackProviderStatus: { type: String, enum: PROVIDER_STATUSES, immutable: true },
    configuredFallback: { type: Boolean, immutable: true },
    requiredCapabilitiesPreserved: { type: Boolean, immutable: true },
    effectCount: nonnegativeInteger,
  },
  { _id: false, strict: 'throw' },
);

const orchestrationTraceEventSchema = new Schema<IViventiumOrchestrationTraceEvent>(
  {
    schemaVersion: { type: Number, required: true, enum: [1], immutable: true },
    ownerScopeHash: { ...hashField(), required: true, index: true },
    originRefHash: { ...hashField(), required: true, index: true },
    sequence: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
      immutable: true,
    },
    stage: { type: String, required: true, enum: TRACE_STAGES, immutable: true },
    at: { type: Date, required: true, immutable: true },
    facts: { type: factsSchema, required: true, immutable: true },
    eventKeyHash: { ...hashField(), required: true },
    contentHash: { ...hashField(), required: true },
    previousEventHash: { ...hashField(), required: true },
    eventHash: { ...hashField(), required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: 'throw' },
);

orchestrationTraceEventSchema.index(
  { ownerScopeHash: 1, originRefHash: 1, sequence: 1 },
  { unique: true },
);
orchestrationTraceEventSchema.index(
  { ownerScopeHash: 1, originRefHash: 1, eventKeyHash: 1 },
  { unique: true },
);

function rejectMutation(): never {
  throw new Error('orchestration_trace_append_only');
}

for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
] as const) {
  orchestrationTraceEventSchema.pre(operation, rejectMutation);
}
orchestrationTraceEventSchema.pre('deleteOne', { document: true, query: false }, rejectMutation);
orchestrationTraceEventSchema.pre('bulkWrite', rejectMutation);
orchestrationTraceEventSchema.pre('save', function rejectExistingDocumentSave() {
  if (!this.isNew) rejectMutation();
});

orchestrationTraceEventSchema.statics.withOrchestrationTraceScopeLock = async function (
  this: Model<IViventiumOrchestrationTraceEvent>,
  { ownerScopeHash, originRefHash }: Partial<OrchestrationTraceScope> = {},
  operation: (() => unknown | Promise<unknown>) | undefined,
) {
  if (
    !ownerScopeHash ||
    !originRefHash ||
    !HASH.test(ownerScopeHash) ||
    !HASH.test(originRefHash)
  ) {
    throw new Error('orchestration_trace_scope_lock_invalid');
  }
  if (typeof operation !== 'function') {
    throw new Error('orchestration_trace_scope_lock_operation_invalid');
  }
  const nativeDb = this.db?.db;
  if (!nativeDb) throw new Error('orchestration_trace_scope_lock_database_unavailable');
  const lockCollection = nativeDb.collection(`${this.collection.collectionName}_scope_locks`);
  const lockId = `${ownerScopeHash}:${originRefHash}`;
  const ownerToken = crypto.randomBytes(24).toString('hex');
  const deadline = Date.now() + TRACE_SCOPE_LOCK_WAIT_MS;
  let acquired = false;

  while (!acquired && Date.now() < deadline) {
    const now = new Date();
    try {
      const result = await lockCollection.findOneAndUpdate(
        {
          _id: lockId,
          $or: [{ expiresAt: { $lte: now } }, { ownerToken }],
        },
        {
          $set: {
            ownerToken,
            expiresAt: new Date(now.getTime() + TRACE_SCOPE_LOCK_LEASE_MS),
          },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true, returnDocument: 'after' },
      );
      const resultRecord = isRecord(result) ? result : {};
      const document = isRecord(resultRecord.value) ? resultRecord.value : resultRecord;
      acquired = document.ownerToken === ownerToken;
    } catch (error) {
      if (errorCode(error) !== 11000) throw error;
    }
    if (!acquired) {
      await new Promise((resolve) => setTimeout(resolve, TRACE_SCOPE_LOCK_RETRY_MS));
    }
  }
  if (!acquired) throw new Error('orchestration_trace_scope_lock_timeout');

  let renewal = Promise.resolve();
  let renewalError: unknown = null;
  const renewalTimer = setInterval(
    () => {
      renewal = renewal
        .then(async () => {
          const result = await lockCollection.updateOne(
            { _id: lockId, ownerToken },
            { $set: { expiresAt: new Date(Date.now() + TRACE_SCOPE_LOCK_LEASE_MS) } },
          );
          if (result.matchedCount !== 1) {
            throw new Error('orchestration_trace_scope_lock_lost');
          }
        })
        .catch((error: unknown) => {
          renewalError = error;
        });
    },
    Math.floor(TRACE_SCOPE_LOCK_LEASE_MS / 3),
  );
  renewalTimer.unref?.();

  try {
    const result = await operation();
    await renewal;
    if (renewalError) throw renewalError;
    return result;
  } finally {
    clearInterval(renewalTimer);
    await renewal.catch(() => undefined);
    await lockCollection.deleteOne({ _id: lockId, ownerToken });
  }
};

export default orchestrationTraceEventSchema;
