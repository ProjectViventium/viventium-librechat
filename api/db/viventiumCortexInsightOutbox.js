/* === VIVENTIUM START ===
 * Feature: Durable completed-cortex insight outbox.
 * Purpose: Preserve an exact completed graph result before the delivery ledger write begins.
 * === VIVENTIUM END === */

const mongoose = require('mongoose');
const { createViventiumCortexFeelingSnapshotSchema } = require('@librechat/data-schemas');

const IMMUTABLE_OUTBOX_PATHS = new Set([
  'outboxKey',
  'deliveryId',
  'userId',
  'conversationId',
  'parentMessageId',
  'cortexId',
  'cortexName',
  'insight',
  'insightHash',
  'graphResultHash',
  'surface',
  'streamId',
  'sourceRevision',
  'messageRevision',
  'batchId',
  'batchSize',
  'batchMemberHashes',
  'batchOutboxKeys',
  'batchEntries',
  'legacyBatchMigrated',
  'feelingSnapshot',
  'acceptanceToken',
  'retentionAlertAt',
]);

function protectedOutboxPath(value) {
  const path = String(value || '');
  return [...IMMUTABLE_OUTBOX_PATHS].some(
    (protectedPath) => path === protectedPath || path.startsWith(`${protectedPath}.`),
  );
}

function outboxAppendOnlyError() {
  return new Error('Cortex insight outbox payload is append-only');
}

function sameImmutableValue(current, next) {
  if (current instanceof Date || next instanceof Date) {
    return new Date(current).getTime() === new Date(next).getTime();
  }
  return current === next;
}

function immutableOutboxSetter(path) {
  return function rejectOutboxAssignment(value) {
    if (this?.isNew === false && !sameImmutableValue(this.get(path), value)) {
      throw outboxAppendOnlyError();
    }
    return value;
  };
}

function assertImmutableOutboxUpdate(update, { operation = '', upsert = false } = {}) {
  if (Array.isArray(update)) throw outboxAppendOnlyError();
  const normalizedUpdate = update && typeof update === 'object' ? update : {};
  const replacesDocument =
    operation === 'replaceOne' ||
    operation === 'findOneAndReplace' ||
    Object.keys(normalizedUpdate).some((key) => !key.startsWith('$'));
  const mutatesPayload = Object.entries(normalizedUpdate).some(([operator, payload]) => {
    if (!payload || typeof payload !== 'object') return false;
    return Object.entries(payload).some(([path, value]) => {
      const targetsProtectedPath =
        protectedOutboxPath(path) || (operator === '$rename' && protectedOutboxPath(value));
      return targetsProtectedPath && !(operator === '$setOnInsert' && upsert);
    });
  });
  if (replacesDocument || mutatesPayload) throw outboxAppendOnlyError();
}

function rejectOutboxMutation(next) {
  try {
    assertImmutableOutboxUpdate(this.getUpdate?.() || {}, {
      operation: this.op || '',
      upsert: this.getOptions?.().upsert === true,
    });
  } catch (error) {
    return next(error);
  }
  return next();
}

function rejectBulkOutboxMutation(next, operations) {
  try {
    for (const operation of Array.isArray(operations) ? operations : []) {
      for (const name of ['updateOne', 'updateMany']) {
        if (operation?.[name]) {
          assertImmutableOutboxUpdate(operation[name].update, {
            operation: name,
            upsert: operation[name].upsert === true,
          });
        }
      }
      if (operation?.replaceOne) {
        assertImmutableOutboxUpdate(operation.replaceOne.replacement, {
          operation: 'replaceOne',
          upsert: operation.replaceOne.upsert === true,
        });
      }
    }
  } catch (error) {
    return next(error);
  }
  return next();
}

module.exports = function createViventiumCortexInsightOutbox(db) {
  const connection = db || mongoose;
  if (connection.models.ViventiumCortexInsightOutbox) {
    return connection.models.ViventiumCortexInsightOutbox;
  }

  const feelingSnapshotSchema = createViventiumCortexFeelingSnapshotSchema();
  const schema = new mongoose.Schema(
    {
      outboxKey: {
        type: String,
        required: true,
        unique: true,
        index: true,
        immutable: true,
        set: immutableOutboxSetter('outboxKey'),
      },
      deliveryId: {
        type: String,
        default: '',
        index: true,
        immutable: true,
        set: immutableOutboxSetter('deliveryId'),
      },
      userId: {
        type: String,
        required: true,
        index: true,
        immutable: true,
        set: immutableOutboxSetter('userId'),
      },
      conversationId: {
        type: String,
        required: true,
        index: true,
        immutable: true,
        set: immutableOutboxSetter('conversationId'),
      },
      parentMessageId: {
        type: String,
        required: true,
        index: true,
        immutable: true,
        set: immutableOutboxSetter('parentMessageId'),
      },
      cortexId: {
        type: String,
        required: true,
        index: true,
        immutable: true,
        set: immutableOutboxSetter('cortexId'),
      },
      cortexName: {
        type: String,
        default: '',
        immutable: true,
        set: immutableOutboxSetter('cortexName'),
      },
      insight: {
        type: String,
        required: true,
        select: false,
        immutable: true,
        set: immutableOutboxSetter('insight'),
      },
      insightHash: {
        type: String,
        required: true,
        index: true,
        immutable: true,
        set: immutableOutboxSetter('insightHash'),
      },
      graphResultHash: {
        type: String,
        index: true,
        select: false,
        immutable: true,
        set: immutableOutboxSetter('graphResultHash'),
      },
      surface: {
        type: String,
        required: true,
        index: true,
        immutable: true,
        set: immutableOutboxSetter('surface'),
      },
      streamId: {
        type: String,
        default: '',
        select: false,
        immutable: true,
        set: immutableOutboxSetter('streamId'),
      },
      messageRevision: {
        type: Number,
        required: true,
        min: 1,
        default: 1,
        immutable: true,
        set: immutableOutboxSetter('messageRevision'),
      },
      sourceRevision: {
        type: Number,
        min: 1,
        immutable: true,
        set: immutableOutboxSetter('sourceRevision'),
      },
      batchId: {
        type: String,
        default: '',
        index: true,
        immutable: true,
        set: immutableOutboxSetter('batchId'),
      },
      batchSize: {
        type: Number,
        required: true,
        min: 1,
        default: 1,
        immutable: true,
        set: immutableOutboxSetter('batchSize'),
      },
      batchMemberHashes: {
        type: [String],
        required: true,
        default: [],
        select: false,
        immutable: true,
      },
      batchOutboxKeys: {
        type: [String],
        default: undefined,
        select: false,
        immutable: true,
      },
      batchEntries: {
        type: [mongoose.Schema.Types.Mixed],
        required: true,
        default: [],
        select: false,
        immutable: true,
      },
      legacyBatchMigrated: {
        type: Boolean,
        default: false,
        select: false,
        immutable: true,
      },
      feelingSnapshot: {
        type: feelingSnapshotSchema,
        default: null,
        select: false,
        immutable: true,
      },
      acceptanceToken: {
        type: String,
        default: '',
        index: true,
        select: false,
        immutable: true,
        set: immutableOutboxSetter('acceptanceToken'),
      },
      nextAttemptAt: {
        type: Date,
        required: true,
        default: Date.now,
      },
      replayAttempts: {
        type: Number,
        required: true,
        default: 0,
        min: 0,
      },
      replayState: {
        type: String,
        enum: ['pending', 'quarantined'],
        required: true,
        default: 'pending',
      },
      lastFailureCode: {
        type: String,
        default: '',
        maxlength: 120,
      },
      lastFailureAt: {
        type: Date,
        default: null,
      },
      quarantinedAt: {
        type: Date,
        default: null,
      },
      legacyReplayClaimToken: {
        type: String,
        default: '',
        select: false,
      },
      legacyReplayClaimExpiresAt: {
        type: Date,
        default: null,
        select: false,
      },
      retentionAlertAt: {
        type: Date,
        required: true,
        index: true,
        immutable: true,
        set: immutableOutboxSetter('retentionAlertAt'),
      },
    },
    { timestamps: true },
  );

  schema.index({ createdAt: 1, _id: 1 }, { name: 'cortex_outbox_global_replay_created_at' });
  schema.index({ nextAttemptAt: 1, createdAt: 1, _id: 1 }, { name: 'cortex_outbox_replay_due' });
  schema.index({ userId: 1, parentMessageId: 1, createdAt: 1 });
  schema.index(
    { batchOutboxKeys: 1 },
    { unique: true, sparse: true, name: 'cortex_outbox_unique_logical_member' },
  );
  for (const operation of [
    'findOneAndUpdate',
    'findOneAndReplace',
    'updateOne',
    'updateMany',
    'replaceOne',
  ]) {
    schema.pre(operation, rejectOutboxMutation);
  }
  schema.pre('bulkWrite', rejectBulkOutboxMutation);
  schema.pre('save', function rejectSavedOutboxRewrite(next) {
    if (!this.isNew && [...IMMUTABLE_OUTBOX_PATHS].some((path) => this.isModified(path))) {
      return next(outboxAppendOnlyError());
    }
    return next();
  });
  return connection.model('ViventiumCortexInsightOutbox', schema);
};
