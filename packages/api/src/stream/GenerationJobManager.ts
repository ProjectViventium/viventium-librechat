import { logger } from '@librechat/data-schemas';
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
} from './interfaces/IJobStore';
import type * as t from '~/types';
import { InMemoryEventTransport } from './implementations/InMemoryEventTransport';
import { InMemoryJobStore } from './implementations/InMemoryJobStore';

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
  abortController: AbortController;
  readyPromise: Promise<void>;
  resolveReady: () => void;
  finalEvent?: t.ServerSentEvent;
  errorEvent?: string;
  syncSent: boolean;
  earlyEventBuffer: t.ServerSentEvent[];
  hasSubscriber: boolean;
  allSubscribersLeftHandlers?: Array<(...args: unknown[]) => void>;
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
  /** Job metadata + content state storage - swappable for Redis, etc. */
  private jobStore: IJobStore;
  /** Event pub/sub transport - swappable for Redis Pub/Sub, etc. */
  private eventTransport: IEventTransport;

  /** Runtime state - always in-memory, not serializable */
  private runtimeState = new Map<string, RuntimeJobState>();

  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Whether we're using Redis stores */
  private _isRedis = false;

  /** Whether to cleanup event transport immediately on job completion */
  private _cleanupOnComplete = true;
  private lifecycleEpoch = 0;
  private pendingAdmissions = 0;
  private unavailable = false;
  private lifecycleAbortController = new AbortController();

  /* === VIVENTIUM START ===
   * Feature: Stream-manager lifecycle fencing.
   * Purpose: Old asynchronous reads may only observe and clean up their captured services.
   */
  private captureLifecycle(): ManagerLifecycleSnapshot {
    return {
      epoch: this.lifecycleEpoch,
      jobStore: this.jobStore,
      eventTransport: this.eventTransport,
      signal: this.lifecycleAbortController.signal,
      isRedis: this._isRedis,
      cleanupOnComplete: this._cleanupOnComplete,
    };
  }

  private isLifecycleCurrent(lifecycle: ManagerLifecycleSnapshot): boolean {
    return (
      !this.unavailable &&
      !lifecycle.signal.aborted &&
      lifecycle.epoch === this.lifecycleEpoch &&
      lifecycle.jobStore === this.jobStore &&
      lifecycle.eventTransport === this.eventTransport
    );
  }

  private async awaitRuntimeInitialization(
    streamId: string,
    runtime: RuntimeJobState,
    lifecycle: ManagerLifecycleSnapshot,
  ): Promise<RuntimeJobState> {
    if (runtime.initializationReady) {
      await awaitLifecycle(runtime.initializationReady, lifecycle.signal);
    }
    if (!this.isLifecycleCurrent(lifecycle) || this.runtimeState.get(streamId) !== runtime) {
      throw streamManagerUnavailableError();
    }
    return runtime;
  }

  private assertLifecycleOperation(
    lifecycle: ManagerLifecycleSnapshot,
    streamId?: string,
    expectedRuntime: RuntimeJobState | undefined | null = null,
  ): void {
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
    const result = await awaitLifecycle(operation(), lifecycle.signal);
    this.assertLifecycleOperation(lifecycle, streamId, expectedRuntime);
    return result;
  }
  /* === VIVENTIUM END === */

  constructor(options?: GenerationJobManagerOptions) {
    this.jobStore =
      options?.jobStore ?? new InMemoryJobStore({ ttlAfterComplete: 0, maxJobs: 1000 });
    this.eventTransport = options?.eventTransport ?? new InMemoryEventTransport();
    this._cleanupOnComplete = options?.cleanupOnComplete ?? true;
  }

  /**
   * Initialize the job manager with periodic cleanup.
   * Call this once at application startup.
   */
  initialize(): void {
    if (this.cleanupInterval) {
      return;
    }

    this.jobStore.initialize();

    this.cleanupInterval = setInterval(() => {
      void this.cleanup().catch((error: { code?: string }) => {
        if (error?.code !== 'stream_store_unavailable') {
          logger.warn('[GenerationJobManager] Periodic cleanup unavailable');
        }
      });
    }, 60000);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.debug('[GenerationJobManager] Initialized');
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
   * GenerationJobManager.initialize();
   * ```
   */
  configure(services: {
    jobStore: IJobStore;
    eventTransport: IEventTransport;
    isRedis?: boolean;
    cleanupOnComplete?: boolean;
  }): void {
    if (this.pendingAdmissions > 0) {
      throw streamManagerUnavailableError();
    }
    const wasInitialized = this.cleanupInterval != null;
    const previousJobStore = this.jobStore;
    const previousEventTransport = this.eventTransport;
    if (this.cleanupInterval) {
      logger.warn(
        '[GenerationJobManager] Reconfiguring after initialization - destroying existing services',
      );
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

    this.jobStore = services.jobStore;
    this.eventTransport = services.eventTransport;
    this._isRedis = services.isRedis ?? false;
    this._cleanupOnComplete = services.cleanupOnComplete ?? true;
    this.unavailable = false;

    if (previousEventTransport !== services.eventTransport) {
      previousEventTransport.destroy();
    }
    if (previousJobStore !== services.jobStore) {
      void previousJobStore.destroy().catch((error) => {
        logger.error('[GenerationJobManager] Previous job store destroy failed:', error);
      });
    }
    if (wasInitialized) {
      this.initialize();
    }

    logger.info(
      `[GenerationJobManager] Configured with ${this._isRedis ? 'Redis' : 'in-memory'} stores`,
    );
  }

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

  /** Persist an adapter's terminal presentation outcome against server-held turn ownership. */
  async acknowledgeDelivery(
    acknowledgement: InteractionDeliveryAck,
    adapterSurface: 'telegram' | 'voice',
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
    return this.recordDeliveryAcknowledgement(acknowledgement, lifecycle, ownerStreamId!, runtime);
  }

  private async recordDeliveryAcknowledgement(
    acknowledgement: InteractionDeliveryAck,
    lifecycle: ManagerLifecycleSnapshot = this.captureLifecycle(),
    expectedOwnerStreamId?: string,
    expectedRuntime: RuntimeJobState | undefined = expectedOwnerStreamId
      ? this.runtimeState.get(expectedOwnerStreamId)
      : undefined,
  ): Promise<DeliveryAcknowledgementResult> {
    const result = await this.runLifecycleOperation(
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
    const runtime = expectedOwnerStreamId
      ? expectedRuntime
      : this.runtimeState.get(result.ownerStreamId);
    const ownerJob = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(result.ownerStreamId!),
      result.ownerStreamId,
      runtime,
    );
    const presentation = ownerJob
      ? {
          userId: ownerJob.userId,
          conversationId: ownerJob.conversationId,
          responseMessageId: ownerJob.responseMessageId,
          interactionContext: ownerJob.interactionContext,
        }
      : undefined;
    await this.runLifecycleOperation(
      lifecycle,
      () =>
        lifecycle.jobStore.updateJob(result.ownerStreamId!, {
          deliveryAcknowledgement: result.acknowledgement,
        }),
      result.ownerStreamId,
      runtime,
    );
    const job = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(result.ownerStreamId!),
      result.ownerStreamId,
      runtime,
    );
    if (acknowledgement.state === 'committed' && job?.generationCompleted === true) {
      await this.finalizeCompletedJob(
        result.ownerStreamId,
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
      job.deliveryPolicy?.commit_authority === 'external_adapter'
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
      if (this.unavailable || lifecycleEpoch !== this.lifecycleEpoch) {
        if (!job.abortController.signal.aborted) {
          job.abortController.abort('manager_lifecycle_changed');
        }
        await lifecycleJobStore.deleteJob(streamId);
        lifecycleEventTransport.cleanup(streamId);
        throw streamManagerUnavailableError();
      }
      return job;
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
          throw new Error(`Duplicate source event references unavailable stream ${claim.streamId}`);
        }
        const persistedContext = persistedJob.interactionContext;
        if (
          persistedJob.userId !== userId ||
          !persistedContext?.logical_turn_id ||
          persistedContext.logical_turn_id !== claim.interactionContext.logical_turn_id ||
          persistedContext.revision !== claim.interactionContext.revision ||
          persistedContext.source_event_id !== claim.interactionContext.source_event_id
        ) {
          throw streamReceiptConflictError();
        }
        const duplicateJob = await this.getJob(claim.streamId);
        if (!duplicateJob) {
          throw new Error(`Duplicate source event references unavailable stream ${claim.streamId}`);
        }
        duplicateJob.duplicateOfStreamId = claim.streamId;
        return duplicateJob;
      }
      supersededStreamIds = claim.supersededStreamIds;
      logicalTurnClaim = claim;
    }

    const staleRuntime = this.runtimeState.get(streamId);
    if (staleRuntime) {
      if (await this.jobStore.hasJob(streamId)) {
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
          this.eventTransport.onAbort(streamId, (reason) => {
            const currentRuntime = this.runtimeState.get(streamId);
            if (currentRuntime && !currentRuntime.abortController.signal.aborted) {
              logger.debug(`[GenerationJobManager] Received cross-replica abort for ${streamId}`);
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
      });
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
      throw error;
    }

    const persistedAdmission = await this.jobStore.getJob(streamId);
    if (!persistedAdmission || persistedAdmission.status !== 'running') {
      if (!runtime.abortController.signal.aborted) {
        runtime.abortController.abort('superseded');
      }
      this.runtimeState.delete(streamId);
      this.eventTransport.cleanup(streamId);
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
          logger.error(`[GenerationJobManager] Failed to persist syncSent=false:`, err);
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
                  logger.error(`[GenerationJobManager] Error in allSubscribersLeft handler:`, err);
                }
              }
            })
            .catch((err) => {
              logger.error(
                `[GenerationJobManager] Failed to get content parts for allSubscribersLeft handlers:`,
                err,
              );
            });
        }
      }
    });

    logger.debug(`[GenerationJobManager] Created job: ${streamId}`);

    const supersededPresentations: NonNullable<t.GenerationJob['supersededPresentations']> = [];
    for (const supersededStreamId of supersededStreamIds) {
      const supersededJob = await this.jobStore.getJob(supersededStreamId);
      if (supersededJob?.deliveryAcknowledgement?.state !== 'committed') {
        supersededPresentations.push({
          conversationId: supersededJob?.conversationId,
          responseMessageId: supersededJob?.responseMessageId,
          interactionContext: supersededJob?.interactionContext,
        });
      }
      await this.supersedeJob(supersededStreamId);
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
        interactionContext: jobData.interactionContext,
        adapterCapabilities: jobData.adapterCapabilities,
        deliveryPolicy: jobData.deliveryPolicy,
        deliveryAcknowledgement: jobData.deliveryAcknowledgement,
        generationCompleted: jobData.generationCompleted,
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
      persistedJob ?? (await awaitLifecycle(lifecycle.jobStore.getJob(streamId), lifecycle.signal));
    if (!this.isLifecycleCurrent(lifecycle)) {
      throw streamManagerUnavailableError();
    }
    if (!jobData) {
      return null;
    }

    const concurrentlyInitializedRuntime = this.runtimeState.get(streamId);
    if (concurrentlyInitializedRuntime) {
      return this.awaitRuntimeInitialization(streamId, concurrentlyInitializedRuntime, lifecycle);
    }

    logger.debug(`[GenerationJobManager] Creating cross-replica runtime for ${streamId}`);

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
          logger.error(`[GenerationJobManager] Failed to persist syncSent=false:`, err);
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
                  logger.error(`[GenerationJobManager] Error in allSubscribersLeft handler:`, err);
                }
              }
            })
            .catch((err) => {
              logger.error(
                `[GenerationJobManager] Failed to get content parts for allSubscribersLeft handlers:`,
                err,
              );
            });
        }
      });

      if (lifecycle.eventTransport.onAbort) {
        await awaitLifecycle(
          lifecycle.eventTransport.onAbort(streamId, (reason) => {
            const currentRuntime = this.runtimeState.get(streamId);
            if (
              this.isLifecycleCurrent(lifecycle) &&
              currentRuntime === runtime &&
              !currentRuntime.abortController.signal.aborted
            ) {
              logger.debug(
                `[GenerationJobManager] Received cross-replica abort for lazily-init job ${streamId}`,
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
    const jobData = await awaitLifecycle(lifecycle.jobStore.getJob(streamId), lifecycle.signal);
    if (!this.isLifecycleCurrent(lifecycle)) {
      throw streamManagerUnavailableError();
    }
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
    if (!job || job.status !== 'running') {
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
    if (!jobData || !['running', 'complete'].includes(jobData.status)) {
      return;
    }

    const context = jobData.interactionContext;
    const terminalEvent = {
      final: true,
      superseded: true,
      logical_turn_id: context?.logical_turn_id,
      revision: context?.revision,
    } as unknown as t.ServerSentEvent;
    const runtime = this.runtimeState.get(streamId);
    const stopsAuthoring = jobData.adapterCapabilities?.supersede_scope !== 'response_only';
    if (stopsAuthoring && runtime && !runtime.abortController.signal.aborted) {
      runtime.abortController.abort('superseded');
    }
    if (runtime) {
      runtime.finalEvent = terminalEvent;
    }
    await this.jobStore.updateJob(streamId, {
      status: 'superseded',
      completedAt: Date.now(),
      finalEvent: JSON.stringify(terminalEvent),
    });
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
    try {
      await this.eventTransport.emitDone(streamId, terminalEvent);
    } catch {
      logger.warn(
        '[GenerationJobManager] Superseded terminal notification unavailable after durable fence',
      );
    }
    /* === VIVENTIUM END === */
    logger.debug(`[GenerationJobManager] Job superseded: ${streamId}`);
  }

  private async finalizeCompletedJob(
    streamId: string,
    preserveJob = false,
    lifecycle: ManagerLifecycleSnapshot = this.captureLifecycle(),
    runtime: RuntimeJobState | undefined = this.runtimeState.get(streamId),
  ): Promise<void> {
    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    if (runtime && !runtime.abortController.signal.aborted) {
      runtime.abortController.abort('generation_completed');
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
      return;
    }
    const runtime = this.runtimeState.get(streamId);
    this.assertLifecycleOperation(lifecycle, streamId, runtime);

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
        `[GenerationJobManager] Job completed with error (keeping for late subscribers): ${streamId}`,
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
    const presentationCommitted = refreshedJob?.deliveryAcknowledgement?.state === 'committed';
    if (hasTrustedLifecycle && !presentationCommitted) {
      logger.debug(
        `[GenerationJobManager] Generation complete; awaiting presentation acknowledgement: ${streamId}`,
      );
      return;
    }
    await this.finalizeCompletedJob(streamId, false, lifecycle, runtime);

    logger.debug(`[GenerationJobManager] Job completed: ${streamId}`);
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
  async abortJob(streamId: string): Promise<AbortResult> {
    /* === VIVENTIUM START ===
     * Feature: Stream-manager lifecycle fencing.
     * Purpose: A stale abort may mutate only the store, transport, and runtime generation it read.
     */
    const lifecycle = this.captureLifecycle();
    const jobData = await this.runLifecycleOperation(lifecycle, () =>
      lifecycle.jobStore.getJob(streamId),
    );
    const runtime = this.runtimeState.get(streamId);
    this.assertLifecycleOperation(lifecycle, streamId, runtime);

    if (!jobData) {
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

    // Also abort local controller if we have it (same-replica abort)
    if (runtime && !runtime.abortController.signal.aborted) {
      runtime.abortController.abort('user_cancelled');
    }

    /** Content before clearing state */
    const result = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getContentParts(streamId),
      streamId,
      runtime,
    );
    const content = result?.content ?? [];

    /** Collected usage for all models */
    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    const collectedUsage = lifecycle.jobStore.getCollectedUsage(streamId);

    /** Text from content parts for fallback token counting */
    const text = parseTextParts(content as TMessageContentParts[]);

    /** Detect "early abort" - aborted before any generation happened (e.g., during tool loading)
    In this case, no messages were saved to DB, so frontend shouldn't navigate to conversation */
    const isEarlyAbort = content.length === 0 && !jobData.responseMessageId;

    /** Final event for abort */
    const userMessageId = jobData.userMessage?.messageId;

    const abortFinalEvent: t.ServerSentEvent = {
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
      responseMessage: isEarlyAbort
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
          },
      aborted: true,
      // Flag for early abort - no messages saved, frontend should go to new chat
      earlyAbort: isEarlyAbort,
    } as unknown as t.ServerSentEvent;

    if (runtime) {
      runtime.finalEvent = abortFinalEvent;
    }

    /* === VIVENTIUM START ===
     * Feature: Durable cross-replica cancellation.
     * Purpose: Persist terminal truth before best-effort Pub/Sub so a missed signal cannot retain
     * authoring authority on another replica.
     * === VIVENTIUM END === */
    await this.runLifecycleOperation(
      lifecycle,
      () =>
        lifecycle.jobStore.updateJob(streamId, {
          status: 'aborted',
          completedAt: Date.now(),
          finalEvent: JSON.stringify(abortFinalEvent),
        }),
      streamId,
      runtime,
    );
    if (lifecycle.eventTransport.emitAbort) {
      try {
        await this.runLifecycleOperation(
          lifecycle,
          () => lifecycle.eventTransport.emitAbort!(streamId, 'user_cancelled'),
          streamId,
          runtime,
        );
      } catch {
        this.assertLifecycleOperation(lifecycle, streamId, runtime);
        logger.warn('[GenerationJobManager] Abort signal unavailable after durable fence');
      }
    }

    await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.eventTransport.emitDone(streamId, abortFinalEvent),
      streamId,
      runtime,
    );
    this.assertLifecycleOperation(lifecycle, streamId, runtime);
    lifecycle.jobStore.clearContentState(streamId);
    this.runStepBuffers?.delete(streamId);
    await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.completeLogicalTurn(streamId),
      streamId,
      runtime,
    );

    // Immediate cleanup if configured (default: true)
    if (lifecycle.cleanupOnComplete) {
      // Don't cleanup eventTransport here - let the abort event fully transmit first.
      await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.deleteJob(streamId),
        streamId,
        runtime,
      );
      this.runtimeState.delete(streamId);
    } else {
      // Only update status if keeping the job around
      await this.runLifecycleOperation(
        lifecycle,
        () =>
          lifecycle.jobStore.updateJob(streamId, {
            status: 'aborted',
            completedAt: Date.now(),
          }),
        streamId,
        runtime,
      );
    }

    this.assertLifecycleOperation(lifecycle);
    logger.debug(`[GenerationJobManager] Job aborted: ${streamId}`);

    return {
      success: true,
      jobData,
      content,
      finalEvent: abortFinalEvent,
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
  ): Promise<{ unsubscribe: t.UnsubscribeFn } | null> {
    /* === VIVENTIUM START ===
     * Feature: Stream-manager lifecycle fencing.
     * Purpose: An SSE subscription cannot escape before its exact lifecycle/channel is ready.
     */
    const lifecycle = this.captureLifecycle();
    // Use lazy initialization to support cross-replica subscriptions
    const runtime = await this.getOrCreateRuntimeState(streamId, lifecycle);
    if (!runtime) {
      return null;
    }

    const jobData = await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.getJob(streamId),
      streamId,
      runtime,
    );

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
              `[GenerationJobManager] Sending stored error to late subscriber: ${streamId}`,
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
      onDone: (event) => {
        if (this.isLifecycleCurrent(lifecycle) && this.runtimeState.get(streamId) === runtime) {
          onDone?.(event as t.ServerSentEvent);
        }
      },
      onError: (error) => {
        if (this.isLifecycleCurrent(lifecycle) && this.runtimeState.get(streamId) === runtime) {
          onError?.(error);
        }
      },
    });

    try {
      if (subscription.ready) {
        await this.runLifecycleOperation(lifecycle, () => subscription.ready!, streamId, runtime);
      } else {
        this.assertLifecycleOperation(lifecycle, streamId, runtime);
      }
    } catch (error) {
      subscription.unsubscribe();
      throw error;
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
          `[GenerationJobManager] Replaying ${runtime.earlyEventBuffer.length} buffered events for ${streamId}`,
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
        `[GenerationJobManager] First subscriber ready, resolving promise for ${streamId}`,
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
  async emitChunk(streamId: string, event: t.ServerSentEvent): Promise<void> {
    const lifecycle = this.captureLifecycle();
    const runtime = this.runtimeState.get(streamId);
    if (!runtime || runtime.abortController.signal.aborted) {
      return;
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
      return;
    }

    // Track user message from created event
    this.trackUserMessage(streamId, event, lifecycle.jobStore);

    // For Redis mode, persist chunk for later reconstruction (fire-and-forget for resumability)
    if (lifecycle.isRedis) {
      // The SSE event structure is { event: string, data: unknown, ... }
      // The aggregator expects { event: string, data: unknown } where data is the payload
      const eventObj = event as Record<string, unknown>;
      const eventType = eventObj.event as string | undefined;
      const eventData = eventObj.data;

      if (eventType && eventData !== undefined) {
        // Store in format expected by aggregateContent: { event, data }
        lifecycle.jobStore
          .appendChunk(streamId, { event: eventType, data: eventData })
          .catch((err) => {
            logger.error(`[GenerationJobManager] Failed to append chunk:`, err);
          });

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

    // Buffer early events if no subscriber yet (replay when first subscriber connects)
    if (!runtime.hasSubscriber) {
      runtime.earlyEventBuffer.push(event);
    }

    // Await the transport emit - critical for Redis mode to maintain event order
    await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.eventTransport.emitChunk(streamId, event),
      streamId,
      runtime,
    );
  }

  /**
   * Extract and save run step from event data.
   * The data is already the run step object from the event payload.
   */
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
        logger.error(`[GenerationJobManager] Failed to save run steps:`, err);
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
    const updates: Partial<SerializableJobData> = {};
    if (metadata.responseMessageId) {
      updates.responseMessageId = metadata.responseMessageId;
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
    await this.jobStore.updateJob(streamId, updates);
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
    const jobData = await this.jobStore.getJob(streamId);
    if (!jobData) {
      return null;
    }

    const result = await this.jobStore.getContentParts(streamId);
    const aggregatedContent = result?.content ?? [];
    const runSteps = await this.jobStore.getRunSteps(streamId);

    logger.debug(`[GenerationJobManager] getResumeState:`, {
      streamId,
      runStepsLength: runSteps.length,
      aggregatedContentLength: aggregatedContent.length,
    });

    return {
      runSteps,
      aggregatedContent,
      userMessage: jobData.userMessage,
      responseMessageId: jobData.responseMessageId,
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
      logger.error(`[GenerationJobManager] Failed to persist syncSent flag:`, err);
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
    if (
      !(await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.isCurrentLogicalTurn(streamId),
        streamId,
        runtime,
      ))
    ) {
      await this.stopRuntimeAfterDurableFence(streamId, lifecycle, runtime);
      return;
    }
    if (runtime) {
      runtime.finalEvent = event;
    }
    // Persist finalEvent to Redis for cross-replica consistency
    await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.updateJob(streamId, { finalEvent: JSON.stringify(event) }),
      streamId,
      runtime,
    );
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
    if (
      !(await this.runLifecycleOperation(
        lifecycle,
        () => lifecycle.jobStore.isCurrentLogicalTurn(streamId),
        streamId,
        runtime,
      ))
    ) {
      await this.stopRuntimeAfterDurableFence(streamId, lifecycle, runtime);
      return;
    }
    if (runtime) {
      runtime.errorEvent = error;
    }
    // Persist error to job store for cross-replica consistency
    await this.runLifecycleOperation(
      lifecycle,
      () => lifecycle.jobStore.updateJob(streamId, { error }),
      streamId,
      runtime,
    );
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
    const lifecycle = this.captureLifecycle();
    const count = await this.runLifecycleOperation(lifecycle, () => lifecycle.jobStore.cleanup());

    // Cleanup runtime state for deleted jobs
    for (const [streamId, runtime] of this.runtimeState.entries()) {
      if (
        !(await this.runLifecycleOperation(
          lifecycle,
          () => lifecycle.jobStore.hasJob(streamId),
          streamId,
          runtime,
        ))
      ) {
        this.runtimeState.delete(streamId);
        this.runStepBuffers?.delete(streamId);
        lifecycle.jobStore.clearContentState(streamId);
        lifecycle.eventTransport.cleanup(streamId);
      }
    }

    // Also check runStepBuffers for any orphaned entries (Redis mode only)
    if (this.runStepBuffers) {
      for (const streamId of this.runStepBuffers.keys()) {
        const runtime = this.runtimeState.get(streamId);
        if (
          !(await this.runLifecycleOperation(
            lifecycle,
            () => lifecycle.jobStore.hasJob(streamId),
            streamId,
            runtime,
          ))
        ) {
          this.runStepBuffers.delete(streamId);
        }
      }
    }

    // Check eventTransport for orphaned streams (e.g., connections dropped without clean close)
    // These are streams that exist in eventTransport but have no corresponding job
    for (const streamId of lifecycle.eventTransport.getTrackedStreamIds()) {
      const runtime = this.runtimeState.get(streamId);
      if (
        !(await this.runLifecycleOperation(
          lifecycle,
          () => lifecycle.jobStore.hasJob(streamId),
          streamId,
          runtime,
        )) &&
        !runtime
      ) {
        lifecycle.eventTransport.cleanup(streamId);
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
    const streamIds = await this.jobStore.getActiveJobIdsByUser(userId);
    const conversationIds = new Set<string>();
    for (const streamId of streamIds) {
      const job = await this.jobStore.getJob(streamId);
      if (job?.status === 'running') {
        conversationIds.add(job.conversationId ?? streamId);
      }
    }
    return [...conversationIds];
  }

  /**
   * Destroy the manager.
   * Cleans up all resources including runtime state, buffers, and stores.
   */
  async destroy(): Promise<void> {
    const lifecycleJobStore = this.jobStore;
    const lifecycleEventTransport = this.eventTransport;
    this.unavailable = true;
    this.lifecycleAbortController.abort('manager_destroyed');
    this.lifecycleEpoch += 1;
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    for (const runtime of this.runtimeState.values()) {
      if (!runtime.abortController.signal.aborted) {
        runtime.abortController.abort('manager_destroyed');
      }
    }
    this.runtimeState.clear();
    this.runStepBuffers?.clear();
    lifecycleEventTransport.destroy();
    await lifecycleJobStore.destroy();

    logger.debug('[GenerationJobManager] Destroyed');
  }
}

export const GenerationJobManager = new GenerationJobManagerClass();
export { GenerationJobManagerClass };
