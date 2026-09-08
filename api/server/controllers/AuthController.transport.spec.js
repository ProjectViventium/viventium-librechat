/* === VIVENTIUM START === Real transport and native persistence own refresh cancellation. === */
jest.mock('@librechat/api', () => ({
  getSessionCookieName: jest.requireActual('@librechat/api').getSessionCookieName,
  math: (value, fallback) => (value ? Number(value) : fallback),
  isEnabled: (value) => value === 'true',
  shouldUseSecureCookie: () => false,
}));
jest.mock('~/models', () => {
  const methods = require('@librechat/data-schemas').createMethods(require('mongoose'));
  return {
    ...methods,
    findSession: jest.fn(methods.findSession),
    generateRefreshToken: jest.fn(methods.generateRefreshToken),
    generateToken: jest.fn(methods.generateToken),
  };
});
jest.mock('~/strategies/validators', () => ({ registerSchema: {} }));
jest.mock('~/strategies', () => ({}));
jest.mock('~/server/services/Config', () => ({}));
jest.mock('~/server/utils', () => ({}));
jest.mock('~/server/services/GraphTokenService', () => ({}));
jest.mock('~/server/services/viventium/registrationApprovalService', () => ({
  assertViventiumApproved: jest.fn(async () => {}),
  APPROVAL_ERROR_CODE: 'synthetic-approval-error',
}));

const axios = require('axios');
const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { createServer } = require('node:http');
const { webcrypto } = require('node:crypto');
const { MongoMemoryServer } = require('mongodb-memory-server');
const schemas = require('@librechat/data-schemas');
const models = require('~/models');
const { refreshController } = require('~/server/controllers/AuthController');
const { setAuthTokens } = require('~/server/services/AuthService');
const { logoutController } = require('~/server/controllers/auth/LogoutController');
const { CookieJar } = require('tough-cookie');
const {
  assertViventiumApproved,
} = require('~/server/services/viventium/registrationApprovalService');

const originalEnv = { ...process.env };
const actual = schemas.createMethods(mongoose);
const owner = new mongoose.Types.ObjectId();
let mongo;
let server;
let client;
let records;
let beforeController;

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'synthetic-access-secret';
  process.env.JWT_REFRESH_SECRET = 'synthetic-refresh-secret';
  process.env.OPENID_REUSE_TOKENS = 'false';
  mongo = await MongoMemoryServer.create({
    instance: { args: ['--setParameter', 'enableTestCommands=1'] },
  });
  await mongoose.connect(mongo.getUri(), {
    dbName: 'synthetic_refresh_cancellation',
    retryReads: false,
    heartbeatFrequencyMS: 500,
    serverSelectionTimeoutMS: 3000,
  });
  schemas.createModels(mongoose);
  await mongoose.models.User.create({
    _id: owner,
    username: 'synthetic-user',
    email: 'synthetic@example.test',
    provider: 'local',
  });
});

beforeEach(async () => {
  process.env.VIVENTIUM_DEV_ENV_ENABLED = 'false';
  delete process.env.VIVENTIUM_DEV_ENV_NAME;
  models.findSession.mockReset().mockImplementation(actual.findSession);
  models.generateRefreshToken.mockReset().mockImplementation(actual.generateRefreshToken);
  models.generateToken.mockReset().mockImplementation(actual.generateToken);
  assertViventiumApproved.mockReset().mockResolvedValue(undefined);
  await mongoose.models.Session.deleteMany({});
  records = [];
  beforeController = null;
  const app = express();
  app.post('/api/auth/test-session', async (_req, res) => {
    res.json({ token: await setAuthTokens(owner.toString(), res) });
  });
  app.post('/api/auth/logout', (req, res) => {
    req.user = { id: owner.toString() };
    return logoutController(req, res);
  });
  app.post('/api/auth/refresh', async (req, res) => {
    const record = { response: res, closed: deferred(), settled: deferred() };
    records.push(record);
    res.once('close', record.closed.resolve);
    try {
      await beforeController?.(req, res);
      await refreshController(req, res);
    } finally {
      record.settled.resolve();
    }
  });
  server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  client = axios.create({
    baseURL: `http://127.0.0.1:${server.address().port}`,
    adapter: 'http',
    proxy: false,
    timeout: 3000,
    maxRedirects: 0,
    validateStatus: () => true,
  });
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
  process.env = originalEnv;
});

async function sessionFixture() {
  const expiration = new Date(Date.now() + 3600000);
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 60000);
  let fixture;
  try {
    fixture = await actual.createSession(owner.toString(), { expiration });
  } finally {
    clock.mockRestore();
  }
  return {
    cookie: fixture.refreshToken,
    id: fixture.session._id,
    hash: fixture.session.refreshTokenHash,
  };
}

function refresh(cookie, signal) {
  return client.post('/api/auth/refresh', undefined, {
    headers: { Cookie: `refreshToken=${cookie}; token_provider=librechat` },
    signal,
  });
}

function returnedCookie(response) {
  const line = response.headers['set-cookie']?.find((entry) => entry.startsWith('refreshToken='));
  return line?.split(';')[0].slice('refreshToken='.length);
}

async function unchanged(fixture) {
  const session = await mongoose.models.Session.findById(fixture.id).lean();
  return session?.refreshTokenHash === fixture.hash;
}

it('a request canceled before controller processing preserves its session for retry', async () => {
  const fixture = await sessionFixture();
  const entered = deferred();
  const release = deferred();
  beforeController = async () => {
    entered.resolve();
    await release.promise;
  };
  const cancellation = new AbortController();
  const pending = refresh(fixture.cookie, cancellation.signal).catch((error) => ({
    code: error.code,
  }));
  await entered.promise;
  cancellation.abort();
  const failure = await pending;
  await records[0].closed.promise;
  const responseAbandoned = records[0].response.destroyed;
  beforeController = null;
  release.resolve();
  await records[0].settled.promise;
  const sessionHashUnchanged = await unchanged(fixture);
  const retry = await refresh(fixture.cookie);
  expect({
    code: failure.code,
    responseAbandoned,
    sessionHashUnchanged,
    retryStatus: retry.status,
  }).toEqual({
    code: 'ERR_CANCELED',
    responseAbandoned: true,
    sessionHashUnchanged: true,
    retryStatus: 200,
  });
});

it('cancellation while the actual session lookup is awaited preserves its session', async () => {
  const fixture = await sessionFixture();
  const entered = deferred();
  const release = deferred();
  models.findSession.mockImplementationOnce(async (...args) => {
    const session = await actual.findSession(...args);
    entered.resolve();
    await release.promise;
    return session;
  });
  const cancellation = new AbortController();
  const pending = refresh(fixture.cookie, cancellation.signal).catch((error) => ({
    code: error.code,
  }));
  await entered.promise;
  cancellation.abort();
  const failure = await pending;
  await records[0].closed.promise;
  const responseAbandoned = records[0].response.destroyed;
  release.resolve();
  await records[0].settled.promise;
  const sessionHashUnchanged = await unchanged(fixture);
  const retry = await refresh(fixture.cookie);
  expect({
    code: failure.code,
    responseAbandoned,
    sessionHashUnchanged,
    retryStatus: retry.status,
  }).toEqual({
    code: 'ERR_CANCELED',
    responseAbandoned: true,
    sessionHashUnchanged: true,
    retryStatus: 200,
  });
});

it('normal rotation rejects the old token and accepts the delivered replacement', async () => {
  const fixture = await sessionFixture();
  const response = await refresh(fixture.cookie);
  const replacement = returnedCookie(response);
  const oldRetry = await refresh(fixture.cookie);
  const next = replacement ? await refresh(replacement) : null;
  expect({
    status: response.status,
    accessTokenPresent: typeof response.data.token === 'string',
    replacementPresent: Boolean(replacement),
    hashChanged: !(await unchanged(fixture)),
    oldStatus: oldRetry.status,
    nextStatus: next?.status,
  }).toEqual({
    status: 200,
    accessTokenPresent: true,
    replacementPresent: true,
    hashChanged: true,
    oldStatus: 401,
    nextStatus: 200,
  });
});

it('cancellation during the actual new-token hash await does not commit rotation', async () => {
  const fixture = await sessionFixture();
  const entered = deferred();
  const release = deferred();
  const digest = webcrypto.subtle.digest.bind(webcrypto.subtle);
  let calls = 0;
  const hash = jest.spyOn(webcrypto.subtle, 'digest').mockImplementation(async (...args) => {
    const result = await digest(...args);
    calls += 1;
    if (calls === 2) {
      entered.resolve();
      await release.promise;
    }
    return result;
  });
  try {
    const cancellation = new AbortController();
    const pending = refresh(fixture.cookie, cancellation.signal).catch((error) => ({
      code: error.code,
    }));
    await entered.promise;
    cancellation.abort();
    const failure = await pending;
    await records[0].closed.promise;
    const responseAbandoned = records[0].response.destroyed;
    release.resolve();
    await records[0].settled.promise;
    hash.mockRestore();
    const sessionHashUnchanged = await unchanged(fixture);
    const retry = await refresh(fixture.cookie);
    expect({
      code: failure.code,
      responseAbandoned,
      sessionHashUnchanged,
      retryStatus: retry.status,
    }).toEqual({
      code: 'ERR_CANCELED',
      responseAbandoned: true,
      sessionHashUnchanged: true,
      retryStatus: 200,
    });
  } finally {
    release.resolve();
    hash.mockRestore();
  }
});

it.each(['invalid-signature', 'expired', 'malformed', 'not-yet-valid'])(
  '%s tokens remain rejected without rotating a valid session',
  async (kind) => {
    const fixture = await sessionFixture();
    const cookie =
      kind === 'malformed'
        ? 'malformed-cookie'
        : jwt.sign(
            {
              id: owner.toString(),
              sessionId: fixture.id.toString(),
              ...(kind === 'not-yet-valid' ? { nbf: Math.floor(Date.now() / 1000) + 600 } : {}),
            },
            kind === 'invalid-signature'
              ? 'different-synthetic-secret'
              : process.env.JWT_REFRESH_SECRET,
            { expiresIn: kind === 'expired' ? -10 : 3600 },
          );
    const response = await refresh(cookie);
    expect({
      status: response.status,
      clearsRefreshCookie: returnedCookie(response) === '',
      sessionHashUnchanged: await unchanged(fixture),
      rotations: models.generateRefreshToken.mock.calls.length,
    }).toEqual({
      status: 403,
      clearsRefreshCookie: true,
      sessionHashUnchanged: true,
      rotations: 0,
    });
  },
);

it('LIMIT: cancellation after rotation committed cannot recover with the old cookie', async () => {
  const fixture = await sessionFixture();
  const committed = deferred();
  const release = deferred();
  models.generateToken.mockImplementationOnce(async (...args) => {
    committed.resolve();
    await release.promise;
    return actual.generateToken(...args);
  });
  const cancellation = new AbortController();
  const pending = refresh(fixture.cookie, cancellation.signal).catch((error) => ({
    code: error.code,
  }));
  await committed.promise;
  const hashAlreadyChanged = !(await unchanged(fixture));
  cancellation.abort();
  const failure = await pending;
  await records[0].closed.promise;
  release.resolve();
  await records[0].settled.promise;
  const retry = await refresh(fixture.cookie);
  expect({ code: failure.code, hashAlreadyChanged, retryStatus: retry.status }).toEqual({
    code: 'ERR_CANCELED',
    hashAlreadyChanged: true,
    retryStatus: 401,
  });
});

it.each([
  ['first user read', 91],
  ['second session read', 91],
  ['first user read', 13],
  ['second session read', 13],
])('%s storage error %s returns a server failure and preserves the cookie', async (phase, code) => {
  const fixture = await sessionFixture();
  const installFailure = () =>
    mongoose.connection.db.admin().command({
      configureFailPoint: 'failCommand',
      mode: { times: 1 },
      data: { failCommands: ['find'], errorCode: code },
    });
  if (phase === 'first user read') {
    await installFailure();
  } else {
    models.findSession.mockImplementationOnce(async (...args) => {
      await installFailure();
      return actual.findSession(...args);
    });
  }
  const response = await refresh(fixture.cookie);
  const sessionHashUnchanged = await unchanged(fixture);
  const retry = await refresh(fixture.cookie);
  expect({
    status: response.status,
    cookieUntouched: returnedCookie(response) === undefined,
    sessionHashUnchanged,
    retryStatus: retry.status,
  }).toEqual({ status: 500, cookieUntouched: true, sessionHashUnchanged: true, retryStatus: 200 });
});

it.each([undefined, ''])(
  'missing refresh signing configuration (%s) is a server failure',
  async (secret) => {
    const fixture = await sessionFixture();
    const originalSecret = process.env.JWT_REFRESH_SECRET;
    if (secret === undefined) delete process.env.JWT_REFRESH_SECRET;
    else process.env.JWT_REFRESH_SECRET = secret;
    try {
      const response = await refresh(fixture.cookie);
      expect({
        status: response.status,
        cookieUntouched: returnedCookie(response) === undefined,
        tokenIssued: Boolean(response.data?.token),
        sessionHashUnchanged: await unchanged(fixture),
      }).toEqual({
        status: 500,
        cookieUntouched: true,
        tokenIssued: false,
        sessionHashUnchanged: true,
      });
    } finally {
      process.env.JWT_REFRESH_SECRET = originalSecret;
    }
  },
);

it.each(['verification', 'session-read', 'issuance'])(
  'unexpected %s failure denies access without clearing cookies',
  async (stage) => {
    const fixture = await sessionFixture();
    const error = new Error('synthetic-private-diagnostic');
    const verification =
      stage === 'verification'
        ? jest.spyOn(jwt, 'verify').mockImplementationOnce(() => {
            throw error;
          })
        : null;
    if (stage === 'session-read') models.findSession.mockRejectedValueOnce(error);
    if (stage === 'issuance') models.generateToken.mockRejectedValueOnce(error);
    try {
      const response = await refresh(fixture.cookie);
      expect({
        status: response.status,
        cookieUntouched: returnedCookie(response) === undefined,
        tokenIssued: Boolean(response.data?.token),
        privateMessageExposed: JSON.stringify(response.data).includes(error.message),
      }).toEqual({
        status: 500,
        cookieUntouched: true,
        tokenIssued: false,
        privateMessageExposed: false,
      });
      expect(JSON.stringify(schemas.logger.error.mock.calls.at(-1))).not.toContain(error.message);
    } finally {
      verification?.mockRestore();
    }
  },
);

it('retains the known approval rejection without issuing access', async () => {
  const fixture = await sessionFixture();
  assertViventiumApproved.mockRejectedValueOnce(
    Object.assign(new Error('approval rejected'), {
      code: 'synthetic-approval-error',
    }),
  );
  const response = await refresh(fixture.cookie);
  expect({
    status: response.status,
    tokenIssued: Boolean(response.data?.token),
    cookieUntouched: returnedCookie(response) === undefined,
  }).toEqual({ status: 403, tokenIssued: false, cookieUntouched: true });
});

it.each(['user', 'session'])(
  'a verified cookie with no current %s remains rejected',
  async (missing) => {
    const fixture = await sessionFixture();
    const cookie =
      missing === 'user'
        ? jwt.sign(
            { id: new mongoose.Types.ObjectId().toString() },
            process.env.JWT_REFRESH_SECRET,
            { expiresIn: 3600 },
          )
        : fixture.cookie;
    if (missing === 'session') await actual.deleteSession({ sessionId: fixture.id.toString() });
    const response = await refresh(cookie);
    expect({ status: response.status, tokenIssued: Boolean(response.data?.token) }).toEqual({
      status: missing === 'user' ? 302 : 401,
      tokenIssued: false,
    });
    if (missing === 'user') expect(response.headers.location).toBe('/login');
  },
);

/* === VIVENTIUM END === */

it('daily and development refresh and logout remain separate in one host cookie jar', async () => {
  const jar = new CookieJar();
  const base = client.defaults.baseURL;
  async function request(scope, route) {
    process.env.VIVENTIUM_DEV_ENV_ENABLED = scope ? 'true' : 'false';
    if (scope) process.env.VIVENTIUM_DEV_ENV_NAME = scope;
    else delete process.env.VIVENTIUM_DEV_ENV_NAME;
    const url = base + route;
    const response = await client.post(route, undefined, {
      headers: { Cookie: jar.getCookieStringSync(url) },
    });
    for (const cookie of response.headers['set-cookie'] || []) jar.setCookieSync(cookie, url);
    return response;
  }
  expect((await request(null, '/api/auth/test-session')).status).toBe(200);
  const dailyCookie = jar.getCookiesSync(base).find((c) => c.key === 'refreshToken').value;
  expect((await request('QA-One', '/api/auth/test-session')).status).toBe(200);
  expect(jar.getCookiesSync(base).find((c) => c.key === 'refreshToken').value).toBe(dailyCookie);
  expect((await request(null, '/api/auth/refresh')).data).toEqual(
    expect.objectContaining({ token: expect.any(String) }),
  );
  expect((await request('QA-One', '/api/auth/refresh')).data).toEqual(
    expect.objectContaining({ token: expect.any(String) }),
  );
  expect((await request('QA-One', '/api/auth/logout')).status).toBe(200);
  expect((await request('QA-One', '/api/auth/refresh')).data).toBe('Refresh token not provided');
  expect((await request(null, '/api/auth/refresh')).data).toEqual(
    expect.objectContaining({ token: expect.any(String) }),
  );
});
