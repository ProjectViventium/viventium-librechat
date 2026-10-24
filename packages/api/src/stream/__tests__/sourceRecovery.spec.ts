import type { NativeResponseIdentity } from '@librechat/data-schemas';
import type { InteractionContext, SerializableJobData } from '../interfaces/IJobStore';
import { GenerationJobManagerClass } from '../GenerationJobManager';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import {
  ownedInteractionSources,
  buildTrustedSourceSelectionCapsule,
} from '../../agents/sourceSelectionContext';
import {
  prepareNativeSourceRecovery,
  nativePredecessorSupersession,
  nativePredecessorSourceRecovery,
} from '../../glasshive/nativeSupersession';
import { normalizeAdapterCapabilities } from '../../agents/interactionContext';
import { resolveManagedMutationSource } from '../../glasshive/sourceMutation';

/* === VIVENTIUM START === Cancelled foreground ownership moves only after exact release and facts. === */
const capabilities = { segment_stability: 'immediate', supersede_scope: 'response_only' } as const;
const context = (source: string, text: string): InteractionContext => ({
  actor_kind: 'external_user',
  origin: 'interactive',
  surface: 'voice',
  conversation_id: 'chat',
  source_event_id: source,
  revision: 1,
  source_segments: [{ ordinal: 0, source_event_id: source, source_index: 0, text }],
});
const facts = { effects: [], work: [] };

async function managerLifecycleFixture(
  cancelledFinal: boolean,
  committedBeforeSecond = false,
  fromWeb = false,
  currentFromWeb = false,
) {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({ jobStore: store });
  const voice = { segment_stability: 'provisional', supersede_scope: 'response_only' } as const;
  await manager.initialize();
  await manager.createJob('lifecycle-first', 'owner', 'chat', {
    interactionContext: {
      ...context('L1', 'Create a synthetic CSV.'),
      surface: fromWeb ? 'web' : 'voice',
    },
    adapterCapabilities: fromWeb ? normalizeAdapterCapabilities() : voice,
    deliveryPolicy: { commit_authority: fromWeb ? 'server' : 'external_adapter' },
  });
  await manager.updateMetadata('lifecycle-first', {
    responseMessageId: 'lifecycle-old-response',
    userMessage: { messageId: 'lifecycle-source' },
  });
  await manager.commitLogicalTurnAuthor('lifecycle-first', 'owner');
  const previous = (await store.getJob('lifecycle-first'))!;
  const native: NativeResponseIdentity = {
    userId: previous.userId,
    conversationId: previous.conversationId!,
    streamId: previous.streamId,
    jobCreatedAt: previous.createdAt,
    invocationId: 'lifecycle-invocation',
    responseMessageId: previous.responseMessageId!,
    logicalTurnId: previous.interactionContext!.logical_turn_id!,
    revision: 1,
    providerId: 'provider',
    agentId: 'agent',
    originSha256: 'b'.repeat(64),
    bodySha256: 'c'.repeat(64),
    source: { id: 'input-row', messageId: 'lifecycle-source', digest: 'd'.repeat(64) },
    admittedAt: previous.createdAt,
    recoverUntil: previous.createdAt + 86400000,
  };
  expect(await manager.bindNativeResponse(native)).toBe(true);
  await manager.retainNativeAcceptedSources(native, [
    { id: 'lifecycle-source', sha256: 'a'.repeat(64) },
  ]);
  if (committedBeforeSecond) {
    expect(await manager.commitNativeResponse(native, 'e'.repeat(64))).toEqual({
      status: 'committed',
      candidateSha256: 'e'.repeat(64),
    });
  }
  await manager.createJob('lifecycle-second', 'owner', 'chat', {
    interactionContext: {
      ...context('L2', 'Tell me when it is ready.'),
      ...(currentFromWeb ? { surface: 'web' as const } : {}),
    },
    adapterCapabilities: currentFromWeb ? normalizeAdapterCapabilities() : voice,
    deliveryPolicy: { commit_authority: currentFromWeb ? 'server' : 'external_adapter' },
  });
  if (committedBeforeSecond) return { store, manager, voice, native };
  if (!fromWeb) await manager.completeJob(previous.streamId);
  if (cancelledFinal) {
    expect(
      await manager.finishNativeResponse(
        native,
        {
          final: true,
          aborted: true,
          responseMessage: { messageId: native.responseMessageId, text: '' },
        } as never,
        'cancelled',
      ),
    ).toBe(true);
  }
  const acknowledgement = {
    logical_turn_id: native.logicalTurnId,
    revision: native.revision,
    state: 'partial_removed' as const,
    presentation_ref: native.responseMessageId,
  };
  expect(
    await (fromWeb
      ? manager.acknowledgeStreamDelivery(previous.streamId, acknowledgement, native)
      : manager.acknowledgeDelivery(acknowledgement, 'voice')),
  ).toMatchObject({ status: 'recorded' });
  manager.setNativeSourceRecovery((current, stopped) =>
    prepareNativeSourceRecovery(current, stopped, {
      beforeCapture: async () => Date.now() + 1000,
      getJob: (id) => store.getJob(id),
      isUnboundCancelled: (job) => store.isNativeResponseUnboundCancelled(job),
      readFacts: async () => ({ facts, pending: false }),
      sleep: async () => {
        throw new Error('Unexpected pending proof');
      },
    }),
  );
  return { store, manager, voice, native };
}

test.each([false, true])(
  'real manager supersession retains both inputs after old request completion; cancelled final=%s',
  async (cancelledFinal) => {
    const f = await managerLifecycleFixture(cancelledFinal);
    try {
      expect(await f.store.isCurrentLogicalTurn('lifecycle-second')).toBe(true);
      const committed = await f.manager.commitLogicalTurnAuthor('lifecycle-second', 'owner');
      expect(
        ownedInteractionSources(committed, f.voice).map(({ segment }) => segment.text),
      ).toEqual(['Create a synthetic CSV.', 'Tell me when it is ready.']);
      expect(await f.store.getNativeResponseCommit(f.native)).toEqual({ status: 'revoked' });
    } finally {
      await f.manager.destroy();
    }
  },
);

test.each([false, true])(
  'a current Web Main recovers unanswered input after exact native cancellation; predecessor Web=%s',
  async (fromWeb) => {
    const f = await managerLifecycleFixture(false, false, fromWeb, true);
    try {
      const committed = await f.manager.commitLogicalTurnAuthor('lifecycle-second', 'owner');
      expect(
        committed?.source_segments?.map(({ source_event_id, authoring_revision }) => ({
          source_event_id,
          authoring_revision,
        })),
      ).toEqual([
        { source_event_id: 'L1', authoring_revision: 2 },
        { source_event_id: 'L2', authoring_revision: 2 },
      ]);
      expect(committed?.source_recovery_facts).toEqual(facts);
      expect(resolveManagedMutationSource(committed!, 'L1')).toBe('L1');
      expect(await f.store.getNativeResponseCommit(f.native)).toEqual({ status: 'revoked' });
    } finally {
      await f.manager.destroy();
    }
  },
);

test('a real same-turn successor preserves a committed answer author without source recovery', async () => {
  const f = await managerLifecycleFixture(false, true);
  const hook = jest.fn(async () => facts);
  f.manager.setNativeSourceRecovery(hook);
  try {
    const committed = await f.manager.commitLogicalTurnAuthor('lifecycle-second', 'owner');
    expect(ownedInteractionSources(committed, f.voice).map(({ segment }) => segment.text)).toEqual([
      'Tell me when it is ready.',
    ]);
    expect(hook).not.toHaveBeenCalled();
    expect(await f.store.getNativeResponseCommit(f.native)).toEqual({
      status: 'committed',
      candidateSha256: 'e'.repeat(64),
    });
    expect((await f.store.getJob(f.native.streamId))?.nativeResponseCancelled).not.toBe(true);
  } finally {
    await f.manager.destroy();
  }
});
async function fixture() {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({ jobStore: store });
  const first = await store.claimLogicalTurn(
    'first',
    'owner',
    context('S1', 'Create a synthetic CSV.'),
  );
  const previous = await store.createJob('first', 'owner', 'chat', {
    interactionContext: first.interactionContext,
    adapterCapabilities: capabilities,
    responseMessageId: 'old-response',
    userMessage: { messageId: 'source-message' },
  });
  await store.commitLogicalTurnAdmission!('first', 'owner', first.interactionContext);
  const accepted = [{ id: 'source-message', sha256: 'a'.repeat(64) }];
  const native: NativeResponseIdentity = {
    userId: 'owner',
    conversationId: 'chat',
    streamId: 'first',
    jobCreatedAt: previous.createdAt,
    invocationId: 'invocation',
    responseMessageId: 'old-response',
    logicalTurnId: first.interactionContext.logical_turn_id!,
    revision: 1,
    providerId: 'provider',
    agentId: 'agent',
    originSha256: 'b'.repeat(64),
    bodySha256: 'c'.repeat(64),
    source: { id: 'input-row', messageId: 'source-message', digest: 'd'.repeat(64) },
    admittedAt: previous.createdAt,
    recoverUntil: previous.createdAt + 86400000,
  };
  expect(await store.bindNativeResponse(native)).toBe(true);
  await store.cancelNativeResponse((await store.getJob('first'))!);
  await store.updateJob('first', {
    status: 'superseded',
    nativeAcceptedSources: { invocationId: 'invocation', sources: accepted },
    deliveryAcknowledgement: {
      logical_turn_id: native.logicalTurnId,
      revision: 1,
      state: 'partial_removed',
    },
  });
  const second = await store.claimLogicalTurn(
    'second',
    'owner',
    context('S2', 'Actually, make a PDF.'),
  );
  const current = await store.createJob('second', 'owner', 'chat', {
    interactionContext: second.interactionContext,
    adapterCapabilities: capabilities,
    nativePredecessor: {
      streamId: 'first',
      createdAt: previous.createdAt,
      responseMessageId: 'old-response',
      invocationId: 'invocation',
    },
    nativeReleaseTargets: ['old-response'],
  });
  return { store, manager, previous: (await store.getJob('first'))!, current };
}
test('a cancelled author returns both exact ordered inputs to the successor after the release hook', async () => {
  const f = await fixture();
  const hook = jest.fn(async () => facts);
  f.manager.setNativeSourceRecovery(hook);
  const committed = await f.manager.commitLogicalTurnAuthor('second', 'owner');
  expect(hook).toHaveBeenCalledWith(
    expect.objectContaining({ streamId: 'second' }),
    expect.objectContaining({ streamId: 'first' }),
  );
  expect(
    ownedInteractionSources(committed, capabilities).map(({ segment }) => segment.text),
  ).toEqual(['Create a synthetic CSV.', 'Actually, make a PDF.']);
  expect(committed?.source_recovery_facts).toEqual(facts);
  expect(buildTrustedSourceSelectionCapsule(committed, capabilities)).not.toContain(
    'only the current accepted input',
  );
  await f.manager.destroy();
});
test.each(['response_only', 'response_and_authoring'] as const)(
  'accepted work retains its durable owner while unanswered source moves on %s',
  async (supersede_scope) => {
    const f = await fixture();
    f.current.adapterCapabilities = { segment_stability: 'immediate', supersede_scope };
    const receipt = {
      effect_kind: 'durable_work_accepted',
      effect_ref: 'existing-work',
      source_event_id: 'S1',
      response_message_id: 'old-response',
      committed_at: 1,
    } as const;
    await f.store.updateJob('first', {
      durableEffectReceipt: receipt,
      durableEffectReceipts: [receipt],
    });
    const outcomes = {
      effects: [],
      work: [
        {
          sourceEventId: 'S1',
          originRef: 'origin',
          workRef: 'existing-work',
          launchState: 'accepted',
        },
      ],
    };
    f.manager.setNativeSourceRecovery(async () => outcomes);
    const committed = await f.manager.commitLogicalTurnAuthor('second', 'owner');
    expect(ownedInteractionSources(committed, capabilities)).toHaveLength(2);
    expect((await f.store.getJob('first'))?.durableEffectReceipts).toEqual([receipt]);
    expect(committed?.source_recovery_facts?.work[0].workRef).toBe('existing-work');
    await f.manager.destroy();
  },
);
test('three Web inputs keep exact originals and accepted work when the second reply is removed', async () => {
  const f = await managerLifecycleFixture(false, false, true, true);
  try {
    await f.manager.commitLogicalTurnAuthor('lifecycle-second', 'owner');
    await f.manager.updateMetadata('lifecycle-second', {
      responseMessageId: 'second-response',
      userMessage: { messageId: 'second-source' },
    });
    const second = (await f.store.getJob('lifecycle-second'))!;
    const native = {
      ...f.native,
      streamId: second.streamId,
      jobCreatedAt: second.createdAt,
      invocationId: 'second-invocation',
      responseMessageId: 'second-response',
      revision: 2,
      source: { ...f.native.source, messageId: 'second-source' },
    };
    expect(await f.manager.bindNativeResponse(native)).toBe(true);
    await f.manager.retainNativeAcceptedSources(native, [
      { id: 'lifecycle-source', sha256: 'a'.repeat(64) },
      { id: 'second-source', sha256: 'b'.repeat(64) },
    ]);
    const receipt = {
      effect_kind: 'durable_work_accepted',
      effect_ref: 'second-work',
      source_event_id: 'L2',
      response_message_id: 'second-response',
      committed_at: 1,
    } as const;
    await f.store.updateJob(second.streamId, {
      durableEffectReceipt: receipt,
      durableEffectReceipts: [receipt],
    });
    const outcomes = {
      effects: [],
      work: [
        {
          sourceEventId: 'L2',
          originRef: 'origin',
          workRef: 'second-work',
          launchState: 'accepted',
        },
      ],
    };
    await f.manager.createJob('lifecycle-third', 'owner', 'chat', {
      interactionContext: { ...context('L3', 'What is eight times seven?'), surface: 'web' },
      adapterCapabilities: normalizeAdapterCapabilities(),
      deliveryPolicy: { commit_authority: 'server' },
    });
    expect(
      await f.manager.acknowledgeStreamDelivery(
        second.streamId,
        {
          logical_turn_id: native.logicalTurnId,
          revision: 2,
          state: 'partial_removed',
          presentation_ref: native.responseMessageId,
        },
        native,
      ),
    ).toMatchObject({ status: 'recorded' });
    f.manager.setNativeSourceRecovery((current, previous) =>
      prepareNativeSourceRecovery(current, previous, {
        beforeCapture: async () => Date.now() + 1000,
        getJob: (id) => f.store.getJob(id),
        isUnboundCancelled: (job) => f.store.isNativeResponseUnboundCancelled(job),
        readFacts: async () => ({ facts: outcomes, pending: false }),
        sleep: async () => {
          throw new Error('Unexpected pending proof');
        },
      }),
    );
    const committed = await f.manager.commitLogicalTurnAuthor('lifecycle-third', 'owner');
    expect(
      committed?.source_segments?.map(({ source_event_id, text, authoring_revision }) => ({
        source_event_id,
        text,
        authoring_revision,
      })),
    ).toEqual([
      { source_event_id: 'L1', text: 'Create a synthetic CSV.', authoring_revision: 3 },
      { source_event_id: 'L2', text: 'Tell me when it is ready.', authoring_revision: 3 },
      { source_event_id: 'L3', text: 'What is eight times seven?', authoring_revision: 3 },
    ]);
    expect(resolveManagedMutationSource(committed!, 'L1')).toBe('L1');
    expect(committed?.source_recovery_facts).toEqual(outcomes);
    expect((await f.store.getJob(second.streamId))?.durableEffectReceipts).toEqual([receipt]);
    expect(await f.store.isCurrentLogicalTurn(second.streamId)).toBe(false);
    expect(await f.store.getNativeResponseCommit(native)).toEqual({ status: 'revoked' });
  } finally {
    await f.manager.destroy();
  }
});
test('an accepted effect for an earlier owned source blocks replay without acquiring current presentation authority', async () => {
  const f = await fixture();
  f.manager.setNativeSourceRecovery(async () => facts);
  await f.manager.commitLogicalTurnAuthor('second', 'owner');
  await f.store.updateJob('second', {
    responseMessageId: 'new-response',
    deliveryPolicy: { commit_authority: 'external_adapter' },
  });
  expect(
    await f.manager.markDurableEffectReceipt({
      streamId: 'second',
      userId: 'owner',
      sourceEventId: 'S1',
      responseMessageId: 'new-response',
      effectKind: 'durable_work_accepted',
      effectRef: 'work',
    }),
  ).toBe(true);
  const current = await f.store.getJob('second');
  expect(current?.durableEffectReceipts).toEqual([
    expect.objectContaining({ source_event_id: 'S1', effect_ref: 'work' }),
  ]);
  expect(current?.durableEffectReceipt).toBeUndefined();
  await f.manager.destroy();
});
test.each([
  { userId: 'foreign' },
  { createdAt: 0 },
  { nativeResponseCancelled: false },
  { deliveryAcknowledgement: undefined },
  { status: 'complete' },
])('a mismatched or unremoved predecessor cannot transfer a source: %j', async (patch) => {
  const f = await fixture();
  f.manager.setNativeSourceRecovery(async () => facts);
  Object.assign((await f.store.getJob('first'))!, patch as Partial<SerializableJobData>);
  await expect(f.manager.commitLogicalTurnAuthor('second', 'owner')).rejects.toMatchObject({
    code: 'native_source_recovery_unconfirmed',
  });
  expect(await f.store.getJob('second')).toBeNull();
  await f.manager.destroy();
});
test('a missing native reference and missing canonical predecessor ledger stay unresolved', async () => {
  const f = await fixture();
  f.manager.setNativeSourceRecovery(async () => facts);
  await f.store.updateJob('second', { nativePredecessor: undefined });
  jest.spyOn(f.store, 'getLogicalTurnSourcePredecessors').mockResolvedValue([]);
  await expect(f.manager.commitLogicalTurnAuthor('second', 'owner')).rejects.toMatchObject({
    code: 'native_source_recovery_predecessor_unavailable',
  });
  await f.manager.destroy();
});
test('capture waits for release, then pending facts, then takes a fresh settled snapshot', async () => {
  const f = await fixture();
  const order: string[] = [];
  const readFacts = jest
    .fn()
    .mockImplementationOnce(async () => {
      order.push('pending');
      return { facts, pending: true };
    })
    .mockImplementationOnce(async () => {
      order.push('settled');
      return { facts, pending: false };
    });
  expect(
    await prepareNativeSourceRecovery(f.current, f.previous, {
      beforeCapture: async () => {
        order.push('release');
      },
      getJob: (id) => f.store.getJob(id),
      readFacts,
      sleep: async () => {
        order.push('wait');
      },
    }),
  ).toEqual(facts);
  expect(order).toEqual(['release', 'pending', 'wait', 'release', 'settled']);
  expect(readFacts).toHaveBeenCalledWith({
    ownerId: 'owner',
    conversationId: 'chat',
    logicalTurnId: f.current.interactionContext?.logical_turn_id,
    sourceEventIds: ['S1', 'S2'],
  });
  await f.manager.destroy();
});
test('the exact adapter removal can arrive after native release without an early context capture', async () => {
  const f = await fixture();
  const ack = f.previous.deliveryAcknowledgement;
  delete f.previous.deliveryAcknowledgement;
  const readFacts = jest.fn(async () => ({ facts, pending: false }));
  let waits = 0;
  expect(
    await prepareNativeSourceRecovery(f.current, f.previous, {
      beforeCapture: async () => 2000,
      now: () => 1000,
      getJob: (id) => f.store.getJob(id),
      readFacts,
      sleep: async () => {
        waits += 1;
        f.previous.deliveryAcknowledgement = ack;
      },
    }),
  ).toEqual(facts);
  expect(waits).toBe(1);
  expect(readFacts).toHaveBeenCalledTimes(1);
  await f.manager.destroy();
});
test('missing removal confirmation reaches the existing provider deadline instead of claiming completion', async () => {
  const f = await fixture();
  delete f.previous.deliveryAcknowledgement;
  await expect(
    prepareNativeSourceRecovery(f.current, f.previous, {
      beforeCapture: async () => 1000,
      now: () => 1000,
      getJob: (id) => f.store.getJob(id),
      readFacts: jest.fn(),
      sleep: async () => {},
    }),
  ).rejects.toMatchObject({ code: 'provider_response_deadline_exceeded' });
  await f.manager.destroy();
});
test('release failure does not read facts or relinquish authorship', async () => {
  const f = await fixture();
  const readFacts = jest.fn();
  await expect(
    prepareNativeSourceRecovery(f.current, f.previous, {
      beforeCapture: async () => {
        throw new Error('lease remains occupied');
      },
      getJob: (id) => f.store.getJob(id),
      readFacts,
      sleep: async () => {},
    }),
  ).rejects.toThrow('lease remains occupied');
  expect(readFacts).not.toHaveBeenCalled();
  await f.manager.destroy();
});
/* === VIVENTIUM END === */

async function prebindFixture() {
  const store = new InMemoryJobStore();
  const manager = new GenerationJobManagerClass({ jobStore: store });
  const first = await store.claimLogicalTurn(
    'unbound-first',
    'owner',
    context('P1', 'Create a synthetic CSV.'),
  );
  const previous = await store.createJob('unbound-first', 'owner', 'chat', {
    interactionContext: first.interactionContext,
    adapterCapabilities: capabilities,
  });
  await store.commitLogicalTurnAdmission!('unbound-first', 'owner', first.interactionContext);
  expect(await store.cancelNativeResponse(previous)).toEqual({ status: 'revoked' });
  await store.updateJob(previous.streamId, { status: 'superseded' });
  const second = await store.claimLogicalTurn(
    'unbound-second',
    'owner',
    context('P2', 'Actually, make a PDF.'),
  );
  const current = await store.createJob('unbound-second', 'owner', 'chat', {
    interactionContext: second.interactionContext,
    adapterCapabilities: capabilities,
  });
  return { store, manager, previous: (await store.getJob(previous.streamId))!, current };
}

test('a positively cancelled pre-bind author gives the exact first source to the successor', async () => {
  const f = await prebindFixture();
  const outcomes = {
    effects: [],
    work: [
      {
        sourceEventId: 'P1',
        originRef: 'prior-origin',
        workRef: 'accepted-work',
        launchState: 'accepted',
      },
    ],
  };
  const hook = jest.fn(async () => outcomes);
  f.manager.setNativeSourceRecovery(hook);
  const committed = await f.manager.commitLogicalTurnAuthor(f.current.streamId, 'owner');
  expect(hook).toHaveBeenCalledWith(
    expect.objectContaining({ streamId: f.current.streamId }),
    expect.objectContaining({ streamId: f.previous.streamId, nativeResponseCancelled: true }),
  );
  expect(
    ownedInteractionSources(committed, capabilities).map(({ segment }) => segment.text),
  ).toEqual(['Create a synthetic CSV.', 'Actually, make a PDF.']);
  expect(committed?.source_recovery_facts).toEqual(outcomes);
  await f.manager.destroy();
});

test('a pre-bind tombstone rejects a late native admission after source supersession', async () => {
  const f = await prebindFixture();
  const native: NativeResponseIdentity = {
    userId: 'owner',
    conversationId: 'chat',
    streamId: f.previous.streamId,
    jobCreatedAt: f.previous.createdAt,
    invocationId: 'late-invocation',
    responseMessageId: f.previous.responseMessageId!,
    logicalTurnId: f.previous.interactionContext!.logical_turn_id!,
    revision: 1,
    providerId: 'provider',
    agentId: 'agent',
    originSha256: 'b'.repeat(64),
    bodySha256: 'c'.repeat(64),
    source: { id: 'late-input', messageId: 'late-source', digest: 'd'.repeat(64) },
    admittedAt: f.previous.createdAt,
    recoverUntil: f.previous.createdAt + 86400000,
  };
  expect(await f.store.bindNativeResponse(native)).toBe(false);
  expect((await f.store.getJob(f.previous.streamId))?.nativeResponse).toBeUndefined();
  await f.manager.destroy();
});

test('pre-bind recovery still waits for fresh Core reservation outcomes', async () => {
  const f = await prebindFixture();
  const events: string[] = [];
  const captured = {
    effects: [],
    work: [{ sourceEventId: 'P1', originRef: 'prior-origin', launchState: 'dispatch_unknown' }],
  };
  const readFacts = jest
    .fn()
    .mockResolvedValueOnce({ facts, pending: true })
    .mockResolvedValueOnce({ facts: captured, pending: false });
  await expect(
    prepareNativeSourceRecovery(f.current, f.previous, {
      isUnboundCancelled: (job) => f.store.isNativeResponseUnboundCancelled(job),
      beforeCapture: async () => {
        events.push('fence');
      },
      getJob: (id) => f.store.getJob(id),
      readFacts,
      sleep: async () => {
        events.push('wait');
      },
    }),
  ).resolves.toEqual(captured);
  expect(events).toEqual(['fence', 'wait', 'fence']);
  expect(readFacts).toHaveBeenCalledTimes(2);
  await f.manager.destroy();
});

test('a missing cancellation tombstone cannot grant pre-bind source recovery', async () => {
  const f = await prebindFixture();
  Object.assign((await f.store.getJob(f.previous.streamId))!, { nativeResponseCancelled: false });
  const readFacts = jest.fn();
  await expect(
    prepareNativeSourceRecovery(f.current, f.previous, {
      isUnboundCancelled: (job) => f.store.isNativeResponseUnboundCancelled(job),
      beforeCapture: async () => undefined,
      getJob: (id) => f.store.getJob(id),
      readFacts,
      sleep: async () => undefined,
    }),
  ).rejects.toMatchObject({ code: 'native_source_recovery_unconfirmed' });
  expect(readFacts).not.toHaveBeenCalled();
  await f.manager.destroy();
});

test('source predecessor projection reads exact ledger owners and rejects another user', async () => {
  const f = await prebindFixture();
  const predecessors = await f.store.getLogicalTurnSourcePredecessors(
    f.current.streamId,
    'owner',
    f.current.interactionContext!,
  );
  expect(predecessors.map((job) => [job.streamId, job.createdAt])).toEqual([
    [f.previous.streamId, f.previous.createdAt],
  ]);
  await expect(
    f.store.getLogicalTurnSourcePredecessors(
      f.current.streamId,
      'other-owner',
      f.current.interactionContext!,
    ),
  ).rejects.toThrow();
  await f.manager.destroy();
});

test('three accepted parts reuse exact cancelled Native A across positively unadmitted B', async () => {
  const f = await fixture();
  expect(await f.store.cancelNativeResponse(f.current)).toEqual({ status: 'revoked' });
  await f.store.updateJob(f.current.streamId, { status: 'superseded' });
  const third = await f.store.claimLogicalTurn('third', 'owner', context('S3', 'Use three rows.'));
  const current = await f.store.createJob('third', 'owner', 'chat', {
    interactionContext: third.interactionContext,
    adapterCapabilities: capabilities,
    nativeReleaseTargets: f.current.nativeReleaseTargets,
  });
  const hook = jest.fn(async () => facts);
  f.manager.setNativeSourceRecovery(hook);
  const committed = await f.manager.commitLogicalTurnAuthor('third', 'owner');
  expect(
    ownedInteractionSources(committed, capabilities).map(({ segment }) => segment.text),
  ).toEqual(['Create a synthetic CSV.', 'Actually, make a PDF.', 'Use three rows.']);
  const persisted = (await f.store.getJob(current.streamId))!;
  expect(persisted.nativePredecessor).toEqual({
    ...f.current.nativePredecessor,
    unadmittedRevisions: [2],
  });
  expect(
    nativePredecessorSupersession(persisted, f.previous, f.previous.nativeAcceptedSources!.sources),
  ).toMatchObject({ previous_revision: 1, revision: 3, unadmitted_revisions: [2] });
  expect(hook).toHaveBeenCalledWith(
    expect.objectContaining({ nativePredecessor: persisted.nativePredecessor }),
    expect.objectContaining({ streamId: 'first' }),
  );
  expect(await f.store.isNativeResponseUnboundCancelled(f.current)).toBe(true);
  await f.manager.destroy();
});

test('a skipped revision without positive never-admitted publication proof cannot bridge Native A', async () => {
  const f = await fixture();
  await f.store.cancelNativeResponse(f.current);
  await f.store.updateJob(f.current.streamId, { status: 'superseded' });
  jest.spyOn(f.store, 'isNativeResponseUnboundCancelled').mockResolvedValue(false);
  const third = await f.store.claimLogicalTurn('third', 'owner', context('S3', 'Use three rows.'));
  await f.store.createJob('third', 'owner', 'chat', {
    interactionContext: third.interactionContext,
    adapterCapabilities: capabilities,
    nativeReleaseTargets: f.current.nativeReleaseTargets,
  });
  f.manager.setNativeSourceRecovery(async () => facts);
  await expect(f.manager.commitLogicalTurnAuthor('third', 'owner')).rejects.toMatchObject({
    code: 'native_source_recovery_predecessor_unavailable',
  });
  await f.manager.destroy();
});

/* === VIVENTIUM START === Recovery follows the surviving adapter after exact predecessor removal. === */
test('a real unfinished Web predecessor returns both ordered inputs to its Voice successor', async () => {
  const f = await managerLifecycleFixture(false, false, true);
  try {
    const previous = (await f.store.getJob(f.native.streamId))!;
    expect(previous.adapterCapabilities?.supersede_scope).toBe('response_and_authoring');
    expect(previous).toMatchObject({
      status: 'superseded',
      nativeResponseCancelled: true,
      deliveryAcknowledgement: { state: 'partial_removed' },
    });
    expect(previous.nativeResponseFinished).not.toBe(true);
    expect(previous.nativeResponseSettled).not.toBe(true);
    expect(previous.generationCompleted).not.toBe(true);
    const committed = await f.manager.commitLogicalTurnAuthor('lifecycle-second', 'owner');
    expect(ownedInteractionSources(committed, f.voice).map(({ segment }) => segment.text)).toEqual([
      'Create a synthetic CSV.',
      'Tell me when it is ready.',
    ]);
    expect((await f.store.getJob('lifecycle-second'))?.nativePredecessor).toMatchObject({
      streamId: f.native.streamId,
      invocationId: f.native.invocationId,
      responseMessageId: f.native.responseMessageId,
      createdAt: f.native.jobCreatedAt,
    });
    expect(await f.store.getNativeResponseCommit(f.native)).toEqual({ status: 'revoked' });
    expect(committed?.source_recovery_facts).toEqual(facts);
  } finally {
    await f.manager.destroy();
  }
});

test('Web predecessor recovery waits for its actual removal ACK before fresh facts', async () => {
  const f = await fixture();
  f.previous.adapterCapabilities = normalizeAdapterCapabilities();
  f.previous.interactionContext!.surface = 'web';
  delete f.previous.deliveryAcknowledgement;
  const events: string[] = [];
  const readFacts = jest.fn(async () => {
    events.push('facts');
    return { facts, pending: false };
  });
  try {
    await expect(
      prepareNativeSourceRecovery(f.current, f.previous, {
        beforeCapture: async () => {
          events.push('released');
          return 2000;
        },
        now: () => 1000,
        getJob: (id) => f.store.getJob(id),
        readFacts,
        sleep: async () => {
          events.push('wait');
          expect(readFacts).not.toHaveBeenCalled();
          expect(
            await f.manager.acknowledgeStreamDelivery(
              f.previous.streamId,
              {
                state: 'partial_removed',
                presentation_ref: f.previous.nativeResponse!.responseMessageId,
              },
              f.previous.nativeResponse!,
            ),
          ).toMatchObject({ status: 'recorded' });
        },
      }),
    ).resolves.toEqual(facts);
    expect(events).toEqual(['released', 'wait', 'released', 'facts']);
    expect(readFacts).toHaveBeenCalledWith({
      ownerId: 'owner',
      conversationId: 'chat',
      logicalTurnId: f.current.interactionContext!.logical_turn_id,
      sourceEventIds: ['S1', 'S2'],
    });
  } finally {
    await f.manager.destroy();
  }
});

test('a missing Web removal ACK reaches the existing deadline without taking facts or authorship', async () => {
  const f = await fixture();
  f.previous.adapterCapabilities = normalizeAdapterCapabilities();
  delete f.previous.deliveryAcknowledgement;
  let now = 1000;
  const readFacts = jest.fn();
  const relinquish = jest.spyOn(f.store, 'relinquishLogicalTurnAuthor');
  try {
    await expect(
      prepareNativeSourceRecovery(f.current, f.previous, {
        beforeCapture: async () => 1300,
        now: () => now,
        getJob: (id) => f.store.getJob(id),
        readFacts,
        sleep: async () => {
          now += 300;
        },
      }),
    ).rejects.toMatchObject({ code: 'provider_response_deadline_exceeded' });
    expect(readFacts).not.toHaveBeenCalled();
    expect(relinquish).not.toHaveBeenCalled();
    expect(f.previous.nativeResponseCancelled).toBe(true);
    expect(f.previous.deliveryAcknowledgement).toBeUndefined();
  } finally {
    await f.manager.destroy();
  }
});

test('a positively fenced never-admitted Web predecessor keeps original input for Voice', async () => {
  const f = await prebindFixture();
  f.previous.adapterCapabilities = normalizeAdapterCapabilities();
  f.previous.interactionContext!.surface = 'web';
  try {
    f.manager.setNativeSourceRecovery((current, previous) =>
      prepareNativeSourceRecovery(current, previous, {
        beforeCapture: async () => Date.now() + 1000,
        getJob: (id) => f.store.getJob(id),
        isUnboundCancelled: (job) => f.store.isNativeResponseUnboundCancelled(job),
        readFacts: async () => ({ facts, pending: false }),
        sleep: async () => {
          throw new Error('Unexpected wait');
        },
      }),
    );
    expect(await f.store.isNativeResponseUnboundCancelled(f.previous)).toBe(true);
    const committed = await f.manager.commitLogicalTurnAuthor(f.current.streamId, 'owner');
    expect(
      ownedInteractionSources(committed, capabilities).map(({ segment }) => segment.text),
    ).toEqual(['Create a synthetic CSV.', 'Actually, make a PDF.']);
    expect(f.previous.nativeResponse).toBeUndefined();
    expect(f.previous.deliveryAcknowledgement).toBeUndefined();
  } finally {
    await f.manager.destroy();
  }
});

test.each([
  ['owner', { userId: 'foreign' }],
  ['conversation', { conversationId: 'foreign' }],
  ['response', { responseMessageId: 'other-response' }],
  [
    'ACK turn',
    {
      deliveryAcknowledgement: {
        logical_turn_id: 'other-turn',
        revision: 1,
        state: 'partial_removed',
      },
    },
  ],
  [
    'ACK revision',
    {
      deliveryAcknowledgement: { logical_turn_id: 'turn-1', revision: 9, state: 'partial_removed' },
    },
  ],
  [
    'ACK state',
    { deliveryAcknowledgement: { logical_turn_id: 'turn-1', revision: 1, state: 'failed' } },
  ],
  ['cancellation', { nativeResponseCancelled: false }],
  ['invocation', {}],
  ['successor status', {}],
] as const)('Web recovery rejects a conflicting %s without reading facts', async (_name, patch) => {
  const f = await fixture();
  f.previous.adapterCapabilities = normalizeAdapterCapabilities();
  Object.assign(f.previous, patch);
  if (_name === 'ACK revision' || _name === 'ACK state') {
    f.previous.deliveryAcknowledgement!.logical_turn_id = f.previous.nativeResponse!.logicalTurnId;
  }
  if (_name === 'invocation') f.current.nativePredecessor!.invocationId = 'other-invocation';
  if (_name === 'successor status') f.current.status = 'complete';
  const readFacts = jest.fn();
  try {
    await expect(
      prepareNativeSourceRecovery(f.current, f.previous, {
        beforeCapture: async () => 2000,
        now: () => 1000,
        getJob: (id) => f.store.getJob(id),
        readFacts,
        sleep: async () => {
          throw new Error('Conflicting proof must not wait');
        },
      }),
    ).rejects.toMatchObject({ code: 'native_source_recovery_unconfirmed' });
    expect(readFacts).not.toHaveBeenCalled();
  } finally {
    await f.manager.destroy();
  }
});

test.each([null, undefined])(
  'a missing predecessor cannot grant source recovery: %s',
  async (previous) => {
    const f = await fixture();
    try {
      expect(nativePredecessorSourceRecovery(f.current, previous)).toBe(false);
    } finally {
      await f.manager.destroy();
    }
  },
);

test('a deleted stopped job rejects capture without taking facts', async () => {
  const f = await fixture();
  f.previous.adapterCapabilities = normalizeAdapterCapabilities();
  const readFacts = jest.fn();
  try {
    await expect(
      prepareNativeSourceRecovery(f.current, f.previous, {
        beforeCapture: async () => 2000,
        now: () => 1000,
        getJob: (id) => (id === f.previous.streamId ? Promise.resolve(null) : f.store.getJob(id)),
        readFacts,
        sleep: async () => {
          throw new Error('Missing proof must not wait');
        },
      }),
    ).rejects.toMatchObject({ code: 'native_source_recovery_unconfirmed' });
    expect(readFacts).not.toHaveBeenCalled();
  } finally {
    await f.manager.destroy();
  }
});
/* === VIVENTIUM END === */
