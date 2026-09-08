/* VIVENTIUM: actual route and native manager must share the exact active-stream contract. */
const express = require('express');
const request = require('supertest');
const { GenerationJobManagerClass, InMemoryJobStore, InMemoryEventTransport } =
  jest.requireActual('@librechat/api');
let mockManager;
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: () => false,
  get GenerationJobManager() {
    return mockManager;
  },
}));
jest.mock('~/models', () => ({ saveMessage: jest.fn() }));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'owner-a' };
    next();
  },
  uaParser: (_req, _res, next) => next(),
  checkBan: (_req, _res, next) => next(),
  messageIpLimiter: (_req, _res, next) => next(),
  configMiddleware: (_req, _res, next) => next(),
  messageUserLimiter: (_req, _res, next) => next(),
}));
jest.mock('~/server/routes/agents/chat', () => require('express').Router());
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());
jest.mock('~/server/routes/agents/v1', () => ({ v1: require('express').Router() }));
describe('actual agent route with native active stream owner', () => {
  let store;
  let app;
  beforeEach(async () => {
    store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    mockManager = new GenerationJobManagerClass({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      cleanupOnComplete: false,
    });
    await mockManager.initialize();
    // The actual route destructures this instance at module load.
    jest.isolateModules(() => {
      app = express();
      app.use(require('~/server/routes/agents/index'));
      app.use((error, _req, res, _next) => res.status(503).json({ error: error.message }));
    });
  });
  afterEach(async () => {
    await mockManager.destroy();
  });
  it('returns exact active stream identities from the real manager', async () => {
    await mockManager.createJob('stream-a', 'owner-a', 'conversation-a');
    await mockManager.createJob('stream-b', 'owner-a', 'conversation-a');
    await mockManager.createJob('stream-other', 'owner-b', 'conversation-other');
    const response = await request(app).get('/chat/active');
    expect(response.status).toBe(200);
    if (!Array.isArray(response.body.activeStreams))
      throw new Error('Actual route omitted activeStreams; native manager method is missing');
    expect(response.body).toEqual({
      activeJobIds: ['conversation-a'],
      activeStreams: [
        { streamId: 'stream-a', conversationId: 'conversation-a' },
        { streamId: 'stream-b', conversationId: 'conversation-a' },
      ],
    });
  });
  it('rejects a replacement owner after active-index discovery', async () => {
    await mockManager.createJob('stream-a', 'owner-a', 'conversation-a');
    const readIds = store.getActiveJobIdsByUser.bind(store);
    jest.spyOn(store, 'getActiveJobIdsByUser').mockImplementationOnce(async (userId) => {
      const ids = await readIds(userId);
      await store.createJob('stream-a', 'owner-b', 'conversation-other');
      return ids;
    });
    const response = await request(app).get('/chat/active');
    expect(response.body).toEqual({ activeJobIds: [], activeStreams: [] });
  });
  it('rejects a service generation change during an awaited job read', async () => {
    await mockManager.createJob('stream-a', 'owner-a', 'conversation-a');
    const readJob = store.getJob.bind(store);
    jest.spyOn(store, 'getJob').mockImplementationOnce(async (streamId) => {
      const job = await readJob(streamId);
      mockManager.configure({
        jobStore: new InMemoryJobStore(),
        eventTransport: new InMemoryEventTransport(),
      });
      return job;
    });
    const response = await request(app).get('/chat/active');
    expect(response.status).toBe(503);
    await store.destroy();
  });
  it('does not represent an unreadable active index as empty', async () => {
    jest
      .spyOn(store, 'getActiveJobIdsByUser')
      .mockRejectedValue(new Error('synthetic-store-unavailable'));
    const response = await request(app).get('/chat/active');
    expect(response.status).toBe(503);
    expect(response.body.activeJobIds).toBeUndefined();
  });
  it('does not represent a failed job read as empty', async () => {
    await mockManager.createJob('stream-a', 'owner-a', 'conversation-a');
    jest.spyOn(store, 'getJob').mockRejectedValue(new Error('synthetic-job-unavailable'));
    const response = await request(app).get('/chat/active');
    expect(response.status).toBe(503);
  });
  it('excludes finished and stale cross-owner entries using the actual job row', async () => {
    await mockManager.createJob('stream-a', 'owner-a', 'conversation-a');
    await mockManager.createJob('stream-other', 'owner-b', 'conversation-other');
    await store.updateJob('stream-a', { status: 'complete' });
    jest
      .spyOn(store, 'getActiveJobIdsByUser')
      .mockResolvedValue(['stream-a', 'stream-other', 'missing']);
    const response = await request(app).get('/chat/active');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ activeJobIds: [], activeStreams: [] });
  });
});
