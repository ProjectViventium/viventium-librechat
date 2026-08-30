import type { Redis } from 'ioredis';
import { RedisJobStore } from '../implementations/RedisJobStore';

/* === VIVENTIUM START ===
 * Feature: Durable client-presentation resume identity.
 * Purpose: Guard the exact Redis hash serialization boundary without requiring a live Redis server.
 */
describe('RedisJobStore job serialization', () => {
  it('uses Redis TIME and co-slotted TTL fencing for durable source-order observation', async () => {
    const redis = {
      eval: jest.fn().mockResolvedValue(['12347', '1725000000123', '1']),
    };
    const store = new RedisJobStore(redis as unknown as Redis, {
      sourceOrderTtl: 11,
      runningTtl: 22,
    });

    await expect(
      store.observeSourceOrder({
        source_order_scope: 'a'.repeat(64),
        source_sequence: 12346,
      }),
    ).resolves.toEqual({
      latest_source_sequence: 12347,
      observed_at: 1_725_000_000_123,
      stale: true,
    });

    const [script, keyCount, sourceKey, logicalKey, sequence, sourceTtl, runningTtl] =
      redis.eval.mock.calls[0];
    expect(store.sourceOrderDurability).toBe('durable');
    expect(script).toContain("redis.call('TIME')");
    expect(script).toContain("redis.call('EXPIRE', KEYS[1], target_ttl)");
    expect(keyCount).toBe(2);
    expect(sourceKey).toMatch(/^stream:source-order:\{[a-f0-9]{64}\}$/);
    expect(logicalKey).toMatch(/^stream:logical:\{[a-f0-9]{64}\}$/);
    expect(sourceKey.match(/\{([^}]+)\}/)?.[1]).toBe(logicalKey.match(/\{([^}]+)\}/)?.[1]);
    expect([sequence, sourceTtl, runningTtl]).toEqual([12346, 11, 22]);
  });

  it('round-trips the client presentation receipt', () => {
    const store = new RedisJobStore({} as Redis);
    const codec = store as unknown as {
      serializeJob(value: Record<string, unknown>): Record<string, string>;
      deserializeJob(value: Record<string, string>): {
        clientPresentation?: Record<string, string>;
      };
    };
    const clientPresentation = {
      mode: 'regenerate',
      userMessageId: 'client-user',
      responseMessageId: 'client-response',
      targetUserMessageId: 'target-user',
    };
    const serialized = codec.serializeJob({
      streamId: 'stream-1',
      userId: 'user-1',
      status: 'running',
      createdAt: 1,
      syncSent: false,
      clientPresentation,
    });

    expect(codec.deserializeJob(serialized).clientPresentation).toEqual(clientPresentation);
  });

  it('round-trips the exact server-held Cortex presentation generation binding', () => {
    const store = new RedisJobStore({} as Redis);
    const codec = store as unknown as {
      serializeJob(value: Record<string, unknown>): Record<string, string>;
      deserializeJob(value: Record<string, string>): {
        cortexPresentation?: Record<string, string | number>;
        cortexDeliveryAcknowledgement?: Record<string, string | number>;
        cortexDeliveryAcknowledgementPresentation?: Record<string, string | number>;
      };
    };
    const cortexPresentation = {
      ownerId: 'user-1',
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
    const serialized = codec.serializeJob({
      streamId: 'stream-1',
      userId: 'user-1',
      status: 'running',
      createdAt: 1,
      syncSent: false,
      cortexPresentation,
      cortexDeliveryAcknowledgement: {
        logical_turn_id: 'turn-7',
        revision: 1,
        state: 'committed',
        presentation_ref: 'telegram:1:7',
      },
      cortexDeliveryAcknowledgementPresentation: cortexPresentation,
    });

    expect(codec.deserializeJob(serialized).cortexPresentation).toEqual(cortexPresentation);
    expect(codec.deserializeJob(serialized).cortexDeliveryAcknowledgement).toMatchObject({
      logical_turn_id: 'turn-7',
      presentation_ref: 'telegram:1:7',
    });
    expect(codec.deserializeJob(serialized).cortexDeliveryAcknowledgementPresentation).toEqual(
      cortexPresentation,
    );
  });

  it('repairs a same-generation job mirror from the authoritative logical Cortex fence', async () => {
    const logicalScope = 'e'.repeat(64);
    const logicalTurnId = `${logicalScope}.logical-turn-upgrade`;
    const previousBinding = {
      ownerId: 'user-upgrade',
      messageId: 'follow-up-upgrade',
      parentMessageId: 'parent-upgrade',
      revision: 1,
      generation: 2,
      deliveryIds: ['delivery-upgrade'],
      deliveryReceipts: [{ deliveryId: 'delivery-upgrade', graphResultHash: 'a'.repeat(64) }],
      claimToken: 'claim-upgrade',
      presentationLeaseToken: 'lease-upgrade',
      boundAt: 1_000,
    };
    const authoritativeBinding = { ...previousBinding, boundAt: 2_000 };
    const redis = {
      hgetall: jest.fn(),
      eval: jest
        .fn()
        .mockResolvedValueOnce(['recorded', JSON.stringify(authoritativeBinding)])
        .mockResolvedValueOnce(1),
    };
    const store = new RedisJobStore(redis as unknown as Redis);
    const codec = store as unknown as {
      serializeJob(value: Record<string, unknown>): Record<string, string>;
    };
    redis.hgetall.mockResolvedValue(
      codec.serializeJob({
        streamId: 'stream-upgrade',
        userId: 'user-upgrade',
        status: 'running',
        createdAt: 1,
        syncSent: false,
        interactionContext: {
          actor_kind: 'external_user',
          origin: 'interactive',
          surface: 'telegram',
          conversation_id: 'conversation-upgrade',
          logical_turn_id: logicalTurnId,
          revision: 1,
          source_event_id: 'source-upgrade',
        },
        cortexPresentation: previousBinding,
      }),
    );

    await expect(
      store.bindCortexPresentation('stream-upgrade', authoritativeBinding),
    ).resolves.toBe(true);

    const [mirrorScript, keyCount, jobKey, encodedAuthoritativeBinding] = redis.eval.mock.calls[1];
    const sameGenerationIndex = mirrorScript.indexOf(
      'if incoming.revision == current.revision and incoming.generation == current.generation',
    );
    const authoritativeWriteIndex = mirrorScript.indexOf(
      "redis.call('HSET', KEYS[1], 'cortexPresentation', ARGV[1])",
      sameGenerationIndex,
    );
    const sameGenerationReturnIndex = mirrorScript.indexOf('return 1', sameGenerationIndex);
    expect(sameGenerationIndex).toBeGreaterThanOrEqual(0);
    expect(authoritativeWriteIndex).toBeGreaterThanOrEqual(0);
    expect(authoritativeWriteIndex).toBeLessThan(sameGenerationReturnIndex);
    expect([keyCount, jobKey]).toEqual([1, 'stream:{stream-upgrade}:job']);
    expect(JSON.parse(encodedAuthoritativeBinding)).toEqual(authoritativeBinding);
  });

  it('atomically compares the expected Cortex generation while binding an acknowledgement', async () => {
    const binding = {
      ownerId: 'user-1',
      messageId: 'follow-up-2',
      parentMessageId: 'parent-1',
      revision: 1,
      generation: 2,
      deliveryIds: ['delivery-2'],
      deliveryReceipts: [{ deliveryId: 'delivery-2', graphResultHash: 'a'.repeat(64) }],
      claimToken: 'claim-2',
      presentationLeaseToken: 'lease-2',
      boundAt: 2_000,
    };
    const logicalScope = 'f'.repeat(64);
    const acknowledgement = {
      logical_turn_id: `${logicalScope}.logical-turn-1`,
      revision: 1,
      state: 'committed' as const,
    };
    const recordedAcknowledgement = {
      ...acknowledgement,
      presentation_committed_at: 2_500,
    };
    const redis = {
      eval: jest
        .fn()
        .mockResolvedValueOnce([
          'recorded_new',
          JSON.stringify(binding),
          JSON.stringify(recordedAcknowledgement),
          '0',
        ])
        .mockResolvedValueOnce(['retryable_conflict', '', '', '0']),
    };
    const store = new RedisJobStore(redis as unknown as Redis);

    await expect(
      store.bindDeliveryAcknowledgement('stream-1', acknowledgement, binding),
    ).resolves.toEqual({
      status: 'recorded',
      acknowledgement: recordedAcknowledgement,
      idempotent: false,
      cortexPresentation: binding,
    });
    await expect(
      store.bindDeliveryAcknowledgement('stream-1', acknowledgement, binding),
    ).resolves.toEqual({ status: 'retryable_conflict' });

    const [
      script,
      keyCount,
      logicalKey,
      sourceOrderKey,
      streamId,
      logicalTurnId,
      revision,
      encodedAcknowledgement,
      encodedBinding,
      encodedInput,
    ] = redis.eval.mock.calls[0];
    expect(script).toContain("'cortexDeliveryAcknowledgement:'");
    expect(script).toContain("'streamForRevision:'");
    expect(script).toContain("'cortexPresentation:'");
    expect(script).toContain("redis.call('TIME')");
    expect(script).toContain("return {'retryable_conflict', '', '', '0'}");
    const fenceReadIndex = script.indexOf("local current_json = redis.call('HGET', KEYS[1]");
    const acknowledgementWriteIndex = script.indexOf('ack_key, recorded_json');
    expect(fenceReadIndex).toBeGreaterThanOrEqual(0);
    expect(acknowledgementWriteIndex).toBeGreaterThanOrEqual(0);
    expect(fenceReadIndex).toBeLessThan(acknowledgementWriteIndex);
    expect(keyCount).toBe(2);
    expect(logicalKey).toBe(`stream:logical:{${logicalScope}}`);
    expect(sourceOrderKey).toBe(`stream:source-order:{${logicalScope}}`);
    expect([streamId, logicalTurnId, revision]).toEqual([
      'stream-1',
      acknowledgement.logical_turn_id,
      1,
    ]);
    expect(JSON.parse(encodedAcknowledgement)).toEqual(acknowledgement);
    expect(JSON.parse(encodedBinding)).toEqual(binding);
    expect(JSON.parse(encodedInput)).toEqual(acknowledgement);
  });

  it.each([
    [
      'XADD',
      [
        [new Error('xadd failed'), null],
        [null, 1],
        [null, 1],
      ],
    ],
    [
      'chunk EXPIRE',
      [
        [null, '1-0'],
        [new Error('expire failed'), null],
        [null, 1],
      ],
    ],
    [
      'owner EXPIRE',
      [
        [null, '1-0'],
        [null, 1],
        [new Error('owner expire failed'), null],
      ],
    ],
  ])(
    'rejects appendChunk when the Redis pipeline reports a %s command error',
    async (_, results) => {
      const pipeline = {
        xadd: jest.fn(),
        expire: jest.fn(),
        exec: jest.fn().mockResolvedValue(results),
      };
      pipeline.xadd.mockReturnValue(pipeline);
      pipeline.expire.mockReturnValue(pipeline);
      const redis = { pipeline: jest.fn(() => pipeline) };
      const store = new RedisJobStore(redis as unknown as Redis);

      await expect(
        store.appendChunk('cortex-stream', {
          event: 'on_cortex_followup',
          data: { messageId: 'follow-up-1', revision: 2 },
        }),
      ).rejects.toThrow(/Redis appendChunk pipeline failed/);
    },
  );

  it('removes adapter time before the atomic Redis acknowledgement and returns server time', async () => {
    const storedAcknowledgement = {
      logical_turn_id: 'logical-turn-1',
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:1:10',
      presentation_committed_at: 1_725_000_000_123,
    };
    const redis = {
      hget: jest.fn().mockResolvedValue('stream:logical:{scope}'),
      eval: jest
        .fn()
        .mockResolvedValueOnce(['recorded_new', JSON.stringify(storedAcknowledgement), 'stream-1'])
        .mockResolvedValueOnce(['recorded', JSON.stringify(storedAcknowledgement), 'stream-1']),
      expire: jest.fn().mockResolvedValue(1),
    };
    const store = new RedisJobStore(redis as unknown as Redis);
    const adapterAcknowledgement = {
      ...storedAcknowledgement,
      presentation_committed_at: 1,
    } as const;

    const first = await store.acknowledgeDelivery(adapterAcknowledgement);
    const replay = await store.acknowledgeDelivery(adapterAcknowledgement);

    const encodedInput = JSON.parse(redis.eval.mock.calls[0][6] as string);
    expect(encodedInput).toEqual({
      logical_turn_id: 'logical-turn-1',
      revision: 1,
      state: 'committed',
      presentation_ref: 'telegram:1:10',
    });
    expect(redis.eval.mock.calls[0][0]).toContain("redis.call('TIME')");
    expect(first).toMatchObject({
      status: 'recorded',
      idempotent: false,
      acknowledgement: storedAcknowledgement,
    });
    expect(replay).toMatchObject({
      status: 'recorded',
      idempotent: true,
      acknowledgement: storedAcknowledgement,
    });
  });
});
/* === VIVENTIUM END === */
