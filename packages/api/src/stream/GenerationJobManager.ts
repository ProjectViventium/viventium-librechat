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
}

/* === VIVENTIUM START ===
 * Purpose: Keep every asynchronous manager operation bound to one immutable
 * store/transport generation across teardown and reconfiguration.
 */
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
   * Purpose: Lock configuration from the first store/transport use until a
   * successful asynchronous teardown completes, including before initialize().
   */
  /** Job metadata + content state storage - swappable for Redis, etc. */
  private _jobStore: IJobStore;
  /** Event pub/sub transport - swappable for Redis Pub/Sub, etc. */
  private _eventTransport: IEventTransport;
  private lifecycleState:
    'configurable' | 'active' | 'destroying' | 'destroyed' | 'teardown-failed' = 'configurable';

  private destroyPromise?: Promise<void>;
  private serviceGeneration = 0;

  private markActive(): void {
    if (this.lifecycleState === 'configurable' || this.lifecycleState === 'active') {
      this.lifecycleState = 'active';
      return;
    }
    throw new Error('[GenerationJobManager] Configure services before using a destroyed manager');
  }

  private get jobStore(): IJobStore {
    this.markActive();
    return this._jobStore;
  }

  private get eventTransport(): IEventTransport {
    this.markActive();
    return this._eventTransport;
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
      throw new Error(
        '[GenerationJobManager] Operation rejected because service generation changed',
      );
    }
  }
  /* === VIVENTIUM END === */

  /** Runtime state - always in-memory, not serializable */
  private runtimeState = new Map<string, RuntimeJobState>();

  private cleanupInterval: NodeJS.Timeout | null = null;

  /** Whether we're using Redis stores */
  private _isRedis = false;

  /** Whether to cleanup event transport immediately on job completion */
  private _cleanupOnComplete = true;

  /* === VIVENTIUM START ===
   * Purpose: Assign initial services without treating startup configuration as
   * runtime use; guarded accessors lock configuration on first actual use.
   */
  constructor(options?: GenerationJobManagerOptions) {
    this._jobStore =
      options?.jobStore ?? new InMemoryJobStore({ ttlAfterComplete: 0, maxJobs: 1000 });
    this._eventTransport = options?.eventTransport ?? new InMemoryEventTransport();
    this._cleanupOnComplete = options?.cleanupOnComplete ?? true;
  }
  /* === VIVENTIUM END === */

  /**
   * Initialize the job manager with periodic cleanup.
   * Call this once at application startup.
   */
  initialize(): void {
    /* === VIVENTIUM START ===
     * Purpose: Preserve idempotent initialization while lifecycle state owns
     * the fail-closed reconfiguration boundary.
     */
    if (this.lifecycleState === 'active' && this.cleanupInterval) {
      return;
    }
    /* === VIVENTIUM END === */

    this.jobStore.initialize();

    this.cleanupInterval = setInterval(() => {
      void this.cleanup().catch((error) => {
        if (this.lifecycleState === 'active') {
          logger.error('[GenerationJobManager] Periodic cleanup failed:', error);
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
    /* === VIVENTIUM START ===
     * Purpose: Reconfiguration is a startup-only boundary. Failing closed
     * prevents in-flight operations from mutating replacement services while
     * asynchronous teardown is still draining the old generation.
     */
    if (this.lifecycleState !== 'configurable' && this.lifecycleState !== 'destroyed') {
      throw new Error(
        '[GenerationJobManager] Destroy the active manager before reconfiguring services',
      );
    }

    this._jobStore = services.jobStore;
    this._eventTransport = services.eventTransport;
    this._isRedis = services.isRedis ?? false;
    this._cleanupOnComplete = services.cleanupOnComplete ?? true;
    this.lifecycleState = 'configurable';
    this.destroyPromise = undefined;
    this.serviceGeneration++;
    /* === VIVENTIUM END === */

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
  ): Promise<t.GenerationJob> {
    /* === VIVENTIUM START ===
     * Purpose: Bind the whole asynchronous create flow to one service generation
     * so an old completion cannot mutate replacement runtime or services.
     */
    const services = this.captureServices();
    const { generation, jobStore, eventTransport } = services;
    const jobData = await jobStore.createJob(streamId, userId, conversationId);
    this.assertServiceGeneration(generation);
    /* === VIVENTIUM END === */

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
    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const runtime: RuntimeJobState = {
      abortController: new AbortController(),
      readyPromise,
      resolveReady: resolveReady!,
      syncSent: false,
      earlyEventBuffer: [],
      hasSubscriber: false,
    };
    this.runtimeState.set(streamId, runtime);

    // Resolve immediately - early event buffer handles late subscribers
    resolveReady!();

    /**
     * Set up all-subscribers-left callback.
     * When all SSE clients disconnect, this:
     * 1. Resets syncSent so reconnecting clients get sync event (persisted to Redis)
     * 2. Calls any registered allSubscribersLeft handlers (e.g., to save partial responses)
     */
    eventTransport.onAllSubscribersLeft(streamId, () => {
      if (generation !== this.serviceGeneration) {
        return;
      }
      const currentRuntime = this.runtimeState.get(streamId);
      if (currentRuntime === runtime) {
        currentRuntime.syncSent = false;
        currentRuntime.hasSubscriber = false;
        // Persist syncSent=false to Redis for cross-replica consistency
        jobStore.updateJob(streamId, { syncSent: false }).catch((err) => {
          logger.error(`[GenerationJobManager] Failed to persist syncSent=false:`, err);
        });
        // Call registered handlers (from job.emitter.on('allSubscribersLeft', ...))
        if (currentRuntime.allSubscribersLeftHandlers) {
          jobStore
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

    /**
     * Set up cross-replica abort listener (Redis mode only).
     * When abort is triggered on ANY replica, this replica receives the signal
     * and aborts its local AbortController (if it's the one running generation).
     */
    if (eventTransport.onAbort) {
      try {
        /* === VIVENTIUM START ===
         * Purpose: Do not report a Redis-backed job as created until its
         * cross-replica abort channel is actually live.
         * === VIVENTIUM END === */
        await eventTransport.onAbort(streamId, () => {
          if (generation !== this.serviceGeneration) {
            return;
          }
          const currentRuntime = this.runtimeState.get(streamId);
          if (currentRuntime === runtime && !currentRuntime.abortController.signal.aborted) {
            logger.debug(`[GenerationJobManager] Received cross-replica abort for ${streamId}`);
            currentRuntime.abortController.abort();
          }
        });
        this.assertServiceGeneration(generation);
      } catch (error) {
        if (generation === this.serviceGeneration) {
          eventTransport.cleanup(streamId);
          if (this.runtimeState.get(streamId) === runtime) {
            this.runtimeState.delete(streamId);
          }
          await jobStore.deleteJob(streamId);
        }
        throw error;
      }
    }

    logger.debug(`[GenerationJobManager] Created job: ${streamId}`);

    // Return facade for backwards compatibility
    return this.buildJobFacade(streamId, jobData, runtime, eventTransport);
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
    eventTransport: IEventTransport,
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
      listenerCount: () => eventTransport.getSubscriberCount(streamId),
      setMaxListeners: () => {
        /* no-op for proxy */
      },
      removeAllListeners: () => eventTransport.cleanup(streamId),
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
    services: ServiceGenerationSnapshot,
  ): Promise<RuntimeJobState | null> {
    const { generation, jobStore, eventTransport } = services;
    this.assertServiceGeneration(generation);
    const existingRuntime = this.runtimeState.get(streamId);
    if (existingRuntime) {
      return existingRuntime;
    }

    // Job doesn't exist locally - check Redis
    const jobData = await jobStore.getJob(streamId);
    this.assertServiceGeneration(generation);
    if (!jobData) {
      return null;
    }

    // Cross-replica scenario: job exists in Redis but not locally
    // Create minimal runtime state for handling reconnection/subscription
    logger.debug(`[GenerationJobManager] Creating cross-replica runtime for ${streamId}`);

    let resolveReady: () => void;
    const readyPromise = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    // For jobs created on other replicas, readyPromise should be pre-resolved
    // since generation has already started
    resolveReady!();

    // Parse finalEvent from Redis if available
    let finalEvent: t.ServerSentEvent | undefined;
    if (jobData.finalEvent) {
      try {
        finalEvent = JSON.parse(jobData.finalEvent) as t.ServerSentEvent;
      } catch {
        // Ignore parse errors
      }
    }

    const runtime: RuntimeJobState = {
      abortController: new AbortController(),
      readyPromise,
      resolveReady: resolveReady!,
      syncSent: jobData.syncSent ?? false,
      earlyEventBuffer: [],
      hasSubscriber: false,
      finalEvent,
      errorEvent: jobData.error,
    };

    this.runtimeState.set(streamId, runtime);

    // Set up all-subscribers-left callback for this replica
    eventTransport.onAllSubscribersLeft(streamId, () => {
      if (generation !== this.serviceGeneration) {
        return;
      }
      const currentRuntime = this.runtimeState.get(streamId);
      if (currentRuntime === runtime) {
        currentRuntime.syncSent = false;
        currentRuntime.hasSubscriber = false;
        // Persist syncSent=false to Redis
        jobStore.updateJob(streamId, { syncSent: false }).catch((err) => {
          logger.error(`[GenerationJobManager] Failed to persist syncSent=false:`, err);
        });
        // Call registered handlers
        if (currentRuntime.allSubscribersLeftHandlers) {
          jobStore
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

    // Set up cross-replica abort listener (Redis mode only)
    // This ensures lazily-initialized jobs can receive abort signals
    if (eventTransport.onAbort) {
      try {
        /* === VIVENTIUM START ===
         * Purpose: A lazily created replica runtime is usable only after its
         * abort subscription is acknowledged.
         * === VIVENTIUM END === */
        await eventTransport.onAbort(streamId, () => {
          if (generation !== this.serviceGeneration) {
            return;
          }
          const currentRuntime = this.runtimeState.get(streamId);
          if (currentRuntime === runtime && !currentRuntime.abortController.signal.aborted) {
            logger.debug(
              `[GenerationJobManager] Received cross-replica abort for lazily-init job ${streamId}`,
            );
            currentRuntime.abortController.abort();
          }
        });
        this.assertServiceGeneration(generation);
      } catch (error) {
        if (generation === this.serviceGeneration) {
          eventTransport.cleanup(streamId);
          if (this.runtimeState.get(streamId) === runtime) {
            this.runtimeState.delete(streamId);
          }
        }
        throw error;
      }
    }

    this.assertServiceGeneration(generation);
    return runtime;
  }

  /**
   * Get a job by streamId.
   */
  async getJob(streamId: string): Promise<t.GenerationJob | undefined> {
    /* === VIVENTIUM START ===
     * Purpose: A lazy lookup may outlive teardown; never let it attach old job
     * data or callbacks to replacement services.
     */
    const services = this.captureServices();
    const jobData = await services.jobStore.getJob(streamId);
    this.assertServiceGeneration(services.generation);
    if (!jobData) {
      return undefined;
    }

    const runtime = await this.getOrCreateRuntimeState(streamId, services);
    this.assertServiceGeneration(services.generation);
    if (!runtime) {
      return undefined;
    }

    return this.buildJobFacade(streamId, jobData, runtime, services.eventTransport);
    /* === VIVENTIUM END === */
  }

  /**
   * Check if a job exists.
   */
  async hasJob(streamId: string): Promise<boolean> {
    const services = this.captureServices();
    const hasJob = await services.jobStore.hasJob(streamId);
    this.assertServiceGeneration(services.generation);
    return hasJob;
  }

  /**
   * Get job status.
   */
  async getJobStatus(streamId: string): Promise<t.GenerationJobStatus | undefined> {
    const services = this.captureServices();
    const jobData = await services.jobStore.getJob(streamId);
    this.assertServiceGeneration(services.generation);
    return jobData?.status as t.GenerationJobStatus | undefined;
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
     * Purpose: Completion may overlap shutdown; keep every awaited continuation
     * on its original services and reject before touching replacement state.
     */
    const services = this.captureServices();
    const { generation, jobStore, cleanupOnComplete } = services;
    const runtime = this.runtimeState.get(streamId);

    // Abort the controller to signal all pending operations (e.g., OAuth flow monitors)
    // that the job is done and they should clean up
    if (runtime) {
      runtime.abortController.abort();
    }

    // Clear content state and run step buffer (Redis only)
    jobStore.clearContentState(streamId);
    this.runStepBuffers?.delete(streamId);

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
      await jobStore.updateJob(streamId, {
        status: 'error',
        completedAt: Date.now(),
        error,
      });
      this.assertServiceGeneration(generation);
      // Keep runtime state so subscribe() can access errorEvent
      logger.debug(
        `[GenerationJobManager] Job completed with error (keeping for late subscribers): ${streamId}`,
      );
      return;
    }

    // Immediate cleanup if configured (default: true) - only for successful completions
    if (cleanupOnComplete) {
      // Don't cleanup eventTransport here - let the done event fully transmit first.
      // EventTransport will be cleaned up when subscribers disconnect or by periodic cleanup.
      await jobStore.deleteJob(streamId);
      this.assertServiceGeneration(generation);
      if (!runtime || this.runtimeState.get(streamId) === runtime) {
        this.runtimeState.delete(streamId);
      }
    } else {
      // Only update status if keeping the job around
      await jobStore.updateJob(streamId, {
        status: 'complete',
        completedAt: Date.now(),
      });
      this.assertServiceGeneration(generation);
    }

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
     * Purpose: A delayed abort must never target a replacement same-stream job
     * after manager teardown and reconfiguration.
     */
    const services = this.captureServices();
    const { generation, jobStore, eventTransport, cleanupOnComplete } = services;
    const jobData = await jobStore.getJob(streamId);
    this.assertServiceGeneration(generation);
    const runtime = this.runtimeState.get(streamId);

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

    // Emit abort signal for cross-replica support (Redis mode)
    // This ensures the generating replica receives the abort signal
    if (eventTransport.emitAbort) {
      eventTransport.emitAbort(streamId);
    }

    // Also abort local controller if we have it (same-replica abort)
    if (runtime) {
      runtime.abortController.abort();
    }

    /** Content before clearing state */
    const result = await jobStore.getContentParts(streamId);
    this.assertServiceGeneration(generation);
    const content = result?.content ?? [];

    /** Collected usage for all models */
    const collectedUsage = jobStore.getCollectedUsage(streamId);

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

    await eventTransport.emitDone(streamId, abortFinalEvent);
    this.assertServiceGeneration(generation);
    jobStore.clearContentState(streamId);
    this.runStepBuffers?.delete(streamId);

    // Immediate cleanup if configured (default: true)
    if (cleanupOnComplete) {
      // Don't cleanup eventTransport here - let the abort event fully transmit first.
      await jobStore.deleteJob(streamId);
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
   * @param signal - Optional request-lifetime cancellation signal
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
     * Purpose: Keep lazy runtime lookup, stored status, subscription readiness,
     * and post-readiness mutation on one service generation.
     */
    const services = this.captureServices();
    const { generation, jobStore, eventTransport } = services;
    const createCancellationError = () => {
      const error = new Error('Generation stream subscription cancelled');
      error.name = 'AbortError';
      return error;
    };
    if (signal?.aborted) {
      throw createCancellationError();
    }
    // Use lazy initialization to support cross-replica subscriptions
    const runtime = await this.getOrCreateRuntimeState(streamId, services);
    this.assertServiceGeneration(generation);
    if (signal?.aborted) {
      throw createCancellationError();
    }
    if (!runtime) {
      return null;
    }

    const jobData = await jobStore.getJob(streamId);
    this.assertServiceGeneration(generation);
    if (signal?.aborted) {
      throw createCancellationError();
    }

    // If job already complete/error, send final event or error
    // Error status takes precedence to ensure errors aren't misreported as successes
    setImmediate(() => {
      if (generation !== this.serviceGeneration || this.runtimeState.get(streamId) !== runtime) {
        return;
      }
      if (jobData && ['complete', 'error', 'aborted'].includes(jobData.status)) {
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

    const subscription = eventTransport.subscribe(streamId, {
      onChunk: (event) => {
        const e = event as t.ServerSentEvent;
        // Filter out internal events
        if (!(e as Record<string, unknown>)._internal) {
          onChunk(e);
        }
      },
      onDone: (event) => onDone?.(event as t.ServerSentEvent),
      onError,
    });

    /* === VIVENTIUM START ===
     * Purpose: A Redis subscription is not live until Redis acknowledges it.
     * Await that boundary before generation is allowed to publish its first
     * chunk; otherwise fast first responses can be silently lost.
     * === VIVENTIUM END === */
    let onAbort: () => void = () => undefined;
    try {
      const cancellation = new Promise<never>((_, reject) => {
        onAbort = () => reject(createCancellationError());
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) {
          onAbort();
        }
      });
      await (signal ? Promise.race([subscription.ready, cancellation]) : subscription.ready);
      this.assertServiceGeneration(generation);
    } catch (error) {
      subscription.unsubscribe();
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    // Check if this is the first subscriber
    const isFirst = eventTransport.isFirstSubscriber(streamId);

    // First subscriber: replay buffered events and mark as connected
    if (!runtime.hasSubscriber) {
      /* === VIVENTIUM START ===
       * Purpose: On reconnect, align Redis subscriber ordering with the
       * current publisher sequence before new chunks arrive. Without this,
       * stale expected sequence numbers can buffer fresh chunks until timeout.
       * === VIVENTIUM END === */
      if (isFirst) {
        eventTransport.syncReorderBuffer?.(streamId);
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

    this.assertServiceGeneration(generation);
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
    /* === VIVENTIUM START ===
     * Purpose: Streaming emits stay on one service generation through their
     * asynchronous transport acknowledgement.
     */
    const services = this.captureServices();
    const { generation, jobStore, eventTransport, isRedis } = services;
    const runtime = this.runtimeState.get(streamId);
    if (!runtime || runtime.abortController.signal.aborted) {
      return;
    }

    // Track user message from created event
    this.trackUserMessage(streamId, event);

    // For Redis mode, persist chunk for later reconstruction (fire-and-forget for resumability)
    if (isRedis) {
      // The SSE event structure is { event: string, data: unknown, ... }
      // The aggregator expects { event: string, data: unknown } where data is the payload
      const eventObj = event as Record<string, unknown>;
      const eventType = eventObj.event as string | undefined;
      const eventData = eventObj.data;

      if (eventType && eventData !== undefined) {
        // Store in format expected by aggregateContent: { event, data }
        jobStore.appendChunk(streamId, { event: eventType, data: eventData }).catch((err) => {
          logger.error(`[GenerationJobManager] Failed to append chunk:`, err);
        });

        // For run step events, also save to run steps key for quick retrieval
        if (eventType === 'on_run_step' || eventType === 'on_run_step_completed') {
          this.saveRunStepFromEvent(streamId, eventData as Record<string, unknown>);
        }
      }
    }

    // Buffer early events if no subscriber yet (replay when first subscriber connects)
    if (!runtime.hasSubscriber) {
      runtime.earlyEventBuffer.push(event);
    }

    // Await the transport emit - critical for Redis mode to maintain event order
    await eventTransport.emitChunk(streamId, event);
    this.assertServiceGeneration(generation);
    /* === VIVENTIUM END === */
  }

  /**
   * Extract and save run step from event data.
   * The data is already the run step object from the event payload.
   */
  private saveRunStepFromEvent(streamId: string, data: Record<string, unknown>): void {
    // The data IS the run step object
    const runStep = data as Agents.RunStep;
    if (!runStep.id) {
      return;
    }

    // Fire and forget - accumulate run steps
    this.accumulateRunStep(streamId, runStep);
  }

  /**
   * Accumulate run steps for a stream (Redis mode only).
   * Uses a simple in-memory buffer that gets flushed to Redis.
   * Not used in in-memory mode - run steps come from live graph via WeakRef.
   */
  private runStepBuffers: Map<string, Agents.RunStep[]> | null = null;

  private accumulateRunStep(streamId: string, runStep: Agents.RunStep): void {
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
    if (this.jobStore.saveRunSteps) {
      this.jobStore.saveRunSteps(streamId, buffer).catch((err) => {
        logger.error(`[GenerationJobManager] Failed to save run steps:`, err);
      });
    }
  }

  /**
   * Track user message from created event.
   */
  private trackUserMessage(streamId: string, event: t.ServerSentEvent): void {
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

    this.jobStore.updateJob(streamId, updates);
  }

  /**
   * Update job metadata.
   */
  async updateMetadata(
    streamId: string,
    metadata: Partial<t.GenerationJobMetadata>,
  ): Promise<void> {
    /* === VIVENTIUM START ===
     * Purpose: Metadata persistence must not report success after its service
     * generation has been replaced.
     */
    const services = this.captureServices();
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
    await services.jobStore.updateJob(streamId, updates);
    this.assertServiceGeneration(services.generation);
    /* === VIVENTIUM END === */
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
    /* === VIVENTIUM START ===
     * Purpose: Resume state cannot combine metadata from an old store with
     * content from replacement services.
     */
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
    /* === VIVENTIUM END === */
  }

  /**
   * Mark that sync has been sent.
   * Persists to Redis for cross-replica consistency.
   */
  markSyncSent(streamId: string): void {
    /* === VIVENTIUM START ===
     * Purpose: Fire-and-forget persistence still captures its originating store
     * instead of resolving a replacement service later.
     */
    const services = this.captureServices();
    const runtime = this.runtimeState.get(streamId);
    if (runtime) {
      runtime.syncSent = true;
    }
    // Persist to Redis for cross-replica consistency
    services.jobStore.updateJob(streamId, { syncSent: true }).catch((err) => {
      logger.error(`[GenerationJobManager] Failed to persist syncSent flag:`, err);
    });
    /* === VIVENTIUM END === */
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
    const services = this.captureServices();
    const jobData = await services.jobStore.getJob(streamId);
    this.assertServiceGeneration(services.generation);
    return jobData?.syncSent ?? false;
  }

  /**
   * Emit a done event.
   * Persists finalEvent to Redis for cross-replica access.
   */
  async emitDone(streamId: string, event: t.ServerSentEvent): Promise<void> {
    /* === VIVENTIUM START ===
     * Purpose: Terminal persistence and delivery share one immutable service
     * generation and reject stale completion.
     */
    const services = this.captureServices();
    const runtime = this.runtimeState.get(streamId);
    if (runtime) {
      runtime.finalEvent = event;
    }
    // Persist finalEvent to Redis for cross-replica consistency
    void services.jobStore
      .updateJob(streamId, { finalEvent: JSON.stringify(event) })
      .catch((error) => {
        logger.error(`[GenerationJobManager] Failed to persist terminal event:`, error);
      });
    await services.eventTransport.emitDone(streamId, event);
    this.assertServiceGeneration(services.generation);
    /* === VIVENTIUM END === */
  }

  /**
   * Emit an error event.
   * Stores the error for late-connecting subscribers (race condition where error
   * occurs before client connects to SSE stream).
   */
  async emitError(streamId: string, error: string): Promise<void> {
    /* === VIVENTIUM START ===
     * Purpose: Error persistence and delivery share one immutable service
     * generation and reject stale completion.
     */
    const services = this.captureServices();
    const runtime = this.runtimeState.get(streamId);
    if (runtime) {
      runtime.errorEvent = error;
    }
    // Persist error to job store for cross-replica consistency
    void services.jobStore.updateJob(streamId, { error }).catch((persistError) => {
      logger.error(`[GenerationJobManager] Failed to persist terminal error:`, persistError);
    });
    await services.eventTransport.emitError(streamId, error);
    this.assertServiceGeneration(services.generation);
    /* === VIVENTIUM END === */
  }

  /**
   * Cleanup expired jobs.
   * Also cleans up any orphaned runtime state, buffers, and event transport entries.
   */
  private async cleanup(): Promise<void> {
    /* === VIVENTIUM START ===
     * Purpose: Periodic cleanup must stop at the generation boundary instead
     * of traversing replacement runtime, store, or transport state.
     */
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
      if (!jobExists) {
        if (!this.runtimeState.has(streamId)) {
          eventTransport.cleanup(streamId);
        }
      }
    }

    if (count > 0) {
      logger.debug(`[GenerationJobManager] Cleaned up ${count} expired jobs`);
    }
    /* === VIVENTIUM END === */
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
    const services = this.captureServices();
    const jobData = await services.jobStore.getJob(streamId);
    this.assertServiceGeneration(services.generation);
    if (!jobData) {
      return null;
    }

    const result = await services.jobStore.getContentParts(streamId);
    this.assertServiceGeneration(services.generation);
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
    const services = this.captureServices();
    const count = await services.jobStore.getJobCount();
    this.assertServiceGeneration(services.generation);
    return count;
  }

  /**
   * Get job count by status.
   */
  async getJobCountByStatus(): Promise<Record<t.GenerationJobStatus, number>> {
    const services = this.captureServices();
    const [running, complete, error, aborted] = await Promise.all([
      services.jobStore.getJobCountByStatus('running'),
      services.jobStore.getJobCountByStatus('complete'),
      services.jobStore.getJobCountByStatus('error'),
      services.jobStore.getJobCountByStatus('aborted'),
    ]);
    this.assertServiceGeneration(services.generation);
    return { running, complete, error, aborted };
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
    const services = this.captureServices();
    const activeJobIds = await services.jobStore.getActiveJobIdsByUser(userId);
    this.assertServiceGeneration(services.generation);
    return activeJobIds;
  }

  /**
   * Destroy the manager.
   * Cleans up all resources including runtime state, buffers, and stores.
   */
  /* === VIVENTIUM START ===
   * Purpose: Make teardown idempotent, keep configuration locked until both
   * services settle, and retain a failed state when teardown is incomplete.
   */
  destroy(): Promise<void> {
    if (this.destroyPromise) {
      return this.destroyPromise;
    }

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const jobStore = this._jobStore;
    const eventTransport = this._eventTransport;
    this.serviceGeneration++;
    this.lifecycleState = 'destroying';
    this.runtimeState.clear();
    this.runStepBuffers?.clear();
    this.destroyPromise = Promise.allSettled([jobStore.destroy(), eventTransport.destroy()])
      .then(([jobStoreResult, eventTransportResult]) => {
        if (jobStoreResult.status === 'rejected') {
          if (eventTransportResult.status === 'rejected') {
            logger.error(
              '[GenerationJobManager] Event transport teardown also failed:',
              eventTransportResult.reason,
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
  /* === VIVENTIUM END === */
}

export const GenerationJobManager = new GenerationJobManagerClass();
export { GenerationJobManagerClass };
