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
