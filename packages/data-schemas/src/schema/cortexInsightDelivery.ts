/* === VIVENTIUM START ===
 * Feature: Durable Cortex insight delivery ledger.
 * Purpose: Keep private insight payloads immutable and transition evidence append-only.
 * === VIVENTIUM END === */

import { Schema } from 'mongoose';
import { createViventiumCortexFeelingSnapshotSchema } from './cortexFeelingSnapshot';
import {
  CORTEX_INSIGHT_DROP_REASONS,
  CORTEX_INSIGHT_FAILURE_REASONS,
  CORTEX_INSIGHT_RECOVERY_DEFERRAL_REASONS,
} from '~/types/cortexInsightDelivery';
import type {
  ICortexInsightDeliveryEvent,
  IViventiumCortexInsightDelivery,
} from '~/types/cortexInsightDelivery';

type UnknownRecord = Record<string, unknown>;
type MiddlewareNext = (error?: Error) => void;
type DeliveryDocument = {
  isNew: boolean;
  status: string;
  persistenceStatus: string;
  requiredSurfaces?: string[];
  presentedSurfaces?: string[];
  get(path: string): unknown;
  isModified(path: string): boolean;
};

const EVENT_REASONS = [
  '',
  ...CORTEX_INSIGHT_DROP_REASONS,
  ...CORTEX_INSIGHT_FAILURE_REASONS,
  ...CORTEX_INSIGHT_RECOVERY_DEFERRAL_REASONS,
];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function eventHistoryPath(value: unknown): boolean {
  return value === 'events' || String(value || '').startsWith('events.');
}

const IMMUTABLE_DELIVERY_PATHS = new Set([
  'deliveryKey',
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
  'requiredSurfaces',
  'streamId',
  'feelingSnapshot',
  'acceptanceToken',
  'sourceRevision',
  'presentationRevision',
  'messageRevision',
  'batchId',
  'batchSize',
  'batchMemberHashes',
  'parentAdmissionKey',
]);

function immutableDeliveryPath(value: unknown): boolean {
  return [...IMMUTABLE_DELIVERY_PATHS].some(
    (path) => value === path || String(value || '').startsWith(`${path}.`),
  );
}

function appendOnlyError(): Error {
  return new Error(
    'Cortex insight delivery event history is append-only; private insight payload is immutable',
  );
}

function sameImmutableValue(current: unknown, next: unknown): boolean {
  if (Array.isArray(current) || Array.isArray(next)) {
    return JSON.stringify(current) === JSON.stringify(next);
  }
  return current === next;
}

function immutableDeliverySetter(path: string) {
  return function rejectDeliveryAssignment(this: DeliveryDocument, value: unknown): unknown {
    if (this?.isNew === false && !sameImmutableValue(this.get(path), value)) {
      throw appendOnlyError();
    }
    return value;
  };
}

export function assertAppendOnlyCortexInsightDeliveryUpdate(
  update: unknown,
  { operation = '', upsert = false }: { operation?: string; upsert?: boolean } = {},
): void {
  if (Array.isArray(update)) {
    throw appendOnlyError();
  }
  const normalizedUpdate = isRecord(update) ? update : {};
  const replacesDocument =
    operation === 'replaceOne' ||
    operation === 'findOneAndReplace' ||
    Object.keys(normalizedUpdate).some((key) => !key.startsWith('$'));
  const mutatesExistingEvent = Object.entries(normalizedUpdate).some(([operator, payload]) => {
    if (!isRecord(payload)) {
      return false;
    }
    return Object.entries(payload).some(([path, value]) => {
      const targetsProtectedPath =
        eventHistoryPath(path) ||
        immutableDeliveryPath(path) ||
        (operator === '$rename' && (eventHistoryPath(value) || immutableDeliveryPath(value)));
      if (!targetsProtectedPath) {
        return false;
      }
      if (operator === '$setOnInsert' && upsert) {
        return false;
      }
      if (operator !== '$push' || path !== 'events') {
        return true;
      }
      if (!isRecord(value)) {
        return false;
      }
      const modifierKeys = Object.keys(value).filter((key) => key.startsWith('$'));
      return modifierKeys.some((key) => key !== '$each');
    });
  });
  if (replacesDocument || mutatesExistingEvent) {
    throw appendOnlyError();
  }
}

function rejectEventHistoryMutation(
  this: {
    op?: string;
    getOptions?: () => UnknownRecord;
    getUpdate?: () => unknown;
  },
  next: MiddlewareNext,
): void {
  try {
    const options = this.getOptions?.() || {};
    assertAppendOnlyCortexInsightDeliveryUpdate(this.getUpdate?.() || {}, {
      operation: this.op || '',
      upsert: options.upsert === true,
    });
  } catch (error) {
    return next(error instanceof Error ? error : appendOnlyError());
  }
  return next();
}

function rejectBulkEventHistoryMutation(next: MiddlewareNext, operations: unknown[]): void {
  try {
    for (const operation of Array.isArray(operations) ? operations : []) {
      if (!isRecord(operation)) continue;
      for (const name of ['updateOne', 'updateMany']) {
        const command = operation[name];
        if (isRecord(command)) {
          assertAppendOnlyCortexInsightDeliveryUpdate(command.update, {
            operation: name,
            upsert: command.upsert === true,
          });
        }
      }
      const replacement = operation.replaceOne;
      if (isRecord(replacement)) {
        assertAppendOnlyCortexInsightDeliveryUpdate(replacement.replacement, {
          operation: 'replaceOne',
          upsert: replacement.upsert === true,
        });
      }
      if (operation.deleteOne || operation.deleteMany) {
        throw appendOnlyError();
      }
    }
  } catch (error) {
    return next(error instanceof Error ? error : appendOnlyError());
  }
  return next();
}

function rejectLedgerDeletion(next: MiddlewareNext): void {
  return next(appendOnlyError());
}

const eventSchema = new Schema<ICortexInsightDeliveryEvent>(
  {
    transition: {
      type: String,
      required: true,
      enum: [
        'pending',
        'claimed',
        'failure',
        'recovery_deferred',
        'persisted',
        'presented',
        'sent',
        'dropped',
      ],
      immutable: true,
    },
    attemptNumber: { type: Number, required: true, min: 0, immutable: true },
    claimToken: { type: String, default: '', immutable: true },
    claimGeneration: { type: Number, required: true, min: 0, immutable: true },
    eventAt: { type: Date, required: true, immutable: true },
    claimedAt: { type: Date, default: null, immutable: true },
    leaseExpiresAt: { type: Date, default: null, immutable: true },
    reason: { type: String, enum: EVENT_REASONS, default: '', immutable: true },
    surface: { type: String, default: '', immutable: true },
    receiptHash: { type: String, default: '', immutable: true },
    runtimeSlot: { type: String, default: '', immutable: true },
    runtimeEpoch: { type: String, default: '', immutable: true },
    recoveryAttemptNumber: {
      type: Number,
      required: true,
      min: 0,
      max: 16,
      default: 0,
      immutable: true,
    },
    retryEligibleAt: { type: Date, default: null, immutable: true },
  },
  { _id: false },
);

const feelingSnapshotSchema = createViventiumCortexFeelingSnapshotSchema();

const cortexInsightDeliverySchema = new Schema<IViventiumCortexInsightDelivery>(
  {
    deliveryKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
      immutable: true,
      set: immutableDeliverySetter('deliveryKey'),
    },
    deliveryId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      immutable: true,
      set: immutableDeliverySetter('deliveryId'),
    },
    userId: {
      type: String,
      required: true,
      index: true,
      immutable: true,
      set: immutableDeliverySetter('userId'),
    },
    conversationId: {
      type: String,
      required: true,
      index: true,
      immutable: true,
      set: immutableDeliverySetter('conversationId'),
    },
    parentMessageId: {
      type: String,
      required: true,
      index: true,
      immutable: true,
      set: immutableDeliverySetter('parentMessageId'),
    },
    cortexId: {
      type: String,
      required: true,
      index: true,
      immutable: true,
      set: immutableDeliverySetter('cortexId'),
    },
    cortexName: {
      type: String,
      default: '',
      immutable: true,
      set: immutableDeliverySetter('cortexName'),
    },
    insight: {
      type: String,
      required: true,
      select: false,
      immutable: true,
      set: immutableDeliverySetter('insight'),
    },
    insightHash: {
      type: String,
      required: true,
      index: true,
      immutable: true,
      set: immutableDeliverySetter('insightHash'),
    },
    graphResultHash: {
      type: String,
      required: true,
      index: true,
      immutable: true,
      set: immutableDeliverySetter('graphResultHash'),
    },
    surface: {
      type: String,
      required: true,
      index: true,
      immutable: true,
      set: immutableDeliverySetter('surface'),
    },
    requiredSurfaces: { type: [String], required: true, default: [], immutable: true },
    presentedSurfaces: { type: [String], required: true, default: [] },
    presentationReceiptHashes: {
      type: [String],
      default: [],
      select: false,
      validate: {
        validator(this: DeliveryDocument, value: string[]) {
          if (this.status !== 'sent') return true;
          const required = new Set(this.requiredSurfaces || []);
          const presented = new Set(this.presentedSurfaces || []);
          return (
            required.size > 0 &&
            [...required].every((surface) => presented.has(surface)) &&
            Array.isArray(value) &&
            value.length >= required.size
          );
        },
        message: 'sent delivery requires presentationReceiptHashes for every required surface',
      },
    },
    streamId: {
      type: String,
      default: '',
      select: false,
      immutable: true,
      set: immutableDeliverySetter('streamId'),
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
      set: immutableDeliverySetter('acceptanceToken'),
    },
    sourceRevision: {
      type: Number,
      min: 1,
      immutable: true,
      set: immutableDeliverySetter('sourceRevision'),
    },
    presentationRevision: { type: Number, required: true, min: 1, default: 1 },
    messageRevision: { type: Number, required: true, min: 1, default: 1 },
    batchId: {
      type: String,
      default: '',
      index: true,
      immutable: true,
      set: immutableDeliverySetter('batchId'),
    },
    batchSize: {
      type: Number,
      required: true,
      min: 1,
      default: 1,
      immutable: true,
      set: immutableDeliverySetter('batchSize'),
    },
    batchMemberHashes: { type: [String], required: true, default: [], immutable: true },
    parentAdmissionKey: {
      type: String,
      default: undefined,
      select: false,
      immutable: true,
      set: immutableDeliverySetter('parentAdmissionKey'),
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'claimed', 'sent', 'dropped'],
      default: 'pending',
      index: true,
    },
    attemptNumber: { type: Number, required: true, min: 0, default: 0 },
    recoveryAttemptNumber: { type: Number, required: true, min: 0, max: 16, default: 0 },
    recoveryEligibleAt: { type: Date, default: null, index: true },
    claimGeneration: { type: Number, required: true, min: 0, default: 0 },
    claimToken: {
      type: String,
      default: '',
      index: true,
      required(this: DeliveryDocument) {
        return this.status === 'claimed';
      },
    },
    claimRuntimeSlot: { type: String, default: '', select: false },
    claimRuntimeEpoch: { type: String, default: '', select: false },
    claimedAt: {
      type: Date,
      default: null,
      required(this: DeliveryDocument) {
        return this.status === 'claimed';
      },
    },
    leaseExpiresAt: {
      type: Date,
      default: null,
      index: true,
      required(this: DeliveryDocument) {
        return this.status === 'claimed';
      },
    },
    presentationLeaseToken: { type: String, default: '', select: false },
    presentationLeaseOwnerId: { type: String, default: '', select: false },
    presentationLeaseClaimToken: { type: String, default: '', select: false },
    presentationLeaseGeneration: { type: Number, min: 0, default: 0, select: false },
    presentationLeaseExpiresAt: { type: Date, default: null, index: true, select: false },
    batchLockToken: { type: String, default: '', select: false },
    batchLockRuntimeSlot: { type: String, default: '', select: false },
    batchLockRuntimeEpoch: { type: String, default: '', select: false },
    batchLockExpiresAt: { type: Date, default: null, index: true },
    batchLockGeneration: { type: Number, required: true, min: 0, default: 0 },
    batchIntent: {
      type: Schema.Types.Mixed,
      default: null,
      select: false,
    },
    lastBatchIntentToken: { type: String, default: '', select: false },
    persistedMessageId: {
      type: String,
      default: '',
      index: true,
      required(this: DeliveryDocument) {
        return this.status === 'sent' || this.persistenceStatus === 'persisted';
      },
    },
    persistenceStatus: {
      type: String,
      required: true,
      enum: ['pending', 'persisted'],
      default: 'pending',
      index: true,
    },
    persistedAt: {
      type: Date,
      default: null,
      required(this: DeliveryDocument) {
        return this.persistenceStatus === 'persisted';
      },
    },
    sentAt: {
      type: Date,
      default: null,
      required(this: DeliveryDocument) {
        return this.status === 'sent';
      },
    },
    dropReason: {
      type: String,
      enum: ['', ...CORTEX_INSIGHT_DROP_REASONS],
      default: '',
      index: true,
      required(this: DeliveryDocument) {
        return this.status === 'dropped';
      },
    },
    droppedAt: {
      type: Date,
      default: null,
      required(this: DeliveryDocument) {
        return this.status === 'dropped';
      },
    },
    events: { type: [eventSchema], default: [], select: false },
    expiresAt: {
      type: Date,
      default: null,
      required(this: DeliveryDocument) {
        return this.status === 'sent' || this.status === 'dropped';
      },
    },
  },
  { timestamps: true },
);

cortexInsightDeliverySchema.index({ userId: 1, parentMessageId: 1, surface: 1, createdAt: 1 });
cortexInsightDeliverySchema.index({ status: 1, leaseExpiresAt: 1, createdAt: 1 });
cortexInsightDeliverySchema.index(
  { status: 1, recoveryEligibleAt: 1, createdAt: 1, deliveryId: 1 },
  { name: 'cortex_delivery_recovery_eligibility' },
);
cortexInsightDeliverySchema.index(
  { userId: 1, parentMessageId: 1, cortexId: 1, insightHash: 1 },
  { unique: true },
);
cortexInsightDeliverySchema.index(
  { parentAdmissionKey: 1 },
  { unique: true, sparse: true, name: 'cortex_delivery_unique_parent_admission' },
);
cortexInsightDeliverySchema.index(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: { status: { $in: ['sent', 'dropped'] } },
  },
);

for (const operation of [
  'findOneAndUpdate',
  'findOneAndReplace',
  'updateOne',
  'updateMany',
  'replaceOne',
] as const) {
  cortexInsightDeliverySchema.pre(operation, rejectEventHistoryMutation);
}
cortexInsightDeliverySchema.pre('bulkWrite', rejectBulkEventHistoryMutation);
for (const operation of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  cortexInsightDeliverySchema.pre(
    operation,
    { query: true, document: false },
    rejectLedgerDeletion,
  );
}
cortexInsightDeliverySchema.pre(
  'deleteOne',
  { query: false, document: true },
  rejectLedgerDeletion,
);
cortexInsightDeliverySchema.pre('save', function rejectSavedEventRewrite(next) {
  if (
    !this.isNew &&
    (this.isModified('events') ||
      [...IMMUTABLE_DELIVERY_PATHS].some((path) => this.isModified(path)))
  ) {
    return next(appendOnlyError());
  }
  return next();
});

export default cortexInsightDeliverySchema;
