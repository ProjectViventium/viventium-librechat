const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { EModelEndpoint } = require('librechat-data-provider');

jest.mock('~/models', () => ({
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
  let updateUserKey;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    process.env.JWT_SECRET = 'test-jwt-secret';
    process.env.DOMAIN_SERVER = 'https://chat.viventium.ai';
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'true';

    global.fetch = jest.fn();

    ({ updateUserKey } = require('~/models'));
    router = require('../connectedAccounts');
    app = express();
    app.use(express.json());
    app.use('/api/connected-accounts', router);
  });

  afterEach(() => {
    delete process.env.DOMAIN_SERVER;
    delete process.env.JWT_SECRET;
    delete process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH;
    delete process.env.VIVENTIUM_ANTHROPIC_OAUTH_REDIRECT_URI;
    delete process.env.VIVENTIUM_OPENAI_LOCAL_CALLBACK_MANUAL_ONLY;
    delete process.env.VIVENTIUM_CONNECTED_ACCOUNTS_RETURN_ORIGIN;
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
    expect(state).not.toContain('.');
  });

  it('should use the configured connected-account return origin without changing DOMAIN_SERVER', async () => {
    process.env.VIVENTIUM_CONNECTED_ACCOUNTS_RETURN_ORIGIN = 'http://localhost:3190/';

    const response = await request(app).get('/api/connected-accounts/openai/start');
    const authUrl = new URL(response.body.authUrl);
    const state = authUrl.searchParams.get('state');
    const decoded = jwt.decode(state);

    expect(response.status).toBe(200);
    expect(decoded.serverOrigin).toBe('http://localhost:3190');
    expect(process.env.DOMAIN_SERVER).toBe('https://chat.viventium.ai');
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
    expect(response.headers.location).toContain('provider=openai');
    expect(updateUserKey).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'test-user-id',
        name: EModelEndpoint.openAI,
        expiresAt: null,
      }),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
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
    expect(global.fetch.mock.calls[0][1].body.toString()).toContain('grant_type=authorization_code');
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

  it('should return oauth_not_enabled when local subscription auth is disabled', async () => {
    process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH = 'false';

    const response = await request(app).get('/api/connected-accounts/openai/start');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'oauth_not_enabled' });
  });
});
