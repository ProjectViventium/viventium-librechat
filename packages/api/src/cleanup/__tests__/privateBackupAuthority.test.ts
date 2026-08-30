import { createHash, generateKeyPairSync, sign } from 'crypto';
import {
  cleanupTargetBindingsSha256,
  createTrustedPrivateBackupAuthorityVerifier,
  serializePersonalAccountCleanupAuthorityPayload,
} from '../privateBackupAuthority';
import type {
  CleanupBackupAuthority,
  CleanupBackupAuthorityPayload,
  CleanupOperationRegistration,
} from '../types';

const NOW = new Date('2026-08-25T16:00:00.000Z');
const OWNER_ID = 'owner-cleanup-1';
const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonical(value: object): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = value[key as keyof typeof value];
        return result;
      }, {}),
  );
}

function registration(): CleanupOperationRegistration {
  const recoveryReceiptBase = {
    contractVersion: 1 as const,
    backupId: 'backup-20260825T155500Z-0123456789ab',
    ownerScopeHash: `sha256:${sha256(OWNER_ID)}`,
    reviewSetSha256: HEX_B,
    manifestSha256: HEX_A,
    artifactSetSha256: HEX_C,
    restoreVerification: 'verified' as const,
    status: 'verified' as const,
    createdAt: '2026-08-25T15:55:00.000Z',
  };
  const recoveryReceipt = {
    ...recoveryReceiptBase,
    receiptSha256: sha256(canonical(recoveryReceiptBase)),
  };
  return {
    operationId: 'cleanup-operation-1',
    ownerId: OWNER_ID,
    ownerScopeHash: `sha256:${sha256(OWNER_ID)}`,
    planSha256: HEX_A,
    backupReceiptSha256: recoveryReceipt.receiptSha256,
    reviewSetSha256: HEX_B,
    recoveryReceipt,
    nonceHash: `sha256:${HEX_C}`,
    targetSetSha256: HEX_A,
    notBefore: '2026-08-25T16:15:00.000Z',
    at: NOW.toISOString(),
    targets: [
      {
        kind: 'message',
        resourceId: 'message-cleanup-1',
        expectedRevision: 4,
        expectedUpdatedAt: '2026-08-25T15:50:00.000Z',
        stateSha256: HEX_A,
        preimageSha256: HEX_A,
        reviewBindingSha256: HEX_B,
        runNonceHash: `sha256:${HEX_C}`,
      },
    ],
  };
}

describe('trusted private backup authority', () => {
  const keys = generateKeyPairSync('ed25519');

  function signedAuthority(
    value: CleanupOperationRegistration = registration(),
  ): CleanupBackupAuthority {
    const payload: CleanupBackupAuthorityPayload = {
      contractVersion: 1,
      authorityId: 'cleanup-authority-1',
      purpose: 'reviewed_personal_account_synthetic_qa_cleanup',
      reviewedCleanupApproved: true,
      ownerScopeHash: value.ownerScopeHash,
      operationId: value.operationId,
      planSha256: value.planSha256,
      backupReceiptSha256: value.backupReceiptSha256,
      reviewSetSha256: value.reviewSetSha256,
      targetSetSha256: value.targetSetSha256,
      targetBindingsSha256: cleanupTargetBindingsSha256(value.targets),
      nonceHash: value.nonceHash,
      backupId: value.recoveryReceipt.backupId,
      backupCreatedAt: value.recoveryReceipt.createdAt,
      issuedAt: '2026-08-25T15:59:00.000Z',
      expiresAt: '2026-08-25T17:00:00.000Z',
    };
    return {
      ...payload,
      proof: `ed25519:${sign(
        null,
        Buffer.from(serializePersonalAccountCleanupAuthorityPayload(payload), 'utf8'),
        keys.privateKey,
      ).toString('base64url')}`,
    };
  }

  function verifier() {
    return createTrustedPrivateBackupAuthorityVerifier({
      publicKey: keys.publicKey,
      now: () => NOW,
      maximumLifetimeMs: 2 * 60 * 60 * 1000,
    });
  }

  test('accepts only a current signed authority bound to the exact recovery and targets', async () => {
    const value = registration();

    await expect(
      verifier()({
        backupAuthority: signedAuthority(value),
        recoveryReceipt: value.recoveryReceipt,
        registration: value,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        verified: true,
        authorityId: 'cleanup-authority-1',
        authoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        expiresAt: '2026-08-25T17:00:00.000Z',
      }),
    );
  });

  test('rejects missing or forged backup authority', async () => {
    const value = registration();
    await expect(
      verifier()({
        backupAuthority: undefined,
        recoveryReceipt: value.recoveryReceipt,
        registration: value,
      }),
    ).rejects.toThrow('cleanup_backup_authority_missing');

    const authority = signedAuthority(value);
    await expect(
      verifier()({
        backupAuthority: { ...authority, proof: `${authority.proof.slice(0, -2)}aa` },
        recoveryReceipt: value.recoveryReceipt,
        registration: value,
      }),
    ).rejects.toThrow('cleanup_backup_authority_forged');
  });

  test('rejects wrong-owner and stale authority', async () => {
    const value = registration();
    await expect(
      verifier()({
        backupAuthority: signedAuthority(value),
        recoveryReceipt: value.recoveryReceipt,
        registration: {
          ...value,
          ownerId: 'owner-cleanup-2',
          ownerScopeHash: `sha256:${sha256('owner-cleanup-2')}`,
        },
      }),
    ).rejects.toThrow('cleanup_backup_authority_owner_mismatch');

    const staleVerifier = createTrustedPrivateBackupAuthorityVerifier({
      publicKey: keys.publicKey,
      now: () => new Date('2026-08-25T17:00:00.001Z'),
      maximumLifetimeMs: 2 * 60 * 60 * 1000,
    });
    await expect(
      staleVerifier({
        backupAuthority: signedAuthority(value),
        recoveryReceipt: value.recoveryReceipt,
        registration: value,
      }),
    ).rejects.toThrow('cleanup_backup_authority_stale');
  });

  test('rejects target or revision substitution after review', async () => {
    const value = registration();
    const authority = signedAuthority(value);
    const substituted = {
      ...value,
      targets: value.targets.map((target) => ({ ...target, expectedRevision: 5 })),
    };

    await expect(
      verifier()({
        backupAuthority: authority,
        recoveryReceipt: value.recoveryReceipt,
        registration: substituted,
      }),
    ).rejects.toThrow('cleanup_backup_authority_target_binding_mismatch');
  });
});
