import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import type { InteractionContext } from '../interfaces/IJobStore';

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
    await manager.markMainResponseComplete('voice-a', { final: true } as never);
    await manager.emitDone('voice-a', { final: true } as never);
    await manager.completeJob('voice-a');

    await manager.createJob('voice-c', 'user-1', 'conversation-1', {
      interactionContext: { ...webContext('conversation-1', 'event-c'), surface: 'voice' },
      adapterCapabilities: responseOnly,
      deliveryPolicy: externalDelivery,
    });
    await manager.emitChunk('voice-a', {
      event: 'on_message_delta',
      data: { text: 'stale durable completion prose' },
    } as never);

    expect(first.abortController.signal.aborted).toBe(false);
    expect((await manager.getJob('voice-a'))?.status).toBe('superseded');
    expect(chunks).toEqual([]);
    expect(terminals).toEqual([
      expect.objectContaining({ final: true }),
      expect.objectContaining({ final: true, superseded: true, revision: 1 }),
    ]);
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
      ).resolves.toMatchObject({ status: 'stale_revision' });
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
