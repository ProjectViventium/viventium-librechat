/* === VIVENTIUM START ===
 * Feature: LibreChat Telegram Link - /api/viventium/telegram/link tests
 * Added: 2026-01-15
 * === VIVENTIUM END === */

const express = require('express');

let mockResolveUserIdFromCookies;
let mockConsumeLinkToken;
let mockUpsertTelegramMapping;
let mockGetUserById;

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('~/server/services/TelegramLinkService', () => ({
  resolveUserIdFromCookies: (...args) => mockResolveUserIdFromCookies(...args),
  consumeLinkToken: (...args) => mockConsumeLinkToken(...args),
  upsertTelegramMapping: (...args) => mockUpsertTelegramMapping(...args),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
}));

function createTestApp(router) {
  const app = express();
  app.use('/api/viventium/telegram', router);
  return app;
}

function createMockReq({ method = 'GET', url, headers = {} } = {}) {
  const normalized = {};
  Object.entries(headers).forEach(([key, value]) => {
    normalized[key.toLowerCase()] = value;
  });
  let path = url.split('?')[0];
  const basePrefix = '/api/viventium/telegram';
  if (path.startsWith(basePrefix)) {
    path = path.slice(basePrefix.length) || '/';
  }

  return {
    method,
    url,
    originalUrl: url,
    path,
    headers: normalized,
    get(name) {
      return normalized[name.toLowerCase()] || '';
    },
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    setHeader: jest.fn((name, value) => {
      res.headers[name] = value;
    }),
    status(code) {
      res.statusCode = code;
      return res;
    },
    send: jest.fn((payload) => {
      res.body = payload;
      res.writableEnded = true;
      if (res._resolve) {
        res._resolve();
      }
      return res;
    }),
  };

  res._done = new Promise((resolve, reject) => {
    res._resolve = resolve;
    res._reject = reject;
  });

  return res;
}

function dispatch(app, req, res) {
  app.handle(req, res, (err) => {
    if (err && res._reject) {
      res._reject(err);
    } else if (!res.writableEnded && res._resolve) {
      res._resolve();
    }
  });
  return res._done;
}

describe('/api/viventium/telegram/link', () => {
  beforeEach(() => {
    jest.resetModules();
    mockResolveUserIdFromCookies = jest.fn();
    mockConsumeLinkToken = jest.fn();
    mockUpsertTelegramMapping = jest.fn();
    mockGetUserById = jest.fn();
  });

  test('GET requires login', async () => {
    mockResolveUserIdFromCookies.mockReturnValue('');

    const linkRouter = require('../telegram_link');
    const app = createTestApp(linkRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/link/test-token',
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(401);
  });

  test('GET returns 400 for expired token', async () => {
    mockResolveUserIdFromCookies.mockReturnValue('user_1');
    mockGetUserById.mockResolvedValue({ _id: 'user_1' });
    mockConsumeLinkToken.mockResolvedValue(null);

    const linkRouter = require('../telegram_link');
    const app = createTestApp(linkRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/link/test-token',
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(400);
  });

  test('GET links when token and user are valid', async () => {
    mockResolveUserIdFromCookies.mockReturnValue('user_1');
    mockGetUserById.mockResolvedValue({ _id: 'user_1' });
    mockConsumeLinkToken.mockResolvedValue({
      telegramUserId: 'tg-1',
      telegramUsername: 'testuser',
    });
    mockUpsertTelegramMapping.mockResolvedValue({});

    const linkRouter = require('../telegram_link');
    const app = createTestApp(linkRouter);
    const req = createMockReq({
      url: '/api/viventium/telegram/link/test-token',
    });
    const res = createMockRes();

    await dispatch(app, req, res);
    expect(res.statusCode).toBe(200);
    expect(mockUpsertTelegramMapping).toHaveBeenCalledWith({
      telegramUserId: 'tg-1',
      libreChatUserId: 'user_1',
      telegramUsername: 'testuser',
    });
  });
});
