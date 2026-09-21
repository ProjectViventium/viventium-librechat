/* === VIVENTIUM START ===
 * Feature: Run-scoped GlassHive provider broker
 * Purpose: Prove clean-room workers can use the owner's connected model account without
 * receiving the provider credential or selecting an unscoped owner.
 * === VIVENTIUM END === */

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

  test('rejects missing or invalid run grants before connected-account lookup', async () => {
    mockVerifyBrokerGrant.mockImplementationOnce(() => {
      throw new Error('invalid grant');
    });

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .send({ model: 'synthetic-model', input: [] });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('provider_broker_unauthorized');
    expect(mockGetUserKeyValues).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects a signed but revoked exact run grant before credential lookup or provider access', async () => {
    mockAssertActiveCapabilityAuthorizationGrant.mockRejectedValue(
      Object.assign(new Error('inactive'), {
        code: 'capability_grant_inactive',
        status: 401,
      }),
    );

    const providerResponse = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .set('Authorization', 'Bearer synthetic-revoked-run-grant')
      .send({ model: 'synthetic-model', input: [] });
    const preflightResponse = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/auth/preflight')
      .set('Authorization', 'Bearer synthetic-revoked-run-grant')
      .send({ version: 1 });

    expect(providerResponse.status).toBe(401);
    expect(providerResponse.body.error.code).toBe('provider_broker_unauthorized');
    expect(preflightResponse.status).toBe(401);
    expect(preflightResponse.body.error.code).toBe('provider_broker_unauthorized');
    expect(mockGetUserKeyValues).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('streams OpenAI through the signed owner account without forwarding the run grant', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'synthetic-owner-openai-token',
      baseURL: 'https://provider.example/v1',
      headers: {
        'OpenAI-Beta': 'responses=experimental',
        originator: 'pi',
        'chatgpt-account-id': 'synthetic-account',
      },
      oauthProvider: 'openai-codex',
      oauthType: 'subscription',
    });
    mockResolveOpenAI.mockImplementation(async (_userId, values) => values);
    global.fetch.mockResolvedValue(
      new Response('data: {"type":"response.output_text.delta","delta":"OK"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'upstream-request' },
      }),
    );

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ model: 'synthetic-model', stream: true, input: [] });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('response.output_text.delta');
    expect(mockGetUserKeyValues).toHaveBeenCalledWith({
      userId: 'owner-a',
      name: 'openAI',
    });
    expect(mockResolveOpenAI).toHaveBeenCalledWith(
      'owner-a',
      expect.objectContaining({ apiKey: 'synthetic-owner-openai-token' }),
      expect.objectContaining({
        getUserKeyValues: expect.any(Function),
        updateUserKey: expect.any(Function),
      }),
    );
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://provider.example/v1/responses');
    expect(options.headers.Authorization).toBe('Bearer synthetic-owner-openai-token');
    expect(JSON.stringify(options)).not.toContain('synthetic-run-grant');
    expect(mockRecordOrchestrationTraceEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordOrchestrationTraceEvent).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      originRef: 'origin-a',
      eventKey: expect.stringMatching(/^glasshive\.provider\.request\.v1:ghpr_/),
      stage: 'provider.request.forwarded',
      facts: {
        workRef: 'work-a',
        runRef: 'run-a',
        providerRequestRef: expect.stringMatching(/^ghpr_/),
        provider: 'openai',
        providerStatus: 'completed',
      },
    });
    expect(JSON.stringify(mockRecordOrchestrationTraceEvent.mock.calls)).not.toContain(
      'synthetic-owner-openai-token',
    );
    expect(JSON.stringify(mockRecordOrchestrationTraceEvent.mock.calls)).not.toContain(
      'synthetic-model',
    );
  });

  test('withholds an upstream response when its immutable provider-forwarding receipt cannot persist', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'synthetic-owner-openai-token',
      baseURL: 'https://provider.example/v1',
    });
    mockResolveOpenAI.mockImplementation(async (_userId, values) => values);
    global.fetch.mockResolvedValue(new Response('private provider result', { status: 200 }));
    mockRecordOrchestrationTraceEvent.mockRejectedValueOnce(new Error('trace unavailable'));

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ model: 'synthetic-model', input: [] });

    expect(response.status).toBe(503);
    expect(response.body.error).toEqual({
      code: 'provider_trace_unavailable',
      message: 'The provider request result could not be recorded safely.',
      needsInput: false,
    });
    expect(response.text).not.toContain('private provider result');
  });

  test('streams Anthropic with owner-scoped OAuth and never accepts an arbitrary path', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      authToken: 'synthetic-owner-anthropic-token',
      oauthProvider: 'anthropic',
      oauthType: 'subscription',
    });
    mockResolveAnthropic.mockImplementation(async (_userId, values) => values);
    global.fetch.mockResolvedValue(
      new Response('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/anthropic/v1/messages')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .set('anthropic-version', '2023-06-01')
      .send({ model: 'synthetic-claude', stream: true, messages: [] });

    expect(response.status).toBe(200);
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(options.headers.authorization).toBe('Bearer synthetic-owner-anthropic-token');
    expect(options.headers['x-api-key']).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain('synthetic-run-grant');

    const rejected = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/files')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({});
    expect(rejected.status).toBe(404);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('persists reconnect-required truth when an OAuth provider rejects the connected account', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      authToken: 'synthetic-revoked-anthropic-token',
      refreshToken: 'synthetic-refresh-token',
      oauthProvider: 'anthropic',
      oauthType: 'subscription',
      oauthExpiresAt: Date.now() + 60 * 60 * 1000,
      oauthReconnectRequired: false,
    });
    mockResolveAnthropic.mockImplementation(async (_userId, values) => values);
    global.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { type: 'authentication_error' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/anthropic/v1/messages')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ model: 'synthetic-claude', stream: true, messages: [] });

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({
      code: 'provider_connected_account_reconnect_required',
      message: 'Reconnect the connected model account, then resume this work.',
      needsInput: true,
    });
    expect(mockUpdateUserKey).toHaveBeenCalledTimes(1);
    expect(mockUpdateUserKey).toHaveBeenCalledWith({
      userId: 'owner-a',
      name: 'anthropic',
      value: expect.any(String),
      expiresAt: null,
    });
    expect(JSON.parse(mockUpdateUserKey.mock.calls[0][0].value)).toMatchObject({
      oauthProvider: 'anthropic',
      oauthType: 'subscription',
      oauthReconnectRequired: true,
    });
    expect(response.text).not.toContain('synthetic-revoked-anthropic-token');
    expect(response.text).not.toContain('synthetic-refresh-token');
  });

  test('fails closed when the signed owner has no connected provider credential', async () => {
    mockGetUserKeyValues.mockResolvedValue(null);
    mockResolveOpenAI.mockResolvedValue(null);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ model: 'synthetic-model', input: [] });

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({
      code: 'provider_auth_missing',
      message: 'Connect the configured model account, then resume this work.',
      needsInput: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('uses the configured platform OpenAI account when the owner has no connected account', async () => {
    process.env.OPENAI_API_KEY = 'synthetic-platform-openai-token';
    process.env.OPENAI_REVERSE_PROXY = 'https://platform-provider.example/v1';
    mockGetUserKeyValues.mockRejectedValue(new Error(JSON.stringify({ type: 'no_user_key' })));
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
    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe('https://platform-provider.example/v1/responses');
    expect(options.headers.Authorization).toBe('Bearer synthetic-platform-openai-token');
    expect(JSON.stringify(options)).not.toContain('synthetic-run-grant');
  });

  test('maps a missing connected account without platform fallback to actionable needs-input truth', async () => {
    mockGetUserKeyValues.mockRejectedValue(new Error(JSON.stringify({ type: 'no_user_key' })));

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ model: 'synthetic-model', input: [] });

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({
      code: 'provider_auth_missing',
      message: 'Connect the configured model account, then resume this work.',
      needsInput: true,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('does not bypass connected-account mode with a platform credential', async () => {
    process.env.VIVENTIUM_OPENAI_AUTH_MODE = 'connected_account';
    process.env.OPENAI_API_KEY = 'synthetic-platform-openai-token';
    process.env.OPENAI_REVERSE_PROXY = 'https://platform-provider.example/v1';
    mockGetUserKeyValues.mockRejectedValue(new Error(JSON.stringify({ type: 'no_user_key' })));

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ model: 'synthetic-model', input: [] });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('provider_auth_missing');
    expect(response.body.error.needsInput).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('preflights the exact signed owner credential without an upstream provider request', async () => {
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

  test('preflight reports reconnect, missing auth, and projection faults as distinct states', async () => {
    mockGetUserKeyValues.mockResolvedValueOnce({
      apiKey: 'synthetic-expired-token',
      baseURL: 'https://provider.example/v1',
      oauthProvider: 'openai-codex',
      oauthType: 'subscription',
      oauthReconnectRequired: true,
    });
    const reconnect = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/auth/preflight')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ version: 1 });
    expect(reconnect.status).toBe(409);
    expect(reconnect.body.error).toEqual({
      code: 'provider_connected_account_reconnect_required',
      message: 'Reconnect the connected model account, then resume this work.',
      needsInput: true,
    });

    mockGetUserKeyValues.mockRejectedValueOnce(new Error(JSON.stringify({ type: 'no_user_key' })));
    const missing = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/auth/preflight')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ version: 1 });
    expect(missing.status).toBe(409);
    expect(missing.body.error.code).toBe('provider_auth_missing');
    expect(missing.body.error.needsInput).toBe(true);

    mockGetUserKeyValues.mockRejectedValueOnce(new Error('synthetic storage unavailable'));
    const projection = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/auth/preflight')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ version: 1 });
    expect(projection.status).toBe(503);
    expect(projection.body.error).toEqual({
      code: 'provider_auth_projection_unavailable',
      message: 'The model account authorization could not be read for this mission.',
      needsInput: false,
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('maps a non-subscription provider credential rejection to provider_unauthorized', async () => {
    mockGetUserKeyValues.mockResolvedValue({
      apiKey: 'synthetic-rejected-api-key',
      baseURL: 'https://provider.example/v1',
    });
    mockResolveOpenAI.mockImplementation(async (_userId, values) => values);
    global.fetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'private upstream body' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ model: 'synthetic-model', input: [] });

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({
      code: 'provider_unauthorized',
      message: 'The model provider rejected the configured credentials.',
      needsInput: true,
    });
    expect(response.text).not.toContain('private upstream body');
  });
});
