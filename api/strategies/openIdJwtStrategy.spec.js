const { SystemRoles } = require('librechat-data-provider');

// --- Capture the verify callback from JwtStrategy ---
let capturedVerifyCallback;
let capturedStrategyOptions;
jest.mock('passport-jwt', () => ({
  Strategy: jest.fn((opts, verifyCallback) => {
    capturedStrategyOptions = opts;
    capturedVerifyCallback = verifyCallback;
    return { name: 'jwt' };
  }),
  ExtractJwt: {
    fromAuthHeaderAsBearerToken: jest.fn(() => 'mock-extractor'),
  },
}));
jest.mock('jwks-rsa', () => ({
  passportJwtSecret: jest.fn(() => 'mock-secret-provider'),
}));
jest.mock('https-proxy-agent', () => ({
  HttpsProxyAgent: jest.fn(),
}));
jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() },
}));
jest.mock('@librechat/api', () => ({
  isEnabled: jest.fn(() => false),
  findOpenIDUser: jest.fn(),
  isEmailDomainAllowed: jest.fn(() => true),
  math: jest.fn((val, fallback) => fallback),
}));
jest.mock('~/models', () => ({
  findUser: jest.fn(),
  updateUser: jest.fn(),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({
    saveBuffer: jest.fn().mockResolvedValue('/fake/path/to/avatar.png'),
  })),
}));
jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn().mockResolvedValue({}),
}));
jest.mock('~/cache/getLogStores', () =>
  jest.fn().mockReturnValue({ get: jest.fn(), set: jest.fn() }),
);

const { findOpenIDUser } = require('@librechat/api');
const { isEmailDomainAllowed } = require('@librechat/api');
const openIdJwtLogin = require('./openIdJwtStrategy');
const { findUser, updateUser } = require('~/models');
const { getAppConfig } = require('~/server/services/Config');

// Helper: build a mock openIdConfig
const mockOpenIdConfig = {
  serverMetadata: () => ({
    issuer: 'https://identity.example.test/tenant/v2.0',
    jwks_uri: 'https://example.com/.well-known/jwks.json',
  }),
};

// Helper: invoke the captured verify callback
async function invokeVerify(req, payload) {
  return new Promise((resolve, reject) => {
    capturedVerifyCallback(req, payload, (err, user, info) => {
      if (err) {
        return reject(err);
      }
      resolve({ user, info });
    });
  });
}

describe('openIdJwtStrategy – token source handling', () => {
  const baseUser = {
    _id: { toString: () => 'user-abc' },
    role: SystemRoles.USER,
    provider: 'openid',
  };

  const payload = { sub: 'oidc-123', email: 'test@example.com', exp: 9999999999 };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENID_CLIENT_ID = 'librechat-web';
    process.env.OPENID_AUDIENCE = 'api://librechat';
    delete process.env.OPENID_REQUIRED_ROLE;
    delete process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH;
    /* === VIVENTIUM START === Shared-OIDC test isolation. === */
    delete process.env.VIVENTIUM_GLASSHIVE_SHARED_OIDC_ISSUER;
    delete process.env.VIVENTIUM_GLASSHIVE_SHARED_OIDC_PRINCIPAL_CLAIM;
    /* === VIVENTIUM END === */
    findOpenIDUser.mockResolvedValue({ user: { ...baseUser }, error: null, migration: false });
    getAppConfig.mockResolvedValue({ registration: { allowedDomains: ['example.com'] } });
    isEmailDomainAllowed.mockReturnValue(true);
    updateUser.mockResolvedValue({});

    // Initialize the strategy so capturedVerifyCallback is set
    openIdJwtLogin(mockOpenIdConfig);
  });

  it('pins issuer, audience, and RS256 before accepting a reused bearer token', () => {
    expect(capturedStrategyOptions).toEqual(
      expect.objectContaining({
        issuer: 'https://identity.example.test/tenant/v2.0',
        audience: 'api://librechat',
        algorithms: ['RS256'],
      }),
    );
  });

  it('rejects a reused token when its email is outside the current domain policy', async () => {
    isEmailDomainAllowed.mockReturnValue(false);

    const result = await invokeVerify(
      { headers: { authorization: 'Bearer raw-bearer-token' }, session: {} },
      payload,
    );

    expect(result.user).toBe(false);
    expect(result.info).toEqual({ message: 'OpenID account is not authorized' });
    expect(findOpenIDUser).not.toHaveBeenCalled();
  });

  it('rejects a reused token when its required role was removed', async () => {
    process.env.OPENID_REQUIRED_ROLE = 'Workspace.User';
    process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'roles';

    const result = await invokeVerify(
      { headers: { authorization: 'Bearer raw-bearer-token' }, session: {} },
      { ...payload, roles: ['Other.Role'] },
    );

    expect(result.user).toBe(false);
    expect(result.info).toEqual({ message: 'OpenID account is not authorized' });
    expect(findOpenIDUser).not.toHaveBeenCalled();
  });

  it('accepts a reused token carrying one of the approved roles', async () => {
    process.env.OPENID_REQUIRED_ROLE = 'Workspace.Reader, Workspace.User';
    process.env.OPENID_REQUIRED_ROLE_PARAMETER_PATH = 'roles';

    const { user } = await invokeVerify(
      { headers: { authorization: 'Bearer raw-bearer-token' }, session: {} },
      { ...payload, roles: ['Workspace.User'] },
    );

    expect(user.id).toBe('user-abc');
  });

  it('should read all tokens from session when available', async () => {
    const req = {
      headers: { authorization: 'Bearer raw-bearer-token' },
      session: {
        openidTokens: {
          accessToken: 'session-access',
          idToken: 'session-id',
          refreshToken: 'session-refresh',
        },
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens).toEqual({
      access_token: 'session-access',
      id_token: 'session-id',
      refresh_token: 'session-refresh',
      expires_at: payload.exp,
    });
  });

  it('should fall back to cookies when session is absent', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie:
          'openid_access_token=cookie-access; openid_id_token=cookie-id; refreshToken=cookie-refresh',
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens).toEqual({
      access_token: 'cookie-access',
      id_token: 'cookie-id',
      refresh_token: 'cookie-refresh',
      expires_at: payload.exp,
    });
  });

  it('should fall back to cookie for idToken only when session lacks it', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie: 'openid_id_token=cookie-id',
      },
      session: {
        openidTokens: {
          accessToken: 'session-access',
          // idToken intentionally missing
          refreshToken: 'session-refresh',
        },
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens).toEqual({
      access_token: 'session-access',
      id_token: 'cookie-id',
      refresh_token: 'session-refresh',
      expires_at: payload.exp,
    });
  });

  it('should use raw Bearer token as access_token fallback when neither session nor cookie has one', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie: 'openid_id_token=cookie-id; refreshToken=cookie-refresh',
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens.access_token).toBe('raw-bearer-token');
    expect(user.federatedTokens.id_token).toBe('cookie-id');
    expect(user.federatedTokens.refresh_token).toBe('cookie-refresh');
  });

  it('should set id_token to undefined when not available in session or cookies', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie: 'openid_access_token=cookie-access; refreshToken=cookie-refresh',
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens.access_token).toBe('cookie-access');
    expect(user.federatedTokens.id_token).toBeUndefined();
    expect(user.federatedTokens.refresh_token).toBe('cookie-refresh');
  });

  it('should keep id_token and access_token as distinct values from cookies', async () => {
    const req = {
      headers: {
        authorization: 'Bearer raw-bearer-token',
        cookie:
          'openid_access_token=the-access-token; openid_id_token=the-id-token; refreshToken=the-refresh',
      },
    };

    const { user } = await invokeVerify(req, payload);

    expect(user.federatedTokens.access_token).toBe('the-access-token');
    expect(user.federatedTokens.id_token).toBe('the-id-token');
    expect(user.federatedTokens.access_token).not.toBe(user.federatedTokens.id_token);
  });

  /* === VIVENTIUM START ===
   * Feature: Shared-OIDC GlassHive authenticated JWT-login backfill.
   */
  it('should backfill the opaque GlassHive principal from the exact configured issuer and claim', async () => {
    process.env.VIVENTIUM_GLASSHIVE_SHARED_OIDC_ISSUER =
      'https://identity.example.test/tenant/v2.0';
    process.env.VIVENTIUM_GLASSHIVE_SHARED_OIDC_PRINCIPAL_CLAIM = 'oid';
    const linkedPayload = {
      ...payload,
      iss: 'https://identity.example.test/tenant/v2.0',
      oid: 'stable-object-id',
    };

    await invokeVerify(
      { headers: { authorization: 'Bearer raw-bearer-token' }, session: {} },
      linkedPayload,
    );

    expect(updateUser).toHaveBeenCalledWith(
      'user-abc',
      expect.objectContaining({
        viventiumGlassHivePrincipalId: expect.stringMatching(/^usr_[a-f0-9]{32}$/),
      }),
    );
  });

  it('should refuse GlassHive backfill when the signed token issuer does not match', async () => {
    process.env.VIVENTIUM_GLASSHIVE_SHARED_OIDC_ISSUER =
      'https://identity.example.test/tenant/v2.0';
    process.env.VIVENTIUM_GLASSHIVE_SHARED_OIDC_PRINCIPAL_CLAIM = 'oid';

    await invokeVerify(
      { headers: { authorization: 'Bearer raw-bearer-token' }, session: {} },
      { ...payload, iss: 'https://wrong.example.test/tenant/v2.0', oid: 'stable-object-id' },
    );

    expect(updateUser).not.toHaveBeenCalled();
  });
  /* === VIVENTIUM END === */
});

describe('openIdJwtStrategy – OPENID_EMAIL_CLAIM', () => {
  const payload = {
    sub: 'oidc-123',
    email: 'test@example.com',
    preferred_username: 'testuser',
    upn: 'test@corp.example.com',
    exp: 9999999999,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.OPENID_EMAIL_CLAIM;

    // Use real findOpenIDUser so it delegates to the findUser mock
    const realFindOpenIDUser = jest.requireActual('@librechat/api').findOpenIDUser;
    findOpenIDUser.mockImplementation(realFindOpenIDUser);

    findUser.mockResolvedValue(null);
    updateUser.mockResolvedValue({});

    openIdJwtLogin(mockOpenIdConfig);
  });

  afterEach(() => {
    delete process.env.OPENID_EMAIL_CLAIM;
  });

  it('should use the default email when OPENID_EMAIL_CLAIM is not set', async () => {
    const existingUser = {
      _id: 'user-id-1',
      provider: 'openid',
      openidId: payload.sub,
      email: payload.email,
      role: SystemRoles.USER,
    };
    findUser.mockImplementation(async (query) => {
      if (query.$or && query.$or.some((c) => c.openidId === payload.sub)) {
        return existingUser;
      }
      return null;
    });

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith(
      expect.objectContaining({
        $or: expect.arrayContaining([{ openidId: payload.sub }]),
      }),
    );
  });

  it('should use OPENID_EMAIL_CLAIM when set for email lookup', async () => {
    process.env.OPENID_EMAIL_CLAIM = 'upn';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user } = await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledTimes(2);
    expect(findUser.mock.calls[0][0]).toMatchObject({
      $or: expect.arrayContaining([{ openidId: payload.sub }]),
    });
    expect(findUser.mock.calls[1][0]).toEqual({ email: 'test@corp.example.com' });
    expect(user).toBe(false);
  });

  it('should fall back to default chain when OPENID_EMAIL_CLAIM points to missing claim', async () => {
    process.env.OPENID_EMAIL_CLAIM = 'nonexistent_claim';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user } = await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith({ email: payload.email });
    expect(user).toBe(false);
  });

  it('should trim whitespace from OPENID_EMAIL_CLAIM', async () => {
    process.env.OPENID_EMAIL_CLAIM = '  upn  ';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith({ email: 'test@corp.example.com' });
  });

  it('should ignore empty string OPENID_EMAIL_CLAIM and use default fallback', async () => {
    process.env.OPENID_EMAIL_CLAIM = '';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith({ email: payload.email });
  });

  it('should ignore whitespace-only OPENID_EMAIL_CLAIM and use default fallback', async () => {
    process.env.OPENID_EMAIL_CLAIM = '   ';
    findUser.mockResolvedValue(null);

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    await invokeVerify(req, payload);

    expect(findUser).toHaveBeenCalledWith({ email: payload.email });
  });

  it('should resolve undefined email when payload is null', async () => {
    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user } = await invokeVerify(req, null);

    expect(user).toBe(false);
  });

  it('should attempt email lookup via preferred_username fallback when email claim is absent', async () => {
    const payloadNoEmail = {
      sub: 'oidc-new-sub',
      preferred_username: 'legacy@corp.com',
      upn: 'legacy@corp.com',
      exp: 9999999999,
    };

    const legacyUser = {
      _id: 'legacy-db-id',
      email: 'legacy@corp.com',
      openidId: null,
      role: SystemRoles.USER,
    };

    findUser.mockImplementation(async (query) => {
      if (query.$or) {
        return null;
      }
      if (query.email === 'legacy@corp.com') {
        return legacyUser;
      }
      return null;
    });

    const req = { headers: { authorization: 'Bearer tok' }, session: {} };
    const { user } = await invokeVerify(req, payloadNoEmail);

    expect(findUser).toHaveBeenCalledTimes(2);
    expect(findUser.mock.calls[1][0]).toEqual({ email: 'legacy@corp.com' });
    expect(user).toBeTruthy();
    expect(updateUser).toHaveBeenCalledWith(
      'legacy-db-id',
      expect.objectContaining({ provider: 'openid', openidId: payloadNoEmail.sub }),
    );
  });
});
