import { createHash } from 'crypto';
import { createNativeCoordinatorResultSourceVerifier } from './nativeCoordinatorVoicePresentation';
import { buildCortexInsightDeliveryCandidates } from '../cortex/insightDeliveryService';
import { nativeCoordinatorResultEvidence } from './nativeCoordinatorContext';
import type { MainGenerationDelivery } from './mainGenerationPresentation';

function fixture(originalSurface = 'voice') {
  const insight = 'Completed original Native goal result.';
  const resultDigest = 'sha256:' + createHash('sha256').update(insight).digest('hex');
  const source = {
    kind: 'native_coordinator_goal' as const,
    bindingRef: 'binding-one',
    nativeConversationId: 'native-one',
    goalId: 'goal-one',
    runId: 'run-one',
    resultRevision: 1,
    resultDigest,
    sourceTurnId: 'source-turn',
    sourceCallSessionId: originalSurface === 'voice' ? 'call-one' : '',
  };
  const [candidate] = buildCortexInsightDeliveryCandidates({
    ownerId: 'owner-one',
    conversationId: 'core-one',
    parentMessageId: 'original-main',
    surface: originalSurface === 'voice' ? 'web' : originalSurface,
    insights: [
      {
        cortexId: 'native-result:native-one:goal-one:run-one:1',
        status: 'completed',
        insight,
      },
    ],
  });
  const binding: Record<string, unknown> = {
    _id: source.bindingRef,
    kind: 'native_coordinator_binding',
    active: true,
    ownerId: 'owner-one',
    tenantId: 'tenant-one',
    conversationId: 'core-one',
    nativeConversationId: 'native-one',
  };
  const accepted: Record<string, unknown> = {
    kind: 'native_coordinator_source',
    bindingRef: source.bindingRef,
    turnId: 'source-turn',
    requestBody: {
      messageId: 'original-main',
      viventiumSurface: originalSurface,
      ...(originalSurface === 'voice' ? { viventiumCallSessionId: 'call-one' } : {}),
    },
  };
  const goal: Record<string, unknown> = {
    goal_id: 'goal-one',
    source_turn_id: 'source-turn',
    run_id: 'run-one',
    state: 'completed',
    result_revision: 1,
    intent_state: 'accepted',
    restore_hold: false,
  };
  const result: Record<string, unknown> = {
    goal_id: 'goal-one',
    run_id: 'run-one',
    result_revision: 1,
    state: 'completed',
    total_chars: insight.length,
    sha256: resultDigest.slice(7),
    publisher: {
      owner_id: 'owner-one',
      conversation_id: 'native-one',
      agent_id: 'coordinator',
      run_id: 'run-one',
      request_id: 'actual-native-request',
      message_id: 'actual-native-message',
      stream_id: 'actual-native-stream',
    },
  };
  const row: Record<string, unknown> = {
    ...candidate,
    insight,
    status: 'sent',
    claimToken: '',
    claimGeneration: 2,
    persistedMessageId: 'current-main-result',
    persistenceStatus: 'persisted',
    events: [{ transition: 'persisted', claimGeneration: 2, claimToken: 'real-cortex-claim' }],
  };
  const message = {
    messageId: 'current-main-result',
    user: 'owner-one',
    conversationId: 'core-one',
    isCreatedByUser: false,
    text: 'Current Main-authored answer.',
    metadata: {
      viventium: {
        cortexInsightDeliveryIds: [row.deliveryId],
        cortexPresentationParentMessageId: 'original-main',
        cortexPresentationGeneration: 2,
        cortexPresentationClaimToken: 'real-cortex-claim',
      },
    },
  };
  const deps = {
    tenantId: () => 'tenant-one',
    readBinding: jest.fn(async () => binding),
    readSource: jest.fn(async () => accepted),
    readGoal: jest.fn(async () => goal),
    readResult: jest.fn(async () => result),
    readCortexRows: jest.fn(async () => [row]),
    readDestinations: jest.fn(async () => [
      { surface: 'librechat' },
      { surface: 'telegram', telegramChatId: 'chat-one', telegramUserId: 'telegram-one' },
    ]),
  };
  const input = {
    source,
    ownerId: 'owner-one',
    conversationId: 'core-one',
    message,
    destination: { surface: 'voice', voiceCallSessionId: 'call-one' } as MainGenerationDelivery,
  };
  return {
    input,
    deps,
    binding,
    accepted,
    goal,
    result,
    row,
    message,
    verify: createNativeCoordinatorResultSourceVerifier(deps),
  };
}

it('uses real Native publisher and persisted Cortex evidence independently of a suppressed foreground task', async () => {
  const f = fixture();
  expect(await f.verify(f.input)).toBe(true);
  expect(await f.verify(f.input)).toBe(true);
  expect(f.deps.readResult).toHaveBeenCalledWith('owner-one', 'native-one', 'goal-one', 'run-one');
  expect(f.input).not.toHaveProperty('workerId');
  expect(f.input).not.toHaveProperty('job');
});

it('rejects a retained result from an older current goal revision', async () => {
  const f = fixture();
  f.goal.result_revision = 2;
  expect(await f.verify(f.input)).toBe(false);
});

it('accepts the exact promoted parent as well as a child without borrowing its old task authority', async () => {
  const f = fixture();
  f.message.messageId = 'original-main';
  f.row.persistedMessageId = 'original-main';
  expect(await f.verify(f.input)).toBe(true);
});

it('keeps original source proof when the result is attached after a later conversation turn', async () => {
  const f = fixture('telegram');
  Object.assign(f.message, { parentMessageId: 'later-conversation-leaf' });
  f.input.destination = {
    surface: 'telegram',
    telegramChatId: 'chat-one',
    telegramUserId: 'telegram-one',
  };
  expect(await f.verify(f.input)).toBe(true);
  expect(f.message.metadata.viventium.cortexPresentationParentMessageId).toBe('original-main');
  f.message.metadata.viventium.cortexPresentationParentMessageId = 'later-conversation-leaf';
  expect(await f.verify(f.input)).toBe(false);
});

it('retains genuine Native source authority for configured Telegram after the original call ends', async () => {
  const f = fixture();
  f.input.destination = {
    surface: 'telegram',
    telegramChatId: 'chat-one',
    telegramUserId: 'telegram-one',
  };
  expect(await f.verify(f.input)).toBe(true);
  expect(f.deps.readDestinations).toHaveBeenCalledWith('owner-one', f.accepted.requestBody);
  f.deps.readDestinations.mockResolvedValue([{ surface: 'librechat' }]);
  expect(await f.verify(f.input)).toBe(false);
});

it('supports a Telegram-origin goal without inventing a Call and rejects a different topic', async () => {
  const f = fixture('telegram');
  f.input.destination = {
    surface: 'telegram',
    telegramChatId: 'chat-one',
    telegramUserId: 'telegram-one',
  };
  expect(await f.verify(f.input)).toBe(true);
  f.input.destination = { ...f.input.destination, telegramMessageThreadId: 'different-topic' };
  expect(await f.verify(f.input)).toBe(false);
});

it('verifies the existing Web source and persisted Web row', async () => {
  const f = fixture('web');
  f.input.destination = { surface: 'librechat' };
  expect(await f.verify(f.input)).toBe(true);
});

it.each(['web', 'telegram', 'voice', 'unknown', 'foreign'])(
  'accepts only the exact Telegram persistence surface (%s)',
  async (surface) => {
    const f = fixture('telegram');
    f.input.destination = {
      surface: 'telegram',
      telegramChatId: 'chat-one',
      telegramUserId: 'telegram-one',
    };
    f.row.surface = surface;
    expect(await f.verify(f.input)).toBe(surface === 'telegram');
  },
);

it.each(['unknown', 'foreign', {}, true, false, null, ''])(
  'rejects an invalid stored source surface instead of accepting arbitrary UI metadata (%s)',
  async (surface) => {
    const f = fixture('telegram');
    f.input.destination = {
      surface: 'telegram',
      telegramChatId: 'chat-one',
      telegramUserId: 'telegram-one',
    };
    f.accepted.requestBody = { messageId: 'original-main', viventiumSurface: surface };
    expect(await f.verify(f.input)).toBe(false);
  },
);

it.each([
  ['binding', 'ownerId', 'foreign'],
  ['binding', 'tenantId', 'foreign'],
  ['binding', 'nativeConversationId', 'foreign'],
  ['binding', 'conversationId', 'foreign'],
  ['binding', 'active', false],
  ['accepted', 'bindingRef', 'foreign'],
  ['accepted', 'turnId', 'foreign'],
  ['goal', 'run_id', 'superseding-run'],
  ['goal', 'source_turn_id', 'foreign'],
  ['goal', 'state', 'running'],
  ['goal', 'intent_state', 'cancelled'],
  ['goal', 'restore_hold', true],
  ['result', 'sha256', 'b'.repeat(64)],
  ['result', 'result_revision', 2],
  ['row', 'userId', 'foreign'],
  ['row', 'conversationId', 'foreign'],
  ['row', 'parentMessageId', 'foreign'],
  ['row', 'persistedMessageId', 'foreign'],
  ['row', 'persistenceStatus', 'pending'],
  ['row', 'status', 'dropped'],
  ['row', 'claimGeneration', 3],
  ['row', 'surface', 'voice'],
  ['row', 'graphResultHash', 'b'.repeat(64)],
  ['row', 'insightHash', 'b'.repeat(64)],
] as const)('rejects stale or foreign %s.%s proof', async (target, field, value) => {
  const f = fixture();
  f[target][field] = value;
  expect(await f.verify(f.input)).toBe(false);
});

it('rejects a fake publisher or a changed Cortex persistence claim', async () => {
  const f = fixture();
  f.result.publisher = { ...(f.result.publisher as object), agent_id: 'worker' };
  expect(await f.verify(f.input)).toBe(false);
  const next = fixture();
  next.row.events = [{ transition: 'persisted', claimGeneration: 2, claimToken: 'foreign-claim' }];
  expect(await next.verify(next.input)).toBe(false);
});

it('verifies shared neutral Native facts for empty failed output while retaining its genuine empty raw digest', async () => {
  const f = fixture();
  const emptyDigest = 'sha256:' + createHash('sha256').update('').digest('hex');
  f.input.source.resultDigest = emptyDigest;
  f.goal.state = 'failed';
  Object.assign(f.result, {
    state: 'failed',
    total_chars: 0,
    sha256: emptyDigest.slice(7),
    failure_class: 'native_failure',
  });
  const insight = nativeCoordinatorResultEvidence({
    text: '',
    state: 'failed',
    failureClass: 'native_failure',
    runId: f.input.source.runId,
    resultRevision: 1,
    resultDigest: emptyDigest,
  });
  const [candidate] = buildCortexInsightDeliveryCandidates({
    ownerId: f.input.ownerId,
    conversationId: f.input.conversationId,
    parentMessageId: 'original-main',
    surface: 'web',
    insights: [
      {
        cortexId: 'native-result:native-one:goal-one:run-one:1',
        status: 'completed',
        insight,
      },
    ],
  });
  Object.assign(f.row, candidate, { insight });
  f.message.metadata.viventium.cortexInsightDeliveryIds = [candidate.deliveryId];
  expect(await f.verify(f.input)).toBe(true);
  expect(f.input.source.resultDigest).toBe(emptyDigest);
  f.row.insight = 'Invented user-facing failure speech';
  expect(await f.verify(f.input)).toBe(false);
});

function turnFixture(surface = 'voice') {
  const f = fixture(surface);
  const { goalId: _goal, ...shared } = f.input.source;
  const source = {
    ...shared,
    kind: 'native_coordinator_turn' as const,
    turnId: 'actual-turn',
    requestId: 'actual-request',
  };
  const { goal_id: _goalId, ...sharedResult } = f.result;
  const result: Record<string, unknown> = {
    ...sharedResult,
    turn_id: source.turnId,
    source_turn_id: source.sourceTurnId,
    request_id: source.requestId,
    state: 'completed',
    intent_state: 'accepted',
    restore_hold: false,
    superseded: false,
    presentation_eligible: true,
    publisher: {
      ...(f.result.publisher as object),
      request_id: source.requestId,
      message_id: source.turnId,
      stream_id: source.turnId,
    },
  };
  const { nativeCoordinatorResultCortexId } = jest.requireActual('./mainGenerationPresentation');
  const [candidate] = buildCortexInsightDeliveryCandidates({
    ownerId: f.input.ownerId,
    conversationId: f.input.conversationId,
    parentMessageId: 'original-main',
    surface: surface === 'voice' ? 'web' : surface,
    insights: [
      {
        cortexId: nativeCoordinatorResultCortexId(source),
        status: 'completed',
        insight: f.row.insight,
      },
    ],
  });
  Object.assign(f.row, candidate);
  f.message.metadata.viventium.cortexInsightDeliveryIds = [candidate.deliveryId];
  const readTurnResult = jest.fn(async () => result);
  const deps = { ...f.deps, readTurnResult };
  return {
    ...f,
    result,
    input: { ...f.input, source },
    deps,
    verify: createNativeCoordinatorResultSourceVerifier(deps),
  };
}
it('verifies a genuine selected turn without inventing or reading a goal', async () => {
  const f = turnFixture();
  expect(await f.verify(f.input)).toBe(true);
  expect(f.deps.readTurnResult).toHaveBeenCalledWith(
    'owner-one',
    'native-one',
    'actual-turn',
    'actual-request',
    'run-one',
  );
  expect(f.deps.readGoal).not.toHaveBeenCalled();
  expect(f.deps.readResult).not.toHaveBeenCalled();
});
it.each([
  ['turn_id', 'other-turn'],
  ['source_turn_id', 'other-source'],
  ['request_id', 'other-request'],
  ['run_id', 'other-run'],
  ['result_revision', 2],
  ['sha256', '0'.repeat(64)],
  ['state', 'failed'],
  ['intent_state', 'cancelled'],
  ['restore_hold', true],
  ['superseded', true],
  ['presentation_eligible', false],
  ['goal_id', 'fake-goal'],
])('rejects stale, stopped, held, superseded or cross-kind turn %s', async (field, value) => {
  const f = turnFixture();
  f.result[field] = value;
  expect(await f.verify(f.input)).toBe(false);
});
it.each(['request_id', 'message_id', 'stream_id', 'owner_id', 'conversation_id'])(
  'requires the exact actual turn publisher %s',
  async (field) => {
    const f = turnFixture();
    (f.result.publisher as Record<string, unknown>)[field] = 'foreign';
    expect(await f.verify(f.input)).toBe(false);
  },
);
it('keeps ended Voice linked text and current conversation source independent of its old foreground task', async () => {
  const f = turnFixture();
  f.input.destination = { surface: 'librechat' };
  Object.assign(f.message, { parentMessageId: 'later-leaf' });
  expect(await f.verify(f.input)).toBe(true);
  f.binding.ownerId = 'foreign';
  f.deps.readTurnResult.mockClear();
  expect(await f.verify(f.input)).toBe(false);
  expect(f.deps.readTurnResult).not.toHaveBeenCalled();
});
it('requires the turn reader and rejects a goal-shaped source claiming to be a turn', async () => {
  const f = turnFixture();
  const { readTurnResult: _reader, ...without } = f.deps;
  expect(await createNativeCoordinatorResultSourceVerifier(without)(f.input)).toBe(false);
  Object.assign(f.input.source, { goalId: 'fake-goal' });
  expect(await f.verify(f.input)).toBe(false);
});
