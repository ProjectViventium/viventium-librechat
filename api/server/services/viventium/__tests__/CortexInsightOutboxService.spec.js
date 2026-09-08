/* === VIVENTIUM START ===
 * Feature: Durable completed-cortex outbox fairness without a live database.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const { buildCortexInsightDeliveryCandidates } = require('../CortexInsightDeliveryService');
const { createCortexInsightOutboxService } = require('../CortexInsightOutboxService');

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

function fakeOutboxModel(rows) {
  function matchesReplayFilter(row, filter) {
    const clauses = Array.isArray(filter?.$and) ? filter.$and : [filter];
    const dueClause = clauses.find((clause) => clause?.$or?.some((entry) => entry?.nextAttemptAt));
    const replayStateClause = clauses.find((clause) =>
      clause?.$or?.some((entry) => entry?.replayState),
    );
    const dueAt = dueClause?.$or?.find((entry) => entry?.nextAttemptAt?.$lte)?.nextAttemptAt?.$lte;
    const isDue =
      !dueAt || !row.nextAttemptAt || new Date(row.nextAttemptAt).getTime() <= dueAt.getTime();
    const replayStateMatches =
      !replayStateClause || row.replayState == null || row.replayState === 'pending';
    return isDue && replayStateMatches;
  }

  const model = {
    rows: rows.map((row) => ({ ...row })),
    lastFind: null,
    findCalls: 0,
    async exists(filter) {
      return model.rows.find((row) => matchesReplayFilter(row, filter)) || null;
    },
    find(filter) {
      model.findCalls += 1;
      model.lastFind = filter;
      let requestedLimit = 100;
      return {
        select() {
          return this;
        },
        sort() {
          return this;
        },
        hint() {
          return this;
        },
        limit(value) {
          requestedLimit = value;
          return this;
        },
        async lean() {
          return model.rows
            .filter((row) => matchesReplayFilter(row, filter))
            .sort((left, right) => {
              const leftDue = new Date(left.nextAttemptAt || left.createdAt).getTime();
              const rightDue = new Date(right.nextAttemptAt || right.createdAt).getTime();
              return (
                leftDue - rightDue ||
                new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime() ||
                String(left._id).localeCompare(String(right._id))
              );
            })
            .slice(0, requestedLimit)
            .map((row) => ({ ...row }));
        },
      };
    },
    async updateOne(filter, update) {
      const row = model.rows.find(
        (candidate) => candidate._id === filter._id && candidate.outboxKey === filter.outboxKey,
      );
      if (!row) return { modifiedCount: 0 };
      Object.assign(row, update.$set || {});
      for (const [key, value] of Object.entries(update.$inc || {})) {
        row[key] = Number(row[key] || 0) + Number(value);
      }
      return { modifiedCount: 1 };
    },
    async deleteOne(filter) {
      const index = model.rows.findIndex(
        (row) => row._id === filter._id && row.outboxKey === filter.outboxKey,
      );
      if (index < 0) return { deletedCount: 0 };
      model.rows.splice(index, 1);
      return { deletedCount: 1 };
    },
  };
  return model;
}

function outboxRow({ id, parentMessageId, insight, createdAt }) {
  return {
    _id: id,
    outboxKey: `outbox-${id}`,
    userId: 'owner-fairness',
    conversationId: 'conversation-fairness',
    parentMessageId,
    cortexId: 'emotional-resonance',
    cortexName: 'Emotional Resonance',
    insight,
    insightHash: crypto.createHash('sha256').update(insight).digest('hex'),
    surface: 'web',
    streamId: 'stream-fairness',
    messageRevision: 1,
    createdAt,
    nextAttemptAt: createdAt,
    replayAttempts: 0,
    retentionAlertAt: new Date('2026-10-01T00:00:00.000Z'),
  };
}

function embeddedOutboxRow({ id, parentMessageId, insight, createdAt, feelingSnapshot = null }) {
  const params = {
    ownerId: 'owner-fairness',
    conversationId: 'conversation-fairness',
    parentMessageId,
    surface: 'web',
    streamId: 'stream-fairness',
    messageRevision: 1,
    insights: [{ cortexId: 'emotional-resonance', cortexName: 'Emotional Resonance', insight }],
  };
  const candidate = buildCortexInsightDeliveryCandidates(params)[0];
  const entry = {
    ...candidate,
    outboxKey: candidate.deliveryKey,
    insight,
    ...(feelingSnapshot ? { feelingSnapshot } : {}),
    batchOutboxKeys: [candidate.deliveryKey],
    createdAt,
    nextAttemptAt: createdAt,
    replayAttempts: 0,
    retentionAlertAt: new Date('2026-10-01T00:00:00.000Z'),
  };
  delete entry.deliveryKey;
  return { ...entry, _id: id, batchEntries: [{ ...entry }] };
}

describe('CortexInsightOutboxService fair replay', () => {
  test('rejects a batch that cannot fit the bounded durable coordinator', async () => {
    const Model = { bulkWrite: jest.fn(), find: jest.fn() };
    const service = createCortexInsightOutboxService({ OutboxModel: Model });

    await expect(
      service.enqueueBatch({
        ownerId: 'owner-bounded-batch',
        conversationId: 'conversation-bounded-batch',
        parentMessageId: 'parent-bounded-batch',
        surface: 'web',
        insights: Array.from({ length: 257 }, (_value, index) => ({
          cortexId: `review-${index}`,
          insight: `Bounded completed result ${index}.`,
        })),
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_outbox_batch_too_large' });
    expect(Model.bulkWrite).not.toHaveBeenCalled();
  });

  test('accepts both identical standalone enqueues after one loses the unique-index race', async () => {
    let stored = null;
    let arrivals = 0;
    let releaseWrites;
    const writesReady = new Promise((resolve) => {
      releaseWrites = resolve;
    });
    const Model = {
      find: jest.fn((filter) => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () =>
            stored && filter.outboxKey.$in.includes(stored.outboxKey) ? [stored] : [],
          ),
        };
        return chain;
      }),
      bulkWrite: jest.fn(async (operations) => {
        arrivals += 1;
        if (arrivals === 2) releaseWrites();
        await writesReady;
        if (stored) {
          throw Object.assign(new Error('duplicate coordinator'), { code: 11000 });
        }
        stored = { ...operations[0].updateOne.update.$setOnInsert };
      }),
    };
    const params = {
      ownerId: 'owner-concurrent-outbox',
      conversationId: 'conversation-concurrent-outbox',
      parentMessageId: 'parent-concurrent-outbox',
      surface: 'web',
      insights: [
        { cortexId: 'review-a', insight: 'Concurrent outbox sibling A.' },
        { cortexId: 'review-b', insight: 'Concurrent outbox sibling B.' },
      ],
    };
    const services = ['worker-a', 'worker-b'].map((worker) =>
      createCortexInsightOutboxService({
        OutboxModel: Model,
        randomUUID: () => worker,
      }),
    );

    const results = await Promise.all(services.map((service) => service.enqueueBatch(params)));
    expect(results).toEqual([
      { outboxKeys: expect.arrayContaining([expect.any(String), expect.any(String)]) },
      { outboxKeys: expect.arrayContaining([expect.any(String), expect.any(String)]) },
    ]);
    expect(stored.batchEntries).toHaveLength(2);
  });

  test.each([
    ['disabled', { available: true, enabled: false }],
    ['unavailable', { available: false, enabled: false }],
  ])('persists a %s Feelings receipt with an empty capsule', async (_name, overrides) => {
    let insertedEntry;
    const Model = {
      bulkWrite: jest.fn(async (operations) => {
        insertedEntry = operations[0].updateOne.update.$setOnInsert;
      }),
      find: jest.fn(() => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () => (insertedEntry ? [insertedEntry] : [])),
        };
        return chain;
      }),
    };
    const service = createCortexInsightOutboxService({ OutboxModel: Model });
    const feelingSnapshot = exactFeelingSnapshot({ ...overrides, capsule: '' });

    await expect(
      service.enqueueBatch({
        ownerId: `owner-${_name}-feelings`,
        conversationId: `conversation-${_name}-feelings`,
        parentMessageId: `parent-${_name}-feelings`,
        surface: 'web',
        feelingSnapshot,
        insights: [{ cortexId: 'review', insight: 'Exact completed result.' }],
      }),
    ).resolves.toEqual({ outboxKeys: [expect.any(String)] });
    expect(insertedEntry.feelingSnapshot).toEqual(feelingSnapshot);
  });

  test.each([
    ['stored absence and requested presence', null, true],
    ['stored presence and requested absence', true, null],
  ])('rejects an idempotent outbox enqueue with %s', async (_name, storedMode, requestedMode) => {
    const feelingSnapshot = exactFeelingSnapshot();
    let insertedEntry;
    const Model = {
      bulkWrite: jest.fn(async (operations) => {
        insertedEntry = operations[0].updateOne.update.$setOnInsert;
      }),
      find: jest.fn(() => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () => [
            {
              ...insertedEntry,
              ...(storedMode === true ? { feelingSnapshot } : { feelingSnapshot: null }),
            },
          ]),
        };
        return chain;
      }),
    };
    const service = createCortexInsightOutboxService({ OutboxModel: Model });

    await expect(
      service.enqueueBatch({
        ownerId: 'owner-outbox-identity',
        conversationId: 'conversation-outbox-identity',
        parentMessageId: 'parent-outbox-identity',
        surface: 'telegram',
        feelingSnapshot: requestedMode === true ? feelingSnapshot : null,
        insights: [{ cortexId: 'review', insight: 'Exact outbox identity result.' }],
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_outbox_conflict' });
  });

  test.each([
    ['conversation', { conversationId: 'changed-conversation' }],
    ['surface', { surface: 'telegram' }],
    ['stream', { streamId: 'changed-stream' }],
    ['delivery identity', { deliveryId: 'cidl_changed' }],
    ['cortex name', { cortexName: 'Changed' }],
    ['revision', { messageRevision: 7 }],
    ['receipt', { graphResultHash: 'b'.repeat(64) }],
    [
      'snapshot',
      {
        feelingSnapshot: exactFeelingSnapshot({
          capsule: 'Changed request-pinned state.',
          snapshotHash: 'b'.repeat(64),
        }),
      },
    ],
  ])('rejects an idempotent enqueue with a changed %s envelope', async (_name, storedOverride) => {
    let insertedEntry;
    const Model = {
      bulkWrite: jest.fn(async (operations) => {
        insertedEntry = operations[0].updateOne.update.$setOnInsert;
      }),
      find: jest.fn(() => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () => [{ ...insertedEntry, ...storedOverride }]),
        };
        return chain;
      }),
    };
    const service = createCortexInsightOutboxService({ OutboxModel: Model });

    await expect(
      service.enqueueBatch({
        ownerId: 'owner-outbox-envelope',
        conversationId: 'conversation-outbox-envelope',
        parentMessageId: 'parent-outbox-envelope',
        surface: 'web',
        streamId: 'stream-outbox-envelope',
        messageRevision: 3,
        feelingSnapshot: exactFeelingSnapshot(),
        insights: [{ cortexId: 'review', insight: 'Exact outbox envelope result.' }],
      }),
    ).rejects.toMatchObject({ code: 'cortex_insight_outbox_conflict' });
  });

  test('preflights every sibling before the first outbox write', async () => {
    const params = {
      ownerId: 'owner-atomic-outbox',
      conversationId: 'conversation-atomic-outbox',
      parentMessageId: 'parent-atomic-outbox',
      surface: 'web',
      streamId: 'stream-atomic-outbox',
      messageRevision: 2,
      feelingSnapshot: exactFeelingSnapshot(),
      insights: [
        { cortexId: 'review-a', insight: 'Exact outbox sibling A.' },
        { cortexId: 'review-b', insight: 'Exact outbox sibling B.' },
      ],
    };
    const [, conflictingCandidate] = buildCortexInsightDeliveryCandidates(params);
    const conflictingRow = {
      outboxKey: conflictingCandidate.deliveryKey,
      ...conflictingCandidate,
      insight: 'Exact outbox sibling B.',
      feelingSnapshot: exactFeelingSnapshot({
        capsule: 'Conflicting request-pinned state.',
        snapshotHash: 'b'.repeat(64),
      }),
    };
    const inserted = [];
    const Model = {
      bulkWrite: jest.fn(async (operations) => {
        for (const operation of operations) {
          if (operation.updateOne.filter.outboxKey !== conflictingRow.outboxKey) {
            inserted.push(operation.updateOne.update.$setOnInsert);
          }
        }
      }),
      find: jest.fn(() => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () => [...inserted, conflictingRow]),
        };
        return chain;
      }),
    };
    const service = createCortexInsightOutboxService({ OutboxModel: Model });

    await expect(service.enqueueBatch(params)).rejects.toMatchObject({
      code: 'cortex_insight_outbox_conflict',
    });
    expect(inserted).toEqual([]);
    expect(Model.bulkWrite).not.toHaveBeenCalled();
  });

  test('retains the atomic coordinator when a fallback validation loses a later race', async () => {
    const params = {
      ownerId: 'owner-outbox-fallback-race',
      conversationId: 'conversation-outbox-fallback-race',
      parentMessageId: 'parent-outbox-fallback-race',
      surface: 'web',
      insights: [
        { cortexId: 'review-a', insight: 'Outbox fallback race sibling A.' },
        { cortexId: 'review-b', insight: 'Outbox fallback race sibling B.' },
      ],
    };
    const [, conflictingCandidate] = buildCortexInsightDeliveryCandidates(params);
    const conflictingRow = {
      outboxKey: conflictingCandidate.deliveryKey,
      ...conflictingCandidate,
      conversationId: 'changed-conversation',
      insight: 'Outbox fallback race sibling B.',
    };
    const inserted = [];
    let readCount = 0;
    const Model = {
      bulkWrite: jest.fn(async (operations) => {
        for (const operation of operations) {
          if (operation.updateOne.filter.outboxKey !== conflictingRow.outboxKey) {
            inserted.push(operation.updateOne.update.$setOnInsert);
          }
        }
      }),
      find: jest.fn(() => {
        const chain = {
          select: jest.fn(() => chain),
          lean: jest.fn(async () => {
            readCount += 1;
            return readCount === 1 ? [] : [...inserted, conflictingRow];
          }),
        };
        return chain;
      }),
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
    const service = createCortexInsightOutboxService({
      OutboxModel: Model,
      randomUUID: () => 'fallback-race-token',
    });

    await expect(service.enqueueBatch(params)).rejects.toMatchObject({
      code: 'cortex_insight_outbox_conflict',
    });
    expect(Model.collection.deleteMany).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(1);
  });

  test('an empty collection does not run an indexed replay query before startup creates indexes', async () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const model = fakeOutboxModel([]);
    const service = createCortexInsightOutboxService({ OutboxModel: model, now: () => now });

    await expect(service.replayPending()).resolves.toEqual({
      scanned: 0,
      replayed: 0,
      pending: 0,
    });
    expect(model.findCalls).toBe(0);
  });

  test('a permanent oldest failure cannot starve a later exact result across service restart', async () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    const exactLater = '\u00a0{"summary":"Later ① Å ﬁ","ok":true}\u3000';
    const model = fakeOutboxModel([
      outboxRow({
        id: '0001',
        parentMessageId: 'parent-permanent-failure',
        insight: 'Permanent failure.',
        createdAt: new Date('2026-08-31T23:58:00.000Z'),
      }),
      outboxRow({
        id: '0002',
        parentMessageId: 'parent-later',
        insight: exactLater,
        createdAt: new Date('2026-08-31T23:59:00.000Z'),
      }),
    ]);
    const recordBatch = jest.fn(async (batch) => {
      if (batch.parentMessageId === 'parent-permanent-failure') {
        throw Object.assign(new Error('permanent row failure'), { code: 'permanent_failure' });
      }
      const expected = buildCortexInsightDeliveryCandidates(batch);
      return {
        deliveries: expected.map(({ deliveryId, graphResultHash }) => ({
          deliveryId,
          graphResultHash,
        })),
      };
    });

    const firstBoot = createCortexInsightOutboxService({ OutboxModel: model, now: () => now });
    await expect(firstBoot.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 0,
      pending: 1,
    });
    expect(model.rows.find((row) => row._id === '0001')).toMatchObject({ replayAttempts: 1 });

    const restarted = createCortexInsightOutboxService({ OutboxModel: model, now: () => now });
    await expect(restarted.replayPending({ limit: 1, recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 1,
      pending: 0,
    });

    const replayedBatch = recordBatch.mock.calls.at(-1)[0];
    expect(replayedBatch.insights[0].insight).toBe(exactLater);
    expect(buildCortexInsightDeliveryCandidates(replayedBatch)[0].graphResultHash).toBe(
      crypto.createHash('sha256').update(exactLater).digest('hex'),
    );
    expect(model.rows.map((row) => row._id)).toEqual(['0001']);
  });

  test('replays the same request-pinned Feelings receipt after restart', async () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
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
    const model = fakeOutboxModel([
      {
        ...outboxRow({
          id: 'feelings-restart',
          parentMessageId: 'parent-feelings',
          insight: 'Exact restarted result.',
          createdAt: now,
        }),
        feelingSnapshot,
      },
    ]);
    const recordBatch = jest.fn(async (batch) => ({
      deliveries: buildCortexInsightDeliveryCandidates(batch),
    }));

    const restarted = createCortexInsightOutboxService({ OutboxModel: model, now: () => now });
    await expect(restarted.replayPending({ recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 1,
      pending: 0,
    });
    expect(recordBatch.mock.calls[0][0].feelingSnapshot).toEqual(feelingSnapshot);
  });

  test('quarantines an immutable mixed-envelope failure once without deleting its payload', async () => {
    let replayedAt = new Date('2026-09-01T00:00:00.000Z');
    const model = fakeOutboxModel([
      embeddedOutboxRow({
        id: 'irreconcilable-parent',
        parentMessageId: 'parent-irreconcilable',
        insight: 'Durable result retained for operator repair.',
        createdAt: replayedAt,
      }),
    ]);
    const recordBatch = jest.fn(async () => {
      throw Object.assign(new Error('mixed immutable parent envelope'), {
        code: 'cortex_insight_delivery_batch_mixed_envelope',
      });
    });
    const firstBoot = createCortexInsightOutboxService({
      OutboxModel: model,
      now: () => replayedAt,
    });

    await expect(firstBoot.replayPending({ recordBatch })).resolves.toEqual({
      scanned: 1,
      replayed: 0,
      pending: 0,
      quarantined: 1,
    });
    expect(model.rows).toHaveLength(1);
    expect(model.rows[0]).toMatchObject({
      replayState: 'quarantined',
      replayAttempts: 1,
      lastFailureCode: 'cortex_insight_delivery_batch_mixed_envelope',
      lastFailureAt: replayedAt,
      quarantinedAt: replayedAt,
      insight: 'Durable result retained for operator repair.',
    });

    replayedAt = new Date('2026-09-02T00:00:00.000Z');
    const restarted = createCortexInsightOutboxService({
      OutboxModel: model,
      now: () => replayedAt,
    });
    await expect(restarted.replayPending({ recordBatch })).resolves.toEqual({
      scanned: 0,
      replayed: 0,
      pending: 0,
    });
    expect(recordBatch).toHaveBeenCalledTimes(1);
  });
});
