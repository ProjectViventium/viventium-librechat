/**
 * === VIVENTIUM START ===
 * Feature: Authenticated channel credential storage.
 * Purpose: Prove IV, ciphertext, and tag tampering always fails closed.
 * === VIVENTIUM END ===
 */

import {
  decryptChannelCredentialsV4,
  encryptChannelCredentialsV4,
  isChannelCredentialV4,
} from './index';

function flipFirstHex(value: string): string {
  return `${value[0] === '0' ? '1' : '0'}${value.slice(1)}`;
}

describe('channel credential v4 envelope', () => {
  const priorKey = process.env.CREDS_KEY;

  beforeAll(() => {
    process.env.CREDS_KEY = '11'.repeat(32);
  });

  afterAll(() => {
    if (priorKey == null) {
      delete process.env.CREDS_KEY;
    } else {
      process.env.CREDS_KEY = priorKey;
    }
  });

  it('round-trips only through the domain-separated AES-256-GCM format', async () => {
    const encrypted = await encryptChannelCredentialsV4('{"botToken":"synthetic"}');
    expect(isChannelCredentialV4(encrypted)).toBe(true);
    await expect(decryptChannelCredentialsV4(encrypted)).resolves.toBe('{"botToken":"synthetic"}');
  });

  it.each([1, 2, 3])('rejects tampering with envelope segment %s', async (segment) => {
    const encrypted = await encryptChannelCredentialsV4('{"botToken":"synthetic"}');
    const parts = encrypted.split(':');
    parts[segment] = flipFirstHex(parts[segment]);
    await expect(decryptChannelCredentialsV4(parts.join(':'))).rejects.toThrow(
      'Channel credentials could not be authenticated',
    );
  });
});
