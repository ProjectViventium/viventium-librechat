import mongoose from 'mongoose';
import { createHash } from 'node:crypto';
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
  test('retains exact optional background source and validates its UTF-8 digest', async () => {
    const text = 'Exact historical inspection: matériau sûr. 次の事実。\n';
    const input = {
      version: 1,
      invocationId: 'invocation',
      deliveryId: 'd'.repeat(64),
      text,
      textSha256: createHash('sha256').update(text).digest('hex'),
      sources: [
        { cortexId: 'cortex', cortexName: 'Synthetic cortex', insightSha256: 'e'.repeat(64) },
      ],
    };
    const turn = {
      logicalTurnId: 'turn',
      revision: 1,
      assistantMessageId: 'answer',
      committedAt: new Date(),
      backgroundInputs: [input],
    };
    const document = new ContinuityState({ ...validState, acceptedTurns: [turn] });
    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.toObject().acceptedTurns[0].backgroundInputs).toEqual([input]);
    const malformed = new ContinuityState({
      ...validState,
      acceptedTurns: [{ ...turn, backgroundInputs: [{ ...input, text: 'Changed' }] }],
    });
    await expect(malformed.validate()).rejects.toThrow('Accepted Main background input is invalid');
  });
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


test('retains the full reviewed replacement and its server-owned allocation', async () => {
  const contract = { version: 1, consumer: 'accepted_core', carrierMaxUtf8Bytes: 12288,
    reservedUtf8Bytes: 1200, maxJsonUtf8Bytes: 11088, maxSummaryUtf8Bytes: 11088,
    maxItemsPerArray: 32, maxStringItemUtf8Bytes: 1024, maxToolIdentityCharacters: 256 };
  const summary = 's'.repeat(8000) + ' Keep permission required.';
  const document = new ContinuityState({ ...validState, semanticCompactionContract: contract,
    semanticCompaction: { version: 1, summary, pendingAsks: [], commitments: [], corrections: [],
      decisions: [], durableIdentifiers: [], recurrenceOutcomes: [], toolPairs: [],
      sourceDigest: 'b'.repeat(64), generatedAt: new Date() },
    compactionLease: { leaseId: 'lease', sourceDigest: 'b'.repeat(64), sourceTurnIds: [],
      claimedAt: new Date(), expiresAt: new Date(Date.now() + 1000), outputContract: contract } });
  await expect(document.validate()).resolves.toBeUndefined();
  expect(document.toObject().semanticCompaction?.summary).toBe(summary);
  expect(document.toObject().semanticCompactionContract).toEqual(contract);
  expect(document.toObject().compactionLease?.outputContract).toEqual(contract);
});


test('persists the typed pending repair separately from accepted semantic context', async () => {
  const pendingCompactionRepair = { version: 1, sourceDigest: 'd'.repeat(64),
    contractKey: 'exact-route-contract', semanticAttempts: 1, transportRetries: 0,
    sourceGeneration: 2, sourceTurnKeys: ['source:1'],
    correction: { code: 'semantic_fidelity', candidate: '{"summary":"unaccepted"}',
      reason: 'Preserve the exact reference.' } };
  const document = new ContinuityState({ ...validState, pendingCompactionRepair });
  await expect(document.validate()).resolves.toBeUndefined();
  expect(document.toObject().pendingCompactionRepair).toEqual(pendingCompactionRepair);
  expect(document.toObject().semanticCompaction).toBeNull();
  await expect(new ContinuityState({ ...validState, pendingCompactionRepair: {
    ...pendingCompactionRepair, correction: { ...pendingCompactionRepair.correction, code: 'schema_invalid' },
  } }).validate()).rejects.toThrow();
});


test('retains numeric size feedback without an oversized candidate or accepted summary', async () => {
  const pendingCompactionRepair = { version: 1, sourceDigest: 'd'.repeat(64),
    contractKey: 'exact-route-contract', semanticAttempts: 2, transportRetries: 0,
    sourceGeneration: 2, sourceTurnKeys: ['source:1'],
    sizeRepair: { proposalBytes: 94000, previousProposalBytes: 96000, converging: true },
    correction: { code: 'schema_invalid', issue: { path: '', constraint: 'max_bytes',
      actual: 94000, limit: 75000, proposalBytes: 94000, excessBytes: 19000, unit: 'utf8_bytes' } } };
  const document = new ContinuityState({ ...validState, pendingCompactionRepair });
  await expect(document.validate()).resolves.toBeUndefined();
  expect(document.toObject().pendingCompactionRepair).toEqual(pendingCompactionRepair);
  expect(document.toObject().semanticCompaction).toBeNull();
});
