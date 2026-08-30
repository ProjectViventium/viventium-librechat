import type { Document } from 'mongoose';

export const CORTEX_LOCAL_QA_FAULT_BOUNDARIES = [
  'cortex_ledger_first_write',
  'web_replay_persistence',
  'web_redis_publish_ack',
  'telegram_promoted_parent_presentation',
] as const;

export const CORTEX_LOCAL_QA_FAULT_STATES = ['armed', 'consumed', 'cleared', 'expired'] as const;

export const CORTEX_LOCAL_QA_FAULT_AUDIT_EVENTS = [
  'armed',
  'consumed',
  'cleared',
  'expired',
] as const;

export type CortexLocalQaFaultBoundary = (typeof CORTEX_LOCAL_QA_FAULT_BOUNDARIES)[number];
export type CortexLocalQaFaultState = (typeof CORTEX_LOCAL_QA_FAULT_STATES)[number];
export type CortexLocalQaFaultAuditEventName = (typeof CORTEX_LOCAL_QA_FAULT_AUDIT_EVENTS)[number];
export type CortexLocalQaFaultTerminalState = Exclude<CortexLocalQaFaultState, 'armed'>;

export interface ILocalQaCortexFaultAuditEvent {
  sequence: number;
  event: CortexLocalQaFaultAuditEventName;
  at: Date;
}

export interface ILocalQaCortexFaultControl extends Document {
  schemaVersion: 1;
  controlId: string;
  capabilityKey: string;
  caseTokenHash: string;
  componentArtifactDigest: string;
  boundary: CortexLocalQaFaultBoundary;
  ownerScopeHash: string;
  conversationScopeHash: string;
  parentScopeHash: string;
  syntheticScope: true;
  state: CortexLocalQaFaultState;
  armedAt: Date;
  expiresAt: Date;
  purgeAt: Date;
  consumedAt?: Date;
  clearedAt?: Date;
  audit: ILocalQaCortexFaultAuditEvent[];
}

export interface ILocalQaCortexFaultAuthorityIdentity {
  schemaVersion: 1;
  controlId: string;
  capabilityKey: string;
  caseTokenHash: string;
  componentArtifactDigest: string;
  boundary: CortexLocalQaFaultBoundary;
  ownerScopeHash: string;
  conversationScopeHash: string;
  parentScopeHash: string;
  syntheticScope: true;
  armedAt: Date;
  expiresAt: Date;
  purgeAt: Date;
}

export interface ILocalQaCortexFaultIssuance
  extends Document, ILocalQaCortexFaultAuthorityIdentity {
  authorityState: CortexLocalQaFaultState;
  terminalAt?: Date;
}

export interface ILocalQaCortexFaultTerminalReceipt
  extends Document, ILocalQaCortexFaultAuthorityIdentity {
  terminalState: CortexLocalQaFaultTerminalState;
  terminalAt: Date;
}
