/* === VIVENTIUM START ===
 * Explicit readiness must opt into native checks while model discovery remains metadata-only.
 * === VIVENTIUM END === */
const express = require('express');
const request = require('supertest');
const mockConfig = {
  endpoints: { agents: { providerCapabilities: { harness: { activity_stream: true } } } },
};
const mockEndpoint = { apiKey: 'synthetic-provider-key', baseURL: 'http://provider.test/v1' };
jest.mock('@librechat/api', () => ({
  generateCheckAccess: () => (req, res, next) => next(),
  getCustomEndpointConfig: () => mockEndpoint,
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    req.user = { id: 'synthetic-owner' };
    next();
  },
  configMiddleware: (req, res, next) => {
    req.config = mockConfig;
    next();
  },
  canAccessAgentResource: () => (req, res, next) => next(),
}));
jest.mock('~/models/Role', () => ({ getRoleByName: jest.fn() }));
jest.mock('~/server/routes/agents/actions', () => require('express').Router());
jest.mock('~/server/routes/agents/tools', () => require('express').Router());
jest.mock('~/server/controllers/agents/v1', () =>
  Object.fromEntries(
    [
      'createAgent',
      'deleteAgent',
      'duplicateAgent',
      'getAgent',
      'getAgentCategories',
      'getListAgents',
      'revertAgentVersion',
      'updateAgent',
      'uploadAgentAvatar',
    ].map((name) => [name, (req, res) => res.sendStatus(204)]),
  ),
);
const { v1 } = require('~/server/routes/agents/v1');

describe('explicit provider readiness', () => {
  const app = express();
  app.use('/api/agents', v1);
  const originalFetch = global.fetch;
  let timeout;
  beforeEach(() => {
    global.fetch = jest.fn();
    timeout = jest.spyOn(AbortSignal, 'timeout');
  });
  afterEach(() => {
    global.fetch = originalFetch;
    timeout.mockRestore();
  });

  it('requests the authenticated readiness opt-in and preserves each actual model status', async () => {
    const models = [
      { id: 'native:model', readiness: { status: 'ready', detail: 'Signed in.' } },
      {
        id: 'direct:model',
        readiness: { status: 'authentication_required', detail: 'Connect API.' },
      },
    ];
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: models }) });
    const res = await request(app).get('/api/agents/provider-readiness/harness');
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      'http://provider.test/v1/models?check_readiness=true',
      {
        headers: {
          Authorization: 'Bearer synthetic-provider-key',
          'X-Viventium-User-Id': 'synthetic-owner',
        },
        signal: expect.any(AbortSignal),
      },
    );
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(res.body.status).toBe('ready');
    expect(res.body.models.map((model) => model.readiness)).toEqual(
      models.map((model) => model.readiness),
    );
  });

  it('does not proxy an undeclared provider', async () => {
    const res = await request(app).get('/api/agents/provider-readiness/undeclared');
    expect(res.status).toBe(404);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ name: 'TimeoutError' }, 'Provider readiness check timed out.'],
    [new Error('unreachable'), 'Provider is not reachable.'],
  ])('keeps readiness failures explicit', async (error, detail) => {
    global.fetch.mockRejectedValue(error);
    const res = await request(app).get('/api/agents/provider-readiness/harness');
    expect(res.body).toEqual({ status: 'unavailable', detail, models: [] });
  });
});
