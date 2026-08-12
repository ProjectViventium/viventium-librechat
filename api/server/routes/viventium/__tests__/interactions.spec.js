const express = require('express');

let mockAcknowledgeDelivery;
const mockMessageUpdateOne = jest.fn();
const mockMessageFindOneAndDelete = jest.fn();
const mockConversationUpdateOne = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn() },
}));

jest.mock('@librechat/api', () => ({
  GenerationJobManager: {
    acknowledgeDelivery: (...args) => mockAcknowledgeDelivery(...args),
  },
}));

jest.mock('~/db/models', () => ({
  Message: {
    updateOne: (...args) => mockMessageUpdateOne(...args),
    findOneAndDelete: (...args) => mockMessageFindOneAndDelete(...args),
  },
  Conversation: { updateOne: (...args) => mockConversationUpdateOne(...args) },
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
    mockAcknowledgeDelivery = jest.fn().mockResolvedValue({
      status: 'recorded',
      acknowledgement: {
        logical_turn_id: 'turn-1',
        revision: 2,
        state: 'committed',
        presentation_ref: 'message-1',
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
          },
        },
      },
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
    ['stale_revision', 409],
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
