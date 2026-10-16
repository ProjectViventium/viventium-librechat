/* === VIVENTIUM START === Raw native requests remain internal; Main owns mission Voice presentation. === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { nativeWorkInputBinding } = require('@librechat/api');
const { Message, ViventiumGlassHiveCallbackDelivery } = require('~/db/models');
let mockPending;
const mockAccountRead = jest.fn(async ({ ownerId }) =>
  ownerId === 'owner-question'
    ? {
        workRef: 'work-question',
        state: mockPending ? 'needs_input' : 'running',
        pendingNativeInput: mockPending,
      }
    : null,
);
jest.mock('../GlassHiveAccountService', () => ({
  requestAccountApi: (...args) => mockAccountRead(...args),
}));
jest.mock('../GlassHiveCallbackBindingService', () => {
  const typed = require('@librechat/api').createGlassHiveCallbackBindingService({
    mongoose: require('mongoose'),
  });
  return {
    fenceGlassHiveCallbackRunState: typed.fenceGlassHiveCallbackRunState,
    isGlassHiveNonterminalAttentionCallback: typed.isGlassHiveNonterminalAttentionCallback,
    recordGlassHiveSurfaceDeliveryOutcome: jest.fn().mockResolvedValue(null),
  };
});
jest.mock('../VoiceOrchestrationTraceService', () => ({
  recordVoiceOrchestrationTraceBestEffort: jest.fn(),
}));
jest.mock('../OrchestrationTraceLedgerService', () => ({
  recordOrchestrationTraceDelivery: jest.fn(),
}));
const {
  claimPendingGlassHiveCallbackDeliveries,
  authorizeGlassHiveCallbackDeliveryDispatch,
} = require('../GlassHiveCallbackDeliveryService');
const scope = { userId: 'owner-question', voiceCallSessionId: 'call-question' };
function pending(kind = 'permission') {
  const request = {
    version: 1,
    requestId: 'request-question',
    requestFingerprint: 'a'.repeat(64),
    runId: 'run-question',
    attemptId: 'attempt-question',
    sessionId: 'session-question',
    expiresAt: '2099-01-01T00:00:00.000Z',
    kind: 'permission',
    state: 'pending',
    mode: 'form',
    runtimeName: 'Native runtime',
    message: 'Permit this operation?',
    requestedSchema: {
      type: 'object',
      required: ['optionId'],
      properties: {
        optionId: {
          type: 'string',
          enum: ['allow_once', 'reject_once'],
          enumNames: ['Allow once', 'Reject once'],
        },
      },
    },
  };
  if (kind === 'question') {
    const key = 'Which size?';
    request.kind = 'question';
    request.message = key;
    request.requestedSchema = {
      type: 'object',
      required: ['answers'],
      additionalProperties: false,
      properties: {
        answers: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          maxProperties: 16,
          properties: {
            [key]: {
              type: 'array',
              uniqueItems: true,
              minItems: 1,
              maxItems: 1,
              items: { type: 'string', enum: ['Small', 'Other'] },
            },
          },
        },
        annotations: {
          type: 'object',
          additionalProperties: false,
          properties: {
            [key]: {
              type: 'object',
              additionalProperties: false,
              required: ['notes'],
              properties: { notes: { type: 'string', minLength: 1, maxLength: 8000 } },
            },
          },
        },
      },
    };
  }
  return request;
}
async function fixture(text = 'Permit this operation?', kind = 'permission') {
  mockPending = pending(kind);
  const row = {
    deliveryKey: 'question-key',
    deliveryId: 'question-delivery',
    callbackId: 'callback_sha256:' + 'b'.repeat(64),
    callbackMessageId: 'question-message',
    userId: scope.userId,
    conversationId: 'conversation-question',
    surface: 'voice',
    voiceCallSessionId: scope.voiceCallSessionId,
    voiceRequestId: 'question-turn',
    originRef: 'origin-question',
    workRef: 'work-question',
    workerId: 'worker-question',
    runId: 'run-question',
    event: 'run.needs_input',
    presentationKind: 'native_input',
    status: 'pending',
    text,
    fullText: text,
    expiresAt: new Date('2099-01-01'),
    nativeInputBinding: nativeWorkInputBinding(mockPending, mockPending.runId),
  };
  await mongoose.connection.collection('viventium_external_work').insertOne({
    _id: row.originRef,
    ownerId: row.userId,
    workRef: row.workRef,
    runId: row.runId,
    workerId: row.workerId,
    externalState: 'needs_input',
  });
  await Message.create({
    user: row.userId,
    conversationId: row.conversationId,
    messageId: row.callbackMessageId,
    isCreatedByUser: false,
    text,
    content: [{ type: 'text', text }],
    metadata: {
      viventium: {
        type: 'glasshive_worker_callback',
        callbackId: row.callbackId,
        event: row.event,
        originRef: row.originRef,
        workRef: row.workRef,
        workerId: row.workerId,
        runId: row.runId,
        voiceCallSessionId: row.voiceCallSessionId,
      },
    },
  });
  await ViventiumGlassHiveCallbackDelivery.create(row);
  return row;
}
async function claimed() {
  const [row] = await claimPendingGlassHiveCallbackDeliveries({
    surface: 'voice',
    callbackId: 'callback_sha256:' + 'b'.repeat(64),
    ...scope,
  });
  return row;
}
// The former bank expected raw run.needs_input prose to speak directly. That
// behavior is now forbidden. Main-authored attention permit/settlement and exact
// worker fences are exercised in GlassHiveCallbackDeliveryService.spec.js.
describe('raw native input stays internal on mission Voice', () => {
  let replica;
  beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Message.syncIndexes();
    await ViventiumGlassHiveCallbackDelivery.syncIndexes();
  }, 30000);
  afterEach(async () => {
    await mongoose.connection.dropDatabase();
    await Message.syncIndexes();
    await ViventiumGlassHiveCallbackDelivery.syncIndexes();
    jest.clearAllMocks();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
  });
  test.each(['permission', 'question'])(
    'keeps exact %s data without a raw speech claim',
    async (kind) => {
      const fixtureRow = await fixture(
        kind === 'question' ? 'Which size?' : 'May I replace the file?',
        kind,
      );
      expect(await claimed()).toBeUndefined();
      expect(await claimed()).toBeUndefined(); // Exact polling/replay cannot add another speech path.
      const retained = await ViventiumGlassHiveCallbackDelivery.findOne({
        deliveryId: fixtureRow.deliveryId,
      }).lean();
      expect(retained.status).toBe('pending');
      expect(retained.text).toBe(fixtureRow.text);
      expect(retained.nativeInputBinding).toEqual(fixtureRow.nativeInputBinding);
      expect(await ViventiumGlassHiveCallbackDelivery.countDocuments({})).toBe(1);
      expect(mockAccountRead).not.toHaveBeenCalled();
    },
  );
  test.each(['pending', 'delivery_unknown', 'sent'])(
    'does not revive an old raw %s receipt',
    async (status) => {
      const row = await fixture();
      await ViventiumGlassHiveCallbackDelivery.updateOne(
        { deliveryId: row.deliveryId },
        { $set: { status, claimId: 'old-claim' } },
      );
      expect(await claimed()).toBeUndefined();
      expect(
        await authorizeGlassHiveCallbackDeliveryDispatch({
          ...scope,
          deliveryId: row.deliveryId,
          claimId: 'old-claim',
        }),
      ).toBeNull();
      const retained = await ViventiumGlassHiveCallbackDelivery.findOne({
        deliveryId: row.deliveryId,
      }).lean();
      expect(retained.status).toBe(status);
    },
  );
  test('missing worker identity cannot make a raw callback eligible', async () => {
    const row = await fixture();
    await mongoose.connection
      .collection('viventium_external_work')
      .updateOne({ _id: row.originRef }, { $unset: { workerId: '' } });
    expect(await claimed()).toBeUndefined();
  });
});
