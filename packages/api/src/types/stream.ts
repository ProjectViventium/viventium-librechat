import type { EventEmitter } from 'events';
import type { Agents } from 'librechat-data-provider';
import type { ServerSentEvent } from '~/types';
import type {
  AdapterCapabilities,
  InteractionContext,
  InteractionDeliveryAck,
  InteractionDeliveryPolicy,
} from '~/stream/interfaces/IJobStore';

export interface GenerationJobMetadata {
  userId: string;
  conversationId?: string;
  /** User message data for rebuilding submission on reconnect */
  userMessage?: Agents.UserMessageMeta;
  /** Response message ID for tracking */
  responseMessageId?: string;
  /** Sender label for the response (e.g., "GPT-4.1", "Claude") */
  sender?: string;
  /** Endpoint identifier for abort handling */
  endpoint?: string;
  /** Icon URL for UI display */
  iconURL?: string;
  /** Model name for token tracking */
  model?: string;
  /** Prompt token count for abort token spending */
  promptTokens?: number;
  interactionContext?: InteractionContext;
  adapterCapabilities?: AdapterCapabilities;
  deliveryPolicy?: InteractionDeliveryPolicy;
  deliveryAcknowledgement?: InteractionDeliveryAck;
  generationCompleted?: boolean;
  /** Viventium voice-call session that owns this generation, when applicable */
  voiceCallSessionId?: string;
}

export type GenerationJobStatus = 'running' | 'complete' | 'error' | 'aborted' | 'superseded';

export interface GenerationJob {
  streamId: string;
  emitter: EventEmitter;
  status: GenerationJobStatus;
  createdAt: number;
  completedAt?: number;
  abortController: AbortController;
  error?: string;
  metadata: GenerationJobMetadata;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  /** Final event when job completes */
  finalEvent?: ServerSentEvent;
  /** Flag to indicate if a sync event was already sent (prevent duplicate replays) */
  syncSent?: boolean;
  /** Set when source-event idempotency maps this request to an already-created stream. */
  duplicateOfStreamId?: string;
  /** Uncommitted older presentations that this revision superseded and must hide durably. */
  supersededPresentations?: Array<{
    conversationId?: string;
    responseMessageId?: string;
    interactionContext?: InteractionContext;
  }>;
}

export type ContentPart = Agents.ContentPart;
export type ResumeState = Agents.ResumeState;

export type ChunkHandler = (event: ServerSentEvent) => void;
export type DoneHandler = (event: ServerSentEvent) => void;
export type ErrorHandler = (error: string) => void;
export type UnsubscribeFn = () => void;
