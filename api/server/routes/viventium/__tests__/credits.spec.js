/* === VIVENTIUM START ===
 * Feature: Credits request endpoint tests.
 * Added: 2026-02-18
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');

const mockFetch = jest.fn();
const mockIsEnabled = jest.fn();
const mockRequireJwtAuth = jest.fn();
const mockGetUserById = jest.fn();
const mockCreditsFindOne = jest.fn();
const mockCreditsCreate = jest.fn();
const mockCreditsUpdateOne = jest.fn();
const mockBalanceFindOne = jest.fn();
const mockSendAdminMessage = jest.fn();

jest.mock('node-fetch', () => (...args) => mockFetch(...args));

jest.mock('@librechat/api', () => ({
  isEnabled: (...args) => mockIsEnabled(...args),
}));

jest.mock(
  '@librechat/data-schemas',
  () => ({
    logger: {
      warn: jest.fn(),
      error: jest.fn(),
      info: jest.fn(),
      debug: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (...args) => mockRequireJwtAuth(...args),
}));

jest.mock('~/models', () => ({
  getUserById: (...args) => mockGetUserById(...args),
}));

jest.mock('~/db/models', () => ({
  Balance: {
    findOne: (...args) => mockBalanceFindOne(...args),
  },
  ViventiumCreditsRequest: {
    findOne: (...args) => mockCreditsFindOne(...args),
    create: (...args) => mockCreditsCreate(...args),
    updateOne: (...args) => mockCreditsUpdateOne(...args),
  },
}));

jest.mock('~/server/services/viventium/telegramNotifier', () => ({
  sendAdminMessage: (...args) => mockSendAdminMessage(...args),
}));

function findOneQuery(result) {
  return {
    sort: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(result),
    }),
  };
}

describe('/api/viventium/credits/request', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockReset();
    mockIsEnabled.mockReset();
    mockRequireJwtAuth.mockReset();
    mockGetUserById.mockReset();
    mockCreditsFindOne.mockReset();
    mockCreditsCreate.mockReset();
    mockCreditsUpdateOne.mockReset();
    mockBalanceFindOne.mockReset();
    mockSendAdminMessage.mockReset();

    process.env.VIVENTIUM_GEO_FILTER_ENABLED = 'true';

    mockIsEnabled.mockImplementation((value) => String(value).toLowerCase() === 'true');
    mockRequireJwtAuth.mockImplementation((req, _res, next) => {
      req.user = { id: '507f191e810c19729de860ea' };
      next();
    });
    mockGetUserById.mockResolvedValue({
      _id: '507f191e810c19729de860ea',
      name: 'Avery',
      username: 'avery',
      email: 'avery@example.com',
    });
    mockBalanceFindOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ tokenCredits: 42000 }),
    });
    mockCreditsCreate.mockResolvedValue({ _id: 'req_1' });
    mockCreditsUpdateOne.mockResolvedValue({ acknowledged: true });
    mockSendAdminMessage.mockResolvedValue(true);
  });

  function createApp() {
    const router = require('../credits');
    const app = express();
    app.use(express.json());
    app.use('/api/viventium/credits', router);
    return app;
  }

  test('notifies admin and stores audit for North America requests', async () => {
    mockCreditsFindOne.mockReturnValue(findOneQuery(null));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        continent_code: 'NA',
        country: 'CA',
        country_name: 'Canada',
        city: 'Toronto',
      }),
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/viventium/credits/request')
      .set('x-forwarded-for', '198.51.100.4')
      .send({})
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(mockCreditsCreate).toHaveBeenCalledTimes(1);
    expect(mockSendAdminMessage).toHaveBeenCalledTimes(1);
    expect(mockCreditsUpdateOne).toHaveBeenCalledWith(
      { _id: 'req_1' },
      { $set: { notifiedAdmin: true } },
    );
  });

  test('stores audit but does not notify admin for outside NA/EU', async () => {
    mockCreditsFindOne.mockReturnValue(findOneQuery(null));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        continent_code: 'AS',
        country: 'IN',
        country_name: 'India',
        city: 'Mumbai',
      }),
    });

    const app = createApp();
    const response = await request(app)
      .post('/api/viventium/credits/request')
      .set('x-forwarded-for', '198.51.100.5')
      .send({})
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(mockCreditsCreate).toHaveBeenCalledTimes(1);
    expect(mockSendAdminMessage).not.toHaveBeenCalled();
    expect(mockCreditsUpdateOne).toHaveBeenCalledWith(
      { _id: 'req_1' },
      { $set: { notifiedAdmin: false } },
    );
  });

  test('returns cooldown message and skips notification when duplicate exists', async () => {
    mockCreditsFindOne.mockReturnValue(findOneQuery({ _id: 'prev_1' }));

    const app = createApp();
    const response = await request(app).post('/api/viventium/credits/request').send({}).expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.cooldown).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCreditsCreate).not.toHaveBeenCalled();
    expect(mockSendAdminMessage).not.toHaveBeenCalled();
  });
});
