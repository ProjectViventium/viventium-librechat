const express = require('express');
const request = require('supertest');

const mockVerifyBrokerGrant = jest.fn();
const mockAssertBrokerGrantActive = jest.fn();
const mockGetUserKeyValues = jest.fn();
const mockUpdateUserKey = jest.fn();
const mockResolveOpenAI = jest.fn();
const mockResolveAnthropic = jest.fn();
const mockAssertActiveCapabilityAuthorizationGrant = jest.fn();
const mockRecordOrchestrationTraceEvent = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

jest.mock('librechat-data-provider', () => ({
  EModelEndpoint: { openAI: 'openAI', anthropic: 'anthropic' },
  ErrorTypes: { NO_USER_KEY: 'no_user_key' },
}));

jest.mock('@librechat/api', () => ({
  resolveOpenAISubscriptionUserValues: (...args) => mockResolveOpenAI(...args),
  resolveAnthropicSubscriptionUserValues: (...args) => mockResolveAnthropic(...args),
}));

jest.mock('~/models', () => ({
  getUserKeyValues: (...args) => mockGetUserKeyValues(...args),
  updateUserKey: (...args) => mockUpdateUserKey(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityBrokerAuth', () => ({
  assertBrokerGrantActive: (...args) => mockAssertBrokerGrantActive(...args),
  BROKER_AUTHORITY_KINDS: { MISSION_WORKER: 'mission_worker' },
  resolveBrokerTenantId: () => 'tenant-a',
  verifyBrokerGrant: (...args) => mockVerifyBrokerGrant(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveCapabilityAuthorizationService', () => ({
  assertActiveCapabilityAuthorizationGrant: (...args) =>
    mockAssertActiveCapabilityAuthorizationGrant(...args),
}));

jest.mock('~/server/services/viventium/OrchestrationTraceLedgerService', () => ({
  recordOrchestrationTraceEvent: (...args) => mockRecordOrchestrationTraceEvent(...args),
}));

function appWithRoute() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/viventium/glasshive/providers', require('../glasshiveProvider'));
  return app;
}

describe('GlassHive run-scoped provider broker', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    global.fetch = jest.fn();
    mockVerifyBrokerGrant.mockReturnValue({
      user_id: 'owner-a',
      worker_id: 'worker-a',
      run_id: 'run-a',
      message_id: 'message-a',
      conversation_id: 'conversation-a',
      authorization_ref: 'authorization-a',
      grant_id: 'grant-a',
      container_generation_id: 'a'.repeat(64),
      authority_kind: 'mission_worker',
      execution_mode: 'docker',
    });
    mockAssertActiveCapabilityAuthorizationGrant.mockResolvedValue({
      authorizationRef: 'authorization-a',
      ownerId: 'owner-a',
      originRef: 'origin-a',
      workRef: 'work-a',
      workerId: 'worker-a',
      runId: 'run-a',
      grantId: 'grant-a',
    });
    mockAssertBrokerGrantActive.mockResolvedValue(undefined);
    mockRecordOrchestrationTraceEvent.mockResolvedValue({ accepted: true });
    mockUpdateUserKey.mockResolvedValue(undefined);
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_REVERSE_PROXY;
    delete process.env.VIVENTIUM_OPENAI_AUTH_MODE;
    delete process.env.VIVENTIUM_PRIMARY_AUTH_MODE;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test('rejects a revoked exact run grant before credential lookup', async () => {
    mockAssertActiveCapabilityAuthorizationGrant.mockRejectedValue(
      Object.assign(new Error('inactive'), { code: 'capability_grant_inactive', status: 401 }),
    );

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/auth/preflight')
      .set('Authorization', 'Bearer synthetic-revoked-run-grant')
      .send({ version: 1 });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('provider_broker_unauthorized');
    expect(mockGetUserKeyValues).not.toHaveBeenCalled();
  });

  test('preflights the exact signed owner credential without an upstream request', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'synthetic-owner-openai-token',
      baseURL: 'https://provider.example/v1',
      oauthProvider: 'openai-codex',
      oauthType: 'subscription',
    });
    mockResolveOpenAI.mockImplementation(async (_userId, values) => values);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/auth/preflight')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ version: 1 });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'authorized',
      provider: 'openai',
      workerId: 'worker-a',
      runId: 'run-a',
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('streams OpenAI through the signed owner account and records the forwarding receipt', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'synthetic-owner-openai-token',
      baseURL: 'https://provider.example/v1',
      headers: { 'chatgpt-account-id': 'synthetic-account' },
      oauthProvider: 'openai-codex',
      oauthType: 'subscription',
    });
    mockResolveOpenAI.mockImplementation(async (_userId, values) => values);
    global.fetch.mockResolvedValue(
      new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ model: 'synthetic-model', stream: true, input: [] });

    expect(response.status).toBe(200);
    expect(response.text).toContain('response.output_text.delta');
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://provider.example/v1/responses');
    expect(options.headers.Authorization).toBe('Bearer synthetic-owner-openai-token');
    expect(JSON.stringify(options)).not.toContain('synthetic-run-grant');
    expect(mockRecordOrchestrationTraceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-a',
        originRef: 'origin-a',
        stage: 'provider.request.forwarded',
        facts: expect.objectContaining({ provider: 'openai', providerStatus: 'completed' }),
      }),
    );
  });
});
