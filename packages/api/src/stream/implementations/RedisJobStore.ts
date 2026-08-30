import { logger } from '@librechat/data-schemas';
import { createHash, randomUUID } from 'crypto';
import { createContentAggregator } from '@librechat/agents';
import type { StandardGraph } from '@librechat/agents';
import type { Agents } from 'librechat-data-provider';
import type { Redis, Cluster } from 'ioredis';
import type {
  SerializableJobData,
  UsageMetadata,
  IJobStore,
  JobStatus,
  InteractionContext,
  LogicalTurnClaim,
  InteractionDeliveryAck,
  DeliveryAcknowledgementResult,
  DeliveryAcknowledgementBindingResult,
  SourceOrderObservation,
  SourceOrderObservationResult,
  CortexPresentationBinding,
} from '~/stream/interfaces/IJobStore';

function sourceOrderScopeDigest(sourceOrderScope: string): string {
  return createHash('sha256')
    .update(`viventium.source-order.v1\0${sourceOrderScope}`)
    .digest('hex');
}

function logicalTurnScopeDigest(userId: string, interactionContext: InteractionContext): string {
  if (interactionContext.source_order_scope) {
    return sourceOrderScopeDigest(interactionContext.source_order_scope);
  }
  return createHash('sha256')
    .update(
      [
        userId,
        interactionContext.conversation_id,
        interactionContext.actor_kind,
        interactionContext.origin,
      ].join('\u0000'),
    )
    .digest('hex');
}

function logicalTurnScopeDigestFromKey(key: string): string | null {
  return /^stream:logical:\{([a-f0-9]{64})\}$/.exec(key)?.[1] ?? null;
}

/**
 * Key prefixes for Redis storage.
 * All keys include the streamId for easy cleanup.
 * Note: streamId === conversationId, so no separate mapping needed.
 *
 * IMPORTANT: Uses hash tags {streamId} for Redis Cluster compatibility.
 * All keys for the same stream hash to the same slot, enabling:
 * - Pipeline operations across related keys
 * - Atomic multi-key operations
 */
const KEYS = {
  /** Job metadata: stream:{streamId}:job */
  job: (streamId: string) => `stream:{${streamId}}:job`,
  /** Durable first-claim ownership, co-slotted with the job. */
  streamOwner: (streamId: string) => `stream:{${streamId}}:owner`,
  /** Chunk stream (Redis Streams): stream:{streamId}:chunks */
  chunks: (streamId: string) => `stream:{${streamId}}:chunks`,
  /** Run steps: stream:{streamId}:runsteps */
  runSteps: (streamId: string) => `stream:{${streamId}}:runsteps`,
  /** Running jobs set for cleanup (global set - single slot) */
  runningJobs: 'stream:running',
  /** User's active jobs set: stream:user:{userId}:jobs */
  userJobs: (userId: string) => `stream:user:{${userId}}:jobs`,
  /** Atomic logical-turn claim state, deliberately separate from stream payload storage. */
  logicalTurn: (userId: string, interactionContext: InteractionContext) => {
    const scope = logicalTurnScopeDigest(userId, interactionContext);
    return `stream:logical:{${scope}}`;
  },
  /** Source watermark co-slots with its logical turn for atomic presentation fencing. */
  sourceOrder: (sourceOrderScope: string) => {
    const scope = sourceOrderScopeDigest(sourceOrderScope);
    return `stream:source-order:{${scope}}`;
  },
  sourceOrderFromScopeDigest: (scopeDigest: string) => `stream:source-order:{${scopeDigest}}`,
  logicalTurnFromSourceOrderScope: (sourceOrderScope: string) => {
    const scope = sourceOrderScopeDigest(sourceOrderScope);
    return `stream:logical:{${scope}}`;
  },
  /** New logical IDs carry only the irreversible scope digest needed for atomic owner lookup. */
  logicalTurnId: (userId: string, interactionContext: InteractionContext) => {
    const scope = logicalTurnScopeDigest(userId, interactionContext);
    return `${scope}.${randomUUID()}`;
  },
  logicalTurnFromId: (logicalTurnId: string) => {
    const scope = /^([a-f0-9]{64})\./.exec(logicalTurnId)?.[1];
    return scope ? `stream:logical:{${scope}}` : null;
  },
  /** Reverse lookup contains the server-owned scope key, never client ownership claims. */
  logicalTurnIndex: (logicalTurnId: string) => {
    const id = createHash('sha256').update(logicalTurnId).digest('hex');
    return `stream:logical-index:{${id}}`;
  },
};

/**
 * Default TTL values in seconds.
 * Can be overridden via constructor options.
 */
const DEFAULT_TTL = {
  /** TTL for completed jobs (5 minutes) */
  completed: 300,
  /** TTL for running jobs/chunks (20 minutes - failsafe for crashed jobs) */
  running: 1200,
  /** TTL for chunks after completion (0 = delete immediately) */
  chunksAfterComplete: 0,
  /** TTL for run steps after completion (0 = delete immediately) */
  runStepsAfterComplete: 0,
  /** TTL for inactive source watermarks (5 minutes). */
  sourceOrder: 300,
};

/**
 * Redis implementation of IJobStore.
 * Enables horizontal scaling with multi-instance deployments.
 *
 * Storage strategy:
 * - Job metadata: Redis Hash (fast field access)
 * - Chunks: Redis Streams (append-only, efficient for streaming)
 * - Run steps: Redis String (JSON serialized)
 *
 * Note: streamId === conversationId, so getJob(conversationId) works directly.
 *
 * @example
 * ```ts
 * import { ioredisClient } from '~/cache';
 * const store = new RedisJobStore(ioredisClient);
 * await store.initialize();
 * ```
 */
/**
 * Configuration options for RedisJobStore
 */
export interface RedisJobStoreOptions {
  /** TTL for completed jobs in seconds (default: 300 = 5 minutes) */
  completedTtl?: number;
  /** TTL for running jobs/chunks in seconds (default: 1200 = 20 minutes) */
  runningTtl?: number;
  /** TTL for chunks after completion in seconds (default: 0 = delete immediately) */
  chunksAfterCompleteTtl?: number;
  /** TTL for run steps after completion in seconds (default: 0 = delete immediately) */
  runStepsAfterCompleteTtl?: number;
  /** TTL for inactive source-order watermarks in seconds (default: 300). */
  sourceOrderTtl?: number;
}

export class RedisJobStore implements IJobStore {
  readonly sourceOrderDurability = 'durable' as const;

  private redis: Redis | Cluster;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private ttl: typeof DEFAULT_TTL;

  /** Whether Redis client is in cluster mode (affects pipeline usage) */
  private isCluster: boolean;

  /**
   * Local cache for graph references on THIS instance.
   * Enables fast reconnects when client returns to the same server.
   * Uses WeakRef to allow garbage collection when graph is no longer needed.
   */
  private localGraphCache = new Map<string, WeakRef<StandardGraph>>();

  /**
   * Local cache for collectedUsage arrays.
   * Generation happens on a single instance, so collectedUsage is only available locally.
   * For cross-replica abort, the abort handler falls back to text-based token counting.
   */
  private localCollectedUsageCache = new Map<string, UsageMetadata[]>();

  /** Cleanup interval in ms (1 minute) */
  private cleanupIntervalMs = 60000;

  constructor(redis: Redis | Cluster, options?: RedisJobStoreOptions) {
    this.redis = redis;
    this.ttl = {
      completed: options?.completedTtl ?? DEFAULT_TTL.completed,
      running: options?.runningTtl ?? DEFAULT_TTL.running,
      chunksAfterComplete: options?.chunksAfterCompleteTtl ?? DEFAULT_TTL.chunksAfterComplete,
      runStepsAfterComplete: options?.runStepsAfterCompleteTtl ?? DEFAULT_TTL.runStepsAfterComplete,
      sourceOrder: Math.max(1, options?.sourceOrderTtl ?? DEFAULT_TTL.sourceOrder),
    };
    // Detect cluster mode using ioredis's isCluster property
    this.isCluster = (redis as Cluster).isCluster === true;
  }

  async initialize(): Promise<void> {
    if (this.cleanupInterval) {
      return;
    }

    // Start periodic cleanup
    this.cleanupInterval = setInterval(() => {
      this.cleanup().catch((err) => {
        logger.error('[RedisJobStore] Cleanup error:', err);
      });
    }, this.cleanupIntervalMs);

    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }

    logger.info('[RedisJobStore] Initialized with cleanup interval');
  }

  async createJob(
    streamId: string,
    userId: string,
    conversationId?: string,
    initialData?: Partial<SerializableJobData>,
  ): Promise<SerializableJobData> {
    const job: SerializableJobData = {
      ...initialData,
      streamId,
      userId,
      status: 'running',
      createdAt: Date.now(),
      conversationId,
      syncSent: false,
    };

    const key = KEYS.job(streamId);
    const userJobsKey = KEYS.userJobs(userId);

    // For cluster mode, we can't pipeline keys on different slots
    // The job key uses hash tag {streamId}, runningJobs and userJobs are on different slots
    if (this.isCluster) {
      await this.redis.hset(key, this.serializeJob(job));
      await this.redis.expire(key, this.ttl.running);
      await this.redis.sadd(KEYS.runningJobs, streamId);
      await this.redis.sadd(userJobsKey, streamId);
    } else {
      const pipeline = this.redis.pipeline();
      pipeline.hset(key, this.serializeJob(job));
      pipeline.expire(key, this.ttl.running);
      pipeline.sadd(KEYS.runningJobs, streamId);
      pipeline.sadd(userJobsKey, streamId);
      await pipeline.exec();
    }

    logger.debug(`[RedisJobStore] Created job: ${streamId}`);
    return job;
  }

  async observeSourceOrder(
    observation: SourceOrderObservation,
  ): Promise<SourceOrderObservationResult> {
    const result = (await this.redis.eval(
      `local requested = tonumber(ARGV[1])
       local current = tonumber(redis.call('HGET', KEYS[1], 'latestSourceSequence') or '-1')
       local observed_at = redis.call('HGET', KEYS[1], 'sourceOrderObservedAt') or ''
       local stale = current > requested
       if requested > current then
         local server_time = redis.call('TIME')
         observed_at = tostring(
           tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
         )
         current = requested
         redis.call('HSET', KEYS[1],
           'latestSourceSequence', tostring(current),
           'sourceOrderObservedAt', observed_at)
       end
       local target_ttl = tonumber(ARGV[2])
       if redis.call('HGET', KEYS[2], 'active') == '1' then
         target_ttl = math.max(target_ttl, tonumber(ARGV[3]))
       end
       local current_ttl = redis.call('TTL', KEYS[1])
       if current_ttl < target_ttl then
         redis.call('EXPIRE', KEYS[1], target_ttl)
       end
       return {tostring(current), observed_at, stale and '1' or '0'}`,
      2,
      KEYS.sourceOrder(observation.source_order_scope),
      KEYS.logicalTurnFromSourceOrderScope(observation.source_order_scope),
      observation.source_sequence,
      this.ttl.sourceOrder,
      this.ttl.running,
    )) as [string, string, string];
    return {
      latest_source_sequence: Number(result[0]),
      observed_at: Number(result[1]),
      stale: result[2] === '1',
    };
  }

  async claimLogicalTurn(
    streamId: string,
    userId: string,
    interactionContext: InteractionContext,
  ): Promise<LogicalTurnClaim> {
    const key = KEYS.logicalTurn(userId, interactionContext);
    const result = (await this.redis.eval(
      `local receipt_key = 'receipt:' .. ARGV[2]
       local receipt = redis.call('HGET', KEYS[1], receipt_key)
       if receipt then
         local decoded = cjson.decode(receipt)
         return {'duplicate', decoded.streamId, cjson.encode(decoded.interactionContext), ''}
       end
       local logical_id = redis.call('HGET', KEYS[1], 'logicalTurnId')
       local revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
       local current = redis.call('HGET', KEYS[1], 'currentStreamId') or ''
       local active = redis.call('HGET', KEYS[1], 'active') == '1'
       local superseded = ''
       if active and current ~= '' then
         revision = revision + 1
         superseded = current
       else
         redis.call('DEL', KEYS[1])
         logical_id = ARGV[3]
         revision = 1
       end
       local context = cjson.decode(ARGV[4])
       context.logical_turn_id = logical_id
       context.revision = revision
       local encoded_context = cjson.encode(context)
       local encoded_receipt = cjson.encode({streamId = ARGV[1], interactionContext = context})
       redis.call('HSET', KEYS[1],
         'logicalTurnId', logical_id,
         'revision', tostring(revision),
         'currentStreamId', ARGV[1],
         'active', '1',
         'streamForRevision:' .. tostring(revision), ARGV[1],
         receipt_key, encoded_receipt)
       redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
       return {'claimed', ARGV[1], encoded_context, superseded}`,
      1,
      key,
      streamId,
      interactionContext.source_event_id,
      KEYS.logicalTurnId(userId, interactionContext),
      JSON.stringify(interactionContext),
      this.ttl.running,
    )) as [string, string, string, string];

    const claimedContext = JSON.parse(result[2]) as InteractionContext;
    if (claimedContext.logical_turn_id) {
      // Prefixed IDs resolve directly to this hash slot, so ack ownership cannot race a second
      // reverse-index write. Retain the index only for pre-upgrade UUID turns.
      if (!KEYS.logicalTurnFromId(claimedContext.logical_turn_id)) {
        const indexKey = KEYS.logicalTurnIndex(claimedContext.logical_turn_id);
        await this.redis.hset(indexKey, {
          logicalTurnId: claimedContext.logical_turn_id,
          ownerScopeKey: key,
          surface: claimedContext.surface,
        });
        await this.redis.expire(indexKey, this.ttl.running);
      }
    }

    return {
      status: result[0] as LogicalTurnClaim['status'],
      streamId: result[1],
      interactionContext: claimedContext,
      supersededStreamIds: result[3] ? [result[3]] : [],
    };
  }

  async rollbackLogicalTurnClaim(
    streamId: string,
    interactionContext: InteractionContext,
  ): Promise<boolean> {
    if (!interactionContext.logical_turn_id) {
      return false;
    }
    const indexKey = KEYS.logicalTurnIndex(interactionContext.logical_turn_id);
    const ownerScopeKey =
      KEYS.logicalTurnFromId(interactionContext.logical_turn_id) ??
      (await this.redis.hget(indexKey, 'ownerScopeKey'));
    if (!ownerScopeKey) {
      return false;
    }
    const rolledBack = await this.redis.eval(
      `if redis.call('HGET', KEYS[1], 'logicalTurnId') ~= ARGV[1]
          or tonumber(redis.call('HGET', KEYS[1], 'revision') or '0') ~= tonumber(ARGV[2])
          or redis.call('HGET', KEYS[1], 'currentStreamId') ~= ARGV[3] then
         return 0
       end
       local receipt_key = 'receipt:' .. ARGV[4]
       local receipt = redis.call('HGET', KEYS[1], receipt_key)
       if receipt then
         local decoded = cjson.decode(receipt)
         if decoded.streamId == ARGV[3] then
           redis.call('HDEL', KEYS[1], receipt_key)
         end
       end
       redis.call('HDEL', KEYS[1], 'streamForRevision:' .. ARGV[2])
       local previous_revision = tonumber(ARGV[2]) - 1
       if previous_revision > 0 then
         local previous_stream = redis.call(
           'HGET',
           KEYS[1],
           'streamForRevision:' .. tostring(previous_revision)
         ) or ''
         redis.call('HSET', KEYS[1],
           'revision', tostring(previous_revision),
           'currentStreamId', previous_stream,
           'active', previous_stream ~= '' and '1' or '0')
       else
         redis.call('HSET', KEYS[1],
           'revision', '0',
           'currentStreamId', '',
           'active', '0')
       end
       return 1`,
      1,
      ownerScopeKey,
      interactionContext.logical_turn_id,
      interactionContext.revision,
      streamId,
      interactionContext.source_event_id,
    );
    if (
      rolledBack === 1 &&
      interactionContext.revision === 1 &&
      !KEYS.logicalTurnFromId(interactionContext.logical_turn_id)
    ) {
      await this.redis.del(indexKey);
    }
    return rolledBack === 1;
  }

  async forgetMissingSourceEventReceipt(
    interactionContext: InteractionContext,
    expectedStreamId: string,
  ): Promise<boolean> {
    if (!interactionContext.logical_turn_id) {
      return false;
    }
    const indexKey = KEYS.logicalTurnIndex(interactionContext.logical_turn_id);
    const ownerScopeKey =
      KEYS.logicalTurnFromId(interactionContext.logical_turn_id) ??
      (await this.redis.hget(indexKey, 'ownerScopeKey'));
    if (!ownerScopeKey) {
      return false;
    }
    const removed = await this.redis.eval(
      `if redis.call('HGET', KEYS[1], 'logicalTurnId') ~= ARGV[1] then
         return 0
       end
       local receipt_key = 'receipt:' .. ARGV[2]
       local receipt = redis.call('HGET', KEYS[1], receipt_key)
       if not receipt then
         return 0
       end
       local decoded = cjson.decode(receipt)
       if decoded.streamId ~= ARGV[3] then
         return 0
       end
       redis.call('HDEL', KEYS[1], receipt_key)
       return 1`,
      1,
      ownerScopeKey,
      interactionContext.logical_turn_id,
      interactionContext.source_event_id,
      expectedStreamId,
    );
    return removed === 1;
  }

  async completeLogicalTurn(streamId: string): Promise<void> {
    const job = await this.getJob(streamId);
    if (!job?.interactionContext) {
      return;
    }
    const key = KEYS.logicalTurn(job.userId, job.interactionContext);
    await this.redis.eval(
      `if redis.call('HGET', KEYS[1], 'currentStreamId') == ARGV[1] then
         redis.call('HSET', KEYS[1], 'active', '0')
         return 1
       end
       return 0`,
      1,
      key,
      streamId,
    );
  }

  async isCurrentLogicalTurn(streamId: string): Promise<boolean> {
    const job = await this.getJob(streamId);
    if (!job?.interactionContext) {
      return true;
    }
    const key = KEYS.logicalTurn(job.userId, job.interactionContext);
    return (await this.redis.hget(key, 'currentStreamId')) === streamId;
  }

  async resolveDeliveryOwner(logicalTurnId: string, revision: number): Promise<string | null> {
    const indexKey = KEYS.logicalTurnIndex(logicalTurnId);
    const ownerScopeKey =
      KEYS.logicalTurnFromId(logicalTurnId) ?? (await this.redis.hget(indexKey, 'ownerScopeKey'));
    if (!ownerScopeKey) {
      return null;
    }
    const [storedLogicalTurnId, ownerStreamId] = await this.redis.hmget(
      ownerScopeKey,
      'logicalTurnId',
      `streamForRevision:${revision}`,
    );
    if (storedLogicalTurnId !== logicalTurnId || !ownerStreamId) {
      return null;
    }
    return ownerStreamId;
  }

  async acknowledgeDelivery(
    acknowledgement: InteractionDeliveryAck,
  ): Promise<DeliveryAcknowledgementResult> {
    const indexKey = KEYS.logicalTurnIndex(acknowledgement.logical_turn_id);
    const ownerScopeKey =
      KEYS.logicalTurnFromId(acknowledgement.logical_turn_id) ??
      (await this.redis.hget(indexKey, 'ownerScopeKey'));
    if (!ownerScopeKey) {
      return { status: 'not_found' };
    }
    const scopeDigest = logicalTurnScopeDigestFromKey(ownerScopeKey);
    const sourceOrderKey = scopeDigest
      ? KEYS.sourceOrderFromScopeDigest(scopeDigest)
      : ownerScopeKey;
    const recordedInput = { ...acknowledgement };
    delete recordedInput.presentation_committed_at;
    const encoded = JSON.stringify(recordedInput);
    const result = (await this.redis.eval(
      `if redis.call('HGET', KEYS[1], 'logicalTurnId') ~= ARGV[1] then
         return {'not_found', ''}
       end
       local current_revision = tonumber(redis.call('HGET', KEYS[1], 'revision') or '0')
       local requested_revision = tonumber(ARGV[2])
       if requested_revision > current_revision then
         return {'stale_revision', ''}
       end
       local owner_stream_id = redis.call(
         'HGET',
         KEYS[1],
         'streamForRevision:' .. tostring(requested_revision)
       ) or ''
       if owner_stream_id == '' then
         return {'stale_revision', ''}
       end
       local ack_key = 'deliveryAck:' .. ARGV[1] .. ':' .. ARGV[2]
       local ack_input_key = 'deliveryAckInput:' .. ARGV[1] .. ':' .. ARGV[2]
       local existing = redis.call('HGET', KEYS[1], ack_key)
       if existing then
         local existing_input = redis.call('HGET', KEYS[1], ack_input_key)
         if existing_input == ARGV[3] or (not existing_input and existing == ARGV[3]) then
           return {'recorded', existing, owner_stream_id}
         end
         return {'conflict', existing}
       end
       if requested_revision < current_revision and ARGV[4] == 'committed' then
         return {'stale_revision', ''}
       end
       if ARGV[4] == 'committed' or ARGV[4] == 'committed_effect' then
         local source_sequence = tonumber(redis.call(
           'HGET', KEYS[1], 'sourceSequenceForRevision:' .. tostring(requested_revision)
         ) or '')
         local latest_source_sequence = tonumber(
           redis.call('HGET', KEYS[2], 'latestSourceSequence') or ''
         )
         if source_sequence and latest_source_sequence and latest_source_sequence > source_sequence then
           return {'stale_source_order', '', owner_stream_id}
         end
       end
       local recorded = ARGV[3]
       if ARGV[4] == 'committed' or ARGV[4] == 'committed_effect' then
         local server_time = redis.call('TIME')
         local decoded = cjson.decode(ARGV[3])
         decoded.presentation_committed_at = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
         recorded = cjson.encode(decoded)
       end
       redis.call('HSET', KEYS[1], ack_key, recorded, ack_input_key, ARGV[3])
       if requested_revision == current_revision and (ARGV[4] == 'committed' or ARGV[4] == 'failed') then
         redis.call('HSET', KEYS[1], 'active', '0')
       end
       redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
       return {'recorded_new', recorded, owner_stream_id}`,
      2,
      ownerScopeKey,
      sourceOrderKey,
      acknowledgement.logical_turn_id,
      acknowledgement.revision,
      encoded,
      acknowledgement.state,
      this.ttl.completed,
    )) as [string, string, string];

    if (
      result[0] === 'not_found' ||
      result[0] === 'stale_revision' ||
      result[0] === 'stale_source_order' ||
      result[0] === 'conflict'
    ) {
      return { status: result[0] };
    }
    if (!KEYS.logicalTurnFromId(acknowledgement.logical_turn_id)) {
      await this.redis.expire(indexKey, this.ttl.completed);
    }
    return {
      status: 'recorded',
      acknowledgement: JSON.parse(result[1]) as InteractionDeliveryAck,
      idempotent: result[0] === 'recorded',
      ownerStreamId: result[2] || undefined,
    };
  }

  async getJob(streamId: string): Promise<SerializableJobData | null> {
    const data = await this.redis.hgetall(KEYS.job(streamId));
    if (!data || Object.keys(data).length === 0) {
      return null;
    }
    return this.deserializeJob(data);
  }

  async updateJob(streamId: string, updates: Partial<SerializableJobData>): Promise<void> {
    const key = KEYS.job(streamId);

    const serialized = this.serializeJob(updates as SerializableJobData);
    if (Object.keys(serialized).length === 0) {
      return;
    }

    const fields = Object.entries(serialized).flat();
    const updated = await this.redis.eval(
      'if redis.call("EXISTS", KEYS[1]) == 1 then redis.call("HSET", KEYS[1], unpack(ARGV)) return 1 else return 0 end',
      1,
      key,
      ...fields,
    );

    if (updated === 0) {
      return;
    }

    // If status changed to a terminal state, update TTL and remove from running set
    // Note: userJobs cleanup is handled lazily via self-healing in getActiveJobIdsByUser
    if (updates.status && ['complete', 'error', 'aborted', 'superseded'].includes(updates.status)) {
      // In cluster mode, separate runningJobs (global) from stream-specific keys
      if (this.isCluster) {
        await this.redis.expire(key, this.ttl.completed);
        await this.redis.srem(KEYS.runningJobs, streamId);

        if (this.ttl.chunksAfterComplete === 0) {
          await this.redis.del(KEYS.chunks(streamId));
        } else {
          await this.redis.expire(KEYS.chunks(streamId), this.ttl.chunksAfterComplete);
        }

        if (this.ttl.runStepsAfterComplete === 0) {
          await this.redis.del(KEYS.runSteps(streamId));
        } else {
          await this.redis.expire(KEYS.runSteps(streamId), this.ttl.runStepsAfterComplete);
        }
      } else {
        const pipeline = this.redis.pipeline();
        pipeline.expire(key, this.ttl.completed);
        pipeline.srem(KEYS.runningJobs, streamId);

        if (this.ttl.chunksAfterComplete === 0) {
          pipeline.del(KEYS.chunks(streamId));
        } else {
          pipeline.expire(KEYS.chunks(streamId), this.ttl.chunksAfterComplete);
        }

        if (this.ttl.runStepsAfterComplete === 0) {
          pipeline.del(KEYS.runSteps(streamId));
        } else {
          pipeline.expire(KEYS.runSteps(streamId), this.ttl.runStepsAfterComplete);
        }

        await pipeline.exec();
      }
    }
  }

  /** Atomically bind one exact Cortex presentation generation to its durable stream job. */
  async bindCortexPresentation(
    streamId: string,
    binding: CortexPresentationBinding,
  ): Promise<boolean> {
    const result = await this.redis.eval(
      `if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
       local current_json = redis.call('HGET', KEYS[1], 'cortexPresentation')
       if current_json then
         local current = cjson.decode(current_json)
         local incoming = cjson.decode(ARGV[1])
         if incoming.revision < current.revision or incoming.generation < current.generation then
           return 0
         end
         if incoming.revision == current.revision and incoming.generation == current.generation then
           if incoming.ownerId ~= current.ownerId or
              incoming.messageId ~= current.messageId or
              incoming.parentMessageId ~= current.parentMessageId or
              incoming.claimToken ~= current.claimToken or
              incoming.presentationLeaseToken ~= current.presentationLeaseToken or
              cjson.encode(incoming.deliveryIds) ~= cjson.encode(current.deliveryIds) or
              cjson.encode(incoming.deliveryReceipts) ~= cjson.encode(current.deliveryReceipts) then
             return 0
           end
           return 1
         end
       end
       redis.call('HSET', KEYS[1], 'cortexPresentation', ARGV[1])
       return 1`,
      1,
      KEYS.job(streamId),
      JSON.stringify(binding),
    );
    return Number(result) === 1;
  }

  /** Compare-and-bind an acknowledgement to the expected Cortex generation. */
  async bindDeliveryAcknowledgement(
    streamId: string,
    acknowledgement: InteractionDeliveryAck,
    expectedCortexPresentation: CortexPresentationBinding | null,
  ): Promise<DeliveryAcknowledgementBindingResult> {
    const acknowledgementInput = { ...acknowledgement };
    delete acknowledgementInput.presentation_committed_at;
    const result = (await this.redis.eval(
      `if redis.call('EXISTS', KEYS[1]) == 0 then return {'not_found', '', '', '0'} end
       if ARGV[2] == '' then
         redis.call('HSET', KEYS[1], 'deliveryAcknowledgement', ARGV[1])
         return {'recorded', '', ARGV[1], '0'}
       end
       local current_json = redis.call('HGET', KEYS[1], 'cortexPresentation')
       if not current_json then return {'retryable_conflict', '', '', '0'} end
       local current = cjson.decode(current_json)
       local expected = cjson.decode(ARGV[2])
       if current.ownerId ~= expected.ownerId or
          current.messageId ~= expected.messageId or
          current.parentMessageId ~= expected.parentMessageId or
          current.revision ~= expected.revision or
          current.generation ~= expected.generation or
          current.boundAt ~= expected.boundAt or
          current.claimToken ~= expected.claimToken or
          current.presentationLeaseToken ~= expected.presentationLeaseToken or
          cjson.encode(current.deliveryIds) ~= cjson.encode(expected.deliveryIds) or
          cjson.encode(current.deliveryReceipts) ~= cjson.encode(expected.deliveryReceipts) then
         return {'retryable_conflict', '', '', '0'}
       end
       local existing = redis.call('HGET', KEYS[1], 'cortexDeliveryAcknowledgement')
       local existing_binding = redis.call(
         'HGET', KEYS[1], 'cortexDeliveryAcknowledgementPresentation'
       )
       if existing or existing_binding then
         if not existing or not existing_binding then
           return {'retryable_conflict', '', '', '0'}
         end
         local existing_input = redis.call(
           'HGET', KEYS[1], 'cortexDeliveryAcknowledgementInput'
         )
         if existing_binding == current_json then
           if existing_input == ARGV[3] then
             return {'recorded', current_json, existing, '1'}
           end
           return {'conflict', '', '', '0'}
         end
         if existing_input == ARGV[3] then
           redis.call(
             'HSET', KEYS[1], 'cortexDeliveryAcknowledgementPresentation', current_json
           )
           return {'recorded', current_json, existing, '1'}
         end
       end
       local server_time = redis.call('TIME')
       local recorded = cjson.decode(ARGV[3])
       recorded.presentation_committed_at = tonumber(server_time[1]) * 1000 +
         math.floor(tonumber(server_time[2]) / 1000)
       local recorded_json = cjson.encode(recorded)
       redis.call(
         'HSET', KEYS[1],
         'cortexDeliveryAcknowledgement', recorded_json,
         'cortexDeliveryAcknowledgementInput', ARGV[3],
         'cortexDeliveryAcknowledgementPresentation', current_json
       )
       return {'recorded_new', current_json, recorded_json, '0'}`,
      1,
      KEYS.job(streamId),
      JSON.stringify(acknowledgement),
      expectedCortexPresentation ? JSON.stringify(expectedCortexPresentation) : '',
      JSON.stringify(acknowledgementInput),
    )) as [string, string, string, string];
    if (!['recorded', 'recorded_new'].includes(result[0])) {
      return {
        status: result[0] as 'not_found' | 'conflict' | 'retryable_conflict',
      };
    }
    return {
      status: 'recorded',
      ...(result[2] ? { acknowledgement: JSON.parse(result[2]) as InteractionDeliveryAck } : {}),
      idempotent: result[3] === '1',
      ...(result[1]
        ? { cortexPresentation: JSON.parse(result[1]) as CortexPresentationBinding }
        : {}),
    };
  }

  async deleteJob(streamId: string): Promise<void> {
    // Clear local caches
    this.localGraphCache.delete(streamId);
    this.localCollectedUsageCache.delete(streamId);

    // Note: userJobs cleanup is handled lazily via self-healing in getActiveJobIdsByUser
    // In cluster mode, separate runningJobs (global) from stream-specific keys (same slot)
    if (this.isCluster) {
      // Stream-specific keys all hash to same slot due to {streamId}
      const pipeline = this.redis.pipeline();
      pipeline.del(KEYS.job(streamId));
      pipeline.del(KEYS.chunks(streamId));
      pipeline.del(KEYS.runSteps(streamId));
      await pipeline.exec();
      // Global set is on different slot - execute separately
      await this.redis.srem(KEYS.runningJobs, streamId);
    } else {
      const pipeline = this.redis.pipeline();
      pipeline.del(KEYS.job(streamId));
      pipeline.del(KEYS.chunks(streamId));
      pipeline.del(KEYS.runSteps(streamId));
      pipeline.srem(KEYS.runningJobs, streamId);
      await pipeline.exec();
    }
    logger.debug(`[RedisJobStore] Deleted job: ${streamId}`);
  }

  async hasJob(streamId: string): Promise<boolean> {
    const exists = await this.redis.exists(KEYS.job(streamId));
    return exists === 1;
  }

  async getRunningJobs(): Promise<SerializableJobData[]> {
    const streamIds = await this.redis.smembers(KEYS.runningJobs);
    if (streamIds.length === 0) {
      return [];
    }

    const jobs: SerializableJobData[] = [];
    for (const streamId of streamIds) {
      const job = await this.getJob(streamId);
      if (job && job.status === 'running') {
        jobs.push(job);
      }
    }
    return jobs;
  }

  async cleanup(): Promise<number> {
    const now = Date.now();
    const streamIds = await this.redis.smembers(KEYS.runningJobs);
    let cleaned = 0;

    // Clean up stale local graph cache entries (WeakRefs that were collected)
    for (const [streamId, graphRef] of this.localGraphCache) {
      if (!graphRef.deref()) {
        this.localGraphCache.delete(streamId);
      }
    }

    // Process in batches of 50 to avoid sequential per-job round-trips
    const BATCH_SIZE = 50;
    for (let i = 0; i < streamIds.length; i += BATCH_SIZE) {
      const batch = streamIds.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (streamId) => {
          const job = await this.getJob(streamId);

          // Job no longer exists (TTL expired) - remove from set
          if (!job) {
            await this.redis.srem(KEYS.runningJobs, streamId);
            this.localGraphCache.delete(streamId);
            this.localCollectedUsageCache.delete(streamId);
            return 1;
          }

          // Job completed but still in running set (shouldn't happen, but handle it)
          if (job.status !== 'running') {
            await this.redis.srem(KEYS.runningJobs, streamId);
            this.localGraphCache.delete(streamId);
            this.localCollectedUsageCache.delete(streamId);
            return 1;
          }

          // Stale running job (failsafe - running for > configured TTL)
          if (now - job.createdAt > this.ttl.running * 1000) {
            logger.warn(`[RedisJobStore] Cleaning up stale job: ${streamId}`);
            await this.deleteJob(streamId);
            return 1;
          }

          return 0;
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') {
          cleaned += result.value;
        } else {
          logger.warn(`[RedisJobStore] Cleanup failed for a job:`, result.reason);
        }
      }
    }

    if (cleaned > 0) {
      logger.debug(`[RedisJobStore] Cleaned up ${cleaned} jobs`);
    }

    return cleaned;
  }

  async getJobCount(): Promise<number> {
    // This is approximate - counts jobs in running set + scans for job keys
    // For exact count, would need to scan all job:* keys
    const runningCount = await this.redis.scard(KEYS.runningJobs);
    return runningCount;
  }

  async getJobCountByStatus(status: JobStatus): Promise<number> {
    if (status === 'running') {
      return this.redis.scard(KEYS.runningJobs);
    }

    // For other statuses, we'd need to scan - return 0 for now
    // In production, consider maintaining separate sets per status if needed
    return 0;
  }

  /**
   * Get active job IDs for a user.
   * Returns conversation IDs of running jobs belonging to the user.
   * Also performs self-healing cleanup: removes stale entries for jobs that no longer exist.
   *
   * @param userId - The user ID to query
   * @returns Array of conversation IDs with active jobs
   */
  async getActiveJobIdsByUser(userId: string): Promise<string[]> {
    const userJobsKey = KEYS.userJobs(userId);
    const trackedIds = await this.redis.smembers(userJobsKey);

    if (trackedIds.length === 0) {
      return [];
    }

    const activeIds: string[] = [];
    const staleIds: string[] = [];

    for (const streamId of trackedIds) {
      const job = await this.getJob(streamId);
      // Only include if job exists AND is still running
      if (job && job.status === 'running') {
        activeIds.push(streamId);
      } else {
        // Self-healing: job completed/deleted but mapping wasn't cleaned - mark for removal
        staleIds.push(streamId);
      }
    }

    // Clean up stale entries
    if (staleIds.length > 0) {
      await this.redis.srem(userJobsKey, ...staleIds);
      logger.debug(
        `[RedisJobStore] Self-healed ${staleIds.length} stale job entries for user ${userId}`,
      );
    }

    return activeIds;
  }

  async destroy(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    // Clear local caches
    this.localGraphCache.clear();
    this.localCollectedUsageCache.clear();
    // Don't close the Redis connection - it's shared
    logger.info('[RedisJobStore] Destroyed');
  }

  // ===== Content State Methods =====
  // For Redis, content is primarily reconstructed from chunks.
  // However, we keep a LOCAL graph cache for fast same-instance reconnects.

  /**
   * Store graph reference in local cache.
   * This enables fast reconnects when client returns to the same instance.
   * Falls back to Redis chunk reconstruction for cross-instance reconnects.
   *
   * @param streamId - The stream identifier
   * @param graph - The graph instance (stored as WeakRef)
   */
  setGraph(streamId: string, graph: StandardGraph): void {
    this.localGraphCache.set(streamId, new WeakRef(graph));
  }

  /**
   * No-op for Redis - content parts are reconstructed from chunks.
   * Metadata (agentId, groupId) is embedded directly on content parts by the agent runtime.
   */
  setContentParts(): void {
    // Content parts are reconstructed from chunks during getContentParts
    // No separate storage needed
  }

  /**
   * Store collectedUsage reference in local cache.
   * This is used for abort handling to spend tokens for all models.
   * Note: Only available on the generating instance; cross-replica abort uses fallback.
   */
  setCollectedUsage(streamId: string, collectedUsage: UsageMetadata[]): void {
    this.localCollectedUsageCache.set(streamId, collectedUsage);
  }

  /**
   * Get collected usage for a job.
   * Only available if this is the generating instance.
   */
  getCollectedUsage(streamId: string): UsageMetadata[] {
    return this.localCollectedUsageCache.get(streamId) ?? [];
  }

  /**
   * Get aggregated content - tries local cache first, falls back to Redis reconstruction.
   *
   * Optimization: If this instance has the live graph (same-instance reconnect),
   * we return the content directly without Redis round-trip.
   * For cross-instance reconnects, we reconstruct from Redis Streams.
   *
   * @param streamId - The stream identifier
   * @returns Content parts array or null if not found
   */
  async getContentParts(streamId: string): Promise<{
    content: Agents.MessageContentComplex[];
  } | null> {
    // 1. Try local graph cache first (fast path for same-instance reconnect)
    const graphRef = this.localGraphCache.get(streamId);
    if (graphRef) {
      const graph = graphRef.deref();
      if (graph) {
        const localParts = graph.getContentParts();
        if (localParts && localParts.length > 0) {
          return {
            content: localParts,
          };
        }
      } else {
        // WeakRef was collected, remove from cache
        this.localGraphCache.delete(streamId);
      }
    }

    // 2. Fall back to Redis chunk reconstruction (cross-instance reconnect)
    const chunks = await this.getChunks(streamId);
    if (chunks.length === 0) {
      return null;
    }

    // Use the same content aggregator as live streaming
    const { contentParts, aggregateContent } = createContentAggregator();

    // Valid event types for content aggregation
    const validEvents = new Set([
      'on_run_step',
      'on_message_delta',
      'on_reasoning_delta',
      'on_run_step_delta',
      'on_run_step_completed',
      'on_agent_update',
    ]);

    for (const chunk of chunks) {
      const event = chunk as { event?: string; data?: unknown };
      if (!event.event || !event.data || !validEvents.has(event.event)) {
        continue;
      }

      // Pass event string directly - GraphEvents values are lowercase strings
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      aggregateContent({ event: event.event as any, data: event.data as any });
    }

    // Filter out undefined entries
    const filtered: Agents.MessageContentComplex[] = [];
    for (const part of contentParts) {
      if (part !== undefined) {
        filtered.push(part);
      }
    }

    return {
      content: filtered,
    };
  }

  /**
   * Get run steps - tries local cache first, falls back to Redis.
   *
   * Optimization: If this instance has the live graph, we get run steps
   * directly without Redis round-trip.
   *
   * @param streamId - The stream identifier
   * @returns Run steps array
   */
  async getRunSteps(streamId: string): Promise<Agents.RunStep[]> {
    // 1. Try local graph cache first (fast path for same-instance reconnect)
    const graphRef = this.localGraphCache.get(streamId);
    if (graphRef) {
      const graph = graphRef.deref();
      if (graph) {
        const localSteps = graph.getRunSteps();
        if (localSteps && localSteps.length > 0) {
          return localSteps;
        }
      }
      // Note: Don't delete from cache here - graph may still be valid
      // but just not have run steps yet
    }

    // 2. Fall back to Redis (cross-instance reconnect)
    const key = KEYS.runSteps(streamId);
    const data = await this.redis.get(key);
    if (!data) {
      return [];
    }
    try {
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  /**
   * Clear content state for a job.
   * Removes both local cache and Redis data.
   */
  clearContentState(streamId: string): void {
    // Clear local caches immediately
    this.localGraphCache.delete(streamId);
    this.localCollectedUsageCache.delete(streamId);

    // Fire and forget - async cleanup for Redis
    this.clearContentStateAsync(streamId).catch((err) => {
      logger.error(`[RedisJobStore] Failed to clear content state for ${streamId}:`, err);
    });
  }

  /**
   * Clear content state async.
   */
  private async clearContentStateAsync(streamId: string): Promise<void> {
    const pipeline = this.redis.pipeline();
    pipeline.del(KEYS.chunks(streamId));
    pipeline.del(KEYS.runSteps(streamId));
    await pipeline.exec();
  }

  /**
   * Append a streaming chunk to Redis Stream.
   * Uses XADD for efficient append-only storage.
   * Sets TTL on first chunk to ensure cleanup if job crashes.
   */
  async appendChunk(streamId: string, event: unknown): Promise<void> {
    const key = KEYS.chunks(streamId);
    // Pipeline XADD + EXPIRE in a single round-trip.
    // EXPIRE is O(1) and idempotent — refreshing TTL on every chunk is better than
    // only setting it once, since the original approach could let the TTL expire
    // during long-running streams.
    const pipeline = this.redis.pipeline();
    pipeline.xadd(key, '*', 'event', JSON.stringify(event));
    pipeline.expire(key, this.ttl.running);
    pipeline.expire(KEYS.streamOwner(streamId), this.ttl.running);
    const results = await pipeline.exec();
    if (!results || results.length !== 3) {
      throw new Error('Redis appendChunk pipeline failed: incomplete command results');
    }
    const failedCommand = results.findIndex(([error]) => error != null);
    if (failedCommand >= 0) {
      const commandNames = ['XADD', 'chunk EXPIRE', 'owner EXPIRE'];
      throw new Error(
        `Redis appendChunk pipeline failed: ${commandNames[failedCommand]} command error`,
        { cause: results[failedCommand][0] },
      );
    }
    if (typeof results[0][1] !== 'string' || !results[0][1]) {
      throw new Error('Redis appendChunk pipeline failed: XADD returned no stream entry ID');
    }
  }

  /**
   * Get all chunks from Redis Stream.
   */
  private async getChunks(streamId: string): Promise<unknown[]> {
    const key = KEYS.chunks(streamId);
    const entries = await this.redis.xrange(key, '-', '+');

    return entries
      .map(([, fields]) => {
        const eventIdx = fields.indexOf('event');
        if (eventIdx >= 0 && eventIdx + 1 < fields.length) {
          try {
            return JSON.parse(fields[eventIdx + 1]);
          } catch {
            return null;
          }
        }
        return null;
      })
      .filter(Boolean);
  }

  /**
   * Save run steps for resume state.
   */
  async saveRunSteps(streamId: string, runSteps: Agents.RunStep[]): Promise<void> {
    const key = KEYS.runSteps(streamId);
    await this.redis.set(key, JSON.stringify(runSteps), 'EX', this.ttl.running);
  }

  // ===== Consumer Group Methods =====
  // These enable tracking which chunks each client has seen.
  // Based on https://upstash.com/blog/resumable-llm-streams

  /**
   * Create a consumer group for a stream.
   * Used to track which chunks a client has already received.
   *
   * @param streamId - The stream identifier
   * @param groupName - Unique name for the consumer group (e.g., session ID)
   * @param startFrom - Where to start reading ('0' = from beginning, '$' = only new)
   */
  async createConsumerGroup(
    streamId: string,
    groupName: string,
    startFrom: '0' | '$' = '0',
  ): Promise<void> {
    const key = KEYS.chunks(streamId);
    try {
      await this.redis.xgroup('CREATE', key, groupName, startFrom, 'MKSTREAM');
      logger.debug(`[RedisJobStore] Created consumer group ${groupName} for ${streamId}`);
    } catch (err) {
      // BUSYGROUP error means group already exists - that's fine
      const error = err as Error;
      if (!error.message?.includes('BUSYGROUP')) {
        throw err;
      }
    }
  }

  /**
   * Read chunks from a consumer group (only unseen chunks).
   * This is the key to the resumable stream pattern.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name
   * @param consumerName - Name of the consumer within the group
   * @param count - Maximum number of chunks to read (default: all available)
   * @returns Array of { id, event } where id is the Redis stream entry ID
   */
  async readChunksFromGroup(
    streamId: string,
    groupName: string,
    consumerName: string = 'consumer-1',
    count?: number,
  ): Promise<Array<{ id: string; event: unknown }>> {
    const key = KEYS.chunks(streamId);

    try {
      // XREADGROUP GROUP groupName consumerName [COUNT count] STREAMS key >
      // The '>' means only read new messages not yet delivered to this consumer
      let result;
      if (count) {
        result = await this.redis.xreadgroup(
          'GROUP',
          groupName,
          consumerName,
          'COUNT',
          count,
          'STREAMS',
          key,
          '>',
        );
      } else {
        result = await this.redis.xreadgroup('GROUP', groupName, consumerName, 'STREAMS', key, '>');
      }

      if (!result || result.length === 0) {
        return [];
      }

      // Result format: [[streamKey, [[id, [field, value, ...]], ...]]]
      const [, messages] = result[0] as [string, Array<[string, string[]]>];
      const chunks: Array<{ id: string; event: unknown }> = [];

      for (const [id, fields] of messages) {
        const eventIdx = fields.indexOf('event');
        if (eventIdx >= 0 && eventIdx + 1 < fields.length) {
          try {
            chunks.push({
              id,
              event: JSON.parse(fields[eventIdx + 1]),
            });
          } catch {
            // Skip malformed entries
          }
        }
      }

      return chunks;
    } catch (err) {
      const error = err as Error;
      // NOGROUP error means the group doesn't exist yet
      if (error.message?.includes('NOGROUP')) {
        return [];
      }
      throw err;
    }
  }

  /**
   * Acknowledge that chunks have been processed.
   * This tells Redis we've successfully delivered these chunks to the client.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name
   * @param messageIds - Array of Redis stream entry IDs to acknowledge
   */
  async acknowledgeChunks(
    streamId: string,
    groupName: string,
    messageIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const key = KEYS.chunks(streamId);
    await this.redis.xack(key, groupName, ...messageIds);
  }

  /**
   * Delete a consumer group.
   * Called when a client disconnects and won't reconnect.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name to delete
   */
  async deleteConsumerGroup(streamId: string, groupName: string): Promise<void> {
    const key = KEYS.chunks(streamId);
    try {
      await this.redis.xgroup('DESTROY', key, groupName);
      logger.debug(`[RedisJobStore] Deleted consumer group ${groupName} for ${streamId}`);
    } catch {
      // Ignore errors - group may not exist
    }
  }

  /**
   * Get pending chunks for a consumer (chunks delivered but not acknowledged).
   * Useful for recovering from crashes.
   *
   * @param streamId - The stream identifier
   * @param groupName - Consumer group name
   * @param consumerName - Consumer name
   */
  async getPendingChunks(
    streamId: string,
    groupName: string,
    consumerName: string = 'consumer-1',
  ): Promise<Array<{ id: string; event: unknown }>> {
    const key = KEYS.chunks(streamId);

    try {
      // Read pending messages (delivered but not acked) by using '0' instead of '>'
      const result = await this.redis.xreadgroup(
        'GROUP',
        groupName,
        consumerName,
        'STREAMS',
        key,
        '0',
      );

      if (!result || result.length === 0) {
        return [];
      }

      const [, messages] = result[0] as [string, Array<[string, string[]]>];
      const chunks: Array<{ id: string; event: unknown }> = [];

      for (const [id, fields] of messages) {
        const eventIdx = fields.indexOf('event');
        if (eventIdx >= 0 && eventIdx + 1 < fields.length) {
          try {
            chunks.push({
              id,
              event: JSON.parse(fields[eventIdx + 1]),
            });
          } catch {
            // Skip malformed entries
          }
        }
      }

      return chunks;
    } catch {
      return [];
    }
  }

  /**
   * Serialize job data for Redis hash storage.
   * Converts complex types to strings.
   */
  private serializeJob(job: Partial<SerializableJobData>): Record<string, string> {
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(job)) {
      if (value === undefined) {
        continue;
      }

      if (typeof value === 'object') {
        result[key] = JSON.stringify(value);
      } else if (typeof value === 'boolean') {
        result[key] = value ? '1' : '0';
      } else {
        result[key] = String(value);
      }
    }

    return result;
  }

  /**
   * Deserialize job data from Redis hash.
   */
  private deserializeJob(data: Record<string, string>): SerializableJobData {
    return {
      streamId: data.streamId,
      userId: data.userId,
      status: data.status as JobStatus,
      createdAt: parseInt(data.createdAt, 10),
      completedAt: data.completedAt ? parseInt(data.completedAt, 10) : undefined,
      conversationId: data.conversationId || undefined,
      error: data.error || undefined,
      userMessage: data.userMessage ? JSON.parse(data.userMessage) : undefined,
      responseMessageId: data.responseMessageId || undefined,
      sender: data.sender || undefined,
      syncSent: data.syncSent === '1',
      finalEvent: data.finalEvent || undefined,
      endpoint: data.endpoint || undefined,
      iconURL: data.iconURL || undefined,
      model: data.model || undefined,
      promptTokens: data.promptTokens ? parseInt(data.promptTokens, 10) : undefined,
      voiceCallSessionId: data.voiceCallSessionId || undefined,
      interactionContext: data.interactionContext
        ? (JSON.parse(data.interactionContext) as InteractionContext)
        : undefined,
      adapterCapabilities: data.adapterCapabilities
        ? JSON.parse(data.adapterCapabilities)
        : undefined,
      deliveryPolicy: data.deliveryPolicy ? JSON.parse(data.deliveryPolicy) : undefined,
      deliveryAcknowledgement: data.deliveryAcknowledgement
        ? JSON.parse(data.deliveryAcknowledgement)
        : undefined,
      cortexDeliveryAcknowledgement: data.cortexDeliveryAcknowledgement
        ? JSON.parse(data.cortexDeliveryAcknowledgement)
        : undefined,
      cortexDeliveryAcknowledgementPresentation: data.cortexDeliveryAcknowledgementPresentation
        ? JSON.parse(data.cortexDeliveryAcknowledgementPresentation)
        : undefined,
      generationCompleted: data.generationCompleted === '1',
      clientPresentation: data.clientPresentation ? JSON.parse(data.clientPresentation) : undefined,
      cortexPresentation: data.cortexPresentation ? JSON.parse(data.cortexPresentation) : undefined,
    };
  }
}
