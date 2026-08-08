const express = require('express');
const request = require('supertest');

const RAW_PERSONAL_KEY = 'synthetic-route-personal-key-never-return';
const mockGetUserById = jest.fn();
const mockGetUserKey = jest.fn();
const mockGetUserKeyValues = jest.fn();
const mockAssertGrantActive = jest.fn();
const mockRememberBrokerRequest = jest.fn();
const mockRevokeBrokerGrant = jest.fn();
const mockLoggerInfo = jest.fn();

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
  getUserKey: (...args) => mockGetUserKey(...args),
  getUserKeyValues: (...args) => mockGetUserKeyValues(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: (...args) => mockLoggerInfo(...args) },
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityBrokerAuth', () => ({
  assertBrokerGrantActive: (...args) => mockAssertGrantActive(...args),
  rememberBrokerRequest: (...args) => mockRememberBrokerRequest(...args),
  resolveBrokerTenantId: () => 'tenant-a',
  revokeBrokerGrant: (...args) => mockRevokeBrokerGrant(...args),
}));

function appWithRoute() {
  const app = express();
  app.use(express.json());
  app.use('/api/viventium/glasshive/inference', require('../glasshiveInference'));
  return app;
}

describe('GlassHive inference route adapter', () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      VIVENTIUM_GLASSHIVE_INFERENCE_BROKER_SECRET: 'synthetic-route-secret-with-at-least-32-bytes',
      VIVENTIUM_GLASSHIVE_INFERENCE_PROXY_URL:
        'https://librechat.example.test/api/viventium/glasshive/inference',
    };
    mockGetUserById.mockResolvedValue({ _id: 'user-a' });
    mockGetUserKey.mockResolvedValue('personal_preferred');
    mockGetUserKeyValues.mockResolvedValue({ apiKey: RAW_PERSONAL_KEY });
    mockAssertGrantActive.mockResolvedValue({ active: true });
    mockRememberBrokerRequest.mockResolvedValue({ accepted: true, remaining: 4 });
    mockRevokeBrokerGrant.mockResolvedValue({ revoked: true });
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'chatcmpl_route_synthetic', choices: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_route' },
      }),
    );
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  test('wires encrypted user-key ownership into a redacted run-bound proxy', async () => {
    const { mintInferenceIssuerAssertion } = require('@librechat/api');
    const issuer = mintInferenceIssuerAssertion({
      secret: process.env.VIVENTIUM_GLASSHIVE_INFERENCE_BROKER_SECRET,
      tenantId: 'tenant-a',
      userId: 'user-a',
      workerId: 'worker-a',
      runId: 'run-a',
      provider: 'openai',
      route: 'personal_api_key',
      adapter: 'openai_chat_completions_v1',
      models: ['gpt-4.1-mini'],
      action: 'issue',
    });

    const issuedResponse = await request(appWithRoute())
      .post('/api/viventium/glasshive/inference/grants')
      .set('Authorization', `Bearer ${issuer.token}`)
      .expect(201);

    expect(JSON.stringify(issuedResponse.body)).not.toContain(RAW_PERSONAL_KEY);

    const proxiedResponse = await request(appWithRoute())
      .post('/api/viventium/glasshive/inference/openai/v1/chat/completions')
      .set('Authorization', `Bearer ${issuedResponse.body.grantToken}`)
      .set('X-GlassHive-Worker-Id', 'worker-a')
      .set('X-GlassHive-Run-Id', 'run-a')
      .send({
        model: 'gpt-4.1-mini',
        messages: [{ role: 'user', content: 'Synthetic route request' }],
      })
      .expect(200);

    expect(proxiedResponse.body.id).toBe('chatcmpl_route_synthetic');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        redirect: 'manual',
        headers: expect.objectContaining({ Authorization: `Bearer ${RAW_PERSONAL_KEY}` }),
      }),
    );
    expect(JSON.stringify(mockLoggerInfo.mock.calls)).not.toContain(RAW_PERSONAL_KEY);
    expect(mockGetUserKeyValues).toHaveBeenCalledTimes(2);
  });

  test('wires the fixed Responses API adapter without exposing routing or credential overrides', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_route_synthetic', output: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req_responses_route' },
      }),
    );
    const { mintInferenceIssuerAssertion } = require('@librechat/api');
    const issuer = mintInferenceIssuerAssertion({
      secret: process.env.VIVENTIUM_GLASSHIVE_INFERENCE_BROKER_SECRET,
      tenantId: 'tenant-a',
      userId: 'user-a',
      workerId: 'worker-a',
      runId: 'run-a',
      provider: 'openai',
      route: 'personal_api_key',
      adapter: 'openai_responses_v1',
      models: ['gpt-4.1-mini'],
      action: 'issue',
    });
    const app = appWithRoute();

    const issuedResponse = await request(app)
      .post('/api/viventium/glasshive/inference/grants')
      .set('Authorization', `Bearer ${issuer.token}`)
      .expect(201);
    const proxiedResponse = await request(app)
      .post('/api/viventium/glasshive/inference/openai/v1/responses')
      .set('Authorization', `Bearer ${issuedResponse.body.grantToken}`)
      .set('X-GlassHive-Worker-Id', 'worker-a')
      .set('X-GlassHive-Run-Id', 'run-a')
      .send({
        model: 'gpt-4.1-mini',
        input: 'Synthetic route request',
        stream: false,
        apiKey: 'attacker-key',
        baseURL: 'http://169.254.169.254/latest/meta-data',
        headers: { Authorization: 'Bearer attacker-controlled' },
      })
      .expect(200);

    expect(proxiedResponse.body.id).toBe('resp_route_synthetic');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/responses',
      expect.objectContaining({
        redirect: 'manual',
        headers: expect.objectContaining({ Authorization: `Bearer ${RAW_PERSONAL_KEY}` }),
      }),
    );
    const [, upstreamRequest] = global.fetch.mock.calls[0];
    const upstreamBody = JSON.parse(upstreamRequest.body);
    expect(upstreamBody.apiKey).toBeUndefined();
    expect(upstreamBody.baseURL).toBeUndefined();
    expect(upstreamBody.headers).toBeUndefined();
    expect(JSON.stringify(mockLoggerInfo.mock.calls)).not.toContain(RAW_PERSONAL_KEY);
  });

  test('rejects an expired user before resolving or returning a grant', async () => {
    mockGetUserById.mockResolvedValue({
      _id: 'user-a',
      expiresAt: new Date(Date.now() - 60_000),
    });
    const { mintInferenceIssuerAssertion } = require('@librechat/api');
    const issuer = mintInferenceIssuerAssertion({
      secret: process.env.VIVENTIUM_GLASSHIVE_INFERENCE_BROKER_SECRET,
      tenantId: 'tenant-a',
      userId: 'user-a',
      workerId: 'worker-a',
      runId: 'run-a',
      provider: 'openai',
      route: 'personal_api_key',
      adapter: 'openai_chat_completions_v1',
      models: ['gpt-4.1-mini'],
      action: 'issue',
    });

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/inference/grants')
      .set('Authorization', `Bearer ${issuer.token}`)
      .expect(401);

    expect(response.body.error.code).toBe('user_unavailable');
    expect(mockGetUserKeyValues).not.toHaveBeenCalled();
  });

  test('treats a user-provided enterprise placeholder as unavailable configuration', async () => {
    process.env.OPENAI_API_KEY = 'user_provided';
    process.env.OPENAI_REVERSE_PROXY = 'https://enterprise-openai.example.test';
    mockGetUserKey.mockResolvedValue('personal_preferred');
    const { mintInferenceIssuerAssertion } = require('@librechat/api');
    const issuer = mintInferenceIssuerAssertion({
      secret: process.env.VIVENTIUM_GLASSHIVE_INFERENCE_BROKER_SECRET,
      tenantId: 'tenant-a',
      userId: 'user-a',
      workerId: 'worker-a',
      runId: 'run-a',
      provider: 'openai',
      route: 'enterprise_route',
      adapter: 'openai_chat_completions_v1',
      models: ['gpt-4.1-mini'],
      action: 'issue',
    });

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/inference/grants')
      .set('Authorization', `Bearer ${issuer.token}`)
      .expect(503);

    expect(response.body.error.code).toBe('enterprise_route_unavailable');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
