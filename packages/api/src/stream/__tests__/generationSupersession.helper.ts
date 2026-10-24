/* eslint-disable jest/no-export -- Shared contract uses the existing owned Redis fixture. */
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { admitted } from './nativeResponse.helper';
import type { NativeResponseIdentity } from '@librechat/data-schemas';
import type { IJobStore } from '../interfaces/IJobStore';

export function generationSupersessionContract(createStore: () => IJobStore) {
  let store: IJobStore;
  let manager: GenerationJobManagerClass;
  let transport: InMemoryEventTransport;
  beforeEach(async () => {
    store = createStore();
    transport = new InMemoryEventTransport();
    manager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: transport,
      cleanupOnComplete: false,
    });
    await manager.initialize();
  });
  afterEach(async () => {
    await manager.destroy();
  });

  test('classifies a newer recorded source before its next generation is claimed', async () => {
    const { identity, job } = await admitted(store);
    expect(await store.bindNativeResponse(identity)).toBe(true);
    await store.observeSourceOrder({
      source_order_scope: identity.sourceOrderScope!,
      source_sequence: 2,
    });
    expect(await store.getJob(job.streamId)).toMatchObject({ status: 'running' });
    expect(await store.commitNativeResponse(identity, 'a'.repeat(64))).toEqual({
      status: 'revoked',
    });
    expect(await manager.isGenerationSuperseded(job.streamId, job.createdAt)).toBe(true);
    expect(await manager.isGenerationSuperseded(job.streamId, job.createdAt + 1)).toBe(false);
    const terminals: unknown[] = [];
    await manager.subscribe(
      job.streamId,
      () => {},
      (event) => terminals.push(event),
    );
    expect(await manager.settleSupersededGeneration(job.streamId, job.createdAt)).toBe(true);
    await manager.completeJob(job.streamId);
    expect(await store.getJob(job.streamId)).toMatchObject({ status: 'superseded' });
    expect(terminals).toEqual([expect.objectContaining({ final: true, superseded: true })]);
  });

  test('classifies a revoked predecessor while the superseded status write is held', async () => {
    const { identity, job } = await admitted(store, 'old-stream', false);
    expect(await store.bindNativeResponse(identity)).toBe(true);
    const first = await manager.getJob(job.streamId);
    const terminals: unknown[] = [];
    await manager.subscribe(
      job.streamId,
      () => {},
      (event) => terminals.push(event),
    );
    const errors = jest.spyOn(transport, 'emitError');
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const update = store.updateJob.bind(store);
    jest.spyOn(store, 'updateJob').mockImplementation(async (id, patch, expected) => {
      if (id === job.streamId && patch.status === 'superseded') {
        reached();
        await gate;
      }
      return update(id, patch, expected);
    });
    const successor = manager.createJob('new-stream', 'owner', 'conversation', {
      interactionContext: { ...job.interactionContext!, source_event_id: 'new-source' },
    });
    let settlement: Promise<boolean> | undefined;
    try {
      await held;
      expect(await store.getJob(job.streamId)).toMatchObject({
        status: 'running',
        nativeResponseCancelled: true,
      });
      expect(first!.abortController.signal.aborted).toBe(false);
      expect(await store.commitNativeResponse(identity, 'a'.repeat(64))).toEqual({
        status: 'revoked',
      });
      expect(await manager.isGenerationSuperseded(job.streamId, job.createdAt)).toBe(true);
      settlement = manager.settleSupersededGeneration(job.streamId, job.createdAt);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      release();
      await successor;
    }
    expect(await settlement).toBe(true);
    await manager.completeJob(job.streamId);
    expect(await store.getJob(job.streamId)).toMatchObject({ status: 'superseded' });
    expect(first!.abortController.signal.reason).toBe('superseded');
    expect(terminals).toEqual([expect.objectContaining({ final: true, superseded: true })]);
  });

  test('does not call a Stop or lease revocation supersession without newer input', async () => {
    const { identity, job } = await admitted(store);
    expect(await store.bindNativeResponse(identity)).toBe(true);
    await store.revokeNativeResponse(identity);
    expect(await manager.isGenerationSuperseded(job.streamId, job.createdAt)).toBe(false);
    expect(await manager.settleSupersededGeneration(job.streamId, job.createdAt)).toBe(false);
    await store.updateJob(job.streamId, { status: 'aborted' });
    expect(await manager.isGenerationSuperseded(job.streamId, job.createdAt)).toBe(false);
    expect(await manager.isGenerationSuperseded('missing-stream', job.createdAt)).toBe(false);
  });

  test('a failed native revoke cannot mark or abort an obsolete generation', async () => {
    const { identity, job } = await admitted(store);
    expect(await store.bindNativeResponse(identity)).toBe(true);
    const first = await manager.getJob(job.streamId);
    const terminals: unknown[] = [];
    await manager.subscribe(
      job.streamId,
      () => {},
      (event) => terminals.push(event),
    );
    await store.observeSourceOrder({
      source_order_scope: identity.sourceOrderScope!,
      source_sequence: 2,
    });
    jest.spyOn(store, 'cancelNativeResponse').mockResolvedValueOnce({ status: 'unavailable' });
    expect(await manager.settleSupersededGeneration(job.streamId, job.createdAt)).toBe(false);
    expect(await store.getJob(job.streamId)).toMatchObject({ status: 'running' });
    expect(first!.abortController.signal.aborted).toBe(false);
    expect(terminals).toEqual([]);
  });

  test('uses the retained input presentation watermark instead of its older original sequence', async () => {
    const { identity, job } = await admitted(store);
    await store.observeSourceOrder({
      source_order_scope: identity.sourceOrderScope!,
      source_sequence: 2,
    });
    await store.updateJob(job.streamId, {
      interactionContext: {
        ...job.interactionContext!,
        ready_input_continuation: {
          source_message_id: 'source',
          presentation_source_sequence: 2,
        },
      },
    });
    expect(await store.bindNativeResponse({ ...identity, sourceSequence: 2 })).toBe(true);
    expect(await manager.isGenerationSuperseded(job.streamId, job.createdAt)).toBe(false);
    await store.observeSourceOrder({
      source_order_scope: identity.sourceOrderScope!,
      source_sequence: 3,
    });
    expect(await manager.isGenerationSuperseded(job.streamId, job.createdAt)).toBe(true);
  });

  test.each([
    ['partial_removed', false],
    ['failed', false],
    ['partial_removed', true],
    ['failed', true],
  ] as const)(
    'watermark-before-claim preserves or retires the original input after %s (ready replay: %s)',
    async (outcome, ready) => {
      const sourceOrderScope = 'c'.repeat(64);
      const context = (label: string, sequence: number) => ({
        actor_kind: 'external_user' as const,
        origin: 'interactive' as const,
        surface: 'telegram' as const,
        conversation_id: 'continuing-conversation',
        revision: 1,
        source_event_id: `source-${label}`,
        source_order_scope: sourceOrderScope,
        source_sequence: sequence,
        source_segments: [
          {
            ordinal: 0,
            source_event_id: `source-${label}`,
            source_index: 0,
            source_sequence: sequence,
            text: `${label} original goal`,
          },
        ],
      });
      const options = {
        adapterCapabilities: {
          segment_stability: 'immediate' as const,
          supersede_scope: 'response_only' as const,
        },
        deliveryPolicy: { commit_authority: 'external_adapter' as const },
      };
      await manager.observeSourceOrder({
        source_order_scope: sourceOrderScope,
        source_sequence: 1,
      });
      const first = await manager.createJob('continuous-a', 'owner', 'continuing-conversation', {
        ...options,
        interactionContext: context('A', 1),
      });
      await manager.updateMetadata('continuous-a', {
        responseMessageId: 'answer-a',
        userMessage: { messageId: 'input-a' },
      });
      const now = Date.now();
      const identity: NativeResponseIdentity = {
        userId: 'owner',
        conversationId: 'continuing-conversation',
        responseMessageId: 'answer-a',
        streamId: 'continuous-a',
        jobCreatedAt: first.createdAt,
        logicalTurnId: first.metadata.interactionContext!.logical_turn_id!,
        revision: 1,
        sourceOrderScope,
        sourceSequence: 1,
        invocationId: 'native-a',
        bodySha256: 'a'.repeat(64),
        providerId: 'provider',
        agentId: 'agent',
        originSha256: 'a'.repeat(64),
        source: { id: 'source-a-row', messageId: 'input-a', digest: 'a'.repeat(64) },
        admittedAt: now,
        recoverUntil: now + 86_400_000,
      };
      expect(await store.getJob('continuous-a')).toMatchObject({
        createdAt: identity.jobCreatedAt,
        userId: identity.userId,
        conversationId: identity.conversationId,
        responseMessageId: identity.responseMessageId,
        userMessage: { messageId: identity.source.messageId },
        interactionContext: {
          logical_turn_id: identity.logicalTurnId,
          revision: identity.revision,
          source_order_scope: identity.sourceOrderScope,
          source_sequence: identity.sourceSequence,
        },
      });
      expect(await manager.bindNativeResponse(identity)).toBe(true);
      await manager.retainNativeAcceptedSources(identity, [
        { id: 'input-a', sha256: 'a'.repeat(64) },
      ]);
      expect(
        await manager.markDurableEffectReceipt({
          streamId: 'continuous-a',
          userId: 'owner',
          sourceEventId: 'source-A',
          responseMessageId: 'answer-a',
          effectKind: 'durable_work_accepted',
          effectRef: 'independent-worker-a',
        }),
      ).toBe(true);
      await manager.observeSourceOrder({
        source_order_scope: sourceOrderScope,
        source_sequence: 2,
      });
      expect(await store.commitNativeResponse(identity, 'a'.repeat(64))).toEqual({
        status: 'revoked',
      });
      expect(await manager.settleSupersededGeneration('continuous-a', first.createdAt)).toBe(true);
      await manager.completeJob('continuous-a');
      expect(
        await manager.acknowledgeDelivery(
          {
            logical_turn_id: identity.logicalTurnId!,
            revision: 1,
            state: outcome,
            presentation_ref: 'telegram:1:old-preview',
          },
          'telegram',
        ),
      ).toMatchObject({ status: 'recorded' });

      const readyContext = {
        ...context('B', 2),
        ...(ready
          ? {
              ready_input_continuation: {
                source_message_id: 'input-b',
                presentation_source_sequence: 2,
              },
            }
          : {}),
      };
      const before = await store.getJob('continuous-a');
      const next = await manager.createJob('continuous-b', 'owner', 'continuing-conversation', {
        ...options,
        interactionContext: readyContext,
      });
      const nextTurn = next.metadata.interactionContext!;
      const continues = outcome === 'partial_removed';
      expect(nextTurn.logical_turn_id === identity.logicalTurnId).toBe(continues);
      expect(nextTurn.revision).toBe(continues ? 2 : 1);
      expect(nextTurn.source_segments?.map((source) => source.text)).toEqual(
        continues ? ['A original goal', 'B original goal'] : ['B original goal'],
      );
      expect(await store.getJob('continuous-b')).toMatchObject({ status: 'running' });
      expect((await store.getJob('continuous-a'))?.nativeAcceptedSources).toEqual(
        before?.nativeAcceptedSources,
      );
      expect((await store.getJob('continuous-a'))?.durableEffectReceipts).toEqual(
        before?.durableEffectReceipts,
      );
      expect(nextTurn.source_segments?.map((source) => source.authoring_revision)).toEqual(
        continues ? [1, 2] : [1],
      );
      expect(await store.claimLogicalTurn('duplicate-b', 'owner', readyContext)).toMatchObject({
        status: 'duplicate',
        streamId: 'continuous-b',
        interactionContext: nextTurn,
      });
      await manager.observeSourceOrder({
        source_order_scope: sourceOrderScope,
        source_sequence: 3,
      });
      expect(
        await store.claimLogicalTurn('waiting-c', 'owner', {
          ...context('C', 3),
          ready_input_continuation: {
            source_message_id: 'input-c',
            presentation_source_sequence: 3,
          },
        }),
      ).toMatchObject({ status: 'busy' });
      expect((await store.getJob('continuous-b'))?.interactionContext).toEqual(nextTurn);
    },
  );

  test.each([
    'missing publication',
    'live publication',
    'missing removal',
    'wrong owner',
    'wrong conversation',
    'committed effect',
  ] as const)('ready recovery stays busy with %s', async (condition) => {
    const { identity, job } = await admitted(store);
    if (condition !== 'missing publication') {
      await store.bindNativeResponse(identity);
      if (condition !== 'live publication') {
        await store.revokeNativeResponse(identity);
      }
    }
    if (condition !== 'missing removal') {
      await store.acknowledgeDelivery({
        logical_turn_id: identity.logicalTurnId,
        revision: identity.revision,
        state: condition === 'committed effect' ? 'committed_effect' : 'partial_removed',
        presentation_ref: 'telegram:1:old-preview',
      });
    }
    expect((await store.getJob(job.streamId))?.nativeResponse).toEqual(
      condition === 'missing publication' ? undefined : identity,
    );
    expect(await store.getNativeResponseCommit(identity)).toEqual({
      status: ['missing publication', 'live publication'].includes(condition)
        ? 'unavailable'
        : 'revoked',
    });
    const incoming = {
      ...job.interactionContext!,
      source_event_id: 'ready-source',
      source_sequence: 2,
      conversation_id:
        condition === 'wrong conversation' ? 'foreign-conversation' : job.conversationId!,
      ready_input_continuation: {
        source_message_id: 'ready-input',
        presentation_source_sequence: 2,
      },
    };
    expect(
      await store.claimLogicalTurn(
        'ready-stream',
        condition === 'wrong owner' ? 'foreign-owner' : 'owner',
        incoming,
      ),
    ).toMatchObject({ status: 'busy' });
    expect(await store.getJob(job.streamId)).toMatchObject({
      streamId: job.streamId,
      interactionContext: job.interactionContext,
    });
  });
}
