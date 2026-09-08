/* === VIVENTIUM START === Title recovery preserves owner-scoped persisted renames. === */
const mongoose = require('mongoose');
const express = require('express');
const request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  sleep: jest.fn(),
}));
jest.mock('~/models/Message', () => ({ getMessages: jest.fn() }));
jest.mock('~/models', () => ({
  saveConvo: (...args) => require('~/models/Conversation').saveConvo(...args),
}));
jest.mock('~/models/ToolCall', () => ({}));
jest.mock('~/server/services/viventium/conversationRecallService', () => ({}));
jest.mock('~/cache/getLogStores', () => jest.fn());
jest.mock('~/server/middleware/requireJwtAuth', () => (_req, _res, next) => next());
jest.mock('~/server/middleware', () => ({
  validateConvoAccess: (_req, _res, next) => next(),
  configMiddleware: (_req, _res, next) => next(),
  createImportLimiters: () => ({
    importIpLimiter: (_req, _res, next) => next(),
    importUserLimiter: (_req, _res, next) => next(),
  }),
  createForkLimiters: () => ({
    forkIpLimiter: (_req, _res, next) => next(),
    forkUserLimiter: (_req, _res, next) => next(),
  }),
}));
jest.mock('~/server/utils/import/fork', () => ({}));
jest.mock('~/server/utils/import', () => ({}));
jest.mock('~/server/routes/files/multer', () => ({}));
jest.mock('multer', () => () => ({ single: () => (_req, _res, next) => next() }));
jest.mock('~/server/services/Endpoints/azureAssistants', () => ({}));
jest.mock('~/server/services/Endpoints/assistants', () => ({}));
jest.mock('~/server/services/viventium/interactionContext', () => ({
  getTrustedInteractionContext: () => null,
}));
jest.mock('~/server/services/viventium/VoiceOrchestrationTraceService', () => ({}));

const { Conversation } = require('~/db/models');
const { getMessages } = require('~/models/Message');
const getLogStores = require('~/cache/getLogStores');
const addTitle = require('~/server/services/Endpoints/agents/title');
const owner = new mongoose.Types.ObjectId().toString();
const otherOwner = new mongoose.Types.ObjectId().toString();
let server;
let app;
let titleCache;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  await Conversation.init();
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: owner };
    next();
  });
  app.use('/api/convos', require('../convos'));
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
beforeEach(async () => {
  await Conversation.deleteMany({});
  getMessages.mockReset().mockResolvedValue([]);
  titleCache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  getLogStores.mockReturnValue(titleCache);
});

test('a rename confirmed while fallback messages are held survives the pending title request', async () => {
  const conversationId = 'held-fallback';
  await Conversation.create({ user: owner, conversationId, title: 'New Chat', endpoint: 'agents' });
  let release;
  let entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  getMessages.mockImplementationOnce(async () => {
    entered();
    await held;
    return [{ text: 'Original question for fallback', isCreatedByUser: true }];
  });
  const pending = request(app)
    .get(`/api/convos/gen_title/${conversationId}`)
    .then((res) => res);
  await started;
  const rename = await request(app)
    .post('/api/convos/update')
    .send({
      arg: { conversationId, title: 'User chosen title' },
    });
  release();
  const response = await pending;
  expect(rename.status).toBe(201);
  expect(rename.body.title).toBe('User chosen title');
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ title: 'User chosen title' });
  expect(await Conversation.findOne({ user: owner, conversationId }).lean()).toMatchObject({
    title: 'User chosen title',
  });
});

test('fallback updates only the title and preserves temporary retention', async () => {
  const conversationId = 'temporary-fallback';
  const expiredAt = new Date(Date.now() + 3_600_000);
  await Conversation.create({
    user: owner,
    conversationId,
    title: 'New Chat',
    endpoint: 'agents',
    expiredAt,
  });
  getMessages.mockResolvedValueOnce([{ text: 'Original question', isCreatedByUser: true }]);
  const response = await request(app).get(`/api/convos/gen_title/${conversationId}`);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({ title: 'Original question' });
  expect(await Conversation.findOne({ user: owner, conversationId }).lean()).toMatchObject({
    title: 'Original question',
    expiredAt,
  });
});

test.each(['missing', 'foreign'])(
  'title recovery never creates or changes a %s conversation',
  async (conversationId) => {
    if (conversationId === 'foreign') {
      await Conversation.create({
        user: otherOwner,
        conversationId,
        title: 'Foreign title',
        endpoint: 'agents',
      });
    }
    getMessages.mockResolvedValue([{ text: 'Unowned fallback', isCreatedByUser: true }]);
    const response = await request(app).get(`/api/convos/gen_title/${conversationId}`);
    expect(response.status).toBe(404);
    expect(await Conversation.findOne({ user: owner, conversationId }).lean()).toBeNull();
    expect(await Conversation.countDocuments()).toBe(conversationId === 'foreign' ? 1 : 0);
    if (conversationId === 'foreign') {
      expect(await Conversation.findOne({ user: otherOwner, conversationId }).lean()).toMatchObject(
        {
          title: 'Foreign title',
        },
      );
    }
  },
);

test.each(['missing', 'foreign', 'deleted'])(
  'explicit rename does not create or change a %s target',
  async (kind) => {
    const conversationId = `rename-${kind}`;
    if (kind !== 'missing') {
      await Conversation.create({
        user: kind === 'foreign' ? otherOwner : owner,
        conversationId,
        title: 'Existing title',
        endpoint: 'agents',
      });
    }
    if (kind === 'deleted') {
      await Conversation.deleteOne({ user: owner, conversationId });
    }
    const response = await request(app)
      .post('/api/convos/update')
      .send({
        arg: { conversationId, title: 'New Chat' },
      });
    expect(response.status).toBe(404);
    expect(await Conversation.findOne({ user: owner, conversationId }).lean()).toBeNull();
    expect(await Conversation.countDocuments()).toBe(kind === 'foreign' ? 1 : 0);
    if (kind === 'foreign') {
      expect(await Conversation.findOne({ user: otherOwner, conversationId }).lean()).toMatchObject(
        { title: 'Existing title' },
      );
    }
  },
);

test('ordinary client conversation saves preserve the hidden manual-title marker', async () => {
  const conversationId = 'rename-then-client-save';
  await Conversation.create({ user: owner, conversationId, title: 'New Chat', endpoint: 'agents' });
  const rename = await request(app)
    .post('/api/convos/update')
    .send({
      arg: { conversationId, title: 'New Chat' },
    });
  expect(rename.status).toBe(201);
  await require('~/models/Conversation').saveConvo(
    { user: { id: owner }, body: {} },
    { conversationId, model: 'new-model', titleSetByUser: false },
    { unsetFields: { titleSetByUser: 1, temperature: 1 } },
  );
  expect(
    await Conversation.findOne({ user: owner, conversationId }).select('+titleSetByUser').lean(),
  ).toMatchObject({ title: 'New Chat', titleSetByUser: true, model: 'new-model' });
  titleCache.get.mockResolvedValueOnce('Older generated title');
  const reloaded = await request(app).get(`/api/convos/gen_title/${conversationId}`);
  expect(reloaded.status).toBe(200);
  expect(reloaded.body).toEqual({ title: 'New Chat' });
});

describe.each([
  { mode: 'generated', result: 'Model title', expected: 'Model title' },
  { mode: 'empty', result: undefined, expected: 'Question for title' },
  { mode: 'rejected', result: undefined, expected: 'Question for title' },
])('addTitle $mode result', ({ mode, result, expected }) => {
  function startTitle(conversationId) {
    let settle;
    const titleConvo = jest.fn(
      () =>
        new Promise((resolve, reject) => {
          settle = () =>
            mode === 'rejected' ? reject(new Error('Provider failed')) : resolve(result);
        }),
    );
    const running = addTitle(
      { user: { id: owner }, body: {} },
      {
        text: 'Question for title',
        response: { conversationId },
        client: { options: {}, titleConvo },
      },
    );
    return { running, settle: () => settle() };
  }

  test('persists the selected title without clearing retention', async () => {
    const conversationId = `normal-${mode}`;
    const expiredAt = new Date(Date.now() + 3_600_000);
    await Conversation.create({
      user: owner,
      conversationId,
      title: 'New Chat',
      endpoint: 'agents',
      expiredAt,
    });
    const pending = startTitle(conversationId);
    pending.settle();
    await pending.running;
    expect(await Conversation.findOne({ user: owner, conversationId }).lean()).toMatchObject({
      title: expected,
      expiredAt,
    });
    expect(titleCache.set).toHaveBeenCalledWith(`${owner}-${conversationId}`, expected, 120000);
  });

  test.each([
    { title: 'New Chat', timing: 'before' },
    { title: 'New Chat', timing: 'during' },
    { title: 'User chosen title', timing: 'before' },
    { title: 'User chosen title', timing: 'during' },
  ])('preserves an explicit $title rename $timing generation', async ({ title, timing }) => {
    const conversationId = `renamed-${mode}-${timing}`;
    const expiredAt = new Date(Date.now() + 3_600_000);
    await Conversation.create({
      user: owner,
      conversationId,
      title: 'New Chat',
      endpoint: 'agents',
      expiredAt,
    });
    let pending = timing === 'during' ? startTitle(conversationId) : null;
    const rename = await request(app).post('/api/convos/update').send({
      arg: { conversationId, title },
    });
    pending ??= startTitle(conversationId);
    pending.settle();
    await pending.running;
    expect(rename.status).toBe(201);
    expect(
      await Conversation.findOne({ user: owner, conversationId }).select('+titleSetByUser').lean(),
    ).toMatchObject({ title, titleSetByUser: true, expiredAt });
    expect(await Conversation.findOne({ user: owner, conversationId }).lean()).not.toHaveProperty(
      'titleSetByUser',
    );
    expect(titleCache.set).toHaveBeenCalledWith(`${owner}-${conversationId}`, title, 120000);
    titleCache.get.mockResolvedValueOnce('Older generated title');
    const reloaded = await request(app).get(`/api/convos/gen_title/${conversationId}`);
    expect(reloaded.status).toBe(200);
    expect(reloaded.body).toEqual({ title });
  });

  test('does not recreate a conversation deleted during generation', async () => {
    const conversationId = `deleted-${mode}`;
    await Conversation.create({
      user: owner,
      conversationId,
      title: 'New Chat',
      endpoint: 'agents',
    });
    const pending = startTitle(conversationId);
    await Conversation.deleteOne({ user: owner, conversationId });
    pending.settle();
    await pending.running;
    expect(await Conversation.findOne({ conversationId }).lean()).toBeNull();
    expect(titleCache.set).not.toHaveBeenCalled();
  });

  test('does not change or create another owner conversation', async () => {
    const conversationId = `foreign-${mode}`;
    await Conversation.create({
      user: otherOwner,
      conversationId,
      title: 'Foreign title',
      endpoint: 'agents',
    });
    const pending = startTitle(conversationId);
    pending.settle();
    await pending.running;
    expect(await Conversation.findOne({ user: owner, conversationId }).lean()).toBeNull();
    expect(await Conversation.findOne({ user: otherOwner, conversationId }).lean()).toMatchObject({
      title: 'Foreign title',
    });
    expect(titleCache.set).not.toHaveBeenCalled();
  });
});
/* === VIVENTIUM END === */
