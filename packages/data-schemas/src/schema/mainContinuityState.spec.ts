import mongoose from 'mongoose';
import { createViventiumMainContinuityStateModel } from '~/models/mainContinuityState';

const database = new mongoose.Mongoose();
const ContinuityState = createViventiumMainContinuityStateModel(database);

const validState = {
  domainEpochKey: 'domain-epoch-synthetic-1',
  continuityDomainId: 'continuity-domain-synthetic-1',
  ownerId: 'owner-synthetic-1',
  agentId: 'agent-synthetic-1',
  contextEpoch: 'context-epoch-synthetic-1',
  stableAuthoritySha256: 'a'.repeat(64),
};

describe('ViventiumMainContinuityState model', () => {
  test('keeps one state per owner, agent, and context epoch', () => {
    expect(ContinuityState.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ domainEpochKey: 1 }, expect.objectContaining({ unique: true })],
        [{ ownerId: 1, agentId: 1, contextEpoch: 1 }, expect.objectContaining({ unique: true })],
      ]),
    );
  });

  test('applies empty continuity defaults', async () => {
    const document = new ContinuityState(validState);

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject()).toMatchObject({
      version: 1,
      acceptedTurns: [],
      pendingCompactionTurns: [],
      acceptedRevisions: [],
      semanticCompaction: null,
      compactionStatus: 'empty',
      compactionLease: null,
      lastCompactionError: '',
    });
  });

  test('rejects invalid revisions, compaction states, and oversized stable keys', async () => {
    await expect(
      new ContinuityState({
        ...validState,
        acceptedRevisions: [{ logicalTurnId: 'turn-1', revision: 0 }],
      }).validate(),
    ).rejects.toThrow();
    await expect(
      new ContinuityState({ ...validState, compactionStatus: 'unknown' }).validate(),
    ).rejects.toThrow();
    await expect(
      new ContinuityState({ ...validState, stableAuthoritySha256: 'a'.repeat(65) }).validate(),
    ).rejects.toThrow();
  });
});
