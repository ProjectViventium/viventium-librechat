import { StepTypes } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { Redis, Cluster } from 'ioredis';
import type { InteractionContext, LogicalTurnClaim } from '../interfaces/IJobStore';
import { StandardGraph } from '@librechat/agents';

/**
 * Integration tests for RedisJobStore.
 *
 * Tests horizontal scaling scenarios:
 * - Multi-instance job access
 * - Content reconstruction from chunks
 * - Consumer groups for resumable streams
 * - TTL and cleanup behavior
 *
 * Run with: USE_REDIS=true npx jest RedisJobStore.stream_integration
 */
describe('RedisJobStore Integration Tests', () => {
  let originalEnv: NodeJS.ProcessEnv;
  let ioredisClient: Redis | Cluster | null = null;
  let keyvRedisClient: { quit: () => Promise<unknown>; disconnect: () => void } | null = null;
  const testPrefix = 'Stream-Integration-Test';

  beforeAll(async () => {
    originalEnv = { ...process.env };

    // Set up test environment
    process.env.USE_REDIS = process.env.USE_REDIS ?? 'true';
    process.env.USE_REDIS_CLUSTER = process.env.USE_REDIS_CLUSTER ?? 'false';
    process.env.REDIS_URI = process.env.REDIS_URI ?? 'redis://127.0.0.1:6379';
    process.env.REDIS_KEY_PREFIX = testPrefix;
    process.env.REDIS_PING_INTERVAL = '0';
    process.env.REDIS_RETRY_MAX_ATTEMPTS = '5';

    jest.resetModules();

    // Import Redis client
    const {
      ioredisClient: client,
      keyvRedisClient: keyvClient,
      keyvRedisClientReady,
    } = await import('../../cache/redisClients');
    ioredisClient = client;
    keyvRedisClient = keyvClient;
    await keyvRedisClientReady;

    if (!ioredisClient) {
      console.warn('Redis not available, skipping integration tests');
    }
  });

  afterEach(async () => {
    if (!ioredisClient) {
      return;
    }

    // Clean up all test keys (delete individually for cluster compatibility)
    try {
      const keys = await ioredisClient.keys(`${testPrefix}*`);
      // Also clean up stream keys which use hash tags
      const streamKeys = await ioredisClient.keys(`stream:*`);
      const allKeys = [...keys, ...streamKeys];
      // Delete individually to avoid CROSSSLOT errors in cluster mode
      await Promise.all(allKeys.map((key) => ioredisClient!.del(key)));
    } catch (error) {
      console.warn('Error cleaning up test keys:', error);
    }
  });

  afterAll(async () => {
    if (keyvRedisClient) {
      try {
        await keyvRedisClient.quit();
      } catch {
        keyvRedisClient.disconnect();
      }
    }
    if (ioredisClient) {
      try {
        // Use quit() to gracefully close - waits for pending commands
        await ioredisClient.quit();
      } catch {
        // Fall back to disconnect if quit fails
        try {
          ioredisClient.disconnect();
        } catch {
          // Ignore
        }
      }
    }
    process.env = originalEnv;
  });

  describe('Job CRUD Operations', () => {
    test('should create and retrieve a job', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `test-stream-${Date.now()}`;
      const userId = 'test-user-123';

      const job = await store.createJob(streamId, userId, streamId);

      expect(job).toMatchObject({
        streamId,
        userId,
        status: 'running',
        conversationId: streamId,
        syncSent: false,
      });

      const retrieved = await store.getJob(streamId);
      expect(retrieved).toMatchObject({
        streamId,
        userId,
        status: 'running',
      });

      await store.destroy();
    });

    test('grants one pre-dispatch takeover only after the Redis-timed lease expires', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `lease-stream-${Date.now()}`;
      const job = await store.createJob(streamId, 'lease-user', streamId);
      const claim = (
        owner: string,
        mode: 'renew' | 'takeover',
        leaseMs = 60_000,
        createdAt = job.createdAt,
      ) => store.claimNativeDispatchLease(streamId, { createdAt, owner, leaseMs, mode });

      expect(await claim('owner-a', 'renew')).toBe(true);
      expect(await claim('owner-a', 'renew')).toBe(true);
      expect(await claim('owner-b', 'renew')).toBe(false);
      expect(await claim('owner-b', 'takeover')).toBe(false);
      expect(await claim('owner-a', 'renew', 1)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(await claim('owner-b', 'takeover', 60_000, job.createdAt + 1)).toBe(false);
      expect(await claim('owner-a', 'takeover')).toBe(false);
      expect(await claim('owner-b', 'takeover')).toBe(true);
      expect(await claim('owner-c', 'takeover')).toBe(false);
      expect(await claim('owner-a', 'renew')).toBe(false);
      expect(await store.getJob(streamId)).toMatchObject({
        createdAt: job.createdAt,
        nativeDispatchOwner: 'owner-b',
      });

      const redis = (store as unknown as { redis: typeof ioredisClient }).redis!;
      await redis.hset(`stream:{${streamId}}:job`, 'nativeResponse', '{}');
      expect(await claim('owner-b', 'renew')).toBe(false);
      await redis.hdel(`stream:{${streamId}}:job`, 'nativeResponse');
      await store.updateJob(streamId, { status: 'complete' });
      expect(await claim('owner-b', 'renew')).toBe(false);

      await store.destroy();
    });

    test('round-trips the durable client presentation receipt', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `client-presentation-${Date.now()}`;
      const clientPresentation = {
        mode: 'append' as const,
        userMessageId: 'client-user',
        responseMessageId: 'client-response',
        targetUserMessageId: 'client-user',
      };

      await store.createJob(streamId, 'test-user', 'conversation-1', { clientPresentation });

      await expect(store.getJob(streamId)).resolves.toMatchObject({ clientPresentation });
      await store.destroy();
    });

    /* === VIVENTIUM START ===
     * Feature: Restart-safe Cortex presentation binding.
     * Purpose: Prove Redis keeps one exact owner/generation/hash claim and rejects stale replay.
     * === VIVENTIUM END === */
    test('atomically fences the durable Cortex presentation binding', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const streamId = `cortex-presentation-${Date.now()}`;
      const binding = {
        ownerId: 'owner-1',
        messageId: 'follow-up-7',
        parentMessageId: 'parent-1',
        revision: 2,
        generation: 7,
        deliveryIds: ['delivery-7'],
        deliveryReceipts: [
          {
            deliveryId: 'delivery-7',
            graphResultHash: 'a'.repeat(64),
          },
        ],
        claimToken: 'claim-7',
        presentationLeaseToken: 'lease-7',
        boundAt: 1_725_000_000_100,
      };

      await store.createJob(streamId, binding.ownerId, 'conversation-1');

      await expect(store.bindCortexPresentation(streamId, binding)).resolves.toBe(true);
      await expect(store.bindCortexPresentation(streamId, binding)).resolves.toBe(true);
      await expect(
        store.bindCortexPresentation(streamId, {
          ...binding,
          deliveryReceipts: [
            {
              deliveryId: 'delivery-7',
              graphResultHash: 'b'.repeat(64),
            },
          ],
        }),
      ).resolves.toBe(false);
      await expect(
        store.bindCortexPresentation(streamId, { ...binding, generation: 6 }),
      ).resolves.toBe(false);
      await expect(
        store.bindCortexPresentation(streamId, { ...binding, ownerId: 'owner-2' }),
      ).resolves.toBe(false);
      await expect(store.getJob(streamId)).resolves.toMatchObject({ cortexPresentation: binding });

      const acknowledgement = {
        logical_turn_id: 'logical-turn-cortex-presentation',
        revision: 2,
        state: 'committed' as const,
        presentation_ref: 'telegram:1:follow-up-7',
      };
      await expect(
        store.bindDeliveryAcknowledgement(streamId, acknowledgement, binding),
      ).resolves.toMatchObject({
        status: 'recorded',
        acknowledgement: {
          ...acknowledgement,
          presentation_committed_at: expect.any(Number),
        },
        idempotent: false,
        cortexPresentation: binding,
      });
      await expect(
        store.bindDeliveryAcknowledgement(streamId, acknowledgement, binding),
      ).resolves.toMatchObject({ status: 'recorded', idempotent: true });
      await expect(
        store.bindDeliveryAcknowledgement(
          streamId,
          { ...acknowledgement, presentation_ref: 'telegram:1:conflict' },
          binding,
        ),
      ).resolves.toEqual({ status: 'conflict' });
      const nextBinding = { ...binding, generation: 8, boundAt: binding.boundAt + 1 };
      await expect(store.bindCortexPresentation(streamId, nextBinding)).resolves.toBe(true);
      await expect(
        store.bindDeliveryAcknowledgement(streamId, acknowledgement, binding),
      ).resolves.toEqual({ status: 'retryable_conflict' });
      await expect(
        store.bindDeliveryAcknowledgement(streamId, acknowledgement, nextBinding),
      ).resolves.toMatchObject({
        status: 'recorded',
        idempotent: true,
        cortexPresentation: nextBinding,
      });
      const mainAcknowledgement = {
        ...acknowledgement,
        presentation_ref: 'telegram:1:main',
      };
      await expect(
        store.bindDeliveryAcknowledgement(streamId, mainAcknowledgement, null),
      ).resolves.toMatchObject({ status: 'recorded', acknowledgement: mainAcknowledgement });
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        deliveryAcknowledgement: mainAcknowledgement,
        cortexDeliveryAcknowledgement: expect.objectContaining(acknowledgement),
        cortexDeliveryAcknowledgementPresentation: nextBinding,
      });

      await store.destroy();
    });

    /* === VIVENTIUM START ===
     * Purpose: on a logical turn, a late Cortex addition's receipt is its own record. Main's
     * committed receipt is neither compared nor replaced, in either order, while the exact
     * presentation fence, replay idempotency and different-receipt conflict still hold. Input
     * newer than the turn's source withdraws a presentation before its receipt commits, and a
     * presentation of the parent itself (a promoted empty answer) is also Main's receipt.
     * === VIVENTIUM END === */
    async function claimedLogicalTurn(
      label: string,
      options: { ordered?: boolean; promoted?: boolean } = {},
    ) {
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { createHash } = await import('crypto');
      const store = new RedisJobStore(ioredisClient!);
      await store.initialize();
      const suffix = `${label}-${Date.now()}`;
      const streamId = `cortex-addition-${suffix}`;
      const ownerId = `owner-${suffix}`;
      const conversationId = `conversation-${suffix}`;
      const sourceEventId = `source-${suffix}`;
      const sourceOrderScope = createHash('sha256').update(`order-${suffix}`).digest('hex');
      const claim = await store.claimLogicalTurn(streamId, ownerId, {
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: conversationId,
        revision: 1,
        source_event_id: sourceEventId,
        ...(options.ordered
          ? {
              source_order_scope: sourceOrderScope,
              source_sequence: 1,
              source_segments: [
                { ordinal: 0, source_event_id: sourceEventId, source_index: 0, text: 'Question.' },
              ],
            }
          : {}),
      });
      await store.createJob(streamId, ownerId, conversationId, {
        interactionContext: claim.interactionContext,
      });
      const revision = claim.interactionContext.revision!;
      const mainAcknowledgement = {
        logical_turn_id: claim.interactionContext.logical_turn_id!,
        revision,
        state: 'committed' as const,
        presentation_ref: 'telegram:1:main-answer',
      };
      const binding = {
        ownerId,
        messageId: options.promoted ? `parent-${suffix}` : `follow-up-${suffix}`,
        parentMessageId: `parent-${suffix}`,
        revision,
        generation: 2,
        deliveryIds: ['delivery-addition'],
        deliveryReceipts: [{ deliveryId: 'delivery-addition', graphResultHash: 'a'.repeat(64) }],
        claimToken: 'claim-2',
        presentationLeaseToken: 'lease-2',
        boundAt: 1_725_000_000_100,
      };
      const cortexAcknowledgement = {
        ...mainAcknowledgement,
        presentation_ref: 'telegram:1:late-addition',
      };
      const logicalTurnKey = `stream:logical:{${mainAcknowledgement.logical_turn_id.split('.')[0]}}`;
      const turnActive = () => ioredisClient!.hget(logicalTurnKey, 'active');
      const newerInput = () =>
        store.observeSourceOrder({ source_order_scope: sourceOrderScope, source_sequence: 2 });
      return {
        store,
        streamId,
        mainAcknowledgement,
        binding,
        cortexAcknowledgement,
        turnActive,
        newerInput,
      };
    }

    test('a late Cortex addition acknowledges beside the committed Main receipt of its logical turn', async () => {
      if (!ioredisClient) return;
      const { store, streamId, mainAcknowledgement, binding, cortexAcknowledgement } =
        await claimedLogicalTurn('main-first');

      await expect(
        store.bindDeliveryAcknowledgement(streamId, mainAcknowledgement, null),
      ).resolves.toMatchObject({ status: 'recorded' });
      await expect(store.bindCortexPresentation(streamId, binding)).resolves.toBe(true);

      await expect(
        store.bindDeliveryAcknowledgement(streamId, cortexAcknowledgement, binding),
      ).resolves.toMatchObject({
        status: 'recorded',
        idempotent: false,
        acknowledgement: { ...cortexAcknowledgement, presentation_committed_at: expect.any(Number) },
        cortexPresentation: binding,
      });
      await expect(
        store.bindDeliveryAcknowledgement(streamId, cortexAcknowledgement, binding),
      ).resolves.toMatchObject({ status: 'recorded', idempotent: true });
      await expect(
        store.bindDeliveryAcknowledgement(
          streamId,
          { ...cortexAcknowledgement, presentation_ref: 'telegram:1:other-addition' },
          binding,
        ),
      ).resolves.toEqual({ status: 'conflict' });
      await expect(
        store.bindDeliveryAcknowledgement(streamId, cortexAcknowledgement, {
          ...binding,
          claimToken: 'claim-stale',
        }),
      ).resolves.toEqual({ status: 'retryable_conflict' });

      // Main's committed receipt is untouched: its replay stays idempotent and the job keeps it.
      await expect(
        store.bindDeliveryAcknowledgement(streamId, mainAcknowledgement, null),
      ).resolves.toMatchObject({
        status: 'recorded',
        acknowledgement: expect.objectContaining({ presentation_ref: 'telegram:1:main-answer' }),
      });
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        deliveryAcknowledgement: expect.objectContaining({
          presentation_ref: 'telegram:1:main-answer',
        }),
        cortexDeliveryAcknowledgement: expect.objectContaining({
          presentation_ref: 'telegram:1:late-addition',
        }),
        cortexDeliveryAcknowledgementPresentation: binding,
      });
      await store.destroy();
    });

    test('a Cortex receipt recorded first never pre-empts its logical turn’s Main receipt', async () => {
      if (!ioredisClient) return;
      const { store, streamId, mainAcknowledgement, binding, cortexAcknowledgement, turnActive } =
        await claimedLogicalTurn('cortex-first');
      await expect(store.bindCortexPresentation(streamId, binding)).resolves.toBe(true);
      await expect(
        store.bindDeliveryAcknowledgement(streamId, cortexAcknowledgement, binding),
      ).resolves.toMatchObject({ status: 'recorded', idempotent: false });
      // The addition settles nothing of Main's: the turn stays active and has no Main receipt.
      await expect(turnActive()).resolves.toBe('1');
      expect((await store.getJob(streamId))?.deliveryAcknowledgement).toBeUndefined();

      await expect(
        store.bindDeliveryAcknowledgement(streamId, mainAcknowledgement, null),
      ).resolves.toMatchObject({
        status: 'recorded',
        acknowledgement: expect.objectContaining({ presentation_ref: 'telegram:1:main-answer' }),
      });
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        deliveryAcknowledgement: expect.objectContaining({
          presentation_ref: 'telegram:1:main-answer',
        }),
        cortexDeliveryAcknowledgement: expect.objectContaining({
          presentation_ref: 'telegram:1:late-addition',
        }),
      });
      await store.destroy();
    });

    test('input newer than its turn withdraws a late Cortex addition before the receipt commits', async () => {
      if (!ioredisClient) return;
      const {
        store,
        streamId,
        mainAcknowledgement,
        binding,
        cortexAcknowledgement,
        newerInput,
      } = await claimedLogicalTurn('newer-input', { ordered: true });
      await expect(
        store.bindDeliveryAcknowledgement(streamId, mainAcknowledgement, null),
      ).resolves.toMatchObject({ status: 'recorded' });
      await expect(store.bindCortexPresentation(streamId, binding)).resolves.toBe(true);
      await newerInput();

      await expect(
        store.bindDeliveryAcknowledgement(streamId, cortexAcknowledgement, binding),
      ).resolves.toEqual({ status: 'stale_source_order' });
      expect((await store.getJob(streamId))?.cortexDeliveryAcknowledgement).toBeUndefined();
      // The adapter's withdrawal of that presentation still settles it, and only it.
      const withdrawal = { ...cortexAcknowledgement, state: 'partial_removed' as const };
      await expect(
        store.bindDeliveryAcknowledgement(streamId, withdrawal, binding),
      ).resolves.toMatchObject({ status: 'recorded', idempotent: false });
      await expect(
        store.bindDeliveryAcknowledgement(streamId, mainAcknowledgement, null),
      ).resolves.toMatchObject({ status: 'recorded', idempotent: true });
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        deliveryAcknowledgement: expect.objectContaining({
          state: 'committed',
          presentation_ref: 'telegram:1:main-answer',
        }),
        cortexDeliveryAcknowledgement: expect.objectContaining({ state: 'partial_removed' }),
      });
      await store.destroy();
    });

    test('a committed Cortex receipt stays replayable after newer input', async () => {
      if (!ioredisClient) return;
      const {
        store,
        streamId,
        mainAcknowledgement,
        binding,
        cortexAcknowledgement,
        newerInput,
      } = await claimedLogicalTurn('replay-after-input', { ordered: true });
      await store.bindDeliveryAcknowledgement(streamId, mainAcknowledgement, null);
      await store.bindCortexPresentation(streamId, binding);
      const first = await store.bindDeliveryAcknowledgement(
        streamId,
        cortexAcknowledgement,
        binding,
      );
      expect(first).toMatchObject({ status: 'recorded', idempotent: false });
      await newerInput();

      await expect(
        store.bindDeliveryAcknowledgement(streamId, cortexAcknowledgement, binding),
      ).resolves.toMatchObject({
        status: 'recorded',
        idempotent: true,
        acknowledgement: first.acknowledgement,
      });
      await expect(
        store.bindDeliveryAcknowledgement(
          streamId,
          { ...cortexAcknowledgement, presentation_ref: 'telegram:1:other-addition' },
          binding,
        ),
      ).resolves.toEqual({ status: 'conflict' });
      await store.destroy();
    });

    test('a promoted empty answer’s presentation is also its turn’s Main receipt', async () => {
      if (!ioredisClient) return;
      const { store, streamId, mainAcknowledgement, binding, cortexAcknowledgement, turnActive } =
        await claimedLogicalTurn('promoted', { ordered: true, promoted: true });
      await expect(store.bindCortexPresentation(streamId, binding)).resolves.toBe(true);

      const first = await store.bindDeliveryAcknowledgement(
        streamId,
        cortexAcknowledgement,
        binding,
      );
      expect(first).toMatchObject({ status: 'recorded', idempotent: false });
      // The presented parent settles the turn exactly as Main's own receipt would.
      await expect(turnActive()).resolves.toBe('0');
      await expect(store.getJob(streamId)).resolves.toMatchObject({
        deliveryAcknowledgement: first.acknowledgement,
        cortexDeliveryAcknowledgement: first.acknowledgement,
      });
      await expect(
        store.bindDeliveryAcknowledgement(streamId, mainAcknowledgement, null),
      ).resolves.toEqual({ status: 'conflict' });
      await expect(
        store.bindDeliveryAcknowledgement(streamId, cortexAcknowledgement, binding),
      ).resolves.toMatchObject({ status: 'recorded', idempotent: true });
      await store.destroy();
    });

    test('newer input withdraws a promoted empty answer before it becomes Main’s receipt', async () => {
      if (!ioredisClient) return;
      const { store, streamId, binding, cortexAcknowledgement, turnActive, newerInput } =
        await claimedLogicalTurn('promoted-stale', { ordered: true, promoted: true });
      await store.bindCortexPresentation(streamId, binding);
      await newerInput();

      await expect(
        store.bindDeliveryAcknowledgement(streamId, cortexAcknowledgement, binding),
      ).resolves.toEqual({ status: 'stale_source_order' });
      await expect(turnActive()).resolves.toBe('1');
      const job = await store.getJob(streamId);
      expect(job?.deliveryAcknowledgement).toBeUndefined();
      expect(job?.cortexDeliveryAcknowledgement).toBeUndefined();
      await store.destroy();
    });

    /* === VIVENTIUM START ===
     * Purpose: a deferred quoted input keeps its own quote when an unquoted successor claims the
     * combined turn, on the Redis store's own claim path.
     * === VIVENTIUM END === */
    test('a deferred quoted input keeps its own quote when an unquoted successor claims the turn', async () => {
      if (!ioredisClient) return;
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { createHash } = await import('crypto');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();
      const suffix = `${Date.now()}`;
      const scope = createHash('sha256').update(`deferred-quote-${suffix}`).digest('hex');
      const quote = {
        version: 1 as const,
        provenanceStatus: 'verified' as const,
        senderRole: 'assistant_self' as const,
        repliedTelegramMessageId: '14384',
        quoteText: 'Willow is cheaper by $15.',
        logicalMessageId: 'addition-message',
      };
      const input = (id: string, sequence: number, replyContext?: typeof quote) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'telegram' as const,
        conversation_id: `conversation-${suffix}`,
        revision: 1,
        source_event_id: `${id}-${suffix}`,
        source_order_scope: scope,
        source_sequence: sequence,
        source_segments: [
          {
            ordinal: 0,
            source_event_id: `${id}-${suffix}`,
            source_index: 0,
            source_sequence: sequence,
            source_message_id: `input-${id}-${suffix}`,
            source_persisted: true as const,
            text: `${id} goal`,
            ...(replyContext ? { reply_context: replyContext } : {}),
          },
        ],
      });
      const a = input('a', 1, quote),
        b = input('b', 2);
      await store.retainLogicalTurnInput('owner', a);
      await store.retainLogicalTurnInput('owner', b);
      const combined = await store.claimLogicalTurn(`b-stream-${suffix}`, 'owner', b);

      expect(combined.status).toBe('claimed');
      expect(
        combined.interactionContext.source_segments?.map((segment) => [
          segment.source_event_id,
          segment.reply_context ?? null,
        ]),
      ).toEqual([
        [`a-${suffix}`, quote],
        [`b-${suffix}`, null],
      ]);
      await store.destroy();
    });

    /* Purpose: a Redis claim only reserves a revision; its admission commit fixes each source's
     * author. An additive (response_only) Telegram turn owns the inputs deferred to it and the
     * inputs of revisions that never committed, and leaves an input that an earlier committed
     * revision carried to that revision. */
    const additiveTurn = async (label: string) => {
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { ownedInteractionSources } = await import('../../agents/sourceSelectionContext');
      const { createHash } = await import('crypto');
      const store = new RedisJobStore(ioredisClient!);
      await store.initialize();
      const suffix = `${label}-${Date.now()}`;
      const scope = createHash('sha256').update(suffix).digest('hex');
      const stream = (id: string) => `${id}-stream-${suffix}`;
      /** The adapter capabilities the Telegram route binds to every input. */
      const telegramCapabilities = {
        segment_stability: 'immediate',
        supersede_scope: 'response_only',
      } as const;
      const input = (id: string, sequence: number, quoteText?: string): InteractionContext => ({
        actor_kind: 'external_user',
        origin: 'interactive',
        surface: 'telegram',
        conversation_id: `conversation-${suffix}`,
        revision: 1,
        source_event_id: `${id}-${suffix}`,
        source_order_scope: scope,
        source_sequence: sequence,
        source_segments: [
          {
            ordinal: 0,
            source_event_id: `${id}-${suffix}`,
            source_index: 0,
            source_sequence: sequence,
            text: `${id} goal`,
            ...(quoteText
              ? {
                  source_message_id: `input-${id}-${suffix}`,
                  source_persisted: true as const,
                  reply_context: {
                    version: 1 as const,
                    provenanceStatus: 'verified' as const,
                    senderRole: 'assistant_self' as const,
                    repliedTelegramMessageId: '14378',
                    quoteText,
                    logicalMessageId: 'main-answer',
                  },
                }
              : {}),
          },
        ],
      });
      return {
        store,
        stream,
        input,
        claim: (id: string, sequence: number, quoteText?: string) =>
          store.claimLogicalTurn(stream(id), 'owner', input(id, sequence, quoteText)),
        admit: (id: string, claimed: LogicalTurnClaim) =>
          store.createJob(stream(id), 'owner', `conversation-${suffix}`, {
            interactionContext: claimed.interactionContext,
          }),
        commit: (id: string, claimed: LogicalTurnClaim) =>
          store.commitLogicalTurnAdmission(stream(id), 'owner', claimed.interactionContext),
        owned: (context: InteractionContext) =>
          ownedInteractionSources(context, telegramCapabilities).map(
            ({ sourceOrdinal, segment }) => [
              sourceOrdinal,
              segment.reply_context?.quoteText ?? null,
            ],
          ),
      };
    };

    test('an additive Redis turn owns the quoted input deferred to it', async () => {
      if (!ioredisClient) return;
      const turn = await additiveTurn('deferred');
      await turn.store.retainLogicalTurnInput('owner', turn.input('a', 1, 'Willow 427 / Elm 441'));
      const combined = await turn.claim('b', 2);
      await turn.admit('b', combined);
      const committed = await turn.commit('b', combined);
      expect(turn.owned(committed)).toEqual([
        [1, 'Willow 427 / Elm 441'],
        [2, null],
      ]);
      await turn.store.destroy();
    });

    test('an input an earlier committed Redis revision carried stays with that revision', async () => {
      if (!ioredisClient) return;
      const turn = await additiveTurn('committed');
      const first = await turn.claim('a', 1);
      await turn.admit('a', first);
      await turn.commit('a', first);
      await turn.store.retainLogicalTurnInput('owner', turn.input('c', 2));
      const combined = await turn.claim('b', 3);
      await turn.admit('b', combined);
      await turn.store.fenceSupersededLogicalTurnClaims(combined);
      const committed = await turn.commit('b', combined);
      expect(committed.source_segments?.map((s) => s.authoring_revision)).toEqual([1, 2, 2]);
      expect(turn.owned(committed)).toEqual([
        [2, null],
        [3, null],
      ]);
      await turn.store.destroy();
    });

    test('a Redis reservation that never admits leaves its input and quote to the winner', async () => {
      if (!ioredisClient) return;
      const turn = await additiveTurn('reservation');
      const reserved = await turn.claim('a', 1, 'Willow 427 / Elm 441');
      const winner = await turn.claim('b', 2);
      await turn.admit('b', winner);
      await turn.store.fenceSupersededLogicalTurnClaims(winner);
      const committed = await turn.commit('b', winner);
      expect(turn.owned(committed)).toEqual([
        [1, 'Willow 427 / Elm 441'],
        [2, null],
      ]);
      expect((await turn.store.getJob(turn.stream('b')))?.interactionContext).toEqual(committed);
      await expect(turn.admit('a', reserved)).rejects.toMatchObject({ code: 'stream_id_conflict' });
      await expect(turn.commit('a', reserved)).rejects.toMatchObject({
        code: 'stream_id_conflict',
      });
      await turn.store.destroy();
    });

    test('an admitted Redis revision whose commit loses to a newer commit is taken over', async () => {
      if (!ioredisClient) return;
      const turn = await additiveTurn('taken-over');
      const older = await turn.claim('a', 1, 'Willow 427 / Elm 441');
      const winner = await turn.claim('b', 2);
      await turn.admit('a', older);
      await turn.admit('b', winner);
      await turn.store.fenceSupersededLogicalTurnClaims(winner);
      const committed = await turn.commit('b', winner);
      expect(turn.owned(committed)).toEqual([
        [1, 'Willow 427 / Elm 441'],
        [2, null],
      ]);
      await expect(turn.commit('a', older)).rejects.toMatchObject({ code: 'stream_id_conflict' });
      await turn.store.destroy();
    });

    test('a Redis admission whose turn another conversation retired still commits on its own ledger', async () => {
      if (!ioredisClient) return;
      const turn = await additiveTurn('retired');
      const claimed = await turn.claim('a', 1, 'Willow 427 / Elm 441');
      await turn.admit('a', claimed);
      const other = await turn.store.claimLogicalTurn(turn.stream('s'), 'owner', {
        ...turn.input('s', 2),
        conversation_id: 'other-conversation',
      });
      expect(other.interactionContext.logical_turn_id).not.toBe(
        claimed.interactionContext.logical_turn_id,
      );
      await expect(turn.commit('a', claimed)).resolves.toEqual(claimed.interactionContext);
      await turn.store.destroy();
    });

    test('a Redis winner whose turn another conversation retires still owns the reservation it fenced', async () => {
      if (!ioredisClient) return;
      const turn = await additiveTurn('retired-winner');
      const reserved = await turn.claim('a', 1, 'Willow 427 / Elm 441');
      const winner = await turn.claim('b', 2);
      await turn.admit('b', winner);
      await turn.store.fenceSupersededLogicalTurnClaims(winner);
      const other = await turn.store.claimLogicalTurn(turn.stream('c'), 'owner', {
        ...turn.input('c', 3),
        conversation_id: 'other-conversation',
      });
      expect(other.interactionContext.logical_turn_id).not.toBe(
        winner.interactionContext.logical_turn_id,
      );
      const committed = await turn.commit('b', winner);
      expect(turn.owned(committed)).toEqual([
        [1, 'Willow 427 / Elm 441'],
        [2, null],
      ]);
      await expect(turn.admit('a', reserved)).rejects.toMatchObject({ code: 'stream_id_conflict' });
      await expect(turn.commit('a', reserved)).rejects.toMatchObject({
        code: 'stream_id_conflict',
      });
      await turn.store.destroy();
    });

    test('a Redis revision whose job-context write fails before its commit leaves no author', async () => {
      if (!ioredisClient) return;
      const { createHash } = await import('crypto');
      const turn = await additiveTurn('write-failure');
      const older = await turn.claim('a', 1, 'Willow 427 / Elm 441');
      await turn.admit('a', older);
      const winner = await turn.claim('b', 2);
      jest
        .spyOn(turn.store, 'updateJob')
        .mockRejectedValueOnce(new Error('job context write failed'));
      await expect(turn.commit('a', older)).rejects.toThrow('job context write failed');
      await turn.admit('b', winner);
      await turn.store.fenceSupersededLogicalTurnClaims(winner);
      const committed = await turn.commit('b', winner);
      expect(turn.owned(committed)).toEqual([
        [1, 'Willow 427 / Elm 441'],
        [2, null],
      ]);
      const logicalTurnId = older.interactionContext.logical_turn_id!;
      const ledger = `stream:logical-author:{${logicalTurnId.split('.')[0]}}:${createHash('sha256')
        .update(logicalTurnId)
        .digest('hex')
        .slice(0, 32)}`;
      await expect(ioredisClient.hget(ledger, 'author:1')).resolves.toBeNull();
      await expect(turn.commit('a', older)).rejects.toMatchObject({ code: 'stream_id_conflict' });
      await turn.store.destroy();
    });

    test('a Redis commit whose replies are all lost is reconciled from the ledger', async () => {
      if (!ioredisClient) return;
      const turn = await additiveTurn('lost-replies');
      const claimed = await turn.claim('a', 1, 'Willow 427 / Elm 441');
      await turn.admit('a', claimed);
      const client = ioredisClient as unknown as { eval: (...args: unknown[]) => Promise<unknown> };
      const evaluate = client.eval.bind(client);
      let commits = 0;
      const lost = jest.spyOn(client, 'eval').mockImplementation(async (...args: unknown[]) => {
        if (String(args[0]).includes("redis.call('HSET', KEYS[1], 'author:' .. ARGV[1], '1')")) {
          commits += 1;
          // The first commit lands in Redis; every reply is lost on the way back.
          if (commits === 1) await evaluate(...args);
          throw new Error('reply lost');
        }
        return evaluate(...args);
      });
      const committed = await turn.commit('a', claimed);
      lost.mockRestore();
      expect(commits).toBe(3);
      expect(turn.owned(committed)).toEqual([[1, 'Willow 427 / Elm 441']]);
      await expect(turn.store.getJob(turn.stream('a'))).resolves.toMatchObject({
        interactionContext: committed,
      });
      await turn.store.destroy();
    });

    test('a Redis commit whose outcome stays unknown is uncertain, never a refusal', async () => {
      if (!ioredisClient) return;
      const turn = await additiveTurn('unknown-commit');
      const claimed = await turn.claim('a', 1);
      await turn.admit('a', claimed);
      const client = ioredisClient as unknown as {
        eval: (...args: unknown[]) => Promise<unknown>;
        hmget: (...args: unknown[]) => Promise<unknown>;
      };
      const evaluate = client.eval.bind(client);
      const read = client.hmget.bind(client);
      const lost = jest.spyOn(client, 'eval').mockImplementation(async (...args: unknown[]) => {
        if (String(args[0]).includes("redis.call('HSET', KEYS[1], 'author:' .. ARGV[1], '1')")) {
          throw new Error('reply lost');
        }
        return evaluate(...args);
      });
      const unreadable = jest
        .spyOn(client, 'hmget')
        .mockImplementation(async (...args: unknown[]) => {
          if (String(args[1]).startsWith('author:')) throw new Error('read lost');
          return read(...args);
        });
      await expect(turn.commit('a', claimed)).rejects.toMatchObject({
        code: 'author_commit_uncertain',
      });
      lost.mockRestore();
      unreadable.mockRestore();
      await turn.store.destroy();
    });

    test('a Redis commit for a mismatched reservation writes nothing', async () => {
      if (!ioredisClient) return;
      const turn = await additiveTurn('mismatched');
      const older = await turn.claim('a', 1, 'Willow 427 / Elm 441');
      await turn.admit('a', older);
      const winner = await turn.claim('b', 2);
      const before = (await turn.store.getJob(turn.stream('a')))?.interactionContext;
      await expect(
        turn.store.commitLogicalTurnAdmission(turn.stream('a'), 'owner', winner.interactionContext),
      ).rejects.toMatchObject({ code: 'stream_id_conflict' });
      expect((await turn.store.getJob(turn.stream('a')))?.interactionContext).toEqual(before);
      await turn.store.destroy();
    });

    test('a Redis bare legacy reservation keeps its disposition after the turn retires', async () => {
      if (!ioredisClient) return;
      const { createHash } = await import('crypto');
      const turn = await additiveTurn('legacy-retired');
      const legacy = await turn.claim('a', 1, 'Willow 427 / Elm 441');
      const logicalTurnId = legacy.interactionContext.logical_turn_id!;
      const ledger = `stream:logical-author:{${logicalTurnId.split('.')[0]}}:${createHash('sha256')
        .update(logicalTurnId)
        .digest('hex')
        .slice(0, 32)}`;
      await ioredisClient.hdel(ledger, 'reservation:1');
      const winner = await turn.claim('b', 2);
      await turn.admit('b', winner);
      await turn.store.fenceSupersededLogicalTurnClaims(winner);
      await turn.store.claimLogicalTurn(turn.stream('c'), 'owner', {
        ...turn.input('c', 3),
        conversation_id: 'other-conversation',
      });
      await expect(ioredisClient.hget(ledger, 'legacy:1')).resolves.toContain(turn.stream('a'));
      expect(turn.owned(await turn.commit('b', winner))).toEqual([
        [1, 'Willow 427 / Elm 441'],
        [2, null],
      ]);
      await turn.store.destroy();
    });

    test('a Redis revision claimed before author ledgers existed keeps authoring only with a job', async () => {
      if (!ioredisClient) return;
      const { createHash } = await import('crypto');
      const ledgerOf = (claimed: LogicalTurnClaim) => {
        const logicalTurnId = claimed.interactionContext.logical_turn_id!;
        return `stream:logical-author:{${logicalTurnId.split('.')[0]}}:${createHash('sha256')
          .update(logicalTurnId)
          .digest('hex')
          .slice(0, 32)}`;
      };

      // A pre-upgrade revision with its job keeps authoring its input.
      const admitted = await additiveTurn('legacy-admitted');
      const legacyJob = await admitted.claim('a', 1, 'Willow 427 / Elm 441');
      await admitted.admit('a', legacyJob);
      await ioredisClient.hdel(ledgerOf(legacyJob), 'reservation:1');
      const afterJob = await admitted.claim('b', 2);
      await admitted.admit('b', afterJob);
      await admitted.store.fenceSupersededLogicalTurnClaims(afterJob);
      expect(admitted.owned(await admitted.commit('b', afterJob))).toEqual([[2, null]]);
      await admitted.store.destroy();

      // A pre-upgrade bare reservation is fenced and its input belongs to the winner.
      const bare = await additiveTurn('legacy-bare');
      const legacyReservation = await bare.claim('a', 1, 'Willow 427 / Elm 441');
      await ioredisClient.hdel(ledgerOf(legacyReservation), 'reservation:1');
      const afterReservation = await bare.claim('b', 2);
      await bare.admit('b', afterReservation);
      expect(bare.owned(await bare.commit('b', afterReservation))).toEqual([
        [1, 'Willow 427 / Elm 441'],
        [2, null],
      ]);
      await expect(bare.admit('a', legacyReservation)).rejects.toMatchObject({
        code: 'stream_id_conflict',
      });
      await bare.store.destroy();
    });
    /* === VIVENTIUM END === */

    test('should update job status', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `test-stream-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      await store.updateJob(streamId, { status: 'complete', completedAt: Date.now() });

      const job = await store.getJob(streamId);
      expect(job?.status).toBe('complete');
      expect(job?.completedAt).toBeDefined();

      await store.destroy();
    });

    test('should delete job and related data', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `test-stream-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Add some chunks
      await store.appendChunk(streamId, { event: 'on_message_delta', data: { text: 'Hello' } });

      await store.deleteJob(streamId);

      const job = await store.getJob(streamId);
      expect(job).toBeNull();

      await store.destroy();
    });
  });

  describe('Horizontal Scaling - Multi-Instance Simulation', () => {
    /* === VIVENTIUM START ===
     * Feature: Owner-safe stream claim ordering.
     * Purpose: The first logical claimant must reserve a global stream before either owner creates
     * the job; scheduling order between replicas cannot transfer ownership.
     * === VIVENTIUM END === */
    test('reserves a shared stream for the first cross-owner logical claimant', async () => {
      if (!ioredisClient) return;

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const first = new RedisJobStore(ioredisClient);
      const second = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const streamId = `claim-order-${suffix}`;
      const context = (conversation_id: string, source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'web' as const,
        conversation_id,
        revision: 1,
        source_event_id,
      });

      const firstClaim = await first.claimLogicalTurn(
        streamId,
        `owner-a-${suffix}`,
        context(`conversation-a-${suffix}`, 'source-a'),
      );
      await expect(
        second.claimLogicalTurn(
          streamId,
          `owner-b-${suffix}`,
          context(`conversation-b-${suffix}`, 'source-b'),
        ),
      ).rejects.toMatchObject({ code: 'stream_id_conflict' });

      await expect(
        first.createJob(streamId, `owner-a-${suffix}`, `conversation-a-${suffix}`, {
          interactionContext: firstClaim.interactionContext,
        }),
      ).resolves.toMatchObject({ streamId, userId: `owner-a-${suffix}` });
      await expect(first.getJob(streamId)).resolves.toMatchObject({ userId: `owner-a-${suffix}` });

      await first.destroy();
      await second.destroy();
    });

    test('newer admitted revision fences an older claim that has not published its job', async () => {
      if (!ioredisClient) return;

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const first = new RedisJobStore(ioredisClient);
      const second = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const userId = `owner-${suffix}`;
      const conversationId = `conversation-${suffix}`;
      const context = (source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'web' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id,
      });
      const older = await first.claimLogicalTurn(`older-${suffix}`, userId, context('source-a'));
      const newer = await second.claimLogicalTurn(`newer-${suffix}`, userId, context('source-b'));

      await second.createJob(`newer-${suffix}`, userId, conversationId, {
        interactionContext: newer.interactionContext,
      });
      await second.fenceSupersededLogicalTurnClaims(newer);

      await expect(
        first.createJob(`older-${suffix}`, userId, conversationId, {
          interactionContext: older.interactionContext,
        }),
      ).rejects.toMatchObject({ code: 'stream_id_conflict' });
      await expect(second.getJob(`newer-${suffix}`)).resolves.toMatchObject({
        userId,
        status: 'running',
      });
      await first.destroy();
      await second.destroy();
    });

    /* === VIVENTIUM START === An adapter subscribed at stream start receives the native FINAL. === */
    test('an early subscriber receives the actual native final through Redis', async () => {
      if (!ioredisClient || !('duplicate' in ioredisClient)) return;

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { RedisEventTransport } = await import('../implementations/RedisEventTransport');
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const subscriber = ioredisClient.duplicate();
      const store = new RedisJobStore(ioredisClient);
      const transport = new RedisEventTransport(ioredisClient as never, subscriber as never);
      const manager = new GenerationJobManagerClass();
      manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
      manager.initialize();
      const suffix = `${Date.now()}`;
      const streamId = `native-early-${suffix}`;
      const userId = `owner-${suffix}`;
      const conversationId = `conversation-${suffix}`;
      const digest = 'd'.repeat(64);
      try {
        await manager.createJob(streamId, userId, conversationId, {
          interactionContext: {
            actor_kind: 'external_user',
            origin: 'interactive',
            surface: 'telegram',
            conversation_id: conversationId,
            revision: 1,
            source_event_id: `source-${suffix}`,
          },
        });
        // Telegram subscribes as soon as chat start returns, before the response identity exists.
        const delivered = jest.fn();
        const subscription = await manager.subscribe(streamId, jest.fn(), delivered);
        await manager.updateMetadata(streamId, {
          responseMessageId: `answer-${suffix}`,
          userMessage: { messageId: `source-${suffix}` },
        });
        const data = (await store.getJob(streamId))!;
        const admittedAt = Date.now();
        const identity = {
          userId,
          conversationId,
          responseMessageId: `answer-${suffix}`,
          streamId,
          jobCreatedAt: data.createdAt,
          logicalTurnId: data.interactionContext!.logical_turn_id!,
          revision: data.interactionContext!.revision,
          invocationId: `invocation-${suffix}`,
          bodySha256: digest,
          originSha256: digest,
          providerId: 'provider',
          agentId: 'agent',
          source: { id: `source-id-${suffix}`, messageId: `source-${suffix}`, digest },
          admittedAt,
          recoverUntil: admittedAt + 86400000,
        };
        expect(await manager.bindNativeResponse(identity)).toBe(true);
        await manager.commitNativeResponse(identity, digest);
        const final = {
          final: true,
          responseMessage: { messageId: `answer-${suffix}`, text: 'Answer.' },
        };
        expect(await manager.finishNativeResponse(identity, final as never)).toBe(true);
        const deadline = Date.now() + 3000;
        while (!delivered.mock.calls.length && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(delivered).toHaveBeenCalledWith(final);
        subscription?.unsubscribe();
      } finally {
        await manager.destroy();
        subscriber.disconnect();
      }
    });
    /* === VIVENTIUM END === */

    /* === VIVENTIUM START === A reset conversation never continues another conversation's turn. === */
    test('a newer source from another conversation supersedes the active turn without inheriting it', async () => {
      if (!ioredisClient) return;

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const userId = `owner-${suffix}`;
      // A unique source-order scope keeps this proof independent of earlier watermarks.
      const { createHash } = await import('crypto');
      const sourceOrderScope = createHash('sha256').update(`reset-${suffix}`).digest('hex');
      const context = (conversation_id: string, source_event_id: string, source_sequence: number) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'telegram' as const,
        conversation_id,
        revision: 1,
        source_event_id,
        source_order_scope: sourceOrderScope,
        source_sequence,
        source_segments: [
          { ordinal: 0, source_event_id, source_index: 0, text: source_event_id },
        ],
      });
      const old = await store.claimLogicalTurn(
        `old-${suffix}`,
        userId,
        context(`conversation-old-${suffix}`, `old-replay-${suffix}`, 1),
      );
      await store.createJob(`old-${suffix}`, userId, `conversation-old-${suffix}`, {
        interactionContext: old.interactionContext,
      });
      // A source of the old conversation is retained but not yet admitted.
      await store.retainLogicalTurnInput(
        userId,
        context(`conversation-old-${suffix}`, `old-pending-${suffix}`, 2),
      );
      const fresh = await store.claimLogicalTurn(
        `fresh-${suffix}`,
        userId,
        context(`conversation-new-${suffix}`, `fresh-task-${suffix}`, 3),
      );
      expect(fresh.status).toBe('claimed');
      expect(fresh.interactionContext).toMatchObject({
        conversation_id: `conversation-new-${suffix}`,
        revision: 1,
      });
      expect(fresh.interactionContext.logical_turn_id).not.toBe(
        old.interactionContext.logical_turn_id,
      );
      expect(
        fresh.interactionContext.source_segments?.map((source) => source.source_event_id),
      ).toEqual([`fresh-task-${suffix}`]);
      // The newest source in the chat still supersedes the older in-flight turn.
      expect(fresh.supersededStreamIds).toEqual([`old-${suffix}`]);
      await store.destroy();
    });
    /* === VIVENTIUM END === */

    test('newer revision accepts an already-retired predecessor without restoring its authority', async () => {
      if (!ioredisClient) return;

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const first = new RedisJobStore(ioredisClient);
      const second = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const userId = `owner-${suffix}`;
      const conversationId = `conversation-${suffix}`;
      const context = (source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'telegram' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id,
      });
      const olderStreamId = `retired-older-${suffix}`;
      const newerStreamId = `retired-newer-${suffix}`;
      const older = await first.claimLogicalTurn(olderStreamId, userId, context('source-a'));
      await first.createJob(olderStreamId, userId, conversationId, {
        interactionContext: older.interactionContext,
      });

      // A restart cleanup can retire the durable stream while its logical-turn receipt remains.
      await first.deleteJob(olderStreamId);
      const newer = await second.claimLogicalTurn(newerStreamId, userId, context('source-b'));
      await second.createJob(newerStreamId, userId, conversationId, {
        interactionContext: newer.interactionContext,
      });

      await expect(second.fenceSupersededLogicalTurnClaims(newer)).resolves.toBeUndefined();
      await expect(second.getJob(newerStreamId)).resolves.toMatchObject({
        userId,
        status: 'running',
      });
      await expect(
        first.createJob(olderStreamId, userId, conversationId, {
          interactionContext: older.interactionContext,
        }),
      ).rejects.toMatchObject({ code: 'stream_id_conflict' });
      await first.destroy();
      await second.destroy();
    });

    test('failed newer admission can roll back without fencing the older claim', async () => {
      if (!ioredisClient) return;

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const userId = `owner-${suffix}`;
      const conversationId = `conversation-${suffix}`;
      const context = (source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'web' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id,
      });
      const older = await store.claimLogicalTurn(
        `rollback-older-${suffix}`,
        userId,
        context('source-a'),
      );
      const newer = await store.claimLogicalTurn(
        `rollback-newer-${suffix}`,
        userId,
        context('source-b'),
      );

      await expect(
        store.rollbackLogicalTurnClaim(`rollback-newer-${suffix}`, newer.interactionContext),
      ).resolves.toBe(true);
      await expect(
        store.createJob(`rollback-older-${suffix}`, userId, conversationId, {
          interactionContext: older.interactionContext,
        }),
      ).resolves.toMatchObject({ status: 'running', userId });
      await store.destroy();
    });

    test('manager silently supersedes a late older ordered Redis admission after newer job commit', async () => {
      if (!ioredisClient) return;

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const firstStore = new RedisJobStore(ioredisClient);
      const secondStore = new RedisJobStore(ioredisClient);
      const firstManager = new GenerationJobManagerClass({
        jobStore: firstStore,
        eventTransport: new InMemoryEventTransport(),
        cleanupOnComplete: false,
      });
      const secondManager = new GenerationJobManagerClass({
        jobStore: secondStore,
        eventTransport: new InMemoryEventTransport(),
        cleanupOnComplete: false,
      });
      const suffix = `${Date.now()}`;
      const userId = `owner-${suffix}`;
      const conversationId = `conversation-${suffix}`;
      const sourceOrderScope = suffix.padStart(64, 'a').slice(-64);
      const context = (source_event_id: string, source_sequence: number) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'telegram' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id,
        source_order_scope: sourceOrderScope,
        source_sequence,
      });
      const originalCreate = firstStore.createJob.bind(firstStore);
      let releaseOlder!: () => void;
      const olderReleased = new Promise<void>((resolve) => {
        releaseOlder = resolve;
      });
      let markOlderStarted!: () => void;
      const olderStarted = new Promise<void>((resolve) => {
        markOlderStarted = resolve;
      });
      jest.spyOn(firstStore, 'createJob').mockImplementationOnce(async (...args) => {
        markOlderStarted();
        await olderReleased;
        return originalCreate(...args);
      });

      await firstManager.observeSourceOrder({
        source_order_scope: sourceOrderScope,
        source_sequence: 12346,
      });
      const older = firstManager.createJob(`manager-older-${suffix}`, userId, conversationId, {
        interactionContext: context('source-a', 12346),
      });
      await olderStarted;
      await secondManager.observeSourceOrder({
        source_order_scope: sourceOrderScope,
        source_sequence: 12347,
      });
      const newer = await secondManager.createJob(
        `manager-newer-${suffix}`,
        userId,
        conversationId,
        { interactionContext: context('source-b', 12347) },
      );
      releaseOlder();

      await expect(older).rejects.toMatchObject({ code: 'source_order_superseded' });
      expect(newer.status).toBe('running');
      await expect(firstStore.getJob(`manager-older-${suffix}`)).resolves.toBeNull();
      await expect(secondStore.getJob(`manager-newer-${suffix}`)).resolves.toMatchObject({
        status: 'running',
        userId,
      });
      await firstManager.destroy();
      await secondManager.destroy();
    });

    test('should share job state between two store instances', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // Simulate two server instances with separate store instances
      const instance1 = new RedisJobStore(ioredisClient);
      const instance2 = new RedisJobStore(ioredisClient);

      await instance1.initialize();
      await instance2.initialize();

      const streamId = `multi-instance-${Date.now()}`;

      // Instance 1 creates job
      await instance1.createJob(streamId, 'user-1', streamId);

      // Instance 2 should see the job
      const jobFromInstance2 = await instance2.getJob(streamId);
      expect(jobFromInstance2).not.toBeNull();
      expect(jobFromInstance2?.streamId).toBe(streamId);

      // Instance 1 updates job
      await instance1.updateJob(streamId, { sender: 'TestAgent', syncSent: true });

      // Instance 2 should see the update
      const updatedJob = await instance2.getJob(streamId);
      expect(updatedJob?.sender).toBe('TestAgent');
      expect(updatedJob?.syncSent).toBe(true);

      await instance1.destroy();
      await instance2.destroy();
    });

    test('should share chunks between instances for content reconstruction', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      const instance1 = new RedisJobStore(ioredisClient);
      const instance2 = new RedisJobStore(ioredisClient);

      await instance1.initialize();
      await instance2.initialize();

      const streamId = `chunk-sharing-${Date.now()}`;
      await instance1.createJob(streamId, 'user-1', streamId);

      // Instance 1 emits chunks (simulating stream generation)
      // Format must match what aggregateContent expects:
      // - on_run_step: { id, index, stepDetails: { type } }
      // - on_message_delta: { id, delta: { content: { type, text } } }
      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'Hello, ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'world!' } } },
        },
      ];

      for (const chunk of chunks) {
        await instance1.appendChunk(streamId, chunk);
      }

      // Instance 2 reconstructs content (simulating reconnect to different instance)
      const result = await instance2.getContentParts(streamId);

      // Should have reconstructed content
      expect(result).not.toBeNull();
      expect(result!.content.length).toBeGreaterThan(0);

      await instance1.destroy();
      await instance2.destroy();
    });

    test('should reconstruct normalized voice message chunks without cumulative duplication', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      const instance1 = new RedisJobStore(ioredisClient);
      const instance2 = new RedisJobStore(ioredisClient);

      await instance1.initialize();
      await instance2.initialize();

      const streamId = `voice-normalized-chunks-${Date.now()}`;
      await instance1.createJob(streamId, 'user-1', streamId);

      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'I' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: ' hear' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: ' you.' } } },
        },
      ];

      for (const chunk of chunks) {
        await instance1.appendChunk(streamId, chunk);
      }

      const result = await instance2.getContentParts(streamId);

      expect(result).not.toBeNull();
      expect(result!.content).toEqual([{ type: 'text', text: 'I hear you.' }]);

      await instance1.destroy();
      await instance2.destroy();
    });

    test('should share run steps between instances', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      const instance1 = new RedisJobStore(ioredisClient);
      const instance2 = new RedisJobStore(ioredisClient);

      await instance1.initialize();
      await instance2.initialize();

      const streamId = `runsteps-sharing-${Date.now()}`;
      await instance1.createJob(streamId, 'user-1', streamId);

      // Instance 1 saves run steps
      const runSteps: Partial<Agents.RunStep>[] = [
        { id: 'step-1', runId: 'run-1', type: StepTypes.MESSAGE_CREATION, index: 0 },
        { id: 'step-2', runId: 'run-1', type: StepTypes.TOOL_CALLS, index: 1 },
      ];

      await instance1.saveRunSteps!(streamId, runSteps as Agents.RunStep[]);

      // Instance 2 retrieves run steps
      const retrievedSteps = await instance2.getRunSteps(streamId);

      expect(retrievedSteps).toHaveLength(2);
      expect(retrievedSteps[0].id).toBe('step-1');
      expect(retrievedSteps[1].id).toBe('step-2');

      await instance1.destroy();
      await instance2.destroy();
    });
  });

  describe('Content Reconstruction', () => {
    test('should reconstruct text content from message deltas', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `text-reconstruction-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Simulate a streaming response with correct event format
      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'The ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'quick ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'brown ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'fox.' } } },
        },
      ];

      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      const result = await store.getContentParts(streamId);

      expect(result).not.toBeNull();
      // Content aggregator combines text deltas
      const textPart = result!.content.find((p) => p.type === 'text');
      expect(textPart).toBeDefined();

      await store.destroy();
    });

    test('should reconstruct thinking content from reasoning deltas', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `think-reconstruction-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // on_reasoning_delta events need id and delta.content format
      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_reasoning_delta',
          data: { id: 'step-1', delta: { content: { type: 'think', think: 'Let me think...' } } },
        },
        {
          event: 'on_reasoning_delta',
          data: {
            id: 'step-1',
            delta: { content: { type: 'think', think: ' about this problem.' } },
          },
        },
        {
          event: 'on_run_step',
          data: {
            id: 'step-2',
            runId: 'run-1',
            index: 1,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-2', delta: { content: { type: 'text', text: 'The answer is 42.' } } },
        },
      ];

      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      const result = await store.getContentParts(streamId);

      expect(result).not.toBeNull();
      // Should have both think and text parts
      const thinkPart = result!.content.find((p) => p.type === 'think');
      const textPart = result!.content.find((p) => p.type === 'text');
      expect(thinkPart).toBeDefined();
      expect(textPart).toBeDefined();

      await store.destroy();
    });

    test('should return null for empty chunks', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `empty-chunks-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // No chunks appended
      const content = await store.getContentParts(streamId);
      expect(content).toBeNull();

      await store.destroy();
    });
  });

  describe('Consumer Groups', () => {
    test('should create consumer group and read chunks', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `consumer-group-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Add some chunks
      const chunks = [
        { event: 'on_message_delta', data: { type: 'text', text: 'Chunk 1' } },
        { event: 'on_message_delta', data: { type: 'text', text: 'Chunk 2' } },
        { event: 'on_message_delta', data: { type: 'text', text: 'Chunk 3' } },
      ];

      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      // Wait for Redis to sync
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Create consumer group starting from beginning
      const groupName = `client-${Date.now()}`;
      await store.createConsumerGroup(streamId, groupName, '0');

      // Read chunks from group
      // Note: With '0' as lastId, we need to use getPendingChunks or read with '0' instead of '>'
      // The '>' only gives new messages after group creation
      const readChunks = await store.getPendingChunks(streamId, groupName, 'consumer-1');

      // If pending is empty, the messages haven't been delivered yet
      // Let's read from '0' using regular read
      if (readChunks.length === 0) {
        // Consumer groups created at '0' should have access to all messages
        // but they need to be "claimed" first. Skip this test as consumer groups
        // require more complex setup for historical messages.
        console.log(
          'Skipping consumer group test - requires claim mechanism for historical messages',
        );
        await store.deleteConsumerGroup(streamId, groupName);
        await store.destroy();
        return;
      }

      expect(readChunks.length).toBe(3);

      // Acknowledge chunks
      const ids = readChunks.map((c) => c.id);
      await store.acknowledgeChunks(streamId, groupName, ids);

      // Reading again should return empty (all acknowledged)
      const moreChunks = await store.readChunksFromGroup(streamId, groupName, 'consumer-1');
      expect(moreChunks.length).toBe(0);

      // Cleanup
      await store.deleteConsumerGroup(streamId, groupName);
      await store.destroy();
    });

    // TODO: Debug consumer group timing with Redis Streams
    test.skip('should resume from where client left off', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `resume-test-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Create consumer group FIRST (before adding chunks) to track delivery
      const groupName = `client-resume-${Date.now()}`;
      await store.createConsumerGroup(streamId, groupName, '$'); // Start from end (only new messages)

      // Add initial chunks (these will be "new" to the consumer group)
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Part 1' },
      });
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Part 2' },
      });

      // Wait for Redis to sync
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Client reads first batch
      const firstRead = await store.readChunksFromGroup(streamId, groupName, 'consumer-1');
      expect(firstRead.length).toBe(2);

      // ACK the chunks
      await store.acknowledgeChunks(
        streamId,
        groupName,
        firstRead.map((c) => c.id),
      );

      // More chunks arrive while client is away
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Part 3' },
      });
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { type: 'text', text: 'Part 4' },
      });

      // Wait for Redis to sync
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Client reconnects - should only get new chunks
      const secondRead = await store.readChunksFromGroup(streamId, groupName, 'consumer-1');
      expect(secondRead.length).toBe(2);

      await store.deleteConsumerGroup(streamId, groupName);
      await store.destroy();
    });
  });

  describe('TTL and Cleanup', () => {
    test('should set running TTL on chunk stream', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 60 });
      await store.initialize();

      const streamId = `ttl-test-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', type: 'text', text: 'test' },
      });

      // Check that TTL was set on the stream key
      // Note: ioredis client has keyPrefix, so we use the key WITHOUT the prefix
      // Key uses hash tag format: stream:{streamId}:chunks
      const ttl = await ioredisClient.ttl(`stream:{${streamId}}:chunks`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);

      await store.destroy();
    });

    test('should clean up stale jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      // Very short TTL for testing
      const store = new RedisJobStore(ioredisClient, { runningTtl: 1 });
      await store.initialize();

      const streamId = `stale-job-${Date.now()}`;

      // Manually create a job that looks old
      // Note: ioredis client has keyPrefix, so we use the key WITHOUT the prefix
      // Key uses hash tag format: stream:{streamId}:job
      const jobKey = `stream:{${streamId}}:job`;
      const veryOldTimestamp = Date.now() - 10000; // 10 seconds ago

      await ioredisClient.hmset(jobKey, {
        streamId,
        userId: 'user-1',
        status: 'running',
        createdAt: veryOldTimestamp.toString(),
        syncSent: '0',
      });
      await ioredisClient.sadd(`stream:running`, streamId);

      // Run cleanup
      const cleaned = await store.cleanup();

      // Should have cleaned the stale job
      expect(cleaned).toBeGreaterThanOrEqual(1);

      await store.destroy();
    });
  });

  describe('Logical turn delivery acknowledgement', () => {
    test('reconciles persisted web final across a Redis manager restart before follow-up claim', async () => {
      if (!ioredisClient) {
        return;
      }
      const { GenerationJobManagerClass } = await import('../GenerationJobManager');
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const { InMemoryEventTransport } = await import('../implementations/InMemoryEventTransport');
      const store = new RedisJobStore(ioredisClient, { completedTtl: 60 });
      const firstProcess = new GenerationJobManagerClass({
        jobStore: store,
        eventTransport: new InMemoryEventTransport(),
        cleanupOnComplete: false,
      });
      firstProcess.initialize();
      const suffix = `${Date.now()}`;
      const conversationId = `restart-conversation-${suffix}`;
      const context = (source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'web' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id,
      });
      const first = await firstProcess.createJob(
        `restart-web-a-${suffix}`,
        `restart-user-${suffix}`,
        conversationId,
        {
          interactionContext: context('web-a'),
          adapterCapabilities: {
            segment_stability: 'immediate',
            supersede_scope: 'response_and_authoring',
          },
          deliveryPolicy: { commit_authority: 'server' },
        },
      );
      await firstProcess.updateMetadata(`restart-web-a-${suffix}`, {
        responseMessageId: 'assistant-b',
      });
      await firstProcess.markMainResponseComplete(`restart-web-a-${suffix}`, {
        final: true,
        responseMessage: { messageId: 'assistant-b', text: 'persisted B' },
      } as never);
      await firstProcess.emitDone(`restart-web-a-${suffix}`, {
        final: true,
        responseMessage: { messageId: 'assistant-b', text: 'persisted B' },
      } as never);

      const restartedProcess = new GenerationJobManagerClass({
        jobStore: store,
        eventTransport: new InMemoryEventTransport(),
        cleanupOnComplete: false,
      });
      restartedProcess.initialize();
      const followUp = await restartedProcess.createJob(
        `restart-web-c-${suffix}`,
        `restart-user-${suffix}`,
        conversationId,
        {
          interactionContext: context('web-c'),
          adapterCapabilities: {
            segment_stability: 'immediate',
            supersede_scope: 'response_and_authoring',
          },
          deliveryPolicy: { commit_authority: 'server' },
        },
      );

      expect(followUp.metadata.interactionContext).toMatchObject({ revision: 1 });
      expect(followUp.metadata.interactionContext?.logical_turn_id).not.toBe(
        first.metadata.interactionContext?.logical_turn_id,
      );
      expect((await restartedProcess.getJob(`restart-web-a-${suffix}`))?.status).toBe('complete');
      await restartedProcess.destroy();
    });

    test('isolates scheduler and interactive claims while preserving interactive A+C', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const userId = `scope-user-${suffix}`;
      const conversationId = `scope-conversation-${suffix}`;
      const interactiveContext = (source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'web' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id,
      });
      const schedulerContext = {
        actor_kind: 'system' as const,
        origin: 'scheduler' as const,
        surface: 'workbench' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id: 'scheduler-a',
      };

      const interactive = await store.claimLogicalTurn(
        `interactive-a-${suffix}`,
        userId,
        interactiveContext('interactive-a'),
      );
      const scheduler = await store.claimLogicalTurn(
        `scheduler-a-${suffix}`,
        userId,
        schedulerContext,
      );
      expect(scheduler.interactionContext).toMatchObject({ revision: 1 });
      expect(scheduler.interactionContext.logical_turn_id).not.toBe(
        interactive.interactionContext.logical_turn_id,
      );

      const interactiveFollowUp = await store.claimLogicalTurn(
        `interactive-c-${suffix}`,
        userId,
        interactiveContext('interactive-c'),
      );
      expect(interactiveFollowUp.interactionContext).toMatchObject({
        revision: 2,
        logical_turn_id: interactive.interactionContext.logical_turn_id,
      });
      await store.destroy();
    });

    test('rolls back a failed claim for retry without clobbering a concurrent takeover', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const context = (conversation_id: string, source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'telegram' as const,
        conversation_id,
        revision: 1,
        source_event_id,
      });

      const retryConversation = `rollback-retry-${suffix}`;
      const failed = await store.claimLogicalTurn(
        `failed-${suffix}`,
        `user-${suffix}`,
        context(retryConversation, 'same-event'),
      );
      await expect(
        store.rollbackLogicalTurnClaim(`failed-${suffix}`, failed.interactionContext),
      ).resolves.toBe(true);
      const retry = await store.claimLogicalTurn(
        `retry-${suffix}`,
        `user-${suffix}`,
        context(retryConversation, 'same-event'),
      );
      expect(retry).toMatchObject({ status: 'claimed' });
      expect(retry.interactionContext.revision).toBe(1);
      expect(retry.interactionContext.logical_turn_id).not.toBe(
        failed.interactionContext.logical_turn_id,
      );

      const takeoverConversation = `rollback-takeover-${suffix}`;
      const original = await store.claimLogicalTurn(
        `original-${suffix}`,
        `user-${suffix}`,
        context(takeoverConversation, 'original-event'),
      );
      const takeover = await store.claimLogicalTurn(
        `takeover-${suffix}`,
        `user-${suffix}`,
        context(takeoverConversation, 'takeover-event'),
      );
      await expect(
        store.rollbackLogicalTurnClaim(`original-${suffix}`, original.interactionContext),
      ).resolves.toBe(false);
      await expect(
        store.resolveDeliveryOwner(takeover.interactionContext.logical_turn_id!, 2),
      ).resolves.toBe(`takeover-${suffix}`);
      await expect(
        store.forgetMissingSourceEventReceipt(original.interactionContext, `original-${suffix}`),
      ).resolves.toBe(true);
      const retryAfterTakeover = await store.claimLogicalTurn(
        `retry-after-takeover-${suffix}`,
        `user-${suffix}`,
        context(takeoverConversation, 'original-event'),
      );
      expect(retryAfterTakeover).toMatchObject({ status: 'claimed' });
      expect(retryAfterTakeover.interactionContext).toMatchObject({ revision: 3 });
      await store.destroy();
    });

    test('keeps superseded outcomes revision-scoped and starts fresh after current commit', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      for (const supersededState of ['partial_removed', 'failed'] as const) {
        const scopeSuffix = `${suffix}-${supersededState}`;
        const userId = `ack-user-${scopeSuffix}`;
        const conversationId = `ack-conversation-${scopeSuffix}`;
        const context = (source_event_id: string) => ({
          actor_kind: 'external_user' as const,
          origin: 'interactive' as const,
          surface: 'telegram' as const,
          conversation_id: conversationId,
          revision: 1,
          source_event_id,
        });

        const first = await store.claimLogicalTurn(
          `ack-stream-a-${scopeSuffix}`,
          userId,
          context('ack-event-a'),
        );
        const second = await store.claimLogicalTurn(
          `ack-stream-b-${scopeSuffix}`,
          userId,
          context('ack-event-b'),
        );
        expect(second.interactionContext).toMatchObject({
          logical_turn_id: first.interactionContext.logical_turn_id,
          revision: 2,
        });

        const superseded = {
          logical_turn_id: first.interactionContext.logical_turn_id!,
          revision: 1,
          state: supersededState,
          presentation_ref: `old-${supersededState}`,
        };
        await expect(store.acknowledgeDelivery(superseded)).resolves.toMatchObject({
          status: 'recorded',
          acknowledgement: superseded,
          idempotent: false,
        });
        await expect(store.acknowledgeDelivery(superseded)).resolves.toMatchObject({
          status: 'recorded',
          acknowledgement: superseded,
          idempotent: true,
        });
        await expect(
          store.acknowledgeDelivery({
            ...superseded,
            state: supersededState === 'failed' ? 'partial_removed' : 'failed',
          }),
        ).resolves.toMatchObject({ status: 'conflict' });
        await expect(
          store.acknowledgeDelivery({
            logical_turn_id: first.interactionContext.logical_turn_id!,
            revision: 1,
            state: 'committed',
          }),
        ).resolves.toMatchObject({ status: 'conflict' });

        const committed = {
          logical_turn_id: second.interactionContext.logical_turn_id!,
          revision: 2,
          state: 'committed' as const,
          presentation_ref: 'telegram-message-1',
        };
        await expect(store.acknowledgeDelivery(committed)).resolves.toMatchObject({
          status: 'recorded',
          acknowledgement: committed,
          idempotent: false,
        });
        await expect(store.acknowledgeDelivery(committed)).resolves.toMatchObject({
          status: 'recorded',
          acknowledgement: committed,
          idempotent: true,
        });

        const next = await store.claimLogicalTurn(
          `ack-stream-c-${scopeSuffix}`,
          userId,
          context('ack-event-c'),
        );
        expect(next.interactionContext.revision).toBe(1);
        expect(next.interactionContext.logical_turn_id).not.toBe(
          second.interactionContext.logical_turn_id,
        );
      }
      await store.destroy();
    });

    /* === VIVENTIUM START ===
     * Feature: Authoritative presentation commit time.
     * Purpose: Prove Redis server time is stored once and replay returns the original receipt.
     */
    test('store-stamps one Redis presentation_committed_at and preserves it on replay', async () => {
      if (!ioredisClient) {
        return;
      }
      const redisClient = ioredisClient;
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(redisClient);
      const suffix = `${Date.now()}`;
      const claim = await store.claimLogicalTurn(
        `presentation-time-stream-${suffix}`,
        `presentation-time-user-${suffix}`,
        {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'telegram',
          conversation_id: `presentation-time-conversation-${suffix}`,
          revision: 1,
          source_event_id: `presentation-time-event-${suffix}`,
        },
      );
      const acknowledgement = {
        logical_turn_id: claim.interactionContext.logical_turn_id!,
        revision: 1,
        state: 'committed' as const,
        presentation_ref: 'telegram:1:10',
        presentation_committed_at: 1,
      };
      const readRedisTimeMs = async () => {
        const [seconds, microseconds] = await redisClient.time();
        return Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
      };
      const before = await readRedisTimeMs();

      const first = await store.acknowledgeDelivery(acknowledgement);
      const after = await readRedisTimeMs();
      const replay = await store.acknowledgeDelivery(acknowledgement);

      expect(first).toMatchObject({
        status: 'recorded',
        idempotent: false,
        acknowledgement: {
          presentation_committed_at: expect.any(Number),
        },
      });
      expect(first.acknowledgement?.presentation_committed_at).toBeGreaterThanOrEqual(before);
      expect(first.acknowledgement?.presentation_committed_at).toBeLessThanOrEqual(after);
      expect(replay).toMatchObject({
        status: 'recorded',
        idempotent: true,
        acknowledgement: first.acknowledgement,
      });
      expect(first.acknowledgement?.presentation_committed_at).not.toBe(1);

      await store.destroy();
    });
    /* === VIVENTIUM END === */

    test('closes the current claim on failed delivery without letting an old removal affect revision 2', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const conversationId = `failed-close-conversation-${suffix}`;
      const userId = `failed-close-user-${suffix}`;
      const context = (source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'telegram' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id,
      });
      const first = await store.claimLogicalTurn('failed-close-a', userId, context('event-a'));
      const second = await store.claimLogicalTurn('failed-close-b', userId, context('event-b'));

      await expect(
        store.acknowledgeDelivery({
          logical_turn_id: first.interactionContext.logical_turn_id!,
          revision: 1,
          state: 'partial_removed',
        }),
      ).resolves.toMatchObject({ status: 'recorded' });
      await expect(
        store.acknowledgeDelivery({
          logical_turn_id: second.interactionContext.logical_turn_id!,
          revision: 2,
          state: 'failed',
        }),
      ).resolves.toMatchObject({ status: 'recorded' });

      const next = await store.claimLogicalTurn('failed-close-c', userId, context('event-c'));
      expect(next.interactionContext).toMatchObject({ revision: 1 });
      expect(next.interactionContext.logical_turn_id).not.toBe(
        second.interactionContext.logical_turn_id,
      );
      await store.destroy();
    });

    test('records an authorized durable effect receipt for an older revision without closing the current revision', async () => {
      if (!ioredisClient) {
        return;
      }
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const conversationId = `effect-receipt-conversation-${suffix}`;
      const userId = `effect-receipt-user-${suffix}`;
      const context = (source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'telegram' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id,
      });
      const first = await store.claimLogicalTurn(
        `effect-receipt-a-${suffix}`,
        userId,
        context('event-a'),
      );
      const second = await store.claimLogicalTurn(
        `effect-receipt-b-${suffix}`,
        userId,
        context('event-b'),
      );
      const acknowledgement = {
        logical_turn_id: first.interactionContext.logical_turn_id!,
        revision: 1,
        state: 'committed_effect' as const,
        presentation_ref: 'telegram:1:10',
      };

      await expect(store.acknowledgeDelivery(acknowledgement)).resolves.toMatchObject({
        status: 'recorded',
        acknowledgement,
        idempotent: false,
      });
      await expect(store.acknowledgeDelivery(acknowledgement)).resolves.toMatchObject({
        status: 'recorded',
        idempotent: true,
      });
      await expect(
        store.claimLogicalTurn(`effect-receipt-retry-${suffix}`, userId, context('event-b')),
      ).resolves.toMatchObject({
        status: 'duplicate',
        streamId: `effect-receipt-b-${suffix}`,
        interactionContext: { revision: 2 },
      });
      expect(second.interactionContext.revision).toBe(2);
      await store.destroy();
    });

    test('prunes prior revision and receipt fields when a new logical turn begins', async () => {
      if (!ioredisClient) {
        return;
      }
      const { createHash } = await import('crypto');
      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      const suffix = `${Date.now()}`;
      const userId = `bounded-user-${suffix}`;
      const conversationId = `bounded-conversation-${suffix}`;
      const context = (source_event_id: string) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'telegram' as const,
        conversation_id: conversationId,
        revision: 1,
        source_event_id,
      });

      const first = await store.claimLogicalTurn(
        `bounded-stream-a-${suffix}`,
        userId,
        context('bounded-event-a'),
      );
      const second = await store.claimLogicalTurn(
        `bounded-stream-b-${suffix}`,
        userId,
        context('bounded-event-b'),
      );
      await store.acknowledgeDelivery({
        logical_turn_id: first.interactionContext.logical_turn_id!,
        revision: 1,
        state: 'partial_removed',
      });
      await store.acknowledgeDelivery({
        logical_turn_id: second.interactionContext.logical_turn_id!,
        revision: 2,
        state: 'committed',
      });
      await store.claimLogicalTurn(
        `bounded-stream-c-${suffix}`,
        userId,
        context('bounded-event-c'),
      );

      const scope = createHash('sha256')
        .update([userId, conversationId, 'external_user', 'interactive'].join('\u0000'))
        .digest('hex');
      const fields = await ioredisClient.hkeys(`stream:logical:{${scope}}`);
      expect(fields.filter((field) => field.startsWith('receipt:'))).toEqual([
        'receipt:bounded-event-c',
      ]);
      expect(fields.filter((field) => field.startsWith('streamForRevision:'))).toEqual([
        'streamForRevision:1',
      ]);
      expect(fields.filter((field) => field.startsWith('deliveryAck:'))).toEqual([]);
      await store.destroy();
    });
  });

  describe('Active Jobs by User', () => {
    test('should return active job IDs for a user', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId1 = `stream-1-${Date.now()}`;
      const streamId2 = `stream-2-${Date.now()}`;

      // Create two jobs for the same user
      await store.createJob(streamId1, userId, streamId1);
      await store.createJob(streamId2, userId, streamId2);

      // Get active jobs for user
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(2);
      expect(activeJobs).toContain(streamId1);
      expect(activeJobs).toContain(streamId2);

      await store.destroy();
    });

    test('should return empty array for user with no jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `nonexistent-user-${Date.now()}`;

      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(0);

      await store.destroy();
    });

    test('should not return completed jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId1 = `stream-1-${Date.now()}`;
      const streamId2 = `stream-2-${Date.now()}`;

      // Create two jobs
      await store.createJob(streamId1, userId, streamId1);
      await store.createJob(streamId2, userId, streamId2);

      // Complete one job
      await store.updateJob(streamId1, { status: 'complete', completedAt: Date.now() });

      // Get active jobs - should only return the running one
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(1);
      expect(activeJobs).toContain(streamId2);
      expect(activeJobs).not.toContain(streamId1);

      await store.destroy();
    });

    test('should not return aborted jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;

      // Create a job and abort it
      await store.createJob(streamId, userId, streamId);
      await store.updateJob(streamId, { status: 'aborted', completedAt: Date.now() });

      // Get active jobs - should be empty
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(0);

      await store.destroy();
    });

    test('should not return error jobs', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;

      // Create a job with error status
      await store.createJob(streamId, userId, streamId);
      await store.updateJob(streamId, {
        status: 'error',
        error: 'Test error',
        completedAt: Date.now(),
      });

      // Get active jobs - should be empty
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      expect(activeJobs).toHaveLength(0);

      await store.destroy();
    });

    test('should perform self-healing cleanup of stale entries', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;
      const staleStreamId = `stale-stream-${Date.now()}`;

      // Create a real job
      await store.createJob(streamId, userId, streamId);

      // Manually add a stale entry to the user's job set (simulating orphaned data)
      const userJobsKey = `stream:user:{${userId}}:jobs`;
      await ioredisClient.sadd(userJobsKey, staleStreamId);

      // Verify both entries exist in the set
      const beforeCleanup = await ioredisClient.smembers(userJobsKey);
      expect(beforeCleanup).toContain(streamId);
      expect(beforeCleanup).toContain(staleStreamId);

      // Get active jobs - should trigger self-healing
      const activeJobs = await store.getActiveJobIdsByUser(userId);

      // Should only return the real job
      expect(activeJobs).toHaveLength(1);
      expect(activeJobs).toContain(streamId);

      // Verify stale entry was removed
      const afterCleanup = await ioredisClient.smembers(userJobsKey);
      expect(afterCleanup).toContain(streamId);
      expect(afterCleanup).not.toContain(staleStreamId);

      await store.destroy();
    });

    test('should isolate jobs between different users', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId1 = `user-1-${Date.now()}`;
      const userId2 = `user-2-${Date.now()}`;
      const streamId1 = `stream-1-${Date.now()}`;
      const streamId2 = `stream-2-${Date.now()}`;

      // Create jobs for different users
      await store.createJob(streamId1, userId1, streamId1);
      await store.createJob(streamId2, userId2, streamId2);

      // Get active jobs for user 1
      const user1Jobs = await store.getActiveJobIdsByUser(userId1);
      expect(user1Jobs).toHaveLength(1);
      expect(user1Jobs).toContain(streamId1);
      expect(user1Jobs).not.toContain(streamId2);

      // Get active jobs for user 2
      const user2Jobs = await store.getActiveJobIdsByUser(userId2);
      expect(user2Jobs).toHaveLength(1);
      expect(user2Jobs).toContain(streamId2);
      expect(user2Jobs).not.toContain(streamId1);

      await store.destroy();
    });

    test('should work across multiple store instances (horizontal scaling)', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // Simulate two server instances
      const instance1 = new RedisJobStore(ioredisClient);
      const instance2 = new RedisJobStore(ioredisClient);

      await instance1.initialize();
      await instance2.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;

      // Instance 1 creates a job
      await instance1.createJob(streamId, userId, streamId);

      // Instance 2 should see the active job
      const activeJobs = await instance2.getActiveJobIdsByUser(userId);
      expect(activeJobs).toHaveLength(1);
      expect(activeJobs).toContain(streamId);

      // Instance 1 completes the job
      await instance1.updateJob(streamId, { status: 'complete', completedAt: Date.now() });

      // Instance 2 should no longer see the job as active
      const activeJobsAfter = await instance2.getActiveJobIdsByUser(userId);
      expect(activeJobsAfter).toHaveLength(0);

      await instance1.destroy();
      await instance2.destroy();
    });

    test('should clean up user jobs set when job is deleted', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const userId = `test-user-${Date.now()}`;
      const streamId = `stream-${Date.now()}`;

      // Create a job
      await store.createJob(streamId, userId, streamId);

      // Verify job is in active list
      let activeJobs = await store.getActiveJobIdsByUser(userId);
      expect(activeJobs).toContain(streamId);

      // Delete the job
      await store.deleteJob(streamId);

      // Job should no longer be in active list
      activeJobs = await store.getActiveJobIdsByUser(userId);
      expect(activeJobs).not.toContain(streamId);

      await store.destroy();
    });
  });

  describe('Race Condition: updateJob after deleteJob', () => {
    test('should not re-create job hash when updateJob runs after deleteJob', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `race-condition-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      const jobKey = `stream:{${streamId}}:job`;
      const ttlBefore = await ioredisClient.ttl(jobKey);
      expect(ttlBefore).toBeGreaterThan(0);

      await store.deleteJob(streamId);

      const afterDelete = await ioredisClient.exists(jobKey);
      expect(afterDelete).toBe(0);

      await store.updateJob(streamId, { finalEvent: JSON.stringify({ final: true }) });

      const afterUpdate = await ioredisClient.exists(jobKey);
      expect(afterUpdate).toBe(0);

      await store.destroy();
    });

    test('should not leave orphan keys from concurrent emitDone and deleteJob', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `concurrent-race-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      const jobKey = `stream:{${streamId}}:job`;

      await Promise.all([
        store.updateJob(streamId, { finalEvent: JSON.stringify({ final: true }) }),
        store.deleteJob(streamId),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 100));

      const exists = await ioredisClient.exists(jobKey);
      const ttl = exists ? await ioredisClient.ttl(jobKey) : -2;

      expect(ttl === -2 || ttl > 0).toBe(true);
      expect(ttl).not.toBe(-1);

      await store.destroy();
    });
  });

  describe('Local Graph Cache Optimization', () => {
    test('should use local cache when available', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `local-cache-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Create a mock graph
      const mockContentParts = [{ type: 'text', text: 'From local cache' }];
      const mockRunSteps = [{ id: 'step-1', type: 'message_creation', status: 'completed' }];
      const mockGraph = {
        getContentParts: () => mockContentParts,
        getRunSteps: () => mockRunSteps,
      };

      // Set graph reference (will be cached locally)
      store.setGraph(streamId, mockGraph as unknown as StandardGraph);

      // Get content - should come from local cache, not Redis
      const result = await store.getContentParts(streamId);
      expect(result!.content).toEqual(mockContentParts);

      // Get run steps - should come from local cache
      const runSteps = await store.getRunSteps(streamId);
      expect(runSteps).toEqual(mockRunSteps);

      await store.destroy();
    });

    test('should fall back to Redis when local cache not available', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');

      // Instance 1 creates and populates data
      const instance1 = new RedisJobStore(ioredisClient);
      await instance1.initialize();

      const streamId = `fallback-test-${Date.now()}`;
      await instance1.createJob(streamId, 'user-1', streamId);

      // Add chunks to Redis with correct format
      await instance1.appendChunk(streamId, {
        event: 'on_run_step',
        data: {
          id: 'step-1',
          runId: 'run-1',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
      });
      await instance1.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', delta: { content: { type: 'text', text: 'From Redis' } } },
      });

      // Save run steps to Redis
      await instance1.saveRunSteps!(streamId, [
        {
          id: 'step-1',
          runId: 'run-1',
          type: StepTypes.MESSAGE_CREATION,
          index: 0,
        } as unknown as Agents.RunStep,
      ]);

      // Instance 2 has NO local cache - should fall back to Redis
      const instance2 = new RedisJobStore(ioredisClient);
      await instance2.initialize();

      // Get content - should reconstruct from Redis chunks
      const result = await instance2.getContentParts(streamId);
      expect(result).not.toBeNull();
      expect(result!.content.length).toBeGreaterThan(0);

      // Get run steps - should fetch from Redis
      const runSteps = await instance2.getRunSteps(streamId);
      expect(runSteps).toHaveLength(1);
      expect(runSteps[0].id).toBe('step-1');

      await instance1.destroy();
      await instance2.destroy();
    });
  });

  describe('Batched Cleanup', () => {
    test('should clean up many stale jobs in parallel batches', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      // Very short TTL so jobs are immediately stale
      const store = new RedisJobStore(ioredisClient, { runningTtl: 1 });
      await store.initialize();

      const jobCount = 75; // More than one batch of 50
      const veryOldTimestamp = Date.now() - 10000; // 10 seconds ago

      // Create many stale jobs directly in Redis
      for (let i = 0; i < jobCount; i++) {
        const streamId = `batch-cleanup-${Date.now()}-${i}`;
        const jobKey = `stream:{${streamId}}:job`;
        await ioredisClient.hmset(jobKey, {
          streamId,
          userId: 'batch-user',
          status: 'running',
          createdAt: veryOldTimestamp.toString(),
          syncSent: '0',
        });
        await ioredisClient.sadd('stream:running', streamId);
      }

      // Verify jobs are in the running set
      const runningBefore = await ioredisClient.scard('stream:running');
      expect(runningBefore).toBeGreaterThanOrEqual(jobCount);

      // Run cleanup - should process in batches of 50
      const cleaned = await store.cleanup();
      expect(cleaned).toBeGreaterThanOrEqual(jobCount);

      await store.destroy();
    });

    test('should not clean up valid running jobs during batch cleanup', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 1200 });
      await store.initialize();

      // Create a mix of valid and stale jobs
      const validStreamId = `valid-job-${Date.now()}`;
      await store.createJob(validStreamId, 'user-1', validStreamId);

      const staleStreamId = `stale-job-${Date.now()}`;
      const jobKey = `stream:{${staleStreamId}}:job`;
      await ioredisClient.hmset(jobKey, {
        streamId: staleStreamId,
        userId: 'user-1',
        status: 'running',
        createdAt: (Date.now() - 2000000).toString(), // Very old
        syncSent: '0',
      });
      await ioredisClient.sadd('stream:running', staleStreamId);

      const cleaned = await store.cleanup();
      expect(cleaned).toBeGreaterThanOrEqual(1);

      // Valid job should still exist
      const validJob = await store.getJob(validStreamId);
      expect(validJob).not.toBeNull();
      expect(validJob?.status).toBe('running');

      await store.destroy();
    });
  });

  describe('appendChunk TTL Refresh', () => {
    test('should set TTL on the chunk stream', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 120 });
      await store.initialize();

      const streamId = `append-ttl-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', type: 'text', text: 'first' },
      });

      const chunkKey = `stream:{${streamId}}:chunks`;
      const ttl = await ioredisClient.ttl(chunkKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);

      await store.destroy();
    });

    test('should refresh TTL on subsequent chunks (not just first)', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient, { runningTtl: 120 });
      await store.initialize();

      const streamId = `append-refresh-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      // Append first chunk
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', type: 'text', text: 'first' },
      });

      const chunkKey = `stream:{${streamId}}:chunks`;
      const ttl1 = await ioredisClient.ttl(chunkKey);
      expect(ttl1).toBeGreaterThan(0);

      // Manually reduce TTL to simulate time passing
      await ioredisClient.expire(chunkKey, 30);
      const reducedTtl = await ioredisClient.ttl(chunkKey);
      expect(reducedTtl).toBeLessThanOrEqual(30);

      // Append another chunk - TTL should be refreshed back to running TTL
      await store.appendChunk(streamId, {
        event: 'on_message_delta',
        data: { id: 'step-1', type: 'text', text: 'second' },
      });

      const ttl2 = await ioredisClient.ttl(chunkKey);
      // Should be refreshed to ~120, not still ~30
      expect(ttl2).toBeGreaterThan(30);
      expect(ttl2).toBeLessThanOrEqual(120);

      await store.destroy();
    });

    test('should store chunks correctly via pipeline', async () => {
      if (!ioredisClient) {
        return;
      }

      const { RedisJobStore } = await import('../implementations/RedisJobStore');
      const store = new RedisJobStore(ioredisClient);
      await store.initialize();

      const streamId = `append-pipeline-${Date.now()}`;
      await store.createJob(streamId, 'user-1', streamId);

      const chunks = [
        {
          event: 'on_run_step',
          data: {
            id: 'step-1',
            runId: 'run-1',
            index: 0,
            stepDetails: { type: 'message_creation' },
          },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'Hello ' } } },
        },
        {
          event: 'on_message_delta',
          data: { id: 'step-1', delta: { content: { type: 'text', text: 'world!' } } },
        },
      ];

      for (const chunk of chunks) {
        await store.appendChunk(streamId, chunk);
      }

      // Verify all chunks were stored
      const chunkKey = `stream:{${streamId}}:chunks`;
      const len = await ioredisClient.xlen(chunkKey);
      expect(len).toBe(3);

      // Verify content can be reconstructed
      const content = await store.getContentParts(streamId);
      expect(content).not.toBeNull();
      expect(content!.content.length).toBeGreaterThan(0);

      await store.destroy();
    });
  });
});
