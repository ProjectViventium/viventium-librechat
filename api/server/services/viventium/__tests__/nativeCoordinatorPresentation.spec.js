const crypto = require('crypto');
const { buildCortexInsightDeliveryCandidates } = require('@librechat/api');
const {
  createNativeCoordinatorPresentationService,
  bindNativeResultAuthority,
} = require('../nativeCoordinatorPresentation');

function fixture() {
  const parent = { ownerId: 'owner', conversationId: 'core-chat', parentMessageId: 'source-main' };
  const binding = {
    _id: 'native-binding',
    kind: 'native_coordinator_binding',
    active: true,
    tenantId: 'tenant',
    ownerId: 'owner',
    conversationId: 'core-chat',
    nativeConversationId: 'native-chat',
  };
  const source = {
    kind: 'native_coordinator_source',
    bindingRef: binding._id,
    turnId: 'original-turn',
    requestBody: {
      conversationId: parent.conversationId,
      messageId: parent.parentMessageId,
      viventiumSurface: 'telegram',
    },
  };
  const goal = {
    goal_id: 'goal',
    source_turn_id: source.turnId,
    run_id: 'run',
    state: 'completed',
    result_revision: 1,
    intent_state: 'accepted',
    restore_hold: false,
  };
  const text = 'The verified useful result.';
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const result = {
    goal_id: goal.goal_id,
    run_id: goal.run_id,
    state: 'completed',
    result_revision: 1,
    sha256: hash,
    total_chars: text.length,
    publisher: {
      owner_id: 'owner',
      conversation_id: 'native-chat',
      agent_id: 'coordinator',
      run_id: 'run',
      request_id: 'request',
      message_id: 'native-message',
      stream_id: 'native-stream',
    },
  };
  const candidate = buildCortexInsightDeliveryCandidates({
    ...parent,
    surface: 'telegram',
    insights: [
      { cortexId: 'native-result:native-chat:goal:run:1', status: 'completed', insight: text },
    ],
  })[0];
  const row = {
    ...candidate,
    insight: text,
    status: 'dropped',
    dropReason: 'delivery_attempts_exhausted',
    persistenceStatus: 'persisted',
    persistedMessageId: 'saved-main',
    claimGeneration: 3,
    requiredSurfaces: ['web', 'telegram'],
    presentedSurfaces: [],
  };
  let message = {
    user: 'owner',
    conversationId: 'core-chat',
    parentMessageId: 'source-main',
    messageId: 'saved-main',
    text: 'Main already wrote this reply.',
    isCreatedByUser: false,
    metadata: {
      viventium: {
        messageRevision: 1,
        cortexInsightDeliveryIds: [row.deliveryId],
        cortexPresentationParentMessageId: 'source-main',
        cortexPresentationGeneration: 3,
        cortexPresentationClaimToken: 'old-claim',
      },
    },
  };
  const deliveries = new Map();
  const ledger = {
    resumeTransportFailure: jest.fn(async () => {
      row.status = 'pending';
      row.dropReason = '';
    }),
    claimPendingByParent: jest.fn(async () =>
      row.status === 'pending'
        ? { claimed: [{ deliveryId: row.deliveryId, claimToken: 'new-claim', claimGeneration: 4 }] }
        : { claimed: [] },
    ),
    liveClaimsByParent: jest.fn(async () => [
      { deliveryId: row.deliveryId, claimToken: 'new-claim', claimGeneration: 4 },
    ]),
    markPersisted: jest.fn(async ({ claims, persistedMessageId }) => {
      row.status = 'claimed';
      row.claimGeneration = claims[0].claimGeneration;
      row.persistenceStatus = 'persisted';
      row.persistedMessageId = persistedMessageId;
    }),
    fencePresentationByParent: jest.fn(async () => ({
      generation: 4,
      claimToken: 'new-claim',
      claims: [{ deliveryId: row.deliveryId, claimToken: 'new-claim', claimGeneration: 4 }],
      presentationLeaseToken: 'lease',
      deliveryReceipts: [{ deliveryId: row.deliveryId, graphResultHash: hash }],
    })),
    markPresentationByParent: jest.fn(async ({ surface }) => {
      row.presentedSurfaces.push(surface);
      if (row.requiredSurfaces.every((value) => row.presentedSurfaces.includes(value)))
        row.status = 'sent';
    }),
  };
  const deps = {
    tenantId: () => 'tenant',
    ledger,
    readRows: jest.fn(async () => [row]),
    readMessage: jest.fn(async () => message),
    readSources: jest.fn(async () => [{ binding, source }]),
    readSnapshot: jest.fn(async () => ({ goals: [goal] })),
    readResult: jest.fn(async () => result),
    readPublications: jest.fn(async () => []),
    bindMessage: jest.fn(async (bound, fence) => {
      message = {
        ...bound,
        metadata: {
          viventium: {
            ...bound.metadata.viventium,
            cortexPresentationGeneration: fence.claimGeneration,
            cortexPresentationClaimToken: fence.claimToken,
          },
        },
      };
      return message;
    }),
    enqueue: jest.fn(async ({ message: saved }) => {
      deliveries.set(saved.messageId, saved);
      return { configured: 1, enqueued: 1, unresolved: 0 };
    }),
    readDelivery: jest.fn(async (value) => value),
    findMessages: jest.fn(async () => []),
    publishUnpublished: jest.fn(async () => undefined),
  };
  return {
    parent,
    binding,
    source,
    goal,
    result,
    row,
    deps,
    ledger,
    deliveries,
    message: () => message,
    service: createNativeCoordinatorPresentationService(deps),
  };
}

test('recovers a transport-dropped saved reply through the same channel identity without cognition', async () => {
  const f = fixture();
  const text = f.message().text;
  await expect(f.service.recover(f.parent)).resolves.toBe(true);
  expect(f.ledger.resumeTransportFailure).toHaveBeenCalledWith({
    ...f.parent,
    deliveryIds: [f.row.deliveryId],
    persistedMessageId: 'saved-main',
    messageRevision: 1,
  });
  expect(f.message().text).toBe(text);
  expect(f.message().messageId).toBe('saved-main');
  expect(f.message().metadata.viventium.mainGenerationPresentation.version).toBe(2);
  await f.service.recover(f.parent);
  expect(f.deliveries.size).toBe(1);
  expect(f.ledger.resumeTransportFailure).toHaveBeenCalledTimes(1);
});

test.each(['owner', 'conversation', 'parent', 'publisher', 'hash', 'source', 'batch', 'revision'])(
  'rejects a foreign or changed %s proof without resuming or sending',
  async (changed) => {
    const f = fixture();
    if (changed === 'owner') f.binding.ownerId = 'foreign';
    if (changed === 'conversation') f.row.conversationId = 'foreign';
    if (changed === 'parent') f.source.requestBody.messageId = 'other';
    if (changed === 'publisher') f.result.publisher.owner_id = 'foreign';
    if (changed === 'hash') f.result.sha256 = 'a'.repeat(64);
    if (changed === 'source') f.goal.source_turn_id = 'other';
    if (changed === 'revision') f.goal.result_revision = 2;
    if (changed === 'batch')
      f.deps.readRows.mockResolvedValue([f.row, { ...f.row, deliveryId: 'other' }]);
    await expect(f.service.recover(f.parent)).resolves.toBe(false);
    expect(f.ledger.resumeTransportFailure).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  },
);

test.each(['stop', 'hold', 'semantic'])(
  'keeps Native ownership but never revives genuine %s suppression',
  async (kind) => {
    const f = fixture();
    if (kind === 'stop') f.goal.intent_state = 'cancelled';
    if (kind === 'hold') f.goal.restore_hold = true;
    if (kind === 'semantic') f.row.dropReason = 'semantic_suppression';
    await expect(f.service.recover(f.parent)).resolves.toBe(true);
    expect(f.ledger.resumeTransportFailure).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  },
);

test('leaves generic Web/Telegram recovery with its existing owner', async () => {
  const f = fixture();
  f.deps.readSources.mockResolvedValue([]);
  await expect(f.service.recover(f.parent)).resolves.toBe(false);
  expect(f.ledger.resumeTransportFailure).not.toHaveBeenCalled();
});

test('retains the original source parent while preserving a moved-on conversation tree parent', async () => {
  const f = fixture();
  f.message().parentMessageId = 'later-tree-leaf';
  await expect(f.service.recover(f.parent)).resolves.toBe(true);
  expect(f.message().parentMessageId).toBe('later-tree-leaf');
  expect(f.message().metadata.viventium.cortexPresentationParentMessageId).toBe('source-main');
  expect(f.deps.bindMessage.mock.calls[0][1].parentMessageId).toBe('source-main');
});

test('a saved typed Native authority fails closed if its source is no longer available', async () => {
  const f = fixture();
  f.deps.readMessage.mockResolvedValue(
    bindNativeResultAuthority(f.message(), f.binding, f.source, {
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 1,
      result_digest: `sha256:${f.result.sha256}`,
    }),
  );
  f.deps.readSources.mockResolvedValue([]);
  await expect(f.service.recover(f.parent)).rejects.toThrow(
    'coordinator_presentation_authority_unavailable',
  );
  expect(f.deps.enqueue).not.toHaveBeenCalled();
});

test('projects one genuine sent channel receipt into the existing author ledger once', async () => {
  const f = fixture();
  await f.service.recover(f.parent);
  const delivery = {
    deliveryId: 'surface-delivery',
    userId: 'owner',
    conversationId: 'core-chat',
    callbackMessageId: 'saved-main',
    originRef: f.binding._id,
    event: 'main.followup',
    surface: 'telegram',
    status: 'sent',
    sentAt: new Date(),
    telegramSentMessageIds: ['observed-telegram-message'],
    text: f.message().text,
    mainGenerationPresentation: f.message().metadata.viventium.mainGenerationPresentation,
  };
  await expect(f.service.settle(delivery)).resolves.toBe(true);
  expect(f.row.status).toBe('sent');
  expect(f.ledger.markPresentationByParent.mock.calls.map(([value]) => value.surface)).toEqual([
    'web',
    'telegram',
  ]);
  await f.service.settle(delivery);
  expect(f.ledger.markPresentationByParent).toHaveBeenCalledTimes(2);
  f.deps.readDelivery.mockResolvedValue(null);
  await expect(f.service.settle(delivery)).resolves.toBe(false);
});

test('does not treat pending or forged channel state as a send receipt', async () => {
  const f = fixture();
  await f.service.recover(f.parent);
  const value = {
    event: 'main.followup',
    callbackMessageId: 'saved-main',
    status: 'pending',
    mainGenerationPresentation: f.message().metadata.viventium.mainGenerationPresentation,
  };
  await expect(f.service.settle(value)).resolves.toBe(false);
  expect(f.ledger.markPresentationByParent).not.toHaveBeenCalled();
});

test('re-enters the same Native presenter for an accepted result whose Main reply is not saved yet', async () => {
  const f = fixture();
  f.row.status = 'claimed';
  f.row.persistenceStatus = 'pending';
  f.row.persistedMessageId = '';
  f.deps.readMessage.mockResolvedValue(null);
  await expect(f.service.recover(f.parent)).resolves.toBe(true);
  expect(f.deps.publishUnpublished).toHaveBeenCalledWith({
    binding: f.binding,
    data: {
      request_ref: f.binding._id,
      conversation_id: 'native-chat',
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 1,
      result_digest: `sha256:${f.result.sha256}`,
    },
  });
  expect(f.ledger.resumeTransportFailure).not.toHaveBeenCalled();
  expect(f.deps.enqueue).not.toHaveBeenCalled();
});

test.each(['stop', 'hold', 'foreign'])(
  'an unpublished Native result preserves %s fences',
  async (state) => {
    const f = fixture();
    f.row.status = 'pending';
    f.row.persistenceStatus = 'pending';
    f.row.persistedMessageId = '';
    f.deps.readMessage.mockResolvedValue(null);
    if (state === 'stop') f.goal.intent_state = 'cancelled';
    if (state === 'hold') f.goal.restore_hold = true;
    if (state === 'foreign') f.result.publisher.owner_id = 'foreign';
    await expect(f.service.recover(f.parent)).resolves.toBe(state !== 'foreign');
    expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  },
);

test('a missing previously persisted Main reply is never recreated', async () => {
  const f = fixture();
  f.deps.readMessage.mockResolvedValue(null);
  await expect(f.service.recover(f.parent)).resolves.toBe(true);
  expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
  expect(f.deps.enqueue).not.toHaveBeenCalled();
});

test('unpublished Native author failure stays with Native ownership instead of generic recovery', async () => {
  const f = fixture();
  f.row.status = 'pending';
  f.row.persistenceStatus = 'pending';
  f.row.persistedMessageId = '';
  f.deps.readMessage.mockResolvedValue(null);
  f.deps.publishUnpublished.mockRejectedValue(new Error('Native author temporarily unavailable'));
  await expect(f.service.recover(f.parent)).rejects.toThrow(
    'Native author temporarily unavailable',
  );
  expect(f.deps.enqueue).not.toHaveBeenCalled();
});

test('discovers and repairs a saved Main whose ledger persistence receipt was not committed', async () => {
  const f = fixture();
  f.row.status = 'pending';
  f.row.persistenceStatus = 'pending';
  f.row.persistedMessageId = '';
  f.deps.findMessages.mockResolvedValue([f.message()]);
  const original = f.message().text;
  await expect(f.service.recover(f.parent)).resolves.toBe(true);
  expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
  expect(f.ledger.markPersisted).toHaveBeenCalledWith(
    expect.objectContaining({
      persistedMessageId: 'saved-main',
      messageRevision: 1,
    }),
  );
  expect(f.message().text).toBe(original);
  expect(f.message().messageId).toBe('saved-main');
});

test('repairs the exact still-live publication claim after save without stealing a new claim', async () => {
  const f = fixture();
  f.row.status = 'claimed';
  f.row.persistenceStatus = 'pending';
  f.row.persistedMessageId = '';
  f.row.claimToken = f.message().metadata.viventium.cortexPresentationClaimToken;
  f.deps.findMessages.mockResolvedValue([f.message()]);
  await expect(f.service.recover(f.parent)).resolves.toBe(true);
  expect(f.ledger.markPersisted.mock.calls[0][0].claims[0]).toMatchObject({
    claimToken: 'old-claim',
    claimGeneration: 3,
  });
  expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
});

test.each(['deleted', 'error', 'unfinished', 'multiple', 'foreign'])(
  'saved-before-receipt discovery blocks %s records without republishing',
  async (kind) => {
    const f = fixture();
    f.row.status = 'pending';
    f.row.persistenceStatus = 'pending';
    f.row.persistedMessageId = '';
    if (kind === 'deleted') f.message().deletedAt = new Date();
    if (kind === 'error') f.message().error = true;
    if (kind === 'unfinished') f.message().unfinished = true;
    if (kind === 'foreign') f.message().user = 'foreign';
    f.deps.findMessages.mockResolvedValue(
      kind === 'multiple' ? [f.message(), { ...f.message(), messageId: 'copy' }] : [f.message()],
    );
    await expect(f.service.recover(f.parent)).resolves.toBe(true);
    expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  },
);

function unpublishedHistoricalFixture() {
  const f = fixture();
  f.row.status = 'pending';
  f.row.persistenceStatus = 'pending';
  f.row.persistedMessageId = '';
  f.deps.readMessage.mockResolvedValue(null);
  const publication = {
    event_id: 'existing-result-event',
    type: 'coordinator.result_ready',
    source_turn_id: f.source.turnId,
    expires_at: '2020-01-01T00:00:00Z',
    data: {
      request_ref: f.binding._id,
      conversation_id: f.binding.nativeConversationId,
      goal_id: f.goal.goal_id,
      run_id: f.goal.run_id,
      result_revision: 1,
      result_digest: `sha256:${f.result.sha256}`,
    },
  };
  f.goal.run_id = 'new-run';
  f.result = { ...f.result, run_id: 'new-run', result_revision: 2 };
  f.deps.readResult.mockResolvedValue(f.result);
  f.deps.readPublications.mockResolvedValue([publication]);
  return { ...f, publication };
}

test.each(['legacy', 'scoped'])(
  'retained %s publication identity keeps superseded unpublished evidence with Native ownership',
  async (scope) => {
    const f = unpublishedHistoricalFixture();
    if (scope === 'scoped') f.row.publicationId = 'native-result:native-chat:goal:run:1';
    await expect(f.service.recover(f.parent)).resolves.toBe(true);
    expect(await f.service.resolve(f.parent)).toMatchObject({
      retainedPublication: true,
      eligible: false,
    });
    expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
    expect(f.ledger.resumeTransportFailure).not.toHaveBeenCalled();
  },
);

test.each([
  'tenant',
  'owner',
  'conversation',
  'source',
  'binding',
  'event',
  'run',
  'revision',
  'hash',
  'publication',
  'mixed',
])(
  'historical provenance rejects changed %s instead of claiming generic evidence',
  async (changed) => {
    const f = unpublishedHistoricalFixture();
    if (changed === 'tenant') f.binding.tenantId = 'other';
    if (changed === 'owner') f.binding.ownerId = 'other';
    if (changed === 'conversation') f.publication.data.conversation_id = 'other';
    if (changed === 'source') f.publication.source_turn_id = 'other';
    if (changed === 'binding') f.publication.data.request_ref = 'other';
    if (changed === 'event') f.publication.type = 'coordinator.turn_due';
    if (changed === 'run') f.publication.data.run_id = 'other';
    if (changed === 'revision') f.publication.data.result_revision = 2;
    if (changed === 'hash') f.row.graphResultHash = 'b'.repeat(64);
    if (changed === 'publication') f.row.publicationId = 'other';
    if (changed === 'mixed')
      f.deps.readRows.mockResolvedValue([f.row, { ...f.row, deliveryId: 'other' }]);
    await expect(f.service.recover(f.parent)).resolves.toBe(false);
    expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  },
);

test('metadata availability failure does not release an unresolved candidate to generic authoring', async () => {
  const f = unpublishedHistoricalFixture();
  f.deps.readPublications.mockRejectedValue(new Error('Native metadata temporarily unavailable'));
  await expect(f.service.recover(f.parent)).rejects.toThrow(
    'Native metadata temporarily unavailable',
  );
  expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
});

function directTurnFixture() {
  const f = fixture();
  const data = {
    request_ref: f.binding._id,
    conversation_id: f.binding.nativeConversationId,
    turn_id: 'direct-turn',
    request_id: 'turn-request',
    run_id: 'turn-run',
    result_revision: 1,
    result_digest: `sha256:${f.result.sha256}`,
  };
  const candidate = buildCortexInsightDeliveryCandidates({
    ...f.parent,
    surface: 'telegram',
    insights: [
      {
        cortexId: 'native-turn-result:native-chat:direct-turn:turn-request:turn-run:1',
        status: 'completed',
        insight: f.row.insight,
      },
    ],
  })[0];
  Object.assign(f.row, candidate);
  f.message().metadata.viventium.cortexInsightDeliveryIds = [candidate.deliveryId];
  const result = {
    ...f.result,
    turn_id: data.turn_id,
    request_id: data.request_id,
    source_turn_id: f.source.turnId,
    run_id: data.run_id,
    intent_state: 'accepted',
    restore_hold: false,
    superseded: false,
    presentation_eligible: true,
    publisher: {
      ...f.result.publisher,
      request_id: data.request_id,
      message_id: data.turn_id,
      stream_id: data.turn_id,
      run_id: data.run_id,
    },
  };
  delete result.goal_id;
  f.deps.readSnapshot.mockResolvedValue({ goals: [] });
  f.deps.readTurnResult = jest.fn(async () => result);
  f.deps.readPublications.mockResolvedValue([
    {
      event_id: 'actual-turn-event',
      type: 'coordinator.turn_result_ready',
      source_turn_id: f.source.turnId,
      data,
    },
  ]);
  return { ...f, data, result };
}

test('a saved Native turn result uses the same Main recovery owner and no fake goal', async () => {
  const f = directTurnFixture();
  await expect(f.service.recover(f.parent)).resolves.toBe(true);
  expect(
    f.message().metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult,
  ).toMatchObject({
    kind: 'native_coordinator_turn',
    turnId: 'direct-turn',
    requestId: 'turn-request',
  });
  expect(
    f.message().metadata.viventium.mainGenerationPresentation.nativeCoordinatorResult,
  ).not.toHaveProperty('goalId');
  await f.service.recover(f.parent);
  expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
  expect(f.message().messageId).toBe('saved-main');
});

test('a claimed unpublished direct turn re-enters the existing Native presenter after restart', async () => {
  const f = directTurnFixture();
  f.row.status = 'pending';
  f.row.persistenceStatus = 'pending';
  f.row.persistedMessageId = '';
  await expect(f.service.recover(f.parent)).resolves.toBe(true);
  expect(f.deps.publishUnpublished).toHaveBeenCalledWith({ binding: f.binding, data: f.data });
  expect(f.deps.readResult).not.toHaveBeenCalled();
});

test.each(['stop', 'hold', 'superseded', 'ineligible', 'request', 'publisher', 'digest'])(
  'retains turn ownership without republishing changed %s evidence',
  async (changed) => {
    const f = directTurnFixture();
    f.row.status = 'pending';
    f.row.persistenceStatus = 'pending';
    f.row.persistedMessageId = '';
    if (changed === 'stop') f.result.intent_state = 'cancelled';
    if (changed === 'hold') f.result.restore_hold = true;
    if (changed === 'superseded') f.result.superseded = true;
    if (changed === 'ineligible') f.result.presentation_eligible = false;
    if (changed === 'request') f.result.request_id = 'another-request';
    if (changed === 'publisher') f.result.publisher.owner_id = 'foreign';
    if (changed === 'digest') f.result.sha256 = '0'.repeat(64);
    await expect(f.service.recover(f.parent)).resolves.toBe(true);
    expect(f.deps.publishUnpublished).not.toHaveBeenCalled();
    expect(f.deps.enqueue).not.toHaveBeenCalled();
  },
);
