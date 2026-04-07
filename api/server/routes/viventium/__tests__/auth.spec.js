/* === VIVENTIUM START ===
 * Feature: Operator-issued password reset route tests.
 * === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');

const mockConsumeLocalPasswordReset = jest.fn();

jest.mock('~/server/services/viventium/localPasswordResetService', () => ({
  consumeLocalPasswordReset: (...args) => mockConsumeLocalPasswordReset(...args),
}));

describe('/api/viventium/auth/password-reset', () => {
  beforeEach(() => {
    jest.resetModules();
    mockConsumeLocalPasswordReset.mockReset();
    process.env.DOMAIN_CLIENT = 'https://app.example.com';
  });

  afterEach(() => {
    delete process.env.DOMAIN_CLIENT;
  });

  test('returns an HTML form when token and userId are present', async () => {
    const router = require('../auth');
    const app = express();
    app.use('/api/viventium/auth', router);

    const response = await request(app)
      .get('/api/viventium/auth/password-reset?token=t1&userId=u1')
      .expect(200);

    expect(response.text).toContain('Set a new password');
    expect(response.text).toContain('Update password');
  });

  test('returns 400 when the reset form is missing the token', async () => {
    const router = require('../auth');
    const app = express();
    app.use('/api/viventium/auth', router);

    const response = await request(app).get('/api/viventium/auth/password-reset').expect(400);
    expect(response.text).toContain('Password reset link is incomplete');
  });

  test('submits the password change through the Viventium reset service', async () => {
    mockConsumeLocalPasswordReset.mockResolvedValue({ message: 'Password reset was successful' });
    const router = require('../auth');
    const app = express();
    app.use('/api/viventium/auth', router);

    const response = await request(app)
      .post('/api/viventium/auth/password-reset')
      .type('form')
      .send({
        token: 't1',
        userId: 'u1',
        password: 'new-password-123',
        confirm_password: 'new-password-123',
      })
      .expect(200);

    expect(mockConsumeLocalPasswordReset).toHaveBeenCalledWith({
      userId: 'u1',
      token: 't1',
      password: 'new-password-123',
    });
    expect(response.text).toContain('Password updated');
  });

  test('returns 400 when the confirmation password does not match', async () => {
    const router = require('../auth');
    const app = express();
    app.use('/api/viventium/auth', router);

    const response = await request(app)
      .post('/api/viventium/auth/password-reset')
      .type('form')
      .send({
        token: 't1',
        userId: 'u1',
        password: 'new-password-123',
        confirm_password: 'different-password',
      })
      .expect(400);

    expect(response.text).toContain('does not match');
  });
});
