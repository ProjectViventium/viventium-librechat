/* === VIVENTIUM START ===
 * Feature: Registration approval decision route tests.
 * Added: 2026-02-18
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');

const mockApplyRegistrationDecision = jest.fn();

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

jest.mock('~/server/services/viventium/registrationApprovalService', () => ({
  applyRegistrationDecision: (...args) => mockApplyRegistrationDecision(...args),
}));

describe('/api/viventium/registration/decision', () => {
  beforeEach(() => {
    jest.resetModules();
    mockApplyRegistrationDecision.mockReset();
  });

  test('returns 400 when token/action is missing', async () => {
    const router = require('../registration');
    const app = express();
    app.use('/api/viventium/registration', router);

    const response = await request(app).get('/api/viventium/registration/decision').expect(400);
    expect(response.text).toContain('Missing token or action');
  });

  test('applies decision and returns success HTML', async () => {
    mockApplyRegistrationDecision.mockResolvedValue({
      userId: 'user_123',
      status: 'approved',
    });
    const router = require('../registration');
    const app = express();
    app.use('/api/viventium/registration', router);

    const response = await request(app)
      .get('/api/viventium/registration/decision?token=t1&action=approve')
      .expect(200);

    expect(mockApplyRegistrationDecision).toHaveBeenCalledWith({ token: 't1', action: 'approve' });
    expect(response.text).toContain('marked as approved');
  });

  test('returns 400 when decision application fails', async () => {
    mockApplyRegistrationDecision.mockRejectedValue(new Error('Invalid decision token'));
    const router = require('../registration');
    const app = express();
    app.use('/api/viventium/registration', router);

    const response = await request(app)
      .get('/api/viventium/registration/decision?token=t1&action=approve')
      .expect(400);

    expect(response.text).toContain('Invalid decision token');
  });
});
