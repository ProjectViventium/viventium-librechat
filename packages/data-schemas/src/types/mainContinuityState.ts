/* === VIVENTIUM START === Provider-neutral accepted Main continuity state types. === VIVENTIUM END === */

export interface IMainContinuityToolPair {
  callId: string;
  toolName: string;
  outcome: string;
}

export interface IMainContinuityAcceptedTurn {
  acceptedPosition?: number;
  logicalTurnId: string;
  revision: number;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  origin: string;
  scheduleId?: string;
  scheduleRunId?: string;
  userText: string;
  assistantText: string;
  toolPairs: IMainContinuityToolPair[];
  committedAt: Date;
  sourceDeletedAt?: Date;
}

export interface IMainContinuityAcceptedRevision {
  logicalTurnId: string;
  revision: number;
  sourceDeleted?: boolean;
}

export interface IMainSemanticCompaction {
  version: number;
  summary: string;
  pendingAsks: string[];
  commitments: string[];
  corrections: string[];
  decisions: string[];
  durableIdentifiers: string[];
  recurrenceOutcomes: string[];
  toolPairs: IMainContinuityToolPair[];
  sourceDigest: string;
  generatedAt: Date;
}

export interface IMainContinuityCompactionLease {
  leaseId: string;
  sourceDigest: string;
  sourceTurnKeys: string[];
  claimedAt: Date;
  expiresAt: Date;
  sourceGeneration?: number;
  throughPosition?: number;
  legacyStateCursor?: string;
  legacyMessageCursor?: string;
  legacyComplete?: boolean;
  legacySourceOffset?: number;
  legacySourceRange?: IMainContinuityLegacySourceRange;
}

export interface IMainContinuityLegacySourceRange {
  artifactId: string;
  start: number;
  end: number;
  total: number;
}

export interface IMainContinuityLegacyCursor {
  state?: string;
  message?: string;
  sourceOffset?: number;
  range?: IMainContinuityLegacySourceRange;
}

export type MainContinuityCompactionStatus = 'empty' | 'pending' | 'running' | 'ready' | 'degraded';

export interface IViventiumMainContinuityState {
  /** Legacy rows remain immutable evidence; only epoch rows contain active derived context. */
  recordKind?: 'domain' | 'epoch' | 'revision_floor' | 'legacy';
  domainEpochKey: string;
  continuityDomainId: string;
  ownerId: string;
  agentId: string;
  contextEpoch: string;
  stableAuthoritySha256: string;
  version: number;
  acceptedTurns: IMainContinuityAcceptedTurn[];
  pendingCompactionTurns: IMainContinuityAcceptedTurn[];
  acceptedRevisions: IMainContinuityAcceptedRevision[];
  semanticCompaction: IMainSemanticCompaction | null;
  compactionStatus: MainContinuityCompactionStatus;
  compactionLease: IMainContinuityCompactionLease | null;
  lastCompactionError: string;
  createdAt: Date;
  updatedAt: Date;
  acceptedPosition?: number;
  legacyAvailable?: boolean;
  sourceGeneration?: number;
  summarizedThrough?: number;
  legacyStateCursor?: string;
  legacyMessageCursor?: string;
  legacyComplete?: boolean;
  legacySourceOffset?: number;
  logicalTurnId?: string;
  revisionFloor?: number;
  deletedRevisionFloor?: number;
}

/** Records state projection, never delivery permission or transcript content. */
export interface IAcceptedMainContext {
  continuityDomainId: string;
  logicalTurnId: string;
  revision: number;
  committedAt: Date;
  /** Domain-serialized acceptance order, independent of maintenance timestamps. */
  position?: number;
  supersededAt?: Date;
  sourceDeletedAt?: Date;
}
