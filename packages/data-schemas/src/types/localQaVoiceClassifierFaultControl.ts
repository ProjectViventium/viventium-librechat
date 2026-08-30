import type { Document } from 'mongoose';

export const VOICE_CLASSIFIER_FAULT_CONTROL_STATES = [
  'armed',
  'challenged',
  'approved',
  'consumed',
  'cleared',
  'expired',
] as const;

export type VoiceClassifierFaultControlState =
  (typeof VOICE_CLASSIFIER_FAULT_CONTROL_STATES)[number];

export interface ILocalQaVoiceClassifierFaultControl extends Document {
  schemaVersion: 1;
  controlId: string;
  caseId: 'MPV-061';
  sessionRefHash: string;
  sessionCandidateDigest: string;
  caseTokenHash: string;
  candidateDigest: string;
  componentArtifactDigest: string;
  installedArtifactDigest: string;
  runtimeOwnerBindingHash: string;
  ownerScopeHash: string;
  callScopeHash: string;
  utteranceHash?: string;
  primaryProvider: string;
  primaryModel: string;
  fallbackProvider: string;
  fallbackModel: string;
  armBindingHash: string;
  syntheticScope: true;
  state: VoiceClassifierFaultControlState;
  armedAt: Date;
  expiresAt: Date;
  purgeAt: Date;
  challengeId?: string;
  challengeIssuedAt?: Date;
  challengeExpiresAt?: Date;
  replayExpiresAt?: Date;
  turnId?: string;
  segments?: Array<{ segmentId: string; revision: number }>;
  turnScopeHash?: string;
  segmentSetHash?: string;
  turnBindingHash?: string;
  coreProof?: string;
  approvedAt?: Date;
  approvalProof?: string;
  consumedAt?: Date;
  receiptExpiresAt?: Date;
  receiptDigest?: string;
  clearedAt?: Date;
}
