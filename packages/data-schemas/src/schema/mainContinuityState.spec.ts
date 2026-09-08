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
  test('keeps deterministic storage identities without treating structural records as epochs', () => {
    expect(ContinuityState.schema.indexes()).toEqual(
      expect.arrayContaining([
        [{ domainEpochKey: 1 }, expect.objectContaining({ unique: true })],
        [
          { ownerId: 1, continuityDomainId: 1, recordKind: 1, domainEpochKey: 1 },
          expect.any(Object),
        ],
      ]),
    );
    expect(ContinuityState.schema.indexes()).not.toEqual(
      expect.arrayContaining([[{ ownerId: 1, agentId: 1, contextEpoch: 1 }, expect.any(Object)]]),
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

  test('persists source-only accepted references and scheduler provenance', async () => {
    const document = new ContinuityState({
      ...validState,
      acceptedTurns: [
        {
          logicalTurnId: 'scheduled-turn',
          revision: 1,
          assistantMessageId: 'scheduled-answer',
          userMessageId: 'internal-envelope',
          conversationId: 'schedule-conversation',
          origin: 'scheduler',
          scheduleId: 'synthetic-schedule',
          scheduleRunId: 'synthetic-run',
          committedAt: new Date(),
        },
      ],
    });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject().acceptedTurns[0]).toMatchObject({
      assistantText: '',
      userText: '',
      scheduleId: 'synthetic-schedule',
      scheduleRunId: 'synthetic-run',
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
