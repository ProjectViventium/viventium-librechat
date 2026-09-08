/* === VIVENTIUM START ===
 * Feature: Provider-neutral accepted Main continuity state.
 * Purpose: Own accepted turns and semantic compaction state in the typed schema package.
 * === VIVENTIUM END === */

import { Schema } from 'mongoose';
import type {
  IMainContinuityAcceptedRevision,
  IMainContinuityAcceptedTurn,
  IMainContinuityCompactionLease,
  IMainContinuityToolPair,
  IMainSemanticCompaction,
  IViventiumMainContinuityState,
} from '~/types/mainContinuityState';

const toolPairSchema = new Schema<IMainContinuityToolPair>(
  {
    callId: { type: String, default: '', maxlength: 256 },
    toolName: { type: String, default: '', maxlength: 256 },
    outcome: { type: String, default: '', maxlength: 1200 },
  },
  { _id: false },
);

const acceptedTurnSchema = new Schema<IMainContinuityAcceptedTurn>(
  {
    acceptedPosition: { type: Number, min: 1 },
    logicalTurnId: { type: String, required: true, maxlength: 160 },
    revision: { type: Number, required: true, min: 1 },
    conversationId: { type: String, default: '', maxlength: 256 },
    userMessageId: { type: String, default: '', maxlength: 256 },
    assistantMessageId: { type: String, required: true, maxlength: 256 },
    origin: { type: String, default: 'interactive', maxlength: 40 },
    scheduleId: { type: String, maxlength: 256 },
    scheduleRunId: { type: String, maxlength: 256 },
    userText: { type: String, default: '', maxlength: 6000 },
    assistantText: { type: String, default: '', maxlength: 6000 },
    toolPairs: { type: [toolPairSchema], default: [] },
    committedAt: { type: Date, required: true },
    sourceDeletedAt: { type: Date, default: undefined },
  },
  { _id: false },
);

const acceptedRevisionSchema = new Schema<IMainContinuityAcceptedRevision>(
  {
    sourceDeleted: { type: Boolean, default: undefined },
    logicalTurnId: { type: String, required: true, maxlength: 160 },
    revision: { type: Number, required: true, min: 1 },
  },
  { _id: false },
);

const semanticCompactionSchema = new Schema<IMainSemanticCompaction>(
  {
    version: { type: Number, required: true, min: 1, max: 1 },
    summary: { type: String, required: true, maxlength: 7000 },
    pendingAsks: { type: [String], default: [] },
    commitments: { type: [String], default: [] },
    corrections: { type: [String], default: [] },
    decisions: { type: [String], default: [] },
    durableIdentifiers: { type: [String], default: [] },
    recurrenceOutcomes: { type: [String], default: [] },
    toolPairs: { type: [toolPairSchema], default: [] },
    sourceDigest: { type: String, required: true, maxlength: 64 },
    generatedAt: { type: Date, required: true },
  },
  { _id: false },
);

const compactionLeaseSchema = new Schema<IMainContinuityCompactionLease>(
  {
    leaseId: { type: String, required: true, maxlength: 96 },
    sourceDigest: { type: String, required: true, maxlength: 64 },
    sourceTurnKeys: { type: [String], default: [] },
    claimedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    sourceGeneration: { type: Number, min: 0 },
    throughPosition: { type: Number, min: 0 },
    legacyStateCursor: String,
    legacyMessageCursor: String,
    legacyComplete: Boolean,
    legacySourceOffset: { type: Number, min: 0 },
    legacySourceRange: {
      type: new Schema(
        {
          artifactId: { type: String, required: true },
          start: { type: Number, min: 0, required: true },
          end: { type: Number, min: 0, required: true },
          total: { type: Number, min: 0, required: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
  },
  { _id: false },
);

const mainContinuityStateSchema = new Schema<IViventiumMainContinuityState>(
  {
    recordKind: { type: String, enum: ['domain', 'epoch', 'revision_floor', 'legacy'] },
    domainEpochKey: { type: String, required: true, unique: true, index: true, maxlength: 64 },
    continuityDomainId: { type: String, required: true, index: true, maxlength: 64 },
    ownerId: { type: String, required: true, index: true, maxlength: 160 },
    agentId: { type: String, required: true, index: true, maxlength: 160 },
    contextEpoch: { type: String, maxlength: 64 },
    stableAuthoritySha256: { type: String, maxlength: 64 },
    version: { type: Number, required: true, default: 1, min: 1 },
    acceptedTurns: { type: [acceptedTurnSchema], default: [] },
    pendingCompactionTurns: { type: [acceptedTurnSchema], default: [] },
    acceptedRevisions: { type: [acceptedRevisionSchema], default: [] },
    semanticCompaction: { type: semanticCompactionSchema, default: null },
    compactionStatus: {
      type: String,
      enum: ['empty', 'pending', 'running', 'ready', 'degraded'],
      default: 'empty',
    },
    compactionLease: { type: compactionLeaseSchema, default: null },
    lastCompactionError: { type: String, default: '', maxlength: 120 },
    acceptedPosition: { type: Number, min: 0 },
    legacyAvailable: Boolean,
    sourceGeneration: { type: Number, min: 0 },
    summarizedThrough: { type: Number, min: 0 },
    legacyStateCursor: String,
    legacyMessageCursor: String,
    legacyComplete: Boolean,
    legacySourceOffset: { type: Number, min: 0 },
    logicalTurnId: String,
    revisionFloor: { type: Number, min: 1 },
    deletedRevisionFloor: { type: Number, min: 1 },
  },
  { timestamps: true },
);

// Deterministic domainEpochKey is the unique identity for all record kinds. The old
// redundant epoch index is verified and retired by the owning storage initialization.
mainContinuityStateSchema.index({
  ownerId: 1,
  continuityDomainId: 1,
  recordKind: 1,
  domainEpochKey: 1,
});

mainContinuityStateSchema.index({
  ownerId: 1,
  continuityDomainId: 1,
  recordKind: 1,
  'acceptedRevisions.logicalTurnId': 1,
});
for (const field of ['acceptedTurns.logicalTurnId', 'pendingCompactionTurns.logicalTurnId'])
  mainContinuityStateSchema.index({ ownerId: 1, continuityDomainId: 1, recordKind: 1, [field]: 1 });

export default mainContinuityStateSchema;
