import mongoose from 'mongoose';
import { createViventiumGlassHiveCallbackEffectOutboxModel } from '~/models/glassHiveCallbackEffectOutbox';

const database = new mongoose.Mongoose();
const Outbox = createViventiumGlassHiveCallbackEffectOutboxModel(database);

const validOutbox = {
  outboxId: 'gh-effect-outbox-synthetic-1',
  destination: 'scheduler',
  ownerId: 'owner-synthetic-1',
  occurrenceKey: 'occurrence-synthetic-1',
  summary: {
    requiredTotal: 2,
    requiredTerminal: 2,
    requiredFailed: 0,
    allRequiredTerminal: true,
    state: 'completed',
  },
  terminalCallbackResultKey: 'result-synthetic-1',
  terminalCallbackAcceptedOperationId: '00000000000000000000000000000001',
  terminalCallbackId: `cb_terminal_${'a'.repeat(64)}`,
  terminalCallbackResultDigest: `sha256:${'b'.repeat(64)}`,
  terminalCallbackResultRevision: 1,
  terminalCallbackEffectGeneration: 1,
  expiresAt: new Date('2026-09-01T00:00:00.000Z'),
};

describe('ViventiumGlassHiveCallbackEffectOutbox model', () => {
  test('preserves the durable claim, dispatch, and TTL indexes', () => {
    expect(Outbox.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ outboxId: 1 }, expect.objectContaining({ unique: true })],
        [{ expiresAt: 1 }, expect.objectContaining({ expireAfterSeconds: 0 })],
        [{ destination: 1, status: 1, nextAttemptAt: 1, createdAt: 1 }, expect.any(Object)],
      ]),
    );
  });

  test('accepts the scheduler contract and applies safe claim defaults', async () => {
    const document = new Outbox(validOutbox);

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).toMatchObject({
      status: 'pending',
      claimId: '',
      claimExpiresAt: null,
      dispatchPermitId: '',
      dispatchPermitGeneration: 0,
      dispatchPermitExpiresAt: null,
      attempts: 0,
      nextAttemptAt: null,
      sentAt: null,
      lastError: '',
    });
  });

  test('rejects unsupported destinations, statuses, and incomplete summaries', async () => {
    await expect(
      new Outbox({ ...validOutbox, destination: 'untrusted' }).validate(),
    ).rejects.toThrow();
    await expect(new Outbox({ ...validOutbox, status: 'unknown' }).validate()).rejects.toThrow();
    await expect(
      new Outbox({ ...validOutbox, summary: { state: 'completed' } }).validate(),
    ).rejects.toThrow();
  });
});
