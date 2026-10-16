/* === VIVENTIUM START ===
 * Feature: Provider-neutral accepted Main continuity state.
 * Purpose: Own accepted turns and semantic compaction state in the typed schema package.
 * === VIVENTIUM END === */

import { Schema } from 'mongoose';
import { normalizeMainBackgroundInputs } from '~/methods/mainContinuityEvidence';
import type {
  IMainContinuityBackgroundInput,
  IMainContinuityAcceptedRevision,
  IMainContinuityAcceptedTurn,
  IMainContinuityCompactionLease,
  IMainContinuityCompactionRepair,
  IMainContinuityToolPair,
  IMainSemanticCompaction,
  IMainCompactionOutputContract,
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

const backgroundInputSchema = new Schema<IMainContinuityBackgroundInput>(
  {
    version: { type: Number, required: true, enum: [1] },
    invocationId: { type: String, required: true, maxlength: 160 },
    deliveryId: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    text: { type: String, required: true, maxlength: 65536 },
    textSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
    sources: {
      type: [
        new Schema(
          {
            cortexId: { type: String, required: true, maxlength: 256 },
            cortexName: { type: String, maxlength: 1024 },
            insightSha256: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
          },
          { _id: false },
        ),
      ],
      required: true,
    },
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
    backgroundInputs: {
      type: [backgroundInputSchema],
      default: undefined,
      validate: {
        validator(value: unknown) {
          try {
            normalizeMainBackgroundInputs(value);
            return true;
          } catch {
            return false;
          }
        },
        message: 'Accepted Main background input is invalid',
      },
    },
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
    summary: { type: String, required: true, maxlength: 128 * 1024 },
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

const outputContractSchema = new Schema<IMainCompactionOutputContract>(
  {
    version: { type: Number, required: true, enum: [1] },
    consumer: { type: String, required: true, enum: ['accepted_core', 'conversation_legacy'] },
    carrierMaxUtf8Bytes: { type: Number, required: true, enum: [12 * 1024, 16 * 1024, 128 * 1024] },
    reservedUtf8Bytes: { type: Number, required: true, min: 0 },
    maxJsonUtf8Bytes: { type: Number, required: true, min: 1 },
    maxSummaryUtf8Bytes: { type: Number, required: true, min: 1 },
    maxItemsPerArray: { type: Number, required: true, enum: [32] },
    maxStringItemUtf8Bytes: { type: Number, required: true, enum: [1024] },
    maxToolIdentityCharacters: { type: Number, required: true, enum: [256] },
  },
  { _id: false },
);

const legacySourceRangeSchema = new Schema({
  artifactId: { type: String, required: true },
  start: { type: Number, min: 0, required: true },
  end: { type: Number, min: 0, required: true },
  total: { type: Number, min: 0, required: true },
}, { _id: false });

const compactionLeaseSchema = new Schema<IMainContinuityCompactionLease>(
  {
    leaseId: { type: String, required: true, maxlength: 96 },
    sourceDigest: { type: String, required: true, maxlength: 64 },
    sourceTurnKeys: { type: [String], default: [] },
    claimedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    outputContract: { type: outputContractSchema, default: undefined },
    sourceGeneration: { type: Number, min: 0 },
    throughPosition: { type: Number, min: 0 },
    legacyStateCursor: String,
    legacyMessageCursor: String,
    legacyComplete: Boolean,
    legacySourceOffset: { type: Number, min: 0 },
    legacySourceRange: { type: legacySourceRangeSchema, default: undefined },
  },
  { _id: false },
);

const compactionRepairSchema = new Schema<IMainContinuityCompactionRepair>(
  {
    version: { type: Number, required: true, enum: [1] },
    sourceDigest: { type: String, required: true, maxlength: 64 },
    contractKey: { type: String, required: true, maxlength: 4096 },
    semanticAttempts: { type: Number, required: true, min: 1 },
    fidelityRepairAttempts: { type: Number, enum: [0, 1], default: undefined },
    transportRetries: { type: Number, required: true, min: 0 },
    sourceGeneration: { type: Number, required: true, min: 0 },
    sourceTurnKeys: { type: [String], required: true },
    legacySourceRange: { type: legacySourceRangeSchema, default: undefined },
    outputContract: { type: outputContractSchema, default: undefined },
    sizeRepair: { type: new Schema({
      proposalBytes: { type: Number, required: true, min: 1 },
      previousProposalBytes: { type: Number, min: 1,
        required: function () { return this.parent().semanticAttempts !== 1; } },
      converging: { type: Boolean, required: true, enum: [true] },
    }, { _id: false }), required: function () { return this.correction?.code === 'schema_invalid'; } },
    correction: {
      type: new Schema({
        code: { type: String, required: true, enum: ['semantic_fidelity', 'schema_invalid'] },
        candidate: { type: String, required: function () { return this.code === 'semantic_fidelity'; } },
        issue: { type: new Schema({
          path: { type: String, enum: ['', 'summary', '$carrier'], default: '' },
          constraint: { type: String, required: true, enum: ['max_bytes'] },
          actual: { type: Number, required: true, min: 1 },
          limit: { type: Number, required: true, min: 1 },
          unit: { type: String, required: true, enum: ['utf8_bytes'] },
          proposalBytes: { type: Number, required: true, min: 1 },
          excessBytes: { type: Number, min: 1 },
          fieldBytes: { type: Map, of: Number },
        }, { _id: false }), required: function () { return this.code === 'schema_invalid'; } },
        reason: { type: String, maxlength: 2000 },
      }, { _id: false }),
      required: true,
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
    semanticCompactionContract: { type: outputContractSchema, default: undefined },
    compactionStatus: {
      type: String,
      enum: ['empty', 'pending', 'running', 'ready', 'degraded'],
      default: 'empty',
    },
    compactionLease: { type: compactionLeaseSchema, default: null },
    pendingCompactionRepair: { type: compactionRepairSchema, default: null },
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
