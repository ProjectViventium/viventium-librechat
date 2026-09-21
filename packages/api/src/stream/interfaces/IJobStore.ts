import type { Agents } from 'librechat-data-provider';
import type { StandardGraph } from '@librechat/agents';
import type { NativeAcceptedSource, NativePredecessor } from '../../glasshive/nativeSupersession';
import type { InteractionSourceSegment } from '../../glasshive/interactionSourceSegments';
export type { InteractionSourceSegment } from '../../glasshive/interactionSourceSegments';
import type { ReadyInputContinuation } from '../../agents/interactionContext';
import type { NativeResponseIdentity, NativeResponseCommit } from '@librechat/data-schemas';

/* === VIVENTIUM START === EMO-UC-048 typed local-QA fault boundary. === */
import type { CortexLocalQaFaultBoundary } from '../../localQa';
/* === VIVENTIUM END === */

/**
 * Job status enum
 */
/* === VIVENTIUM START ===
 * Feature: Durable logical-turn continuity.
 * Purpose: Define trusted stream ownership, revision, source, and delivery contracts.
 */
export type JobStatus = 'running' | 'complete' | 'error' | 'aborted' | 'superseded';

/** Trusted, server-authored context shared by generation and delivery adapters. */
export interface InteractionContext {
  actor_kind: 'external_user' | 'system' | 'worker';
  origin: 'interactive' | 'scheduler' | 'callback';
  surface: 'web' | 'telegram' | 'voice' | 'workbench';
  conversation_id: string;
  logical_turn_id?: string;
  revision: number;
  source_event_id: string;
  /** Trusted monotonic source order; never inferred from the opaque source event identity. */
  source_sequence?: number;
  source_conversation_generation?: string;
  ready_input_continuation?: ReadyInputContinuation;
  /** Opaque SHA-256 scope for the authenticated owner + source chat + topic. */
  source_order_scope?: string;
  /** Optional server-owned boundary for sources that must never revise one unresolved turn. */
  turn_scope?: 'conversation' | 'source_event';
  schedule_id?: string;
  schedule_run_id?: string;
  /** Presentation/message metadata must omit this raw text. */
  source_segments?: readonly InteractionSourceSegment[];
  /** Number of oldest source segments evicted from the bounded internal ledger. */
  source_segments_overflow_count?: number;
}

export interface InteractionAdapterCapabilities {
  segment_stability: 'immediate' | 'provisional';
  supersede_scope: 'response_and_authoring' | 'response_only';
}

export type AdapterCapabilities = InteractionAdapterCapabilities;

export interface InteractionDeliveryPolicy {
  commit_authority: 'server' | 'external_adapter';
}

/** Exact client-authored placeholders for one resumable presentation. */
export interface ClientPresentation {
  mode: 'append' | 'regenerate';
  userMessageId: string;
  responseMessageId: string;
  targetUserMessageId: string;
}

/** Server-verified durable side effect that is allowed to outlive response supersession. */
export interface DurableEffectReceipt {
  effect_kind: 'durable_work_accepted' | 'durable_work_action_accepted';
  effect_ref: string;
  source_event_id: string;
  response_message_id: string;
  committed_at: number;
}

/** Hash-only Voice authority frozen after the route's final persisted authority re-read. */
export interface VoiceDurableEffectAuthorityBinding {
  version: 1;
  userId: string;
  voiceAuthorityRef: string;
  voice: {
    callSessionId: string;
    voiceTurnId: string;
    mode: 'call' | 'wing';
    callModeRevision: number;
    speakerSessionRevision: number;
    segmentRevisionDigest: string;
    ownerParticipantDigest: string;
    engagementDigest?: string;
    engagementExpiresAt?: string;
  };
}

export interface LogicalTurnClaim {
  status: 'claimed' | 'duplicate' | 'superseded' | 'initializing' | 'busy' | 'stale_source_order';
  streamId: string;
  interactionContext: InteractionContext;
  supersededStreamIds: string[];
  /** Store-internal owner receipts for fencing a prior claim that has not published its job yet. */
  supersededClaimIdentities?: string[];
}

/** Authenticated monotonic source-order observation made before provider or presentation awaits. */
export interface SourceOrderObservation {
  source_order_scope: string;
  source_sequence: number;
}

export interface SourceOrderObservationResult {
  latest_source_sequence: number;
  observed_at: number;
  stale: boolean;
}

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

export interface CortexPresentationBinding {
  ownerId: string;
  messageId: string;
  parentMessageId: string;
  revision: number;
  generation: number;
  deliveryIds: string[];
  deliveryReceipts: Array<{
    deliveryId: string;
    graphResultHash: string;
  }>;
  claimToken: string;
  presentationLeaseToken: string;
  /** Server time when this exact presentation was bound to the stream job. */
  boundAt: number;
}

export interface CortexPresentationFenceReceipt {
  ownerId: string;
  messageId: string;
  parentMessageId: string;
  revision: number;
  generation: number;
  deliveryIds: string[];
  deliveryReceipts: Array<{
    deliveryId: string;
    graphResultHash: string;
  }>;
  claimToken: string;
  presentationLeaseToken: string;
}

export type CortexPresentationVerificationStage = 'bind' | 'append' | 'publish';

export interface ChunkEmissionOptions {
  verifyCortexPresentation?: (
    stage: CortexPresentationVerificationStage,
  ) => Promise<CortexPresentationFenceReceipt>;
  /* === VIVENTIUM START === EMO-UC-048 fault capability after presentation authorization. === */
  consumeCortexFault?: (boundary: CortexLocalQaFaultBoundary) => Promise<{ triggered: boolean }>;
  /* === VIVENTIUM END === */
}

export interface DeliveryAcknowledgementResult {
  status:
    | 'recorded'
    | 'not_found'
    | 'stale_revision'
    | 'stale_source_order'
    | 'conflict'
    | 'retryable_conflict';
  acknowledgement?: InteractionDeliveryAck;
  idempotent?: boolean;
  transportOnly?: boolean;
  /** Internal server-held owner; never accepted from or exposed as client authority. */
  ownerStreamId?: string;
  /** Internal persistence target derived from the owner job, never from adapter claims. */
  presentation?: {
    userId: string;
    conversationId?: string;
    responseMessageId?: string;
    interactionContext?: InteractionContext;
    cortexPresentation?: CortexPresentationBinding;
  };
}

/** Result of atomically binding one delivery acknowledgement to the expected Cortex generation. */
export interface DeliveryAcknowledgementBindingResult {
  status:
    | 'recorded'
    | 'not_found'
    | 'stale_revision'
    | 'stale_source_order'
    | 'conflict'
    | 'retryable_conflict';
  acknowledgement?: InteractionDeliveryAck;
  idempotent?: boolean;
  ownerStreamId?: string;
  cortexPresentation?: CortexPresentationBinding;
}
/* === VIVENTIUM END === */

/**
 * Serializable job data - no object references, suitable for Redis/external storage
 */
export interface SerializableJobData {
  streamId: string;
  userId: string;
  status: JobStatus;
  createdAt: number;
  completedAt?: number;
  conversationId?: string;
  error?: string;

  /** User message metadata */
  userMessage?: {
    messageId: string;
    parentMessageId?: string;
    conversationId?: string;
    text?: string;
  };

  /** Response message ID for reconnection */
  responseMessageId?: string;

  /** Sender name for UI display */
  sender?: string;

  /** Whether sync has been sent to a client */
  syncSent: boolean;

  /** Serialized final event for replay */
  finalEvent?: string;

  /** Endpoint metadata for abort handling - avoids storing functions */
  endpoint?: string;
  iconURL?: string;
  model?: string;
  promptTokens?: number;
  /** Legacy/public call-session metadata retained for stream resume compatibility. */
  voiceCallSessionId?: string;
  /* === VIVENTIUM START ===
   * Feature: Durable logical-turn continuity.
   * Purpose: Persist only server-authored generation and delivery ownership metadata with a job.
   */
  interactionContext?: InteractionContext;
  adapterCapabilities?: AdapterCapabilities;
  deliveryPolicy?: InteractionDeliveryPolicy;
  deliveryAcknowledgement?: InteractionDeliveryAck;
  /** Exact adapter receipt for the current fenced Cortex presentation, separate from Main. */
  cortexDeliveryAcknowledgement?: InteractionDeliveryAck;
  cortexDeliveryAcknowledgementPresentation?: CortexPresentationBinding;
  durableEffectReceipt?: DurableEffectReceipt;
  /** All durable launches committed by this response; the singular field is the first receipt. */
  durableEffectReceipts?: DurableEffectReceipt[];
  /** Exact route-captured Voice authority used only for Mongo-before-provider effect admission. */
  viventiumVoiceEffectAuthority?: VoiceDurableEffectAuthorityBinding;
  viventiumCallSessionId?: string;
  viventiumVoiceTaskId?: string;
  /** Immutable native admission; only the typed publication owner may change it. */
  nativeResponse?: NativeResponseIdentity;
  nativePredecessor?: NativePredecessor;
  nativeAcceptedSources?: { invocationId: string; sources: NativeAcceptedSource[] };
  nativeResponseCancelled?: boolean;
  nativeResponseFinished?: boolean;
  nativeResponseSettled?: boolean;
  generationCompleted?: boolean;
  /** Admission-time receipt used only to project optimistic UI IDs onto authoritative IDs. */
  clientPresentation?: ClientPresentation;
  /** Exact server-held Cortex presentation emitted on this logical-turn stream. */
  cortexPresentation?: CortexPresentationBinding;
  /* === VIVENTIUM END === */
}

/**
 * Usage metadata for token spending across different LLM providers.
 *
 * This interface supports two mutually exclusive cache token formats:
 *
 * **OpenAI format** (GPT-4, o1, etc.):
 * - Uses `input_token_details.cache_creation` and `input_token_details.cache_read`
 * - Cache tokens are nested under the `input_token_details` object
 *
 * **Anthropic format** (Claude models):
 * - Uses `cache_creation_input_tokens` and `cache_read_input_tokens`
 * - Cache tokens are top-level properties
 *
 * When processing usage data, check both formats:
 * ```typescript
 * const cacheCreation = usage.input_token_details?.cache_creation
 *   || usage.cache_creation_input_tokens || 0;
 * ```
 */
export interface UsageMetadata {
  /** Total input tokens (prompt tokens) */
  input_tokens?: number;
  /** Total output tokens (completion tokens) */
  output_tokens?: number;
  /** Model identifier that generated this usage */
  model?: string;
  /**
   * OpenAI-style cache token details.
   * Present for OpenAI models (GPT-4, o1, etc.)
   */
  input_token_details?: {
    /** Tokens written to cache */
    cache_creation?: number;
    /** Tokens read from cache */
    cache_read?: number;
  };
  /**
   * Anthropic-style cache creation tokens.
   * Present for Claude models. Mutually exclusive with input_token_details.
   */
  cache_creation_input_tokens?: number;
  /**
   * Anthropic-style cache read tokens.
   * Present for Claude models. Mutually exclusive with input_token_details.
   */
  cache_read_input_tokens?: number;
}

/**
 * Result returned from aborting a job - contains all data needed
 * for token spending and message saving without storing callbacks
 */
export interface AbortResult {
  nativeResponse?: 'committed' | 'pending' | 'unavailable';
  /** Whether the abort was successful */
  success: boolean;
  /** The job data at time of abort */
  jobData: SerializableJobData | null;
  /** Aggregated content from the stream */
  content: Agents.MessageContentComplex[];
  /** Final event to send to client */
  finalEvent: unknown;
  /** Concatenated text from all content parts for token counting fallback */
  text: string;
  /** Collected usage metadata from all models for token spending */
  collectedUsage: UsageMetadata[];
}

/**
 * Resume state for reconnecting clients
 */
export interface ResumeState {
  runSteps: Agents.RunStep[];
  aggregatedContent: Agents.MessageContentComplex[];
  userMessage?: SerializableJobData['userMessage'];
  responseMessageId?: string;
  conversationId?: string;
  sender?: string;
  clientPresentation?: ClientPresentation;
}

/**
 * Interface for job storage backend.
 * Implementations can use in-memory Map, Redis, KV store, etc.
 *
 * Content state is tied to jobs:
 * - In-memory: Holds WeakRef to graph for live content/run steps access
 * - Redis: Persists chunks, reconstructs content on reconnect
 *
 * This consolidates job metadata + content state into a single interface.
 */
export interface IJobStore {
  /** Process-local stores cannot protect Telegram ordering across restarts or replicas. */
  readonly sourceOrderDurability?: 'process' | 'durable';

  /** Initialize the store (e.g., connect to Redis, start cleanup intervals) */
  initialize(): Promise<void>;

  /** Create a new job */
  createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    /* === VIVENTIUM START ===
     * Feature: Durable logical-turn continuity.
     * Purpose: Atomically seed trusted job metadata at create-once admission.
     */
    initialData?: Partial<SerializableJobData>,
    /* === VIVENTIUM END === */
  ): Promise<SerializableJobData>;

  /* === VIVENTIUM START ===
   * Feature: Durable logical-turn continuity.
   * Purpose: Keep revision ownership, rollback, and external delivery acknowledgement server-held.
   */
  /** Retain authenticated input in the existing logical-turn owner before asynchronous setup. */
  retainLogicalTurnInput(userId: string, context: InteractionContext): Promise<InteractionContext>;

  /** Atomically claim a revision, or return the first stream for a duplicate source event. */
  claimLogicalTurn(
    streamId: string,
    userId: string,
    interactionContext: InteractionContext,
  ): Promise<LogicalTurnClaim>;

  /** Atomically advance or read one authenticated source-order watermark. */
  observeSourceOrder(observation: SourceOrderObservation): Promise<SourceOrderObservationResult>;

  /** Conditionally undo a failed claim only while that stream still owns the latest revision. */
  rollbackLogicalTurnClaim(
    streamId: string,
    interactionContext: InteractionContext,
  ): Promise<boolean>;

  /** Fence any older claimed stream slots after this revision's job is durably admitted. */
  fenceSupersededLogicalTurnClaims?(claim: LogicalTurnClaim): Promise<void>;

  /** Remove only a source-event receipt that points at a confirmed missing owner job. */
  forgetMissingSourceEventReceipt(
    interactionContext: InteractionContext,
    expectedStreamId: string,
  ): Promise<boolean>;

  /** Release the active revision only when the supplied stream still owns it. */
  completeLogicalTurn(streamId: string, expected?: NativeResponseIdentity): Promise<void>;

  /** Whether this stream is still the latest revision of its logical turn. */
  isCurrentLogicalTurn(streamId: string): Promise<boolean>;

  /** Resolve revision ownership from the server-held logical-turn index. */
  resolveDeliveryOwner(logicalTurnId: string, revision: number): Promise<string | null>;

  /** Record the current presentation outcome using server-held logical-turn ownership. */
  acknowledgeDelivery(
    acknowledgement: InteractionDeliveryAck,
  ): Promise<DeliveryAcknowledgementResult>;
  /* === VIVENTIUM END === */

  /** Get a job by streamId (streamId === conversationId) */
  getJob(streamId: string): Promise<SerializableJobData | null>;

  /** Update job data */
  updateJob(
    streamId: string,
    updates: Partial<SerializableJobData>,
    expectedNativeIdentity?: NativeResponseIdentity,
  ): Promise<void>;

  /** Monotonically bind one server-authorized Cortex presentation to this stream. */
  bindCortexPresentation(streamId: string, binding: CortexPresentationBinding): Promise<boolean>;

  /** Bind Main or a separately fenced Cortex acknowledgement to the exact current job state. */
  bindDeliveryAcknowledgement(
    streamId: string,
    acknowledgement: InteractionDeliveryAck,
    expectedCortexPresentation: CortexPresentationBinding | null,
  ): Promise<DeliveryAcknowledgementBindingResult>;

  bindNativeResponse(identity: NativeResponseIdentity): Promise<boolean>;
  commitNativeResponse(
    identity: NativeResponseIdentity,
    candidateSha256: string,
  ): Promise<NativeResponseCommit>;
  settleNativeResponse(
    identity: NativeResponseIdentity,
    mode?: 'unsupported' | 'cancelled',
  ): Promise<boolean>;
  getNativeResponseCommit(identity: NativeResponseIdentity): Promise<NativeResponseCommit>;
  revokeNativeResponse(identity: NativeResponseIdentity): Promise<NativeResponseCommit>;
  cancelNativeResponse(job: SerializableJobData): Promise<NativeResponseCommit>;
  finishNativeResponse(
    identity: NativeResponseIdentity,
    candidateSha256: string,
    finalEvent: string,
    mode?: 'cancelled',
  ): Promise<boolean>;

  /** Delete a job */
  deleteJob(streamId: string, retiredNativeResponse?: NativeResponseIdentity): Promise<void>;

  /** Check if job exists */
  hasJob(streamId: string): Promise<boolean>;

  /** Get all running jobs (for cleanup) */
  getRunningJobs(): Promise<SerializableJobData[]>;

  /** Cleanup expired jobs */
  cleanup(): Promise<number>;

  /** Get total job count */
  getJobCount(): Promise<number>;

  /** Get job count by status */
  getJobCountByStatus(status: JobStatus): Promise<number>;

  /** Destroy the store and release resources */
  destroy(): Promise<void>;

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Also performs self-healing cleanup of stale entries.
   *
   * @param userId - The user ID to query
   * @returns Array of conversation IDs with active jobs
   */
  getActiveJobIdsByUser(userId: string): Promise<string[]>;

  // ===== Content State Methods =====
  // These methods manage volatile content state tied to each job.
  // In-memory: Uses WeakRef to graph for live access
  // Redis: Persists chunks and reconstructs on demand

  /**
   * Set the graph reference for a job (in-memory only).
   * The graph provides live access to contentParts and contentData (run steps).
   *
   * In-memory: Stores WeakRef to graph
   * Redis: No-op (graph not transferable, uses chunks instead)
   *
   * @param streamId - The stream identifier
   * @param graph - The StandardGraph instance
   */
  setGraph(streamId: string, graph: StandardGraph): void;

  /**
   * Set content parts reference for a job.
   *
   * In-memory: Stores direct reference to content array
   * Redis: No-op (content built from chunks)
   *
   * @param streamId - The stream identifier
   * @param contentParts - The content parts array
   */
  setContentParts(streamId: string, contentParts: Agents.MessageContentComplex[]): void;

  /**
   * Get aggregated content for a job.
   *
   * In-memory: Returns live content from graph.contentParts or stored reference
   * Redis: Reconstructs from stored chunks
   *
   * @param streamId - The stream identifier
   * @returns Content parts or null if not available
   */
  getContentParts(streamId: string): Promise<{
    content: Agents.MessageContentComplex[];
  } | null>;

  /**
   * Get run steps for a job (for resume state).
   *
   * In-memory: Returns live run steps from graph.contentData
   * Redis: Fetches from persistent storage
   *
   * @param streamId - The stream identifier
   * @returns Run steps or empty array
   */
  getRunSteps(streamId: string): Promise<Agents.RunStep[]>;

  /**
   * Append a streaming chunk for later reconstruction.
   *
   * In-memory: No-op (content available via graph reference)
   * Redis: Uses XADD for append-only log efficiency
   *
   * @param streamId - The stream identifier
   * @param event - The SSE event to append
   */
  appendChunk(streamId: string, event: unknown): Promise<void>;

  /**
   * Clear all content state for a job.
   * Called on job completion/cleanup.
   *
   * @param streamId - The stream identifier
   */
  clearContentState(streamId: string): void;

  /**
   * Save run steps to persistent storage.
   * In-memory: No-op (run steps accessed via graph reference)
   * Redis: Persists for resume across instances
   *
   * @param streamId - The stream identifier
   * @param runSteps - Run steps to save
   */
  saveRunSteps?(streamId: string, runSteps: Agents.RunStep[]): Promise<void>;

  /**
   * Set collected usage reference for a job.
   * This array accumulates token usage from all models during generation.
   *
   * @param streamId - The stream identifier
   * @param collectedUsage - Array of usage metadata from all models
   */
  setCollectedUsage(streamId: string, collectedUsage: UsageMetadata[]): void;

  /**
   * Get collected usage for a job.
   *
   * @param streamId - The stream identifier
   * @returns Array of usage metadata or empty array
   */
  getCollectedUsage(streamId: string): UsageMetadata[];
}

/**
 * Interface for pub/sub event transport.
 * Implementations can use EventEmitter, Redis Pub/Sub, etc.
 */
export interface IEventTransport {
  /** Subscribe to events for a stream. `ready` resolves once the transport can receive messages. */
  subscribe(
    streamId: string,
    handlers: {
      onChunk: (event: unknown) => void;
      onDone?: (event: unknown, nativeJobProof?: string) => void;
      onError?: (error: string) => void;
    },
  ): { unsubscribe: () => void; ready?: Promise<void> };

  /** Publish a chunk event and report whether a transport accepted it. */
  emitChunk(
    streamId: string,
    event: unknown,
    options?: EventTransportEmitOptions,
  ): EventTransportPublishReceipt | void | Promise<EventTransportPublishReceipt | void>;

  /** Publish a done event - returns Promise in Redis mode for ordered delivery */
  emitDone(
    streamId: string,
    event: unknown,
    nativeReplay?: NativeResponseReplayGuard,
  ): void | boolean | Promise<void | boolean>;

  /** Publish an error event - returns Promise in Redis mode for ordered delivery */
  emitError(streamId: string, error: string): void | Promise<void>;

  /**
   * Publish an abort signal to all replicas (Redis mode).
   * Enables cross-replica abort: user aborts on Replica B,
   * generating Replica A receives signal and stops.
   * Optional - only implemented in Redis transport.
   */
  /* === VIVENTIUM START ===
   * Feature: Exact stream supersession.
   * Purpose: Carry a typed internal abort reason without widening public stream authority.
   */
  emitAbort?(
    streamId: string,
    reason?: string,
    nativeReplay?: NativeResponseReplayGuard,
  ): void | boolean | Promise<void | boolean>;
  /* === VIVENTIUM END === */

  /**
   * Register callback for abort signals from any replica (Redis mode).
   * Called when abort is triggered from any replica.
   * Optional - only implemented in Redis transport.
   */
  /* === VIVENTIUM START ===
   * Feature: Exact stream supersession.
   * Purpose: Propagate the internal abort reason to the exact stream subscriber.
   */
  onAbort?(
    streamId: string,
    callback: (reason?: string, nativeJobProof?: string) => void,
  ): void | Promise<void>;
  /* === VIVENTIUM END === */

  /** Get subscriber count for a stream */
  getSubscriberCount(streamId: string): number;

  /** Check if this is the first subscriber (for ready signaling) */
  isFirstSubscriber(streamId: string): boolean;

  /** Listen for all subscribers leaving */
  onAllSubscribersLeft(streamId: string, callback: () => void): void;

  /** Reset publish sequence counter for a stream (used during full stream cleanup) */
  resetSequence?(streamId: string): void;

  /** Advance subscriber reorder buffer to match publisher sequence (cross-replica safe: doesn't reset publisher counter) */
  syncReorderBuffer?(streamId: string): void;

  /** Cleanup transport resources for a specific stream */
  cleanup(streamId: string): void | Promise<void>;

  /** Get all tracked stream IDs (for orphan cleanup) */
  getTrackedStreamIds(): string[];

  /** Destroy all transport resources */
  destroy(): void | Promise<void>;
}

/* === VIVENTIUM START ===
 * Feature: Exact Web presentation receipts.
 * Purpose: Require proof that a presentation handler accepted the exact event when durable replay is unavailable.
 * === VIVENTIUM END === */
export interface EventTransportEmitOptions {
  requirePresentationAcknowledgement?: boolean;
  presentationAcknowledgementTimeoutMs?: number;
}

export interface NativeResponseReplayGuard {
  identity: NativeResponseIdentity;
  isCurrent: () => boolean;
  cancelled?: boolean;
  finalEvent?: string;
}

export interface EventTransportPublishReceipt {
  published: boolean;
  subscriberCount: number;
  presentationAcknowledged?: boolean;
}
