/* === VIVENTIUM START === Exact pending native input reuses durable Voice delivery authority. === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { nativeWorkInputPresentation, nativeWorkInputBinding } = require('@librechat/api');
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
  renewGlassHiveCallbackDeliveryDispatch,
  resolveGlassHiveVoicePresentation,
  markGlassHiveCallbackDeliverySent,
  markGlassHiveCallbackDeliveryUnknown,
  getSettledGlassHiveVoiceCallbackDelivery,
  releaseGlassHiveCallbackDeliveryDispatch,
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
    externalState: 'running',
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
describe('pending native question Voice authority', () => {
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
    'claim, permit, exact speech trace, renewal and once-only sent preserve pending %s',
    async (kind) => {
      await fixture(kind === 'question' ? 'Which size?' : 'Permit this operation?', kind);
      const row = await claimed();
      expect(row).toBeTruthy();
      const permit = await authorizeGlassHiveCallbackDeliveryDispatch({
        ...scope,
        deliveryId: row.deliveryId,
        claimId: row.claimId,
      });
      expect(permit.resultDigest).toBe(nativeWorkInputPresentation(row).digest);
      expect(
        await authorizeGlassHiveCallbackDeliveryDispatch({
          ...scope,
          deliveryId: row.deliveryId,
          claimId: row.claimId,
        }),
      ).toEqual(permit);
      const proof = {
        ...scope,
        conversationId: row.conversationId,
        deliveryId: row.deliveryId,
        claimId: row.claimId,
        dispatchPermit: permit,
        presentationRef: row.deliveryId,
        turnId: row.voiceRequestId,
      };
      expect(await resolveGlassHiveVoicePresentation(proof)).toMatchObject({
        deliveryId: row.deliveryId,
      });
      expect(
        await resolveGlassHiveVoicePresentation({ ...proof, turnId: 'foreign-turn' }),
      ).toBeNull();
      const renewal = await renewGlassHiveCallbackDeliveryDispatch({ ...proof, leaseMs: 120000 });
      expect(renewal.permitId).toBe(permit.permitId);
      expect(
        await markGlassHiveCallbackDeliverySent({ ...proof, dispatchPermit: renewal }),
      ).toMatchObject({ status: 'sent' });
      expect(
        await markGlassHiveCallbackDeliverySent({ ...proof, dispatchPermit: renewal }),
      ).toBeNull();
      expect(await claimed()).toBeUndefined();
      expect(
        await getSettledGlassHiveVoiceCallbackDelivery({ ...scope, callbackId: row.callbackId }),
      ).toMatchObject({ status: 'sent', deliveryId: row.deliveryId });
      expect(
        await getSettledGlassHiveVoiceCallbackDelivery({
          ...scope,
          userId: 'foreign-owner',
          callbackId: row.callbackId,
        }),
      ).toBeNull();
      expect(mockPending.state).toBe('pending');
    },
  );
  test('same exact legacy question is recovered in the existing message and ledger, not discarded or duplicated', async () => {
    await fixture('The native harness is waiting for your response.');
    const row = await claimed();
    expect(row.text).toBe(mockPending.message);
    expect(row.fullText).toBe(mockPending.message);
    expect(
      await authorizeGlassHiveCallbackDeliveryDispatch({
        ...scope,
        deliveryId: row.deliveryId,
        claimId: row.claimId,
      }),
    ).toBeTruthy();
    const repaired = await ViventiumGlassHiveCallbackDelivery.findOne({
      deliveryId: row.deliveryId,
    }).lean();
    expect(repaired.text).toBe(mockPending.message);
    expect(await ViventiumGlassHiveCallbackDelivery.countDocuments({})).toBe(1);
    const message = await Message.findOne({ messageId: row.callbackMessageId }).lean();
    expect(message.text).toBe(mockPending.message);
    expect(message.content[0].text).toBe(mockPending.message);
  });
  test.each(['answered', 'replaced', 'expired', 'new-attempt', 'new-session', 'expired-binding'])(
    'fences %s before new speech',
    async (mode) => {
      await fixture();
      const row = await claimed();
      if (mode === 'answered') mockPending = null;
      if (mode === 'replaced')
        mockPending = { ...mockPending, requestId: 'other', requestFingerprint: 'c'.repeat(64) };
      if (mode === 'expired')
        mockPending = { ...mockPending, expiresAt: '2000-01-01T00:00:00.000Z' };
      if (mode === 'new-attempt') mockPending = { ...mockPending, attemptId: 'other' };
      if (mode === 'new-session') mockPending = { ...mockPending, sessionId: 'other' };
      if (mode === 'expired-binding')
        await ViventiumGlassHiveCallbackDelivery.collection.updateOne(
          { deliveryId: row.deliveryId },
          { $set: { 'nativeInputBinding.expiresAt': '2000-01-01T00:00:00.000Z' } },
        );
      expect(
        await authorizeGlassHiveCallbackDeliveryDispatch({
          ...scope,
          deliveryId: row.deliveryId,
          claimId: row.claimId,
        }),
      ).toBeNull();
      expect(
        (await ViventiumGlassHiveCallbackDelivery.findOne({ deliveryId: row.deliveryId }).lean())
          .status,
      ).toBe('superseded');
      expect(
        await markGlassHiveCallbackDeliverySent({
          ...scope,
          deliveryId: row.deliveryId,
          claimId: row.claimId,
        }),
      ).toBeNull();
    },
  );
  test('temporary pre-permit account failure reclaims the same durable question safely', async () => {
    await fixture();
    mockAccountRead.mockRejectedValueOnce(new Error('account temporarily unavailable'));
    await expect(claimed()).rejects.toThrow('account temporarily unavailable');
    const original = await ViventiumGlassHiveCallbackDelivery.findOne({
      deliveryId: 'question-delivery',
    }).lean();
    expect(original).toMatchObject({
      status: 'claimed',
      dispatchPermitId: '',
      dispatchPermitGeneration: 0,
    });
    await ViventiumGlassHiveCallbackDelivery.updateOne(
      { deliveryId: original.deliveryId },
      { $set: { leaseExpiresAt: new Date(0) } },
    );
    const retried = await claimed();
    expect(retried).toMatchObject({ deliveryId: original.deliveryId, text: mockPending.message });
    expect(retried.claimId).not.toBe(original.claimId);
    expect(await ViventiumGlassHiveCallbackDelivery.countDocuments({})).toBe(1);
  });
  test('an issued native permit cannot replay after release and claim expiry', async () => {
    await fixture();
    const row = await claimed();
    const request = { ...scope, deliveryId: row.deliveryId, claimId: row.claimId };
    const permit = await authorizeGlassHiveCallbackDeliveryDispatch(request);
    expect(
      await releaseGlassHiveCallbackDeliveryDispatch({ ...request, dispatchPermit: permit }),
    ).toBe(true);
    const released = await ViventiumGlassHiveCallbackDelivery.findOne({
      deliveryId: row.deliveryId,
    }).lean();
    expect(released.dispatchPermitGeneration).toBe(permit.permitGeneration);
    await ViventiumGlassHiveCallbackDelivery.updateOne(
      { deliveryId: row.deliveryId },
      { $set: { leaseExpiresAt: new Date(0) } },
    );
    expect(await claimed()).toBeUndefined();
    expect(
      (await ViventiumGlassHiveCallbackDelivery.findOne({ deliveryId: row.deliveryId }).lean())
        .status,
    ).toBe('delivery_unknown');
  });
  test('answered question cannot renew or admit trace; existing issued speech records unknown once', async () => {
    await fixture();
    const row = await claimed();
    const permit = await authorizeGlassHiveCallbackDeliveryDispatch({
      ...scope,
      deliveryId: row.deliveryId,
      claimId: row.claimId,
    });
    const proof = {
      ...scope,
      deliveryId: row.deliveryId,
      claimId: row.claimId,
      dispatchPermit: permit,
    };
    mockPending = null;
    expect(await renewGlassHiveCallbackDeliveryDispatch(proof)).toBeNull();
    expect(
      await resolveGlassHiveVoicePresentation({
        ...proof,
        conversationId: row.conversationId,
        presentationRef: row.deliveryId,
        turnId: row.voiceRequestId,
      }),
    ).toBeNull();
    expect(
      await markGlassHiveCallbackDeliveryUnknown({ ...proof, requireIssuedPermit: true }),
    ).toMatchObject({ status: 'delivery_unknown' });
    expect(await claimed()).toBeUndefined();
  });
  test.each(['owner', 'call', 'message', 'terminal-run'])(
    'rejects changed %s authority',
    async (field) => {
      await fixture();
      const row = await claimed();
      if (field === 'message')
        await Message.updateOne(
          { messageId: row.callbackMessageId },
          { $set: { text: 'changed' } },
        );
      if (field === 'terminal-run')
        await mongoose.connection
          .collection('viventium_external_work')
          .updateOne({ _id: row.originRef }, { $set: { externalState: 'completed' } });
      const request = {
        ...scope,
        deliveryId: row.deliveryId,
        claimId: row.claimId,
        ...(field === 'owner' ? { userId: 'foreign-owner' } : {}),
        ...(field === 'call' ? { voiceCallSessionId: 'foreign-call' } : {}),
      };
      if (field === 'terminal-run')
        await expect(authorizeGlassHiveCallbackDeliveryDispatch(request)).rejects.toMatchObject({
          code: 'glasshive_callback_delivery_superseded',
        });
      else expect(await authorizeGlassHiveCallbackDeliveryDispatch(request)).toBeNull();
    },
  );
});
