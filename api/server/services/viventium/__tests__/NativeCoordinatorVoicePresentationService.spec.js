const mockRequest = jest.fn();
const mockDestinations = jest.fn();
jest.mock('@librechat/api', () => ({
  createNativeCoordinatorResultSourceVerifier: (deps) => deps,
  readNativeCoordinatorGoalSnapshot: jest.requireActual('@librechat/api').readNativeCoordinatorGoalSnapshot,
}));
jest.mock('../GlassHiveAccountService', () => ({ requestAccountApi: (...args) => mockRequest(...args) }));
jest.mock('../GlassHiveCallbackBindingService', () => ({ resolveConfiguredGlassHiveDestinations: (...args) => mockDestinations(...args) }));
jest.mock('~/db/models', () => ({ ViventiumCortexInsightDelivery: {} }));
const reader = require('../NativeCoordinatorVoicePresentationService');

beforeEach(() => { mockRequest.mockReset(); mockDestinations.mockReset(); });

test('reads one current goal from the actual conversation snapshot API', async () => {
  const goal = { goal_id: 'goal-one', run_id: 'native-run', intent_state: 'accepted', restore_hold: false };
  mockRequest.mockResolvedValue({ conversation_id: 'native-one', goals: [{ goal_id: 'unrelated' }, goal] });
  expect(await reader.readGoal('owner-one', 'native-one', 'goal-one')).toEqual(goal);
  expect(mockRequest).toHaveBeenCalledWith({ ownerId: 'owner-one', path: '/v1/coordinator/conversations/native-one?include_history=false' });
});

test('does not substitute another goal or turn malformed availability into an empty result', async () => {
  mockRequest.mockResolvedValueOnce({ conversation_id: 'native-one', goals: [{ goal_id: 'other-goal' }] }).mockResolvedValueOnce({});
  await expect(reader.readGoal('owner-one', 'native-one', 'goal-one')).rejects.toMatchObject({ status: 503 });
  await expect(reader.readGoal('owner-one', 'native-one', 'goal-one')).rejects.toMatchObject({ status: 503 });
});

test('reads exact Native result metadata through its existing scoped result route', async () => {
  const result = { goal_id: 'goal-one', run_id: 'native-run', result_revision: 2, publisher: { agent_id: 'coordinator' } };
  mockRequest.mockResolvedValue(result);
  expect(await reader.readResult('owner-one', 'native-one', 'goal-one', 'native-run')).toBe(result);
  expect(mockRequest).toHaveBeenCalledWith({ ownerId: 'owner-one',
    path: '/v1/coordinator/conversations/native-one/goals/goal-one/result?run_id=native-run&offset=0&max_chars=1' });
});

test('resolves only the original configured destinations through the existing owner mapping', async () => {
  const requestBody = { viventiumSurface: 'telegram', viventiumTelegramChatId: 'chat-one' };
  const destinations = [{ surface: 'telegram', telegramChatId: 'chat-one', telegramUserId: 'user-one' }];
  mockDestinations.mockResolvedValue(destinations);
  expect(await reader.readDestinations('owner-one', requestBody)).toBe(destinations);
  expect(mockDestinations).toHaveBeenCalledWith({ ownerId: 'owner-one', requestBody });
});

describe('actual Mongoose private source proof', () => {
  const mongoose = require('mongoose');
  const { MongoMemoryReplSet } = require('mongodb-memory-server');
  const createDelivery = require('~/db/viventiumCortexInsightDelivery');
  const adapter = require('~/db/models').ViventiumCortexInsightDelivery;
  const { createNativeCoordinatorResultSourceVerifier, buildCortexInsightDeliveryCandidates } = jest.requireActual('@librechat/api');
  let server, database, Delivery;
  beforeAll(async () => {
    server = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    database = new mongoose.Mongoose();
    await database.connect(server.getUri());
    Delivery = createDelivery(database);
    await Delivery.init();
    adapter.find = (...args) => Delivery.find(...args);
  }, 30000);
  afterAll(async () => { await database?.disconnect(); await server?.stop(); });
  beforeEach(async () => { await Delivery.collection.deleteMany({}); });
  function fixture() {
    const insight = 'Actual schema projection evidence.';
    const [candidate] = buildCortexInsightDeliveryCandidates({ ownerId: 'owner', conversationId: 'core',
      parentMessageId: 'original-main', surface: 'telegram',
      insights: [{ cortexId: 'native-result:native:goal:run:1', status: 'completed', insight }] });
    const row = { ...candidate, insight, persistenceStatus: 'persisted', status: 'sent',
      persistedMessageId: 'result-message', claimGeneration: 1,
      events: [{ transition: 'persisted', claimToken: 'exact-claim', claimGeneration: 1 }] };
    const binding = { kind: 'native_coordinator_binding', active: true, ownerId: 'owner', tenantId: 'tenant',
      conversationId: 'core', nativeConversationId: 'native' };
    const accepted = { kind: 'native_coordinator_source', bindingRef: 'binding', turnId: 'turn',
      requestBody: { messageId: 'original-main', viventiumSurface: 'telegram' } };
    const goal = { goal_id: 'goal', source_turn_id: 'turn', run_id: 'run', result_revision: 1, state: 'completed', intent_state: 'accepted', restore_hold: false };
    const result = { goal_id: 'goal', run_id: 'run', state: 'completed', result_revision: 1, total_chars: insight.length,
      sha256: candidate.insightHash, publisher: { owner_id: 'owner', conversation_id: 'native', agent_id: 'coordinator',
        run_id: 'run', request_id: 'request', message_id: 'native-message', stream_id: 'native-stream' } };
    const destination = { surface: 'telegram', telegramChatId: 'chat', telegramUserId: 'telegram-user' };
    const input = { source: { kind: 'native_coordinator_goal', bindingRef: 'binding', nativeConversationId: 'native',
      goalId: 'goal', runId: 'run', resultRevision: 1, resultDigest: 'sha256:' + candidate.insightHash,
      sourceTurnId: 'turn', sourceCallSessionId: '' }, ownerId: 'owner', conversationId: 'core', destination,
      message: { messageId: 'result-message', user: 'owner', conversationId: 'core', text: 'Main result.',
        parentMessageId: 'later-conversation-leaf', isCreatedByUser: false, metadata: { viventium: {
          cortexInsightDeliveryIds: [candidate.deliveryId], cortexPresentationParentMessageId: 'original-main',
          cortexPresentationGeneration: 1, cortexPresentationClaimToken: 'exact-claim' } } } };
    const deps = { ...reader, tenantId: () => 'tenant',
      readBinding: async () => binding, readSource: async () => accepted,
      readGoal: async () => goal, readResult: async () => result, readDestinations: async () => [destination] };
    return { row, input, deps, verify: createNativeCoordinatorResultSourceVerifier(deps) };
  }
  test('private projection reaches the verifier while ordinary reads stay hidden', async () => {
    const f = fixture();
    await Delivery.collection.insertOne(f.row);
    const ordinary = await Delivery.findOne({ deliveryId: f.row.deliveryId }).lean();
    expect(ordinary).not.toHaveProperty('insight');
    expect(ordinary).not.toHaveProperty('events');
    const previousReader = createNativeCoordinatorResultSourceVerifier({ ...f.deps,
      readCortexRows: (ownerId, ids, session) => Delivery.find({ userId: ownerId, deliveryId: { $in: ids } }).session(session || null).lean() });
    expect(await previousReader(f.input)).toBe(false);
    expect(await f.verify(f.input)).toBe(true);
  });
  test('the actual query retains owner and exact delivery-ID scope', async () => {
    const f = fixture();
    await Delivery.collection.insertOne(f.row);
    expect(await reader.readCortexRows('foreign-owner', [f.row.deliveryId])).toEqual([]);
    expect(await reader.readCortexRows('owner', ['foreign-delivery'])).toEqual([]);
    f.input.message.metadata.viventium.cortexInsightDeliveryIds = ['foreign-delivery'];
    expect(await f.verify(f.input)).toBe(false);
  });
  test('the actual reader uses only the supplied Mongo transaction session', async () => {
    const f = fixture();
    const session = await database.startSession();
    session.startTransaction();
    try {
      await Delivery.collection.insertOne(f.row, { session });
      expect(await f.verify({ ...f.input, session })).toBe(true);
      expect(await f.verify(f.input)).toBe(false);
    } finally { await session.abortTransaction(); await session.endSession(); }
  });
});

test('reads the distinct Native turn result with exact request and run selectors', async () => {
  const result = { turn_id: 'turn-one', request_id: 'request-one', run_id: 'native-run', result_revision: 1 };
  mockRequest.mockResolvedValue(result);
  expect(await reader.readTurnResult('owner-one', 'native-one', 'turn-one', 'request-one', 'native-run')).toBe(result);
  expect(mockRequest).toHaveBeenCalledWith({ ownerId: 'owner-one',
    path: '/v1/coordinator/conversations/native-one/turns/turn-one/result?request_id=request-one&run_id=native-run&offset=0&max_chars=1' });
});
