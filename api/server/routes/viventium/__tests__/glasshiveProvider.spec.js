/* === VIVENTIUM START ===
 * Feature: Run-scoped GlassHive provider broker
 * Purpose: Prove clean-room workers can use the owner's connected model account without
 * receiving the provider credential or selecting an unscoped owner.
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');

const mockVerifyBrokerGrant = jest.fn();
const mockGetUserKeyValues = jest.fn();
const mockUpdateUserKey = jest.fn();
const mockResolveOpenAI = jest.fn();
const mockResolveAnthropic = jest.fn();

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
  BROKER_AUTHORITY_KINDS: { MISSION_WORKER: 'mission_worker' },
  verifyBrokerGrant: (...args) => mockVerifyBrokerGrant(...args),
}));

function appWithRoute() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/viventium/glasshive/providers', require('../glasshiveProvider'));
  return app;
}

describe('GlassHive run-scoped provider broker', () => {
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
      authority_kind: 'mission_worker',
      execution_mode: 'docker',
    });
    mockUpdateUserKey.mockResolvedValue(undefined);
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_REVERSE_PROXY;
    delete process.env.VIVENTIUM_OPENAI_AUTH_MODE;
    delete process.env.VIVENTIUM_PRIMARY_AUTH_MODE;
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

  test('fails closed when the signed owner has no connected provider credential', async () => {
    mockGetUserKeyValues.mockResolvedValue(null);
    mockResolveOpenAI.mockResolvedValue(null);

    const response = await request(appWithRoute())
      .post('/api/viventium/glasshive/providers/openai/v1/responses')
      .set('Authorization', 'Bearer synthetic-run-grant')
      .send({ model: 'synthetic-model', input: [] });

    expect(response.status).toBe(409);
    expect(response.body.error).toEqual({
      code: 'provider_auth_projection_unavailable',
      message: 'The connected model account is unavailable for this mission.',
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
      code: 'provider_auth_projection_unavailable',
      message: 'The connected model account is unavailable for this mission.',
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
    expect(response.body.error.code).toBe('provider_auth_projection_unavailable');
    expect(response.body.error.needsInput).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
