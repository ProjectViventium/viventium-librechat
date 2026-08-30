/* === VIVENTIUM START ===
 * Feature: Durable cortex insight delivery ledger tests.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

jest.mock(
  '@librechat/data-schemas',
  () => ({
    ...jest.requireActual('@librechat/data-schemas'),
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
    },
  }),
  { virtual: true },
);

jest.mock('~/db/models', () => ({
  ViventiumCortexInsightDelivery: {},
}));

const {
  CORTEX_INSIGHT_DROP_REASONS,
  CORTEX_INSIGHT_RETRYABLE_FAILURE_REASONS,
  buildCortexInsightDeliveryCandidates,
  createCortexInsightDeliveryService,
  normalizeCortexFeelingSnapshot,
  requireExactCortexInsightDeliverySettlement,
  resolveCortexRuntimeSlotIdentity,
  selectClaimedCortexInsights,
} = require('../CortexInsightDeliveryService');

function exactFeelingSnapshot(overrides = {}) {
  return {
    available: true,
    enabled: true,
    agentScope: 'all_agents',
    version: 41,
    asOf: '2026-08-22T12:00:00.000Z',
    capsule: 'Synthetic request-pinned Feelings capsule.',
    snapshotHash: 'a'.repeat(64),
    rangePromptOverrideCount: 3,
    activeRangePromptOverrideCount: 2,
    activeRangePromptOverrideChars: 120,
    ...overrides,
  };
}

function leanResult(value) {
  return { lean: async () => value };
}

function createBatchStateModel(initialRows, { failClaimFor = '', failSettlementFor = '' } = {}) {
  const cloneRow = (row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
    );
  const state = initialRows.map((row) =>
    cloneRow({
      graphResultHash: row.graphResultHash || row.insightHash || 'a'.repeat(64),
      ...row,
    }),
  );
  let settlementFailureInjected = false;
  const matches = (row, filter = {}) => {
    for (const [key, expected] of Object.entries(filter)) {
      if (key.startsWith('$')) continue;
      if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
        if (
          '$gt' in expected &&
          !(new Date(row[key]).getTime() > new Date(expected.$gt).getTime())
        ) {
          return false;
        }
        if ('$eq' in expected && row[key] !== expected.$eq) return false;
        if ('$in' in expected && !expected.$in.includes(row[key] ?? null)) return false;
        if ('$ne' in expected && row[key] === expected.$ne) return false;
        if ('$all' in expected && !expected.$all.every((value) => row[key]?.includes(value))) {
          return false;
        }
        continue;
      }
      if (row[key] !== expected) return false;
    }
    return true;
  };
  const query = (read) => {
    const chain = {
      select: jest.fn(() => chain),
      sort: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      session: jest.fn(() => chain),
      lean: jest.fn(async () => read()),
    };
    return chain;
  };
  const applyUpdate = (row, update) => {
    Object.assign(row, update.$set || {});
    for (const [key, amount] of Object.entries(update.$inc || {})) {
      row[key] = (Number(row[key]) || 0) + amount;
    }
    for (const [key, value] of Object.entries(update.$addToSet || {})) {
      const values = Array.isArray(row[key]) ? row[key] : [];
      if (!values.includes(value)) values.push(value);
      row[key] = values;
    }
    return row;
  };
  const Model = {
    find: jest.fn((filter = {}) =>
      query(() => state.filter((row) => matches(row, filter)).map(cloneRow)),
    ),
    findOne: jest.fn((filter = {}) =>
      query(() => {
        const row = state.find((candidate) => matches(candidate, filter));
        return row ? cloneRow(row) : null;
      }),
    ),
    findOneAndUpdate: jest.fn((filter, update) => {
      const row = state.find((candidate) => matches(candidate, filter));
      const isClaim = update?.$set?.status === 'claimed';
      const isSettlement =
        update?.$set?.persistenceStatus === 'persisted' ||
        update?.$set?.status === 'sent' ||
        update?.$set?.status === 'dropped';
      if (
        !row ||
        (isClaim && row.deliveryId === failClaimFor) ||
        (isSettlement && row.deliveryId === failSettlementFor && !settlementFailureInjected)
      ) {
        if (isSettlement && row.deliveryId === failSettlementFor) {
          settlementFailureInjected = true;
        }
        return query(() => null);
      }
      applyUpdate(row, update);
      return query(() => cloneRow(row));
    }),
  };
  return { Model, state };
}

describe('CortexInsightDeliveryService', () => {
  test('records pending work without a retention expiry', async () => {
    const Model = {
      findOneAndUpdate: jest.fn((_filter, update) =>
        leanResult({ ...update.$setOnInsert, ...(update.$set || {}) }),
      ),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    const result = await service.recordBatch({
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'web',
      insights: [{ cortexId: 'review', insight: 'Keep this result retryable.' }],
    });

    const update = Model.findOneAndUpdate.mock.calls[0][1];
    expect(update.$setOnInsert.expiresAt).toBeUndefined();
    expect(update.$set?.expiresAt).toBeUndefined();
    expect(result.deliveries[0]).not.toHaveProperty('expiresAt');
  });

  test('stores a bounded private request-pinned Feelings receipt without exposing it', async () => {
    const Model = {
      findOneAndUpdate: jest.fn((_filter, update) => leanResult(update.$setOnInsert)),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({ DeliveryModel: Model });
    const feelingSnapshot = {
      available: true,
      enabled: true,
      agentScope: 'all_agents',
      version: 41,
      asOf: '2026-08-22T12:00:00.000Z',
      capsule: 'Synthetic request-pinned Feelings capsule.',
      snapshotHash: 'a'.repeat(64),
      rangePromptOverrideCount: 3,
      activeRangePromptOverrideCount: 2,
      activeRangePromptOverrideChars: 120,
      bands: { private: 'must not be copied' },
      trail: ['must not be copied'],
    };

    const receipt = await service.recordBatch({
      ownerId: 'owner-feelings',
      conversationId: 'conversation-feelings',
      parentMessageId: 'parent-feelings',
      surface: 'telegram',
      feelingSnapshot,
      insights: [{ cortexId: 'review', insight: 'A durable result.' }],
    });

    expect(Model.findOneAndUpdate.mock.calls[0][1].$setOnInsert.feelingSnapshot).toEqual({
      available: true,
      enabled: true,
      agentScope: 'all_agents',
      version: 41,
      asOf: '2026-08-22T12:00:00.000Z',
      capsule: 'Synthetic request-pinned Feelings capsule.',
      snapshotHash: 'a'.repeat(64),
      rangePromptOverrideCount: 3,
      activeRangePromptOverrideCount: 2,
      activeRangePromptOverrideChars: 120,
    });
    expect(JSON.stringify(receipt)).not.toContain('Synthetic request-pinned Feelings capsule.');
    expect(JSON.stringify(Model.findOneAndUpdate.mock.calls[0][1])).not.toContain(
      'must not be copied',
    );
  });

  test('preserves exact capsule bytes in the private Feelings receipt', () => {
    const capsule = '  Synthetic capsule with intentional edges.\n';

    expect(normalizeCortexFeelingSnapshot(exactFeelingSnapshot({ capsule })).capsule).toBe(capsule);
  });

  test.each([
    ['disabled', { available: true, enabled: false }],
    ['unavailable', { available: false, enabled: false }],
  ])('persists a %s Feelings receipt with an empty capsule', async (_name, overrides) => {
    const Model = {
      findOneAndUpdate: jest.fn((_filter, update) => leanResult(update.$setOnInsert)),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({ DeliveryModel: Model });
    const feelingSnapshot = exactFeelingSnapshot({ ...overrides, capsule: '' });

    await expect(
      service.recordBatch({
        ownerId: `owner-${_name}-feelings`,
        conversationId: `conversation-${_name}-feelings`,
        parentMessageId: `parent-${_name}-feelings`,
        surface: 'web',
        feelingSnapshot,
        insights: [{ cortexId: 'review', insight: 'Exact completed result.' }],
      }),
    ).resolves.toEqual({ deliveries: [expect.objectContaining({ status: 'pending' })] });
    expect(Model.findOneAndUpdate.mock.calls[0][1].$setOnInsert.feelingSnapshot).toEqual(
      feelingSnapshot,
    );
  });

  test.each([
    ['missing available', { available: undefined }],
    ['coercible available', { available: 'true' }],
    ['missing enabled', { enabled: undefined }],
    ['coercible version', { version: '41' }],
    ['noncanonical scope', { agentScope: ' all_agents ' }],
    ['uppercase hash', { snapshotHash: 'A'.repeat(64) }],
    ['missing range count', { rangePromptOverrideCount: undefined }],
    ['coercible active count', { activeRangePromptOverrideCount: '2' }],
    ['invalid timestamp', { asOf: 'not-a-timestamp' }],
    ['oversized capsule', { capsule: 'x'.repeat(16_001) }],
  ])('rejects a strict private Feelings receipt with %s', (_name, overrides) => {
    expect(() => normalizeCortexFeelingSnapshot(exactFeelingSnapshot(overrides))).toThrow(
      expect.objectContaining({ code: 'cortex_feeling_snapshot_invalid' }),
    );
  });

  test.each([
    ['stored absence and requested presence', null, exactFeelingSnapshot()],
    ['stored presence and requested absence', exactFeelingSnapshot(), null],
  ])('rejects idempotent retry with %s', async (_name, storedSnapshot, requestedSnapshot) => {
    const Model = {
      findOneAndUpdate: jest.fn((_filter, update) =>
        leanResult({ ...update.$setOnInsert, feelingSnapshot: storedSnapshot }),
      ),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({ DeliveryModel: Model });

    await expect(
      service.recordBatch({
        ownerId: 'owner-feeling-identity',
        conversationId: 'conversation-feeling-identity',
        parentMessageId: 'parent-feeling-identity',
        surface: 'telegram',
        feelingSnapshot: requestedSnapshot,
        insights: [{ cortexId: 'review', insight: 'Exact identity result.' }],
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_envelope_conflict' });
  });

  test.each([
    ['conversation', { conversationId: 'changed-conversation' }, {}],
    [
      'surface requirements',
      { surface: 'web', requiredSurfaces: ['web'] },
      { surface: 'telegram' },
    ],
    ['stream', { streamId: 'changed-stream' }, {}],
    ['delivery identity', { deliveryId: 'cidl_changed' }, {}],
    ['cortex name', { cortexName: 'Changed' }, {}],
    ['revision', { messageRevision: 7 }, {}],
    ['receipt', { graphResultHash: 'b'.repeat(64) }, {}],
    [
      'snapshot',
      {
        feelingSnapshot: exactFeelingSnapshot({
          capsule: 'Changed request-pinned state.',
          snapshotHash: 'b'.repeat(64),
        }),
      },
      {},
    ],
  ])(
    'rejects an idempotent retry with changed %s',
    async (_name, storedOverride, requestedOverride) => {
      const feelingSnapshot = exactFeelingSnapshot();
      const Model = {
        findOneAndUpdate: jest.fn((_filter, update) =>
          leanResult({ ...update.$setOnInsert, ...storedOverride }),
        ),
        findOne: jest.fn(),
        find: jest.fn(),
      };
      const service = createCortexInsightDeliveryService({ DeliveryModel: Model });

      await expect(
        service.recordBatch({
          ownerId: 'owner-envelope',
          conversationId: 'conversation-envelope',
          parentMessageId: 'parent-envelope',
          surface: 'web',
          streamId: 'stream-envelope',
          messageRevision: 3,
          feelingSnapshot,
          insights: [{ cortexId: 'review', insight: 'Exact envelope result.' }],
          ...requestedOverride,
        }),
      ).rejects.toMatchObject({ code: 'cortex_insight_delivery_envelope_conflict' });
    },
  );

  test('preflights every sibling before the first ledger write', async () => {
    const requestedSnapshot = exactFeelingSnapshot();
    const params = {
      ownerId: 'owner-atomic-ledger',
      conversationId: 'conversation-atomic-ledger',
      parentMessageId: 'parent-atomic-ledger',
      surface: 'web',
      streamId: 'stream-atomic-ledger',
      messageRevision: 2,
      feelingSnapshot: requestedSnapshot,
      insights: [
        { cortexId: 'review-a', insight: 'Exact sibling A.' },
        { cortexId: 'review-b', insight: 'Exact sibling B.' },
      ],
    };
    const [, conflictingCandidate] = buildCortexInsightDeliveryCandidates(params);
    const conflictingRow = {
      ...conflictingCandidate,
      insight: 'Exact sibling B.',
      feelingSnapshot: exactFeelingSnapshot({
        capsule: 'Conflicting request-pinned state.',
        snapshotHash: 'b'.repeat(64),
      }),
      status: 'pending',
      persistenceStatus: 'pending',
      attemptNumber: 0,
      claimGeneration: 0,
    };
    const inserted = [];
    const Model = {
      find: jest.fn(() => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () => [conflictingRow]),
        };
        return chain;
      }),
      findOneAndUpdate: jest.fn((filter, update) => {
        if (filter.deliveryKey === conflictingCandidate.deliveryKey) {
          return leanResult(conflictingRow);
        }
        inserted.push(update.$setOnInsert);
        return leanResult(update.$setOnInsert);
      }),
      findOne: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({ DeliveryModel: Model });

    await expect(service.recordBatch(params)).rejects.toMatchObject({
      code: 'cortex_insight_delivery_envelope_conflict',
    });
    expect(inserted).toEqual([]);
    expect(Model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('retains inserted siblings when a fallback write loses a later race', async () => {
    const params = {
      ownerId: 'owner-ledger-fallback-race',
      conversationId: 'conversation-ledger-fallback-race',
      parentMessageId: 'parent-ledger-fallback-race',
      surface: 'web',
      insights: [
        { cortexId: 'review-a', insight: 'Fallback race sibling A.' },
        { cortexId: 'review-b', insight: 'Fallback race sibling B.' },
      ],
    };
    const [, conflictingCandidate] = buildCortexInsightDeliveryCandidates(params);
    const conflictingRow = {
      ...conflictingCandidate,
      conversationId: 'changed-conversation',
      insight: 'Fallback race sibling B.',
      status: 'pending',
      persistenceStatus: 'pending',
      attemptNumber: 0,
      claimGeneration: 0,
    };
    const inserted = [];
    const Model = {
      find: jest.fn(() => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () => []),
        };
        return chain;
      }),
      findOneAndUpdate: jest.fn((filter, update) => {
        if (filter.deliveryKey === conflictingCandidate.deliveryKey) {
          return leanResult(conflictingRow);
        }
        inserted.push(update.$setOnInsert);
        return leanResult(update.$setOnInsert);
      }),
      findOne: jest.fn(),
      collection: {
        deleteMany: jest.fn(async (filter) => {
          for (let index = inserted.length - 1; index >= 0; index -= 1) {
            if (inserted[index].acceptanceToken === filter.acceptanceToken)
              inserted.splice(index, 1);
          }
          return { deletedCount: 1 };
        }),
      },
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      randomUUID: () => 'fallback-race-token',
    });

    await expect(service.recordBatch(params)).rejects.toMatchObject({
      code: 'cortex_insight_delivery_envelope_conflict',
    });
    expect(Model.collection.deleteMany).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
  });

  test('never deletes a sibling after another standalone worker accepts the exact batch', async () => {
    const params = {
      ownerId: 'owner-observed-acceptance',
      conversationId: 'conversation-observed-acceptance',
      parentMessageId: 'parent-observed-acceptance',
      surface: 'web',
      insights: [
        { cortexId: 'review-a', insight: 'Observed acceptance sibling A.' },
        { cortexId: 'review-b', insight: 'Observed acceptance sibling B.' },
      ],
    };
    const candidates = buildCortexInsightDeliveryCandidates(params);
    const follower = candidates.find((candidate) => !candidate.parentAdmissionKey);
    const rows = [];
    let releaseFirstInsert;
    const firstInsert = new Promise((resolve) => {
      releaseFirstInsert = resolve;
    });
    let releaseSecondInsert;
    const secondInsert = new Promise((resolve) => {
      releaseSecondInsert = resolve;
    });
    const Model = {
      find: jest.fn((filter) => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () =>
            rows.filter(
              (row) =>
                row.userId === filter.userId && filter.deliveryKey.$in.includes(row.deliveryKey),
            ),
          ),
        };
        return chain;
      }),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn((filter, update) => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () => {
            const token = update.$setOnInsert.acceptanceToken;
            if (token === 'cidla_worker-a' && filter.deliveryKey === follower.deliveryKey) {
              await secondInsert;
              throw new Error('ordinary late standalone write failure');
            }
            const existing = rows.find((row) => row.deliveryKey === filter.deliveryKey);
            if (existing) return existing;
            const inserted = { ...update.$setOnInsert };
            rows.push(inserted);
            if (token === 'cidla_worker-a') releaseFirstInsert();
            if (token === 'cidla_worker-b' && filter.deliveryKey === follower.deliveryKey) {
              releaseSecondInsert();
            }
            return inserted;
          }),
        };
        return chain;
      }),
      collection: { deleteMany: jest.fn() },
    };
    const workerA = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      randomUUID: () => 'worker-a',
    });
    const workerB = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      randomUUID: () => 'worker-b',
    });

    const firstResult = workerA.recordBatch(params);
    await firstInsert;
    await expect(workerB.recordBatch(params)).resolves.toEqual({
      batchId: candidates[0].batchId,
      batchSize: 2,
      batchMemberHashes: candidates[0].batchMemberHashes,
      deliveries: expect.any(Array),
    });
    await expect(firstResult).rejects.toThrow('ordinary late standalone write failure');
    expect(rows).toHaveLength(2);
    expect(Model.collection.deleteMany).not.toHaveBeenCalled();
  });

  test('restores one exact Feelings receipt and rejects contradictory sibling rows', async () => {
    const feelingSnapshot = {
      available: true,
      enabled: true,
      agentScope: 'all_agents',
      version: 41,
      asOf: '2026-08-22T12:00:00.000Z',
      capsule: 'Synthetic request-pinned Feelings capsule.',
      snapshotHash: 'a'.repeat(64),
      rangePromptOverrideCount: 3,
      activeRangePromptOverrideCount: 2,
      activeRangePromptOverrideChars: 120,
    };
    const baseRows = ['a', 'b'].map((suffix) => ({
      deliveryId: `cidl_feelings-${suffix}`,
      userId: 'owner-feelings',
      parentMessageId: 'parent-feelings',
      cortexId: `review-${suffix}`,
      insight: `Exact insight ${suffix}.`,
      status: 'pending',
      attemptNumber: 0,
      claimGeneration: 0,
      surface: 'telegram',
      feelingSnapshot,
    }));
    const consistent = createBatchStateModel(baseRows);
    const service = createCortexInsightDeliveryService({
      DeliveryModel: consistent.Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'feeling-claim',
    });

    const batch = await service.claimPendingByParent({
      ownerId: 'owner-feelings',
      parentMessageId: 'parent-feelings',
      surface: 'telegram',
    });
    expect(batch.recoveryContext.feelingSnapshot).toEqual(feelingSnapshot);

    const contradictory = createBatchStateModel([
      baseRows[0],
      {
        ...baseRows[1],
        feelingSnapshot: {
          ...feelingSnapshot,
          capsule: 'Different request state.',
          snapshotHash: 'b'.repeat(64),
        },
      },
    ]);
    const contradictoryService = createCortexInsightDeliveryService({
      DeliveryModel: contradictory.Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'contradictory-claim',
    });

    await expect(
      contradictoryService.claimPendingByParent({
        ownerId: 'owner-feelings',
        parentMessageId: 'parent-feelings',
        surface: 'telegram',
      }),
    ).rejects.toMatchObject({ code: 'cortex_recovery_feeling_snapshot_conflict' });
  });

  test('rejects a terminal sibling with a contradictory Feelings receipt before recovery claims', async () => {
    const pending = {
      deliveryId: 'cidl_pending-feeling',
      userId: 'owner-terminal-feeling',
      parentMessageId: 'parent-terminal-feeling',
      cortexId: 'review-pending',
      insight: 'Pending exact insight.',
      status: 'pending',
      attemptNumber: 0,
      claimGeneration: 0,
      surface: 'telegram',
      feelingSnapshot: exactFeelingSnapshot(),
    };
    const terminal = {
      ...pending,
      deliveryId: 'cidl_terminal-feeling',
      cortexId: 'review-terminal',
      insight: 'Terminal exact insight.',
      status: 'sent',
      feelingSnapshot: exactFeelingSnapshot({
        capsule: 'Contradictory terminal state.',
        snapshotHash: 'b'.repeat(64),
      }),
    };
    const query = (rows) => {
      const chain = {
        select: jest.fn(() => chain),
        sort: jest.fn(() => chain),
        lean: jest.fn(async () => rows),
      };
      return chain;
    };
    const Model = {
      find: jest.fn((filter) => query(filter.$and ? [pending] : [terminal, pending])),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({ DeliveryModel: Model });

    await expect(
      service.claimPendingByParent({
        ownerId: 'owner-terminal-feeling',
        parentMessageId: 'parent-terminal-feeling',
        surface: 'telegram',
      }),
    ).rejects.toMatchObject({ code: 'cortex_recovery_feeling_snapshot_conflict' });
    expect(Model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('routes a consumed first-ledger-write fault into the existing durable outbox pathway', async () => {
    const Model = {
      findOneAndUpdate: jest.fn(),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    const consumeFault = jest.fn().mockResolvedValue({
      triggered: true,
      controlId: 'emo048_synthetic-control',
      boundary: 'cortex_ledger_first_write',
    });
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      consumeFault,
    });

    await expect(
      service.recordBatch({
        ownerId: 'synthetic-owner',
        conversationId: 'synthetic-conversation',
        parentMessageId: 'synthetic-parent',
        surface: 'web',
        insights: [{ cortexId: 'review', insight: 'Synthetic completed result.' }],
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_ledger_write_failed' });
    expect(consumeFault).toHaveBeenCalledWith({
      boundary: 'cortex_ledger_first_write',
      ownerId: 'synthetic-owner',
      conversationId: 'synthetic-conversation',
      parentMessageId: 'synthetic-parent',
    });
    expect(Model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('rejects a partial same-generation settlement with one stable typed error', () => {
    let caught;
    try {
      requireExactCortexInsightDeliverySettlement(
        [
          { deliveryId: 'delivery-a', claimGeneration: 4 },
          { deliveryId: 'delivery-b', claimGeneration: 4 },
        ],
        [{ deliveryId: 'delivery-a', claimGeneration: 4 }],
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });
  });

  test('rejects a stale pre-emit presentation fence after a newer generation reclaims', async () => {
    const current = {
      deliveryId: 'cidl_delivery',
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      persistenceStatus: 'persisted',
      persistedMessageId: 'message-a',
      messageRevision: 2,
      requiredSurfaces: ['web'],
      presentedSurfaces: [],
      presentationReceiptHashes: [],
      claimToken: 'cidl_claim-generation-2',
      claimGeneration: 2,
      attemptNumber: 2,
      claimedAt: new Date('2026-08-22T11:59:00.000Z'),
      leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
    };
    const { Model, state } = createBatchStateModel([current]);
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    await expect(
      service.fencePresentation({
        ownerId: 'owner-a',
        claims: [
          {
            deliveryId: 'cidl_delivery',
            claimToken: 'cidl_claim-generation-1',
            claimGeneration: 1,
          },
        ],
        surface: 'web',
        persistedMessageId: 'message-a',
        messageRevision: 2,
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });

    expect(state[0]).toEqual(
      expect.objectContaining({ ...current, graphResultHash: 'a'.repeat(64) }),
    );
  });
  test('uses a stable API slot identity across container hostname recreation', () => {
    const first = resolveCortexRuntimeSlotIdentity({
      configuredSlot: '',
      nodeAppInstance: '0',
      hostname: 'container-first',
    });
    const recreated = resolveCortexRuntimeSlotIdentity({
      configuredSlot: '',
      nodeAppInstance: '0',
      hostname: 'container-recreated',
    });
    const replica = resolveCortexRuntimeSlotIdentity({
      configuredSlot: '',
      nodeAppInstance: '1',
      hostname: 'container-recreated',
    });

    expect(recreated).toBe(first);
    expect(replica).not.toBe(first);
  });

  test('refuses a silent shared runtime slot and derives unique stable development slots', () => {
    expect(() =>
      resolveCortexRuntimeSlotIdentity({
        configuredSlot: '',
        nodeAppInstance: '',
        nodeEnv: 'production',
        port: '3080',
      }),
    ).toThrow(/stable unique runtime slot/i);

    const first = resolveCortexRuntimeSlotIdentity({
      configuredSlot: '',
      nodeAppInstance: '',
      nodeEnv: 'development',
      port: '3080',
    });
    const recreated = resolveCortexRuntimeSlotIdentity({
      configuredSlot: '',
      nodeAppInstance: '',
      nodeEnv: 'development',
      port: '3080',
      hostname: 'replacement-container',
    });
    const replica = resolveCortexRuntimeSlotIdentity({
      configuredSlot: '',
      nodeAppInstance: '',
      nodeEnv: 'development',
      port: '3081',
    });

    expect(recreated).toBe(first);
    expect(replica).not.toBe(first);
  });

  test('ships the selected LibreChat API port into the backend runtime slot identity', () => {
    const launcher = fs.readFileSync(
      path.resolve(__dirname, '../../../../../viventium-start.sh'),
      'utf8',
    );

    expect(launcher).toContain('export PORT="${PORT:-$LC_API_PORT}"');
  });

  test('builds owner-scoped deterministic identities without retaining insight text', () => {
    const input = {
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'telegram',
      insights: [
        {
          cortexId: 'emotional-resonance',
          cortexName: 'Emotional Resonance',
          insight: 'A completed private insight.',
        },
      ],
    };

    const first = buildCortexInsightDeliveryCandidates(input);
    const replay = buildCortexInsightDeliveryCandidates(input);
    const otherOwner = buildCortexInsightDeliveryCandidates({ ...input, ownerId: 'owner-b' });
    const otherSurface = buildCortexInsightDeliveryCandidates({ ...input, surface: 'web' });

    expect(first).toHaveLength(1);
    expect(replay[0].deliveryId).toBe(first[0].deliveryId);
    expect(otherSurface[0].deliveryId).toBe(first[0].deliveryId);
    expect(otherOwner[0].deliveryId).not.toBe(first[0].deliveryId);
    expect(first[0]).toEqual(
      expect.objectContaining({
        cortexId: 'emotional-resonance',
        insightHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        surface: 'telegram',
      }),
    );
    expect(JSON.stringify(first)).not.toContain('A completed private insight.');
  });

  test('hashes the exact completed Unicode string without compatibility normalization', () => {
    const insight = 'Compatibility forms stay exact: ① Å ﬁ.';
    const normalized = insight.normalize('NFKC');
    const [candidate] = buildCortexInsightDeliveryCandidates({
      ownerId: 'owner-unicode',
      conversationId: 'conversation-unicode',
      parentMessageId: 'parent-unicode',
      surface: 'web',
      insights: [{ cortexId: 'emotional-resonance', insight }],
    });

    expect(normalized).not.toBe(insight);
    expect(candidate.insightHash).toBe(crypto.createHash('sha256').update(insight).digest('hex'));
    expect(candidate.insightHash).not.toBe(
      crypto.createHash('sha256').update(normalized).digest('hex'),
    );
  });

  test('normalizes an undeclared surface to public-safe unknown metadata', () => {
    const candidates = buildCortexInsightDeliveryCandidates({
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'private/customer/path',
      insights: [{ cortexName: 'Review', insight: 'A durable result.' }],
    });

    expect(candidates[0].surface).toBe('unknown');
    expect(JSON.stringify(candidates)).not.toContain('private/customer/path');
  });

  test('claims an idempotent pending row before delivery work starts', async () => {
    const Model = {
      findOneAndUpdate: jest.fn((filter, update) => {
        if (update.$setOnInsert) {
          return leanResult({ ...update.$setOnInsert, ...update.$set });
        }
        return leanResult({
          deliveryId: filter.deliveryId,
          userId: filter.userId,
          cortexId: 'Review',
          insightHash: 'a'.repeat(64),
          status: 'claimed',
          ...update.$set,
        });
      }),
      findOne: jest.fn(),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'claim-1',
    });

    const batch = await service.claimBatch({
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'A durable result.' }],
    });

    expect(batch.claimId).toBe('cidl_claim-1');
    expect(batch.claimed).toHaveLength(1);
    expect(batch.claimed[0].status).toBe('claimed');
    expect(Model.findOneAndUpdate.mock.calls[0][1].$setOnInsert.status).toBe('pending');
    expect(Model.findOneAndUpdate.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        userId: 'owner-a',
        status: 'pending',
      }),
    );
    expect(Model.findOneAndUpdate.mock.calls[1][2].runValidators).toBe(true);
    expect(Model.findOneAndUpdate.mock.calls[1][1].$set.expiresAt).toBeNull();
  });

  test('reuses an active Mongoose transaction session so a newly inserted row remains claimable', async () => {
    const modelMongoose = new mongoose.Mongoose();
    modelMongoose.set('transactionAsyncLocalStorage', true);
    const outerSession = { inTransaction: jest.fn(() => true) };
    const nestedSession = {
      withTransaction: jest.fn(async (operation) => operation()),
      endSession: jest.fn(),
    };
    const rowsBySession = new Map([
      [outerSession, []],
      [nestedSession, []],
    ]);
    const activeRows = (session) => rowsBySession.get(session) || [];
    const matches = (row, filter = {}) =>
      Object.entries(filter).every(([key, expected]) => {
        if (key.startsWith('$')) return true;
        if (expected && typeof expected === 'object' && '$in' in expected) {
          return expected.$in.includes(row[key]);
        }
        return row[key] === expected;
      });
    const query = (operation) => {
      let explicitSession = null;
      const chain = {
        select: jest.fn(() => chain),
        session: jest.fn((session) => {
          explicitSession = session;
          return chain;
        }),
        lean: jest.fn(async () =>
          operation(
            explicitSession ||
              modelMongoose.transactionAsyncLocalStorage.getStore()?.session ||
              null,
          ),
        ),
      };
      return chain;
    };
    const Model = {
      db: {
        base: modelMongoose,
        startSession: jest.fn(async () => nestedSession),
      },
      find: jest.fn((filter = {}) =>
        query((session) => activeRows(session).filter((row) => matches(row, filter))),
      ),
      findOne: jest.fn((filter = {}) =>
        query((session) => activeRows(session).find((row) => matches(row, filter)) || null),
      ),
      findOneAndUpdate: jest.fn((filter, update, options = {}) =>
        query((session) => {
          const rows = activeRows(session);
          let row = rows.find((candidate) => matches(candidate, filter));
          if (!row && options.upsert) {
            row = { ...update.$setOnInsert, ...(update.$set || {}) };
            rows.push(row);
          } else if (row) {
            Object.assign(row, update.$set || {});
            for (const [key, amount] of Object.entries(update.$inc || {})) {
              row[key] = (Number(row[key]) || 0) + amount;
            }
          }
          return row ? { ...row } : null;
        }),
      ),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'claim-in-outer-transaction',
    });

    try {
      const batch = await modelMongoose.transactionAsyncLocalStorage.run(
        { session: outerSession },
        () =>
          service.claimBatch({
            ownerId: 'owner-outer-transaction',
            conversationId: 'conversation-outer-transaction',
            parentMessageId: 'parent-outer-transaction',
            surface: 'telegram',
            insights: [{ cortexName: 'Mission evidence', insight: 'Synthetic completed result.' }],
          }),
      );

      expect({
        claimed: batch.claimed.length,
        nestedSessionStarts: Model.db.startSession.mock.calls.length,
      }).toEqual({ claimed: 1, nestedSessionStarts: 0 });
    } finally {
      modelMongoose.set('transactionAsyncLocalStorage', false);
    }
  });

  test('selects only fresh claimed insights from a partial replay batch', () => {
    const insights = [
      { cortexName: 'Review A', insight: 'Already delivered.' },
      { cortexName: 'Review B', insight: 'Fresh result.' },
    ];
    const candidates = buildCortexInsightDeliveryCandidates({
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'web',
      insights,
    });

    const selected = selectClaimedCortexInsights({
      insights,
      claimedDeliveries: [candidates[1]],
    });

    expect(selected).toEqual([{ cortexName: 'Review B', insight: 'Fresh result.' }]);
  });

  test('recovers a concurrent unique upsert by reusing the existing owner-scoped row', async () => {
    const duplicateError = Object.assign(new Error('duplicate key'), { code: 11000 });
    const [existingCandidate] = buildCortexInsightDeliveryCandidates({
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'A durable result.' }],
    });
    const Model = {
      findOneAndUpdate: jest
        .fn()
        .mockImplementationOnce(() => {
          throw duplicateError;
        })
        .mockImplementationOnce((filter, update) =>
          leanResult({
            deliveryId: filter.deliveryId,
            userId: filter.userId,
            cortexId: 'Review',
            insightHash: 'a'.repeat(64),
            status: 'claimed',
            ...update.$set,
          }),
        ),
      findOne: jest.fn(() =>
        leanResult({
          ...existingCandidate,
          insight: 'A durable result.',
          status: 'pending',
          persistenceStatus: 'pending',
          attemptNumber: 0,
          claimGeneration: 0,
        }),
      ),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'claim-1',
    });

    const batch = await service.claimBatch({
      ownerId: 'owner-a',
      conversationId: 'conversation-a',
      parentMessageId: 'parent-a',
      surface: 'web',
      insights: [{ cortexName: 'Review', insight: 'A durable result.' }],
    });

    expect(batch.claimed).toHaveLength(1);
    expect(Model.findOne).toHaveBeenCalledWith(expect.objectContaining({ userId: 'owner-a' }));
  });

  test('records durable message persistence without settling surface delivery', async () => {
    const liveClaim = {
      deliveryId: 'cidl_delivery',
      userId: 'owner-a',
      status: 'claimed',
      claimToken: 'cidl_claim-1',
      claimGeneration: 1,
      attemptNumber: 1,
      claimedAt: new Date('2026-08-22T11:59:00.000Z'),
      leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
    };
    const Model = {
      findOneAndUpdate: jest.fn((_filter, update) =>
        leanResult({
          ...liveClaim,
          persistenceStatus: update.$set.persistenceStatus,
          persistedMessageId: update.$set.persistedMessageId,
        }),
      ),
      findOne: jest.fn(() => leanResult(liveClaim)),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    const result = await service.markPersisted({
      ownerId: 'owner-a',
      claims: [liveClaim],
      persistedMessageId: 'message-a',
      messageRevision: 2,
    });

    expect(result).toEqual([
      expect.objectContaining({
        status: 'claimed',
        persistenceStatus: 'persisted',
        persistedMessageId: 'message-a',
      }),
    ]);
  });

  test('returns retryable persistence failure to pending and rejects it as a drop', async () => {
    const liveClaim = {
      deliveryId: 'cidl_delivery',
      userId: 'owner-a',
      status: 'claimed',
      claimToken: 'cidl_claim-1',
      claimGeneration: 1,
      attemptNumber: 1,
      claimedAt: new Date('2026-08-22T11:59:00.000Z'),
      leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
      expiresAt: new Date('2026-09-22T12:00:00.000Z'),
    };
    const Model = {
      findOneAndUpdate: jest.fn((_filter, update) =>
        leanResult({
          ...liveClaim,
          ...update.$set,
        }),
      ),
      findOne: jest.fn(() => leanResult(liveClaim)),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    const result = await service.markFailed({
      ownerId: 'owner-a',
      claims: [liveClaim],
      reason: 'durable_surface_persistence_failed',
    });

    expect(CORTEX_INSIGHT_DROP_REASONS).not.toContain('durable_surface_persistence_failed');
    expect(CORTEX_INSIGHT_RETRYABLE_FAILURE_REASONS).toContain(
      'durable_surface_persistence_failed',
    );
    expect(result).toEqual([
      expect.objectContaining({
        status: 'pending',
      }),
    ]);
    expect(Model.findOneAndUpdate.mock.calls.at(-1)[1].$set.expiresAt).toBeNull();
    await expect(
      service.markDropped({
        ownerId: 'owner-a',
        claims: [liveClaim],
        dropReason: 'durable_surface_persistence_failed',
      }),
    ).rejects.toThrow('not a terminal nonretryable reason');
  });

  test('starts terminal retention only after an explicit dropped settlement', async () => {
    const liveClaim = {
      deliveryId: 'cidl_delivery',
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      claimToken: 'cidl_claim-1',
      claimGeneration: 1,
      attemptNumber: 3,
      claimedAt: new Date('2026-08-22T11:59:00.000Z'),
      leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
      expiresAt: null,
    };
    const Model = {
      findOneAndUpdate: jest.fn((_filter, update) =>
        leanResult({
          ...liveClaim,
          ...update.$set,
        }),
      ),
      findOne: jest.fn(() => leanResult(liveClaim)),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    const result = await service.markDropped({
      ownerId: 'owner-a',
      claims: [liveClaim],
      dropReason: 'delivery_attempts_exhausted',
    });

    expect(result).toEqual([expect.objectContaining({ status: 'dropped' })]);
    expect(Model.findOneAndUpdate.mock.calls.at(-1)[1].$set.expiresAt).toEqual(
      new Date('2026-09-21T12:00:00.000Z'),
    );
  });

  test('returns an existing persisted row on an idempotent persistence replay', async () => {
    const existing = {
      deliveryId: 'cidl_delivery',
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      persistenceStatus: 'persisted',
      persistedMessageId: 'message-a',
      messageRevision: 1,
      claimToken: 'cidl_claim-replay',
      claimGeneration: 1,
      leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
    };
    const Model = {
      findOneAndUpdate: jest.fn(() => leanResult(null)),
      findOne: jest.fn(() => leanResult(existing)),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    const result = await service.markPersisted({
      ownerId: 'owner-a',
      claims: [
        {
          deliveryId: 'cidl_delivery',
          claimToken: 'cidl_claim-replay',
          claimGeneration: 1,
        },
      ],
      persistedMessageId: 'message-a',
    });

    expect(result).toEqual([
      expect.objectContaining({
        status: 'claimed',
        persistenceStatus: 'persisted',
        persistedMessageId: 'message-a',
      }),
    ]);
  });

  test('rejects same-message persistence replay after a newer claim generation wins', async () => {
    const currentClaim = {
      deliveryId: 'cidl_delivery',
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      persistenceStatus: 'persisted',
      persistedMessageId: 'message-a',
      messageRevision: 1,
      claimToken: 'cidl_claim-new',
      claimGeneration: 2,
      leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
    };
    const Model = {
      findOneAndUpdate: jest.fn(() => leanResult(null)),
      findOne: jest.fn(() => leanResult(currentClaim)),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    await expect(
      service.markPersisted({
        ownerId: 'owner-a',
        claims: [
          {
            deliveryId: 'cidl_delivery',
            claimToken: 'cidl_claim-old',
            claimGeneration: 1,
          },
        ],
        persistedMessageId: 'message-a',
        messageRevision: 1,
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });
  });

  test('rejects settlement when another claimant still owns the live lease', async () => {
    const Model = {
      findOneAndUpdate: jest.fn(() => leanResult(null)),
      findOne: jest.fn(() =>
        leanResult({
          deliveryId: 'cidl_delivery',
          userId: 'owner-a',
          status: 'claimed',
          claimToken: 'cidl_other-claim',
          claimGeneration: 2,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
      ),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({ DeliveryModel: Model });

    await expect(
      service.markPersisted({
        ownerId: 'owner-a',
        claims: [
          {
            deliveryId: 'cidl_delivery',
            claimToken: 'cidl_claim-1',
            claimGeneration: 1,
          },
        ],
        persistedMessageId: 'message-a',
      }),
    ).rejects.toThrow('Cortex insight delivery transition conflict');
  });

  test('renews every owned claim immediately before durable persistence', async () => {
    const liveClaim = {
      deliveryId: 'cidl_delivery',
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      claimToken: 'cidl_claim-1',
      claimGeneration: 1,
      attemptNumber: 1,
      leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
    };
    const Model = {
      findOneAndUpdate: jest.fn((filter, update) =>
        leanResult({
          deliveryId: filter.deliveryId,
          userId: filter.userId,
          status: 'claimed',
          claimToken: filter.claimToken,
          claimGeneration: filter.claimGeneration,
          leaseExpiresAt: update.$set.leaseExpiresAt,
        }),
      ),
      findOne: jest.fn(() => leanResult(liveClaim)),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    const renewed = await service.renewClaim({
      ownerId: 'owner-a',
      claims: [
        {
          deliveryId: 'cidl_delivery',
          claimToken: 'cidl_claim-1',
          claimGeneration: 1,
          attemptNumber: 1,
        },
      ],
    });

    expect(renewed).toEqual([
      expect.objectContaining({
        status: 'claimed',
        claimToken: 'cidl_claim-1',
        leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
      }),
    ]);
  });

  test('gives one concurrent recovery worker every parent row under one batch fence', async () => {
    const state = [
      {
        deliveryId: 'cidl_delivery-a',
        userId: 'owner-a',
        parentMessageId: 'parent-a',
        cortexId: 'review-a',
        cortexName: 'Review A',
        insight: 'First durable result.',
        insightHash: 'a'.repeat(64),
        status: 'pending',
        attemptNumber: 0,
        claimGeneration: 0,
        surface: 'telegram',
        streamId: 'stream-a',
        messageRevision: 1,
      },
      {
        deliveryId: 'cidl_delivery-b',
        userId: 'owner-a',
        parentMessageId: 'parent-a',
        cortexId: 'review-b',
        cortexName: 'Review B',
        insight: 'Second durable result.',
        insightHash: 'b'.repeat(64),
        status: 'pending',
        attemptNumber: 0,
        claimGeneration: 0,
        surface: 'telegram',
        streamId: 'stream-a',
        messageRevision: 1,
      },
    ];
    const query = () => {
      const chain = {
        select: jest.fn(() => chain),
        sort: jest.fn(() => chain),
        lean: jest.fn(async () => state.map((row) => ({ ...row }))),
      };
      return chain;
    };
    const Model = {
      find: jest.fn(() => query()),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn((filter, update) => {
        const index = state.findIndex(
          (candidate) =>
            candidate.deliveryId === filter.deliveryId &&
            candidate.userId === filter.userId &&
            candidate.status === filter.status &&
            candidate.claimGeneration === filter.claimGeneration,
        );
        if (index < 0) return leanResult(null);
        state[index] = { ...state[index], ...update.$set };
        const result = { ...state[index] };
        return {
          lean: async () => {
            if (filter.deliveryId === 'cidl_delivery-a') {
              await new Promise((resolve) => setImmediate(resolve));
            }
            return result;
          },
        };
      }),
    };
    const serviceA = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'worker-a',
    });
    const serviceB = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'worker-b',
    });

    const batches = await Promise.all(
      [serviceA, serviceB].map((service) =>
        service.claimPendingByParent({
          ownerId: 'owner-a',
          parentMessageId: 'parent-a',
          surface: 'telegram',
        }),
      ),
    );

    expect(batches.map((batch) => batch.claimed.length).sort()).toEqual([0, 2]);
    const winningBatch = batches.find((batch) => batch.claimed.length === 2);
    expect(new Set(winningBatch.claimed.map((row) => row.claimToken)).size).toBe(1);
    expect(winningBatch.recoveryContext.claimGeneration).toBe(1);
    expect(new Set(state.map((row) => row.claimToken)).size).toBe(1);
  });

  test('rolls back every sibling lease when one parent batch claim conflicts', async () => {
    const { Model, state } = createBatchStateModel(
      [
        {
          deliveryId: 'cidl_delivery-a',
          userId: 'owner-a',
          parentMessageId: 'parent-a',
          cortexId: 'review-a',
          insight: 'First result.',
          status: 'pending',
          attemptNumber: 0,
          claimGeneration: 0,
          surface: 'web',
        },
        {
          deliveryId: 'cidl_delivery-b',
          userId: 'owner-a',
          parentMessageId: 'parent-a',
          cortexId: 'review-b',
          insight: 'Second result.',
          status: 'pending',
          attemptNumber: 0,
          claimGeneration: 0,
          surface: 'web',
        },
      ],
      { failClaimFor: 'cidl_delivery-b' },
    );
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'worker-a',
    });

    const batch = await service.claimPendingByParent({
      ownerId: 'owner-a',
      parentMessageId: 'parent-a',
      surface: 'web',
    });

    expect(batch.claimed).toEqual([]);
    expect(state.map((row) => row.status)).toEqual(['pending', 'pending']);
    expect(state.map((row) => row.claimToken || '')).toEqual(['', '']);
  });

  test('rolls back every sibling settlement when one exact claim fence conflicts', async () => {
    const leaseExpiresAt = new Date('2026-08-22T13:00:00.000Z');
    const rows = ['a', 'b'].map((suffix) => ({
      deliveryId: `cidl_delivery-${suffix}`,
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      persistenceStatus: 'pending',
      persistedMessageId: '',
      presentationRevision: 2,
      messageRevision: 2,
      claimToken: 'cidl_claim-a',
      claimGeneration: 1,
      attemptNumber: 1,
      leaseExpiresAt,
    }));
    const { Model, state } = createBatchStateModel(rows, {
      failSettlementFor: 'cidl_delivery-b',
    });
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'lock-a',
    });

    await expect(
      service.markPersisted({
        ownerId: 'owner-a',
        claims: rows,
        persistedMessageId: 'message-a',
        messageRevision: 4,
      }),
    ).rejects.toThrow('Cortex insight delivery transition conflict');

    expect(state.map((row) => row.persistenceStatus)).toEqual(['pending', 'pending']);
    expect(state.map((row) => row.persistedMessageId)).toEqual(['', '']);
    expect(state.map((row) => row.presentationRevision)).toEqual([2, 2]);
    expect(state.map((row) => row.messageRevision)).toEqual([2, 2]);
  });

  test('allows only one complete concurrent settlement for one parent batch', async () => {
    const leaseExpiresAt = new Date('2026-08-22T13:00:00.000Z');
    const rows = ['a', 'b'].map((suffix) => ({
      deliveryId: `cidl_delivery-${suffix}`,
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      persistenceStatus: 'pending',
      persistedMessageId: '',
      claimToken: 'cidl_claim-a',
      claimGeneration: 1,
      attemptNumber: 1,
      leaseExpiresAt,
    }));
    const { Model, state } = createBatchStateModel(rows);
    const services = ['worker-a', 'worker-b'].map((worker) =>
      createCortexInsightDeliveryService({
        DeliveryModel: Model,
        now: () => new Date('2026-08-22T12:00:00.000Z'),
        randomUUID: () => worker,
      }),
    );

    const results = await Promise.allSettled(
      services.map((service, index) =>
        service.markPersisted({
          ownerId: 'owner-a',
          claims: rows,
          persistedMessageId: `message-${index + 1}`,
        }),
      ),
    );

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(new Set(state.map((row) => row.persistedMessageId)).size).toBe(1);
  });

  test('settles every sibling when one already has the same parent presentation receipt', async () => {
    const presentationRef = 'sse:stream-a:message-a:1';
    const graphResultHash = 'a'.repeat(64);
    const receiptHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          messageId: 'message-a',
          presentationRef,
          revision: 1,
          surface: 'web',
          claimToken: 'cidl_claim-a',
          claimGeneration: 1,
          graphResultHash,
          presentationLeaseToken: 'cipl_lock-a',
        }),
      )
      .digest('hex');
    const leaseExpiresAt = new Date('2026-08-22T13:00:00.000Z');
    const rows = ['a', 'b'].map((suffix, index) => ({
      deliveryId: `cidl_delivery-${suffix}`,
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      persistenceStatus: 'persisted',
      persistedMessageId: 'message-a',
      messageRevision: 1,
      requiredSurfaces: ['web'],
      presentedSurfaces: index === 0 ? ['web'] : [],
      presentationReceiptHashes: index === 0 ? [receiptHash] : [],
      claimToken: 'cidl_claim-a',
      claimGeneration: 1,
      graphResultHash,
      attemptNumber: 1,
      claimedAt: new Date('2026-08-22T11:59:00.000Z'),
      leaseExpiresAt,
    }));
    const { Model, state } = createBatchStateModel(rows);
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'lock-a',
    });

    const settled = await service.markPresentationByParent({
      ownerId: 'owner-a',
      parentMessageId: 'parent-a',
      surface: 'web',
      persistedMessageId: 'message-a',
      messageRevision: 1,
      presentationGeneration: 1,
      presentationClaimToken: 'cidl_claim-a',
      presentationRef,
    });

    expect(settled).toHaveLength(2);
    expect(state.map((row) => row.status)).toEqual(['sent', 'sent']);
    expect(state.map((row) => row.expiresAt)).toEqual([
      new Date('2026-09-21T12:00:00.000Z'),
      new Date('2026-09-21T12:00:00.000Z'),
    ]);
  });

  test.each([
    ['claim generation', 2, 'a'.repeat(64)],
    ['graph result', 1, 'b'.repeat(64)],
  ])(
    'rejects a presentation receipt replay after %s mutation',
    async (_field, generation, hash) => {
      const presentationRef = 'sse:stream-a:message-a:1';
      const priorReceiptHash = crypto
        .createHash('sha256')
        .update(
          JSON.stringify({
            messageId: 'message-a',
            presentationRef,
            revision: 1,
            surface: 'web',
            claimToken: 'cidl_claim-a',
            claimGeneration: 1,
            graphResultHash: 'a'.repeat(64),
            presentationLeaseToken: 'cipl_lock-a',
          }),
        )
        .digest('hex');
      const row = {
        deliveryId: 'cidl_delivery-a',
        userId: 'owner-a',
        parentMessageId: 'parent-a',
        status: 'claimed',
        persistenceStatus: 'persisted',
        persistedMessageId: 'message-a',
        messageRevision: 1,
        requiredSurfaces: ['web'],
        presentedSurfaces: ['web'],
        presentationReceiptHashes: [priorReceiptHash],
        claimToken: 'cidl_claim-a',
        claimGeneration: generation,
        graphResultHash: hash,
        attemptNumber: 2,
        claimedAt: new Date('2026-08-22T11:59:00.000Z'),
        leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
        presentationLeaseToken: 'cipl_lock-a',
        presentationLeaseOwnerId: 'owner-a',
        presentationLeaseClaimToken: 'cidl_claim-a',
        presentationLeaseGeneration: generation,
        presentationLeaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
      };
      const { Model, state } = createBatchStateModel([row]);
      const service = createCortexInsightDeliveryService({
        DeliveryModel: Model,
        now: () => new Date('2026-08-22T12:00:00.000Z'),
      });

      await expect(
        service.markPresented({
          ownerId: 'owner-a',
          claims: [row],
          surface: 'web',
          persistedMessageId: 'message-a',
          messageRevision: 1,
          presentationGeneration: generation,
          presentationClaimToken: 'cidl_claim-a',
          presentationLeaseToken: 'cipl_lock-a',
          presentationRef,
        }),
      ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });
      expect(state[0].status).toBe('claimed');
    },
  );

  test('does not credit a Telegram receipt to another live Cortex claim generation', async () => {
    const rows = [
      {
        deliveryId: 'cidl_delivery-a',
        userId: 'owner-a',
        parentMessageId: 'parent-a',
        status: 'claimed',
        persistenceStatus: 'persisted',
        persistedMessageId: 'message-a',
        messageRevision: 2,
        requiredSurfaces: ['web', 'telegram'],
        presentedSurfaces: ['web'],
        presentationReceiptHashes: ['web-receipt'],
        claimToken: 'cidl_claim-a',
        claimGeneration: 7,
        attemptNumber: 2,
        claimedAt: new Date('2026-08-22T11:59:00.000Z'),
        leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
      },
    ];
    const { Model, state } = createBatchStateModel(rows);
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'lock-a',
    });

    await expect(
      service.markPresentationByParent({
        ownerId: 'owner-a',
        parentMessageId: 'parent-a',
        surface: 'telegram',
        persistedMessageId: 'message-a',
        messageRevision: 2,
        presentationGeneration: 6,
        presentationClaimToken: 'cidl_claim-a',
        presentationRef: 'telegram:chat-a:message-41',
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });

    expect(state[0]).toEqual(expect.objectContaining({ status: 'claimed' }));
    expect(state[0].presentedSurfaces).toEqual(['web']);
  });

  test('rejects a direct recovery receipt from an older Cortex claim generation', async () => {
    const row = {
      deliveryId: 'cidl_delivery-reclaimed',
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      persistenceStatus: 'persisted',
      persistedMessageId: 'message-a',
      messageRevision: 2,
      requiredSurfaces: ['telegram'],
      presentedSurfaces: [],
      presentationReceiptHashes: [],
      claimToken: 'cidl_claim-current',
      claimGeneration: 7,
      attemptNumber: 2,
      claimedAt: new Date('2026-08-22T11:59:00.000Z'),
      leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
    };
    const { Model, state } = createBatchStateModel([row]);
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'lock-a',
    });

    await expect(
      service.markPresented({
        ownerId: 'owner-a',
        claims: [row],
        surface: 'telegram',
        persistedMessageId: 'message-a',
        messageRevision: 2,
        presentationGeneration: 6,
        presentationRef: 'telegram:chat-a:message-41',
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });

    expect(state[0].status).toBe('claimed');
    expect(state[0].presentedSurfaces).toEqual([]);
  });

  test('rolls back every sibling when a terminal presentation commit conflicts', async () => {
    const presentationRef = 'sse:stream-a:message-a:1';
    const graphResultHash = 'a'.repeat(64);
    const receiptHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          messageId: 'message-a',
          presentationRef,
          revision: 1,
          surface: 'web',
          claimToken: 'cidl_claim-a',
          claimGeneration: 1,
          graphResultHash,
          presentationLeaseToken: 'cipl_lock-a',
        }),
      )
      .digest('hex');
    const leaseExpiresAt = new Date('2026-08-22T13:00:00.000Z');
    const rows = ['a', 'b'].map((suffix, index) => ({
      deliveryId: `cidl_delivery-${suffix}`,
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'claimed',
      persistenceStatus: 'persisted',
      persistedMessageId: 'message-a',
      messageRevision: 1,
      requiredSurfaces: ['web'],
      presentedSurfaces: index === 0 ? ['web'] : [],
      presentationReceiptHashes: index === 0 ? [receiptHash] : [],
      claimToken: 'cidl_claim-a',
      claimGeneration: 1,
      graphResultHash,
      attemptNumber: 1,
      claimedAt: new Date('2026-08-22T11:59:00.000Z'),
      leaseExpiresAt,
    }));
    const { Model, state } = createBatchStateModel(rows, {
      failSettlementFor: 'cidl_delivery-b',
    });
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      randomUUID: () => 'lock-a',
    });

    await expect(
      service.markPresentationByParent({
        ownerId: 'owner-a',
        parentMessageId: 'parent-a',
        surface: 'web',
        persistedMessageId: 'message-a',
        messageRevision: 1,
        presentationGeneration: 1,
        presentationClaimToken: 'cidl_claim-a',
        presentationRef,
      }),
    ).rejects.toThrow('Cortex insight delivery transition conflict');

    expect(state.map((row) => row.status)).toEqual(['claimed', 'claimed']);
    expect(state.map((row) => row.presentedSurfaces)).toEqual([['web'], []]);
  });

  test('finalizes a recovered claim from already-persisted presentation receipts', async () => {
    const liveClaim = {
      deliveryId: 'cidl_delivery',
      userId: 'owner-a',
      status: 'claimed',
      persistenceStatus: 'persisted',
      persistedMessageId: 'message-a',
      messageRevision: 1,
      requiredSurfaces: ['web', 'telegram'],
      presentedSurfaces: ['web', 'telegram'],
      presentationReceiptHashes: ['a'.repeat(64), 'b'.repeat(64)],
      claimToken: 'cidl_claim-1',
      claimGeneration: 1,
      attemptNumber: 1,
      claimedAt: new Date('2026-08-22T11:59:00.000Z'),
      leaseExpiresAt: new Date('2026-08-22T13:00:00.000Z'),
    };
    const Model = {
      findOne: jest.fn(() => leanResult(liveClaim)),
      findOneAndUpdate: jest.fn((_filter, update) => leanResult({ ...liveClaim, ...update.$set })),
      find: jest.fn(),
    };
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    const finalized = await service.finalizePresented({
      ownerId: 'owner-a',
      claims: [liveClaim],
    });

    expect(finalized).toEqual([expect.objectContaining({ status: 'sent' })]);
    expect(Model.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: 'cidl_delivery',
        presentedSurfaces: { $all: ['web', 'telegram'] },
      }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'sent' }) }),
      expect.objectContaining({ new: true, runValidators: true }),
    );
  });

  test('accepts only an exact idempotent Telegram presentation replay after settlement', async () => {
    const graphResultHash = 'a'.repeat(64);
    const presentationClaimToken = 'cidl_claim-1';
    const presentationLeaseToken = 'cidl_presentation-lease-1';
    const presentationRef = 'telegram:chat-a:message-a';
    const receiptHash = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          messageId: 'message-a',
          presentationRef,
          revision: 1,
          surface: 'telegram',
          claimToken: presentationClaimToken,
          claimGeneration: 1,
          graphResultHash,
          presentationLeaseToken,
        }),
      )
      .digest('hex');
    const sent = {
      deliveryId: 'cidl_delivery',
      userId: 'owner-a',
      parentMessageId: 'parent-a',
      status: 'sent',
      persistenceStatus: 'persisted',
      persistedMessageId: 'message-a',
      messageRevision: 1,
      requiredSurfaces: ['telegram'],
      presentedSurfaces: ['telegram'],
      presentationReceiptHashes: [receiptHash],
      claimToken: '',
      claimGeneration: 1,
      graphResultHash,
      events: [
        {
          transition: 'presented',
          claimToken: presentationClaimToken,
          claimGeneration: 1,
          surface: 'telegram',
          receiptHash,
        },
      ],
    };
    const { Model, state } = createBatchStateModel([sent]);
    const service = createCortexInsightDeliveryService({
      DeliveryModel: Model,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    await expect(
      service.markPresentationByParent({
        ownerId: 'owner-a',
        parentMessageId: 'parent-a',
        surface: 'telegram',
        persistedMessageId: 'message-a',
        messageRevision: 1,
        presentationGeneration: 1,
        presentationClaimToken,
        expectedPresentationLeaseToken: presentationLeaseToken,
        presentationRef,
        expectedDeliveryIds: ['cidl_delivery'],
        expectedDeliveryReceipts: [{ deliveryId: 'cidl_delivery', graphResultHash }],
      }),
    ).resolves.toEqual([expect.objectContaining({ deliveryId: 'cidl_delivery', status: 'sent' })]);

    state.push({ ...sent, deliveryId: 'cidl_unexpected_delivery' });
    await expect(
      service.markPresentationByParent({
        ownerId: 'owner-a',
        parentMessageId: 'parent-a',
        surface: 'telegram',
        persistedMessageId: 'message-a',
        messageRevision: 1,
        presentationGeneration: 1,
        presentationClaimToken,
        expectedPresentationLeaseToken: presentationLeaseToken,
        presentationRef,
        expectedDeliveryIds: ['cidl_delivery'],
        expectedDeliveryReceipts: [{ deliveryId: 'cidl_delivery', graphResultHash }],
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });
    state.pop();

    await expect(
      service.markPresentationByParent({
        ownerId: 'owner-a',
        parentMessageId: 'parent-a',
        surface: 'telegram',
        persistedMessageId: 'message-a',
        messageRevision: 1,
        presentationGeneration: 1,
        presentationClaimToken,
        expectedPresentationLeaseToken: 'forged-lease',
        presentationRef,
        expectedDeliveryIds: ['cidl_delivery'],
        expectedDeliveryReceipts: [{ deliveryId: 'cidl_delivery', graphResultHash }],
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_delivery_settlement_conflict' });
    expect(state).toEqual([expect.objectContaining(sent)]);
  });
});
