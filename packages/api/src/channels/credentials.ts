/**
 * === VIVENTIUM START ===
 * Feature: Connected channel credential storage.
 * Purpose: Reuse LibreChat's shared CREDS_KEY encryption contract through explicit injection.
 * === VIVENTIUM END ===
 */

import type { ChannelCredentials } from './types';

type EncryptCredential = (plaintext: string) => Promise<string>;
type DecryptCredential = (ciphertext: string) => Promise<string>;

function isCredentialRecord(value: unknown): value is ChannelCredentials {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((item) => typeof item === 'string');
}

export class ChannelCredentialVault {
  constructor(
    private readonly encryptCredential: EncryptCredential,
    private readonly decryptCredential: DecryptCredential,
  ) {}

  async encrypt(credentials: ChannelCredentials): Promise<string> {
    return await this.encryptCredential(JSON.stringify(credentials));
  }

  async decrypt(encryptedCredentials: string): Promise<ChannelCredentials> {
    let parsed: unknown;
    try {
      const plaintext = await this.decryptCredential(encryptedCredentials);
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error('credentials could not be decrypted');
    }
    if (!isCredentialRecord(parsed)) {
      throw new Error('credentials could not be decrypted');
    }
    return parsed;
  }
}
