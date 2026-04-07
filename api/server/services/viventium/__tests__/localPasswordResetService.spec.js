/* === VIVENTIUM START ===
 * Feature: Operator-issued password reset link service tests.
 * === VIVENTIUM END === */

const bcrypt = require('bcryptjs');

const mockFindUser = jest.fn();
const mockFindToken = jest.fn();
const mockCreateToken = jest.fn();
const mockDeleteTokens = jest.fn();
const mockUpdateUser = jest.fn();

jest.mock('~/models', () => ({
  findUser: (...args) => mockFindUser(...args),
  findToken: (...args) => mockFindToken(...args),
  createToken: (...args) => mockCreateToken(...args),
  deleteTokens: (...args) => mockDeleteTokens(...args),
  updateUser: (...args) => mockUpdateUser(...args),
}));

describe('localPasswordResetService', () => {
  beforeEach(() => {
    jest.resetModules();
    mockFindUser.mockReset();
    mockFindToken.mockReset();
    mockCreateToken.mockReset();
    mockDeleteTokens.mockReset();
    mockUpdateUser.mockReset();
  });

  test('issues a reset link bound to the Viventium auth route', async () => {
    mockFindUser.mockResolvedValue({ _id: 'user_123', email: 'person@example.com' });
    mockCreateToken.mockResolvedValue({});
    mockDeleteTokens.mockResolvedValue({});

    const {
      issueLocalPasswordResetLink,
      LOCAL_PASSWORD_RESET_EXPIRES_SECONDS,
    } = require('../localPasswordResetService');

    const result = await issueLocalPasswordResetLink({
      email: 'person@example.com',
      clientOrigin: 'https://app.example.com',
    });

    expect(mockDeleteTokens).toHaveBeenCalledWith({
      identifier: 'viventium_local_password_reset:user_123',
    });
    expect(mockCreateToken).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_123',
        identifier: 'viventium_local_password_reset:user_123',
        type: 'viventium_local_password_reset',
        expiresIn: LOCAL_PASSWORD_RESET_EXPIRES_SECONDS,
      }),
    );
    expect(result.email).toBe('person@example.com');
    expect(result.link).toContain('/api/viventium/auth/password-reset?token=');
    expect(result.link).toContain('userId=user_123');
  });

  test('consumes a valid reset token and updates the password', async () => {
    const hashedToken = bcrypt.hashSync('raw-reset-token', 10);
    mockFindToken.mockResolvedValue({ token: hashedToken });
    mockUpdateUser.mockResolvedValue({});
    mockDeleteTokens.mockResolvedValue({});

    const { consumeLocalPasswordReset } = require('../localPasswordResetService');

    await consumeLocalPasswordReset({
      userId: 'user_123',
      token: 'raw-reset-token',
      password: 'new-password-123',
    });

    expect(mockFindToken).toHaveBeenCalledWith(
      {
        userId: 'user_123',
        identifier: 'viventium_local_password_reset:user_123',
      },
      { sort: { createdAt: -1 } },
    );
    expect(mockUpdateUser).toHaveBeenCalledWith(
      'user_123',
      expect.objectContaining({
        password: expect.any(String),
        passwordVersion: expect.any(Number),
      }),
    );
    expect(mockDeleteTokens).toHaveBeenCalledWith({
      identifier: 'viventium_local_password_reset:user_123',
    });
  });

  test('rejects an invalid reset token', async () => {
    mockFindToken.mockResolvedValue({ token: bcrypt.hashSync('different-token', 10) });
    const { consumeLocalPasswordReset } = require('../localPasswordResetService');

    await expect(
      consumeLocalPasswordReset({
        userId: 'user_123',
        token: 'wrong-token',
        password: 'new-password-123',
      }),
    ).rejects.toThrow('Invalid or expired password reset token');
  });
});
