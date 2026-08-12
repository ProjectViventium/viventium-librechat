const express = require('express');
const request = require('supertest');
const { EModelEndpoint, ErrorTypes } = require('librechat-data-provider');

jest.mock('~/models', () => ({
  deleteUserKey: jest.fn(),
  getUserKey: jest.fn(),
  updateUserKey: jest.fn(),
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'test-user-id' };
    next();
  },
}));

jest.mock('@librechat/api', () => ({
  getBasePath: jest.fn(() => ''),
  clearMemoryWriterHealth: jest.fn(),
  isEnabled: jest.fn((value) => {
    if (value == null) {
      return false;
    }
    return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
  }),
}));

describe('Connected Accounts Routes', () => {
  let app;
  let router;
  let deleteUserKey;
  let getUserKey;
  let updateUserKey;
  let clearMemoryWriterHealth;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.DOMAIN_SERVER = 'https://chat.viventium.ai';
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'true';
    process.env.VIVENTIUM_EXPERIMENTAL_DIRECT_SUBSCRIPTION_AUTH = 'true';

    global.fetch = jest.fn();

    ({ deleteUserKey, getUserKey, updateUserKey } = require('~/models'));
    ({ clearMemoryWriterHealth } = require('@librechat/api'));
    router = require('../connectedAccounts');
    app = express();
    app.use(express.json());
    app.use('/api/connected-accounts', router);
  });

  afterEach(() => {
    delete process.env.DOMAIN_SERVER;
    delete process.env.JWT_SECRET;
    delete process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH;
    delete process.env.VIVENTIUM_EXPERIMENTAL_DIRECT_SUBSCRIPTION_AUTH;
    delete process.env.VIVENTIUM_ANTHROPIC_OAUTH_REDIRECT_URI;
    delete process.env.VIVENTIUM_OPENAI_LOCAL_CALLBACK_MANUAL_ONLY;
    delete process.env.VIVENTIUM_CONNECTED_ACCOUNTS_RETURN_ORIGIN;
    delete process.env.VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED;
  });

  it('should persist and report a personal-required credential policy per user and provider', async () => {
    getUserKey.mockResolvedValueOnce('personal_required');

    const updateResponse = await request(app)
      .put('/api/connected-accounts/openai/policy')
      .send({ policy: 'personal_required' });
    const readResponse = await request(app).get('/api/connected-accounts/openai/policy');

    expect(updateResponse.status).toBe(200);
    expect(updateUserKey).toHaveBeenCalledWith({
      userId: 'test-user-id',
      name: 'viventium:connected-account-policy:openai',
      value: 'personal_required',
      expiresAt: null,
    });
    expect(readResponse.status).toBe(200);
    expect(readResponse.body).toEqual({ policy: 'personal_required' });
  });

  it('should allow personal-required recovery when setup is disabled but a credential is already saved', async () => {
    process.env.VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED = 'false';
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'false';
    getUserKey.mockResolvedValueOnce('synthetic-saved-personal-credential');

    const response = await request(app)
      .put('/api/connected-accounts/openai/policy')
      .send({ policy: 'personal_required' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ policy: 'personal_required' });
    expect(updateUserKey).toHaveBeenCalledWith({
      userId: 'test-user-id',
      name: 'viventium:connected-account-policy:openai',
      value: 'personal_required',
      expiresAt: null,
    });
  });

  it('should reject personal-required mode when setup is disabled and no personal credential exists', async () => {
    process.env.VIVENTIUM_CONNECTED_ACCOUNTS_ENABLED = 'false';
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'false';
    getUserKey.mockRejectedValueOnce(new Error(JSON.stringify({ type: ErrorTypes.NO_USER_KEY })));

    const response = await request(app)
      .put('/api/connected-accounts/anthropic/policy')
      .send({ policy: 'personal_required' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: 'personal_credential_unavailable' });
    expect(updateUserKey).not.toHaveBeenCalled();
  });

  it('should report the backward-compatible preferred policy when no override exists', async () => {
    getUserKey.mockRejectedValueOnce(new Error(JSON.stringify({ type: ErrorTypes.NO_USER_KEY })));

    const response = await request(app).get('/api/connected-accounts/openai/policy');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ policy: 'personal_preferred' });
  });

  it('should restore backward-compatible platform fallback by deleting the policy override', async () => {
    const response = await request(app)
      .put('/api/connected-accounts/anthropic/policy')
      .send({ policy: 'personal_preferred' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ policy: 'personal_preferred' });
    expect(deleteUserKey).toHaveBeenCalledWith({
      userId: 'test-user-id',
      name: 'viventium:connected-account-policy:anthropic',
    });
  });

  it('should reject unsupported connected-account credential policies', async () => {
    const response = await request(app)
      .put('/api/connected-accounts/openai/policy')
      .send({ policy: 'platform_required' });

    expect(response.status).toBe(400);
    expect(updateUserKey).not.toHaveBeenCalled();
    expect(deleteUserKey).not.toHaveBeenCalled();
  });

  it('should return an OAuth authorization URL for OpenAI with local callback flow mode', async () => {
    const response = await request(app).get('/api/connected-accounts/openai/start');

    expect(response.status).toBe(200);
    expect(response.body.authUrl).toContain('https://auth.openai.com/oauth/authorize');
    expect(response.body.authUrl).toContain(
      'redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback',
    );
    expect(response.body.authUrl).toContain('code_challenge=');
    expect(response.body.flowMode).toBe('manual_code');
    expect(response.body.attemptId).toEqual(expect.any(String));
  });

  it('should scope connection status to the current OAuth attempt', async () => {
    const firstStart = await request(app).get('/api/connected-accounts/openai/start');
    const secondStart = await request(app).get('/api/connected-accounts/openai/start');

    expect(firstStart.body.attemptId).not.toBe(secondStart.body.attemptId);

    const firstStatus = await request(app)
      .get('/api/connected-accounts/openai/status')
      .query({ attemptId: firstStart.body.attemptId });
    const secondStatus = await request(app)
      .get('/api/connected-accounts/openai/status')
      .query({ attemptId: secondStart.body.attemptId });

    expect(firstStatus.status).toBe(200);
    expect(firstStatus.body).toEqual({
      attemptId: firstStart.body.attemptId,
      status: 'superseded',
    });
    expect(secondStatus.status).toBe(200);
    expect(secondStatus.body).toEqual({
      attemptId: secondStart.body.attemptId,
      status: 'pending',
    });
  });

  it('should return an OAuth authorization URL for Anthropic with manual flow mode', async () => {
    const response = await request(app).get('/api/connected-accounts/anthropic/start');
    const authUrl = new URL(response.body.authUrl);
    const state = authUrl.searchParams.get('state');

    expect(response.status).toBe(200);
    expect(response.body.authUrl).toContain('https://claude.ai/oauth/authorize');
    expect(response.body.authUrl).toContain(
      'redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback',
    );
    expect(authUrl.searchParams.get('scope')).toBe('user:inference');
    expect(response.body.authUrl).toContain('code_challenge=');
    expect(response.body.flowMode).toBe('manual_code');
    expect(typeof state).toBe('string');
    expect(state.split('.')).toHaveLength(4);
    expect(state).not.toContain('test-user-id');
  });

  it('should keep OAuth state confidential without changing the trusted return origin', async () => {
    process.env.VIVENTIUM_CONNECTED_ACCOUNTS_RETURN_ORIGIN = 'http://localhost:3190/';
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'header.payload.signature',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
    });

    const startResponse = await request(app).get('/api/connected-accounts/openai/start');
    const authUrl = new URL(startResponse.body.authUrl);
    const state = authUrl.searchParams.get('state');
    const response = await request(app).get('/api/connected-accounts/openai/callback').query({
      code: 'auth-code',
      state,
    });

    expect(startResponse.status).toBe(200);
    expect(state).not.toContain('test-user-id');
    expect(state).not.toContain('localhost');
    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('/oauth/success');
    expect(process.env.DOMAIN_SERVER).toBe('https://chat.viventium.ai');
  });

  it('should fail closed when no trusted connected-account return origin is configured', async () => {
    delete process.env.VIVENTIUM_CONNECTED_ACCOUNTS_RETURN_ORIGIN;
    delete process.env.DOMAIN_SERVER;

    const response = await request(app)
      .get('/api/connected-accounts/openai/start')
      .set('Host', 'untrusted.example');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'oauth_start_failed' });
  });

  it('should exchange callback code and store OpenAI credentials', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'header.payload.signature',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
    });

    const startResponse = await request(app).get('/api/connected-accounts/openai/start');
    const authUrl = new URL(startResponse.body.authUrl);
    const state = authUrl.searchParams.get('state');

    const response = await request(app).get('/api/connected-accounts/openai/callback').query({
      code: 'auth-code',
      state,
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('/oauth/success');
    expect(clearMemoryWriterHealth).toHaveBeenCalledWith({
      userId: 'test-user-id',
      provider: EModelEndpoint.openAI,
    });
    expect(response.headers.location).toContain('provider=openai');
    expect(response.headers.location).toContain(
      `attemptId=${encodeURIComponent(startResponse.body.attemptId)}`,
    );
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        name: EModelEndpoint.openAI,
        expiresAt: null,
      }),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const statusResponse = await request(app)
      .get('/api/connected-accounts/openai/status')
      .query({ attemptId: startResponse.body.attemptId });
    expect(statusResponse.body).toEqual({
      attemptId: startResponse.body.attemptId,
      status: 'completed',
    });
  });

  it('should reject a superseded callback before exchanging or overwriting credentials', async () => {
    const firstStart = await request(app).get('/api/connected-accounts/openai/start');
    const firstState = new URL(firstStart.body.authUrl).searchParams.get('state');
    await request(app).get('/api/connected-accounts/openai/start');

    const response = await request(app).get('/api/connected-accounts/openai/callback').query({
      code: 'stale-auth-code',
      state: firstState,
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('/oauth/error');
    expect(response.headers.location).toContain('error=superseded_flow');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(updateUserKey).not.toHaveBeenCalled();
  });

  it('should not persist a callback superseded during token exchange', async () => {
    let resolveFetch;
    global.fetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const firstStart = await request(app).get('/api/connected-accounts/openai/start');
    const firstState = new URL(firstStart.body.authUrl).searchParams.get('state');
    const callbackPromise = request(app)
      .get('/api/connected-accounts/openai/callback')
      .query({ code: 'stale-auth-code', state: firstState })
      .then((response) => response);

    await new Promise((resolve) => {
      const waitForExchange = () => {
        if (global.fetch.mock.calls.length > 0) {
          resolve();
          return;
        }
        setImmediate(waitForExchange);
      };
      waitForExchange();
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    await request(app).get('/api/connected-accounts/openai/start');
    resolveFetch({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'header.payload.signature',
          refresh_token: 'stale-refresh-token',
          expires_in: 3600,
        }),
    });

    const response = await callbackPromise;
    expect(response.headers.location).toContain('error=superseded_flow');
    expect(updateUserKey).not.toHaveBeenCalled();
  });

  it('should complete manual OpenAI flow via callbackInput', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'header.payload.signature',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
    });

    const startResponse = await request(app).get('/api/connected-accounts/openai/start');
    const authUrl = new URL(startResponse.body.authUrl);
    const state = authUrl.searchParams.get('state');

    const response = await request(app)
      .post('/api/connected-accounts/openai/complete')
      .send({
        callbackInput: `https://chat.viventium.ai/oauth/callback?code=auth-code&state=${encodeURIComponent(state ?? '')}`,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: true,
        provider: 'openai',
      }),
    );
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        name: EModelEndpoint.openAI,
        expiresAt: null,
      }),
    );
  });

  it('should complete manual Anthropic flow via callbackInput', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'oauth-access-token',
          refresh_token: 'anthropic-refresh-token',
          expires_in: 3600,
        }),
    });

    const startResponse = await request(app).get('/api/connected-accounts/anthropic/start');
    const authUrl = new URL(startResponse.body.authUrl);
    const state = authUrl.searchParams.get('state');

    const response = await request(app)
      .post('/api/connected-accounts/anthropic/complete')
      .send({
        callbackInput: `https://platform.claude.com/oauth/code/callback?code=anthropic-auth-code&state=${encodeURIComponent(state ?? '')}`,
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: true,
        provider: 'anthropic',
      }),
    );
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        name: EModelEndpoint.anthropic,
        expiresAt: null,
      }),
    );
    expect(JSON.parse(updateUserKey.mock.calls[0][0].value)).toEqual(
      expect.objectContaining({
        authToken: 'oauth-access-token',
        apiKey: 'oauth-access-token',
        oauthProvider: 'anthropic',
        oauthType: 'subscription',
      }),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://platform.claude.com/v1/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
        body: expect.any(URLSearchParams),
      }),
    );
    expect(global.fetch.mock.calls[0][1].body.toString()).toContain(
      'grant_type=authorization_code',
    );
  });

  it('should complete Anthropic manual flow using code-only input and explicit state', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: 'oauth-access-token',
          refresh_token: 'anthropic-refresh-token',
          expires_in: 3600,
        }),
    });

    const startResponse = await request(app).get('/api/connected-accounts/anthropic/start');
    const authUrl = new URL(startResponse.body.authUrl);
    const state = authUrl.searchParams.get('state');

    const response = await request(app).post('/api/connected-accounts/anthropic/complete').send({
      callbackInput: 'anthropic-auth-code-only',
      state,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual(
      expect.objectContaining({
        success: true,
        provider: 'anthropic',
      }),
    );
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        name: EModelEndpoint.anthropic,
        expiresAt: null,
      }),
    );
  });

  it('should reject callback with invalid state token', async () => {
    const response = await request(app).get('/api/connected-accounts/openai/callback').query({
      code: 'auth-code',
      state: 'invalid-state-token',
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('/oauth/error');
    expect(response.headers.location).toContain('error=invalid_state');
    expect(updateUserKey).not.toHaveBeenCalled();
  });

  it('should reject manual completion when state is missing', async () => {
    const response = await request(app).post('/api/connected-accounts/openai/complete').send({
      callbackInput: 'auth-code-only',
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('missing_state');
    expect(updateUserKey).not.toHaveBeenCalled();
  });

  it('should keep direct OAuth disabled by default even when credential setup is enabled', async () => {
    delete process.env.VIVENTIUM_EXPERIMENTAL_DIRECT_SUBSCRIPTION_AUTH;

    const response = await request(app).get('/api/connected-accounts/openai/start');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'oauth_not_enabled' });
  });

  it('should not treat the legacy page gate as authorization for direct OAuth', async () => {
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'true';
    process.env.VIVENTIUM_EXPERIMENTAL_DIRECT_SUBSCRIPTION_AUTH = 'false';

    const response = await request(app).get('/api/connected-accounts/anthropic/start');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'oauth_not_enabled' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
