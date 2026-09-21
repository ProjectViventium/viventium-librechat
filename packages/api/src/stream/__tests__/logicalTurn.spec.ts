import { logger } from '@librechat/data-schemas';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import type {
  CortexPresentationBinding,
  InteractionContext,
  InteractionDeliveryAck,
} from '../interfaces/IJobStore';

const webContext = (conversationId: string, sourceEventId: string): InteractionContext => ({
  actor_kind: 'external_user',
  origin: 'interactive',
  surface: 'web',
  conversation_id: conversationId,
  revision: 1,
  source_event_id: sourceEventId,
});

const telegramContext = (conversationId: string, sourceEventId: string): InteractionContext => ({
  ...webContext(conversationId, sourceEventId),
  surface: 'telegram',
});

const webCapabilities = {
  segment_stability: 'immediate' as const,
  supersede_scope: 'response_and_authoring' as const,
};

const serverDelivery = { commit_authority: 'server' as const };
const externalDelivery = { commit_authority: 'external_adapter' as const };
const schedulerContext = (conversationId: string, sourceEventId: string): InteractionContext => ({
  actor_kind: 'system',
  origin: 'scheduler',
  surface: 'workbench',
  conversation_id: conversationId,
  revision: 1,
  source_event_id: sourceEventId,
});

describe('GenerationJobManager logical turns', () => {
  test('reusing a conversation stream retires its old revision without cancelling the replacement', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const transport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: transport,
      cleanupOnComplete: false,
    });
    await manager.initialize();
    try {
      let previous = await manager.createJob('conversation', 'owner', 'conversation', {
        interactionContext: webContext('conversation', 'source-0'),
        adapterCapabilities: webCapabilities,
      });
      for (let revision = 1; revision <= 3; revision++) {
        await manager.updateMetadata('conversation', {
          responseMessageId: `answer-${revision - 1}`,
          userMessage: { messageId: `input-${revision - 1}`, text: 'Accepted input.' },
        });
        const replaced = await store.getJob('conversation');
        const current = await manager.createJob('conversation', 'owner', 'conversation', {
          interactionContext: webContext('conversation', `source-${revision}`),
          adapterCapabilities: webCapabilities,
        });
        expect(current.supersededPresentations).toEqual([
          expect.objectContaining({
            responseMessageId: `answer-${revision - 1}`,
            userMessageId: `input-${revision - 1}`,
            interactionContext: expect.objectContaining({ revision }),
          }),
        ]);
        expect(previous.abortController.signal.aborted).toBe(true);
        expect(current.abortController.signal.aborted).toBe(false);
        expect(await store.getJob('conversation')).toMatchObject({
          status: 'running',
          interactionContext: expect.objectContaining({ revision: revision + 1 }),
        });
        expect((await store.getJob('conversation'))?.createdAt).toBeGreaterThan(
          replaced!.createdAt,
        );
        const output: unknown[] = [];
        const subscription = await manager.subscribe('conversation', (event) => output.push(event));
        await manager.emitChunk('conversation', {
          event: 'on_message_delta',
          data: { text: 'Useful replacement answer.' },
        } as never);
        expect(output).toContainEqual(
          expect.objectContaining({ data: { text: 'Useful replacement answer.' } }),
        );
        subscription?.unsubscribe();
        previous = current;
      }
    } finally {
      await manager.destroy();
    }
  });

  test('persists the exact Voice durable-effect authority beside the claimed job', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    await manager.createJob('voice-effect-metadata', 'owner-1', 'conversation-1', {
      interactionContext: {
        ...webContext('conversation-1', 'voice:event-1'),
        surface: 'voice',
      },
      deliveryPolicy: externalDelivery,
    });
    const authority = {
      version: 1 as const,
      userId: 'owner-1',
      voiceAuthorityRef: `voice_authority_${'a'.repeat(64)}`,
      voice: {
        callSessionId: 'call-1',
        voiceTurnId: 'voice-turn-1',
        mode: 'wing' as const,
        callModeRevision: 2,
        speakerSessionRevision: 4,
        segmentRevisionDigest: `sha256:${'b'.repeat(64)}`,
        ownerParticipantDigest: `sha256:${'c'.repeat(64)}`,
        engagementDigest: `sha256:${'d'.repeat(64)}`,
        engagementExpiresAt: '2026-09-01T12:01:00.000Z',
      },
    };

    await manager.updateMetadata('voice-effect-metadata', {
      responseMessageId: 'response-1',
      viventiumCallSessionId: 'call-1',
      viventiumVoiceTaskId: 'voice-task-1',
      viventiumVoiceEffectAuthority: authority,
    });

    await expect(manager.getJob('voice-effect-metadata')).resolves.toMatchObject({
      metadata: {
        responseMessageId: 'response-1',
        viventiumCallSessionId: 'call-1',
        viventiumVoiceTaskId: 'voice-task-1',
        viventiumVoiceEffectAuthority: authority,
      },
    });
    await manager.destroy();
  });

  test('hashes stream identity in lifecycle logs', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    const streamId = 'private-stream-id';
    const debugLog = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    try {
      manager.initialize();
      await manager.createJob(streamId, 'private-owner-id', 'private-conversation-id');
      await manager.completeJob(streamId);

      const output = debugLog.mock.calls.flat().map(String).join('\n');
      expect(output).not.toContain(streamId);
      expect(output).not.toContain('private-owner-id');
      expect(output).not.toContain('private-conversation-id');
      expect(output).toMatch(/stream_sha256=[a-f0-9]{64}/);
    } finally {
      debugLog.mockRestore();
      await manager.destroy();
    }
  });

  test('rejects source N presentation when N+1 was observed 280ms earlier without aborting response_only authoring', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const sourceOrderScope = 'a'.repeat(64);
    const responseOnly = {
      segment_stability: 'immediate' as const,
      supersede_scope: 'response_only' as const,
    };
    const orderedTelegramContext = (
      sourceEventId: string,
      sourceSequence: number,
    ): InteractionContext => ({
      ...telegramContext('conversation-source-order', sourceEventId),
      source_order_scope: sourceOrderScope,
      source_sequence: sourceSequence,
    });

    await manager.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12346,
    });
    const first = await manager.createJob(
      'telegram-source-n',
      'user-1',
      'conversation-source-order',
      {
        interactionContext: orderedTelegramContext('opaque-source-n', 12346),
        adapterCapabilities: responseOnly,
        deliveryPolicy: externalDelivery,
      },
    );

    await manager.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12347,
    });
    await new Promise((resolve) => setTimeout(resolve, 280));

    await expect(
      manager.acknowledgeDelivery(
        {
          logical_turn_id: first.metadata.interactionContext!.logical_turn_id!,
          revision: 1,
          state: 'committed',
        },
        'telegram',
      ),
    ).resolves.toMatchObject({ status: 'stale_source_order' });
    expect(first.abortController.signal.aborted).toBe(false);

    const second = await manager.createJob(
      'telegram-source-n-plus-one',
      'user-1',
      'conversation-source-order',
      {
        interactionContext: orderedTelegramContext('opaque-source-n-plus-one', 12347),
        adapterCapabilities: responseOnly,
        deliveryPolicy: externalDelivery,
      },
    );
    expect(second.metadata.interactionContext).toMatchObject({
      logical_turn_id: first.metadata.interactionContext?.logical_turn_id,
      revision: 2,
      source_sequence: 12347,
    });
    expect(first.abortController.signal.aborted).toBe(false);
    await manager.destroy();
  });

  /* === VIVENTIUM START ===
   * Feature: Telegram source-order-safe duplicate admission.
   * Purpose: Fence replay against the newest trusted source, isolate owners and sessions, and
   * distinguish a pre-commit interrupt from an ordinary post-commit follow-up.
   */
  test.each([
    { stage: 'observed before delayed admission', admitNewerFirst: false },
    { stage: 'already admitted', admitNewerFirst: true },
  ])(
    'rejects a duplicate source N receipt once source N+1 is $stage',
    async ({ admitNewerFirst }) => {
      const manager = new GenerationJobManagerClass({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
        eventTransport: new InMemoryEventTransport(),
        cleanupOnComplete: false,
      });
      manager.initialize();
      const sourceOrderScope = 'c'.repeat(64);
      const responseOnly = {
        segment_stability: 'immediate' as const,
        supersede_scope: 'response_only' as const,
      };
      const orderedContext = (
        sourceEventId: string,
        sourceSequence: number,
      ): InteractionContext => ({
        ...telegramContext('conversation-source-replay', sourceEventId),
        source_order_scope: sourceOrderScope,
        source_sequence: sourceSequence,
      });
      const createOrderedJob = (streamId: string, sourceEventId: string, sourceSequence: number) =>
        manager.createJob(streamId, 'user-1', 'conversation-source-replay', {
          interactionContext: orderedContext(sourceEventId, sourceSequence),
          adapterCapabilities: responseOnly,
          deliveryPolicy: externalDelivery,
        });

      try {
        await manager.observeSourceOrder({
          source_order_scope: sourceOrderScope,
          source_sequence: 12346,
        });
        const first = await createOrderedJob(
          'telegram-original-source-n',
          'opaque-source-n',
          12346,
        );

        await manager.observeSourceOrder({
          source_order_scope: sourceOrderScope,
          source_sequence: 12347,
        });
        let current = admitNewerFirst
          ? await createOrderedJob('telegram-source-n-plus-one', 'opaque-source-n-plus-one', 12347)
          : undefined;

        await expect(
          createOrderedJob('telegram-replayed-source-n', 'opaque-source-n', 12346),
        ).rejects.toMatchObject({ code: 'source_order_superseded' });

        current ??= await createOrderedJob(
          'telegram-source-n-plus-one',
          'opaque-source-n-plus-one',
          12347,
        );
        expect(current.metadata.interactionContext).toMatchObject({
          logical_turn_id: first.metadata.interactionContext?.logical_turn_id,
          revision: 2,
          source_sequence: 12347,
        });
        expect(first.abortController.signal.aborted).toBe(false);
        await expect(
          manager.acknowledgeDelivery(
            {
              logical_turn_id: current.metadata.interactionContext!.logical_turn_id!,
              revision: 2,
              state: 'committed',
              presentation_ref: 'telegram:111:12348',
            },
            'telegram',
          ),
        ).resolves.toMatchObject({ status: 'recorded' });
      } finally {
        await manager.destroy();
      }
    },
  );

  test.each([
    { boundary: 'owner', userId: 'user-2', conversationId: 'conversation-original' },
    { boundary: 'session', userId: 'user-1', conversationId: 'conversation-reset' },
  ])(
    'never reuses a Telegram duplicate receipt across a different $boundary',
    async ({ userId, conversationId }) => {
      const manager = new GenerationJobManagerClass({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
        eventTransport: new InMemoryEventTransport(),
        cleanupOnComplete: false,
      });
      manager.initialize();
      const sourceOrderScope = 'd'.repeat(64);
      const orderedContext = (conversation: string): InteractionContext => ({
        ...telegramContext(conversation, 'opaque-shared-source'),
        source_order_scope: sourceOrderScope,
        source_sequence: 12346,
      });

      try {
        await manager.observeSourceOrder({
          source_order_scope: sourceOrderScope,
          source_sequence: 12346,
        });
        const first = await manager.createJob(
          'telegram-original-owner-session',
          'user-1',
          'conversation-original',
          {
            interactionContext: orderedContext('conversation-original'),
            adapterCapabilities: {
              segment_stability: 'immediate',
              supersede_scope: 'response_only',
            },
            deliveryPolicy: externalDelivery,
          },
        );

        await expect(
          manager.createJob('telegram-cross-boundary-replay', userId, conversationId, {
            interactionContext: orderedContext(conversationId),
            adapterCapabilities: {
              segment_stability: 'immediate',
              supersede_scope: 'response_only',
            },
            deliveryPolicy: externalDelivery,
          }),
        ).rejects.toMatchObject({ code: 'stream_id_conflict' });

        expect(first.abortController.signal.aborted).toBe(false);
        await expect(manager.hasJob('telegram-cross-boundary-replay')).resolves.toBe(false);
      } finally {
        await manager.destroy();
      }
    },
  );

  test('starts a fresh Telegram turn when source N+1 is observed only after source N commits', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const sourceOrderScope = 'e'.repeat(64);
    const responseOnly = {
      segment_stability: 'immediate' as const,
      supersede_scope: 'response_only' as const,
    };
    const orderedContext = (sourceEventId: string, sourceSequence: number): InteractionContext => ({
      ...telegramContext('conversation-after-commit', sourceEventId),
      source_order_scope: sourceOrderScope,
      source_sequence: sourceSequence,
    });

    try {
      await manager.observeSourceOrder({
        source_order_scope: sourceOrderScope,
        source_sequence: 12346,
      });
      const committed = await manager.createJob(
        'telegram-committed-source-n',
        'user-1',
        'conversation-after-commit',
        {
          interactionContext: orderedContext('opaque-committed-source-n', 12346),
          adapterCapabilities: responseOnly,
          deliveryPolicy: externalDelivery,
        },
      );
      await expect(
        manager.acknowledgeDelivery(
          {
            logical_turn_id: committed.metadata.interactionContext!.logical_turn_id!,
            revision: 1,
            state: 'committed',
            presentation_ref: 'telegram:111:12347',
          },
          'telegram',
        ),
      ).resolves.toMatchObject({ status: 'recorded' });

      await manager.observeSourceOrder({
        source_order_scope: sourceOrderScope,
        source_sequence: 12348,
      });
      const followUp = await manager.createJob(
        'telegram-follow-up-source-n-plus-one',
        'user-1',
        'conversation-after-commit',
        {
          interactionContext: orderedContext('opaque-follow-up-source-n-plus-one', 12348),
          adapterCapabilities: responseOnly,
          deliveryPolicy: externalDelivery,
        },
      );

      expect(followUp.metadata.interactionContext).toMatchObject({
        revision: 1,
        source_sequence: 12348,
      });
      expect(followUp.metadata.interactionContext?.logical_turn_id).not.toBe(
        committed.metadata.interactionContext?.logical_turn_id,
      );
      expect(committed.abortController.signal.aborted).toBe(false);
    } finally {
      await manager.destroy();
    }
  });
  /* === VIVENTIUM END === */

  test('rejects a delayed older Telegram admission after the newer source was observed', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const sourceOrderScope = 'b'.repeat(64);
    const orderedContext = (sourceEventId: string, sourceSequence: number): InteractionContext => ({
      ...telegramContext('conversation-delayed-source', sourceEventId),
      source_order_scope: sourceOrderScope,
      source_sequence: sourceSequence,
    });

    await manager.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12347,
    });

    await expect(
      manager.createJob('telegram-delayed-source-n', 'user-1', 'conversation-delayed-source', {
        interactionContext: orderedContext('opaque-delayed-source-n', 12346),
        adapterCapabilities: {
          segment_stability: 'immediate',
          supersede_scope: 'response_only',
        },
        deliveryPolicy: externalDelivery,
      }),
    ).rejects.toMatchObject({ code: 'source_order_superseded' });

    const current = await manager.createJob(
      'telegram-current-source-n-plus-one',
      'user-1',
      'conversation-delayed-source',
      {
        interactionContext: orderedContext('opaque-current-source-n-plus-one', 12347),
        adapterCapabilities: {
          segment_stability: 'immediate',
          supersede_scope: 'response_only',
        },
        deliveryPolicy: externalDelivery,
      },
    );

    expect(current.metadata.interactionContext).toMatchObject({
      revision: 1,
      source_sequence: 12347,
    });
    await manager.destroy();
  });

  test('InMemory preserves the source watermark when a failed claim resets its logical turn', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const sourceOrderScope = 'd'.repeat(64);
    const context = (source_event_id: string, source_sequence: number): InteractionContext => ({
      ...telegramContext('conversation-memory-reset', source_event_id),
      source_order_scope: sourceOrderScope,
      source_sequence,
    });
    await store.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12346,
    });
    const first = await store.claimLogicalTurn(
      'memory-reset-n',
      'user-1',
      context('opaque-reset-n', 12346),
    );
    await expect(
      store.rollbackLogicalTurnClaim('memory-reset-n', first.interactionContext),
    ).resolves.toBe(true);
    await expect(
      store.observeSourceOrder({
        source_order_scope: sourceOrderScope,
        source_sequence: 12345,
      }),
    ).resolves.toMatchObject({ latest_source_sequence: 12346, stale: true });
    await store.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12347,
    });
    const second = await store.claimLogicalTurn(
      'memory-reset-n-plus-one',
      'user-1',
      context('opaque-reset-n-plus-one', 12347),
    );

    expect(second.interactionContext).toMatchObject({ revision: 1, source_sequence: 12347 });
    await expect(
      store.observeSourceOrder({
        source_order_scope: sourceOrderScope,
        source_sequence: 12346,
      }),
    ).resolves.toMatchObject({ latest_source_sequence: 12347, stale: true });
    await store.destroy();
  });

  test('InMemory expires inactive source watermarks but retains them while a turn is active', async () => {
    let now = 1_725_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000, sourceOrderTtl: 100 });
    const sourceOrderScope = 'e'.repeat(64);
    const context: InteractionContext = {
      ...telegramContext('conversation-memory-ttl', 'opaque-memory-ttl'),
      source_order_scope: sourceOrderScope,
      source_sequence: 12346,
    };

    await store.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12346,
    });
    const active = await store.claimLogicalTurn('memory-ttl', 'user-1', context);
    now += 101;
    await expect(
      store.observeSourceOrder({ source_order_scope: sourceOrderScope, source_sequence: 12345 }),
    ).resolves.toMatchObject({ latest_source_sequence: 12346, stale: true });
    await store.acknowledgeDelivery({
      logical_turn_id: active.interactionContext.logical_turn_id!,
      revision: 1,
      state: 'failed',
    });
    now += 101;
    await expect(
      store.observeSourceOrder({ source_order_scope: sourceOrderScope, source_sequence: 12345 }),
    ).resolves.toMatchObject({ latest_source_sequence: 12345, stale: false });
    await store.destroy();
  });

  test('InMemory acknowledgement idempotency compares every adapter-authored field', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const claim = await store.claimLogicalTurn(
      'memory-ack-parity',
      'user-1',
      telegramContext('conversation-ack-parity', 'opaque-ack-parity'),
    );
    const acknowledgement = {
      logical_turn_id: claim.interactionContext.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:111:1001',
      presentation_refs: ['telegram:111:1001', 'telegram:111:1002'],
      source_kind: 'assistant_message' as const,
    };

    await expect(store.acknowledgeDelivery(acknowledgement)).resolves.toMatchObject({
      status: 'recorded',
      idempotent: false,
    });
    await expect(store.acknowledgeDelivery({ ...acknowledgement })).resolves.toMatchObject({
      status: 'recorded',
      idempotent: true,
    });
    await expect(
      store.acknowledgeDelivery({
        ...acknowledgement,
        presentation_refs: ['telegram:111:1001', 'telegram:111:DIFFERENT'],
      }),
    ).resolves.toMatchObject({ status: 'conflict' });
    await expect(
      store.acknowledgeDelivery({ ...acknowledgement, source_kind: 'callback' }),
    ).resolves.toMatchObject({ status: 'conflict' });
    await store.destroy();
  });

  test('InMemory returns an exact committed ACK replay before later source staleness', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const sourceOrderScope = '9'.repeat(64);
    await store.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12346,
    });
    const claim = await store.claimLogicalTurn('memory-ack-source-replay', 'user-1', {
      ...telegramContext('conversation-ack-source-replay', 'opaque-ack-source-replay'),
      source_order_scope: sourceOrderScope,
      source_sequence: 12346,
    });
    const acknowledgement = {
      logical_turn_id: claim.interactionContext.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:111:1001',
      presentation_refs: ['telegram:111:1001'],
    };

    await expect(store.acknowledgeDelivery(acknowledgement)).resolves.toMatchObject({
      status: 'recorded',
      idempotent: false,
    });
    await store.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12347,
    });

    await expect(store.acknowledgeDelivery({ ...acknowledgement })).resolves.toMatchObject({
      status: 'recorded',
      idempotent: true,
      acknowledgement: expect.objectContaining({ presentation_ref: 'telegram:111:1001' }),
    });
    await expect(
      store.acknowledgeDelivery({
        ...acknowledgement,
        presentation_ref: 'telegram:111:CHANGED',
        presentation_refs: ['telegram:111:CHANGED'],
      }),
    ).resolves.toMatchObject({ status: 'conflict' });
    await store.destroy();
  });

  test('InMemory returns an exact saved committed ACK before old-revision rejection', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const sourceOrderScope = '7'.repeat(64);
    const context = (source_event_id: string, source_sequence: number): InteractionContext => ({
      ...telegramContext('conversation-saved-ack-replay', source_event_id),
      source_order_scope: sourceOrderScope,
      source_sequence,
    });
    const first = await store.claimLogicalTurn(
      'memory-saved-ack-n',
      'user-1',
      context('opaque-saved-ack-n', 12346),
    );
    const second = await store.claimLogicalTurn(
      'memory-saved-ack-n-plus-one',
      'user-1',
      context('opaque-saved-ack-n-plus-one', 12347),
    );
    const acknowledgement = Object.freeze({
      logical_turn_id: first.interactionContext.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:111:1001',
      presentation_refs: ['telegram:111:1001'],
      presentation_committed_at: 1_725_000_000_000,
    });
    const logicalTurnIndex = Reflect.get(store, 'logicalTurnIndex') as Map<
      string,
      { deliveryAcknowledgements: Map<number, typeof acknowledgement> }
    >;
    logicalTurnIndex
      .get(first.interactionContext.logical_turn_id!)!
      .deliveryAcknowledgements.set(1, acknowledgement);

    expect(second.interactionContext).toMatchObject({
      logical_turn_id: first.interactionContext.logical_turn_id,
      revision: 2,
    });
    await expect(
      store.acknowledgeDelivery({
        ...acknowledgement,
        presentation_committed_at: undefined,
      }),
    ).resolves.toMatchObject({ status: 'recorded', idempotent: true });
    await expect(
      store.acknowledgeDelivery({
        ...acknowledgement,
        presentation_ref: 'telegram:111:CHANGED',
        presentation_refs: ['telegram:111:CHANGED'],
        presentation_committed_at: undefined,
      }),
    ).resolves.toMatchObject({ status: 'conflict' });
    await store.destroy();
  });

  test.each([
    webContext('conversation-web-non-regression', 'web-event'),
    schedulerContext('conversation-scheduler-non-regression', 'scheduler-event'),
    {
      ...webContext('conversation-voice-non-regression', 'voice-event'),
      surface: 'voice' as const,
    },
  ])(
    'does not apply Telegram source fencing to $surface contexts without typed source order',
    async (context) => {
      const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
      await store.observeSourceOrder({ source_order_scope: 'f'.repeat(64), source_sequence: 999 });
      const claim = await store.claimLogicalTurn(
        `non-regression-${context.surface}`,
        'user-1',
        context,
      );
      await expect(
        store.acknowledgeDelivery({
          logical_turn_id: claim.interactionContext.logical_turn_id!,
          revision: 1,
          state: 'committed',
        }),
      ).resolves.toMatchObject({ status: 'recorded' });
      await store.destroy();
    },
  );

  test('revises one unresolved Telegram reply in source order without aborting accepted work', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const unresolvedTelegram = (event: string): InteractionContext =>
      telegramContext('conversation-independent', event);

    const first = await manager.createJob(
      'telegram-independent-a',
      'user-1',
      'conversation-independent',
      {
        interactionContext: unresolvedTelegram('event-a'),
        adapterCapabilities: {
          segment_stability: 'immediate',
          supersede_scope: 'response_only',
        },
        deliveryPolicy: externalDelivery,
      },
    );
    const second = await manager.createJob(
      'telegram-independent-b',
      'user-1',
      'conversation-independent',
      {
        interactionContext: unresolvedTelegram('event-b'),
        adapterCapabilities: {
          segment_stability: 'immediate',
          supersede_scope: 'response_only',
        },
        deliveryPolicy: externalDelivery,
      },
    );

    expect(first.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(second.metadata.interactionContext).toMatchObject({ revision: 2 });
    expect(first.metadata.interactionContext?.logical_turn_id).toBe(
      second.metadata.interactionContext?.logical_turn_id,
    );
    expect(first.abortController.signal.aborted).toBe(false);
    expect((await manager.getJob('telegram-independent-a'))?.status).toBe('superseded');
    expect((await manager.getJob('telegram-independent-b'))?.status).toBe('running');
    await manager.destroy();
  });

  test('retains rapid unresolved source segments once in exact event order without semantic dedupe', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const withSource = (
      event: string,
      text: string,
      source_files: NonNullable<InteractionContext['source_segments']>[number]['source_files'] = [],
    ): InteractionContext => ({
      ...telegramContext('conversation-sources', event),
      source_segments: [
        {
          ordinal: 0,
          source_event_id: event,
          source_index: 0,
          text,
          ...(source_files.length ? { source_files } : {}),
        },
      ],
    });

    const first = await manager.createJob('source-a', 'user-1', 'conversation-sources', {
      interactionContext: withSource('event-a', 'same exact request', [
        { file_id: 'file-a', filename: 'a.png', type: 'image/png', media_group_index: 0 },
      ]),
      adapterCapabilities: webCapabilities,
    });
    const second = await manager.createJob('source-b', 'user-1', 'conversation-sources', {
      interactionContext: withSource('event-b', 'same exact request'),
      adapterCapabilities: webCapabilities,
    });
    const replay = await manager.createJob('source-b-replay', 'user-1', 'conversation-sources', {
      interactionContext: withSource('event-b', 'same exact request'),
      adapterCapabilities: webCapabilities,
    });
    const third = await manager.createJob('source-c', 'user-1', 'conversation-sources', {
      interactionContext: withSource('event-c', 'third request'),
      adapterCapabilities: webCapabilities,
    });

    expect(replay.duplicateOfStreamId).toBe('source-b');
    expect(third.metadata.interactionContext?.source_segments).toEqual([
      {
        ordinal: 0,
        source_event_id: 'event-a',
        source_index: 0,
        text: 'same exact request',
        source_files: [
          { file_id: 'file-a', filename: 'a.png', type: 'image/png', media_group_index: 0 },
        ],
      },
      { ordinal: 1, source_event_id: 'event-b', source_index: 0, text: 'same exact request' },
      { ordinal: 2, source_event_id: 'event-c', source_index: 0, text: 'third request' },
    ]);
    expect(first.metadata.interactionContext?.source_segments).toHaveLength(1);
    expect(second.metadata.interactionContext?.source_segments).toHaveLength(2);
    await manager.destroy();
  });

  test('keeps the newest rapid source identity when three large segments exceed the bounded ledger', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const largeContext = (event: string, fill: string): InteractionContext => ({
      ...webContext('conversation-large-sources', event),
      source_segments: [
        {
          ordinal: 0,
          source_event_id: event,
          source_index: 0,
          text: fill.repeat(30 * 1024),
        },
      ],
    });

    await manager.createJob('large-a', 'user-1', 'conversation-large-sources', {
      interactionContext: largeContext('event-large-a', 'a'),
      adapterCapabilities: webCapabilities,
    });
    await manager.createJob('large-b', 'user-1', 'conversation-large-sources', {
      interactionContext: largeContext('event-large-b', 'b'),
      adapterCapabilities: webCapabilities,
    });
    const third = await manager.createJob('large-c', 'user-1', 'conversation-large-sources', {
      interactionContext: largeContext('event-large-c', 'c'),
      adapterCapabilities: webCapabilities,
    });

    expect(third.metadata.interactionContext).toMatchObject({
      source_event_id: 'event-large-c',
      source_segments_overflow_count: 1,
    });
    expect(
      third.metadata.interactionContext?.source_segments?.map((segment) => segment.source_event_id),
    ).toEqual(['event-large-b', 'event-large-c']);
    await manager.destroy();
  });

  test('supersedes one provisional revision and suppresses stale chunks and finals', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();

    const first = await manager.createJob('stream-a', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'event-a'),
      adapterCapabilities: webCapabilities,
    });
    const chunks: unknown[] = [];
    const terminals: unknown[] = [];
    await manager.subscribe(
      'stream-a',
      (event) => chunks.push(event),
      (event) => terminals.push(event),
    );

    const second = await manager.createJob('stream-c', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'event-c'),
      adapterCapabilities: webCapabilities,
    });

    expect(first.abortController.signal.aborted).toBe(true);
    expect(first.abortController.signal.reason).toBe('superseded');
    expect((await manager.getJob('stream-a'))?.status).toBe('superseded');
    expect(terminals).toEqual([
      expect.objectContaining({
        final: true,
        superseded: true,
        logical_turn_id: second.metadata.interactionContext?.logical_turn_id,
        revision: 1,
      }),
    ]);
    expect(terminals[0]).not.toEqual(expect.objectContaining({ aborted: true }));

    const chunkCountAfterSupersede = chunks.length;
    const terminalCountAfterSupersede = terminals.length;
    await manager.emitChunk('stream-a', {
      event: 'on_message_delta',
      data: { text: 'stale' },
    } as never);
    await manager.emitDone('stream-a', {
      final: true,
      responseMessage: { text: 'stale' },
    } as never);
    expect(chunks).toHaveLength(chunkCountAfterSupersede);
    expect(terminals).toHaveLength(terminalCountAfterSupersede);

    expect(second.metadata.interactionContext).toMatchObject({
      logical_turn_id: first.metadata.interactionContext?.logical_turn_id,
      revision: 2,
      source_event_id: 'event-c',
    });
    await manager.destroy();
  });

  /* === VIVENTIUM START ===
   * Feature: Durable logical-turn supersession.
   * Purpose: A best-effort old-stream terminal publish cannot roll back an admitted successor.
   */
  test('keeps the committed successor usable when the superseded terminal publish fails', async () => {
    const { logger } = await import('@librechat/data-schemas');
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const transport = new InMemoryEventTransport();
    const emitDone = transport.emitDone.bind(transport);
    jest.spyOn(transport, 'emitDone').mockImplementation((streamId, event) => {
      if (streamId === 'terminal-failure-old') {
        throw new Error('private transport detail must not be logged');
      }
      return emitDone(streamId, event);
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: transport,
      cleanupOnComplete: false,
    });

    try {
      await manager.createJob('terminal-failure-old', 'user-1', 'conversation-terminal', {
        interactionContext: webContext('conversation-terminal', 'event-old'),
        adapterCapabilities: webCapabilities,
      });
      const successor = await manager.createJob(
        'terminal-failure-current',
        'user-1',
        'conversation-terminal',
        {
          interactionContext: webContext('conversation-terminal', 'event-current'),
          adapterCapabilities: webCapabilities,
        },
      );

      expect(successor.status).toBe('running');
      expect(await store.isCurrentLogicalTurn('terminal-failure-current')).toBe(true);
      await expect(store.getJob('terminal-failure-old')).resolves.toMatchObject({
        status: 'superseded',
      });

      const replay = await manager.createJob(
        'terminal-failure-retry',
        'user-1',
        'conversation-terminal',
        {
          interactionContext: webContext('conversation-terminal', 'event-current'),
          adapterCapabilities: webCapabilities,
        },
      );
      expect(replay.streamId).toBe('terminal-failure-current');
      expect(replay.duplicateOfStreamId).toBe('terminal-failure-current');
      expect(warn).toHaveBeenCalledWith(
        '[GenerationJobManager] Superseded terminal notification unavailable after durable fence',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain('private transport detail');
    } finally {
      warn.mockRestore();
      await manager.destroy();
    }
  });
  /* === VIVENTIUM END === */

  /* === VIVENTIUM START ===
   * Feature: Exact stream supersession.
   * Purpose: An older delayed admission must not publish after a newer revision commits.
   * === VIVENTIUM END === */
  test('rejects an older admission whose successor committed while its abort listener waited', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    let releaseFirstListener!: () => void;
    const firstListenerReady = new Promise<void>((resolve) => {
      releaseFirstListener = resolve;
    });
    let markFirstListenerStarted!: () => void;
    const firstListenerStarted = new Promise<void>((resolve) => {
      markFirstListenerStarted = resolve;
    });
    const transport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn((streamId: string) => {
        if (streamId === 'delayed-revision-a') {
          markFirstListenerStarted();
          return firstListenerReady;
        }
        return Promise.resolve();
      }),
    });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: transport,
      cleanupOnComplete: false,
    });

    const older = manager.createJob('delayed-revision-a', 'user-1', 'conversation-delay', {
      interactionContext: webContext('conversation-delay', 'event-a'),
      adapterCapabilities: webCapabilities,
    });
    void older.catch(() => {});
    await firstListenerStarted;
    const newer = await manager.createJob('committed-revision-b', 'user-1', 'conversation-delay', {
      interactionContext: webContext('conversation-delay', 'event-b'),
      adapterCapabilities: webCapabilities,
    });

    releaseFirstListener();
    await expect(older).rejects.toMatchObject({ code: 'stream_id_conflict' });
    await expect(store.getJob('delayed-revision-a')).resolves.toBeNull();
    expect(newer.status).toBe('running');
    expect(newer.abortController.signal.aborted).toBe(false);
    expect(await store.isCurrentLogicalTurn('committed-revision-b')).toBe(true);
    await manager.destroy();
  });

  test('classifies a fenced older ordered source as silently superseded', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    let releaseOlderListener!: () => void;
    const olderListenerReleased = new Promise<void>((resolve) => {
      releaseOlderListener = resolve;
    });
    let markOlderListenerStarted!: () => void;
    const olderListenerStarted = new Promise<void>((resolve) => {
      markOlderListenerStarted = resolve;
    });
    const transport = Object.assign(new InMemoryEventTransport(), {
      onAbort: jest.fn((streamId: string) => {
        if (streamId === 'ordered-delayed-revision-a') {
          markOlderListenerStarted();
          return olderListenerReleased;
        }
        return Promise.resolve();
      }),
    });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: transport,
      cleanupOnComplete: false,
    });
    manager.initialize();
    const sourceOrderScope = 'f'.repeat(64);
    const context = (source_event_id: string, source_sequence: number): InteractionContext => ({
      ...telegramContext('conversation-ordered-delay', source_event_id),
      source_order_scope: sourceOrderScope,
      source_sequence,
    });

    await manager.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12346,
    });
    const older = manager.createJob(
      'ordered-delayed-revision-a',
      'user-1',
      'conversation-ordered-delay',
      { interactionContext: context('ordered-event-a', 12346) },
    );
    void older.catch(() => {});
    await olderListenerStarted;
    await manager.observeSourceOrder({
      source_order_scope: sourceOrderScope,
      source_sequence: 12347,
    });
    const newer = await manager.createJob(
      'ordered-committed-revision-b',
      'user-1',
      'conversation-ordered-delay',
      { interactionContext: context('ordered-event-b', 12347) },
    );

    releaseOlderListener();
    await expect(older).rejects.toMatchObject({ code: 'source_order_superseded' });
    await expect(store.getJob('ordered-delayed-revision-a')).resolves.toBeNull();
    expect(newer.status).toBe('running');
    expect(newer.abortController.signal.aborted).toBe(false);
    expect(await store.isCurrentLogicalTurn('ordered-committed-revision-b')).toBe(true);
    await manager.destroy();
  });

  test('suppresses stale authoring from durable abort truth when pubsub delivery is lost', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const authorTransport = new InMemoryEventTransport();
    const emitChunk = jest.spyOn(authorTransport, 'emitChunk');
    const authorManager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: authorTransport,
      cleanupOnComplete: false,
    });
    const controlTransport = Object.assign(new InMemoryEventTransport(), {
      emitAbort: jest.fn(() => undefined),
    });
    const controlManager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: controlTransport,
      cleanupOnComplete: true,
    });
    const authorJob = await authorManager.createJob(
      'lost-abort-delivery',
      'user-1',
      'conversation-abort',
      {
        interactionContext: webContext('conversation-abort', 'event-abort'),
        adapterCapabilities: webCapabilities,
      },
    );

    const abortResult = await controlManager.abortJob('lost-abort-delivery');
    expect(abortResult.success).toBe(true);
    expect(controlTransport.emitAbort).toHaveBeenCalledTimes(1);
    expect(authorJob.abortController.signal.aborted).toBe(false);
    await expect(store.getJob('lost-abort-delivery')).resolves.toBeNull();

    await authorManager.emitChunk('lost-abort-delivery', {
      event: 'on_message_delta',
      data: { text: 'must-not-publish' },
    } as never);

    expect(emitChunk).not.toHaveBeenCalled();
    expect(authorJob.abortController.signal.aborted).toBe(true);
    expect(await store.isCurrentLogicalTurn('lost-abort-delivery')).toBe(false);
    await controlManager.destroy();
    await authorManager.destroy();
  });

  test('isolates scheduler authoring from an interactive logical turn in the same conversation', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const interactive = await manager.createJob('interactive-a', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'interactive-a'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: serverDelivery,
    });
    const scheduler = await manager.createJob('scheduler-a', 'user-1', 'conversation-1', {
      interactionContext: schedulerContext('conversation-1', 'scheduler-a'),
      adapterCapabilities: {
        segment_stability: 'immediate',
        supersede_scope: 'response_only',
      },
      deliveryPolicy: serverDelivery,
    });

    expect(interactive.abortController.signal.aborted).toBe(false);
    expect((await manager.getJob('interactive-a'))?.status).toBe('running');
    expect(scheduler.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(scheduler.metadata.interactionContext?.logical_turn_id).not.toBe(
      interactive.metadata.interactionContext?.logical_turn_id,
    );

    const interactiveFollowUp = await manager.createJob(
      'interactive-c',
      'user-1',
      'conversation-1',
      {
        interactionContext: webContext('conversation-1', 'interactive-c'),
        adapterCapabilities: webCapabilities,
        deliveryPolicy: serverDelivery,
      },
    );
    expect(interactive.abortController.signal.aborted).toBe(true);
    expect(interactiveFollowUp.metadata.interactionContext).toMatchObject({ revision: 2 });
    expect(interactiveFollowUp.metadata.interactionContext?.logical_turn_id).toBe(
      interactive.metadata.interactionContext?.logical_turn_id,
    );
    expect((await manager.getJob('scheduler-a'))?.status).toBe('running');
    await manager.destroy();
  });

  test('reconciles a persisted web final after restart before claiming the next user turn', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const firstProcess = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    firstProcess.initialize();
    const first = await firstProcess.createJob('web-a', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'web-a'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: serverDelivery,
    });
    await firstProcess.updateMetadata('web-a', { responseMessageId: 'assistant-b' });
    await firstProcess.markMainResponseComplete('web-a', {
      final: true,
      responseMessage: { messageId: 'assistant-b', text: 'persisted B' },
    } as never);
    await firstProcess.emitDone('web-a', {
      final: true,
      responseMessage: { messageId: 'assistant-b', text: 'persisted B' },
    } as never);

    const restartedProcess = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    restartedProcess.initialize();
    const followUp = await restartedProcess.createJob('web-c', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'web-c'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: serverDelivery,
    });

    expect(followUp.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(followUp.metadata.interactionContext?.logical_turn_id).not.toBe(
      first.metadata.interactionContext?.logical_turn_id,
    );
    expect((await restartedProcess.getJob('web-a'))?.status).toBe('complete');
    expect(first.abortController.signal.aborted).toBe(false);
    await restartedProcess.destroy();
  });

  test('deduplicates a source event without creating another revision', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();

    const first = await manager.createJob('stream-a', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'event-a'),
      adapterCapabilities: webCapabilities,
    });
    const duplicate = await manager.createJob('stream-duplicate', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'event-a'),
      adapterCapabilities: webCapabilities,
    });

    expect(duplicate.duplicateOfStreamId).toBe('stream-a');
    expect(duplicate.metadata.interactionContext).toEqual(first.metadata.interactionContext);
    expect(await manager.hasJob('stream-duplicate')).toBe(false);
    expect(await manager.getActiveJobIdsForUser('user-1')).toEqual(['stream-a']);
    await manager.destroy();
  });

  /* === VIVENTIUM START ===
   * Feature: Exact resumable-stream liveness.
   * Purpose: Preserve both stream identities when overlapping runs share one conversation.
   * === VIVENTIUM END === */
  test('projects overlapping active streams without collapsing their exact identities', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();

    await manager.createJob('stream-a', 'user-1', 'conversation-1', {
      interactionContext: {
        ...telegramContext('conversation-1', 'event-a'),
        turn_scope: 'source_event',
      },
      adapterCapabilities: {
        segment_stability: 'immediate',
        supersede_scope: 'response_only',
      },
    });
    await manager.createJob('stream-b', 'user-1', 'conversation-1', {
      interactionContext: {
        ...telegramContext('conversation-1', 'event-b'),
        turn_scope: 'source_event',
      },
      adapterCapabilities: {
        segment_stability: 'immediate',
        supersede_scope: 'response_only',
      },
    });

    expect(await manager.getActiveConversationIdsForUser('user-1')).toEqual(['conversation-1']);
    expect(await manager.getActiveStreamsForUser('user-1')).toEqual([
      { streamId: 'stream-a', conversationId: 'conversation-1' },
      { streamId: 'stream-b', conversationId: 'conversation-1' },
    ]);
    await manager.markMainResponseComplete('stream-a', { final: true } as never);
    await manager.emitDone('stream-a', { final: true } as never);
    expect(await manager.getActiveConversationIdsForUser('user-1')).toEqual(['conversation-1']);
    expect(await manager.getActiveStreamsForUser('user-1')).toEqual([
      { streamId: 'stream-b', conversationId: 'conversation-1' },
    ]);
    await manager.markMainResponseComplete('stream-b', { final: true } as never);
    await manager.emitDone('stream-b', { final: true } as never);
    expect(await manager.getActiveConversationIdsForUser('user-1')).toEqual([]);
    expect(await manager.getActiveStreamsForUser('user-1')).toEqual([]);
    await manager.destroy();
  });

  /* === VIVENTIUM START ===
   * Feature: Owner-safe logical-turn reservation.
   * Purpose: A conflicting stream key must not overwrite or roll back the first owner's turn.
   * === VIVENTIUM END === */
  test('preserves the original logical turn when another owner collides on its stream key', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();

    const original = await manager.createJob('shared-stream', 'owner-a', 'conversation-a', {
      interactionContext: webContext('conversation-a', 'owner-a-event'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: serverDelivery,
    });

    await expect(
      manager.createJob('shared-stream', 'owner-b', 'conversation-b', {
        interactionContext: webContext('conversation-b', 'owner-b-event'),
        adapterCapabilities: webCapabilities,
        deliveryPolicy: serverDelivery,
      }),
    ).rejects.toMatchObject({ code: 'stream_id_conflict' });

    const persistedOriginal = await manager.getJob('shared-stream');
    expect(persistedOriginal?.metadata.userId).toBe('owner-a');
    expect(persistedOriginal?.metadata.conversationId).toBe('conversation-a');
    expect(original.abortController.signal.aborted).toBe(false);
    await store.updateJob('shared-stream', { status: 'complete', completedAt: Date.now() });
    await store.completeLogicalTurn('shared-stream');

    const next = await manager.createJob('owner-a-next', 'owner-a', 'conversation-a', {
      interactionContext: webContext('conversation-a', 'owner-a-next-event'),
      adapterCapabilities: webCapabilities,
    });
    expect(next.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(next.metadata.interactionContext?.logical_turn_id).not.toBe(
      original.metadata.interactionContext?.logical_turn_id,
    );
    expect((await manager.getJob('shared-stream'))?.status).toBe('complete');
    expect(original.abortController.signal.aborted).toBe(false);
    await manager.destroy();
  });

  test('does not let an unclaimed creator steal another owner logical-turn reservation', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const claimed = await store.claimLogicalTurn(
      'shared-reserved-stream',
      'owner-a',
      webContext('conversation-a', 'owner-a-event'),
    );

    await expect(
      store.createJob('shared-reserved-stream', 'owner-b', 'conversation-b'),
    ).rejects.toMatchObject({ code: 'stream_id_conflict' });
    await expect(
      store.createJob('shared-reserved-stream', 'owner-a', 'conversation-a', {
        interactionContext: claimed.interactionContext,
      }),
    ).resolves.toMatchObject({ userId: 'owner-a', conversationId: 'conversation-a' });
  });

  test('retires terminal ownership before reusing the same canonical stream id', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();

    const first = await manager.createJob('conversation-a', 'owner-a', 'conversation-a', {
      interactionContext: webContext('conversation-a', 'event-a'),
      adapterCapabilities: webCapabilities,
    });
    await store.updateJob('conversation-a', { status: 'complete', completedAt: Date.now() });
    await store.completeLogicalTurn('conversation-a');
    await store.deleteJob('conversation-a');

    const second = await manager.createJob('conversation-a', 'owner-a', 'conversation-a', {
      interactionContext: webContext('conversation-a', 'event-b'),
      adapterCapabilities: webCapabilities,
    });
    expect(second.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(second.metadata.interactionContext?.logical_turn_id).not.toBe(
      first.metadata.interactionContext?.logical_turn_id,
    );
    await manager.destroy();
  });

  test('never retires a terminal turn through an older noncurrent revision id', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const first = await store.claimLogicalTurn(
      'stream-a',
      'owner-a',
      webContext('conversation-a', 'event-a'),
    );
    await store.createJob('stream-a', 'owner-a', 'conversation-a', {
      interactionContext: first.interactionContext,
    });
    const second = await store.claimLogicalTurn(
      'stream-b',
      'owner-a',
      webContext('conversation-a', 'event-b'),
    );
    await store.createJob('stream-b', 'owner-a', 'conversation-a', {
      interactionContext: second.interactionContext,
    });
    await store.completeLogicalTurn('stream-b');
    await store.deleteJob('stream-a');

    await expect(
      store.claimLogicalTurn('stream-a', 'owner-a', webContext('conversation-a', 'event-c')),
    ).rejects.toMatchObject({ code: 'stream_id_conflict' });
    await expect(store.getJob('stream-b')).resolves.toMatchObject({ userId: 'owner-a' });
    await expect(store.isCurrentLogicalTurn('stream-b')).resolves.toBe(true);
  });

  test('rejects a stale duplicate receipt that resolves to another owner job', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const ownerAClaim = await store.claimLogicalTurn(
      'shared-stale-stream',
      'owner-a',
      webContext('conversation-a', 'owner-a-event'),
    );
    const ownerAContext = ownerAClaim.interactionContext;
    await store.createJob('shared-stale-stream', 'owner-a', 'conversation-a', {
      interactionContext: ownerAContext,
    });
    jest.spyOn(store, 'claimLogicalTurn').mockResolvedValue({
      status: 'duplicate',
      streamId: 'shared-stale-stream',
      interactionContext: {
        ...webContext('conversation-b', 'owner-b-event'),
        logical_turn_id: 'logical-owner-b',
        revision: 1,
      },
      supersededStreamIds: [],
    });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });

    await expect(
      manager.createJob('owner-b-retry', 'owner-b', 'conversation-b', {
        interactionContext: webContext('conversation-b', 'owner-b-event'),
        adapterCapabilities: webCapabilities,
      }),
    ).rejects.toMatchObject({ code: 'stream_id_conflict' });
    await expect(store.getJob('shared-stale-stream')).resolves.toMatchObject({ userId: 'owner-a' });
    await manager.destroy();
  });

  test('does not erase an in-flight source receipt when the same source retries concurrently', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalCreateJob = store.createJob.bind(store);
    let releaseFirstCreate!: () => void;
    const firstCreateReleased = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    let markFirstCreateStarted!: () => void;
    const firstCreateStarted = new Promise<void>((resolve) => {
      markFirstCreateStarted = resolve;
    });
    jest
      .spyOn(store, 'createJob')
      .mockImplementationOnce(async (...args) => {
        markFirstCreateStarted();
        await firstCreateReleased;
        return originalCreateJob(...args);
      })
      .mockImplementation(originalCreateJob);
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const options = {
      interactionContext: webContext('conversation-inflight', 'same-source-event'),
      adapterCapabilities: webCapabilities,
    };

    const firstCreate = manager.createJob(
      'inflight-stream',
      'owner-a',
      'conversation-inflight',
      options,
    );
    await firstCreateStarted;
    await expect(
      manager.createJob('concurrent-retry', 'owner-a', 'conversation-inflight', options),
    ).rejects.toMatchObject({ code: 'stream_creation_pending' });
    expect(await manager.hasJob('concurrent-retry')).toBe(false);

    releaseFirstCreate();
    const first = await firstCreate;
    const replay = await manager.createJob(
      'settled-retry',
      'owner-a',
      'conversation-inflight',
      options,
    );
    expect(replay.duplicateOfStreamId).toBe('inflight-stream');
    expect(replay.metadata.interactionContext).toEqual(first.metadata.interactionContext);
    expect(await manager.hasJob('settled-retry')).toBe(false);
    await manager.destroy();
  });

  test('fails closed at active capacity and retires terminal ownership before reuse', async () => {
    const store = new InMemoryJobStore({ maxJobs: 1 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();

    const active = await manager.createJob('capacity-active', 'owner-a', 'conversation-a', {
      interactionContext: webContext('conversation-a', 'event-a'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: serverDelivery,
    });
    await expect(
      manager.createJob('capacity-blocked', 'owner-b', 'conversation-b', {
        interactionContext: webContext('conversation-b', 'event-b'),
        adapterCapabilities: webCapabilities,
      }),
    ).rejects.toMatchObject({ code: 'stream_capacity_exhausted' });
    expect(active.abortController.signal.aborted).toBe(false);
    expect(await manager.hasJob('capacity-active')).toBe(true);
    expect(await manager.hasJob('capacity-blocked')).toBe(false);

    await manager.acknowledgeStreamDelivery('capacity-active', { state: 'committed' });
    await manager.completeJob('capacity-active');
    await store.cleanup();
    const admitted = await manager.createJob(
      'capacity-after-terminal',
      'owner-b',
      'conversation-b',
      {
        interactionContext: webContext('conversation-b', 'event-b'),
        adapterCapabilities: webCapabilities,
      },
    );
    expect(admitted.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(await manager.hasJob('capacity-active')).toBe(false);

    const indexes = store as unknown as {
      logicalTurns: Map<string, unknown>;
      streamScopes: Map<string, string>;
      userJobMap: Map<string, Set<string>>;
    };
    expect(indexes.logicalTurns.size).toBe(1);
    expect(indexes.streamScopes.size).toBe(1);
    expect(indexes.userJobMap.size).toBe(1);
    await manager.destroy();
  });

  test('rolls back overlapping provisional claims after capacity rejection without poisoning retry', async () => {
    const store = new InMemoryJobStore({ maxJobs: 1 });
    await store.initialize();
    await store.createJob('capacity-holder', 'holder', 'holder-conversation');
    let releaseCreateQueue!: () => void;
    const heldCreateQueue = new Promise<void>((resolve) => {
      releaseCreateQueue = resolve;
    });
    (store as unknown as { createJobTail: Promise<void> }).createJobTail = heldCreateQueue;
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    const eventA = {
      interactionContext: webContext('capacity-conversation', 'event-a'),
      adapterCapabilities: webCapabilities,
    };
    const eventB = {
      interactionContext: webContext('capacity-conversation', 'event-b'),
      adapterCapabilities: webCapabilities,
    };
    const first = manager.createJob(
      'capacity-stream-a',
      'owner-a',
      'capacity-conversation',
      eventA,
    );
    const second = manager.createJob(
      'capacity-stream-b',
      'owner-a',
      'capacity-conversation',
      eventB,
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseCreateQueue();

    await expect(first).rejects.toMatchObject({ code: 'stream_capacity_exhausted' });
    await expect(second).rejects.toMatchObject({ code: 'stream_capacity_exhausted' });
    await store.deleteJob('capacity-holder');

    const retry = await manager.createJob(
      'capacity-stream-a-retry',
      'owner-a',
      'capacity-conversation',
      eventA,
    );
    expect(retry.duplicateOfStreamId).toBeUndefined();
    expect(retry.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(await store.hasJob('capacity-stream-a-retry')).toBe(true);
    await manager.destroy();
  });

  test('rolls back a failed post-claim job create so the same source event can retry', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalCreateJob = store.createJob.bind(store);
    jest
      .spyOn(store, 'createJob')
      .mockRejectedValueOnce(new Error('synthetic create failure'))
      .mockImplementation(originalCreateJob);
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const options = {
      interactionContext: telegramContext('conversation-1', 'same-event'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    };

    await expect(
      manager.createJob('failed-stream', 'user-1', 'conversation-1', options),
    ).rejects.toThrow('synthetic create failure');
    const retry = await manager.createJob('retry-stream', 'user-1', 'conversation-1', options);

    expect(retry.duplicateOfStreamId).toBeUndefined();
    expect(retry.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(await manager.hasJob('retry-stream')).toBe(true);
    await manager.destroy();
  });

  test('failed-claim rollback never clobbers a concurrent newer owner', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const originalCreateJob = store.createJob.bind(store);
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    jest
      .spyOn(store, 'createJob')
      .mockImplementationOnce(async () => {
        await manager.createJob('takeover-stream', 'user-1', 'conversation-1', {
          interactionContext: telegramContext('conversation-1', 'takeover-event'),
          adapterCapabilities: webCapabilities,
          deliveryPolicy: externalDelivery,
        });
        throw new Error('late create failure');
      })
      .mockImplementation(originalCreateJob);

    await expect(
      manager.createJob('failed-stream', 'user-1', 'conversation-1', {
        interactionContext: telegramContext('conversation-1', 'failed-event'),
        adapterCapabilities: webCapabilities,
        deliveryPolicy: externalDelivery,
      }),
    ).rejects.toThrow('late create failure');

    expect(await store.isCurrentLogicalTurn('takeover-stream')).toBe(true);
    expect(await manager.getJob('takeover-stream')).toMatchObject({ status: 'running' });
    const retry = await manager.createJob('retry-stream', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'failed-event'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });
    expect(retry.duplicateOfStreamId).toBeUndefined();
    expect(retry.metadata.interactionContext).toMatchObject({ revision: 3 });
    expect(await manager.getJob('takeover-stream')).toMatchObject({ status: 'superseded' });
    await manager.destroy();
  });

  test('starts a new logical turn after the prior turn reaches a normal terminal state', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();

    const first = await manager.createJob('stream-a', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'event-a'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: serverDelivery,
    });
    await manager.acknowledgeStreamDelivery('stream-a', { state: 'committed' });
    await manager.completeJob('stream-a');
    const next = await manager.createJob('stream-b', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'event-b'),
      adapterCapabilities: webCapabilities,
    });

    expect(next.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(next.metadata.interactionContext?.logical_turn_id).not.toBe(
      first.metadata.interactionContext?.logical_turn_id,
    );
    await manager.destroy();
  });

  test('supersedes generation-complete external output that has no presentation commit', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const first = await manager.createJob('stream-a', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'event-a'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });
    const terminals: unknown[] = [];
    await manager.subscribe(
      'stream-a',
      () => {},
      (event) => terminals.push(event),
    );
    await manager.markMainResponseComplete('stream-a', { final: true } as never);
    await manager.emitDone('stream-a', { final: true } as never);
    await manager.completeJob('stream-a');

    expect(first.abortController.signal.aborted).toBe(false);
    expect(await manager.getJob('stream-a')).toMatchObject({
      status: 'complete',
      metadata: {
        deliveryPolicy: externalDelivery,
      },
    });

    const second = await manager.createJob('stream-b', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'event-b'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });

    expect(first.abortController.signal.reason).toBe('superseded');
    expect((await manager.getJob('stream-a'))?.status).toBe('superseded');
    expect(second.metadata.interactionContext).toMatchObject({
      logical_turn_id: first.metadata.interactionContext?.logical_turn_id,
      revision: 2,
    });
    expect(terminals).toEqual([
      expect.objectContaining({ final: true }),
      expect.objectContaining({
        final: true,
        superseded: true,
        logical_turn_id: first.metadata.interactionContext?.logical_turn_id,
        revision: 1,
      }),
    ]);
    await manager.destroy();
  });

  test('normal completion terminalizes an already-superseded response-only stream without a receipt', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const responseOnlyCapabilities = {
      segment_stability: 'immediate' as const,
      supersede_scope: 'response_only' as const,
    };
    const first = await manager.createJob('response-old', 'user-1', 'conversation-response', {
      interactionContext: telegramContext('conversation-response', 'event-old'),
      adapterCapabilities: responseOnlyCapabilities,
      deliveryPolicy: externalDelivery,
    });
    const terminals: unknown[] = [];
    await manager.subscribe(
      'response-old',
      () => {},
      (event) => terminals.push(event),
    );

    await manager.createJob('response-new', 'user-1', 'conversation-response', {
      interactionContext: telegramContext('conversation-response', 'event-new'),
      adapterCapabilities: responseOnlyCapabilities,
      deliveryPolicy: externalDelivery,
    });
    expect(terminals).toEqual([]);

    await manager.completeJob('response-old');

    expect(terminals).toEqual([
      expect.objectContaining({
        final: true,
        superseded: true,
        logical_turn_id: first.metadata.interactionContext?.logical_turn_id,
        revision: 1,
      }),
    ]);
    await manager.destroy();
  });

  test('retains only the exact late Cortex presentation lane after external Main delivery commits', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    const responseOnlyCapabilities = {
      segment_stability: 'immediate' as const,
      supersede_scope: 'response_only' as const,
    };
    const main = await manager.createJob('telegram-late-cortex', 'owner-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-late-cortex'),
      adapterCapabilities: responseOnlyCapabilities,
      deliveryPolicy: externalDelivery,
    });
    await manager.updateMetadata('telegram-late-cortex', { responseMessageId: 'parent-1' });
    await manager.markMainResponseComplete('telegram-late-cortex', { final: true } as never);
    await manager.emitDone('telegram-late-cortex', { final: true } as never);
    const mainAcknowledgement = {
      logical_turn_id: main.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:synthetic-chat:synthetic-main',
    };
    await manager.acknowledgeDelivery(mainAcknowledgement, 'telegram');
    await manager.completeJob('telegram-late-cortex');

    expect(main.abortController.signal.aborted).toBe(false);
    const cortexReceipt = {
      ownerId: 'owner-1',
      messageId: 'follow-up-1',
      parentMessageId: 'parent-1',
      revision: 1,
      generation: 1,
      deliveryIds: ['delivery-1'],
      deliveryReceipts: [{ deliveryId: 'delivery-1', graphResultHash: 'a'.repeat(64) }],
      claimToken: 'claim-1',
      presentationLeaseToken: 'presentation-lease-1',
    };
    await expect(
      manager.emitChunk(
        'telegram-late-cortex',
        {
          event: 'on_cortex_followup',
          data: {
            messageId: 'follow-up-1',
            parentMessageId: 'parent-1',
            revision: 1,
            presentationGeneration: 1,
          },
        },
        {
          verifyCortexPresentation: jest.fn().mockResolvedValue(cortexReceipt),
        },
      ),
    ).resolves.toMatchObject({
      delivered: true,
      streamId: 'telegram-late-cortex',
      presentationRef: 'sse:telegram-late-cortex:follow-up-1:1',
    });
    const cortexAcknowledgement = {
      logical_turn_id: main.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:synthetic-chat:synthetic-follow-up',
    };
    await expect(
      manager.acknowledgeDelivery(cortexAcknowledgement, 'telegram', cortexReceipt),
    ).resolves.toMatchObject({
      status: 'recorded',
      idempotent: false,
      presentation: {
        cortexPresentation: { messageId: 'follow-up-1', generation: 1, claimToken: 'claim-1' },
      },
    });
    await expect(
      manager.acknowledgeDelivery(cortexAcknowledgement, 'telegram', cortexReceipt),
    ).resolves.toMatchObject({ status: 'recorded', idempotent: true });
    await expect(
      manager.acknowledgeDelivery(
        {
          ...cortexAcknowledgement,
          presentation_ref: 'telegram:synthetic-chat:conflicting-follow-up',
        },
        'telegram',
        cortexReceipt,
      ),
    ).resolves.toEqual({ status: 'conflict' });
    await expect(
      manager.acknowledgeDelivery(mainAcknowledgement, 'telegram'),
    ).resolves.toMatchObject({
      status: 'recorded',
      idempotent: true,
      presentation: expect.not.objectContaining({ cortexPresentation: expect.anything() }),
    });
    await expect(
      manager.emitChunk('telegram-late-cortex', {
        event: 'on_message_delta',
        data: { text: 'late Main output must stay closed' },
      }),
    ).resolves.toEqual({
      delivered: false,
      streamId: 'telegram-late-cortex',
      reason: 'runtime_unavailable',
    });

    await manager.destroy();
  });

  test.each(['partial_removed'] as const)(
    'keeps external turn open after recoverable non-delivery outcome %s',
    async (deliveryState) => {
      const manager = new GenerationJobManagerClass({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
        eventTransport: new InMemoryEventTransport(),
        cleanupOnComplete: false,
      });
      manager.initialize();
      const first = await manager.createJob('telegram-a', 'user-1', 'conversation-1', {
        interactionContext: telegramContext('conversation-1', 'event-a'),
        adapterCapabilities: webCapabilities,
        deliveryPolicy: externalDelivery,
      });
      await manager.markMainResponseComplete('telegram-a', { final: true } as never);
      await manager.emitDone('telegram-a', { final: true } as never);
      await manager.completeJob('telegram-a');
      await expect(
        manager.acknowledgeDelivery(
          {
            logical_turn_id: first.metadata.interactionContext!.logical_turn_id!,
            revision: 1,
            state: deliveryState,
          },
          'telegram',
        ),
      ).resolves.toMatchObject({ status: 'recorded' });

      const followUp = await manager.createJob('telegram-c', 'user-1', 'conversation-1', {
        interactionContext: telegramContext('conversation-1', 'event-c'),
        adapterCapabilities: webCapabilities,
        deliveryPolicy: externalDelivery,
      });

      expect((await manager.getJob('telegram-a'))?.status).toBe('superseded');
      expect(followUp.metadata.interactionContext).toMatchObject({
        revision: 2,
        logical_turn_id: first.metadata.interactionContext?.logical_turn_id,
      });
      await manager.destroy();
    },
  );

  test('closes the current external turn after terminal failed delivery', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const first = await manager.createJob('telegram-a', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-a'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });
    await manager.markMainResponseComplete('telegram-a', { final: true } as never);
    await manager.emitDone('telegram-a', { final: true } as never);
    await manager.completeJob('telegram-a');
    await expect(
      manager.acknowledgeDelivery(
        {
          logical_turn_id: first.metadata.interactionContext!.logical_turn_id!,
          revision: 1,
          state: 'failed',
        },
        'telegram',
      ),
    ).resolves.toMatchObject({ status: 'recorded' });

    const followUp = await manager.createJob('telegram-c', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-c'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });

    expect((await manager.getJob('telegram-a'))?.status).toBe('complete');
    expect(followUp.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(followUp.metadata.interactionContext?.logical_turn_id).not.toBe(
      first.metadata.interactionContext?.logical_turn_id,
    );
    await manager.destroy();
  });

  test('response_only supersession suppresses stale presentation without aborting durable work', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const responseOnly = {
      segment_stability: 'provisional' as const,
      supersede_scope: 'response_only' as const,
    };
    const first = await manager.createJob('voice-a', 'user-1', 'conversation-1', {
      interactionContext: { ...webContext('conversation-1', 'event-a'), surface: 'voice' },
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    const chunks: unknown[] = [];
    const terminals: unknown[] = [];
    await manager.subscribe(
      'voice-a',
      (event) => chunks.push(event),
      (event) => terminals.push(event),
    );
    await manager.createJob('voice-c', 'user-1', 'conversation-1', {
      interactionContext: { ...webContext('conversation-1', 'event-c'), surface: 'voice' },
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    expect(terminals).toEqual([]);
    await manager.emitChunk('voice-a', {
      event: 'on_message_delta',
      data: { text: 'stale durable completion prose' },
    } as never);
    await manager.emitDone('voice-a', {
      final: true,
      responseMessage: { text: 'stale durable completion prose' },
    } as never);

    expect(first.abortController.signal.aborted).toBe(false);
    expect((await manager.getJob('voice-a'))?.status).toBe('superseded');
    expect(chunks).toEqual([]);
    expect(terminals).toEqual([
      expect.objectContaining({ final: true, superseded: true, revision: 1 }),
    ]);
    await manager.destroy();
  });

  test('response_only supersession closes the stale adapter when authoring later fails', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const responseOnly = {
      segment_stability: 'provisional' as const,
      supersede_scope: 'response_only' as const,
    };
    const first = await manager.createJob('telegram-error-a', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-a'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    const terminals: unknown[] = [];
    await manager.subscribe(
      'telegram-error-a',
      () => {},
      (event) => terminals.push(event),
    );
    await manager.createJob('telegram-error-b', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-b'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });

    await manager.emitError('telegram-error-a', 'synthetic_provider_failure');

    expect(terminals).toEqual([
      expect.objectContaining({ final: true, superseded: true, revision: 1 }),
    ]);
    expect(first.abortController.signal.aborted).toBe(true);
    expect((await manager.getJob('telegram-error-a'))?.metadata.generationCompleted).toBe(true);
    await manager.destroy();
  });

  test('a live turn can bind several durable launches without ending its response stream', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const responseOnly = {
      segment_stability: 'provisional' as const,
      supersede_scope: 'response_only' as const,
    };
    await manager.createJob('telegram-multi', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-multi'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    await manager.updateMetadata('telegram-multi', { responseMessageId: 'response-multi' });
    const terminals: unknown[] = [];
    await manager.subscribe(
      'telegram-multi',
      () => {},
      (event) => terminals.push(event),
    );

    for (const effectRef of ['work-a', 'work-b']) {
      await expect(
        manager.markDurableEffectReceipt({
          streamId: 'telegram-multi',
          userId: 'user-1',
          sourceEventId: 'event-multi',
          responseMessageId: 'response-multi',
          effectKind: 'durable_work_accepted',
          effectRef,
        }),
      ).resolves.toBe(true);
    }

    expect(terminals).toEqual([]);
    expect((await manager.getJob('telegram-multi'))?.metadata.durableEffectReceipts).toHaveLength(
      2,
    );
    await manager.destroy();
  });

  test('records a fallback lock receipt for server-authored web work without granting presentation authority', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    await manager.createJob('web-durable-work', 'user-1', 'conversation-1', {
      interactionContext: webContext('conversation-1', 'web-event-1'),
    });
    await manager.updateMetadata('web-durable-work', { responseMessageId: 'web-response-1' });
    const terminals: unknown[] = [];
    await manager.subscribe(
      'web-durable-work',
      () => {},
      (event) => terminals.push(event),
    );

    await expect(
      manager.markDurableEffectReceipt({
        streamId: 'web-durable-work',
        userId: 'user-1',
        sourceEventId: 'web-event-1',
        responseMessageId: 'web-response-1',
        effectKind: 'durable_work_accepted',
        effectRef: 'work-web-1',
      }),
    ).resolves.toBe(true);

    const persisted = await manager.getJob('web-durable-work');
    expect(persisted?.metadata.durableEffectReceipts).toEqual([
      expect.objectContaining({ effect_ref: 'work-web-1' }),
    ]);
    expect(persisted?.metadata.durableEffectReceipt).toBeUndefined();
    expect(terminals).toEqual([]);
    await manager.destroy();
  });

  test('a durable receipt that lands during supersession still presents immediately once', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const responseOnly = {
      segment_stability: 'provisional' as const,
      supersede_scope: 'response_only' as const,
    };
    await manager.createJob('telegram-race-a', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-race-a'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    await manager.updateMetadata('telegram-race-a', { responseMessageId: 'response-race-a' });
    const terminals: unknown[] = [];
    await manager.subscribe(
      'telegram-race-a',
      () => {},
      (event) => terminals.push(event),
    );

    let releaseSupersession!: () => void;
    let supersessionUpdateReached!: () => void;
    const supersessionGate = new Promise<void>((resolve) => {
      releaseSupersession = resolve;
    });
    const supersessionReached = new Promise<void>((resolve) => {
      supersessionUpdateReached = resolve;
    });
    const updateJob = store.updateJob.bind(store);
    jest.spyOn(store, 'updateJob').mockImplementation(async (streamId, updates) => {
      if (streamId === 'telegram-race-a' && updates.status === 'superseded') {
        supersessionUpdateReached();
        await supersessionGate;
      }
      return updateJob(streamId, updates);
    });

    const successor = manager.createJob('telegram-race-b', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-race-b'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    await supersessionReached;
    await expect(
      manager.markDurableEffectReceipt({
        streamId: 'telegram-race-a',
        userId: 'user-1',
        sourceEventId: 'event-race-a',
        responseMessageId: 'response-race-a',
        effectKind: 'durable_work_accepted',
        effectRef: 'ghr_race_a',
      }),
    ).resolves.toBe(true);
    expect(terminals).toEqual([]);

    releaseSupersession();
    await successor;

    expect(terminals).toEqual([
      expect.objectContaining({
        final: true,
        responseMessage: expect.objectContaining({
          messageId: 'response-race-a',
          text: 'Background work started. Open Active Work to view or steer it.',
        }),
      }),
    ]);
    await manager.destroy();
  });

  test('response_only supersession delivers one final receipt after exact durable work proof', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const responseOnly = {
      segment_stability: 'provisional' as const,
      supersede_scope: 'response_only' as const,
    };
    await manager.createJob('telegram-work-a', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-a'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    await manager.updateMetadata('telegram-work-a', { responseMessageId: 'response-a' });
    const chunks: unknown[] = [];
    const terminals: unknown[] = [];
    await manager.subscribe(
      'telegram-work-a',
      (event) => chunks.push(event),
      (event) => terminals.push(event),
    );

    await manager.createJob('telegram-direct-b', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-b'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    expect(terminals).toEqual([]);
    await expect(
      manager.markDurableEffectReceipt({
        streamId: 'telegram-work-a',
        userId: 'user-1',
        sourceEventId: 'event-a',
        responseMessageId: 'response-a',
        effectKind: 'durable_work_accepted',
        effectRef: 'ghr_background_a',
      }),
    ).resolves.toBe(true);
    expect(terminals).toEqual([
      expect.objectContaining({
        final: true,
        conversation: { conversationId: 'conversation-1' },
        responseMessage: expect.objectContaining({
          messageId: 'response-a',
          text: 'Background work started. Open Active Work to view or steer it.',
        }),
      }),
    ]);
    await manager.emitChunk('telegram-work-a', {
      event: 'on_message_delta',
      data: { text: 'Running independently in the background.' },
    } as never);
    const laterModelFinal = {
      final: true,
      responseMessage: {
        messageId: 'response-a',
        text: 'Running independently in the background.',
      },
    } as never;
    await manager.emitDone('telegram-work-a', laterModelFinal);

    expect(chunks).toEqual([]);
    expect(terminals).toEqual([
      expect.objectContaining({
        final: true,
        responseMessage: expect.objectContaining({
          messageId: 'response-a',
          text: 'Background work started. Open Active Work to view or steer it.',
        }),
      }),
    ]);
    await expect(store.isCurrentLogicalTurn('telegram-direct-b')).resolves.toBe(true);
    await expect(store.isCurrentLogicalTurn('telegram-work-a')).resolves.toBe(false);
    await expect(
      manager.markDurableEffectReceipt({
        streamId: 'telegram-work-a',
        userId: 'user-1',
        sourceEventId: 'wrong-event',
        responseMessageId: 'response-a',
        effectKind: 'durable_work_accepted',
        effectRef: 'ghr_forged',
      }),
    ).resolves.toBe(false);
    await manager.destroy();
  });

  test('response_only supersession presents a settled existing-work action and closes once', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const responseOnly = {
      segment_stability: 'provisional' as const,
      supersede_scope: 'response_only' as const,
    };
    await manager.createJob('telegram-action-a', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-action-a'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    await manager.updateMetadata('telegram-action-a', { responseMessageId: 'response-action-a' });
    const terminals: unknown[] = [];
    await manager.subscribe(
      'telegram-action-a',
      () => {},
      (event) => terminals.push(event),
    );

    await manager.createJob('telegram-action-b', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-action-b'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    await expect(
      manager.markDurableEffectReceipt({
        streamId: 'telegram-action-a',
        userId: 'user-1',
        sourceEventId: 'event-action-a',
        responseMessageId: 'response-action-a',
        effectKind: 'durable_work_action_accepted',
        effectRef: `work_action_${'a'.repeat(64)}`,
      }),
    ).resolves.toBe(true);

    expect(terminals).toEqual([
      expect.objectContaining({
        final: true,
        responseMessage: expect.objectContaining({
          messageId: 'response-action-a',
          text: 'Background work updated. Open Active Work to view or steer it.',
        }),
      }),
    ]);
    await manager.emitDone('telegram-action-a', {
      final: true,
      responseMessage: { messageId: 'response-action-a', text: 'late model prose' },
    } as never);
    expect(terminals).toHaveLength(1);
    await manager.destroy();
  });

  test('records an idempotent delivery acknowledgement from server-held turn ownership', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const job = await manager.createJob('stream-a', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-a'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });
    const acknowledgement = {
      logical_turn_id: job.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'presentation-1',
    };

    await expect(manager.acknowledgeDelivery(acknowledgement, 'telegram')).resolves.toMatchObject({
      status: 'recorded',
      acknowledgement,
    });
    await expect(manager.acknowledgeDelivery(acknowledgement, 'telegram')).resolves.toMatchObject({
      status: 'recorded',
      acknowledgement,
      idempotent: true,
    });
    const followUp = await manager.createJob('stream-b', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-b'),
      adapterCapabilities: webCapabilities,
    });
    expect(followUp.metadata.interactionContext).toMatchObject({ revision: 1 });
    expect(followUp.metadata.interactionContext?.logical_turn_id).not.toBe(
      acknowledgement.logical_turn_id,
    );
    expect(job.abortController.signal.aborted).toBe(false);
    await manager.destroy();
  });

  test('does not attach a later Cortex follow-up to an ordinary Telegram answer acknowledgement', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    const job = await manager.createJob(
      'telegram-main-answer-cortex-race',
      'owner-1',
      'conversation-1',
      {
        interactionContext: telegramContext('conversation-1', 'event-main-answer-cortex-race'),
        adapterCapabilities: webCapabilities,
        deliveryPolicy: externalDelivery,
      },
    );
    await manager.updateMetadata('telegram-main-answer-cortex-race', {
      responseMessageId: 'main-answer-1',
    });
    await manager.bindCortexPresentation('telegram-main-answer-cortex-race', {
      ownerId: 'owner-1',
      messageId: 'cortex-follow-up-1',
      parentMessageId: 'main-answer-1',
      revision: 2,
      generation: 1,
      deliveryIds: ['delivery-1'],
      deliveryReceipts: [{ deliveryId: 'delivery-1', graphResultHash: 'a'.repeat(64) }],
      claimToken: 'claim-1',
      presentationLeaseToken: 'lease-1',
    });
    const acknowledgement = {
      logical_turn_id: job.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:synthetic-chat:main-answer-message',
    };

    await expect(manager.acknowledgeDelivery(acknowledgement, 'telegram')).resolves.toMatchObject({
      status: 'recorded',
      idempotent: false,
      presentation: expect.not.objectContaining({ cortexPresentation: expect.anything() }),
    });

    await manager.destroy();
  });

  test('attaches the exact generation-2 Cortex receipt to an idempotent Telegram retry', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    const job = await manager.createJob('telegram-cortex-retry', 'owner-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-cortex-retry'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });
    await manager.updateMetadata('telegram-cortex-retry', { responseMessageId: 'parent-1' });
    const acknowledgement = {
      logical_turn_id: job.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:synthetic-chat:synthetic-message',
    };
    const receipt = (generation: number) => ({
      ownerId: 'owner-1',
      messageId: 'parent-1',
      parentMessageId: 'parent-1',
      revision: 1,
      generation,
      deliveryIds: ['delivery-1'],
      deliveryReceipts: [{ deliveryId: 'delivery-1', graphResultHash: 'a'.repeat(64) }],
      claimToken: `claim-${generation}`,
      presentationLeaseToken: `lease-${generation}`,
    });
    const clock = jest.spyOn(Date, 'now');
    clock.mockReturnValue(1_000);
    await expect(
      manager.bindCortexPresentation('telegram-cortex-retry', receipt(1)),
    ).resolves.toMatchObject({
      generation: 1,
    });
    clock.mockReturnValue(2_000);
    await expect(
      manager.acknowledgeDelivery(acknowledgement, 'telegram', receipt(1)),
    ).resolves.toMatchObject({
      status: 'recorded',
      idempotent: false,
      presentation: { cortexPresentation: { generation: 1, claimToken: 'claim-1' } },
    });

    clock.mockReturnValue(3_000);
    await expect(
      manager.bindCortexPresentation('telegram-cortex-retry', receipt(2)),
    ).resolves.toMatchObject({
      generation: 2,
    });
    clock.mockReturnValue(4_000);
    await expect(
      manager.acknowledgeDelivery(acknowledgement, 'telegram', receipt(2)),
    ).resolves.toMatchObject({
      status: 'recorded',
      idempotent: true,
      presentation: { cortexPresentation: { generation: 2, claimToken: 'claim-2' } },
    });

    clock.mockRestore();
    await manager.destroy();
  });

  test('rejects a stale adapter Cortex presentation before recording its acknowledgement', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    const job = await manager.createJob(
      'telegram-cortex-stale-adapter',
      'owner-1',
      'conversation-1',
      {
        interactionContext: telegramContext('conversation-1', 'event-cortex-stale-adapter'),
        adapterCapabilities: webCapabilities,
        deliveryPolicy: externalDelivery,
      },
    );
    await manager.updateMetadata('telegram-cortex-stale-adapter', {
      responseMessageId: 'parent-1',
    });
    const acknowledgement = {
      logical_turn_id: job.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:synthetic-chat:synthetic-message',
    };
    const receipt = (generation: number) => ({
      ownerId: 'owner-1',
      messageId: 'follow-up-1',
      parentMessageId: 'parent-1',
      revision: generation,
      generation,
      deliveryIds: ['delivery-1'],
      deliveryReceipts: [{ deliveryId: 'delivery-1', graphResultHash: 'a'.repeat(64) }],
      claimToken: `claim-${generation}`,
      presentationLeaseToken: `lease-${generation}`,
    });
    await manager.bindCortexPresentation('telegram-cortex-stale-adapter', receipt(1));
    await manager.bindCortexPresentation('telegram-cortex-stale-adapter', receipt(2));

    await expect(
      manager.acknowledgeDelivery(acknowledgement, 'telegram', receipt(1)),
    ).resolves.toEqual({ status: 'conflict' });
    expect(
      (await manager.getJob('telegram-cortex-stale-adapter'))?.metadata.deliveryAcknowledgement,
    ).toBeUndefined();

    await expect(
      manager.acknowledgeDelivery(acknowledgement, 'telegram', receipt(2)),
    ).resolves.toMatchObject({
      status: 'recorded',
      presentation: { cortexPresentation: { generation: 2, claimToken: 'claim-2' } },
    });
    await manager.destroy();
  });

  test('returns a retryable conflict when generation 2 binds during an acknowledgement retry', async () => {
    let releaseAcknowledgement: (() => void) | undefined;
    let acknowledgementStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      acknowledgementStarted = resolve;
    });
    class OverlapAcknowledgementStore extends InMemoryJobStore {
      holdNextAcknowledgement = false;

      override async bindDeliveryAcknowledgement(
        streamId: string,
        acknowledgement: InteractionDeliveryAck,
        expectedCortexPresentation: CortexPresentationBinding | null,
      ) {
        if (this.holdNextAcknowledgement) {
          this.holdNextAcknowledgement = false;
          acknowledgementStarted?.();
          await new Promise<void>((resolve) => {
            releaseAcknowledgement = resolve;
          });
        }
        return super.bindDeliveryAcknowledgement(
          streamId,
          acknowledgement,
          expectedCortexPresentation,
        );
      }
    }

    const store = new OverlapAcknowledgementStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await manager.initialize();
    const job = await manager.createJob('telegram-cortex-overlap', 'owner-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-cortex-overlap'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });
    await manager.updateMetadata('telegram-cortex-overlap', { responseMessageId: 'parent-1' });
    const acknowledgement = {
      logical_turn_id: job.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:synthetic-chat:synthetic-message',
    };
    const receipt = (generation: number) => ({
      ownerId: 'owner-1',
      messageId: 'parent-1',
      parentMessageId: 'parent-1',
      revision: 1,
      generation,
      deliveryIds: ['delivery-1'],
      deliveryReceipts: [{ deliveryId: 'delivery-1', graphResultHash: 'a'.repeat(64) }],
      claimToken: `claim-${generation}`,
      presentationLeaseToken: `lease-${generation}`,
    });
    const clock = jest.spyOn(Date, 'now');

    try {
      clock.mockReturnValue(500);
      await manager.bindCortexPresentation('telegram-cortex-overlap', receipt(1));
      await manager.acknowledgeDelivery(acknowledgement, 'telegram', receipt(1));

      store.holdNextAcknowledgement = true;
      clock.mockReturnValue(1_000);
      const retry = manager.acknowledgeDelivery(acknowledgement, 'telegram', receipt(1));
      await started;
      clock.mockReturnValue(2_000);
      await manager.bindCortexPresentation('telegram-cortex-overlap', receipt(2));
      releaseAcknowledgement?.();

      await expect(retry).resolves.toEqual({ status: 'retryable_conflict' });
      clock.mockReturnValue(3_000);
      await expect(
        manager.acknowledgeDelivery(acknowledgement, 'telegram', receipt(2)),
      ).resolves.toMatchObject({
        status: 'recorded',
        idempotent: true,
        presentation: { cortexPresentation: { generation: 2, claimToken: 'claim-2' } },
      });
    } finally {
      releaseAcknowledgement?.();
      clock.mockRestore();
      await manager.destroy();
    }
  });

  /* === VIVENTIUM START ===
   * Feature: Authoritative presentation commit time.
   * Purpose: Prove the store stamps the first accepted presentation and preserves it on replay.
   */
  test('store-stamps presentation_committed_at once and ignores an adapter-supplied value', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const claim = await store.claimLogicalTurn(
      'presentation-time-stream',
      'user-1',
      telegramContext('presentation-time-conversation', 'presentation-time-event'),
    );
    const acknowledgement = {
      logical_turn_id: claim.interactionContext.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:1:10',
      presentation_committed_at: 1,
    };
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_725_000_000_123);

    const first = await store.acknowledgeDelivery(acknowledgement);
    now.mockReturnValue(1_725_000_999_999);
    const replay = await store.acknowledgeDelivery(acknowledgement);

    expect(first).toMatchObject({
      status: 'recorded',
      idempotent: false,
      acknowledgement: { presentation_committed_at: 1_725_000_000_123 },
    });
    expect(replay).toMatchObject({
      status: 'recorded',
      idempotent: true,
      acknowledgement: { presentation_committed_at: 1_725_000_000_123 },
    });
    expect(first.acknowledgement).toEqual(replay.acknowledgement);

    now.mockRestore();
    await store.destroy();
  });
  /* === VIVENTIUM END === */

  test('rejects cross-surface adapter credentials and server-authority revisions', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const telegram = await manager.createJob('telegram-stream', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'telegram-event'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });
    const telegramAck = {
      logical_turn_id: telegram.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
    };
    await expect(manager.acknowledgeDelivery(telegramAck, 'voice')).resolves.toMatchObject({
      status: 'conflict',
    });
    expect(
      (await manager.getJob('telegram-stream'))?.metadata.deliveryAcknowledgement,
    ).toBeUndefined();

    const web = await manager.createJob('web-stream', 'user-1', 'conversation-2', {
      interactionContext: webContext('conversation-2', 'web-event'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: serverDelivery,
    });
    await expect(
      manager.acknowledgeDelivery(
        {
          logical_turn_id: web.metadata.interactionContext!.logical_turn_id!,
          revision: 1,
          state: 'committed',
        },
        'telegram',
      ),
    ).resolves.toMatchObject({ status: 'conflict' });
    expect((await manager.getJob('web-stream'))?.metadata.deliveryAcknowledgement).toBeUndefined();
    await manager.destroy();
  });

  test('resolves only the exact server-owned scheduled Telegram transport receipt', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const scheduled = await manager.createJob('scheduled-stream', 'user-1', 'conversation-1', {
      interactionContext: {
        ...schedulerContext('conversation-1', 'scheduled-event'),
        schedule_id: 'schedule-1',
        schedule_run_id: 'run-1',
      },
      adapterCapabilities: webCapabilities,
      deliveryPolicy: serverDelivery,
    });
    await manager.updateMetadata('scheduled-stream', {
      responseMessageId: 'scheduled-response-1',
    });
    const acknowledgement = {
      logical_turn_id: scheduled.metadata.interactionContext!.logical_turn_id!,
      revision: 1,
      state: 'committed' as const,
      source_kind: 'schedule_result' as const,
      schedule_id: 'schedule-1',
      schedule_run_id: 'run-1',
      presentation_refs: ['telegram:1:10'],
    };

    await expect(
      manager.acknowledgeServerCommittedTransportReceipt(acknowledgement, 'telegram'),
    ).resolves.toMatchObject({
      status: 'recorded',
      transportOnly: true,
      presentation: {
        userId: 'user-1',
        conversationId: 'conversation-1',
        responseMessageId: 'scheduled-response-1',
      },
    });
    await expect(
      manager.acknowledgeServerCommittedTransportReceipt(
        { ...acknowledgement, schedule_run_id: 'forged-run' },
        'telegram',
      ),
    ).resolves.toMatchObject({ status: 'conflict' });
    await expect(
      manager.acknowledgeServerCommittedTransportReceipt(acknowledgement, 'voice'),
    ).resolves.toMatchObject({ status: 'conflict' });
    await manager.destroy();
  });

  test('rejects stale, unknown, and conflicting delivery acknowledgements', async () => {
    const manager = new GenerationJobManagerClass({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const first = await manager.createJob('stream-a', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-a'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });
    const logicalTurnId = first.metadata.interactionContext!.logical_turn_id!;
    await manager.createJob('stream-b', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'event-b'),
      adapterCapabilities: webCapabilities,
      deliveryPolicy: externalDelivery,
    });

    await expect(
      manager.acknowledgeDelivery(
        {
          logical_turn_id: logicalTurnId,
          revision: 1,
          state: 'committed',
        },
        'telegram',
      ),
    ).resolves.toMatchObject({ status: 'stale_revision' });
    await expect(
      manager.acknowledgeDelivery(
        {
          logical_turn_id: 'unknown-turn',
          revision: 1,
          state: 'failed',
        },
        'telegram',
      ),
    ).resolves.toMatchObject({ status: 'not_found' });

    const current = {
      logical_turn_id: logicalTurnId,
      revision: 2,
      state: 'committed' as const,
    };
    await manager.acknowledgeDelivery(current, 'telegram');
    await expect(
      manager.acknowledgeDelivery({ ...current, state: 'failed' }, 'telegram'),
    ).resolves.toMatchObject({ status: 'conflict' });
    await manager.destroy();
  });

  test.each(['partial_removed', 'failed'] as const)(
    'records superseded revision outcome %s without mutating the current revision',
    async (supersededState) => {
      const manager = new GenerationJobManagerClass({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 60_000 }),
        eventTransport: new InMemoryEventTransport(),
        cleanupOnComplete: false,
      });
      manager.initialize();
      const first = await manager.createJob('stream-a', 'user-1', 'conversation-1', {
        interactionContext: telegramContext('conversation-1', 'event-a'),
        adapterCapabilities: webCapabilities,
        deliveryPolicy: externalDelivery,
      });
      const logicalTurnId = first.metadata.interactionContext!.logical_turn_id!;
      const second = await manager.createJob('stream-b', 'user-1', 'conversation-1', {
        interactionContext: telegramContext('conversation-1', 'event-b'),
        adapterCapabilities: webCapabilities,
        deliveryPolicy: externalDelivery,
      });

      const supersededAcknowledgement = {
        logical_turn_id: logicalTurnId,
        revision: 1,
        state: supersededState,
        presentation_ref: 'old-presentation',
      };
      await expect(
        manager.acknowledgeDelivery(supersededAcknowledgement, 'telegram'),
      ).resolves.toMatchObject({
        status: 'recorded',
        idempotent: false,
      });
      await expect(
        manager.acknowledgeDelivery(supersededAcknowledgement, 'telegram'),
      ).resolves.toMatchObject({
        status: 'recorded',
        idempotent: true,
      });
      await expect(
        manager.acknowledgeDelivery(
          {
            ...supersededAcknowledgement,
            state: supersededState === 'failed' ? 'partial_removed' : 'failed',
          },
          'telegram',
        ),
      ).resolves.toMatchObject({ status: 'conflict' });
      await expect(
        manager.acknowledgeDelivery(
          {
            logical_turn_id: logicalTurnId,
            revision: 1,
            state: 'committed',
          },
          'telegram',
        ),
      ).resolves.toMatchObject({ status: 'conflict' });
      expect(second.metadata.interactionContext).toMatchObject({ revision: 2 });

      await expect(
        manager.acknowledgeDelivery(
          {
            logical_turn_id: logicalTurnId,
            revision: 2,
            state: 'committed',
          },
          'telegram',
        ),
      ).resolves.toMatchObject({ status: 'recorded', idempotent: false });
      await manager.destroy();
    },
  );

  test('records a server-authorized durable effect receipt for an older revision without retiring the current turn', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    manager.initialize();
    const responseOnly = {
      segment_stability: 'provisional' as const,
      supersede_scope: 'response_only' as const,
    };
    const first = await manager.createJob('effect-stream-a', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'effect-event-a'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    await manager.updateMetadata('effect-stream-a', { responseMessageId: 'effect-response-a' });
    const logicalTurnId = first.metadata.interactionContext!.logical_turn_id!;
    await manager.createJob('effect-stream-b', 'user-1', 'conversation-1', {
      interactionContext: telegramContext('conversation-1', 'effect-event-b'),
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });

    const acknowledgement = {
      logical_turn_id: logicalTurnId,
      revision: 1,
      state: 'committed' as const,
      presentation_ref: 'telegram:1:10',
    };

    await expect(
      manager.acknowledgeDurableEffectDelivery(acknowledgement, 'telegram'),
    ).resolves.toMatchObject({ status: 'conflict' });
    await expect(
      manager.markDurableEffectReceipt({
        streamId: 'effect-stream-a',
        userId: 'user-1',
        sourceEventId: 'effect-event-a',
        responseMessageId: 'effect-response-a',
        effectKind: 'durable_work_accepted',
        effectRef: 'work-effect-a',
      }),
    ).resolves.toBe(true);

    await expect(
      manager.acknowledgeDurableEffectDelivery(acknowledgement, 'telegram'),
    ).resolves.toMatchObject({
      status: 'recorded',
      acknowledgement: { state: 'committed_effect' },
      presentation: {
        userId: 'user-1',
        conversationId: 'conversation-1',
      },
    });
    await expect(store.isCurrentLogicalTurn('effect-stream-b')).resolves.toBe(true);
    await expect(store.isCurrentLogicalTurn('effect-stream-a')).resolves.toBe(false);
    await manager.destroy();
  });

  test('retires prior terminal turn indexes and stream scopes when a new turn begins', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const internals = store as unknown as {
      logicalTurns: Map<string, unknown>;
      logicalTurnIndex: Map<string, unknown>;
      streamScopes: Map<string, unknown>;
    };

    for (let index = 0; index < 12; index += 1) {
      const streamId = `bounded-stream-${index}`;
      const claim = await store.claimLogicalTurn(
        streamId,
        'bounded-user',
        telegramContext('bounded-conversation', `bounded-event-${index}`),
      );
      await store.createJob(streamId, 'bounded-user', 'bounded-conversation', {
        interactionContext: claim.interactionContext,
      });
      await store.completeLogicalTurn(streamId);
    }

    expect(internals.logicalTurns.size).toBe(1);
    expect(internals.logicalTurnIndex.size).toBe(1);
    expect(internals.streamScopes.size).toBe(1);
    await store.destroy();
  });

  test('cleanup expires the final terminal logical turn with its completed-job TTL', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    const store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const internals = store as unknown as {
      logicalTurns: Map<string, unknown>;
      logicalTurnIndex: Map<string, unknown>;
      streamScopes: Map<string, unknown>;
    };

    try {
      const claim = await store.claimLogicalTurn(
        'expiring-stream',
        'expiring-user',
        telegramContext('expiring-conversation', 'expiring-event'),
      );
      await store.createJob('expiring-stream', 'expiring-user', 'expiring-conversation', {
        interactionContext: claim.interactionContext,
      });
      await store.completeLogicalTurn('expiring-stream');

      now.mockReturnValue(61_001);
      await store.cleanup();

      expect(internals.logicalTurns.size).toBe(0);
      expect(internals.logicalTurnIndex.size).toBe(0);
      expect(internals.streamScopes.size).toBe(0);
    } finally {
      now.mockRestore();
      await store.destroy();
    }
  });
});
