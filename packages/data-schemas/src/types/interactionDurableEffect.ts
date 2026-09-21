/* === VIVENTIUM START === Provider-neutral durable interaction-effect types. === VIVENTIUM END === */

export const INTERACTION_DURABLE_EFFECT_STATES = [
  'reserved',
  'provider_outcome_unknown',
  'committed',
  'failed_without_effect',
] as const;

export const INTERACTION_DURABLE_EFFECT_KINDS = [
  'durable_work_accepted',
  'durable_work_action_accepted',
] as const;

export const INTERACTION_DURABLE_EFFECT_SURFACES = [
  'web',
  'telegram',
  'voice',
  'workbench',
] as const;

export type InteractionDurableEffectState = (typeof INTERACTION_DURABLE_EFFECT_STATES)[number];
export type InteractionDurableEffectKind = (typeof INTERACTION_DURABLE_EFFECT_KINDS)[number];
export type InteractionDurableEffectSurface = (typeof INTERACTION_DURABLE_EFFECT_SURFACES)[number];

export type InteractionDurableEffectJsonValue =
  | null
  | boolean
  | number
  | string
  | InteractionDurableEffectJsonValue[]
  | { [key: string]: InteractionDurableEffectJsonValue };

export interface InteractionDurableVoiceAuthority {
  callSessionId: string;
  voiceTurnId: string;
  mode: 'call' | 'wing';
  callModeRevision: number;
  speakerSessionRevision: number;
  segmentRevisionDigest: string;
  ownerParticipantDigest: string;
  engagementDigest?: string;
  engagementExpiresAt?: Date;
}

export interface InteractionDurableEffectRuntimeBinding {
  candidateDigest?: string;
  installedArtifactDigest?: string;
  runtimeOwnerBindingHash?: string;
}

export interface InteractionDurableEffectDeliveryAcknowledgement {
  state: 'committed_effect';
  effectRef: string;
  logicalTurnId: string;
  revision: number;
  surface: 'telegram' | 'voice';
  presentationRef?: string;
  recordedAt: Date;
}

export interface IInteractionDurableEffect {
  schemaVersion: 1;
  effectKey: string;
  ownerId: string;
  conversationId: string;
  logicalTurnId: string;
  logicalTurnRevision: number;
  sourceEventId: string;
  sourceRevision: number;
  responseMessageId: string;
  presentationRevision: number;
  surface: InteractionDurableEffectSurface;
  effectOrdinal: 0;
  effectOccurrenceRef: string;
  effectKind: InteractionDurableEffectKind;
  adapterId: string;
  routeId: string;
  operation: string;
  canonicalArgsSha256: string;
  voiceAuthorityRef?: string;
  voice?: InteractionDurableVoiceAuthority;
  providerIdempotencyKey: string;
  providerIdempotencyMode: 'native_key' | 'deterministic_reconciliation';
  runtimeBindingAtReserve?: InteractionDurableEffectRuntimeBinding;
  status: InteractionDurableEffectState;
  claimRevision: number;
  claimTokenHash: string;
  claimExpiresAt?: Date;
  attemptCount: number;
  providerReceiptRef?: string;
  providerResultSha256?: string;
  replayResult?: InteractionDurableEffectJsonValue;
  failureCode?: string;
  committedAt?: Date;
  failedAt?: Date;
  lastTransitionAt: Date;
  lastAttemptRuntimeBinding?: InteractionDurableEffectRuntimeBinding;
  deliveryAcknowledgement?: InteractionDurableEffectDeliveryAcknowledgement;
  transitionRevision: number;
  createdAt: Date;
}
