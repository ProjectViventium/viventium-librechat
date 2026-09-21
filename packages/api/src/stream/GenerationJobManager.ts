import { logger } from '@librechat/data-schemas';
import type {
  IMessage,
  NativeResponseIdentity,
  NativeResponseCommit,
  NativeResponseMessageProjection,
} from '@librechat/data-schemas';
import { nativePredecessorSupersession } from '../glasshive/nativeSupersession';
import type { NativeAcceptedSource } from '../glasshive/nativeSupersession';
import {
  nativeIdentityJson,
  nativeJobMatches,
  nativeJobProofJson,
} from './implementations/nativeResponse';
import type { StandardGraph } from '@librechat/agents';
import { parseTextParts } from 'librechat-data-provider';
import type { Agents, TMessageContentParts } from 'librechat-data-provider';
import type {
  SerializableJobData,
  IEventTransport,
  UsageMetadata,
  AbortResult,
  IJobStore,
  InteractionContext,
  LogicalTurnClaim,
  AdapterCapabilities,
  InteractionDeliveryAck,
  DeliveryAcknowledgementResult,
  InteractionDeliveryPolicy,
  ClientPresentation,
  EventTransportPublishReceipt,
  SourceOrderObservation,
  SourceOrderObservationResult,
  CortexPresentationBinding,
  CortexPresentationFenceReceipt,
  ChunkEmissionOptions,
} from './interfaces/IJobStore';
import type * as t from '~/types';
import { InMemoryEventTransport } from './implementations/InMemoryEventTransport';
import { InMemoryJobStore } from './implementations/InMemoryJobStore';
import { safeStreamLogError, streamLogRef } from './logPrivacy';

/**
 * Configuration options for GenerationJobManager
 */
export interface GenerationJobManagerOptions {
  jobStore?: IJobStore;
  eventTransport?: IEventTransport;
  /**
   * If true, cleans up event transport immediately when job completes.
   * If false, keeps EventEmitters until periodic cleanup for late reconnections.
   * Default: true (immediate cleanup to save memory)
   */
  cleanupOnComplete?: boolean;
}

export interface CreateGenerationJobOptions {
  interactionContext?: InteractionContext;
  adapterCapabilities?: AdapterCapabilities;
  deliveryPolicy?: InteractionDeliveryPolicy;
  clientPresentation?: ClientPresentation;
}

export type ChunkEmissionReceipt =
  | {
      delivered: true;
      streamId: string;
      target: 'subscriber_transport' | 'runtime_replay_buffer' | 'durable_replay_store';
      presentationRef?: string;
      claimToken?: string;
      presentationLeaseToken?: string;
    }
  | {
      delivered: false;
      streamId: string;
      reason: 'runtime_unavailable' | 'logical_turn_inactive' | 'presentation_unconfirmed';
    };

export interface DurableEffectReceiptInput {
  streamId: string;
  userId: string;
  sourceEventId: string;
  responseMessageId: string;
  effectKind: 'durable_work_accepted' | 'durable_work_action_accepted';
  effectRef: string;
}

function normalizeCortexPresentationReceipt(
  receipt: CortexPresentationFenceReceipt,
): CortexPresentationFenceReceipt | null {
  const ownerId = String(receipt?.ownerId || '').trim();
  const messageId = String(receipt?.messageId || '').trim();
  const parentMessageId = String(receipt?.parentMessageId || '').trim();
  const revision = Number(receipt?.revision);
  const generation = Number(receipt?.generation);
  const claimToken = String(receipt?.claimToken || '').trim();
  const presentationLeaseToken = String(receipt?.presentationLeaseToken || '').trim();
  const deliveryIds = [
    ...new Set(
      (Array.isArray(receipt?.deliveryIds) ? receipt.deliveryIds : [])
        .map((deliveryId) => String(deliveryId || '').trim())
        .filter(Boolean),
    ),
  ].sort();
  const deliveryReceipts = (
    Array.isArray(receipt?.deliveryReceipts) ? receipt.deliveryReceipts : []
  )
    .map((deliveryReceipt) => ({
      deliveryId: String(deliveryReceipt?.deliveryId || '').trim(),
      graphResultHash: String(deliveryReceipt?.graphResultHash || '')
        .trim()
        .toLowerCase(),
    }))
    .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
  if (
    !ownerId ||
    !messageId ||
    !parentMessageId ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !claimToken ||
    !presentationLeaseToken ||
    deliveryIds.length < 1 ||
    deliveryReceipts.length !== deliveryIds.length ||
    deliveryReceipts.some(
      (deliveryReceipt, index) =>
        deliveryReceipt.deliveryId !== deliveryIds[index] ||
        !/^[a-f0-9]{64}$/.test(deliveryReceipt.graphResultHash),
    )
  ) {
    return null;
  }
  return {
    ownerId,
    messageId,
    parentMessageId,
    revision,
    generation,
    deliveryIds,
    deliveryReceipts,
    claimToken,
    presentationLeaseToken,
  };
}

function cortexPresentationMatchesReceipt(
  binding: CortexPresentationBinding | undefined,
  receipt: CortexPresentationFenceReceipt,
): binding is CortexPresentationBinding {
  const normalized = normalizeCortexPresentationReceipt(receipt);
  return Boolean(
    binding &&
    normalized &&
    binding.ownerId === normalized.ownerId &&
    binding.messageId === normalized.messageId &&
    binding.parentMessageId === normalized.parentMessageId &&
    binding.revision === normalized.revision &&
    binding.generation === normalized.generation &&
    binding.claimToken === normalized.claimToken &&
    binding.presentationLeaseToken === normalized.presentationLeaseToken &&
    binding.deliveryIds.length === normalized.deliveryIds.length &&
    binding.deliveryIds.every(
      (deliveryId, index) => deliveryId === normalized.deliveryIds[index],
    ) &&
    binding.deliveryReceipts.length === normalized.deliveryReceipts.length &&
    binding.deliveryReceipts.every(
      (storedReceipt, index) =>
        storedReceipt.deliveryId === normalized.deliveryReceipts[index].deliveryId &&
        storedReceipt.graphResultHash === normalized.deliveryReceipts[index].graphResultHash,
    ),
  );
}

export const DURABLE_WORK_ACCEPTED_TEXT =
  'Background work started. Open Active Work to view or steer it.';
export const DURABLE_WORK_ACTION_ACCEPTED_TEXT =
  'Background work updated. Open Active Work to view or steer it.';

function durableEffectReceiptText(
  receipt: SerializableJobData['durableEffectReceipt'] | undefined,
): string {
  return receipt?.effect_kind === 'durable_work_action_accepted'
    ? DURABLE_WORK_ACTION_ACCEPTED_TEXT
    : DURABLE_WORK_ACCEPTED_TEXT;
}

function buildDurableWorkReceiptFinalEvent(
  job: SerializableJobData,
  responseMessageId: string,
  receipt = job.durableEffectReceipt,
): t.ServerSentEvent {
  const receiptText = durableEffectReceiptText(receipt);
  return {
    final: true,
    conversation: { conversationId: job.conversationId },
    title: 'New Chat',
    requestMessage: job.userMessage
      ? {
          ...job.userMessage,
          conversationId: job.conversationId,
          isCreatedByUser: true,
        }
      : null,
    responseMessage: {
      messageId: responseMessageId,
      parentMessageId: job.userMessage?.messageId,
      conversationId: job.conversationId,
      text: receiptText,
      content: [
        {
          type: 'text',
          text: { value: receiptText },
        },
      ],
      sender: job.sender ?? 'AI',
      unfinished: true,
      error: false,
      isCreatedByUser: false,
    },
  } as unknown as t.ServerSentEvent;
}

function parseStoredFinalEvent(job: SerializableJobData): Record<string, unknown> | null {
  if (!job.finalEvent) {
    return null;
  }
  try {
    return (
      typeof job.finalEvent === 'string' ? JSON.parse(job.finalEvent) : job.finalEvent
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function hasDurableWorkReceiptFinalEvent(job: SerializableJobData): boolean {
  const finalEvent = parseStoredFinalEvent(job);
  const responseMessage = finalEvent?.responseMessage as Record<string, unknown> | undefined;
  return [DURABLE_WORK_ACCEPTED_TEXT, DURABLE_WORK_ACTION_ACCEPTED_TEXT].includes(
    String(responseMessage?.text || ''),
  );
}

function hasResponseOnlySupersededFinalEvent(job: SerializableJobData): boolean {
  if (hasDurableWorkReceiptFinalEvent(job)) {
    return true;
  }
  const finalEvent = parseStoredFinalEvent(job);
  return (
    finalEvent?.final === true &&
    finalEvent?.superseded === true &&
    finalEvent?.logical_turn_id === job.interactionContext?.logical_turn_id &&
    finalEvent?.revision === job.interactionContext?.revision
  );
}

/* === VIVENTIUM START ===
 * Feature: Durable source-event idempotency.
 * Purpose: A retry must not erase the first creator's receipt during its claim-to-job window.
 * === VIVENTIUM END === */
function streamCreationPendingError(): Error & { code: string } {
  return Object.assign(new Error('Generation stream creation is still pending'), {
    code: 'stream_creation_pending',
  });
}

/* === VIVENTIUM START ===
 * Feature: Owner-safe duplicate stream recovery.
 * Purpose: A stale or forged receipt must never return another owner's persisted generation.
 * === VIVENTIUM END === */
function streamReceiptConflictError(): Error & { code: string } {
  return Object.assign(new Error('Generation stream receipt ownership does not match'), {
    code: 'stream_id_conflict',
  });
}

function sourceOrderSupersededError(): Error & { code: string } {
  return Object.assign(new Error('A newer ordered source event is already current'), {
    code: 'source_order_superseded',
  });
}

function sourceOrderObservationFromContext(
  context: InteractionContext | undefined,
): SourceOrderObservation | undefined {
  if (
    !context?.source_order_scope ||
    !/^[a-f0-9]{64}$/.test(context.source_order_scope) ||
    !Number.isSafeInteger(context.source_sequence) ||
    context.source_sequence! < 0
  ) {
    return undefined;
  }
  return {
    source_order_scope: context.source_order_scope,
    source_sequence: context.source_sequence!,
  };
}

function streamManagerUnavailableError(): Error & { code: string } {
  return Object.assign(new Error('Generation stream manager is unavailable'), {
    code: 'stream_store_unavailable',
  });
}

/* === VIVENTIUM START ===
 * Feature: Stream-manager lifecycle fencing.
 * Purpose: Shutdown must cancel a transport handshake instead of waiting forever on old state.
 */
const LIFECYCLE_ABORTED = Symbol('lifecycle_aborted');
const lifecycleAbortPromises = new WeakMap<AbortSignal, Promise<typeof LIFECYCLE_ABORTED>>();

function lifecycleAbortPromise(signal: AbortSignal): Promise<typeof LIFECYCLE_ABORTED> {
  const existing = lifecycleAbortPromises.get(signal);
  if (existing) {
    return existing;
  }
  const created = signal.aborted
    ? Promise.resolve(LIFECYCLE_ABORTED)
    : new Promise<typeof LIFECYCLE_ABORTED>((resolve) => {
        signal.addEventListener('abort', () => resolve(LIFECYCLE_ABORTED), { once: true });
      });
  lifecycleAbortPromises.set(signal, created);
  return created;
}

async function awaitLifecycle<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw streamManagerUnavailableError();
  }
  const result = await Promise.race([Promise.resolve(value), lifecycleAbortPromise(signal)]);
  if (result === LIFECYCLE_ABORTED) {
    throw streamManagerUnavailableError();
  }
  return result as T;
}
/* === VIVENTIUM END === */

/**
 * Runtime state for active jobs - not serializable, kept in-memory per instance.
 * Contains AbortController, ready promise, and other non-serializable state.
 *
 * @property abortController - Controller to abort the generation
 * @property readyPromise - Resolves immediately (legacy, kept for API compatibility)
 * @property resolveReady - Function to resolve readyPromise
 * @property finalEvent - Cached final event for late subscribers
 * @property errorEvent - Cached error event for late subscribers (errors before client connects)
 * @property syncSent - Whether sync event was sent (reset when all subscribers leave)
 * @property earlyEventBuffer - Buffer for events emitted before first subscriber connects
 * @property hasSubscriber - Whether at least one subscriber has connected
 * @property allSubscribersLeftHandlers - Internal handlers for disconnect events.
 *   These are stored separately from eventTransport subscribers to avoid being counted
 *   in subscriber count. This is critical: if these were registered via subscribe(),
 *   they would count as subscribers, causing isFirstSubscriber() to return false
 *   when the real client connects, which would prevent readyPromise from resolving.
 */
interface RuntimeJobState {
  nativeProducer?: { createdAt: number; responseMessageId?: string };
  abortController: AbortController;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  finalEvent?: t.ServerSentEvent;
  errorEvent?: string;
  syncSent: boolean;
  earlyEventBuffer: t.ServerSentEvent[];
  hasSubscriber: boolean;
  allSubscribersLeftHandlers?: Array<(...args: unknown[]) => void>;
  /** Main is terminal; only an exact, fenced Phase B presentation may still use this runtime. */
  presentationOnly?: boolean;
  /** Shared readiness for a lazily-created cross-replica runtime. */
  initializationReady?: Promise<void>;
}

/* === VIVENTIUM START ===
 * Feature: Stream-manager lifecycle fencing.
 * Purpose: Bind every lazy cross-replica hydration to one exact service generation.
 */
interface ManagerLifecycleSnapshot {
  epoch: number;
  jobStore: IJobStore;
  eventTransport: IEventTransport;
  signal: AbortSignal;
  isRedis: boolean;
  cleanupOnComplete: boolean;
}

interface ServiceGenerationSnapshot {
  generation: number;
  jobStore: IJobStore;
  eventTransport: IEventTransport;
  cleanupOnComplete: boolean;
  isRedis: boolean;
}
/* === VIVENTIUM END === */

/**
 * Manages generation jobs for resumable LLM streams.
 *
 * Architecture: Composes two pluggable services via dependency injection:
 * - jobStore: Job metadata + content state (InMemory → Redis for horizontal scaling)
 * - eventTransport: Pub/sub events (InMemory → Redis Pub/Sub for horizontal scaling)
 *
 * Content state is tied to jobs:
 * - In-memory: jobStore holds WeakRef to graph for live content/run steps access
 * - Redis: jobStore persists chunks, reconstructs content on demand
 *
 * All storage methods are async to support both in-memory and external stores (Redis, etc.).
 *
 * @example Redis injection:
 * ```ts
 * const manager = new GenerationJobManagerClass({
 *   jobStore: new RedisJobStore(redisClient),
 *   eventTransport: new RedisPubSubTransport(redisClient),
 * });
 * ```
 */
class GenerationJobManagerClass {
  /* === VIVENTIUM START ===
   * Purpose: Lock configuration from first service use until asynchronous teardown settles.
   */
  /** Job metadata + content state storage - swappable for Redis, etc. */
  private _jobStore: IJobStore;
  /** Event pub/sub transport - swappable for Redis Pub/Sub, etc. */
  private _eventTransport: IEventTransport;
  private lifecycleState:
    'configurable' | 'active' | 'destroying' | 'destroyed' | 'teardown-failed' = 'configurable';

  private destroyPromise?: Promise<void>;
  private serviceGeneration = 0;
  private readonly hasInjectedInitialServices: boolean;

  private markActive(): void {
    if (this.lifecycleState === 'configurable' || this.lifecycleState === 'active') {
      this.lifecycleState = 'active';
      return;
    }
    throw streamManagerUnavailableError();
  }

  private get jobStore(): IJobStore {
    this.markActive();
    return this._jobStore;
  }

  private get eventTransport(): IEventTransport {
    this.markActive();
    return this._eventTransport;
  }

  private serviceGenerationChangedError(): Error & { code: string } {
    return Object.assign(
      new Error('[GenerationJobManager] Operation rejected because service generation changed'),
      { code: 'stream_store_unavailable' },
    );
  }
  /* === VIVENTIUM END === */

  /** Runtime state - always in-memory, not serializable */
  private runtimeState = new Map<string, RuntimeJobState>();

  private cleanupInterval: NodeJS.Timeout | null = null;
  /* === VIVENTIUM START === Stream readiness is a traffic-admission prerequisite. === */
  private initializationPromise: Promise<void> | null = null;
  /* === VIVENTIUM END === */

  /** Whether we're using Redis stores */
  private _isRedis = false;

  /** Whether to cleanup event transport immediately on job completion */
  private _cleanupOnComplete = true;
  private lifecycleEpoch = 0;
  private pendingAdmissions = 0;
  private unavailable = false;
  private lifecycleAbortController = new AbortController();
  private nativeResponseRecovery?: (identity: NativeResponseIdentity) => Promise<boolean>;
  private nativeResponseCancellation?: (
    identity: NativeResponseIdentity,
    snapshot: NativeResponseMessageProjection,
    mode?: 'augmentation' | 'published',
  ) => Promise<Partial<IMessage> | null>;

  /* === VIVENTIUM START ===
   * Feature: Stream-manager lifecycle fencing.
   * Purpose: Old asynchronous reads may only observe and clean up their captured services.
   */
  private captureLifecycle(): ManagerLifecycleSnapshot {
    this.markActive();
    return {
      epoch: this.lifecycleEpoch,
      jobStore: this._jobStore,
      eventTransport: this._eventTransport,
      signal: this.lifecycleAbortController.signal,
      isRedis: this._isRedis,
      cleanupOnComplete: this._cleanupOnComplete,
    };
  }

  private captureServices(): ServiceGenerationSnapshot {
    this.markActive();
    return {
      generation: this.serviceGeneration,
      jobStore: this._jobStore,
      eventTransport: this._eventTransport,
      cleanupOnComplete: this._cleanupOnComplete,
      isRedis: this._isRedis,
    };
  }

  private assertServiceGeneration(generation: number): void {
    if (generation !== this.serviceGeneration) {
      throw this.serviceGenerationChangedError();
    }
  }

  private isLifecycleCurrent(lifecycle: ManagerLifecycleSnapshot): boolean {
    return (
      !this.unavailable &&
      !lifecycle.signal.aborted &&
      lifecycle.epoch === this.lifecycleEpoch &&
      lifecycle.jobStore === this._jobStore &&
      lifecycle.eventTransport === this._eventTransport
    );
  }

  private async awaitRuntimeInitialization(
    streamId: string,
    runtime: RuntimeJobState,
    lifecycle: ManagerLifecycleSnapshot,
  ): Promise<RuntimeJobState> {
    if (runtime.initializationReady) {
      await runtime.initializationReady;
    }
    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    return runtime;
  }

  private assertLifecycleOperation(
    lifecycle: ManagerLifecycleSnapshot,
    streamId?: string,
    expectedRuntime: RuntimeJobState | undefined | null = null,
  ): void {
    if (
      lifecycle.epoch !== this.lifecycleEpoch ||
      lifecycle.jobStore !== this._jobStore ||
      lifecycle.eventTransport !== this._eventTransport
    ) {
      throw this.serviceGenerationChangedError();
    }
    if (
      !this.isLifecycleCurrent(lifecycle) ||
      (streamId !== undefined &&
        expectedRuntime !== null &&
        this.runtimeState.get(streamId) !== expectedRuntime)
    ) {
      throw streamManagerUnavailableError();
    }
  }

  private async runLifecycleOperation<T>(
    lifecycle: ManagerLifecycleSnapshot,
    operation: () => T | PromiseLike<T>,
    streamId?: string,
    expectedRuntime: RuntimeJobState | undefined | null = null,
  ): Promise<T> {
    this.assertLifecycleOperation(lifecycle, streamId, expectedRuntime);
    const result = await operation();
    this.assertLifecycleOperation(lifecycle, streamId, expectedRuntime);
    return result;
  }
  /* === VIVENTIUM END === */

  constructor(options?: GenerationJobManagerOptions) {
    this.hasInjectedInitialServices = Boolean(options?.jobStore || options?.eventTransport);
    this._jobStore =
      options?.jobStore ?? new InMemoryJobStore({ ttlAfterComplete: 0, maxJobs: 1000 });
    this._eventTransport = options?.eventTransport ?? new InMemoryEventTransport();
    this._cleanupOnComplete = options?.cleanupOnComplete ?? true;
  }

  /* === VIVENTIUM START ===
   * Feature: Stream readiness before traffic admission.
   * Purpose: Make store initialization awaitable and block destructive reconfiguration while it runs.
   */
  /**
   * Initialize the job manager with periodic cleanup.
   * Call this once at application startup.
   */
  async initialize(): Promise<void> {
    if (this.cleanupInterval) {
      return this.initializationPromise ?? Promise.resolve();
    }
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    const lifecycle = this.captureLifecycle();
    const initialization = (async () => {
      await this.runLifecycleOperation(lifecycle, () => lifecycle.jobStore.initialize());
      this.cleanupInterval = setInterval(() => {
        void this.cleanup().catch((error: { code?: string }) => {
          if (error?.code !== 'stream_store_unavailable') {
            logger.warn('[GenerationJobManager] Periodic cleanup unavailable');
          }
        });
      }, 60000);
      this.cleanupInterval.unref?.();
      logger.debug('[GenerationJobManager] Initialized');
    })();
    this.initializationPromise = initialization;
    try {
      await initialization;
    } finally {
      if (this.initializationPromise === initialization) {
        this.initializationPromise = null;
      }
    }
  }

  /**
   * Configure the manager with custom stores.
   * Call this BEFORE initialize() to use Redis or other stores.
   *
   * @example Using Redis
   * ```ts
   * import { createStreamServicesFromCache } from '~/stream/createStreamServices';
   * import { cacheConfig, ioredisClient } from '~/cache';
   *
   * const services = createStreamServicesFromCache({ cacheConfig, ioredisClient });
   * GenerationJobManager.configure(services);
   * await GenerationJobManager.initialize();
   * ```
   */
  configure(services: {
    jobStore: IJobStore;
    eventTransport: IEventTransport;
    isRedis?: boolean;
    cleanupOnComplete?: boolean;
  }): void {
    const replacesIdleInjectedServices =
      this.lifecycleState === 'active' &&
      this.hasInjectedInitialServices &&
      this.pendingAdmissions === 0 &&
      this.runtimeState.size === 0 &&
      this.initializationPromise == null;
    if (
      this.lifecycleState !== 'configurable' &&
      this.lifecycleState !== 'destroyed' &&
      !replacesIdleInjectedServices
    ) {
      throw streamManagerUnavailableError();
    }
    const wasInitialized = this.cleanupInterval != null;
    const previousJobStore = this._jobStore;
    const previousEventTransport = this._eventTransport;
    if (replacesIdleInjectedServices && this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.lifecycleAbortController.abort('manager_reconfigured');
    this.lifecycleAbortController = new AbortController();
    this.lifecycleEpoch += 1;
    for (const runtime of this.runtimeState.values()) {
      if (!runtime.abortController.signal.aborted) {
        runtime.abortController.abort('manager_reconfigured');
      }
    }
    this.runtimeState.clear();
    this.runStepBuffers?.clear();

    this._jobStore = services.jobStore;
    this._eventTransport = services.eventTransport;
    this._isRedis = services.isRedis ?? false;
    this._cleanupOnComplete = services.cleanupOnComplete ?? true;
    this.unavailable = false;
    this.lifecycleState = 'configurable';
    this.destroyPromise = undefined;
    this.serviceGeneration += 1;

    if (replacesIdleInjectedServices) {
      if (previousEventTransport !== services.eventTransport) {
        void Promise.resolve(previousEventTransport.destroy()).catch((error) => {
          logger.error(
            '[GenerationJobManager] Previous event transport destroy failed',
            safeStreamLogError(error),
          );
        });
      }
      if (previousJobStore !== services.jobStore) {
        void previousJobStore.destroy().catch((error) => {
          logger.error(
            '[GenerationJobManager] Previous job store destroy failed',
            safeStreamLogError(error),
          );
        });
      }
      if (wasInitialized) {
        void this.initialize().catch((error) => {
          logger.error('[GenerationJobManager] Reinitialization failed', safeStreamLogError(error));
        });
      }
    }

    logger.info(
      `[GenerationJobManager] Configured with ${this._isRedis ? 'Redis' : 'in-memory'} stores`,
    );
  }
  /* === VIVENTIUM END === */

  /**
   * Check if using Redis stores.
   */
  get isRedis(): boolean {
    return this._isRedis;
  }

  /**
   * Get the job store instance (for advanced use cases).
   */
  getJobStore(): IJobStore {
    return this.jobStore;
  }

  /* === VIVENTIUM START ===
   * Feature: Restart-safe Cortex presentation binding.
   * Purpose: Bind only the real current owner/generation/hash claim to its durable stream job.
   */
  /** Bind a current owner-scoped Cortex claim receipt to its durable stream job. */
  async bindCortexPresentation(
    streamId: string,
    receipt: CortexPresentationFenceReceipt,
  ): Promise<CortexPresentationBinding | null> {
    const lifecycle = this.captureLifecycle();
    const ownerId = String(receipt?.ownerId || '').trim();
    const messageId = String(receipt?.messageId || '').trim();
    const parentMessageId = String(receipt?.parentMessageId || '').trim();
    const revision = Number(receipt?.revision);
    const generation = Number(receipt?.generation);
    const claimToken = String(receipt?.claimToken || '').trim();
    const presentationLeaseToken = String(receipt?.presentationLeaseToken || '').trim();
    const deliveryIds = [
      ...new Set(
        (Array.isArray(receipt?.deliveryIds) ? receipt.deliveryIds : [])
          .map((deliveryId) => String(deliveryId || '').trim())
          .filter(Boolean),
      ),
    ].sort();
    const deliveryReceipts = (
      Array.isArray(receipt?.deliveryReceipts) ? receipt.deliveryReceipts : []
    )
      .map((deliveryReceipt) => ({
        deliveryId: String(deliveryReceipt?.deliveryId || '').trim(),
        graphResultHash: String(deliveryReceipt?.graphResultHash || '')
          .trim()
          .toLowerCase(),
      }))
      .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
    const exactReceipt =
      ownerId !== '' &&
      messageId !== '' &&
      parentMessageId !== '' &&
      Number.isSafeInteger(revision) &&
      revision > 0 &&
      Number.isSafeInteger(generation) &&
      generation > 0 &&
      claimToken !== '' &&
      presentationLeaseToken !== '' &&
      deliveryIds.length > 0 &&
      deliveryReceipts.length === deliveryIds.length &&
      deliveryReceipts.every(
        (deliveryReceipt, index) =>
          deliveryReceipt.deliveryId === deliveryIds[index] &&
          /^[a-f0-9]{64}$/.test(deliveryReceipt.graphResultHash),
      );
    if (!exactReceipt) return null;

    const ownerJob = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      null,
    );
    if (
      !ownerJob ||
      ownerJob.userId !== ownerId ||
      ownerJob.responseMessageId !== parentMessageId
    ) {
      return null;
    }
    const binding: CortexPresentationBinding = {
      ownerId,
      messageId,
      parentMessageId,
      revision,
      generation,
      deliveryIds,
      deliveryReceipts,
      claimToken,
      presentationLeaseToken,
      boundAt: Date.now(),
    };
    const bound = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.bindCortexPresentation(streamId, binding),
      streamId,
      null,
    );
    if (!bound) return null;
    const stored = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      null,
    );
    const storedBinding = stored?.cortexPresentation;
    if (
      !storedBinding ||
      storedBinding.ownerId !== ownerId ||
      storedBinding.messageId !== messageId ||
      storedBinding.parentMessageId !== parentMessageId ||
      storedBinding.revision !== revision ||
      storedBinding.generation !== generation ||
      storedBinding.claimToken !== claimToken ||
      storedBinding.presentationLeaseToken !== presentationLeaseToken ||
      storedBinding.deliveryReceipts.length !== deliveryReceipts.length ||
      storedBinding.deliveryReceipts.some(
        (storedReceipt, index) =>
          storedReceipt.deliveryId !== deliveryReceipts[index].deliveryId ||
          storedReceipt.graphResultHash !== deliveryReceipts[index].graphResultHash,
      )
    ) {
      return null;
    }
    return storedBinding;
  }
  /* === VIVENTIUM END === */

  /* VIVENTIUM START: native finalization uses saved Message evidence before replay. */
  setNativeResponseRecovery(handler: (identity: NativeResponseIdentity) => Promise<boolean>): void {
    this.nativeResponseRecovery = handler;
  }

  setNativeResponseCancellation(
    handler: NonNullable<GenerationJobManagerClass['nativeResponseCancellation']>,
  ): void {
    this.nativeResponseCancellation = handler;
  }

  hasLocalNativeResponseProducer(identity: NativeResponseIdentity): boolean {
    const producer = this.runtimeState.get(identity.streamId)?.nativeProducer;
    return Boolean(
      producer &&
      producer.createdAt === identity.jobCreatedAt &&
      producer.responseMessageId === identity.responseMessageId,
    );
  }

  async getNativePredecessorSupersession(
    context: Pick<
      NativeResponseIdentity,
      | 'streamId'
      | 'jobCreatedAt'
      | 'userId'
      | 'conversationId'
      | 'responseMessageId'
      | 'logicalTurnId'
      | 'revision'
    >,
    sources: NativeAcceptedSource[],
  ) {
    const services = this.captureServices();
    try {
      const current = await services.jobStore.getJob(context.streamId);
      if (
        !current ||
        current.createdAt !== context.jobCreatedAt ||
        current.userId !== context.userId ||
        current.conversationId !== context.conversationId ||
        current.responseMessageId !== context.responseMessageId ||
        current.interactionContext?.logical_turn_id !== context.logicalTurnId ||
        current.interactionContext?.revision !== context.revision ||
        !current.nativePredecessor
      )
        return undefined;
      const previous = await services.jobStore.getJob(current.nativePredecessor.streamId);
      this.assertServiceGeneration(services.generation);
      return nativePredecessorSupersession(current, previous, sources);
    } catch {
      return undefined;
    }
  }

  async retainNativeAcceptedSources(
    identity: NativeResponseIdentity,
    sources: NativeAcceptedSource[],
  ): Promise<void> {
    const services = this.captureServices();
    try {
      const job = await services.jobStore.getJob(identity.streamId);
      if (
        !job ||
        !nativeJobMatches(job, identity) ||
        job.nativeResponse?.invocationId !== identity.invocationId
      )
        return;
      this.assertServiceGeneration(services.generation);
      await services.jobStore.updateJob(identity.streamId, {
        nativeAcceptedSources: { invocationId: identity.invocationId, sources },
      });
      this.assertServiceGeneration(services.generation);
    } catch {
      /* Optional continuity proof: absent evidence keeps branch replay fail-closed. */
    }
  }

  async bindNativeResponse(identity: NativeResponseIdentity): Promise<boolean> {
    const services = this.captureServices();
    try {
      const bound = await services.jobStore.bindNativeResponse(identity);
      this.assertServiceGeneration(services.generation);
      const producer = this.runtimeState.get(identity.streamId)?.nativeProducer;
      if (bound && producer?.createdAt === identity.jobCreatedAt) {
        producer.responseMessageId = identity.responseMessageId;
      }
      return bound;
    } catch {
      this.assertServiceGeneration(services.generation);
      logger.error('[GenerationJobManager] Native admission authority unavailable');
      return false;
    }
  }

  async commitNativeResponse(
    identity: NativeResponseIdentity,
    candidateSha256: string,
  ): Promise<NativeResponseCommit> {
    const services = this.captureServices();
    try {
      const result = await services.jobStore.commitNativeResponse(identity, candidateSha256);
      this.assertServiceGeneration(services.generation);
      return result;
    } catch {
      this.assertServiceGeneration(services.generation);
      logger.error('[GenerationJobManager] Native publication authority unavailable');
      return { status: 'unavailable' };
    }
  }

  async revokeNativeResponse(
    identity: NativeResponseIdentity,
    requireCurrent = false,
  ): Promise<NativeResponseCommit> {
    const services = this.captureServices();
    try {
      if (requireCurrent) {
        const job = await services.jobStore.getJob(identity.streamId);
        this.assertServiceGeneration(services.generation);
        if (
          !nativeJobMatches(job, identity) ||
          !job.nativeResponse ||
          job.nativeResponseFinished ||
          nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(identity)
        )
          return { status: 'unavailable' };
        const cancelled = await services.jobStore.cancelNativeResponse(job);
        this.assertServiceGeneration(services.generation);
        return cancelled;
      }
      const result = await services.jobStore.revokeNativeResponse(identity);
      this.assertServiceGeneration(services.generation);
      return result;
    } catch {
      this.assertServiceGeneration(services.generation);
      logger.error('[GenerationJobManager] Native revocation authority unavailable');
      return { status: 'unavailable' };
    }
  }

  async finishNativeResponse(
    identity: NativeResponseIdentity,
    finalEvent: t.ServerSentEvent,
    mode?: 'cancelled',
  ): Promise<boolean> {
    const services = this.captureServices();
    const receipt = await services.jobStore.getNativeResponseCommit(identity);
    this.assertServiceGeneration(services.generation);
    if (
      mode === 'cancelled'
        ? receipt.status !== 'revoked'
        : receipt.status !== 'committed' || !receipt.candidateSha256
    ) {
      return false;
    }
    const runtime = await this.getOrCreateRuntimeState(identity.streamId);
    this.assertServiceGeneration(services.generation);
    if (!runtime) return false;
    let acceptedEvent = finalEvent;
    const encoded = JSON.stringify(finalEvent);
    const saved = await services.jobStore.finishNativeResponse(
      identity,
      receipt.candidateSha256 || '',
      encoded,
      mode,
    );
    this.assertServiceGeneration(services.generation);
    if (!saved) {
      const job = await services.jobStore.getJob(identity.streamId);
      this.assertServiceGeneration(services.generation);
      if (
        !job?.nativeResponse ||
        Boolean(job.nativeResponseCancelled) !== (mode === 'cancelled') ||
        !job.nativeResponseFinished ||
        !job.finalEvent ||
        nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(identity)
      ) {
        return false;
      }
      acceptedEvent = JSON.parse(job.finalEvent) as t.ServerSentEvent;
    }
    const retained = await services.jobStore.getJob(identity.streamId);
    this.assertServiceGeneration(services.generation);
    if (
      !nativeJobMatches(retained, identity) ||
      !retained.nativeResponse ||
      nativeIdentityJson(retained.nativeResponse) !== nativeIdentityJson(identity) ||
      Boolean(retained.nativeResponseCancelled) !== (mode === 'cancelled')
    )
      return false;
    runtime.finalEvent = acceptedEvent;
    runtime.errorEvent = undefined;
    runtime.nativeProducer = undefined;
    const published = await services.eventTransport.emitDone(identity.streamId, acceptedEvent, {
      identity,
      ...(mode === 'cancelled' ? { cancelled: true, finalEvent: retained.finalEvent } : {}),
      isCurrent: () =>
        this.runtimeState.get(identity.streamId) === runtime &&
        identity.recoverUntil > Date.now() &&
        Boolean(retained.nativeResponseCancelled) === (mode === 'cancelled') &&
        retained.finalEvent === JSON.stringify(acceptedEvent),
    });
    this.assertServiceGeneration(services.generation);
    if (published === false && runtime.finalEvent === acceptedEvent) runtime.finalEvent = undefined;
    return published !== false;
  }

  /** Explicit assistant mutations retire delivery, without rewriting accepted publication history. */
  async retireNativeResponse(identity: NativeResponseIdentity): Promise<void> {
    const services = this.captureServices();
    const runtime = this.runtimeState.get(identity.streamId);
    const previous = await services.jobStore.getJob(identity.streamId);
    this.assertServiceGeneration(services.generation);
    if (
      previous &&
      (!previous.nativeResponse ||
        nativeIdentityJson(previous.nativeResponse) !== nativeIdentityJson(identity))
    )
      return;
    await services.jobStore.deleteJob(identity.streamId, identity);
    this.assertServiceGeneration(services.generation);
    const current = await services.jobStore.getJob(identity.streamId);
    this.assertServiceGeneration(services.generation);
    if (
      current?.nativeResponse &&
      nativeIdentityJson(current.nativeResponse) === nativeIdentityJson(identity)
    ) {
      throw new Error('native_response_retirement_rejected');
    }
    if (runtime && this.runtimeState.get(identity.streamId) === runtime) {
      runtime.finalEvent = undefined;
      runtime.errorEvent = undefined;
      runtime.nativeProducer = undefined;
      this.runtimeState.delete(identity.streamId);
      this.runStepBuffers?.delete(identity.streamId);
    }
  }

  async settleNativeResponse(
    identity: NativeResponseIdentity,
    mode?: 'unsupported' | 'cancelled',
  ): Promise<boolean> {
    const services = this.captureServices();
    const settled = await services.jobStore.settleNativeResponse(identity, mode);
    this.assertServiceGeneration(services.generation);
    if (settled && mode !== 'unsupported') {
      services.jobStore.clearContentState(identity.streamId);
      this.runStepBuffers?.delete(identity.streamId);
      await services.jobStore.completeLogicalTurn(identity.streamId, identity);
      this.assertServiceGeneration(services.generation);
      if (services.cleanupOnComplete) {
        await services.jobStore.deleteJob(identity.streamId, identity);
        this.assertServiceGeneration(services.generation);
        this.runtimeState.delete(identity.streamId);
      }
    }
    return settled;
  }
  /* VIVENTIUM END */

  /** Report whether source ordering survives process restart and replica changes. */
  getSourceOrderCapabilities(): {
    durability: 'process' | 'durable';
    replica_safe: boolean;
  } {
    const durability = this.jobStore.sourceOrderDurability ?? 'process';
    return { durability, replica_safe: durability === 'durable' };
  }

  async retainLogicalTurnInput(
    userId: string,
    context: InteractionContext,
  ): Promise<InteractionContext> {
    const services = this.captureServices();
    const retained = await services.jobStore.retainLogicalTurnInput(userId, context);
    this.assertServiceGeneration(services.generation);
    if (context.source_order_scope && context.source_sequence) {
      await this.observeSourceOrder({
        source_order_scope: context.source_order_scope,
        source_sequence: context.source_sequence,
      });
    }
    this.assertServiceGeneration(services.generation);
    return retained;
  }

  /** Advance or read the Core-held source watermark before any provider or presentation wait. */
  async observeSourceOrder(
    observation: SourceOrderObservation,
  ): Promise<SourceOrderObservationResult> {
    if (
      !/^[a-f0-9]{64}$/.test(observation.source_order_scope) ||
      !Number.isSafeInteger(observation.source_sequence) ||
      observation.source_sequence < 0
    ) {
      throw Object.assign(new Error('Invalid source order observation'), {
        code: 'invalid_source_order',
      });
    }
    const lifecycle = this.captureLifecycle();
    return this.runLifecycleOperation(lifecycle, () =>
      lifecycle.jobStore.observeSourceOrder(observation),
    );
  }

  /** Persist an adapter's terminal presentation outcome against server-held turn ownership. */
  async acknowledgeDelivery(
    acknowledgement: InteractionDeliveryAck,
    adapterSurface: 'telegram' | 'voice',
    expectedCortexPresentation?: CortexPresentationFenceReceipt,
  ): Promise<DeliveryAcknowledgementResult> {
    const lifecycle = this.captureLifecycle();
    const ownerStreamId = await this.runLifecycleOperation(lifecycle, () =>
      lifecycle.jobStore.resolveDeliveryOwner(
        acknowledgement.logical_turn_id,
        acknowledgement.revision,
      ),
    );
    const runtime = ownerStreamId ? this.runtimeState.get(ownerStreamId) : undefined;
    const ownerJob = ownerStreamId
      ? await this.runLifecycleOperation(
          lifecycle,
          () => lifecycle.jobStore.getJob(ownerStreamId),
          ownerStreamId,
          runtime,
        )
      : null;
    if (!ownerJob) {
      return { status: 'not_found' };
    }
    if (
      ownerJob.deliveryPolicy?.commit_authority !== 'external_adapter' ||
      ownerJob.interactionContext?.surface !== adapterSurface
    ) {
      return { status: 'conflict' };
    }
    const currentCortexPresentation = ownerJob.cortexPresentation;
    if (
      expectedCortexPresentation &&
      (!currentCortexPresentation ||
        currentCortexPresentation.ownerId !== expectedCortexPresentation.ownerId ||
        currentCortexPresentation.messageId !== expectedCortexPresentation.messageId ||
        currentCortexPresentation.parentMessageId !== expectedCortexPresentation.parentMessageId ||
        currentCortexPresentation.revision !== expectedCortexPresentation.revision ||
        currentCortexPresentation.generation !== expectedCortexPresentation.generation ||
        currentCortexPresentation.claimToken !== expectedCortexPresentation.claimToken ||
        currentCortexPresentation.presentationLeaseToken !==
          expectedCortexPresentation.presentationLeaseToken ||
        currentCortexPresentation.deliveryIds.length !==
          expectedCortexPresentation.deliveryIds.length ||
        currentCortexPresentation.deliveryIds.some(
          (deliveryId, index) => deliveryId !== expectedCortexPresentation.deliveryIds[index],
        ) ||
        currentCortexPresentation.deliveryReceipts.length !==
          expectedCortexPresentation.deliveryReceipts.length ||
        currentCortexPresentation.deliveryReceipts.some(
          (receipt, index) =>
            receipt.deliveryId !== expectedCortexPresentation.deliveryReceipts[index]?.deliveryId ||
            receipt.graphResultHash !==
              expectedCortexPresentation.deliveryReceipts[index]?.graphResultHash,
        ))
    ) {
      return { status: 'conflict' };
    }
    const result = await this.recordDeliveryAcknowledgement(
      acknowledgement,
      lifecycle,
      ownerStreamId!,
      runtime,
      expectedCortexPresentation ? (currentCortexPresentation ?? null) : null,
    );
    if (!['stale_revision', 'stale_source_order'].includes(result.status)) {
      if (!expectedCortexPresentation && result.presentation?.cortexPresentation) {
        const { userId, conversationId, responseMessageId, interactionContext } =
          result.presentation;
        return {
          ...result,
          presentation: { userId, conversationId, responseMessageId, interactionContext },
        };
      }
      return result;
    }
    return {
      ...result,
      ownerStreamId: ownerStreamId!,
      presentation: {
        userId: ownerJob.userId,
        conversationId: ownerJob.conversationId,
        responseMessageId: ownerJob.responseMessageId,
        interactionContext: ownerJob.interactionContext,
      },
    };
  }

  /**
   * Resolve a Telegram transport receipt for an answer that the server already committed.
   * Scheduler turns keep server presentation authority; the Telegram adapter may only attach
   * transport IDs after the exact schedule and run identities match server-owned context.
   */
  async acknowledgeServerCommittedTransportReceipt(
    acknowledgement: InteractionDeliveryAck,
    adapterSurface: 'telegram' | 'voice',
  ): Promise<DeliveryAcknowledgementResult> {
    if (
      adapterSurface !== 'telegram' ||
      acknowledgement.state !== 'committed' ||
      acknowledgement.source_kind !== 'schedule_result'
    ) {
      return { status: 'conflict' };
    }
    const lifecycle = this.captureLifecycle();
    const ownerStreamId = await this.runLifecycleOperation(lifecycle, () =>
      lifecycle.jobStore.resolveDeliveryOwner(
        acknowledgement.logical_turn_id,
        acknowledgement.revision,
      ),
    );
    const runtime = ownerStreamId ? this.runtimeState.get(ownerStreamId) : undefined;
    const ownerJob = ownerStreamId
      ? await this.runLifecycleOperation(
          lifecycle,
          () => lifecycle.jobStore.getJob(ownerStreamId),
          ownerStreamId,
          runtime,
        )
      : null;
    const context = ownerJob?.interactionContext;
    if (
      !ownerJob ||
      ownerJob.deliveryPolicy?.commit_authority !== 'server' ||
      context?.origin !== 'scheduler' ||
      context?.schedule_id !== acknowledgement.schedule_id ||
      context?.schedule_run_id !== acknowledgement.schedule_run_id ||
      !ownerJob.responseMessageId
    ) {
      return { status: 'conflict' };
    }
    return {
      status: 'recorded',
      acknowledgement,
      idempotent: false,
      ownerStreamId: ownerStreamId!,
      transportOnly: true,
      presentation: {
        userId: ownerJob.userId,
        conversationId: ownerJob.conversationId,
        responseMessageId: ownerJob.responseMessageId,
        interactionContext: context,
      },
    };
  }

  /**
   * Record an older presentation only after Core has independently proven that the exact response
   * committed a durable external side effect. The adapter cannot request this class directly.
   */
  async acknowledgeDurableEffectDelivery(
    acknowledgement: InteractionDeliveryAck,
    adapterSurface: 'telegram' | 'voice',
  ): Promise<DeliveryAcknowledgementResult> {
    if (acknowledgement.state !== 'committed') {
      return { status: 'conflict' };
    }
    const lifecycle = this.captureLifecycle();
    const ownerStreamId = await this.runLifecycleOperation(lifecycle, () =>
      lifecycle.jobStore.resolveDeliveryOwner(
        acknowledgement.logical_turn_id,
        acknowledgement.revision,
      ),
    );
    const runtime = ownerStreamId ? this.runtimeState.get(ownerStreamId) : undefined;
    const ownerJob = ownerStreamId
      ? await this.runLifecycleOperation(
          lifecycle,
          () => lifecycle.jobStore.getJob(ownerStreamId),
          ownerStreamId,
          runtime,
        )
      : null;
    if (!ownerJob) {
      return { status: 'not_found' };
    }
    const effectRef = String(acknowledgement.effect_ref || '').trim();
    if (
      ownerJob.deliveryPolicy?.commit_authority !== 'external_adapter' ||
      ownerJob.interactionContext?.surface !== adapterSurface ||
      ownerJob.durableEffectReceipt?.source_event_id !==
        ownerJob.interactionContext?.source_event_id ||
      ownerJob.durableEffectReceipt?.response_message_id !== ownerJob.responseMessageId ||
      (effectRef && ownerJob.durableEffectReceipt?.effect_ref !== effectRef) ||
      (adapterSurface === 'voice' && !effectRef)
    ) {
      return { status: 'conflict' };
    }
    return this.recordDeliveryAcknowledgement(
      { ...acknowledgement, state: 'committed_effect' },
      lifecycle,
      ownerStreamId!,
      runtime,
      null,
    );
  }

  /**
   * Record that trusted server code committed durable work for this exact source/response pair.
   * Every surface gets the append-only replay fence; only response-only external adapters receive
   * presentation authority for an older response. Model text and adapter claims cannot set either.
   */
  async markDurableEffectReceipt(input: DurableEffectReceiptInput): Promise<boolean> {
    const reject = (reason: string): false => {
      logger.warn('[GenerationJobManager] Durable effect receipt binding rejected', {
        reason,
      });
      return false;
    };
    const streamId = String(input.streamId || '').trim();
    const userId = String(input.userId || '').trim();
    const sourceEventId = String(input.sourceEventId || '').trim();
    const responseMessageId = String(input.responseMessageId || '').trim();
    const effectRef = String(input.effectRef || '').trim();
    if (
      !streamId ||
      !userId ||
      !sourceEventId ||
      !responseMessageId ||
      !effectRef ||
      !['durable_work_accepted', 'durable_work_action_accepted'].includes(input.effectKind) ||
      streamId.length > 256 ||
      userId.length > 160 ||
      sourceEventId.length > 512 ||
      responseMessageId.length > 256 ||
      effectRef.length > 160
    ) {
      return reject('invalid_input');
    }
    const lifecycle = this.captureLifecycle();
    const runtime = this.runtimeState.get(streamId);
    const job = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );
    if (!job) return reject('job_missing');
    if (job.userId !== userId) return reject('owner_mismatch');
    if (job.responseMessageId !== responseMessageId) return reject('response_mismatch');
    if (job.interactionContext?.source_event_id !== sourceEventId) {
      return reject('source_mismatch');
    }
    const canPresentDurableReceipt =
      job.deliveryPolicy?.commit_authority === 'external_adapter' &&
      job.adapterCapabilities?.supersede_scope === 'response_only';
    let existingReceipts = job.durableEffectReceipts ?? [];
    if (existingReceipts.length === 0 && job.durableEffectReceipt) {
      existingReceipts = [job.durableEffectReceipt];
    }
    const existing = existingReceipts.find((receipt) => receipt.effect_ref === effectRef);
    if (
      existing &&
      (existing.effect_kind !== input.effectKind ||
        existing.source_event_id !== sourceEventId ||
        existing.response_message_id !== responseMessageId)
    ) {
      return reject('receipt_conflict');
    }
    const committedReceipt =
      existing ??
      ({
        effect_kind: input.effectKind,
        effect_ref: effectRef,
        source_event_id: sourceEventId,
        response_message_id: responseMessageId,
        committed_at: Date.now(),
      } as const);
    /* === VIVENTIUM START ===
     * Feature: Cross-surface durable-effect replay fence with narrow presentation authority.
     * Purpose: Every surface records the exact committed effect so provider fallback cannot replay
     *          it. Only response-only external adapters receive the singular presentation receipt
     *          that can close a superseded response; web and scheduler retain their normal authoring.
     */
    const receiptFinalEvent = canPresentDurableReceipt
      ? buildDurableWorkReceiptFinalEvent(job, responseMessageId, committedReceipt)
      : null;
    /* === VIVENTIUM END === */
    await this.runLifecycleOperation(
      lifecycle,
      () =>
        lifecycle.jobStore.updateJob(streamId, {
          ...(canPresentDurableReceipt && !job.durableEffectReceipt
            ? {
                durableEffectReceipt: committedReceipt,
              }
            : {}),
          durableEffectReceipts: existing
            ? existingReceipts
            : [...existingReceipts, committedReceipt],
        }),
      streamId,
      runtime,
    );
    const persisted = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );
    if (!(
      persisted?.durableEffectReceipts?.some(
        (receipt) =>
          receipt.effect_kind === input.effectKind &&
          receipt.effect_ref === effectRef &&
          receipt.source_event_id === sourceEventId &&
          receipt.response_message_id === responseMessageId,
      ) ??
      (persisted?.durableEffectReceipt?.effect_kind === input.effectKind &&
        persisted.durableEffectReceipt.effect_ref === effectRef &&
        persisted.durableEffectReceipt.source_event_id === sourceEventId &&
        persisted.durableEffectReceipt.response_message_id === responseMessageId)
    )) {
      return reject('receipt_not_persisted');
    }
    if (
      canPresentDurableReceipt &&
      receiptFinalEvent &&
      persisted.status === 'superseded' &&
      !hasDurableWorkReceiptFinalEvent(persisted)
    ) {
      if (runtime) {
        runtime.finalEvent = receiptFinalEvent;
      }
      await this.runLifecycleOperation(
        lifecycle,
        () =>
          lifecycle.jobStore.updateJob(streamId, {
            finalEvent: JSON.stringify(receiptFinalEvent),
          }),
        streamId,
        runtime,
      );
      await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.eventTransport.emitDone(streamId, receiptFinalEvent),
        streamId,
        runtime,
      );
    }
    return true;
  }

  private async recordDeliveryAcknowledgement(
    acknowledgement: InteractionDeliveryAck,
    lifecycle: ManagerLifecycleSnapshot = this.captureLifecycle(),
    expectedOwnerStreamId?: string,
    expectedRuntime: RuntimeJobState | undefined = expectedOwnerStreamId
      ? this.runtimeState.get(expectedOwnerStreamId)
      : undefined,
    expectedCortexPresentation?: CortexPresentationBinding | null,
    expectedNativeIdentity?: NativeResponseIdentity,
  ): Promise<DeliveryAcknowledgementResult> {
    let result: DeliveryAcknowledgementResult;
    let cortexPresentation: CortexPresentationBinding | undefined;
    if (expectedCortexPresentation) {
      if (!expectedOwnerStreamId) return { status: 'conflict' };
      const binding = await this.runLifecycleOperation(
        lifecycle,
        () =>
          lifecycle.jobStore.bindDeliveryAcknowledgement(
            expectedOwnerStreamId,
            acknowledgement,
            expectedCortexPresentation,
          ),
        expectedOwnerStreamId,
        expectedRuntime,
      );
      if (binding.status !== 'recorded' || !binding.acknowledgement) {
        return { status: binding.status };
      }
      cortexPresentation = binding.cortexPresentation;
      result = {
        status: 'recorded',
        acknowledgement: binding.acknowledgement,
        idempotent: binding.idempotent === true,
        ownerStreamId: expectedOwnerStreamId,
      };
    } else {
      result = await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.acknowledgeDelivery(acknowledgement),
        expectedOwnerStreamId,
        expectedOwnerStreamId ? expectedRuntime : null,
      );
      if (result.status !== 'recorded' || !result.ownerStreamId) {
        return result;
      }
      if (expectedOwnerStreamId && result.ownerStreamId !== expectedOwnerStreamId) {
        return { status: 'conflict' };
      }
    }
    const ownerStreamId = result.ownerStreamId;
    if (!ownerStreamId) return { status: 'conflict' };
    const runtime = expectedOwnerStreamId ? expectedRuntime : this.runtimeState.get(ownerStreamId);
    const ownerJob = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(ownerStreamId),
      ownerStreamId,
      runtime,
    );
    if (expectedNativeIdentity) {
      await this.runLifecycleOperation(
        lifecycle,
        () =>
          lifecycle.jobStore.updateJob(
            ownerStreamId,
            { deliveryAcknowledgement: result.acknowledgement },
            expectedNativeIdentity,
          ),
        ownerStreamId,
        runtime,
      );
      const fencedJob = await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.getJob(ownerStreamId),
        ownerStreamId,
        runtime,
      );
      if (
        !fencedJob?.nativeResponse ||
        !nativeJobMatches(fencedJob, expectedNativeIdentity) ||
        nativeIdentityJson(fencedJob.nativeResponse) !==
          nativeIdentityJson(expectedNativeIdentity) ||
        fencedJob.deliveryAcknowledgement !== result.acknowledgement
      ) {
        return { status: 'conflict' };
      }
    } else if (!expectedCortexPresentation) {
      const acknowledgementBinding = await this.runLifecycleOperation(
        lifecycle,
        () =>
          lifecycle.jobStore.bindDeliveryAcknowledgement(
            ownerStreamId,
            result.acknowledgement!,
            null,
          ),
        ownerStreamId,
        runtime,
      );
      if (acknowledgementBinding.status !== 'recorded') {
        return { status: acknowledgementBinding.status };
      }
    }
    const verifiedCortexPresentation =
      cortexPresentation &&
      ['committed', 'committed_effect'].includes(result.acknowledgement?.state || '')
        ? cortexPresentation
        : undefined;
    const presentation = ownerJob
      ? {
          userId: ownerJob.userId,
          conversationId: ownerJob.conversationId,
          responseMessageId: ownerJob.responseMessageId,
          interactionContext: ownerJob.interactionContext,
          ...(verifiedCortexPresentation ? { cortexPresentation: verifiedCortexPresentation } : {}),
        }
      : undefined;
    const job = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(ownerStreamId),
      ownerStreamId,
      runtime,
    );
    if (
      ['committed', 'committed_effect'].includes(acknowledgement.state) &&
      job?.generationCompleted === true
    ) {
      await this.finalizeCompletedJob(
        ownerStreamId,
        job.deliveryPolicy?.commit_authority === 'external_adapter',
        lifecycle,
        runtime,
      );
    }
    return { ...result, presentation };
  }

  /** Server-owned commit point used only after canonical persistence and successful final emit. */
  async acknowledgeStreamDelivery(
    streamId: string,
    acknowledgement: Pick<InteractionDeliveryAck, 'state' | 'presentation_ref'>,
    expectedNativeIdentity?: NativeResponseIdentity,
  ): Promise<DeliveryAcknowledgementResult> {
    const lifecycle = this.captureLifecycle();
    const runtime = this.runtimeState.get(streamId);
    const job = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );
    const context = job?.interactionContext;
    if (
      !job ||
      !context?.logical_turn_id ||
      job.deliveryPolicy?.commit_authority === 'external_adapter' ||
      (expectedNativeIdentity &&
        (!job.nativeResponse ||
          !nativeJobMatches(job, expectedNativeIdentity) ||
          nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(expectedNativeIdentity) ||
          acknowledgement.state !== 'partial_removed' ||
          job.status !== 'superseded' ||
          acknowledgement.presentation_ref !== expectedNativeIdentity.responseMessageId))
    ) {
      return { status: 'conflict' };
    }
    return this.recordDeliveryAcknowledgement(
      {
        logical_turn_id: context.logical_turn_id,
        revision: context.revision,
        ...acknowledgement,
      },
      lifecycle,
      streamId,
      runtime,
      null,
      expectedNativeIdentity,
    );
  }

  /**
   * Create a new generation job.
   *
   * This sets up:
   * 1. Serializable job data in the job store
   * 2. Runtime state including readyPromise (resolves when first SSE client connects)
   * 3. allSubscribersLeft callback for handling client disconnections
   *
   * The readyPromise mechanism ensures generation doesn't start before the client
   * is ready to receive events. The controller awaits this promise (with a short timeout)
   * before starting LLM generation.
   *
   * @param streamId - Unique identifier for this stream
   * @param userId - User who initiated the request
   * @param conversationId - Optional conversation ID for lookup
   * @returns A facade object for the GenerationJob
   */
  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    options?: CreateGenerationJobOptions,
  ): Promise<t.GenerationJob> {
    if (this.unavailable) {
      throw streamManagerUnavailableError();
    }
    const serviceGeneration = this.serviceGeneration;
    const lifecycleEpoch = this.lifecycleEpoch;
    const lifecycleJobStore = this.jobStore;
    const lifecycleEventTransport = this.eventTransport;
    const lifecycleSignal = this.lifecycleAbortController.signal;
    this.pendingAdmissions += 1;
    try {
      const job = await this.createJobWithinLifecycle(
        streamId,
        userId,
        conversationId,
        options,
        lifecycleSignal,
      );
      if (
        serviceGeneration !== this.serviceGeneration ||
        this.unavailable ||
        lifecycleEpoch !== this.lifecycleEpoch
      ) {
        if (!job.abortController.signal.aborted) {
          job.abortController.abort('manager_lifecycle_changed');
        }
        await lifecycleJobStore.deleteJob(streamId).catch(() => undefined);
        lifecycleEventTransport.cleanup(streamId);
        throw this.serviceGenerationChangedError();
      }
      return job;
    } catch (error) {
      if (serviceGeneration !== this.serviceGeneration || lifecycleEpoch !== this.lifecycleEpoch) {
        throw this.serviceGenerationChangedError();
      }
      throw error;
    } finally {
      this.pendingAdmissions -= 1;
    }
  }

  private async createJobWithinLifecycle(
    streamId: string,
    userId: string,
    conversationId?: string,
    options?: CreateGenerationJobOptions,
    lifecycleSignal: AbortSignal = this.lifecycleAbortController.signal,
  ): Promise<t.GenerationJob> {
    let interactionContext = options?.interactionContext;
    let supersededStreamIds: string[] = [];
    let logicalTurnClaim: LogicalTurnClaim | undefined;
    if (interactionContext) {
      const baseInteractionContext = interactionContext;
      let claim = await this.jobStore.claimLogicalTurn(streamId, userId, baseInteractionContext);
      if (claim.status === 'stale_source_order') {
        throw sourceOrderSupersededError();
      }
      if (claim.status === 'duplicate' && !(await this.jobStore.hasJob(claim.streamId))) {
        const forgotten = await this.jobStore.forgetMissingSourceEventReceipt(
          claim.interactionContext,
          claim.streamId,
        );
        if (forgotten) {
          claim = await this.jobStore.claimLogicalTurn(streamId, userId, baseInteractionContext);
        } else {
          throw streamCreationPendingError();
        }
      }
      if (claim.status === 'claimed' && claim.supersededStreamIds.length > 0) {
        const supersededJob = await this.jobStore.getJob(claim.supersededStreamIds[0]);
        const persistedServerFinal =
          supersededJob?.deliveryPolicy?.commit_authority === 'server' &&
          supersededJob.status === 'complete' &&
          Boolean(supersededJob.finalEvent) &&
          Boolean(supersededJob.interactionContext?.logical_turn_id);
        if (
          persistedServerFinal &&
          (await this.jobStore.rollbackLogicalTurnClaim(streamId, claim.interactionContext))
        ) {
          const supersededContext = supersededJob.interactionContext!;
          await this.recordDeliveryAcknowledgement({
            logical_turn_id: supersededContext.logical_turn_id!,
            revision: supersededContext.revision,
            state: 'committed',
            ...(supersededJob.responseMessageId
              ? { presentation_ref: supersededJob.responseMessageId }
              : {}),
          });
          claim = await this.jobStore.claimLogicalTurn(streamId, userId, baseInteractionContext);
        }
      }
      interactionContext = claim.interactionContext;
      if (claim.status === 'duplicate') {
        const persistedJob = await this.jobStore.getJob(claim.streamId);
        if (!persistedJob) {
          throw new Error(
            `Duplicate source event references unavailable ${streamLogRef(claim.streamId)}`,
          );
        }
        const persistedContext = persistedJob.interactionContext;
        /* === VIVENTIUM START ===
         * Feature: Source-order-safe Telegram receipt replay.
         * Purpose: Preserve canonical-session ownership and fence duplicate admissions against
         * the latest trusted watermark before returning an already-admitted generation.
         */
        if (
          persistedJob.userId !== userId ||
          !persistedContext?.logical_turn_id ||
          persistedJob.conversationId !== conversationId ||
          persistedContext.conversation_id !== baseInteractionContext.conversation_id ||
          persistedContext.logical_turn_id !== claim.interactionContext.logical_turn_id ||
          persistedContext.revision !== claim.interactionContext.revision ||
          persistedContext.source_event_id !== claim.interactionContext.source_event_id
        ) {
          throw streamReceiptConflictError();
        }
        const duplicateJob = await this.getJob(claim.streamId);
        if (!duplicateJob) {
          throw new Error(
            `Duplicate source event references unavailable ${streamLogRef(claim.streamId)}`,
          );
        }
        const replaySourceOrder = sourceOrderObservationFromContext(baseInteractionContext);
        if (
          replaySourceOrder &&
          (await this.jobStore.observeSourceOrder(replaySourceOrder)).stale
        ) {
          throw sourceOrderSupersededError();
        }
        /* === VIVENTIUM END === */
        duplicateJob.duplicateOfStreamId = claim.streamId;
        return duplicateJob;
      }
      supersededStreamIds = claim.supersededStreamIds;
      logicalTurnClaim = claim;
    }

    let sameStreamSupersededJob: SerializableJobData | null = null;
    if (supersededStreamIds.includes(streamId)) {
      sameStreamSupersededJob = await this.jobStore.getJob(streamId);
      if (sameStreamSupersededJob) {
        await this.supersedeJob(streamId);
        await this.jobStore.deleteJob(streamId);
      }
    }

    const staleRuntime = this.runtimeState.get(streamId);
    if (staleRuntime) {
      const persistedStaleJob = await this.jobStore.getJob(streamId);
      if (
        persistedStaleJob &&
        (!staleRuntime.abortController.signal.aborted ||
          persistedStaleJob.userId !== userId ||
          persistedStaleJob.conversationId !== conversationId ||
          interactionContext != null)
      ) {
        throw streamReceiptConflictError();
      }
      if (!staleRuntime.abortController.signal.aborted) {
        staleRuntime.abortController.abort('stream_reused');
      }
      this.runtimeState.delete(streamId);
      this.eventTransport.cleanup(streamId);
    }
    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const runtime: RuntimeJobState = {
      abortController: new AbortController(),
      readyPromise,
      resolveReady,
      syncSent: false,
      earlyEventBuffer: [],
      hasSubscriber: false,
    };
    this.runtimeState.set(streamId, runtime);
    let jobData: SerializableJobData;
    let jobAdmitted = false;
    try {
      if (this.eventTransport.onAbort) {
        await awaitLifecycle(
          this.eventTransport.onAbort(streamId, (reason, proof) => {
            const currentRuntime = this.runtimeState.get(streamId);
            if (
              !jobData ||
              currentRuntime?.nativeProducer?.createdAt !== jobData.createdAt ||
              (proof &&
                proof !==
                  nativeJobProofJson({
                    ...jobData,
                    responseMessageId:
                      currentRuntime.nativeProducer.responseMessageId ?? jobData.responseMessageId,
                  }))
            ) {
              return;
            }
            if (!currentRuntime.abortController.signal.aborted) {
              logger.debug(
                `[GenerationJobManager] Received cross-replica abort for ${streamLogRef(streamId)}`,
              );
              currentRuntime.abortController.abort(reason ?? 'user_cancelled');
            }
          }),
          lifecycleSignal,
        );
      }
      jobData = await this.jobStore.createJob(streamId, userId, conversationId, {
        interactionContext,
        adapterCapabilities: options?.adapterCapabilities,
        deliveryPolicy: options?.deliveryPolicy,
        clientPresentation: options?.clientPresentation,
      });
      runtime.nativeProducer = {
        createdAt: jobData.createdAt,
        responseMessageId: jobData.responseMessageId,
      };
      if (sameStreamSupersededJob && jobData.createdAt <= sameStreamSupersededJob.createdAt) {
        jobData.createdAt = sameStreamSupersededJob.createdAt + 1;
        await this.jobStore.updateJob(streamId, { createdAt: jobData.createdAt });
      }
      jobAdmitted = true;
      if (
        logicalTurnClaim?.supersededStreamIds.length &&
        this.jobStore.fenceSupersededLogicalTurnClaims
      ) {
        await this.jobStore.fenceSupersededLogicalTurnClaims(logicalTurnClaim);
      }
    } catch (error) {
      if (!runtime.abortController.signal.aborted) {
        runtime.abortController.abort('admission_failed');
      }
      this.runtimeState.delete(streamId);
      this.eventTransport.cleanup(streamId);
      if (jobAdmitted) {
        await this.jobStore.deleteJob(streamId);
      }
      if (interactionContext?.logical_turn_id) {
        await this.jobStore.rollbackLogicalTurnClaim(streamId, interactionContext);
      }
      const sourceOrderObservation = sourceOrderObservationFromContext(interactionContext);
      if (
        (error as { code?: string })?.code === 'stream_id_conflict' &&
        sourceOrderObservation &&
        (await this.jobStore.observeSourceOrder(sourceOrderObservation)).stale
      ) {
        throw sourceOrderSupersededError();
      }
      throw error;
    }

    const persistedAdmission = await this.jobStore.getJob(streamId);
    if (!persistedAdmission || persistedAdmission.status !== 'running') {
      if (!runtime.abortController.signal.aborted) {
        runtime.abortController.abort('superseded');
      }
      this.runtimeState.delete(streamId);
      this.eventTransport.cleanup(streamId);
      const sourceOrderObservation = sourceOrderObservationFromContext(interactionContext);
      if (
        sourceOrderObservation &&
        (await this.jobStore.observeSourceOrder(sourceOrderObservation)).stale
      ) {
        throw sourceOrderSupersededError();
      }
      throw streamReceiptConflictError();
    }

    /**
     * Create runtime state with readyPromise.
     *
     * With the resumable stream architecture, we no longer need to wait for the
     * first subscriber before starting generation:
     * - Redis mode: Events are persisted and can be replayed via sync
     * - In-memory mode: Content is aggregated and sent via sync on connect
     *
     * We resolve readyPromise immediately to eliminate startup latency.
     * The sync mechanism handles late-connecting clients.
     */
    // Resolve immediately - early event buffer handles late subscribers
    resolveReady();

    /**
     * Set up all-subscribers-left callback.
     * When all SSE clients disconnect, this:
     * 1. Resets syncSent so reconnecting clients get sync event (persisted to Redis)
     * 2. Calls any registered allSubscribersLeft handlers (e.g., to save partial responses)
     */
    this.eventTransport.onAllSubscribersLeft(streamId, () => {
      const currentRuntime = this.runtimeState.get(streamId);
      if (currentRuntime) {
        currentRuntime.syncSent = false;
        currentRuntime.hasSubscriber = false;
        // Persist syncSent=false to Redis for cross-replica consistency
        this.jobStore.updateJob(streamId, { syncSent: false }).catch((err) => {
          logger.error(
            `[GenerationJobManager] Failed to persist syncSent=false ${streamLogRef(streamId)}`,
            safeStreamLogError(err),
          );
        });
        // Call registered handlers (from job.emitter.on('allSubscribersLeft', ...))
        if (currentRuntime.allSubscribersLeftHandlers) {
          this.jobStore
            .getContentParts(streamId)
            .then((result) => {
              const parts = result?.content ?? [];
              for (const handler of currentRuntime.allSubscribersLeftHandlers ?? []) {
                try {
                  handler(parts);
                } catch (err) {
                  logger.error(
                    `[GenerationJobManager] Error in allSubscribersLeft handler ${streamLogRef(streamId)}`,
                    safeStreamLogError(err),
                  );
                }
              }
            })
            .catch((err) => {
              logger.error(
                `[GenerationJobManager] Failed to get content parts for allSubscribersLeft handlers ${streamLogRef(streamId)}`,
                safeStreamLogError(err),
              );
            });
        }
      }
    });

    logger.debug(`[GenerationJobManager] Created job ${streamLogRef(streamId)}`);

    const supersededPresentations: NonNullable<t.GenerationJob['supersededPresentations']> = [];
    for (const supersededStreamId of supersededStreamIds) {
      const supersededJob =
        supersededStreamId === streamId && sameStreamSupersededJob
          ? sameStreamSupersededJob
          : await this.jobStore.getJob(supersededStreamId);
      if (
        !['committed', 'committed_effect'].includes(
          supersededJob?.deliveryAcknowledgement?.state ?? '',
        )
      ) {
        supersededPresentations.push({
          conversationId: supersededJob?.conversationId,
          responseMessageId: supersededJob?.responseMessageId,
          userMessageId: supersededJob?.userMessage?.messageId,
          interactionContext: supersededJob?.interactionContext,
        });
      }
      if (supersededStreamId !== streamId) {
        await this.supersedeJob(supersededStreamId);
      }
    }

    // Return facade for backwards compatibility
    const facade = this.buildJobFacade(streamId, jobData, runtime);
    facade.supersededPresentations = supersededPresentations;
    return facade;
  }

  /**
   * Build a GenerationJob facade from composed services.
   *
   * This facade provides a unified API (job.emitter, job.abortController, etc.)
   * while internally delegating to the injected services (jobStore, eventTransport,
   * contentState). This allows swapping implementations (e.g., Redis) without
   * changing consumer code.
   *
   * IMPORTANT: The emitterProxy.on('allSubscribersLeft') handler registration
   * does NOT use eventTransport.subscribe(). This is intentional:
   *
   * If we used subscribe() for internal handlers, those handlers would count
   * as subscribers. When the real SSE client connects, isFirstSubscriber()
   * would return false (because internal handler was "first"), and readyPromise
   * would never resolve - causing a 5-second timeout delay before generation starts.
   *
   * Instead, allSubscribersLeft handlers are stored in runtime.allSubscribersLeftHandlers
   * and called directly from the onAllSubscribersLeft callback in createJob().
   *
   * @param streamId - The stream identifier
   * @param jobData - Serializable job metadata from job store
   * @param runtime - Non-serializable runtime state (abort controller, promises, etc.)
   * @returns A GenerationJob facade object
   */
  private buildJobFacade(
    streamId: string,
    jobData: SerializableJobData,
    runtime: RuntimeJobState,
  ): t.GenerationJob {
    /**
     * Proxy emitter that delegates to eventTransport for most operations.
     * Exception: allSubscribersLeft handlers are stored separately to avoid
     * incrementing subscriber count (see class JSDoc above).
     */
    const emitterProxy = {
      on: (event: string, handler: (...args: unknown[]) => void) => {
        if (event === 'allSubscribersLeft') {
          // Store handler for internal callback - don't use subscribe() to avoid counting as a subscriber
          if (!runtime.allSubscribersLeftHandlers) {
            runtime.allSubscribersLeftHandlers = [];
          }
          runtime.allSubscribersLeftHandlers.push(handler);
        }
      },
      emit: () => {
        /* handled via eventTransport */
      },
      listenerCount: () => this.eventTransport.getSubscriberCount(streamId),
      setMaxListeners: () => {
        /* no-op for proxy */
      },
      removeAllListeners: () => this.eventTransport.cleanup(streamId),
      off: () => {
        /* handled via unsubscribe */
      },
    };

    return {
      streamId,
      emitter: emitterProxy as unknown as t.GenerationJob['emitter'],
      status: jobData.status as t.GenerationJobStatus,
      createdAt: jobData.createdAt,
      completedAt: jobData.completedAt,
      abortController: runtime.abortController,
      error: jobData.error,
      metadata: {
        userId: jobData.userId,
        conversationId: jobData.conversationId,
        userMessage: jobData.userMessage,
        responseMessageId: jobData.responseMessageId,
        sender: jobData.sender,
        voiceCallSessionId: jobData.voiceCallSessionId,
        interactionContext: jobData.interactionContext,
        adapterCapabilities: jobData.adapterCapabilities,
        deliveryPolicy: jobData.deliveryPolicy,
        deliveryAcknowledgement: jobData.deliveryAcknowledgement,
        durableEffectReceipt: jobData.durableEffectReceipt,
        durableEffectReceipts: jobData.durableEffectReceipts,
        viventiumVoiceEffectAuthority: jobData.viventiumVoiceEffectAuthority,
        viventiumCallSessionId: jobData.viventiumCallSessionId,
        viventiumVoiceTaskId: jobData.viventiumVoiceTaskId,
        generationCompleted: jobData.generationCompleted,
        cortexPresentation: jobData.cortexPresentation,
      },
      readyPromise: runtime.readyPromise,
      resolveReady: runtime.resolveReady,
      finalEvent: runtime.finalEvent,
      syncSent: runtime.syncSent,
    };
  }

  /**
   * Get or create runtime state for a job.
   *
   * This enables cross-replica support in Redis mode:
   * - If runtime exists locally (same replica), return it
   * - If job exists in Redis but not locally (cross-replica), create minimal runtime
   *
   * The lazily-created runtime state is sufficient for:
   * - Subscribing to events (via Redis pub/sub)
   * - Getting resume state
   * - Handling reconnections
   * - Receiving cross-replica abort signals (via Redis pub/sub)
   *
   * @param streamId - The stream identifier
   * @returns Runtime state or null if job doesn't exist anywhere
   */
  private async getOrCreateRuntimeState(
    streamId: string,
    lifecycle: ManagerLifecycleSnapshot = this.captureLifecycle(),
    persistedJob?: SerializableJobData,
  ): Promise<RuntimeJobState | null> {
    /* === VIVENTIUM START ===
     * Feature: Stream-manager lifecycle fencing.
     * Purpose: Lazy Redis hydration must fail closed when destroy/reconfigure wins.
     */
    if (!this.isLifecycleCurrent(lifecycle)) {
      throw streamManagerUnavailableError();
    }

    const existingRuntime = this.runtimeState.get(streamId);
    if (existingRuntime) {
      return this.awaitRuntimeInitialization(streamId, existingRuntime, lifecycle);
    }

    const jobData =
      persistedJob ??
      (await this.runLifecycleOperation(lifecycle, () => lifecycle.jobStore.getJob(streamId)));
    this.assertLifecycleOperation(lifecycle);
    if (!jobData) {
      return null;
    }

    const concurrentlyInitializedRuntime = this.runtimeState.get(streamId);
    if (concurrentlyInitializedRuntime) {
      return this.awaitRuntimeInitialization(streamId, concurrentlyInitializedRuntime, lifecycle);
    }

    logger.debug(
      `[GenerationJobManager] Creating cross-replica runtime for ${streamLogRef(streamId)}`,
    );

    let resolveReady!: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    resolveReady();

    let finalEvent: t.ServerSentEvent | undefined;
    if (jobData.finalEvent) {
      try {
        finalEvent = JSON.parse(jobData.finalEvent) as t.ServerSentEvent;
      } catch {
        // Ignore malformed persisted terminal data; the durable status still controls replay.
      }
    }

    const runtime: RuntimeJobState = {
      abortController: new AbortController(),
      readyPromise,
      resolveReady,
      syncSent: jobData.syncSent ?? false,
      earlyEventBuffer: [],
      hasSubscriber: false,
      finalEvent,
      errorEvent: jobData.error,
      presentationOnly:
        jobData.generationCompleted === true &&
        jobData.deliveryPolicy?.commit_authority === 'external_adapter' &&
        ['committed', 'committed_effect'].includes(jobData.deliveryAcknowledgement?.state ?? ''),
    };

    this.runtimeState.set(streamId, runtime);

    runtime.initializationReady = (async () => {
      lifecycle.eventTransport.onAllSubscribersLeft(streamId, () => {
        const currentRuntime = this.runtimeState.get(streamId);
        if (!this.isLifecycleCurrent(lifecycle) || currentRuntime !== runtime) {
          return;
        }
        currentRuntime.syncSent = false;
        currentRuntime.hasSubscriber = false;
        lifecycle.jobStore.updateJob(streamId, { syncSent: false }).catch((err) => {
          logger.error(
            `[GenerationJobManager] Failed to persist syncSent=false ${streamLogRef(streamId)}`,
            safeStreamLogError(err),
          );
        });
        if (currentRuntime.allSubscribersLeftHandlers) {
          lifecycle.jobStore
            .getContentParts(streamId)
            .then((result) => {
              if (!this.isLifecycleCurrent(lifecycle)) {
                return;
              }
              const parts = result?.content ?? [];
              for (const handler of currentRuntime.allSubscribersLeftHandlers ?? []) {
                try {
                  handler(parts);
                } catch (err) {
                  logger.error(
                    `[GenerationJobManager] Error in allSubscribersLeft handler ${streamLogRef(streamId)}`,
                    safeStreamLogError(err),
                  );
                }
              }
            })
            .catch((err) => {
              logger.error(
                `[GenerationJobManager] Failed to get content parts for allSubscribersLeft handlers ${streamLogRef(streamId)}`,
                safeStreamLogError(err),
              );
            });
        }
      });

      if (lifecycle.eventTransport.onAbort) {
        await awaitLifecycle(
          lifecycle.eventTransport.onAbort(streamId, (reason, proof) => {
            const currentRuntime = this.runtimeState.get(streamId);
            if (
              currentRuntime?.nativeProducer?.createdAt !== jobData.createdAt ||
              (proof &&
                proof !==
                  nativeJobProofJson({
                    ...jobData,
                    responseMessageId:
                      currentRuntime.nativeProducer.responseMessageId ?? jobData.responseMessageId,
                  }))
            ) {
              return;
            }
            if (
              this.isLifecycleCurrent(lifecycle) &&
              currentRuntime === runtime &&
              !currentRuntime.abortController.signal.aborted
            ) {
              logger.debug(
                `[GenerationJobManager] Received cross-replica abort for lazily-init job ${streamLogRef(streamId)}`,
              );
              currentRuntime.abortController.abort(reason ?? 'user_cancelled');
            }
          }),
          lifecycle.signal,
        );
      }

      if (!this.isLifecycleCurrent(lifecycle) || this.runtimeState.get(streamId) !== runtime) {
        throw streamManagerUnavailableError();
      }
    })();

    try {
      await runtime.initializationReady;
      return runtime;
    } catch (error) {
      if (!runtime.abortController.signal.aborted) {
        runtime.abortController.abort('manager_lifecycle_changed');
      }
      const currentRuntime = this.runtimeState.get(streamId);
      const lifecycleChanged = !this.isLifecycleCurrent(lifecycle);
      if (currentRuntime === runtime) {
        this.runtimeState.delete(streamId);
      }
      if (
        currentRuntime === runtime ||
        (lifecycleChanged && lifecycle.eventTransport !== this.eventTransport)
      ) {
        lifecycle.eventTransport.cleanup(streamId);
      }
      if (lifecycleChanged) {
        throw streamManagerUnavailableError();
      }
      throw error;
    }
    /* === VIVENTIUM END === */
  }

  /**
   * Get a job by streamId.
   */
  async getJob(streamId: string): Promise<t.GenerationJob | undefined> {
    /* === VIVENTIUM START ===
     * Feature: Stream-manager lifecycle fencing.
     * Purpose: One getJob call may not mix persisted data and runtime state across generations.
     */
    const lifecycle = this.captureLifecycle();
    if (!this.isLifecycleCurrent(lifecycle)) {
      throw streamManagerUnavailableError();
    }
    const jobData = await this.runLifecycleOperation(lifecycle, () =>
      lifecycle.jobStore.getJob(streamId),
    );
    if (!jobData) {
      return undefined;
    }

    const runtime = await this.getOrCreateRuntimeState(streamId, lifecycle, jobData);
    if (!runtime) {
      return undefined;
    }

    return this.buildJobFacade(streamId, jobData, runtime);
    /* === VIVENTIUM END === */
  }

  /**
   * Check if a job exists.
   */
  async hasJob(streamId: string): Promise<boolean> {
    return this.jobStore.hasJob(streamId);
  }

  /**
   * Get job status.
   */
  async getJobStatus(streamId: string): Promise<t.GenerationJobStatus | undefined> {
    const jobData = await this.jobStore.getJob(streamId);
    return jobData?.status as t.GenerationJobStatus | undefined;
  }

  /* === VIVENTIUM START ===
   * Mark the user-visible Main response complete without tearing down the runtime that may still
   * deliver non-blocking Phase B updates. This removes the job from active-generation discovery,
   * while completeJob() retains ownership of final runtime cleanup after the bounded follow-up
   * window.
   * === VIVENTIUM END === */
  async markMainResponseComplete(
    streamId: string,
    finalEvent?: t.ServerSentEvent,
  ): Promise<boolean> {
    const lifecycle = this.captureLifecycle();
    const job = await this.runLifecycleOperation(lifecycle, () =>
      lifecycle.jobStore.getJob(streamId),
    );
    if (!job || job.status !== 'running' || job.nativeResponse) {
      return false;
    }
    const runtime = this.runtimeState.get(streamId);
    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    if (runtime && finalEvent) {
      runtime.finalEvent = finalEvent;
    }
    await this.runLifecycleOperation(
      lifecycle,
      () =>
        lifecycle.jobStore.updateJob(streamId, {
          status: 'complete',
          completedAt: Date.now(),
          ...(finalEvent ? { finalEvent: JSON.stringify(finalEvent) } : {}),
        }),
      streamId,
      runtime,
    );
    return true;
  }

  /**
   * Terminate only the obsolete provisional revision. Durable messages/tool side effects are not
   * rolled back; downstream persistence can use the distinct status to remove unfinished output.
   */
  private async supersedeJob(streamId: string): Promise<void> {
    const jobData = await this.jobStore.getJob(streamId);
    if (
      !jobData ||
      (!['running', 'complete'].includes(jobData.status) &&
        (!jobData.nativeResponse || jobData.nativeResponseCancelled))
    ) {
      return;
    }

    const context = jobData.interactionContext;
    const terminalEvent = {
      final: true,
      superseded: true,
      logical_turn_id: context?.logical_turn_id,
      revision: context?.revision,
    } as unknown as t.ServerSentEvent;
    const nativeCancellation = await this.jobStore.cancelNativeResponse(jobData);
    if (nativeCancellation.status !== 'revoked') {
      return;
    }
    const runtime = this.runtimeState.get(streamId);
    const stopsAuthoring = jobData.adapterCapabilities?.supersede_scope !== 'response_only';
    const durableReceipt = jobData.durableEffectReceipt;
    const presentationEvent = durableReceipt
      ? buildDurableWorkReceiptFinalEvent(jobData, durableReceipt.response_message_id)
      : terminalEvent;
    const waitsForDurableEffectDecision =
      !stopsAuthoring && jobData.status === 'running' && !durableReceipt;
    if (stopsAuthoring && runtime && !runtime.abortController.signal.aborted) {
      runtime.abortController.abort('superseded');
    }
    if (runtime) {
      runtime.nativeProducer = undefined;
      if (!waitsForDurableEffectDecision) {
        runtime.finalEvent = presentationEvent;
      }
    }
    await this.jobStore.updateJob(streamId, {
      status: 'superseded',
      completedAt: Date.now(),
      ...(waitsForDurableEffectDecision ? {} : { finalEvent: JSON.stringify(presentationEvent) }),
    });
    if (waitsForDurableEffectDecision) {
      const supersededJob = await this.jobStore.getJob(streamId);
      const supersededReceipt = supersededJob?.durableEffectReceipt;
      if (
        supersededJob?.status === 'superseded' &&
        supersededReceipt &&
        !hasDurableWorkReceiptFinalEvent(supersededJob)
      ) {
        const receiptEvent = buildDurableWorkReceiptFinalEvent(
          supersededJob,
          supersededReceipt.response_message_id,
        );
        if (runtime) {
          runtime.finalEvent = receiptEvent;
        }
        await this.jobStore.updateJob(streamId, {
          finalEvent: JSON.stringify(receiptEvent),
        });
        try {
          await this.eventTransport.emitDone(streamId, receiptEvent);
        } catch {
          logger.warn(
            '[GenerationJobManager] Durable receipt notification unavailable after supersession',
          );
        }
      }
    }
    if (stopsAuthoring) {
      try {
        await this.eventTransport.emitAbort?.(streamId, 'superseded');
      } catch {
        logger.warn('[GenerationJobManager] Supersession signal unavailable after durable fence');
      }
    }
    if (stopsAuthoring) {
      this.jobStore.clearContentState(streamId);
      this.runStepBuffers?.delete(streamId);
    }
    /* === VIVENTIUM START ===
     * Feature: Durable logical-turn supersession.
     * Purpose: Terminal delivery is best-effort after the old and new revisions are committed.
     */
    if (!waitsForDurableEffectDecision) {
      try {
        await this.eventTransport.emitDone(streamId, presentationEvent);
      } catch {
        logger.warn(
          '[GenerationJobManager] Superseded terminal notification unavailable after durable fence',
        );
      }
    }
    /* === VIVENTIUM END === */
    logger.debug(`[GenerationJobManager] Job superseded ${streamLogRef(streamId)}`);
  }

  private async finalizeCompletedJob(
    streamId: string,
    preserveJob = false,
    lifecycle: ManagerLifecycleSnapshot = this.captureLifecycle(),
    runtime: RuntimeJobState | undefined = this.runtimeState.get(streamId),
  ): Promise<void> {
    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    if (runtime && !runtime.abortController.signal.aborted) {
      if (preserveJob) {
        // External adapters may still present one exact, durable Phase B follow-up after Main has
        // committed. Close ordinary authoring without aborting that separately fenced delivery.
        runtime.presentationOnly = true;
      } else {
        runtime.abortController.abort('generation_completed');
      }
    }
    lifecycle.jobStore.clearContentState(streamId);
    this.runStepBuffers?.delete(streamId);
    await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.completeLogicalTurn(streamId),
      streamId,
      runtime,
    );
    if (lifecycle.cleanupOnComplete && !preserveJob) {
      await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.deleteJob(streamId),
        streamId,
        runtime,
      );
      this.runtimeState.delete(streamId);
      return;
    }
    await this.runLifecycleOperation(
      lifecycle,
      () =>
        lifecycle.jobStore.updateJob(streamId, {
          status: 'complete',
          completedAt: Date.now(),
          generationCompleted: true,
        }),
      streamId,
      runtime,
    );
  }

  /**
   * Resolve the response-only window once stale authoring reaches a real terminal boundary. The
   * newer turn suppresses prose, but an exact durable-work receipt still wins presentation.
   */
  private async finishResponseOnlySupersededJob(
    streamId: string,
    lifecycle: ManagerLifecycleSnapshot,
    runtime: RuntimeJobState | undefined,
    error?: string,
  ): Promise<boolean> {
    const job = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );
    if (
      job?.status !== 'superseded' ||
      job.adapterCapabilities?.supersede_scope !== 'response_only'
    ) {
      return false;
    }
    const receipt = job.durableEffectReceipt;
    const finalEvent = receipt
      ? buildDurableWorkReceiptFinalEvent(job, receipt.response_message_id)
      : ({
          final: true,
          superseded: true,
          logical_turn_id: job.interactionContext?.logical_turn_id,
          revision: job.interactionContext?.revision,
        } as unknown as t.ServerSentEvent);
    const terminalAlreadyPresented = hasResponseOnlySupersededFinalEvent(job);
    if (runtime) {
      runtime.finalEvent = finalEvent;
      if (error) runtime.errorEvent = error;
    }
    await this.runLifecycleOperation(
      lifecycle,
      () =>
        lifecycle.jobStore.updateJob(streamId, {
          generationCompleted: true,
          finalEvent: JSON.stringify(finalEvent),
          ...(error ? { error } : {}),
        }),
      streamId,
      runtime,
    );
    if (!terminalAlreadyPresented) {
      try {
        await this.runLifecycleOperation(
          lifecycle,
          () => lifecycle.eventTransport.emitDone(streamId, finalEvent),
          streamId,
          runtime,
        );
      } catch {
        logger.warn(
          '[GenerationJobManager] Superseded response terminal unavailable after durable fence',
        );
      }
    }
    if (runtime && !runtime.abortController.signal.aborted) {
      runtime.abortController.abort('durable_stream_terminal');
    }
    lifecycle.jobStore.clearContentState(streamId);
    this.runStepBuffers?.delete(streamId);
    await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.completeLogicalTurn(streamId),
      streamId,
      runtime,
    );
    return true;
  }

  /**
   * Mark job as complete.
   * If cleanupOnComplete is true (default), immediately cleans up job resources.
   * Exception: Jobs with errors are NOT immediately deleted to allow late-connecting
   * clients to receive the error (race condition where error occurs before client connects).
   * Note: eventTransport is NOT cleaned up here to allow the final event to be
   * fully transmitted. It will be cleaned up when subscribers disconnect or
   * by the periodic cleanup job.
   */
  async completeJob(streamId: string, error?: string): Promise<void> {
    /* === VIVENTIUM START ===
     * Feature: Stream-manager lifecycle fencing.
     * Purpose: Completion may only finalize the exact runtime and service generation it observed.
     */
    const lifecycle = this.captureLifecycle();
    const existingJob = await this.runLifecycleOperation(lifecycle, () =>
      lifecycle.jobStore.getJob(streamId),
    );
    if (existingJob?.status === 'superseded') {
      const runtime = this.runtimeState.get(streamId);
      await this.finishResponseOnlySupersededJob(streamId, lifecycle, runtime, error);
      return;
    }
    const runtime = this.runtimeState.get(streamId);
    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    if (runtime) {
      runtime.nativeProducer = undefined;
    }
    if (existingJob?.nativeResponse) {
      if (existingJob.nativeResponseCancelled) {
        return;
      }
      lifecycle.jobStore.clearContentState(streamId);
      this.runStepBuffers?.delete(streamId);
      if (error && !existingJob.nativeResponseFinished) {
        await this.runLifecycleOperation(
          lifecycle,
          () =>
            lifecycle.jobStore.updateJob(streamId, {
              status: 'error',
              completedAt: Date.now(),
              error,
            }),
          streamId,
          runtime,
        );
      }
      return;
    }

    // For error jobs, DON'T delete immediately - keep around so late-connecting
    // clients can receive the error. This handles the race condition where error
    // occurs before client connects to SSE stream.
    //
    // Cleanup strategy: Error jobs are cleaned up by periodic cleanup (every 60s)
    // via jobStore.cleanup() which checks for jobs with status 'error' and
    // completedAt set. The TTL is configurable via jobStore options (default: 0,
    // meaning cleanup on next interval). This gives clients ~60s to connect and
    // receive the error before the job is removed.
    if (error) {
      if (runtime && !runtime.abortController.signal.aborted) {
        runtime.abortController.abort('generation_completed');
      }
      lifecycle.jobStore.clearContentState(streamId);
      this.runStepBuffers?.delete(streamId);
      await this.runLifecycleOperation(
        lifecycle,
        () =>
          lifecycle.jobStore.updateJob(streamId, {
            status: 'error',
            completedAt: Date.now(),
            error,
          }),
        streamId,
        runtime,
      );
      await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.completeLogicalTurn(streamId),
        streamId,
        runtime,
      );
      // Keep runtime state so subscribe() can access errorEvent
      logger.debug(
        `[GenerationJobManager] Job completed with error (keeping for late subscribers) ${streamLogRef(streamId)}`,
      );
      return;
    }

    await this.runLifecycleOperation(
      lifecycle,
      () =>
        lifecycle.jobStore.updateJob(streamId, {
          status: 'complete',
          completedAt: Date.now(),
          generationCompleted: true,
        }),
      streamId,
      runtime,
    );
    const refreshedJob = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );
    const hasTrustedLifecycle = Boolean(refreshedJob?.interactionContext?.logical_turn_id);
    const presentationCommitted = ['committed', 'committed_effect'].includes(
      refreshedJob?.deliveryAcknowledgement?.state ?? '',
    );
    if (hasTrustedLifecycle && !presentationCommitted) {
      logger.debug(
        `[GenerationJobManager] Generation complete; awaiting presentation acknowledgement ${streamLogRef(streamId)}`,
      );
      return;
    }
    await this.finalizeCompletedJob(
      streamId,
      refreshedJob?.deliveryPolicy?.commit_authority === 'external_adapter',
      lifecycle,
      runtime,
    );

    logger.debug(`[GenerationJobManager] Job completed ${streamLogRef(streamId)}`);
    /* === VIVENTIUM END === */
  }

  /**
   * Abort a job (user-initiated).
   * Returns all data needed for token spending and message saving.
   *
   * Cross-replica support (Redis mode):
   * - Emits abort signal via Redis pub/sub
   * - The replica running generation receives signal and aborts its AbortController
   */
  async abortJob(
    streamId: string,
    reason?: unknown,
    expected?: string | NativeResponseIdentity,
  ): Promise<AbortResult> {
    /* === VIVENTIUM START ===
     * Purpose: A delayed abort must never target a replacement same-stream job
     * after manager teardown and reconfiguration.
     */
    const services = this.captureServices();
    const { generation, jobStore, eventTransport, cleanupOnComplete } = services;
    const cancellationHandler = this.nativeResponseCancellation;
    const jobData = await jobStore.getJob(streamId);
    this.assertServiceGeneration(generation);
    let runtime = this.runtimeState.get(streamId);

    const expectedUserId = typeof expected === 'string' ? expected : expected?.userId;
    if (
      !jobData ||
      jobData.status === 'superseded' ||
      (expectedUserId !== undefined && jobData.userId !== expectedUserId) ||
      (expected &&
        typeof expected !== 'string' &&
        (!nativeJobMatches(jobData, expected) ||
          !jobData.nativeResponse ||
          nativeIdentityJson(jobData.nativeResponse) !== nativeIdentityJson(expected)))
    ) {
      logger.warn(`[GenerationJobManager] Cannot abort - job not found: ${streamId}`);
      return {
        text: '',
        content: [],
        jobData: null,
        success: false,
        finalEvent: null,
        collectedUsage: [],
      };
    }

    let cancellation: NativeResponseCommit;
    try {
      cancellation = await jobStore.cancelNativeResponse(jobData);
    } catch {
      this.assertServiceGeneration(generation);
      logger.error('[GenerationJobManager] Stop authority unavailable');
      return {
        success: false,
        nativeResponse: 'unavailable',
        jobData,
        content: [],
        text: '',
        collectedUsage: [],
        finalEvent: null,
      };
    }
    this.assertServiceGeneration(generation);
    if (cancellation.status !== 'revoked') {
      let current = await jobStore.getJob(streamId);
      this.assertServiceGeneration(generation);
      const sameJob =
        current?.createdAt === jobData.createdAt &&
        current?.userId === jobData.userId &&
        current?.responseMessageId === jobData.responseMessageId;
      const identity = sameJob ? current?.nativeResponse : undefined;
      if (cancellation.status === 'committed' && identity && this.nativeResponseRecovery) {
        try {
          await this.nativeResponseRecovery(identity);
        } catch {
          logger.error('[GenerationJobManager] Saved native result is pending recovery');
        }
        this.assertServiceGeneration(generation);
        current = await jobStore.getJob(streamId);
        this.assertServiceGeneration(generation);
      }
      const saved =
        current &&
        current.createdAt === jobData.createdAt &&
        current.nativeResponseFinished &&
        current.finalEvent;
      let status: AbortResult['nativeResponse'] = 'unavailable';
      if (cancellation.status === 'committed') {
        status = saved ? 'committed' : 'pending';
      }
      return {
        success: false,
        nativeResponse: status,
        jobData: current,
        content: [],
        text: '',
        collectedUsage: [],
        finalEvent: saved ? JSON.parse(saved) : null,
      };
    }
    const makeAbortFinalEvent = (
      content: Agents.MessageContentComplex[],
      nativeSnapshot?: Partial<IMessage>,
    ): t.ServerSentEvent => {
      /** Detect "early abort" - aborted before any generation happened (e.g., during tool loading)
    In this case, no messages were saved to DB, so frontend shouldn't navigate to conversation */
      const isEarlyAbort = content.length === 0 && !jobData.responseMessageId;

      /** Final event for abort */
      const userMessageId = jobData.userMessage?.messageId;

      return {
        final: true,
        // Don't include conversation for early aborts - it doesn't exist in DB
        conversation: isEarlyAbort ? null : { conversationId: jobData.conversationId },
        title: 'New Chat',
        requestMessage: jobData.userMessage
          ? {
              messageId: userMessageId,
              parentMessageId: jobData.userMessage.parentMessageId,
              conversationId: jobData.conversationId,
              text: jobData.userMessage.text ?? '',
              isCreatedByUser: true,
            }
          : null,
        responseMessage:
          nativeSnapshot ??
          (isEarlyAbort
            ? null
            : {
                messageId: jobData.responseMessageId ?? `${userMessageId ?? 'aborted'}_`,
                parentMessageId: userMessageId,
                conversationId: jobData.conversationId,
                content,
                sender: jobData.sender ?? 'AI',
                unfinished: true,
                error: false,
                isCreatedByUser: false,
              }),
        aborted: true,
        // Flag for early abort - no messages saved, frontend should go to new chat
        earlyAbort: isEarlyAbort,
      } as unknown as t.ServerSentEvent;
    };

    let nativeSnapshot: Partial<IMessage> | undefined;
    const cancellationUnavailable = (): AbortResult => ({
      success: false,
      nativeResponse: 'unavailable',
      jobData,
      content: [],
      text: '',
      collectedUsage: [],
      finalEvent: null,
    });
    const cancelledJobData = await jobStore.getJob(streamId);
    this.assertServiceGeneration(generation);
    if (
      !cancelledJobData ||
      cancelledJobData.createdAt !== jobData.createdAt ||
      cancelledJobData.userId !== jobData.userId ||
      cancelledJobData.responseMessageId !== jobData.responseMessageId
    )
      return cancellationUnavailable();
    // Admission can bind after the first read; cancellation fenced that same job atomically.
    const nativeIdentity = cancelledJobData.nativeResponse;
    const sameJob = async () => {
      const current = await jobStore.getJob(streamId);
      this.assertServiceGeneration(generation);
      return nativeIdentity
        ? nativeJobMatches(current, nativeIdentity) && current.status !== 'superseded'
        : current?.createdAt === jobData.createdAt &&
            current?.userId === jobData.userId &&
            current?.responseMessageId === jobData.responseMessageId;
    };
    if (nativeIdentity) {
      try {
        if (!cancellationHandler) return cancellationUnavailable();
        const currentContent = await jobStore.getContentParts(streamId);
        this.assertServiceGeneration(generation);
        const content = JSON.parse(JSON.stringify(currentContent?.content || []));
        const saved = await cancellationHandler(nativeIdentity, {
          text: parseTextParts(content),
          content,
        });
        this.assertServiceGeneration(generation);
        if (!saved || !(await sameJob())) return cancellationUnavailable();
        nativeSnapshot = saved;
      } catch {
        this.assertServiceGeneration(generation);
        logger.error('[GenerationJobManager] Stop snapshot persistence unavailable');
        return cancellationUnavailable();
      }
    }
    let abortFinalEvent: t.ServerSentEvent | undefined;
    let nativeReplay: import('./interfaces/IJobStore').NativeResponseReplayGuard | undefined;
    if (nativeSnapshot && nativeIdentity) {
      const nativeRuntime = await this.getOrCreateRuntimeState(streamId);
      this.assertServiceGeneration(generation);
      if (!nativeRuntime || !(await sameJob())) return cancellationUnavailable();
      runtime = nativeRuntime;
      abortFinalEvent = makeAbortFinalEvent(
        nativeSnapshot.content as Agents.MessageContentComplex[],
        nativeSnapshot,
      );
      const encoded = JSON.stringify(abortFinalEvent);
      const saved = await jobStore.finishNativeResponse(nativeIdentity, '', encoded, 'cancelled');
      this.assertServiceGeneration(generation);
      const retained = await jobStore.getJob(streamId);
      this.assertServiceGeneration(generation);
      if (
        !nativeJobMatches(retained, nativeIdentity) ||
        !retained.nativeResponseCancelled ||
        !retained.nativeResponseFinished ||
        !retained.finalEvent ||
        nativeIdentityJson(retained.nativeResponse!) !== nativeIdentityJson(nativeIdentity)
      )
        return cancellationUnavailable();
      if (!saved) {
        abortFinalEvent = JSON.parse(retained.finalEvent) as t.ServerSentEvent;
        if (
          !abortFinalEvent ||
          typeof abortFinalEvent !== 'object' ||
          !('responseMessage' in abortFinalEvent)
        )
          return cancellationUnavailable();
        const savedSnapshot = abortFinalEvent.responseMessage;
        if (
          !savedSnapshot ||
          typeof savedSnapshot !== 'object' ||
          !('messageId' in savedSnapshot) ||
          savedSnapshot.messageId !== nativeIdentity.responseMessageId ||
          !('text' in savedSnapshot) ||
          typeof savedSnapshot.text !== 'string' ||
          !('content' in savedSnapshot) ||
          !Array.isArray(savedSnapshot.content)
        )
          return cancellationUnavailable();
        nativeSnapshot = {
          ...savedSnapshot,
          messageId: nativeIdentity.responseMessageId,
          text: savedSnapshot.text,
          content: savedSnapshot.content,
        };
      }
      const acceptedFinal = retained.finalEvent;
      nativeReplay = {
        identity: nativeIdentity,
        cancelled: true,
        finalEvent: acceptedFinal,
        isCurrent: () =>
          generation === this.serviceGeneration &&
          this.runtimeState.get(streamId) === nativeRuntime &&
          nativeIdentity.recoverUntil > Date.now() &&
          retained.nativeResponseCancelled === true &&
          retained.nativeResponseFinished === true &&
          retained.finalEvent === acceptedFinal,
      };
    }
    if (runtime) {
      runtime.nativeProducer = undefined;
    }

    // Emit abort signal for cross-replica support (Redis mode)
    // This ensures the generating replica receives the abort signal
    if (eventTransport.emitAbort) {
      const published = await eventTransport.emitAbort(
        streamId,
        reason === 'user_cancelled' ? 'user_cancelled' : undefined,
        nativeReplay,
      );
      this.assertServiceGeneration(generation);
      if (published === false) return cancellationUnavailable();
    }

    if (nativeSnapshot && !(await sameJob())) return cancellationUnavailable();

    // Also abort local controller if we have it (same-replica abort)
    let harnessCancellationDelivered = false;
    let cancellationDelivery: Promise<unknown> | undefined;
    if (runtime) {
      runtime.abortController.abort(reason);
      if (reason === 'user_cancelled') {
        cancellationDelivery = (
          runtime.abortController.signal as AbortSignal & {
            _viventiumHarnessCancellationDelivery?: Promise<unknown>;
          }
        )._viventiumHarnessCancellationDelivery;
      }
    }

    let nativePublished = false;
    if (nativeSnapshot && nativeIdentity && cancellationHandler && abortFinalEvent) {
      if (runtime) runtime.finalEvent = abortFinalEvent;
      const published = await eventTransport.emitDone(streamId, abortFinalEvent!, nativeReplay);
      this.assertServiceGeneration(generation);
      if (nativeSnapshot && (published === false || !(await sameJob())))
        return cancellationUnavailable();

      try {
        const marked = await cancellationHandler(
          nativeIdentity,
          { text: nativeSnapshot.text || '', content: nativeSnapshot.content || [] },
          'published',
        );
        this.assertServiceGeneration(generation);
        if (!marked || !(await sameJob())) return cancellationUnavailable();
      } catch {
        this.assertServiceGeneration(generation);
        return cancellationUnavailable();
      }
      nativePublished = true;
    }
    if (cancellationDelivery) {
      try {
        const deliveryResult = (await cancellationDelivery) as { delivered?: boolean } | undefined;
        harnessCancellationDelivered = deliveryResult?.delivered === true;
      } catch (error) {
        if (!nativePublished) throw error;
        logger.warn('[GenerationJobManager] Stop activity acknowledgement unavailable');
      }
    }

    /** Content before clearing state */
    const result = nativeSnapshot ? null : await jobStore.getContentParts(streamId);
    this.assertServiceGeneration(generation);
    const rawContent = (nativeSnapshot?.content ??
      result?.content ??
      []) as Agents.MessageContentComplex[];
    /* === VIVENTIUM START ===
     * Feature: Persist acknowledged harness cancellation as a public activity part.
     * Purpose: The abort save path bypasses the normal final content conversion. Preserve safe
     * activity summaries across refresh and never persist an internal `think` part for this turn.
     * === VIVENTIUM END === */
    let content = harnessCancellationDelivered
      ? rawContent.map((part) => {
          if (part?.type !== 'think') {
            return part;
          }
          return {
            type: 'harness_activity',
            harness_activity: {
              event: 'reasoning-summary',
              summary: typeof part.think === 'string' ? part.think : '',
            },
          } as TMessageContentParts;
        })
      : rawContent;
    if (harnessCancellationDelivered) {
      content.push({
        type: 'harness_activity',
        harness_activity: {
          event: 'cancelled',
          summary: 'The harness turn was cancelled.\n',
        },
      } as TMessageContentParts);
      if (nativeSnapshot && nativeIdentity && cancellationHandler) {
        try {
          if (!(await sameJob())) throw new Error('native_response_activity_retired');
          const saved = await cancellationHandler(
            nativeIdentity,
            {
              text: nativeSnapshot.text || '',
              content: content as NativeResponseMessageProjection['content'],
            },
            'augmentation',
          );
          this.assertServiceGeneration(generation);
          if (!saved) throw new Error('native_response_activity_unavailable');
          // Cancellation activity is a later augmentation; the first Stop FINAL stays immutable.
          content = (nativeSnapshot.content || []) as Agents.MessageContentComplex[];
        } catch {
          this.assertServiceGeneration(generation);
          logger.warn('[GenerationJobManager] Later Stop activity remains unavailable');
        }
      }
    }

    /** Collected usage for all models */
    const collectedUsage = jobStore.getCollectedUsage(streamId);

    /** Text from content parts for fallback token counting */
    const text = nativeSnapshot?.text ?? parseTextParts(content as TMessageContentParts[]);

    const finalEvent = abortFinalEvent ?? makeAbortFinalEvent(content);

    if (runtime) {
      runtime.finalEvent = finalEvent;
    }

    if (!nativePublished) {
      await eventTransport.emitDone(streamId, finalEvent);
      this.assertServiceGeneration(generation);
    }
    if (nativeSnapshot && nativeIdentity && nativePublished) {
      try {
        if (await sameJob()) {
          await jobStore.completeLogicalTurn(streamId, nativeIdentity);
          this.assertServiceGeneration(generation);
          if (await sameJob()) {
            await jobStore.deleteJob(streamId, nativeIdentity);
            this.assertServiceGeneration(generation);
            if (this.runtimeState.get(streamId) === runtime) {
              this.runStepBuffers?.delete(streamId);
              this.runtimeState.delete(streamId);
            }
          }
        }
      } catch {
        this.assertServiceGeneration(generation);
        logger.warn('[GenerationJobManager] Published Stop cleanup remains pending');
      }
      return {
        success: true,
        jobData: cancelledJobData,
        content: (nativeSnapshot.content || []) as Agents.MessageContentComplex[],
        finalEvent,
        text: nativeSnapshot.text || '',
        collectedUsage,
      };
    }
    jobStore.clearContentState(streamId);
    this.runStepBuffers?.delete(streamId);
    await jobStore.completeLogicalTurn(streamId);

    // Immediate cleanup if configured (default: true)
    if (cleanupOnComplete) {
      // Don't cleanup eventTransport here - let the abort event fully transmit first.
      await jobStore.deleteJob(streamId, nativeIdentity);
      this.assertServiceGeneration(generation);
      if (!runtime || this.runtimeState.get(streamId) === runtime) {
        this.runtimeState.delete(streamId);
      }
    } else {
      // Only update status if keeping the job around
      await jobStore.updateJob(streamId, {
        status: 'aborted',
        completedAt: Date.now(),
      });
      this.assertServiceGeneration(generation);
    }

    logger.debug(`[GenerationJobManager] Job aborted: ${streamId}`);

    return {
      success: true,
      jobData: cancelledJobData,
      content,
      finalEvent,
      text,
      collectedUsage,
    };
    /* === VIVENTIUM END === */
  }

  /**
   * Subscribe to a job's event stream.
   *
   * This is called when an SSE client connects to /chat/stream/:streamId.
   * On first subscription:
   * - Resolves readyPromise (legacy, for API compatibility)
   * - Replays any buffered early events (e.g., 'created' event)
   *
   * Supports cross-replica reconnection in Redis mode:
   * - If job exists in Redis but not locally, creates minimal runtime state
   * - Events are delivered via Redis pub/sub, not in-memory EventEmitter
   *
   * @param streamId - The stream to subscribe to
   * @param onChunk - Handler for chunk events (streamed tokens, run steps, etc.)
   * @param onDone - Handler for completion event (includes final message)
   * @param onError - Handler for error events
   * @returns Subscription object with unsubscribe function, or null if job not found
   */
  async subscribe(
    streamId: string,
    onChunk: t.ChunkHandler,
    onDone?: t.DoneHandler,
    onError?: t.ErrorHandler,
    signal?: AbortSignal,
  ): Promise<{ unsubscribe: t.UnsubscribeFn } | null> {
    /* === VIVENTIUM START ===
     * Feature: Stream-manager lifecycle fencing.
     * Purpose: An SSE subscription cannot escape before its exact lifecycle/channel is ready.
     */
    const lifecycle = this.captureLifecycle();
    const createCancellationError = () => {
      const error = new Error('Generation stream subscription cancelled');
      error.name = 'AbortError';
      return error;
    };
    if (signal?.aborted) {
      throw createCancellationError();
    }
    // Use lazy initialization to support cross-replica subscriptions
    const runtime = await this.getOrCreateRuntimeState(streamId, lifecycle);
    if (signal?.aborted) {
      throw createCancellationError();
    }
    if (!runtime) {
      return null;
    }

    const jobData = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );
    if (signal?.aborted) {
      throw createCancellationError();
    }

    // If job already complete/error, send final event or error
    // Error status takes precedence to ensure errors aren't misreported as successes
    setImmediate(() => {
      if (!this.isLifecycleCurrent(lifecycle) || this.runtimeState.get(streamId) !== runtime) {
        return;
      }
      if (jobData && ['complete', 'error', 'aborted', 'superseded'].includes(jobData.status)) {
        // Check for error status FIRST and prioritize error handling
        if (jobData.status === 'error' && (runtime.errorEvent || jobData.error)) {
          const errorToSend = runtime.errorEvent ?? jobData.error;
          if (errorToSend) {
            logger.debug(
              `[GenerationJobManager] Sending stored error to late subscriber ${streamLogRef(streamId)}`,
            );
            onError?.(errorToSend);
          }
        } else if (runtime.finalEvent) {
          onDone?.(runtime.finalEvent);
        }
      }
    });

    const subscription = lifecycle.eventTransport.subscribe(streamId, {
      onChunk: (event) => {
        if (!this.isLifecycleCurrent(lifecycle) || this.runtimeState.get(streamId) !== runtime) {
          return;
        }
        const e = event as t.ServerSentEvent;
        // Filter out internal events
        if (!(e as Record<string, unknown>)._internal) {
          onChunk(e);
        }
      },
      onDone: (event, proof) => {
        const currentRuntime = this.runtimeState.get(streamId);
        const expectedProof = nativeJobProofJson({
          ...jobData!,
          responseMessageId:
            currentRuntime?.nativeProducer?.responseMessageId ?? jobData?.responseMessageId,
        });
        if (
          this.isLifecycleCurrent(lifecycle) &&
          currentRuntime === runtime &&
          (proof === undefined || proof === expectedProof)
        ) {
          onDone?.(event as t.ServerSentEvent);
        }
      },
      onError: (error) => {
        if (this.isLifecycleCurrent(lifecycle) && this.runtimeState.get(streamId) === runtime) {
          onError?.(error);
        }
      },
    });

    let onAbort: () => void = () => undefined;
    try {
      if (subscription.ready) {
        const cancellation = new Promise<never>((_, reject) => {
          onAbort = () => reject(createCancellationError());
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) {
            onAbort();
          }
        });
        await (signal
          ? Promise.race([
              this.runLifecycleOperation(lifecycle, () => subscription.ready!, streamId, runtime),
              cancellation,
            ])
          : this.runLifecycleOperation(lifecycle, () => subscription.ready!, streamId, runtime));
      } else {
        this.assertLifecycleOperation(lifecycle, streamId, runtime);
      }
    } catch (error) {
      subscription.unsubscribe();
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    // Check if this is the first subscriber
    const isFirst = lifecycle.eventTransport.isFirstSubscriber(streamId);
    this.assertLifecycleOperation(lifecycle, streamId, runtime);

    // First subscriber: replay buffered events and mark as connected
    if (!runtime.hasSubscriber) {
      /* === VIVENTIUM START ===
       * Purpose: On reconnect, align Redis subscriber ordering with the
       * current publisher sequence before new chunks arrive. Without this,
       * stale expected sequence numbers can buffer fresh chunks until timeout.
       * === VIVENTIUM END === */
      if (isFirst) {
        lifecycle.eventTransport.syncReorderBuffer?.(streamId);
      }

      runtime.hasSubscriber = true;

      // Replay any events that were emitted before subscriber connected
      if (runtime.earlyEventBuffer.length > 0) {
        logger.debug(
          `[GenerationJobManager] Replaying ${runtime.earlyEventBuffer.length} buffered events for ${streamLogRef(streamId)}`,
        );
        for (const bufferedEvent of runtime.earlyEventBuffer) {
          onChunk(bufferedEvent);
        }
        runtime.earlyEventBuffer = [];
      }
    }

    if (isFirst) {
      runtime.resolveReady();
      logger.debug(
        `[GenerationJobManager] First subscriber ready, resolving promise for ${streamLogRef(streamId)}`,
      );
    }

    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    return subscription;
    /* === VIVENTIUM END === */
  }

  /**
   * Emit a chunk event to all subscribers.
   * Uses runtime state check for performance (avoids async job store lookup per token).
   *
   * If no subscriber has connected yet, buffers the event for replay when they do.
   * This ensures early events (like 'created') aren't lost due to race conditions.
   *
   * In Redis mode, awaits the publish to guarantee event ordering.
   * This is critical for streaming deltas (tool args, message content) to arrive in order.
   */
  async emitChunk(
    streamId: string,
    event: t.ServerSentEvent,
    emission: ChunkEmissionOptions | NativeResponseIdentity = {},
  ): Promise<ChunkEmissionReceipt> {
    const nativePreviewIdentity =
      'streamId' in emission ? (emission as NativeResponseIdentity) : undefined;
    const options = nativePreviewIdentity ? {} : (emission as ChunkEmissionOptions);
    const lifecycle = this.captureLifecycle();
    const cortexEvent = event as {
      event?: string;
      data?: {
        messageId?: string;
        parentMessageId?: string;
        presentationParentMessageId?: string;
        revision?: number;
        presentationGeneration?: number;
        presentationClaimToken?: string;
      };
    };
    const isCortexPresentationCandidate =
      cortexEvent.event === 'on_cortex_followup' &&
      String(cortexEvent.data?.messageId || '').trim() !== '';
    const runtime = this.runtimeState.get(streamId);
    if (
      !runtime ||
      runtime.abortController.signal.aborted ||
      (runtime.presentationOnly === true && !isCortexPresentationCandidate)
    ) {
      return { delivered: false, streamId, reason: 'runtime_unavailable' };
    }
    if (
      !(await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.isCurrentLogicalTurn(streamId),
        streamId,
        runtime,
      ))
    ) {
      await this.stopRuntimeAfterDurableFence(streamId, lifecycle, runtime);
      return { delivered: false, streamId, reason: 'logical_turn_inactive' };
    }
    if (nativePreviewIdentity) {
      const job = await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.getJob(streamId),
        streamId,
        runtime,
      );
      if (
        !nativeJobMatches(job, nativePreviewIdentity) ||
        !job.nativeResponse ||
        nativeIdentityJson(job.nativeResponse) !== nativeIdentityJson(nativePreviewIdentity) ||
        !this.hasLocalNativeResponseProducer(nativePreviewIdentity) ||
        this.runtimeState.get(streamId) !== runtime ||
        runtime.abortController.signal.aborted
      ) {
        return { delivered: false, streamId, reason: 'runtime_unavailable' };
      }
    }

    const messageId = String(cortexEvent.data?.messageId || '').trim();
    const parentMessageId = String(
      cortexEvent.data?.presentationParentMessageId || cortexEvent.data?.parentMessageId || '',
    ).trim();
    const revision = Math.max(1, Number(cortexEvent.data?.revision) || 1);
    const isCortexPresentation = cortexEvent.event === 'on_cortex_followup' && !!messageId;
    /* === VIVENTIUM START ===
     * Feature: Exact Cortex presentation receipts.
     * Purpose: Keep owner and graph-result identity stable through bind, append, and publish.
     */
    let presentationGeneration = 0;
    let deliveryIds: string[] = [];
    let deliveryReceipts: CortexPresentationBinding['deliveryReceipts'] = [];
    let presentationOwnerId = '';
    let presentationClaimToken = '';
    let presentationLeaseToken = '';
    let authorizedEvent = event;

    const consumeCortexFault = async (
      boundary: 'web_replay_persistence' | 'web_redis_publish_ack',
    ): Promise<boolean> => {
      if (!isCortexPresentation || typeof options.consumeCortexFault !== 'function') return false;
      try {
        return (await options.consumeCortexFault(boundary)).triggered === true;
      } catch {
        return false;
      }
    };

    const verifyCurrentCortexPresentation = async (stage: 'bind' | 'append' | 'publish') => {
      if (!isCortexPresentation || typeof options.verifyCortexPresentation !== 'function') {
        return false;
      }
      const verified = await options.verifyCortexPresentation(stage);
      const verifiedMessageId = String(verified?.messageId || '').trim();
      const verifiedParentMessageId = String(verified?.parentMessageId || '').trim();
      const verifiedRevision = Math.max(0, Number(verified?.revision) || 0);
      const verifiedGeneration = Math.max(0, Number(verified?.generation) || 0);
      const verifiedOwnerId = String(verified?.ownerId || '').trim();
      const verifiedClaimToken = String(verified?.claimToken || '').trim();
      const verifiedPresentationLeaseToken = String(verified?.presentationLeaseToken || '').trim();
      const verifiedDeliveryIds = [
        ...new Set(
          (Array.isArray(verified?.deliveryIds) ? verified.deliveryIds : [])
            .map((deliveryId) => String(deliveryId || '').trim())
            .filter(Boolean),
        ),
      ].sort();
      const verifiedDeliveryReceipts = (
        Array.isArray(verified?.deliveryReceipts) ? verified.deliveryReceipts : []
      )
        .map((deliveryReceipt) => ({
          deliveryId: String(deliveryReceipt?.deliveryId || '').trim(),
          graphResultHash: String(deliveryReceipt?.graphResultHash || '')
            .trim()
            .toLowerCase(),
        }))
        .sort((left, right) => left.deliveryId.localeCompare(right.deliveryId));
      const exactInitialIdentity =
        verifiedOwnerId !== '' &&
        verifiedMessageId === messageId &&
        verifiedParentMessageId === parentMessageId &&
        verifiedRevision === revision &&
        verifiedGeneration > 0 &&
        verifiedClaimToken !== '' &&
        verifiedPresentationLeaseToken !== '' &&
        verifiedDeliveryIds.length > 0 &&
        verifiedDeliveryReceipts.length === verifiedDeliveryIds.length &&
        verifiedDeliveryReceipts.every(
          (deliveryReceipt, index) =>
            deliveryReceipt.deliveryId === verifiedDeliveryIds[index] &&
            /^[a-f0-9]{64}$/.test(deliveryReceipt.graphResultHash),
        );
      if (!exactInitialIdentity) return false;
      if (presentationGeneration > 0) {
        return (
          verifiedGeneration === presentationGeneration &&
          verifiedClaimToken === presentationClaimToken &&
          verifiedPresentationLeaseToken === presentationLeaseToken &&
          verifiedOwnerId === presentationOwnerId &&
          verifiedDeliveryIds.length === deliveryIds.length &&
          verifiedDeliveryIds.every((deliveryId, index) => deliveryId === deliveryIds[index]) &&
          verifiedDeliveryReceipts.length === deliveryReceipts.length &&
          verifiedDeliveryReceipts.every(
            (deliveryReceipt, index) =>
              deliveryReceipt.deliveryId === deliveryReceipts[index].deliveryId &&
              deliveryReceipt.graphResultHash === deliveryReceipts[index].graphResultHash,
          )
        );
      }
      presentationOwnerId = verifiedOwnerId;
      presentationGeneration = verifiedGeneration;
      presentationClaimToken = verifiedClaimToken;
      presentationLeaseToken = verifiedPresentationLeaseToken;
      deliveryIds = verifiedDeliveryIds;
      deliveryReceipts = verifiedDeliveryReceipts;
      return true;
    };

    if (isCortexPresentation) {
      if (!parentMessageId || typeof options.verifyCortexPresentation !== 'function') {
        return { delivered: false, streamId, reason: 'presentation_unconfirmed' };
      }
      if (!(await verifyCurrentCortexPresentation('bind'))) {
        return { delivered: false, streamId, reason: 'presentation_unconfirmed' };
      }
      authorizedEvent = {
        ...(event as Record<string, unknown>),
        data: {
          ...((cortexEvent.data || {}) as Record<string, unknown>),
          presentationGeneration,
          presentationClaimToken,
        },
      } as t.ServerSentEvent;
      const cortexPresentation: CortexPresentationBinding = {
        ownerId: presentationOwnerId,
        messageId,
        parentMessageId,
        revision,
        generation: presentationGeneration,
        deliveryIds,
        deliveryReceipts,
        claimToken: presentationClaimToken,
        presentationLeaseToken,
        boundAt: Date.now(),
      };
      const presentationBound = await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.bindCortexPresentation(streamId, cortexPresentation),
        streamId,
        runtime,
      );
      if (!presentationBound) {
        return { delivered: false, streamId, reason: 'presentation_unconfirmed' };
      }
    }
    /* === VIVENTIUM END === */

    const eventObj = authorizedEvent as Record<string, unknown>;
    const eventType = eventObj.event as string | undefined;
    const eventData = eventObj.data;

    // Track user message from created event
    this.trackUserMessage(streamId, authorizedEvent, lifecycle.jobStore);

    // For Redis mode, persist chunk for later reconstruction (fire-and-forget for resumability)
    let durableChunkStored = false;
    if (lifecycle.isRedis) {
      if (eventType && eventData !== undefined) {
        const appendChunk = () =>
          lifecycle.jobStore.appendChunk(streamId, { event: eventType, data: eventData });
        if (isCortexPresentation) {
          try {
            if (!(await verifyCurrentCortexPresentation('append'))) {
              return { delivered: false, streamId, reason: 'presentation_unconfirmed' };
            }
            /* === VIVENTIUM START === EMO-UC-048 Web replay persistence fault boundary. === */
            if (await consumeCortexFault('web_replay_persistence')) {
              throw new Error('Cortex Web replay persistence failed');
            }
            /* === VIVENTIUM END === */
            await this.runLifecycleOperation(lifecycle, appendChunk, streamId, runtime);
            durableChunkStored = true;
          } catch (err) {
            logger.error(
              `[GenerationJobManager] Failed to append chunk ${streamLogRef(streamId)}`,
              safeStreamLogError(err),
            );
          }
        } else {
          appendChunk().catch((err) => {
            logger.error(
              `[GenerationJobManager] Failed to append chunk ${streamLogRef(streamId)}`,
              safeStreamLogError(err),
            );
          });
        }

        // For run step events, also save to run steps key for quick retrieval
        if (eventType === 'on_run_step' || eventType === 'on_run_step_completed') {
          this.saveRunStepFromEvent(
            streamId,
            eventData as Record<string, unknown>,
            lifecycle.jobStore,
          );
        }
      }
    }

    // Redis owns Cortex replay only after appendChunk confirms durable storage. Never retain a
    // failed Cortex presentation in the process-local early buffer for a later subscriber.
    const bufferedForRuntime = !runtime.hasSubscriber;
    const canUseRuntimeReplayBuffer = !lifecycle.isRedis || !isCortexPresentation;
    if (isCortexPresentation && !(await verifyCurrentCortexPresentation('publish'))) {
      return { delivered: false, streamId, reason: 'presentation_unconfirmed' };
    }
    if (!runtime.hasSubscriber && canUseRuntimeReplayBuffer) {
      runtime.earlyEventBuffer.push(authorizedEvent);
    }

    // Await the transport emit - critical for Redis mode to maintain event order
    /* === VIVENTIUM START === EMO-UC-048 Redis publish/ack fault boundary. === */
    const publishFaultInjected =
      lifecycle.isRedis && (await consumeCortexFault('web_redis_publish_ack'));
    /* === VIVENTIUM END === */
    const transportReceipt = publishFaultInjected
      ? {
          published: false,
          subscriberCount: 0,
          ...(isCortexPresentation ? { presentationAcknowledged: false } : {}),
        }
      : await this.runLifecycleOperation(
          lifecycle,
          () =>
            lifecycle.eventTransport.emitChunk(streamId, authorizedEvent, {
              requirePresentationAcknowledgement: isCortexPresentation && !durableChunkStored,
            }),
          streamId,
          runtime,
        );
    const publishReceipt = transportReceipt as EventTransportPublishReceipt | undefined;
    let subscriberAcknowledged =
      publishReceipt?.published === true && Number(publishReceipt.subscriberCount) > 0;
    if (isCortexPresentation) {
      subscriberAcknowledged =
        publishReceipt?.published === true && publishReceipt.presentationAcknowledged === true;
    }
    const runtimeReplayAcknowledged =
      !lifecycle.isRedis && bufferedForRuntime && canUseRuntimeReplayBuffer;
    if (
      isCortexPresentation &&
      !subscriberAcknowledged &&
      !durableChunkStored &&
      !runtimeReplayAcknowledged
    ) {
      return { delivered: false, streamId, reason: 'presentation_unconfirmed' };
    }
    let target: Extract<ChunkEmissionReceipt, { delivered: true }>['target'] =
      'runtime_replay_buffer';
    if (subscriberAcknowledged) {
      target = 'subscriber_transport';
    } else if (durableChunkStored) {
      target = 'durable_replay_store';
    } else if (runtime.hasSubscriber) {
      target = 'subscriber_transport';
    }
    const presentationRef = isCortexPresentation
      ? `sse:${streamId}:${messageId}:${revision}`
      : undefined;
    return {
      delivered: true,
      streamId,
      target,
      ...(presentationRef ? { presentationRef } : {}),
      ...(isCortexPresentation
        ? { claimToken: presentationClaimToken, presentationLeaseToken }
        : {}),
    };
  }

  /**
   * Extract and save run step from event data.
   * The data is already the run step object from the event payload.
   */
  /* === VIVENTIUM START === Exact completed-Cortex delivery, independent of Main's lifetime. */
  async emitCortexPresentation(
    streamId: string,
    event: {
      event: 'on_cortex_followup';
      data: {
        messageId: string;
        conversationId: string;
        text: string;
        parentMessageId?: string;
        runId?: string;
        cortexCount?: number;
        revision?: number;
        presentationGeneration?: number;
        presentationClaimToken?: string;
        presentationParentMessageId?: string;
        targetSurface?: string;
        logicalTurnId?: string;
        logicalTurnRevision?: number;
        cortexPresentation?: CortexPresentationFenceReceipt;
      };
    },
    receipt: CortexPresentationFenceReceipt,
    options: {
      verifyPresentation: () => Promise<CortexPresentationFenceReceipt>;
      consumeCortexFault?: (
        boundary: 'web_replay_persistence' | 'web_redis_publish_ack',
      ) => Promise<{ triggered?: boolean }>;
    },
  ): Promise<
    | { delivered: false; streamId: string; reason: string }
    | {
        delivered: true;
        streamId: string;
        target: 'subscriber_transport';
        presentationRef: string;
        claimToken: string;
        presentationLeaseToken: string;
      }
  > {
    const services = this.captureServices();
    const failure = { delivered: false as const, streamId, reason: 'presentation_unconfirmed' };
    const normalized = normalizeCortexPresentationReceipt(receipt);
    if (
      !normalized ||
      event.event !== 'on_cortex_followup' ||
      event.data.messageId !== normalized.messageId
    ) {
      return failure;
    }
    const binding = await this.bindCortexPresentation(streamId, normalized);
    this.assertServiceGeneration(services.generation);
    if (!binding) return failure;
    const verify = async () => {
      const current = await options.verifyPresentation();
      this.assertServiceGeneration(services.generation);
      const job = await services.jobStore.getJob(streamId);
      this.assertServiceGeneration(services.generation);
      return (
        job?.status !== 'aborted' &&
        job?.userId === normalized.ownerId &&
        job?.conversationId === event.data.conversationId &&
        job?.responseMessageId === normalized.parentMessageId &&
        cortexPresentationMatchesReceipt(binding, current) &&
        cortexPresentationMatchesReceipt(job?.cortexPresentation, normalized)
      );
    };
    const authorizedEvent = {
      ...event,
      data: {
        ...event.data,
        revision: normalized.revision,
        presentationGeneration: normalized.generation,
        presentationClaimToken: normalized.claimToken,
        presentationParentMessageId: normalized.parentMessageId,
        cortexPresentation: normalized,
      },
    };
    const consumeFault = async (boundary: 'web_replay_persistence' | 'web_redis_publish_ack') =>
      (await options.consumeCortexFault?.(boundary))?.triggered === true;
    if (!(await verify())) return failure;
    if (services.isRedis && !(await consumeFault('web_replay_persistence'))) {
      try {
        await services.jobStore.appendChunk(streamId, authorizedEvent);
        this.assertServiceGeneration(services.generation);
      } catch {
        // A real subscriber acknowledgement may still establish delivery.
      }
    }
    if (!(await verify())) return failure;
    const published = (await consumeFault('web_redis_publish_ack'))
      ? undefined
      : await services.eventTransport.emitChunk(streamId, authorizedEvent, {
          requirePresentationAcknowledgement: true,
        });
    this.assertServiceGeneration(services.generation);
    if (!(await verify())) return failure;
    const subscriberAccepted =
      published?.published === true && published.presentationAcknowledged === true;
    if (!subscriberAccepted) return failure;
    return {
      delivered: true,
      streamId,
      target: 'subscriber_transport',
      presentationRef: `sse:${streamId}:${normalized.messageId}:${normalized.revision}`,
      claimToken: normalized.claimToken,
      presentationLeaseToken: normalized.presentationLeaseToken,
    };
  }
  /* === VIVENTIUM END === */

  private saveRunStepFromEvent(
    streamId: string,
    data: Record<string, unknown>,
    jobStore: IJobStore = this.jobStore,
  ): void {
    // The data IS the run step object
    const runStep = data as Agents.RunStep;
    if (!runStep.id) {
      return;
    }

    // Fire and forget - accumulate run steps
    this.accumulateRunStep(streamId, runStep, jobStore);
  }

  /**
   * Accumulate run steps for a stream (Redis mode only).
   * Uses a simple in-memory buffer that gets flushed to Redis.
   * Not used in in-memory mode - run steps come from live graph via WeakRef.
   */
  private runStepBuffers: Map<string, Agents.RunStep[]> | null = null;

  private accumulateRunStep(
    streamId: string,
    runStep: Agents.RunStep,
    jobStore: IJobStore = this.jobStore,
  ): void {
    // Lazy initialization - only create map when first used (Redis mode)
    if (!this.runStepBuffers) {
      this.runStepBuffers = new Map();
    }

    let buffer = this.runStepBuffers.get(streamId);
    if (!buffer) {
      buffer = [];
      this.runStepBuffers.set(streamId, buffer);
    }

    // Update or add run step
    const existingIdx = buffer.findIndex((rs) => rs.id === runStep.id);
    if (existingIdx >= 0) {
      buffer[existingIdx] = runStep;
    } else {
      buffer.push(runStep);
    }

    // Save to Redis
    if (jobStore.saveRunSteps) {
      jobStore.saveRunSteps(streamId, buffer).catch((err) => {
        logger.error(
          `[GenerationJobManager] Failed to save run steps ${streamLogRef(streamId)}`,
          safeStreamLogError(err),
        );
      });
    }
  }

  /**
   * Track user message from created event.
   */
  private trackUserMessage(
    streamId: string,
    event: t.ServerSentEvent,
    jobStore: IJobStore = this.jobStore,
  ): void {
    const data = event as Record<string, unknown>;
    if (!data.created || !data.message) {
      return;
    }

    const message = data.message as Record<string, unknown>;
    const updates: Partial<SerializableJobData> = {
      userMessage: {
        messageId: message.messageId as string,
        parentMessageId: message.parentMessageId as string | undefined,
        conversationId: message.conversationId as string | undefined,
        text: message.text as string | undefined,
      },
    };

    if (message.conversationId) {
      updates.conversationId = message.conversationId as string;
    }

    jobStore.updateJob(streamId, updates);
  }

  /**
   * Update job metadata.
   */
  async updateMetadata(
    streamId: string,
    metadata: Partial<t.GenerationJobMetadata>,
  ): Promise<void> {
    const services = this.captureServices();
    const updates: Partial<SerializableJobData> = {};
    if (metadata.responseMessageId) {
      updates.responseMessageId = metadata.responseMessageId;
      const runtime = this.runtimeState.get(streamId);
      if (runtime?.nativeProducer) {
        runtime.nativeProducer.responseMessageId = metadata.responseMessageId;
      }
    }
    if (metadata.sender) {
      updates.sender = metadata.sender;
    }
    if (metadata.conversationId) {
      updates.conversationId = metadata.conversationId;
    }
    if (metadata.userMessage) {
      updates.userMessage = metadata.userMessage;
    }
    if (metadata.endpoint) {
      updates.endpoint = metadata.endpoint;
    }
    if (metadata.iconURL) {
      updates.iconURL = metadata.iconURL;
    }
    if (metadata.model) {
      updates.model = metadata.model;
    }
    if (metadata.promptTokens !== undefined) {
      updates.promptTokens = metadata.promptTokens;
    }
    if (metadata.voiceCallSessionId) {
      updates.voiceCallSessionId = metadata.voiceCallSessionId;
    }
    if (metadata.viventiumVoiceEffectAuthority) {
      updates.viventiumVoiceEffectAuthority = metadata.viventiumVoiceEffectAuthority;
    }
    if (metadata.viventiumCallSessionId) {
      updates.viventiumCallSessionId = metadata.viventiumCallSessionId;
    }
    if (metadata.viventiumVoiceTaskId) {
      updates.viventiumVoiceTaskId = metadata.viventiumVoiceTaskId;
    }
    await services.jobStore.updateJob(streamId, updates);
    this.assertServiceGeneration(services.generation);
  }

  /**
   * Set reference to the graph's contentParts array.
   */
  setContentParts(streamId: string, contentParts: Agents.MessageContentComplex[]): void {
    // Use runtime state check for performance (sync check)
    if (!this.runtimeState.has(streamId)) {
      return;
    }
    this.jobStore.setContentParts(streamId, contentParts);
  }

  /**
   * Set reference to the collectedUsage array.
   * This array accumulates token usage from all models during generation.
   */
  setCollectedUsage(streamId: string, collectedUsage: UsageMetadata[]): void {
    // Use runtime state check for performance (sync check)
    if (!this.runtimeState.has(streamId)) {
      return;
    }
    this.jobStore.setCollectedUsage(streamId, collectedUsage);
  }

  /**
   * Set reference to the graph instance.
   */
  setGraph(streamId: string, graph: StandardGraph): void {
    // Use runtime state check for performance (sync check)
    if (!this.runtimeState.has(streamId)) {
      return;
    }
    this.jobStore.setGraph(streamId, graph);
  }

  /**
   * Get resume state for reconnecting clients.
   */
  async getResumeState(streamId: string): Promise<t.ResumeState | null> {
    const services = this.captureServices();
    const jobData = await services.jobStore.getJob(streamId);
    this.assertServiceGeneration(services.generation);
    if (!jobData) {
      return null;
    }

    const result = await services.jobStore.getContentParts(streamId);
    this.assertServiceGeneration(services.generation);
    const aggregatedContent = result?.content ?? [];
    const runSteps = await services.jobStore.getRunSteps(streamId);
    this.assertServiceGeneration(services.generation);

    logger.debug(`[GenerationJobManager] getResumeState ${streamLogRef(streamId)}`, {
      runStepsLength: runSteps.length,
      aggregatedContentLength: aggregatedContent.length,
    });

    return {
      runSteps,
      aggregatedContent,
      userMessage: jobData.userMessage,
      responseMessageId: jobData.responseMessageId,
      /* === VIVENTIUM START === Exact optimistic-to-authoritative resume identity. === */
      clientPresentation: jobData.clientPresentation,
      /* === VIVENTIUM END === */
      conversationId: jobData.conversationId,
      sender: jobData.sender,
    };
  }

  /**
   * Mark that sync has been sent.
   * Persists to Redis for cross-replica consistency.
   */
  markSyncSent(streamId: string): void {
    const runtime = this.runtimeState.get(streamId);
    if (runtime) {
      runtime.syncSent = true;
    }
    // Persist to Redis for cross-replica consistency
    this.jobStore.updateJob(streamId, { syncSent: true }).catch((err) => {
      logger.error(
        `[GenerationJobManager] Failed to persist syncSent flag ${streamLogRef(streamId)}`,
        safeStreamLogError(err),
      );
    });
  }

  /**
   * Check if sync has been sent.
   * Checks local runtime first, then falls back to Redis for cross-replica scenarios.
   */
  async wasSyncSent(streamId: string): Promise<boolean> {
    const localSyncSent = this.runtimeState.get(streamId)?.syncSent;
    if (localSyncSent !== undefined) {
      return localSyncSent;
    }
    // Cross-replica: check Redis
    const jobData = await this.jobStore.getJob(streamId);
    return jobData?.syncSent ?? false;
  }

  /* === VIVENTIUM START ===
   * Feature: Durable cross-replica cancellation.
   * Purpose: Stop a stale local generator when durable ownership is gone, while preserving the
   * response-only adapter contract that suppresses presentation but allows background authoring.
   * === VIVENTIUM END === */
  private async stopRuntimeAfterDurableFence(
    streamId: string,
    lifecycle: ManagerLifecycleSnapshot = this.captureLifecycle(),
    runtime: RuntimeJobState | undefined = this.runtimeState.get(streamId),
  ): Promise<void> {
    if (!runtime || runtime.abortController.signal.aborted) {
      return;
    }
    const persisted = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );
    if (
      persisted?.status === 'superseded' &&
      persisted.adapterCapabilities?.supersede_scope === 'response_only'
    ) {
      return;
    }
    runtime.abortController.abort('durable_stream_terminal');
  }

  /**
   * Emit a done event.
   * Persists finalEvent to Redis for cross-replica access.
   */
  async emitDone(streamId: string, event: t.ServerSentEvent): Promise<void> {
    const lifecycle = this.captureLifecycle();
    const runtime = this.runtimeState.get(streamId);
    const nativeJob = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );
    const isCurrent =
      nativeJob == null ||
      (await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.isCurrentLogicalTurn(streamId),
        streamId,
        runtime,
      ));
    if (!isCurrent) {
      const persisted = await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.getJob(streamId),
        streamId,
        runtime,
      );
      if (
        persisted?.status === 'superseded' &&
        persisted.adapterCapabilities?.supersede_scope === 'response_only'
      ) {
        const terminalAlreadyPresented = hasResponseOnlySupersededFinalEvent(persisted);
        const finalEvent = persisted.durableEffectReceipt
          ? buildDurableWorkReceiptFinalEvent(
              persisted,
              persisted.durableEffectReceipt.response_message_id,
            )
          : ({
              final: true,
              superseded: true,
              logical_turn_id: persisted.interactionContext?.logical_turn_id,
              revision: persisted.interactionContext?.revision,
            } as unknown as t.ServerSentEvent);
        if (runtime) {
          runtime.finalEvent = finalEvent;
        }
        await this.runLifecycleOperation(
          lifecycle,
          () =>
            lifecycle.jobStore.updateJob(streamId, {
              finalEvent: JSON.stringify(finalEvent),
              generationCompleted: true,
            }),
          streamId,
          runtime,
        );
        if (!terminalAlreadyPresented) {
          await this.runLifecycleOperation(
            lifecycle,
            () => lifecycle.eventTransport.emitDone(streamId, finalEvent),
            streamId,
            runtime,
          );
        }
        return;
      }
      await this.stopRuntimeAfterDurableFence(streamId, lifecycle, runtime);
      return;
    }
    if (nativeJob?.nativeResponse) {
      if (
        !nativeJob.nativeResponseCancelled &&
        nativeJob.nativeResponseFinished &&
        nativeJob.finalEvent === JSON.stringify(event)
      ) {
        await this.finishNativeResponse(nativeJob.nativeResponse, event);
      }
      return;
    }
    if (runtime) {
      runtime.finalEvent = event;
    }
    // Terminal delivery remains available when best-effort replay persistence fails.
    try {
      await lifecycle.jobStore.updateJob(streamId, { finalEvent: JSON.stringify(event) });
    } catch (error) {
      this.assertLifecycleOperation(lifecycle, streamId, runtime);
      logger.error(
        `[GenerationJobManager] Failed to persist terminal event ${streamLogRef(streamId)}`,
        safeStreamLogError(error),
      );
    }
    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.eventTransport.emitDone(streamId, event),
      streamId,
      runtime,
    );
  }

  /**
   * Emit an error event.
   * Stores the error for late-connecting subscribers (race condition where error
   * occurs before client connects to SSE stream).
   */
  async emitError(streamId: string, error: string): Promise<void> {
    const lifecycle = this.captureLifecycle();
    const runtime = this.runtimeState.get(streamId);
    const nativeJob = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );
    if (
      nativeJob != null &&
      !(await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.isCurrentLogicalTurn(streamId),
        streamId,
        runtime,
      ))
    ) {
      if (await this.finishResponseOnlySupersededJob(streamId, lifecycle, runtime, error)) {
        return;
      }
      await this.stopRuntimeAfterDurableFence(streamId, lifecycle, runtime);
      return;
    }
    if (
      nativeJob?.nativeResponseFinished ||
      (nativeJob?.nativeResponse && nativeJob.nativeResponseCancelled)
    ) {
      return;
    }
    if (runtime) {
      runtime.errorEvent = error;
    }
    // Terminal delivery remains available when best-effort replay persistence fails.
    try {
      await lifecycle.jobStore.updateJob(streamId, { error });
    } catch (persistError) {
      this.assertLifecycleOperation(lifecycle, streamId, runtime);
      logger.error(
        `[GenerationJobManager] Failed to persist terminal error ${streamLogRef(streamId)}`,
        safeStreamLogError(persistError),
      );
    }
    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.eventTransport.emitError(streamId, error),
      streamId,
      runtime,
    );
  }

  /**
   * Cleanup expired jobs.
   * Also cleans up any orphaned runtime state, buffers, and event transport entries.
   */
  private async cleanup(): Promise<void> {
    const services = this.captureServices();
    const { generation, jobStore, eventTransport } = services;
    const count = await jobStore.cleanup();
    this.assertServiceGeneration(generation);

    // Cleanup runtime state for deleted jobs
    for (const [streamId, runtime] of this.runtimeState) {
      const jobExists = await jobStore.hasJob(streamId);
      this.assertServiceGeneration(generation);
      if (!jobExists && this.runtimeState.get(streamId) === runtime) {
        this.runtimeState.delete(streamId);
        this.runStepBuffers?.delete(streamId);
        jobStore.clearContentState(streamId);
        eventTransport.cleanup(streamId);
      }
    }

    // Also check runStepBuffers for any orphaned entries (Redis mode only)
    if (this.runStepBuffers) {
      for (const [streamId, runStepBuffer] of this.runStepBuffers) {
        const jobExists = await jobStore.hasJob(streamId);
        this.assertServiceGeneration(generation);
        if (!jobExists && this.runStepBuffers.get(streamId) === runStepBuffer) {
          this.runStepBuffers.delete(streamId);
        }
      }
    }

    // Check eventTransport for orphaned streams (e.g., connections dropped without clean close)
    // These are streams that exist in eventTransport but have no corresponding job
    for (const streamId of eventTransport.getTrackedStreamIds()) {
      const jobExists = await jobStore.hasJob(streamId);
      this.assertServiceGeneration(generation);
      if (!jobExists && !this.runtimeState.has(streamId)) {
        eventTransport.cleanup(streamId);
      }
    }

    if (count > 0) {
      logger.debug(`[GenerationJobManager] Cleaned up ${count} expired jobs`);
    }
  }

  /**
   * Get stream info for status endpoint.
   */
  async getStreamInfo(streamId: string): Promise<{
    active: boolean;
    status: t.GenerationJobStatus;
    aggregatedContent?: Agents.MessageContentComplex[];
    createdAt: number;
  } | null> {
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData) {
      return null;
    }

    const result = await this.jobStore.getContentParts(streamId);
    const aggregatedContent = result?.content ?? [];

    return {
      active: jobData.status === 'running',
      status: jobData.status as t.GenerationJobStatus,
      aggregatedContent,
      createdAt: jobData.createdAt,
    };
  }

  /**
   * Get total job count.
   */
  async getJobCount(): Promise<number> {
    return this.jobStore.getJobCount();
  }

  /**
   * Get job count by status.
   */
  async getJobCountByStatus(): Promise<Record<t.GenerationJobStatus, number>> {
    const [running, complete, error, aborted, superseded] = await Promise.all([
      this.jobStore.getJobCountByStatus('running'),
      this.jobStore.getJobCountByStatus('complete'),
      this.jobStore.getJobCountByStatus('error'),
      this.jobStore.getJobCountByStatus('aborted'),
      this.jobStore.getJobCountByStatus('superseded'),
    ]);
    return { running, complete, error, aborted, superseded };
  }

  getRuntimeStats(): {
    runtimeStateCount: number;
    trackedEventStreams: number;
    isRedis: boolean;
    cleanupOnComplete: boolean;
  } {
    return {
      runtimeStateCount: this.runtimeState.size,
      trackedEventStreams: this.eventTransport.getTrackedStreamIds().length,
      isRedis: this._isRedis,
      cleanupOnComplete: this._cleanupOnComplete,
    };
  }

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Performs self-healing cleanup of stale entries.
   *
   * @param userId - The user ID to query
   * @returns Array of conversation IDs with active jobs
   */
  async getActiveJobIdsForUser(userId: string): Promise<string[]> {
    return this.jobStore.getActiveJobIdsByUser(userId);
  }

  /* === VIVENTIUM START ===
   * Feature: Exact resumable-stream liveness.
   * Purpose: Conversation IDs drive navigation, but terminal UI reconciliation must distinguish
   *          overlapping streams within one conversation.
   */
  async getActiveStreamsForUser(
    userId: string,
  ): Promise<Array<{ streamId: string; conversationId: string }>> {
    const streamIds = await this.jobStore.getActiveJobIdsByUser(userId);
    const activeStreams: Array<{ streamId: string; conversationId: string }> = [];
    for (const streamId of streamIds) {
      const job = await this.jobStore.getJob(streamId);
      if (job?.status === 'running') {
        activeStreams.push({
          streamId,
          conversationId: job.conversationId ?? streamId,
        });
      }
    }
    return activeStreams;
  }
  /* === VIVENTIUM END === */

  /** Resolve the newest active stream by stable conversation identity. */
  async getActiveStreamIdForConversation(
    userId: string,
    conversationId: string,
  ): Promise<string | undefined> {
    const streamIds = await this.jobStore.getActiveJobIdsByUser(userId);
    let newest: SerializableJobData | undefined;
    for (const streamId of streamIds) {
      const job = await this.jobStore.getJob(streamId);
      if (
        job?.status === 'running' &&
        job.conversationId === conversationId &&
        (!newest || job.createdAt > newest.createdAt)
      ) {
        newest = job;
      }
    }
    return newest?.streamId;
  }

  /** Conversation identities used by web navigation/title state, deduplicated from stream IDs. */
  async getActiveConversationIdsForUser(userId: string): Promise<string[]> {
    const activeStreams = await this.getActiveStreamsForUser(userId);
    const conversationIds = new Set(activeStreams.map(({ conversationId }) => conversationId));
    return [...conversationIds];
  }

  /**
   * Destroy the manager.
   * Cleans up all resources including runtime state, buffers, and stores.
   */
  destroy(): Promise<void> {
    if (this.destroyPromise) {
      return this.destroyPromise;
    }
    const lifecycleJobStore = this._jobStore;
    const lifecycleEventTransport = this._eventTransport;
    this.unavailable = true;
    this.lifecycleAbortController.abort('manager_destroyed');
    this.lifecycleEpoch += 1;
    this.serviceGeneration += 1;
    this.lifecycleState = 'destroying';
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    /* === VIVENTIUM START === Stream readiness lifecycle cleanup. === */
    this.initializationPromise = null;
    /* === VIVENTIUM END === */

    for (const runtime of this.runtimeState.values()) {
      if (!runtime.abortController.signal.aborted) {
        runtime.abortController.abort('manager_destroyed');
      }
    }
    this.nativeResponseRecovery = undefined;
    this.nativeResponseCancellation = undefined;
    this.runtimeState.clear();
    this.runStepBuffers?.clear();
    this.destroyPromise = Promise.allSettled([
      lifecycleJobStore.destroy(),
      lifecycleEventTransport.destroy(),
    ])
      .then(([jobStoreResult, eventTransportResult]) => {
        if (jobStoreResult.status === 'rejected') {
          if (eventTransportResult.status === 'rejected') {
            logger.error(
              '[GenerationJobManager] Event transport teardown also failed',
              safeStreamLogError(eventTransportResult.reason),
            );
          }
          throw jobStoreResult.reason;
        }
        if (eventTransportResult.status === 'rejected') {
          throw eventTransportResult.reason;
        }
        this.lifecycleState = 'destroyed';
        logger.debug('[GenerationJobManager] Destroyed');
      })
      .catch((error) => {
        this.lifecycleState = 'teardown-failed';
        throw error;
      });
    return this.destroyPromise;
  }
}

export const GenerationJobManager = new GenerationJobManagerClass();
export { GenerationJobManagerClass };
