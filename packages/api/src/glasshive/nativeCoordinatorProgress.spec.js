const crypto = require('crypto');
const { buildCortexInsightDeliveryCandidates } = require('../cortex/insightDeliveryService');
const { createNativeCoordinatorProgressService } = require('./nativeCoordinatorProgress');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

function fixture() {
  const binding = {
    _id: 'binding',
    kind: 'native_coordinator_binding',
    tenantId: 'tenant',
    ownerId: 'owner',
    conversationId: 'core-conversation',
    nativeConversationId: 'native-conversation',
    agentId: 'main',
    active: true,
  };
  const original = {
    _id: 'binding:source',
    kind: 'native_coordinator_source',
    bindingRef: 'binding',
    turnId: 'source',
    requestBody: {
      conversationId: 'core-conversation',
      messageId: 'ack',
      viventiumSurface: 'telegram',
    },
  };
  const data = {
    conversation_id: 'native-conversation',
    request_ref: 'binding',
    source_turn_id: 'source',
    goal_id: 'goal',
    run_id: 'run',
    attempt_id: 'attempt',
    progress_id: 'a'.repeat(64),
    progress_text: 'The first deliverable is saved. The remaining work is still running.',
  };
  data.progress_digest = `sha256:${sha(data.progress_text)}`;
  const state = {
    rows: [],
    message: null,
    mode: 'visible',
    subject: {
      goal_id: 'goal',
      source_turn_id: 'source',
      run_id: 'run',
      intent_state: 'accepted',
      restore_hold: false,
      state: 'running',
    },
    run: { run_id: 'run', tenant_id: 'tenant', state: 'running', active_attempt_id: 'attempt' },
    finalFiles: Array.from({ length: 12 }, (_, index) => `file-${index}`),
  };
  const publication = {
    event_id: 'event',
    type: 'coordinator.progress_ready',
    source_turn_id: 'source',
    data,
  };
  let service;
  const deps = {
    trace: jest.fn(),
    tenantId: () => 'tenant',
    readBinding: jest.fn(async () => binding),
    readSource: jest.fn(async () => original),
    readBindings: jest.fn(async () => [binding]),
    readSubject: jest.fn(async () => state.subject),
    readRun: jest.fn(async () => state.run),
    readPublications: jest.fn(async () => [publication]),
    readRows: jest.fn(async () => state.rows),
    readMessage: jest.fn(async () => state.message),
    claimPending: jest.fn(async () => ({
      claimed: state.rows.filter((row) => row.status === 'pending'),
    })),
    markDropped: jest.fn(async () => {
      for (const row of state.rows) row.status = 'dropped';
    }),
    prepare: jest.fn(async () => ({ presentationContext: { originalContext: 'inherited' } })),
    createFollowUp: jest.fn(async (input) => {
      const candidate = buildCortexInsightDeliveryCandidates({
        ownerId: binding.ownerId,
        conversationId: binding.conversationId,
        parentMessageId: 'ack',
        publicationId: 'event',
        surface: 'telegram',
        insights: input.insights,
      })[0];
      state.rows = [
        {
          ...candidate,
          insight: input.insights[0].insight,
          status: state.mode === 'silent' ? 'dropped' : 'pending',
          persistedMessageId: state.mode === 'visible' ? 'authored' : '',
        },
      ];
      if (state.mode === 'visible') {
        state.message = await service.bindForSave(
          {
            messageId: 'authored',
            user: 'owner',
            conversationId: 'core-conversation',
            isCreatedByUser: false,
            text: 'One file is ready. I am continuing with the rest.',
            metadata: {
              viventium: {
                cortexInsightDeliveryIds: [candidate.deliveryId],
                cortexPresentationParentMessageId: 'ack',
              },
            },
          },
          binding,
          original,
          data,
        );
      }
      if (state.finishDuringSynthesis) state.run.state = 'completed';
    }),
    enqueue: jest.fn(async () => ({ configured: 1, enqueued: 1, unresolved: 0 })),
    settleRows: jest.fn(async () => true),
  };
  service = createNativeCoordinatorProgressService(deps);
  return {
    service,
    deps,
    state,
    binding,
    original,
    data,
    publication,
    input: { binding, data, eventId: 'event' },
  };
}

test('progress inherits Main context, sends only Main-authored text, and a retry reuses the saved reply', async () => {
  const f = fixture();
  await expect(f.service.publish(f.input)).resolves.toEqual({ accepted: true });
  expect(f.deps.createFollowUp.mock.calls[0][0].context).toEqual({ originalContext: 'inherited' });
  expect(JSON.parse(f.deps.createFollowUp.mock.calls[0][0].insights[0].insight).report).toBe(
    f.data.progress_text,
  );
  expect(f.deps.enqueue.mock.calls[0][0].message.text).not.toBe(f.data.progress_text);
  expect(f.deps.trace).toHaveBeenCalledWith(
    expect.objectContaining({ stage: 'publish.enqueued', enqueued: 1 }),
  );
  expect(
    f.deps.trace.mock.calls.every(([record]) => /^sha256:[a-f0-9]{64}$/.test(record.sourceDigest)),
  ).toBe(true);
  await expect(
    f.service.verify({
      source: f.service.source(f.binding, f.original, f.data),
      ownerId: 'owner',
      conversationId: 'core-conversation',
      message: f.state.message,
    }),
  ).resolves.toBe(true);
  await f.service.publish(f.input);
  expect(f.deps.createFollowUp).toHaveBeenCalledTimes(1);
  expect(f.deps.enqueue.mock.calls[1][0].message.messageId).toBe('authored');
  f.state.rows[0].status = 'sent';
  await expect(f.service.publish(f.input)).resolves.toEqual({ duplicate: true });
  expect(f.deps.enqueue).toHaveBeenCalledTimes(2); // The existing transport owns idempotent enqueue.
});

test('silence and the current Main reply never create a competing progress voice', async () => {
  for (const mode of ['silent', 'current-main']) {
    const f = fixture();
    f.state.mode = mode;
    await expect(f.service.publish(f.input)).resolves.toEqual({ pending: true });
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.deps.createFollowUp).toHaveBeenCalledTimes(1);
    if (mode === 'silent') {
      await expect(f.service.publish(f.input)).resolves.toEqual({ duplicate: true });
      expect(f.deps.createFollowUp).toHaveBeenCalledTimes(1);
    }
  }
});

test('terminal, replacement attempt, and terminal during synthesis suppress progress without changing final files', async () => {
  for (const change of ['terminal', 'replacement', 'during']) {
    const f = fixture();
    if (change === 'terminal') f.state.run.state = 'completed';
    if (change === 'replacement') f.state.run.active_attempt_id = 'new-attempt';
    if (change === 'during') f.state.finishDuringSynthesis = true;
    await expect(f.service.publish(f.input)).resolves.toEqual({ suppressed: true });
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.deps.trace).toHaveBeenCalledWith(expect.objectContaining({ stage: 'current.reject' }));
    if (change !== 'during') expect(f.deps.createFollowUp).not.toHaveBeenCalled();
    expect(f.state.finalFiles).toHaveLength(12);
    expect(f.state.subject.intent_state).toBe('accepted');
  }
});

test('owner, publication, digest and immutable ledger evidence are required for dispatch', async () => {
  const f = fixture();
  await f.service.publish(f.input);
  const value = f.service.source(f.binding, f.original, f.data);
  const input = {
    source: value,
    ownerId: 'owner',
    conversationId: 'core-conversation',
    message: f.state.message,
  };
  await expect(f.service.verify({ ...input, ownerId: 'foreign-owner' })).resolves.toBe(false);
  f.publication.source_turn_id = 'foreign-source';
  await expect(f.service.verify(input)).resolves.toBe(false);
  f.publication.source_turn_id = 'source';
  f.state.rows[0].graphResultHash = 'b'.repeat(64);
  await expect(f.service.verify(input)).resolves.toBe(false);
  f.state.rows[0].graphResultHash = f.state.rows[0].insightHash;
  f.state.message.metadata.viventium.mainGenerationPresentation.responseDigest = `sha256:${'c'.repeat(64)}`;
  await expect(f.service.verify(input)).resolves.toBe(false);
  f.data.progress_digest = `sha256:${'b'.repeat(64)}`;
  await expect(f.service.publish(f.input)).rejects.toThrow('coordinator_progress_digest_invalid');
});

test('recovery uses retained Native publication identity and quietly drops late evidence', async () => {
  const f = fixture();
  await expect(
    f.service.recover({
      ownerId: 'owner',
      conversationId: 'core-conversation',
      parentMessageId: 'ack',
      publicationId: 'event',
    }),
  ).resolves.toBe(true);
  expect(f.deps.createFollowUp).toHaveBeenCalledTimes(1);
  f.state.run.state = 'completed';
  await expect(
    f.service.recover({
      ownerId: 'owner',
      conversationId: 'core-conversation',
      parentMessageId: 'ack',
      publicationId: 'event',
    }),
  ).resolves.toBe(true);
  expect(f.deps.markDropped).toHaveBeenCalledTimes(1);
  expect(f.deps.createFollowUp).toHaveBeenCalledTimes(1);
  await expect(
    f.service.recover({
      ownerId: 'owner',
      conversationId: 'core-conversation',
      parentMessageId: 'ack',
      publicationId: 'another-event',
    }),
  ).resolves.toBe(false);
});
