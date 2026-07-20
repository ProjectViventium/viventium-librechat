/* === VIVENTIUM START ===
 * Feature: Truthful connected-account status tests
 * === VIVENTIUM END === */

import { decrypt } from '~/crypto';
import { createKeyMethods } from './key';

jest.mock('~/crypto', () => ({
  decrypt: jest.fn(),
  encrypt: jest.fn(),
}));

jest.mock('~/config/winston', () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

describe('key methods', () => {
  const mockDecrypt = jest.mocked(decrypt);
  const lean = jest.fn();
  const findOne = jest.fn(() => ({ lean }));
  const mongoose = {
    models: {
      Key: { findOne },
    },
  } as never;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reports a decryptable non-expiring key as connected', async () => {
    lean.mockResolvedValue({ value: 'encrypted-value' });
    mockDecrypt.mockResolvedValue('decrypted-value');
    const methods = createKeyMethods(mongoose);

    await expect(methods.getUserKeyExpiry({ userId: 'user-1', name: 'openAI' })).resolves.toEqual({
      expiresAt: 'never',
    });
  });

  test('reports an unreadable key as disconnected', async () => {
    lean.mockResolvedValue({ value: 'stale-encrypted-value' });
    mockDecrypt.mockRejectedValue(new Error('decrypt failed'));
    const methods = createKeyMethods(mongoose);

    await expect(methods.getUserKeyExpiry({ userId: 'user-1', name: 'openAI' })).resolves.toEqual({
      expiresAt: null,
    });
  });

  test('reports a missing key as disconnected without attempting decryption', async () => {
    lean.mockResolvedValue(null);
    const methods = createKeyMethods(mongoose);

    await expect(methods.getUserKeyExpiry({ userId: 'user-1', name: 'openAI' })).resolves.toEqual({
      expiresAt: null,
    });
    expect(mockDecrypt).not.toHaveBeenCalled();
  });
});
