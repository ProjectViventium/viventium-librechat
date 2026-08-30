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
    logicalTurnId: { type: String, required: true, maxlength: 160 },
    revision: { type: Number, required: true, min: 1 },
    conversationId: { type: String, default: '', maxlength: 256 },
    userMessageId: { type: String, default: '', maxlength: 256 },
    assistantMessageId: { type: String, required: true, maxlength: 256 },
    origin: { type: String, default: 'interactive', maxlength: 40 },
    userText: { type: String, default: '', maxlength: 6000 },
    assistantText: { type: String, required: true, maxlength: 6000 },
    toolPairs: { type: [toolPairSchema], default: [] },
    committedAt: { type: Date, required: true },
  },
  { _id: false },
);

const acceptedRevisionSchema = new Schema<IMainContinuityAcceptedRevision>(
  {
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
  },
  { _id: false },
);

const mainContinuityStateSchema = new Schema<IViventiumMainContinuityState>(
  {
    domainEpochKey: { type: String, required: true, unique: true, index: true, maxlength: 64 },
    continuityDomainId: { type: String, required: true, index: true, maxlength: 64 },
    ownerId: { type: String, required: true, index: true, maxlength: 160 },
    agentId: { type: String, required: true, index: true, maxlength: 160 },
    contextEpoch: { type: String, required: true, maxlength: 64 },
    stableAuthoritySha256: { type: String, required: true, maxlength: 64 },
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
  },
  { timestamps: true },
);

mainContinuityStateSchema.index({ ownerId: 1, agentId: 1, contextEpoch: 1 }, { unique: true });

export default mainContinuityStateSchema;
