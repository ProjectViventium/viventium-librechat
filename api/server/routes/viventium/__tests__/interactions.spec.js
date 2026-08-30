const express = require('express');

let mockAcknowledgeDelivery;
let mockAcknowledgeDurableEffectDelivery;
let mockAcknowledgeServerCommittedTransportReceipt;
let mockHasAcceptedGlassHiveLaunchForPresentation;
const mockMessageUpdateOne = jest.fn();
const mockMessageFindOneAndDelete = jest.fn();
const mockConversationUpdateOne = jest.fn();
const mockRecordTelegramTransportReceipt = jest.fn();
const mockCommitAcceptedMainTurnFromPresentation = jest.fn();
const mockMarkCortexTelegramPresentation = jest.fn();
const mockMarkCortexTelegramPresentationFailed = jest.fn();
const mockConsumeLocalQaCortexFault = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
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

jest.mock('~/db/models', () => ({
  Message: {
    updateOne: (...args) => mockMessageUpdateOne(...args),
    findOneAndDelete: (...args) => mockMessageFindOneAndDelete(...args),
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
    jest.resetModules();
    mockMessageUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
    mockMessageFindOneAndDelete.mockReset().mockResolvedValue(null);
    mockConversationUpdateOne.mockReset().mockResolvedValue({ modifiedCount: 1 });
    mockRecordTelegramTransportReceipt.mockReset().mockResolvedValue({ status: 'sent' });
    mockCommitAcceptedMainTurnFromPresentation.mockReset().mockResolvedValue({
      status: 'committed',
    });
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
        unfinished: true,
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
      expect.objectContaining({ messageId: 'server-response-old', unfinished: true }),
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
      expect.objectContaining({ messageId: 'failed-response', unfinished: true }),
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
});
