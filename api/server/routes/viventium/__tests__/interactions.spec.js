const express = require('express');
const mockAcknowledgeHostFinal = jest.fn();
jest.mock('~/server/services/viventium/nativeResponseService', () => ({
  acknowledgeRetainedHostFinal: (...args) => mockAcknowledgeHostFinal(...args),
}));

let mockAcknowledgeDelivery;
let mockAcknowledgeDurableEffectDelivery;
let mockAcknowledgeServerCommittedTransportReceipt;
let mockHasAcceptedGlassHiveLaunchForPresentation;
const mockRefreshVoiceTaskCommittedPresentation = jest.fn();
const mockMessageUpdateOne = jest.fn();
const mockMessageFindOneAndDelete = jest.fn();
const mockMessageFindOne = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockRecordTelegramTransportReceipt = jest.fn();
const mockCommitAcceptedMainTurnFromPresentation = jest.fn();
const mockScheduleExternallyAcceptedMainCompaction = jest.fn();
const mockMarkCortexTelegramPresentation = jest.fn();
const mockMarkCortexTelegramPresentationFailed = jest.fn();
const mockConsumeLocalQaCortexFault = jest.fn();
const mockTelegramInputDeliveryCoverage = jest.fn(() => null);
const mockAcknowledgeMongoDurableEffectDelivery = jest.fn();
const mockAcknowledgeRetainedTelegramFailure = jest.fn();
jest.mock('~/server/services/viventium/TelegramIngressAuthorityService', () => ({
  acknowledgeRetainedTelegramFailure: (...args) => mockAcknowledgeRetainedTelegramFailure(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  telegramInputDeliveryCoverage: (...args) => mockTelegramInputDeliveryCoverage(...args),
  scheduleExternallyAcceptedMainCompaction: (...args) =>
    mockScheduleExternallyAcceptedMainCompaction(...args),
  GenerationJobManager: {
    acknowledgeDelivery: (...args) => mockAcknowledgeDelivery(...args),
    acknowledgeDurableEffectDelivery: (...args) => mockAcknowledgeDurableEffectDelivery(...args),
    acknowledgeServerCommittedTransportReceipt: (...args) =>
      mockAcknowledgeServerCommittedTransportReceipt(...args),
  },
}));

jest.mock('~/server/services/viventium/GlassHiveCallbackBindingService', () => ({
  hasAcceptedGlassHiveLaunchForPresentation: (...args) =>
    mockHasAcceptedGlassHiveLaunchForPresentation(...args),
}));

jest.mock('~/server/services/viventium/VoiceTaskService', () => ({
  refreshVoiceTaskCommittedPresentation: (...args) =>
    mockRefreshVoiceTaskCommittedPresentation(...args),
}));

jest.mock('~/db/models', () => ({
  Message: {
    updateOne: (...args) => mockMessageUpdateOne(...args),
    findOneAndDelete: (...args) => mockMessageFindOneAndDelete(...args),
    findOne: (...args) => mockMessageFindOne(...args),
  },
  Conversation: { updateOne: (...args) => mockConversationUpdateOne(...args) },
}));

jest.mock('~/server/services/viventium/TelegramReplyProvenanceService', () => ({
  recordTelegramTransportReceipt: (...args) => mockRecordTelegramTransportReceipt(...args),
}));

jest.mock('~/server/services/viventium/ViventiumMainContinuityService', () => ({
  commitAcceptedMainTurnFromPresentation: (...args) =>
    mockCommitAcceptedMainTurnFromPresentation(...args),
}));

jest.mock('~/server/services/viventium/InteractionDurableEffectService', () => ({
  acknowledgeDurableEffectDelivery: (...args) => mockAcknowledgeMongoDurableEffectDelivery(...args),
}));

jest.mock('~/server/services/viventium/CortexInsightDeliveryService', () => ({
  requireExactCortexInsightDeliverySettlement: (expected, settled) => {
    const expectedIds = new Set(expected.map((row) => row.deliveryId));
    const settledIds = new Set((settled || []).map((row) => row.deliveryId));
    if (
      expectedIds.size !== expected.length ||
      settledIds.size !== expectedIds.size ||
      [...expectedIds].some((deliveryId) => !settledIds.has(deliveryId))
    ) {
      const error = new Error('Cortex insight delivery settlement was incomplete');
      error.code = 'cortex_insight_delivery_settlement_conflict';
      throw error;
    }
    return settled;
  },
  markCortexInsightDeliveryPresentationByParent: (...args) =>
    mockMarkCortexTelegramPresentation(...args),
  markCortexInsightDeliveryPresentationFailedByParent: (...args) =>
    mockMarkCortexTelegramPresentationFailed(...args),
}));

jest.mock('~/server/services/viventium/LocalQaCortexFaultService', () => ({
  consumeLocalQaCortexFault: (...args) => mockConsumeLocalQaCortexFault(...args),
}));

function createApp(router) {
  const app = express();
  app.use('/api/viventium/interactions', router);
  return app;
}

function request({ headers = {}, body = {} } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method: 'POST',
    url: '/api/viventium/interactions/delivery-ack',
    originalUrl: '/api/viventium/interactions/delivery-ack',
    path: '/delivery-ack',
    headers: normalized,
    body,
    get(name) {
      return normalized[name.toLowerCase()] || '';
    },
  };
}

function response() {
  const res = {
    statusCode: 200,
    writableEnded: false,
    setHeader: jest.fn(),
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      res.writableEnded = true;
      res.resolve();
      return res;
    },
  };
  res.done = new Promise((resolve) => {
    res.resolve = resolve;
  });
  return res;
}

async function dispatch(app, req, res) {
  app.handle(req, res, (error) => {
    if (error) throw error;
    if (!res.writableEnded) res.resolve();
  });
  await res.done;
}

describe('POST /api/viventium/interactions/delivery-ack', () => {
  beforeEach(() => {
    mockAcknowledgeHostFinal.mockReset().mockResolvedValue({ status: 'not_found' });
    mockTelegramInputDeliveryCoverage.mockReset().mockReturnValue(null);
    mockAcknowledgeRetainedTelegramFailure.mockReset().mockResolvedValue({ status: 'not_found' });
    mockAcknowledgeMongoDurableEffectDelivery.mockReset().mockResolvedValue({ status: 'conflict' });
    jest.resetModules();
    mockMessageUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
    mockRefreshVoiceTaskCommittedPresentation.mockReset().mockResolvedValue(null);
    mockMessageFindOneAndDelete.mockReset().mockResolvedValue(null);
    mockMessageFindOne.mockReset().mockReturnValue({ select: () => ({ lean: async () => null }) });
    mockConversationUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
    mockRecordTelegramTransportReceipt.mockReset().mockResolvedValue({ status: 'sent' });
    mockCommitAcceptedMainTurnFromPresentation.mockReset().mockResolvedValue({
      status: 'committed',
    });
    mockScheduleExternallyAcceptedMainCompaction.mockReset().mockReturnValue(true);
    mockMarkCortexTelegramPresentation.mockReset().mockResolvedValue([]);
    mockMarkCortexTelegramPresentationFailed.mockReset().mockResolvedValue([]);
    mockConsumeLocalQaCortexFault.mockReset().mockResolvedValue({
      triggered: false,
      reason: 'disabled',
    });
    mockAcknowledgeDelivery = jest.fn().mockResolvedValue({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'message-1',
        presentation_committed_at: 1725000000123,
      },
      idempotent: false,
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response',
        interactionContext: {
          logical_turn_id: 'turn-1',
          revision: 2,
        },
      },
    });
    mockAcknowledgeDurableEffectDelivery = jest.fn().mockResolvedValue({ status: 'conflict' });
    mockAcknowledgeServerCommittedTransportReceipt = jest
      .fn()
      .mockResolvedValue({ status: 'conflict' });
    mockHasAcceptedGlassHiveLaunchForPresentation = jest.fn().mockResolvedValue(false);
    process.env.VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET = 'adapter-secret';
    process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET = 'voice-adapter-secret';
  });

  afterEach(() => {
    delete process.env.VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET;
    delete process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET;
  });

  test.each(['telegram', 'voice'])(
    'missing-job %s final ACK uses the same canonical completion and acceptance owners',
    async (surface) => {
      const result = await mockAcknowledgeDelivery();
      mockAcknowledgeDelivery.mockClear().mockResolvedValue({ status: 'not_found' });
      mockAcknowledgeHostFinal.mockResolvedValue(result);
      const res = response();
      await dispatch(
        createApp(require('../interactions')),
        request({
          headers: {
            'x-viventium-adapter-secret':
              surface === 'voice' ? 'voice-adapter-secret' : 'adapter-secret',
          },
          body: {
            logical_turn_id: 'turn-1',
            revision: 2,
            state: 'committed',
            presentation_ref: 'message-1',
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.acknowledged).toBe(true);
      expect(mockAcknowledgeHostFinal).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'committed', logical_turn_id: 'turn-1' }),
        surface,
      );
      expect(mockCommitAcceptedMainTurnFromPresentation).toHaveBeenCalled();
      expect(mockAcknowledgeRetainedTelegramFailure).not.toHaveBeenCalled();
    },
  );

  test('missing Redis failed Telegram ACK settles its exact durable terminal without Main acceptance', async () => {
    mockAcknowledgeDelivery.mockResolvedValue({ status: 'not_found' });
    mockAcknowledgeRetainedTelegramFailure.mockResolvedValue({
      status: 'recorded',
      idempotent: true,
      transportOnly: true,
    });
    const res = response();
    await dispatch(
      createApp(require('../interactions')),
      request({
        headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
        body: {
          logical_turn_id: 'turn-1',
          revision: 2,
          state: 'failed',
          presentation_ref: 'telegram:chat',
        },
      }),
      res,
    );
    expect(res.body).toEqual({ acknowledged: true, idempotent: true });
    expect(mockAcknowledgeRetainedTelegramFailure).toHaveBeenCalledWith(
      expect.objectContaining({ logical_turn_id: 'turn-1', revision: 2, state: 'failed' }),
      'telegram',
    );
    expect(mockCommitAcceptedMainTurnFromPresentation).not.toHaveBeenCalled();
    expect(mockScheduleExternallyAcceptedMainCompaction).not.toHaveBeenCalled();
  });

  test('refreshes the Voice snapshot after Message persistence, Main acceptance and compaction', async () => {
    const order = [];
    mockMessageUpdateOne.mockImplementation(async () => {
      order.push('persisted');
      return { modifiedCount: 1 };
    });
    mockCommitAcceptedMainTurnFromPresentation.mockImplementation(async () => {
      order.push('accepted');
      return { status: 'committed' };
    });
    mockScheduleExternallyAcceptedMainCompaction.mockImplementation(() => {
      order.push('compaction');
      return true;
    });
    mockRefreshVoiceTaskCommittedPresentation.mockImplementation(async () => {
      order.push('snapshot');
      return null;
    });
    const router = require('../interactions');
    const res = response();
    await dispatch(
      createApp(router),
      request({
        headers: { 'x-viventium-adapter-secret': 'voice-adapter-secret' },
        body: {
          logical_turn_id: 'turn-1',
          revision: 2,
          state: 'committed',
          presentation_ref: 'voice-presentation',
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(order).toEqual(['persisted', 'accepted', 'compaction', 'snapshot']);
    expect(mockCommitAcceptedMainTurnFromPresentation).toHaveBeenCalledTimes(1);
    expect(mockScheduleExternallyAcceptedMainCompaction).toHaveBeenCalledTimes(1);
    expect(mockRefreshVoiceTaskCommittedPresentation).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'recorded' }),
      'voice',
    );
  });

  test('a failed Voice projection keeps the committed ACK and accepts Main only once', async () => {
    const projectionError = new Error('private projection payload must not be logged');
    projectionError.name = 'ProjectionUnavailable';
    mockRefreshVoiceTaskCommittedPresentation.mockRejectedValueOnce(projectionError);
    const router = require('../interactions');
    const { logger } = require('@librechat/data-schemas');
    const res = response();
    await dispatch(
      createApp(router),
      request({
        headers: { 'x-viventium-adapter-secret': 'voice-adapter-secret' },
        body: {
          logical_turn_id: 'turn-1',
          revision: 2,
          state: 'committed',
          presentation_ref: 'voice-presentation',
        },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ acknowledged: true, idempotent: false });
    expect(mockMessageUpdateOne).toHaveBeenCalledTimes(1);
    expect(mockCommitAcceptedMainTurnFromPresentation).toHaveBeenCalledTimes(1);
    expect(mockScheduleExternallyAcceptedMainCompaction).toHaveBeenCalledTimes(1);
    expect(mockRefreshVoiceTaskCommittedPresentation).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][interactions/delivery-ack] Voice task projection unavailable',
      { error: 'ProjectionUnavailable' },
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each(['failed', 'partial_removed'])(
    'does not announce files for %s Voice playback',
    async (state) => {
      mockAcknowledgeDelivery.mockResolvedValueOnce({
        ...(await mockAcknowledgeDelivery()),
        acknowledgement: { logical_turn_id: 'turn-1', revision: 2, state },
      });
      const router = require('../interactions'),
        res = response();
      await dispatch(
        createApp(router),
        request({
          headers: { 'x-viventium-adapter-secret': 'voice-adapter-secret' },
          body: { logical_turn_id: 'turn-1', revision: 2, state },
        }),
        res,
      );
      expect(mockRefreshVoiceTaskCommittedPresentation).not.toHaveBeenCalled();
    },
  );
  test.each([false, true])(
    'an unmatched presentation write only accepts an exact saved terminal receipt: %s',
    async (alreadySaved) => {
      mockMessageUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0 });
      mockMessageFindOne.mockReturnValueOnce({
        select: () => ({ lean: async () => (alreadySaved ? { _id: 'saved-receipt' } : null) }),
      });
      const router = require('../interactions');
      const res = response();
      await dispatch(
        createApp(router),
        request({
          headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
          body: { logical_turn_id: 'turn-1', revision: 2, state: 'committed' },
        }),
        res,
      );
      expect(mockMessageFindOne).toHaveBeenCalledWith({
        user: 'server-user',
        messageId: 'server-response',
        conversationId: 'server-conversation',
        isCreatedByUser: { $ne: true },
        unfinished: false,
        'metadata.viventium.interactionContext.logical_turn_id': 'turn-1',
        'metadata.viventium.interactionContext.revision': 2,
        'metadata.viventium.deliveryAcknowledgement.logical_turn_id': 'turn-1',
        'metadata.viventium.deliveryAcknowledgement.revision': 2,
        'metadata.viventium.deliveryAcknowledgement.state': 'committed',
        'metadata.viventium.deliveryAcknowledgement.presentation_ref': 'message-1',
        'metadata.viventium.deliveryAcknowledgement.presentation_committed_at': 1725000000123,
      });
      expect(res.statusCode).toBe(alreadySaved ? 200 : 503);
      expect(mockCommitAcceptedMainTurnFromPresentation).toHaveBeenCalledTimes(
        alreadySaved ? 1 : 0,
      );
      if (!alreadySaved) {
        expect(res.body).toEqual({ acknowledged: false, error: 'persistence_unavailable' });
        expect(mockRecordTelegramTransportReceipt).not.toHaveBeenCalled();
      }
    },
  );

  test('fails closed for missing or wrong adapter credentials', async () => {
    const router = require('../interactions');
    const app = createApp(router);
    for (const secret of ['', 'wrong-secret']) {
      const req = request({
        headers: { 'x-viventium-adapter-secret': secret },
        body: { logical_turn_id: 'turn-1', revision: 2, state: 'committed' },
      });
      const res = response();
      await dispatch(app, req, res);
      expect(res.statusCode).toBe(401);
    }
    expect(mockAcknowledgeDelivery).not.toHaveBeenCalled();
  });

  test('durably binds trusted source coverage to an already finished answer and safely repeats the ACK', async () => {
    const coverage = {
      logical_turn_id: 'turn-1',
      revision: 2,
      source_order_scope: 'scope',
      source_conversation_generation: 'generation',
      sources: [
        {
          source_event_id: 'original-event',
          source_message_id: 'original-message',
          source_sequence: 1,
        },
      ],
    };
    mockTelegramInputDeliveryCoverage.mockReturnValue(coverage);
    const app = createApp(require('../interactions'));
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = response();
      await dispatch(
        app,
        request({
          headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
          body: {
            logical_turn_id: 'turn-1',
            revision: 2,
            state: 'committed',
            deliverySourceCoverage: { sources: ['forged-source'] },
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
    }
    expect(mockMessageUpdateOne).toHaveBeenCalledTimes(2);
    const [filter, update] = mockMessageUpdateOne.mock.calls[0];
    expect(filter).not.toHaveProperty('unfinished');
    expect(filter).toMatchObject({
      user: 'server-user',
      messageId: 'server-response',
      conversationId: 'server-conversation',
      'metadata.viventium.interactionContext.revision': 2,
    });
    expect(update.$set['metadata.viventium.deliverySourceCoverage']).toEqual(coverage);
    expect(mockTelegramInputDeliveryCoverage).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'recorded',
        presentation: expect.objectContaining({ userId: 'server-user' }),
      }),
    );
  });

  test('reports unavailable adapter authentication when the server secret is not configured', async () => {
    delete process.env.VIVENTIUM_TELEGRAM_INTERACTION_ADAPTER_SECRET;
    delete process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET;
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'any-value' },
      body: { logical_turn_id: 'turn-1', revision: 2, state: 'committed' },
    });
    const res = response();
    await dispatch(app, req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      acknowledged: false,
      error: 'adapter_auth_unavailable',
    });
    expect(mockAcknowledgeDelivery).not.toHaveBeenCalled();
  });

  test('passes only the approved bounded contract and ignores forged owner claims', async () => {
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'message-1',
        presentation_committed_at: 1,
        userId: 'forged-user',
        conversationId: 'forged-conversation',
        surface: 'telegram',
      },
    });
    const res = response();
    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ acknowledged: true, idempotent: false });
    expect(mockAcknowledgeDelivery).toHaveBeenCalledWith(
      {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'message-1',
      },
      'telegram',
    );
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      {
        user: 'server-user',
        conversationId: 'server-conversation',
        messageId: 'server-response',
        isCreatedByUser: { $ne: true },
        'metadata.viventium.interactionContext.logical_turn_id': 'turn-1',
        'metadata.viventium.interactionContext.revision': 2,
      },
      {
        $set: {
          unfinished: false,
          'metadata.viventium.deliveryAcknowledgement': {
            logical_turn_id: 'turn-1',
            revision: 2,
            state: 'committed',
            presentation_ref: 'message-1',
            presentation_committed_at: 1725000000123,
          },
        },
      },
    );
    expect(mockCommitAcceptedMainTurnFromPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        responseMessageId: 'server-response',
        presentationCommittedAt: 1725000000123,
      }),
    );
    // External acceptance schedules the accepted turn's semantic compaction.
    expect(mockScheduleExternallyAcceptedMainCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ responseMessageId: 'server-response' }),
      { status: 'committed' },
    );
  });

  test('passes an exact bounded Cortex presentation assertion to the owner store', async () => {
    const cortexPresentation = {
      ownerId: 'server-user',
      messageId: 'follow-up-7',
      parentMessageId: 'server-response',
      revision: 3,
      generation: 7,
      claimToken: 'claim-7',
      presentationLeaseToken: 'lease-7',
      deliveryIds: ['delivery-7'],
      deliveryReceipts: [{ deliveryId: 'delivery-7', graphResultHash: 'a'.repeat(64) }],
    };
    const router = require('../interactions');
    const app = createApp(router);
    const res = response();

    await dispatch(
      app,
      request({
        headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
        body: {
          logical_turn_id: 'turn-1',
          revision: 2,
          state: 'committed',
          presentation_ref: 'telegram:1:11',
          cortex_presentation: cortexPresentation,
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockAcknowledgeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ logical_turn_id: 'turn-1', revision: 2 }),
      'telegram',
      cortexPresentation,
    );
  });

  /* === VIVENTIUM START ===
   * Purpose: a Cortex receipt settles only the message it presented. A separate addition or a
   * Cortex removal never writes, deletes or accepts the turn's Main message; a promoted empty
   * answer is Main's own message and keeps Main's persistence and acceptance.
   * === VIVENTIUM END === */
  const cortexEnvelope = (messageId) => ({
    ownerId: 'server-user',
    messageId,
    parentMessageId: 'server-response',
    revision: 3,
    generation: 7,
    claimToken: 'claim-7',
    presentationLeaseToken: 'lease-7',
    deliveryIds: ['delivery-7'],
    deliveryReceipts: [{ deliveryId: 'delivery-7', graphResultHash: 'a'.repeat(64) }],
  });
  const recordedCortexReceipt = (messageId, state = 'committed') => ({
    status: 'recorded',
    acknowledgement: {
      logical_turn_id: 'turn-1',
      revision: 2,
      state,
      presentation_refs: ['telegram:1:11'],
    },
    idempotent: false,
    presentation: {
      userId: 'server-user',
      conversationId: 'server-conversation',
      responseMessageId: 'server-response',
      interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
      ...(state === 'committed' ? { cortexPresentation: cortexEnvelope(messageId) } : {}),
    },
  });
  const cortexRequest = (messageId, state = 'committed', extra = {}) =>
    request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state,
        presentation_refs: ['telegram:1:11'],
        cortex_presentation: cortexEnvelope(messageId),
        ...extra,
      },
    });
  const mainMessageWrites = () =>
    mockMessageUpdateOne.mock.calls.filter(([query]) => query?.messageId === 'server-response');

  test('a separate Cortex addition settles only its own message and Telegram mapping', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce(recordedCortexReceipt('follow-up-7'));
    mockMarkCortexTelegramPresentation.mockResolvedValueOnce([
      { deliveryId: 'delivery-7', claimGeneration: 7 },
    ]);
    const router = require('../interactions');
    const res = response();

    await dispatch(createApp(router), cortexRequest('follow-up-7'), res);

    expect(res.statusCode).toBe(200);
    expect(mainMessageWrites()).toEqual([]);
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'follow-up-7' }),
      expect.anything(),
    );
    expect(mockRecordTelegramTransportReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ logicalMessageId: 'follow-up-7', telegramSentMessageIds: ['11'] }),
    );
    expect(mockCommitAcceptedMainTurnFromPresentation).not.toHaveBeenCalled();
    expect(mockScheduleExternallyAcceptedMainCompaction).not.toHaveBeenCalled();
    expect(mockMarkCortexTelegramPresentation).toHaveBeenCalledTimes(1);
  });

  test('a promoted empty answer keeps Main persistence and acceptance for its own message', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce(recordedCortexReceipt('server-response'));
    mockMarkCortexTelegramPresentation.mockResolvedValueOnce([
      { deliveryId: 'delivery-7', claimGeneration: 7 },
    ]);
    const router = require('../interactions');
    const res = response();

    await dispatch(createApp(router), cortexRequest('server-response'), res);

    expect(res.statusCode).toBe(200);
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'server-response',
        'metadata.viventium.interactionContext.logical_turn_id': 'turn-1',
      }),
      expect.anything(),
    );
    expect(mockRecordTelegramTransportReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ logicalMessageId: 'server-response' }),
    );
    expect(mockCommitAcceptedMainTurnFromPresentation).toHaveBeenCalledTimes(1);
  });

  test('a Cortex removal settles its presentation without deleting or writing Main', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce(
      recordedCortexReceipt('follow-up-7', 'partial_removed'),
    );
    const router = require('../interactions');
    const res = response();

    await dispatch(createApp(router), cortexRequest('follow-up-7', 'partial_removed'), res);

    expect(res.statusCode).toBe(200);
    expect(mockAcknowledgeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'partial_removed' }),
      'telegram',
      cortexEnvelope('follow-up-7'),
    );
    expect(mockMessageFindOneAndDelete).not.toHaveBeenCalled();
    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
    expect(mockRecordTelegramTransportReceipt).not.toHaveBeenCalled();
    expect(mockCommitAcceptedMainTurnFromPresentation).not.toHaveBeenCalled();
  });

  test('a Cortex receipt never takes Main durable-effect or stale-revision authority', async () => {
    const router = require('../interactions');
    const withEffect = response();
    await dispatch(
      createApp(router),
      cortexRequest('follow-up-7', 'committed', { effect_ref: 'effect-1' }),
      withEffect,
    );
    expect(withEffect.statusCode).toBe(400);
    expect(withEffect.body).toEqual({
      error: 'invalid_delivery_ack',
      field: 'cortex_presentation',
    });

    mockAcknowledgeDelivery.mockResolvedValueOnce({ status: 'stale_revision' });
    const stale = response();
    await dispatch(createApp(router), cortexRequest('follow-up-7'), stale);
    expect(stale.statusCode).toBe(409);
    expect(mockAcknowledgeDurableEffectDelivery).not.toHaveBeenCalled();
    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
  });
  /* === VIVENTIUM END === */

  test('rejects a partial Cortex presentation assertion before owner lookup', async () => {
    const router = require('../interactions');
    const app = createApp(router);
    const res = response();

    await dispatch(
      app,
      request({
        headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
        body: {
          logical_turn_id: 'turn-1',
          revision: 2,
          state: 'committed',
          presentation_ref: 'telegram:1:11',
          cortex_presentation: { generation: 7, claimToken: 'claim-7' },
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_delivery_ack', field: 'cortex_presentation' });
    expect(mockAcknowledgeDelivery).not.toHaveBeenCalled();
  });

  test('records bounded schedule provenance from the authenticated Telegram adapter', async () => {
    mockAcknowledgeServerCommittedTransportReceipt.mockResolvedValueOnce({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'telegram:1:11',
        presentation_refs: ['telegram:1:10', 'telegram:1:11'],
        source_kind: 'schedule_result',
        schedule_id: 'schedule-1',
        schedule_run_id: 'run-1',
      },
      transportOnly: true,
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
      },
    });
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'telegram:1:11',
        presentation_refs: ['telegram:1:10', 'telegram:1:11'],
        source_kind: 'schedule_result',
        schedule_id: 'schedule-1',
        schedule_run_id: 'run-1',
      },
    });
    const res = response();
    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockAcknowledgeServerCommittedTransportReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        source_kind: 'schedule_result',
        schedule_id: 'schedule-1',
        schedule_run_id: 'run-1',
      }),
      'telegram',
    );
    expect(mockAcknowledgeDelivery).not.toHaveBeenCalled();
    expect(mockRecordTelegramTransportReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: 'schedule_result',
        scheduleId: 'schedule-1',
        scheduleRunId: 'run-1',
        telegramSentMessageIds: ['10', '11'],
      }),
    );
  });

  test('derives adapter identity from a distinct scoped secret', async () => {
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'voice-adapter-secret' },
      body: { logical_turn_id: 'turn-1', revision: 2, state: 'committed' },
    });
    const res = response();
    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockAcknowledgeDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ logical_turn_id: 'turn-1', revision: 2 }),
      'voice',
    );
  });

  test('accepts bounded 1:N presentation references without trusting owner fields', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'telegram:1:11',
        presentation_refs: ['telegram:1:10', 'telegram:1:11'],
      },
      idempotent: false,
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
        cortexPresentation: {
          ownerId: 'server-user',
          messageId: 'server-response',
          parentMessageId: 'server-response',
          revision: 2,
          generation: 1,
          claimToken: 'claim-1',
          presentationLeaseToken: 'lease-1',
          deliveryIds: ['delivery-1'],
          deliveryReceipts: [{ deliveryId: 'delivery-1', graphResultHash: 'a'.repeat(64) }],
          boundAt: 1,
        },
      },
    });
    mockMarkCortexTelegramPresentation.mockResolvedValueOnce([
      { deliveryId: 'delivery-1', claimGeneration: 1 },
    ]);
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'telegram:1:11',
        presentation_refs: ['telegram:1:10', 'telegram:1:11'],
        userId: 'forged-user',
      },
    });
    const res = response();
    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockAcknowledgeDelivery).toHaveBeenCalledWith(
      {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'telegram:1:11',
        presentation_refs: ['telegram:1:10', 'telegram:1:11'],
      },
      'telegram',
    );
    expect(mockMarkCortexTelegramPresentation).toHaveBeenCalledWith({
      ownerId: 'server-user',
      parentMessageId: 'server-response',
      surface: 'telegram',
      persistedMessageId: 'server-response',
      messageRevision: 2,
      presentationGeneration: 1,
      presentationClaimToken: 'claim-1',
      expectedPresentationLeaseToken: 'lease-1',
      presentationRef: 'telegram:1:10|telegram:1:11',
      expectedDeliveryIds: ['delivery-1'],
      expectedDeliveryReceipts: [{ deliveryId: 'delivery-1', graphResultHash: 'a'.repeat(64) }],
    });
  });

  test('settles a Cortex Telegram acknowledgement that uses only singular presentation_ref', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'telegram:1:11',
      },
      idempotent: false,
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
        cortexPresentation: {
          ownerId: 'server-user',
          messageId: 'follow-up-7',
          parentMessageId: 'server-response',
          revision: 3,
          generation: 7,
          claimToken: 'claim-7',
          presentationLeaseToken: 'lease-7',
          deliveryIds: ['delivery-7'],
          deliveryReceipts: [{ deliveryId: 'delivery-7', graphResultHash: 'a'.repeat(64) }],
        },
      },
    });
    mockMarkCortexTelegramPresentation.mockResolvedValueOnce([
      { deliveryId: 'delivery-7', claimGeneration: 7 },
    ]);
    const router = require('../interactions');
    const app = createApp(router);
    const res = response();

    await dispatch(
      app,
      request({
        headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
        body: {
          logical_turn_id: 'turn-1',
          revision: 2,
          state: 'committed',
          presentation_ref: 'telegram:1:11',
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(mockMarkCortexTelegramPresentation).toHaveBeenCalledWith(
      expect.objectContaining({ presentationRef: 'telegram:1:11', presentationGeneration: 7 }),
    );
  });

  test.each([
    ['no presentation ref', {}],
    ['an unmatched presentation ref', { presentation_ref: 'not-a-telegram-receipt' }],
  ])('fails closed when a Cortex Telegram acknowledgement has %s', async (_name, receipt) => {
    mockAcknowledgeDelivery.mockResolvedValueOnce({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        ...receipt,
      },
      idempotent: false,
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
        cortexPresentation: {
          ownerId: 'server-user',
          messageId: 'follow-up-7',
          parentMessageId: 'server-response',
          revision: 3,
          generation: 7,
          claimToken: 'claim-7',
          presentationLeaseToken: 'lease-7',
          deliveryIds: ['delivery-7'],
          deliveryReceipts: [{ deliveryId: 'delivery-7', graphResultHash: 'a'.repeat(64) }],
        },
      },
    });
    const router = require('../interactions');
    const app = createApp(router);
    const res = response();

    await dispatch(
      app,
      request({
        headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
        body: { logical_turn_id: 'turn-1', revision: 2, state: 'committed', ...receipt },
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
    expect(mockMessageUpdateOne).not.toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'follow-up-7' }),
      expect.anything(),
    );
    expect(mockMarkCortexTelegramPresentation).not.toHaveBeenCalled();
  });

  test('binds a Telegram receipt to the exact server-held Cortex message revision and generation', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_refs: ['telegram:1:11'],
        presentation_committed_at: 1_725_000_000_200,
      },
      idempotent: false,
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
        cortexPresentation: {
          ownerId: 'server-user',
          messageId: 'follow-up-7',
          parentMessageId: 'server-response',
          revision: 3,
          generation: 7,
          claimToken: 'claim-7',
          presentationLeaseToken: 'lease-7',
          deliveryIds: ['delivery-7'],
          deliveryReceipts: [{ deliveryId: 'delivery-7', graphResultHash: 'a'.repeat(64) }],
          boundAt: 1_725_000_000_100,
        },
      },
    });
    mockMarkCortexTelegramPresentation.mockResolvedValueOnce([
      { deliveryId: 'delivery-7', claimGeneration: 7 },
    ]);
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_refs: ['telegram:1:11'],
      },
    });
    const res = response();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockMarkCortexTelegramPresentation).toHaveBeenCalledWith({
      ownerId: 'server-user',
      parentMessageId: 'server-response',
      surface: 'telegram',
      persistedMessageId: 'follow-up-7',
      messageRevision: 3,
      presentationGeneration: 7,
      presentationClaimToken: 'claim-7',
      expectedPresentationLeaseToken: 'lease-7',
      presentationRef: 'telegram:1:11',
      expectedDeliveryIds: ['delivery-7'],
      expectedDeliveryReceipts: [{ deliveryId: 'delivery-7', graphResultHash: 'a'.repeat(64) }],
    });
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ user: 'server-user', messageId: 'follow-up-7' }),
      {
        $set: {
          'metadata.viventium.deliveryAcknowledgement': expect.objectContaining({
            revision: 3,
            cortex_presentation_generation: 7,
            cortex_presentation_claim_token: 'claim-7',
          }),
        },
      },
    );
    expect(mockMessageUpdateOne.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockMarkCortexTelegramPresentation.mock.invocationCallOrder[0],
    );
  });

  test('fails one promoted-parent Telegram presentation and lets the exact retry settle once', async () => {
    const result = {
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_refs: ['telegram:1:11'],
      },
      idempotent: false,
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
        cortexPresentation: {
          ownerId: 'server-user',
          messageId: 'server-response',
          parentMessageId: 'server-response',
          revision: 3,
          generation: 7,
          claimToken: 'claim-7',
          presentationLeaseToken: 'lease-7',
          deliveryIds: ['delivery-7'],
          deliveryReceipts: [{ deliveryId: 'delivery-7', graphResultHash: 'a'.repeat(64) }],
        },
      },
    };
    mockAcknowledgeDelivery.mockResolvedValue(result);
    mockConsumeLocalQaCortexFault
      .mockResolvedValueOnce({ triggered: true, boundary: 'telegram_promoted_parent_presentation' })
      .mockResolvedValue({ triggered: false, reason: 'consumed' });
    mockMarkCortexTelegramPresentation.mockResolvedValue([
      { deliveryId: 'delivery-7', claimGeneration: 7 },
    ]);
    const router = require('../interactions');
    const app = createApp(router);
    const body = {
      logical_turn_id: 'turn-1',
      revision: 2,
      state: 'committed',
      presentation_refs: ['telegram:1:11'],
    };
    const first = response();
    const second = response();

    await dispatch(
      app,
      request({ headers: { 'x-viventium-adapter-secret': 'adapter-secret' }, body }),
      first,
    );
    await dispatch(
      app,
      request({ headers: { 'x-viventium-adapter-secret': 'adapter-secret' }, body }),
      second,
    );

    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(200);
    expect(mockConsumeLocalQaCortexFault).toHaveBeenCalledTimes(2);
    expect(mockConsumeLocalQaCortexFault).toHaveBeenNthCalledWith(1, {
      boundary: 'telegram_promoted_parent_presentation',
      ownerId: 'server-user',
      conversationId: 'server-conversation',
      parentMessageId: 'server-response',
    });
    expect(mockMarkCortexTelegramPresentationFailed).toHaveBeenCalledTimes(1);
    expect(mockMarkCortexTelegramPresentationFailed).toHaveBeenCalledWith({
      ownerId: 'server-user',
      parentMessageId: 'server-response',
      surface: 'telegram',
      reason: 'presentation_failed',
    });
    expect(mockMarkCortexTelegramPresentation).toHaveBeenCalledTimes(1);
    expect(
      mockMessageUpdateOne.mock.calls.filter(
        ([query]) => query?.['metadata.viventium.cortexPresentationGeneration'] === 7,
      ),
    ).toHaveLength(1);
  });

  test.each([
    ['write failure', () => Promise.reject(new Error('message acknowledgement unavailable'))],
    ['unmatched write', () => Promise.resolve({ matchedCount: 0, modifiedCount: 0 })],
  ])(
    'keeps Cortex Telegram delivery retryable after exact Message %s',
    async (_name, exactWrite) => {
      mockAcknowledgeDelivery.mockResolvedValueOnce({
        status: 'recorded',
        acknowledgement: {
          logical_turn_id: 'turn-1',
          revision: 2,
          state: 'committed',
          presentation_refs: ['telegram:1:11'],
        },
        idempotent: false,
        presentation: {
          userId: 'server-user',
          conversationId: 'server-conversation',
          responseMessageId: 'server-response',
          interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
          cortexPresentation: {
            ownerId: 'server-user',
            messageId: 'follow-up-7',
            parentMessageId: 'server-response',
            revision: 3,
            generation: 7,
            claimToken: 'claim-7',
            presentationLeaseToken: 'lease-7',
            deliveryIds: ['delivery-7'],
            deliveryReceipts: [{ deliveryId: 'delivery-7', graphResultHash: 'a'.repeat(64) }],
          },
        },
      });
      mockMessageUpdateOne.mockImplementation((query) =>
        query?.['metadata.viventium.cortexPresentationGeneration']
          ? exactWrite()
          : Promise.resolve({ matchedCount: 1, modifiedCount: 1 }),
      );
      mockMarkCortexTelegramPresentation.mockResolvedValueOnce([
        { deliveryId: 'delivery-7', claimGeneration: 7 },
      ]);
      const router = require('../interactions');
      const app = createApp(router);
      const req = request({
        headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
        body: {
          logical_turn_id: 'turn-1',
          revision: 2,
          state: 'committed',
          presentation_refs: ['telegram:1:11'],
        },
      });
      const res = response();

      await dispatch(app, req, res);

      expect(res.statusCode).toBe(503);
      expect(mockMarkCortexTelegramPresentation).not.toHaveBeenCalled();
    },
  );

  test('repairs a persisted exact Message acknowledgement after ledger settlement fails', async () => {
    const result = {
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_refs: ['telegram:1:11'],
      },
      idempotent: false,
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
        cortexPresentation: {
          ownerId: 'server-user',
          messageId: 'follow-up-7',
          parentMessageId: 'server-response',
          revision: 3,
          generation: 7,
          claimToken: 'claim-7',
          presentationLeaseToken: 'lease-7',
          deliveryIds: ['delivery-7'],
          deliveryReceipts: [{ deliveryId: 'delivery-7', graphResultHash: 'a'.repeat(64) }],
        },
      },
    };
    mockAcknowledgeDelivery.mockResolvedValue(result);
    mockMessageUpdateOne.mockImplementation((query) =>
      Promise.resolve({
        matchedCount: 1,
        modifiedCount: query?.['metadata.viventium.cortexPresentationGeneration'] ? 0 : 1,
      }),
    );
    mockMarkCortexTelegramPresentation
      .mockRejectedValueOnce(new Error('ledger unavailable'))
      .mockResolvedValueOnce([{ deliveryId: 'delivery-7', claimGeneration: 7 }]);
    const router = require('../interactions');
    const app = createApp(router);
    const body = {
      logical_turn_id: 'turn-1',
      revision: 2,
      state: 'committed',
      presentation_refs: ['telegram:1:11'],
    };
    const first = response();
    const second = response();

    await dispatch(
      app,
      request({ headers: { 'x-viventium-adapter-secret': 'adapter-secret' }, body }),
      first,
    );
    await dispatch(
      app,
      request({ headers: { 'x-viventium-adapter-secret': 'adapter-secret' }, body }),
      second,
    );

    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(200);
    expect(mockMarkCortexTelegramPresentation).toHaveBeenCalledTimes(2);
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'follow-up-7',
        'metadata.viventium.messageRevision': 3,
        'metadata.viventium.cortexPresentationGeneration': 7,
      }),
      expect.any(Object),
    );
  });

  test('rejects a partial same-generation Telegram ledger settlement', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_refs: ['telegram:1:11'],
      },
      idempotent: false,
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
        cortexPresentation: {
          ownerId: 'server-user',
          messageId: 'follow-up-7',
          parentMessageId: 'server-response',
          revision: 3,
          generation: 7,
          claimToken: 'claim-7',
          presentationLeaseToken: 'lease-7',
          deliveryIds: ['delivery-a', 'delivery-b'],
          deliveryReceipts: [
            { deliveryId: 'delivery-a', graphResultHash: 'a'.repeat(64) },
            { deliveryId: 'delivery-b', graphResultHash: 'b'.repeat(64) },
          ],
        },
      },
    });
    mockMessageUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockMarkCortexTelegramPresentation.mockResolvedValueOnce([
      { deliveryId: 'delivery-a', claimGeneration: 7 },
    ]);
    const router = require('../interactions');
    const app = createApp(router);
    const res = response();

    await dispatch(
      app,
      request({
        headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
        body: {
          logical_turn_id: 'turn-1',
          revision: 2,
          state: 'committed',
          presentation_refs: ['telegram:1:11'],
        },
      }),
      res,
    );

    expect(res.statusCode).toBe(503);
  });

  test.each([
    ['finished', false, false, {}, 200],
    ['unfinished', true, false, {}, 200],
    ['idempotent', false, true, {}, 200],
    ['foreign owner', false, false, { user: 'other-owner' }, 503],
    ['foreign conversation', false, false, { conversationId: 'other-conversation' }, 503],
    ['foreign response', false, false, { messageId: 'other-response' }, 503],
    [
      'foreign turn',
      false,
      false,
      { 'metadata.viventium.interactionContext.logical_turn_id': 'other-turn' },
      503,
    ],
    [
      'different revision',
      false,
      false,
      { 'metadata.viventium.interactionContext.revision': 3 },
      503,
    ],
    ['user message', false, false, { isCreatedByUser: true }, 503],
  ])(
    'Mongo committed_effect persists only the owned %s presentation',
    async (_case, unfinished, alreadySaved, changes, expectedStatus) => {
      const acknowledgement = {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed_effect',
        effect_ref: 'effect-1',
        presentation_ref: 'telegram:1:10',
        presentation_committed_at: 1725000000123,
      };
      const row = {
        _id: 'message-row',
        user: 'server-user',
        messageId: 'server-response',
        conversationId: 'server-conversation',
        isCreatedByUser: false,
        unfinished,
        'metadata.viventium.interactionContext.logical_turn_id': 'turn-1',
        'metadata.viventium.interactionContext.revision': 2,
        ...changes,
      };
      if (alreadySaved) {
        for (const [key, value] of Object.entries(acknowledgement)) {
          row[`metadata.viventium.deliveryAcknowledgement.${key}`] = value;
        }
      }
      const matches = (query) =>
        Object.entries(query).every(([key, expected]) =>
          expected?.$ne !== undefined ? row[key] !== expected.$ne : row[key] === expected,
        );
      mockMessageUpdateOne.mockImplementation(async (query) => ({
        matchedCount: alreadySaved ? 0 : Number(matches(query)),
        modifiedCount: alreadySaved ? 0 : Number(matches(query)),
      }));
      mockMessageFindOne.mockImplementation((query) => ({
        select: () => ({ lean: async () => (matches(query) ? { _id: row._id } : null) }),
      }));
      mockAcknowledgeMongoDurableEffectDelivery.mockResolvedValue({
        status: 'recorded',
        acknowledgement,
        idempotent: alreadySaved,
        presentation: {
          userId: 'server-user',
          conversationId: 'server-conversation',
          responseMessageId: 'server-response',
          interactionContext: { logical_turn_id: 'turn-1', revision: 2 },
        },
      });
      const res = response();
      await dispatch(
        createApp(require('../interactions')),
        request({
          headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
          body: { ...acknowledgement, state: 'committed' },
        }),
        res,
      );
      expect(res.statusCode).toBe(expectedStatus);
      expect(mockAcknowledgeMongoDurableEffectDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ effect_ref: 'effect-1', revision: 2 }),
        'telegram',
      );
      expect(mockMessageUpdateOne).toHaveBeenCalledWith(
        {
          user: 'server-user',
          messageId: 'server-response',
          conversationId: 'server-conversation',
          isCreatedByUser: { $ne: true },
          'metadata.viventium.interactionContext.logical_turn_id': 'turn-1',
          'metadata.viventium.interactionContext.revision': 2,
        },
        expect.objectContaining({
          $set: expect.objectContaining({
            unfinished: false,
            'metadata.viventium.deliveryAcknowledgement': acknowledgement,
          }),
        }),
      );
      expect(mockCommitAcceptedMainTurnFromPresentation).toHaveBeenCalledTimes(
        expectedStatus === 200 ? 1 : 0,
      );
      expect(mockRecordTelegramTransportReceipt).toHaveBeenCalledTimes(
        expectedStatus === 200 ? 1 : 0,
      );
      if (alreadySaved) {
        expect(mockMessageFindOne).toHaveBeenCalled();
        expect(res.body).toEqual({ acknowledged: true, idempotent: true });
      }
    },
  );

  test('End failure retains an already completed canonical answer and its background evidence', async () => {
    const result = await mockAcknowledgeDelivery();
    result.acknowledgement.state = 'failed';
    mockAcknowledgeDelivery.mockResolvedValue(result);
    const canonical = {
      text: 'Completed canonical answer.',
      unfinished: false,
      content: [
        { type: 'text', text: 'Completed canonical answer.' },
        ...[1, 2, 3].map((id) => ({
          type: 'cortex_insight',
          cortex_id: `cortex-${id}`,
          insight: `Evidence ${id}.`,
        })),
      ],
      metadata: {
        viventium: { backgroundInputs: [{ text: 'Exact accepted background evidence.' }] },
      },
    };
    const original = JSON.stringify(canonical);
    mockMessageUpdateOne.mockImplementation(async (query, update) => {
      if (query.unfinished === true) return { matchedCount: 0, modifiedCount: 0 };
      expect(query).toMatchObject({
        user: result.presentation.userId,
        messageId: result.presentation.responseMessageId,
        'metadata.viventium.interactionContext.logical_turn_id':
          result.presentation.interactionContext.logical_turn_id,
        'metadata.viventium.interactionContext.revision':
          result.presentation.interactionContext.revision,
      });
      expect(update.$set).toEqual({
        'metadata.viventium.deliveryAcknowledgement': result.acknowledgement,
      });
      return { matchedCount: 1, modifiedCount: 1 };
    });
    const res = response();
    await dispatch(
      createApp(require('../interactions')),
      request({
        headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
        body: { logical_turn_id: 'turn-1', revision: 2, state: 'failed' },
      }),
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(canonical)).toBe(original);
    expect(mockMessageFindOneAndDelete).not.toHaveBeenCalled();
    expect(mockCommitAcceptedMainTurnFromPresentation).not.toHaveBeenCalled();
    expect(mockRefreshVoiceTaskCommittedPresentation).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'a failed receipt retains canonical completion state: %s',
    async (unfinished) => {
      const result = await mockAcknowledgeDelivery();
      result.acknowledgement.state = 'failed';
      mockAcknowledgeDelivery.mockResolvedValue(result);
      mockMessageUpdateOne.mockImplementation(async (query) => ({
        matchedCount: Number(query.unfinished === undefined),
        modifiedCount: Number(query.unfinished === undefined),
      }));
      const res = response();
      await dispatch(
        createApp(require('../interactions')),
        request({
          headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
          body: { logical_turn_id: 'turn-1', revision: 2, state: 'failed' },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(mockMessageUpdateOne.mock.calls[0][0]).not.toHaveProperty('unfinished');
      expect(mockMessageUpdateOne.mock.calls[0][1].$set).not.toHaveProperty('unfinished');
      expect(mockCommitAcceptedMainTurnFromPresentation).not.toHaveBeenCalled();
      expect(mockAcknowledgeMongoDurableEffectDelivery).not.toHaveBeenCalled();
    },
  );

  test('lets the manager-owned exact receipt authorize an older durable presentation', async () => {
    const presentation = {
      userId: 'server-user',
      conversationId: 'server-conversation',
      responseMessageId: 'server-response-old',
      interactionContext: {
        logical_turn_id: 'turn-1',
        revision: 1,
        source_event_id: 'source-1',
      },
    };
    mockAcknowledgeDelivery.mockResolvedValueOnce({
      status: 'stale_revision',
      ownerStreamId: 'stream-old',
      presentation,
    });
    mockHasAcceptedGlassHiveLaunchForPresentation.mockResolvedValueOnce(false);
    mockAcknowledgeDurableEffectDelivery.mockResolvedValueOnce({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 1,
        state: 'committed_effect',
        presentation_ref: 'telegram:1:10',
      },
      idempotent: false,
      presentation,
    });

    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: {
        logical_turn_id: 'turn-1',
        revision: 1,
        state: 'committed',
        presentation_ref: 'telegram:1:10',
      },
    });
    const res = response();
    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockHasAcceptedGlassHiveLaunchForPresentation).not.toHaveBeenCalled();
    expect(mockAcknowledgeDurableEffectDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        logical_turn_id: 'turn-1',
        revision: 1,
        state: 'committed',
      }),
      'telegram',
    );
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'server-response-old' }),
      expect.objectContaining({
        $set: expect.objectContaining({ unfinished: false }),
      }),
    );
    expect(mockRecordTelegramTransportReceipt).toHaveBeenCalledWith({
      sourceKind: 'assistant_message',
      userId: 'server-user',
      conversationId: 'server-conversation',
      logicalMessageId: 'server-response-old',
      telegramChatId: '1',
      telegramSentMessageIds: ['10'],
      scheduleId: '',
      scheduleRunId: '',
    });
  });

  test('keeps rejecting an older ordinary answer when the manager has no durable receipt', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce({
      status: 'stale_revision',
      ownerStreamId: 'stream-old',
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'server-response-old',
        interactionContext: {
          logical_turn_id: 'turn-1',
          revision: 1,
          source_event_id: 'source-ordinary',
        },
      },
    });
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: { logical_turn_id: 'turn-1', revision: 1, state: 'committed' },
    });
    const res = response();
    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(mockAcknowledgeDurableEffectDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ logical_turn_id: 'turn-1', revision: 1, state: 'committed' }),
      'telegram',
    );
  });

  test('never turns stale source-order prose into a durable-work presentation fallback', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce({ status: 'stale_source_order' });
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: { logical_turn_id: 'turn-1', revision: 1, state: 'committed' },
    });
    const res = response();

    await dispatch(app, req, res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ acknowledged: false, error: 'stale_source_order' });
    expect(mockAcknowledgeDurableEffectDelivery).not.toHaveBeenCalled();
  });

  test('fails closed when two adapter surfaces share one credential', async () => {
    process.env.VIVENTIUM_VOICE_INTERACTION_ADAPTER_SECRET = 'adapter-secret';
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: { logical_turn_id: 'turn-1', revision: 2, state: 'committed' },
    });
    const res = response();
    await dispatch(app, req, res);

    expect(res.statusCode).toBe(401);
    expect(mockAcknowledgeDelivery).not.toHaveBeenCalled();
  });

  test('removes only the server-owned unfinished revision after partial_removed', async () => {
    mockMessageFindOneAndDelete.mockResolvedValueOnce({ _id: 'mongo-message-id' });
    mockAcknowledgeDelivery.mockResolvedValueOnce({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 1,
        state: 'partial_removed',
      },
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'old-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 1 },
      },
    });
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: { logical_turn_id: 'turn-1', revision: 1, state: 'partial_removed' },
    });
    const res = response();
    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockMessageFindOneAndDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        user: 'server-user',
        messageId: 'old-response',
        unfinished: true,
        'metadata.viventium.interactionContext.logical_turn_id': 'turn-1',
        'metadata.viventium.interactionContext.revision': 1,
      }),
    );
    expect(mockConversationUpdateOne).toHaveBeenCalledWith(
      { user: 'server-user', conversationId: 'server-conversation' },
      { $pull: { messages: 'mongo-message-id' } },
    );
    expect(mockMessageUpdateOne).not.toHaveBeenCalled();
  });

  test('records failed delivery truthfully without making provisional output visible', async () => {
    mockAcknowledgeDelivery.mockResolvedValueOnce({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 1,
        state: 'failed',
      },
      presentation: {
        userId: 'server-user',
        conversationId: 'server-conversation',
        responseMessageId: 'failed-response',
        interactionContext: { logical_turn_id: 'turn-1', revision: 1 },
      },
    });
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: { logical_turn_id: 'turn-1', revision: 1, state: 'failed' },
    });
    const res = response();
    await dispatch(app, req, res);

    expect(res.statusCode).toBe(200);
    expect(mockMessageUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'failed-response' }),
      {
        $set: {
          'metadata.viventium.deliveryAcknowledgement': {
            logical_turn_id: 'turn-1',
            revision: 1,
            state: 'failed',
          },
        },
      },
    );
    expect(mockMessageFindOneAndDelete).not.toHaveBeenCalled();
  });

  test.each([
    [{ logical_turn_id: '', revision: 1, state: 'committed' }, 'logical_turn_id'],
    [{ logical_turn_id: 'turn-1', revision: 0, state: 'committed' }, 'revision'],
    [{ logical_turn_id: 'turn-1', revision: 1, state: 'sent' }, 'state'],
    [
      {
        logical_turn_id: 'turn-1',
        revision: 1,
        state: 'committed',
        presentation_ref: 'x'.repeat(161),
      },
      'presentation_ref',
    ],
    [
      {
        logical_turn_id: 'turn-1',
        revision: 1,
        state: 'committed',
        source_kind: 'assistant_message',
        schedule_id: 'schedule-1',
      },
      'source_kind',
    ],
  ])('rejects invalid acknowledgement field %s', async (body, field) => {
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body,
    });
    const res = response();
    await dispatch(app, req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_delivery_ack', field });
    expect(mockAcknowledgeDelivery).not.toHaveBeenCalled();
  });

  test.each([
    ['not_found', 404],
    ['retryable_conflict', 503],
    ['stale_revision', 409],
    ['stale_source_order', 409],
    ['conflict', 409],
  ])('maps store result %s without claiming success', async (status, expectedStatus) => {
    mockAcknowledgeDelivery.mockResolvedValueOnce({ status });
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: { logical_turn_id: 'turn-1', revision: 2, state: 'failed' },
    });
    const res = response();
    await dispatch(app, req, res);
    expect(res.statusCode).toBe(expectedStatus);
    expect(res.body).toEqual({ acknowledged: false, error: status });
  });

  test('reports persistence failure without leaking the acknowledgement or credential', async () => {
    mockAcknowledgeDelivery.mockRejectedValueOnce(new Error('private backend detail'));
    const router = require('../interactions');
    const app = createApp(router);
    const req = request({
      headers: { 'x-viventium-adapter-secret': 'adapter-secret' },
      body: { logical_turn_id: 'turn-1', revision: 2, state: 'failed' },
    });
    const res = response();
    await dispatch(app, req, res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({ acknowledged: false, error: 'persistence_unavailable' });
    expect(JSON.stringify(res.body)).not.toContain('private backend detail');
    expect(JSON.stringify(res.body)).not.toContain('adapter-secret');
  });

  describe('Native producer retention after speech removal', () => {
    function matches(row, query) {
      if (!row) return false;
      return Object.entries(query).every(([key, expected]) => {
        if (key === '$nor') return !expected.some((filter) => matches(row, filter));
        const actual = key.split('.').reduce((value, part) => value?.[part], row);
        if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
          if ('$ne' in expected) return actual !== expected.$ne;
          if ('$nin' in expected) return !expected.$nin.includes(actual);
          if ('$in' in expected) return expected.$in.includes(actual);
          if ('$gt' in expected) return actual > expected.$gt;
        }
        return expected === null ? actual == null : actual === expected;
      });
    }

    function setupRow(status = 'pending', overrides = {}) {
      let row = {
        _id: 'mongo-native-id',
        user: 'server-user',
        conversationId: 'server-conversation',
        messageId: 'native-response',
        isCreatedByUser: false,
        unfinished: true,
        deletedAt: null,
        text: '',
        content: [],
        metadata: { viventium: { interactionContext: { logical_turn_id: 'turn-1', revision: 1 } } },
        ...(status == null
          ? {}
          : {
              nativeResponse: {
                userId: 'server-user',
                conversationId: 'server-conversation',
                responseMessageId: 'native-response',
                streamId: 'native-stream',
                jobCreatedAt: 100,
                logicalTurnId: 'turn-1',
                revision: 1,
                invocationId: 'native-invocation',
                bodySha256: 'body-sha',
                status,
              },
            }),
        ...overrides,
      };
      const identity = row.nativeResponse;
      mockMessageFindOneAndDelete.mockImplementation(async (query) => {
        if (!matches(row, query)) return null;
        const removed = row;
        row = null;
        return removed;
      });
      const model = {
        findOne(query) {
          return {
            select: () => ({
              lean: async () => (matches(row, query) ? structuredClone(row) : null),
            }),
          };
        },
        async findOneAndUpdate(query, update) {
          if (!matches(row, query)) return null;
          row = { ...row, ...structuredClone(update.$set) };
          return { toObject: () => structuredClone(row) };
        },
      };
      // Exercise the installed canonical Native snapshot method after the actual route ACK.
      const { createNativeResponseMethods } = jest.requireActual('@librechat/data-schemas');
      const writer = createNativeResponseMethods({ model: () => model });
      mockAcknowledgeDelivery.mockResolvedValue({
        status: 'recorded',
        ownerStreamId: 'native-stream',
        acknowledgement: { logical_turn_id: 'turn-1', revision: 1, state: 'partial_removed' },
        presentation: {
          userId: 'server-user',
          conversationId: 'server-conversation',
          responseMessageId: 'native-response',
          interactionContext: { logical_turn_id: 'turn-1', revision: 1 },
        },
      });
      return { getRow: () => row, writer, identity };
    }

    async function removeSpeech() {
      const router = require('../interactions');
      const res = response();
      await dispatch(
        createApp(router),
        request({
          headers: { 'x-viventium-adapter-secret': 'voice-adapter-secret' },
          body: { logical_turn_id: 'turn-1', revision: 1, state: 'partial_removed' },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(res.body.acknowledged).toBe(true);
      expect(mockCommitAcceptedMainTurnFromPresentation).not.toHaveBeenCalled();
      expect(mockScheduleExternallyAcceptedMainCompaction).not.toHaveBeenCalled();
      expect(mockRefreshVoiceTaskCommittedPresentation).not.toHaveBeenCalled();
      return res;
    }

    test.each(['pending', 'prepared'])(
      'retains %s Native admission and permits canonical snapshots after End speech removal',
      async (status) => {
        const fixture = setupRow(status);
        await removeSpeech();
        expect(fixture.getRow()).not.toBeNull();
        expect(fixture.getRow().nativeResponse.status).toBe(status);
        await expect(
          fixture.writer.saveNativeResponseSnapshot(
            'server-user',
            {
              messageId: 'native-response',
              unfinished: true,
              content: [{ type: 'text', text: 'progress' }],
            },
            fixture.identity,
          ),
        ).resolves.toEqual(
          expect.objectContaining({ messageId: 'native-response', unfinished: true }),
        );
        expect(mockConversationUpdateOne).not.toHaveBeenCalled();
        expect(mockMessageUpdateOne).not.toHaveBeenCalled();
      },
    );

    test('duplicate partial removal does not destroy or commit the pending Native producer', async () => {
      const fixture = setupRow();
      await removeSpeech();
      await removeSpeech();
      expect(fixture.getRow()?.nativeResponse.status).toBe('pending');
      expect(mockConversationUpdateOne).not.toHaveBeenCalled();
    });

    test.each(['cancelled', 'failed', 'unsupported', null])(
      'keeps existing cleanup for %s terminal or ordinary unfinished output',
      async (status) => {
        const fixture = setupRow(status);
        await removeSpeech();
        expect(fixture.getRow()).toBeNull();
        expect(mockConversationUpdateOne).toHaveBeenCalledTimes(1);
      },
    );

    test('does not remove a finished Native answer or resurrect a genuinely deleted answer', async () => {
      const fixture = setupRow('completed', {
        unfinished: false,
        text: 'Completed answer.',
        attachments: [{ type: 'file', file_id: 'native-file' }],
      });
      await removeSpeech();
      expect(fixture.getRow()?.unfinished).toBe(false);
      expect(fixture.getRow()?.attachments).toEqual([{ type: 'file', file_id: 'native-file' }]);
      expect(mockConversationUpdateOne).not.toHaveBeenCalled();
      await expect(
        fixture.writer.saveNativeResponseSnapshot(
          'server-user',
          {
            messageId: 'native-response',
            unfinished: true,
            text: 'Late partial',
          },
          fixture.identity,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          unfinished: false,
          text: 'Completed answer.',
          attachments: [{ type: 'file', file_id: 'native-file' }],
        }),
      );
      mockMessageFindOneAndDelete.mockImplementation(async () => null);
      const { createNativeResponseMethods } = jest.requireActual('@librechat/data-schemas');
      const deletedWriter = createNativeResponseMethods({
        model: () => ({
          findOne: () => ({ select: () => ({ lean: async () => null }) }),
        }),
      });
      await expect(
        deletedWriter.saveNativeResponseSnapshot(
          'server-user',
          {
            messageId: 'native-response',
            unfinished: true,
          },
          fixture.identity,
        ),
      ).rejects.toThrow('native_response_message_deleted');
    });

    test('retains existing removal for inconsistent completed admission still marked unfinished', async () => {
      // Canonical materialization atomically writes completed plus unfinished:false.
      // This synthetic violation documents the narrow predicate, not a reachable product state.
      const fixture = setupRow('completed', {
        attachments: [{ type: 'file', file_id: 'native-file' }],
      });
      await removeSpeech();
      expect(fixture.getRow()).toBeNull();
    });

    test.each([
      { user: 'another-user' },
      { conversationId: 'another-conversation' },
      { messageId: 'another-response' },
      { isCreatedByUser: true },
      {
        metadata: {
          viventium: { interactionContext: { logical_turn_id: 'another-turn', revision: 1 } },
        },
      },
      {
        metadata: { viventium: { interactionContext: { logical_turn_id: 'turn-1', revision: 2 } } },
      },
    ])('retains exact owner and revision fences: %j', async (overrides) => {
      const fixture = setupRow(null, overrides);
      await removeSpeech();
      expect(fixture.getRow()).not.toBeNull();
      expect(mockConversationUpdateOne).not.toHaveBeenCalled();
    });

    test('retains the exact live producer placeholder before Native admission', async () => {
      const fixture = setupRow(null);
      const result = await mockAcknowledgeDelivery();
      result.presentation.producerPending = true;
      mockAcknowledgeDelivery.mockClear();
      await removeSpeech();
      expect(fixture.getRow()).not.toBeNull();
      expect(fixture.getRow().nativeResponse).toBeUndefined();
      expect(mockMessageFindOneAndDelete).not.toHaveBeenCalled();
      expect(mockConversationUpdateOne).not.toHaveBeenCalled();
      await removeSpeech();
      expect(fixture.getRow()).not.toBeNull();
      expect(mockMessageFindOneAndDelete).not.toHaveBeenCalled();
    });

    test.each([false, undefined])(
      'cleans an ordinary placeholder without proven producer liveness: %s',
      async (pending) => {
        const fixture = setupRow(null);
        const result = await mockAcknowledgeDelivery();
        result.presentation.producerPending = pending;
        mockAcknowledgeDelivery.mockClear();
        await removeSpeech();
        expect(fixture.getRow()).toBeNull();
      },
    );

    test('does not accept producer liveness from the adapter request', async () => {
      const fixture = setupRow(null);
      const router = require('../interactions');
      const res = response();
      await dispatch(
        createApp(router),
        request({
          headers: { 'x-viventium-adapter-secret': 'voice-adapter-secret' },
          body: {
            logical_turn_id: 'turn-1',
            revision: 1,
            state: 'partial_removed',
            producerPending: true,
          },
        }),
        res,
      );
      expect(res.statusCode).toBe(200);
      expect(fixture.getRow()).toBeNull();
    });

    test('retains the canonical cancelled Stop snapshot during FINAL publication and duplicate removal', async () => {
      const fixture = setupRow('cancelled');
      fixture.getRow().nativeResponse.stopSnapshotStoredAt = 123;
      await removeSpeech();
      await removeSpeech();
      expect(fixture.getRow()?.nativeResponse).toMatchObject({
        status: 'cancelled',
        stopSnapshotStoredAt: 123,
      });
      expect(mockConversationUpdateOne).not.toHaveBeenCalled();
      expect(mockCommitAcceptedMainTurnFromPresentation).not.toHaveBeenCalled();
    });

    test.each([0, -1, null])(
      'does not retain arbitrary cancellation with invalid Stop timestamp %s',
      async (storedAt) => {
        const fixture = setupRow('cancelled');
        fixture.getRow().nativeResponse.stopSnapshotStoredAt = storedAt;
        await removeSpeech();
        expect(fixture.getRow()).toBeNull();
      },
    );

    test('a failed admission cannot claim canonical Stop retention through its timestamp', async () => {
      const fixture = setupRow('failed');
      fixture.getRow().nativeResponse.stopSnapshotStoredAt = 123;
      await removeSpeech();
      expect(fixture.getRow()).toBeNull();
    });
  });
});
