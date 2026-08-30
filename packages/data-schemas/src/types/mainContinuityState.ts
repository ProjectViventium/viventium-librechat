/* === VIVENTIUM START === Provider-neutral accepted Main continuity state types. === VIVENTIUM END === */

export interface IMainContinuityToolPair {
  callId: string;
  toolName: string;
  outcome: string;
}

export interface IMainContinuityAcceptedTurn {
  logicalTurnId: string;
  revision: number;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  origin: string;
  userText: string;
  assistantText: string;
  toolPairs: IMainContinuityToolPair[];
  committedAt: Date;
}

export interface IMainContinuityAcceptedRevision {
  logicalTurnId: string;
  revision: number;
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
}

export type MainContinuityCompactionStatus = 'empty' | 'pending' | 'running' | 'ready' | 'degraded';

export interface IViventiumMainContinuityState {
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
}
