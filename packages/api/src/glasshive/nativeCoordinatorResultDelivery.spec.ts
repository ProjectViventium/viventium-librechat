import { createHash } from 'crypto';
import { createNativeCoordinatorResultDeliveryProjection } from './nativeCoordinatorResultDelivery';
import { buildMainGenerationPresentation } from './mainGenerationPresentation';
import { buildCortexInsightDeliveryCandidates } from '../cortex/insightDeliveryService';
import { nativeCoordinatorWorkRef, nativeCoordinatorTurnRef } from './nativeCoordinatorWork';
function fixture(surface = 'web') {
  const insight = 'Genuine current result.';
  const source = {
    kind: 'native_coordinator_goal' as const,
    bindingRef: 'binding',
    nativeConversationId: 'native',
    goalId: 'goal',
    runId: 'run',
    resultRevision: 1,
    resultDigest: 'sha256:' + createHash('sha256').update(insight).digest('hex'),
    sourceTurnId: 'source',
    sourceCallSessionId: '',
  };
  const [candidate] = buildCortexInsightDeliveryCandidates({
    ownerId: 'owner',
    conversationId: 'core',
    parentMessageId: 'original',
    surface,
    insights: [{ cortexId: 'native-result:native:goal:run:1', status: 'completed', insight }],
  });
  const row = {
    ...candidate,
    insight,
    persistenceStatus: 'persisted',
    persistedMessageId: 'message',
    status: 'sent',
    claimGeneration: 1,
    requiredSurfaces: candidate.requiredSurfaces,
    presentedSurfaces: candidate.requiredSurfaces,
    presentationReceiptHashes: ['receipt'],
    events: [{ transition: 'persisted', claimToken: 'claim', claimGeneration: 1 }],
  };
  const message = {
    messageId: 'message',
    user: 'owner',
    conversationId: 'core',
    isCreatedByUser: false,
    parentMessageId: 'later-leaf',
    text: 'Main result.',
    metadata: {
      viventium: {
        mainGenerationPresentation: buildMainGenerationPresentation(
          { nativeCoordinatorResult: source },
          'message',
          'Main result.',
        ),
        cortexInsightDeliveryIds: [candidate.deliveryId],
        cortexPresentationParentMessageId: 'original',
        cortexPresentationGeneration: 1,
        cortexPresentationClaimToken: 'claim',
      },
    },
  };
  const binding = {
    _id: 'binding',
    kind: 'native_coordinator_binding',
    ownerId: 'owner',
    tenantId: 'tenant',
    active: true,
    conversationId: 'core',
    nativeConversationId: 'native',
  };
  const goal = {
    goal_id: 'goal',
    source_turn_id: 'source',
    text: 'Task.',
    state: 'completed',
    intent_state: 'accepted',
    restore_hold: false,
    run_id: 'run',
    result_revision: 1,
  };
  const work = {
    workRef: nativeCoordinatorWorkRef('native', 'goal'),
    managementKind: 'native_coordinator',
    state: 'completed',
    actions: [],
    delivery: { state: 'unknown', unreadTerminal: false },
  };
  const deps = {
    readMessages: jest.fn(async () => [message]),
    readSources: jest.fn(async () => [
      {
        kind: 'native_coordinator_source',
        bindingRef: 'binding',
        turnId: 'source',
        requestBody: { messageId: 'original', viventiumSurface: surface },
      },
    ]),
    readRows: jest.fn(async () => [row]),
    readDestinations: jest.fn(async () => [
      { surface: 'librechat' },
      { surface: 'telegram', telegramChatId: 'chat', telegramUserId: 'telegram' },
    ]),
    readResult: jest.fn(async () => ({
      goal_id: 'goal',
      run_id: 'run',
      state: 'completed',
      result_revision: 1,
      total_chars: insight.length,
      sha256: source.resultDigest.slice(7),
      publisher: {
        owner_id: 'owner',
        conversation_id: 'native',
        agent_id: 'coordinator',
        run_id: 'run',
        request_id: 'request',
        message_id: 'native-message',
        stream_id: 'native-stream',
      },
    })),
  };
  const input = {
    ownerId: 'owner',
    tenantId: 'tenant',
    snapshots: [{ binding, snapshot: { conversation_id: 'native', goals: [goal] } }],
    roster: {
      snapshot: 'fresh',
      cursor: 'retained',
      work: [work, { workRef: 'ordinary', delivery: { state: 'failed' } }],
    },
  };
  return {
    input,
    row,
    message,
    binding,
    goal,
    deps,
    project: createNativeCoordinatorResultDeliveryProjection(deps),
  };
}
test.each(['web', 'telegram'])(
  'projects current %s receipt, preserving other work and pagination',
  async (surface) => {
    const f = fixture(surface);
    const before = structuredClone(f.input);
    const result = await f.project(f.input);
    expect(result.work[0]).toMatchObject({
      delivery: { state: 'delivered', unreadTerminal: false },
      deliveryScope: {
        originConversationId: 'core',
        resultRunId: 'run',
        resultRevision: 1,
        destinations: surface === 'web' ? ['librechat'] : ['librechat', 'telegram'],
      },
    });
    expect(result.work[1]).toEqual(f.input.roster.work[1]);
    expect(result.cursor).toBe('retained');
    expect(f.input).toEqual(before);
    expect(f.deps.readResult).toHaveBeenCalledTimes(1);
  },
);
test.each([
  'owner',
  'revision',
  'run',
  'held',
  'stopped',
  'mission',
  'missing-digest',
  'foreign-message',
  'suppressed',
  'missing-row',
  'missing-required',
])('keeps %s unknown without result RPC', async (scenario) => {
  const f = fixture();
  if (scenario === 'owner') f.binding.ownerId = 'foreign';
  if (scenario === 'revision') f.goal.result_revision = 2;
  if (scenario === 'run') f.goal.run_id = 'new-run';
  if (scenario === 'held') f.goal.restore_hold = true;
  if (scenario === 'stopped') f.goal.intent_state = 'cancelled';
  if (scenario === 'mission') Object.assign(f.goal, { work_ref: 'legacy-worker' });
  if (scenario === 'missing-digest')
    delete f.message.metadata.viventium.mainGenerationPresentation?.nativeCoordinatorResult
      ?.resultDigest;
  if (scenario === 'foreign-message') f.message.user = 'foreign';
  if (scenario === 'suppressed') f.row.status = 'dropped';
  if (scenario === 'missing-row') f.deps.readRows.mockResolvedValue([]);
  if (scenario === 'missing-required') f.row.requiredSurfaces = [];
  expect((await f.project(f.input)).work[0].delivery.state).toBe('unknown');
  expect(f.deps.readResult).not.toHaveBeenCalled();
});
test('changed Native digest fails existing proof', async () => {
  const f = fixture();
  f.deps.readResult.mockResolvedValue({ ...(await f.deps.readResult()), sha256: '0'.repeat(64) });
  f.deps.readResult.mockClear();
  expect((await f.project(f.input)).work[0].delivery.state).toBe('unknown');
  expect(f.deps.readResult).toHaveBeenCalledTimes(1);
});
test('pending presentation remains pending', async () => {
  const f = fixture();
  f.row.status = 'claimed';
  f.row.presentedSurfaces = [];
  f.row.presentationReceiptHashes = [];
  expect((await f.project(f.input)).work[0].delivery).toEqual({
    state: 'pending',
    unreadTerminal: true,
  });
});
test('missing sent receipt and unavailable Native proof never erase other work', async () => {
  const f = fixture();
  f.row.presentationReceiptHashes = [];
  expect((await f.project(f.input)).work[0].delivery.state).toBe('unknown');
  f.row.presentationReceiptHashes = ['receipt'];
  f.deps.readResult.mockRejectedValue(new Error('unavailable'));
  const result = await f.project(f.input);
  expect(result.work[0].delivery.state).toBe('unknown');
  expect(result.work[1]).toEqual(f.input.roster.work[1]);
});

function turnProjectionFixture() {
  const f = fixture();
  const turn = {
    turn_id: 'direct-turn',
    source_turn_id: 'source',
    request_id: 'request',
    run_id: 'run',
    origin: 'interactive',
    state: 'completed',
    intent_state: 'accepted',
    restore_hold: false,
    superseded: false,
    has_result: true,
    presentation_eligible: true,
    result_revision: 1,
  };
  const source = {
    kind: 'native_coordinator_turn' as const,
    bindingRef: 'binding',
    nativeConversationId: 'native',
    turnId: 'direct-turn',
    requestId: 'request',
    runId: 'run',
    resultRevision: 1,
    resultDigest: 'sha256:' + createHash('sha256').update(f.row.insight).digest('hex'),
    sourceTurnId: 'source',
    sourceCallSessionId: '',
  };
  const [candidate] = buildCortexInsightDeliveryCandidates({
    ownerId: 'owner',
    conversationId: 'core',
    parentMessageId: 'original',
    surface: 'web',
    insights: [
      {
        cortexId: 'native-turn-result:native:direct-turn:request:run:1',
        status: 'completed',
        insight: f.row.insight,
      },
    ],
  });
  Object.assign(f.row, candidate);
  f.message.metadata.viventium.cortexInsightDeliveryIds = [candidate.deliveryId];
  f.message.metadata.viventium.mainGenerationPresentation = buildMainGenerationPresentation(
    { nativeCoordinatorResult: source },
    f.message.messageId,
    f.message.text,
  );
  const result = {
    ...turn,
    publisher: {
      owner_id: 'owner',
      conversation_id: 'native',
      agent_id: 'coordinator',
      request_id: 'request',
      message_id: 'direct-turn',
      stream_id: 'direct-turn',
      run_id: 'run',
    },
    sha256: source.resultDigest.slice(7),
    total_chars: f.row.insight.length,
  };
  const deps = { ...f.deps, readTurnResult: jest.fn(async () => result) };
  const input = {
    ...f.input,
    snapshots: [
      { binding: f.binding, snapshot: { conversation_id: 'native', goals: [], turns: [turn] } },
    ],
    roster: {
      ...f.input.roster,
      work: [
        {
          workRef: nativeCoordinatorTurnRef('native', 'direct-turn'),
          managementKind: 'native_coordinator_turn',
          state: 'completed',
          actions: [],
          delivery: { state: 'unknown', unreadTerminal: true },
        },
      ],
    },
  };
  return {
    ...f,
    input,
    result,
    deps,
    project: createNativeCoordinatorResultDeliveryProjection(deps),
  };
}

test('projects actual completed Native-turn delivery on its existing xpt work card', async () => {
  const f = turnProjectionFixture();
  expect((await f.project(f.input)).work[0]).toMatchObject({
    managementKind: 'native_coordinator_turn',
    delivery: { state: 'delivered', unreadTerminal: false },
  });
  expect(f.deps.readResult).not.toHaveBeenCalled();
});
test.each(['hold', 'superseded', 'request', 'owner'])(
  'keeps changed turn %s receipt unconfirmed',
  async (changed) => {
    const f = turnProjectionFixture();
    if (changed === 'hold') f.result.restore_hold = true;
    if (changed === 'superseded') f.result.superseded = true;
    if (changed === 'request') f.result.request_id = 'foreign';
    if (changed === 'owner') f.result.publisher.owner_id = 'foreign';
    expect((await f.project(f.input)).work[0].delivery.state).toBe('unknown');
  },
);

test('verified delivered Native-turn output clears stale transport attention, leaving the audit owner untouched', async () => {
  const f = turnProjectionFixture();
  Object.assign(f.input.roster.work[0], {
    state: 'blocked',
    attention: { kind: 'failure', code: 'retained-transport-failure' },
  });
  const result = await f.project(f.input);
  expect(result.work[0]).toMatchObject({
    state: 'completed',
    delivery: { state: 'delivered', unreadTerminal: false },
  });
  expect(result.work[0]).not.toHaveProperty('attention');
  expect(f.input.roster.work[0]).toHaveProperty('attention');
});

test.each(['hold', 'stop', 'superseded', 'native_failure', 'missing_receipt', 'owner', 'revision'])(
  'does not clear Native-turn attention without current %s proof',
  async (changed) => {
    const f = turnProjectionFixture();
    Object.assign(f.input.roster.work[0], {
      state: 'blocked',
      attention: { kind: 'failure', code: 'retained-transport-failure' },
    });
    if (changed === 'hold') f.result.restore_hold = true;
    if (changed === 'stop') f.result.intent_state = 'cancelled';
    if (changed === 'superseded') f.result.superseded = true;
    if (changed === 'native_failure') f.result.state = 'failed';
    if (changed === 'missing_receipt') f.row.presentationReceiptHashes = [];
    if (changed === 'owner') f.result.publisher.owner_id = 'foreign';
    if (changed === 'revision') f.result.result_revision = 2;
    const result = await f.project(f.input);
    expect(result.work[0]).toMatchObject({
      state: 'blocked',
      attention: { code: 'retained-transport-failure' },
    });
  },
);

test('a delivered failure result never converts a genuine failed goal into completed work', async () => {
  const f = fixture();
  f.goal.state = 'failed';
  f.input.roster.work[0].state = 'failed';
  f.deps.readResult.mockResolvedValue({ ...(await f.deps.readResult()), state: 'failed' });
  expect((await f.project(f.input)).work[0]).toMatchObject({
    state: 'failed',
    delivery: { state: 'delivered' },
  });
});
