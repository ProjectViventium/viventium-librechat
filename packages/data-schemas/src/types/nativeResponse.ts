/* === VIVENTIUM START === Private native response admission on the existing Message. === */
import type { ClientSession } from 'mongoose';

export interface NativeResponseSource {
  id: string;
  messageId: string;
  digest: string;
  /** The selected parent captured from authored history before prompt transformation. */
  parent?: Pick<NativeResponseSource, 'id' | 'messageId' | 'digest'> & {
    /** Omitted historical proofs refer to assistant parents. */
    isCreatedByUser?: boolean;
  };
}

/** Server-owned operation intent; augmentation must not retire an accepted Main answer. */
export type NativeResponseMutationKind = 'edit' | 'delete' | 'system';

export interface NativeResponseIdentity {
  userId: string;
  conversationId: string;
  responseMessageId: string;
  streamId: string;
  jobCreatedAt: number;
  logicalTurnId: string;
  revision: number;
  sourceOrderScope?: string;
  sourceSequence?: number;
  deliveryDispositionRequired?: boolean;
  deliveryContext?: NativeResponseDeliveryContext;
  invocationId: string;
  bodySha256: string;
  providerId: string;
  agentId: string;
  originSha256: string;
  source: NativeResponseSource;
  admittedAt: number;
  recoverUntil: number;
}

/** Original request facts used by the existing public-message channel sanitizers. */
export type NativeResponseDeliveryContext =
  | { surface: 'web' | 'voice' }
  | { surface: 'telegram'; audioRequested: boolean; authenticated: boolean };

export type NativeResponseMessageProjection = Pick<
  import('./message').IMessage,
  'text' | 'content' | 'metadata' | 'attachments'
>;

export interface NativeResponsePreparedAttachments {
  attachments: NativeResponseMessageProjection['attachments'];
  authorizePublication?: (session: ClientSession) => Promise<void>;
}
export type NativeResponseAttachmentPreparation =
  NativeResponseMessageProjection['attachments'] | NativeResponsePreparedAttachments;

export interface NativeResponseAdmission extends NativeResponseIdentity {
  status: 'pending' | 'prepared' | 'completed' | 'cancelled' | 'failed' | 'unsupported';
  authoritySha256?: string;
  candidateJson?: string;
  candidateSha256?: string;
  historicalPermit?: string;
  finalReplayStoredAt?: number;
  /** Written atomically with the canonical partial accepted by explicit Stop. */
  stopSnapshotStoredAt?: number;
  /** Written with the canonical error snapshot of an exact upstream terminal result. */
  terminalSnapshotStoredAt?: number;
}

export interface NativeResponseCandidate {
  text: string;
  authoritySha256: string;
  requestId: string;
  runId: string;
  responseJson: string;
}

export interface NativeResponseCommit {
  status: 'committed' | 'revoked' | 'unavailable';
  candidateSha256?: string;
}
/* === VIVENTIUM END === */

export type DeliveryAcknowledgementState =
  'committed' | 'committed_effect' | 'partial_removed' | 'failed';

export interface InteractionDeliveryAck {
  logical_turn_id: string;
  revision: number;
  state: DeliveryAcknowledgementState;
  /** Exact server-persisted durable provider receipt; never inferred from presentation text. */
  effect_ref?: string;
  presentation_ref?: string;
  presentation_refs?: string[];
  /** Store-authored visible-presentation time. Adapter input is never authoritative. */
  presentation_committed_at?: number;
  source_kind?: 'assistant_message' | 'schedule_result' | 'callback';
  schedule_id?: string;
  schedule_run_id?: string;
}

/** Existing host generation identity; no native admission or publication is implied. */
export type HostResponseIdentity = Pick<
  NativeResponseIdentity,
  | 'userId'
  | 'conversationId'
  | 'responseMessageId'
  | 'streamId'
  | 'jobCreatedAt'
  | 'logicalTurnId'
  | 'revision'
  | 'sourceOrderScope'
  | 'sourceSequence'
  | 'source'
> & {
  surface: 'web' | 'telegram' | 'voice';
  callSessionId?: string;
};

/** Private canonical Message completion, separate from presentation acknowledgement. */
export interface HostResponseFinal extends HostResponseIdentity {
  version: 1;
  storedAt: number;
  payloadSha256: string;
  contextSha256: string;
}
