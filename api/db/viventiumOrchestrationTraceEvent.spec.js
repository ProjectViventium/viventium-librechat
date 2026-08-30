/* === VIVENTIUM START === Append-only orchestration trace persistence tests. === VIVENTIUM END === */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const createViventiumOrchestrationTraceEvent = require('./viventiumOrchestrationTraceEvent');
const {
  createOrchestrationTraceLedgerService,
} = require('../server/services/viventium/OrchestrationTraceLedgerService');
const { buildUnifiedOrchestrationTrace, fingerprintTraceReference } = require('@librechat/api');
const completedDetailFixture = require('../../packages/api/src/trace/__fixtures__/glassHiveCompletedWorkDetail.v1.json');
const completedDetailOriginRef = 'ghi_0123456789abcdef0123456789abcdef';
const completedDetailTerminalCallbackRef = completedDetailFixture.callbackDeliveries.find(
  (row) => row.event === 'run.completed',
).callbackRef;

describe('ViventiumOrchestrationTraceEvent', () => {
  let mongoServer;
  let database;
  let EventModel;
  let service;
  let independentlyLoadedService;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    database = new mongoose.Mongoose();
    await database.connect(mongoServer.getUri());
    EventModel = createViventiumOrchestrationTraceEvent(database);
    await EventModel.syncIndexes();
    service = createOrchestrationTraceLedgerService({ EventModel });
    jest.isolateModules(() => {
      const {
        createOrchestrationTraceLedgerService: createIndependentService,
      } = require('../server/services/viventium/OrchestrationTraceLedgerService');
      independentlyLoadedService = createIndependentService({ EventModel });
    });
  });

  afterAll(async () => {
    await database?.disconnect();
    await mongoServer?.stop();
  });

  test('schema has fingerprints only and no raw private identifier or payload fields', () => {
    for (const forbidden of [
      'ownerId',
      'originRef',
      'workRef',
      'runRef',
      'callbackRef',
      'promptText',
      'chatText',
      'hostId',
      'path',
      'url',
      'token',
      'argv',
      'pid',
      'privateId',
    ]) {
      expect(EventModel.schema.path(forbidden)).toBeUndefined();
    }
  });

  test('does not load the default trace model until ledger I/O begins', () => {
    jest.isolateModules(() => {
      jest.doMock('~/db/models', () => {
        throw new Error('trace_model_loaded_eagerly');
      });
      expect(() =>
        require('../server/services/viventium/OrchestrationTraceLedgerService'),
      ).not.toThrow();
    });
    jest.dontMock('~/db/models');
  });

  test('persists one immutable hash chain without raw identifiers', async () => {
    const privateFacts = {
      ownerId: 'owner-private-ledger',
      originRef: 'origin-private-ledger',
      workRef: 'work-private-ledger',
      runRef: 'run-private-ledger',
    };
    await service.append({
      ...privateFacts,
      eventKey: 'event-private-1',
      stage: 'source.bound',
      facts: { workRef: privateFacts.workRef, runRef: privateFacts.runRef },
    });
    await service.append({
      ...privateFacts,
      eventKey: 'event-private-2',
      stage: 'launch.accepted',
      facts: { workRef: privateFacts.workRef, runRef: privateFacts.runRef },
    });

    const page = await service.read({
      ownerId: privateFacts.ownerId,
      originRef: privateFacts.originRef,
      limit: 10,
    });
    expect(page.chain).toMatchObject({ pageVerified: true, fullChainVerified: true });
    expect(page.events).toHaveLength(2);
    const persisted = JSON.stringify(await EventModel.find({}).lean());
    for (const value of Object.values(privateFacts)) expect(persisted).not.toContain(value);
  });

  test('persists typed producer-contract and provider-request facts as redacted evidence', async () => {
    const ownerId = 'owner-typed-trace-facts';
    const originRef = 'origin-typed-trace-facts';
    const providerRequestRef = 'provider-request-private-trace-fact';
    await service.append({
      ownerId,
      originRef,
      eventKey: 'event-typed-trace-facts',
      stage: 'provider.request.forwarded',
      facts: {
        providerRequestRef,
        producerTraceContractVersion: 2,
        provider: 'synthetic-provider',
        model: 'synthetic-model',
        providerStatus: 'completed',
      },
    });

    const [row] = await EventModel.find({
      ownerScopeHash: fingerprintTraceReference('owner', ownerId),
      originRefHash: fingerprintTraceReference('origin', originRef),
    }).lean();
    expect(row.facts).toMatchObject({
      providerRequestRefHash: fingerprintTraceReference('provider_request', providerRequestRef),
      producerTraceContractVersion: 2,
    });
    expect(JSON.stringify(row)).not.toContain(providerRequestRef);
  });

  test('rejects every model-level mutation path', async () => {
    const document = await EventModel.findOne({});
    const row = document.toObject();
    await expect(
      EventModel.updateOne({ eventHash: row.eventHash }, { $set: { stage: 'work.completed' } }),
    ).rejects.toThrow('orchestration_trace_append_only');
    await expect(
      EventModel.findOneAndReplace(
        { eventHash: row.eventHash },
        { ...row, stage: 'work.completed' },
      ),
    ).rejects.toThrow('orchestration_trace_append_only');
    await expect(
      EventModel.bulkWrite([
        {
          updateOne: {
            filter: { eventHash: row.eventHash },
            update: { $set: { stage: 'work.completed' } },
          },
        },
      ]),
    ).rejects.toThrow('orchestration_trace_append_only');
    await expect(document.save()).rejects.toThrow('orchestration_trace_append_only');
    await expect(document.deleteOne()).rejects.toThrow('orchestration_trace_append_only');
    await expect(EventModel.deleteOne({ eventHash: row.eventHash })).rejects.toThrow(
      'orchestration_trace_append_only',
    );
  });

  test('owner scope and pagination remain bounded in Mongo', async () => {
    await service.append({
      ownerId: 'owner-other',
      originRef: 'origin-private-ledger',
      eventKey: 'event-other',
      stage: 'source.bound',
      facts: { workRef: 'work-other' },
    });
    const page = await service.read({
      ownerId: 'owner-other',
      originRef: 'origin-private-ledger',
      limit: 1,
    });
    expect(page.events).toHaveLength(1);
    expect(page.pagination).toMatchObject({ limit: 1, overflow: false });
  });

  test('isolates owners, redacts refs, and detects raw Mongo hash corruption', async () => {
    const originRef = 'origin-shared-corruption-test';
    for (const ownerId of ['owner-corrupt-a', 'owner-corrupt-b']) {
      await service.append({
        ownerId,
        originRef,
        eventKey: 'event-shared',
        stage: 'source.bound',
        at: '2026-08-22T12:00:00.000Z',
        facts: { workRef: 'private-work-shared' },
      });
    }
    await EventModel.collection.updateOne(
      {
        ownerScopeHash: fingerprintTraceReference('owner', 'owner-corrupt-a'),
        originRefHash: fingerprintTraceReference('origin', originRef),
      },
      { $set: { 'facts.workRefHash': `sha256:${'9'.repeat(64)}` } },
    );

    const [ownerA, ownerB] = await Promise.all([
      service.read({ ownerId: 'owner-corrupt-a', originRef, limit: 10 }),
      service.read({ ownerId: 'owner-corrupt-b', originRef, limit: 10 }),
    ]);

    expect(ownerA.chain.fullChainVerified).toBe(false);
    expect(ownerA.chain.errors).toEqual(
      expect.arrayContaining(['content_hash_mismatch:1', 'event_hash_mismatch:1']),
    );
    expect(ownerB.chain.fullChainVerified).toBe(true);
    expect(JSON.stringify([ownerA, ownerB])).not.toContain('private-work-shared');
  });

  test('persists the complete launch hook including an empty launch-prepared fact set', async () => {
    await service.recordLaunch({
      ownerId: 'owner-launch-hook',
      originRef: 'origin-launch-hook',
      sourceEventRef: 'source-launch-hook',
      logicalTurnRef: 'turn-launch-hook',
      promptLayers: { contractVersion: 1, unknownLayerNames: [] },
    });
    const page = await service.read({
      ownerId: 'owner-launch-hook',
      originRef: 'origin-launch-hook',
      limit: 10,
    });

    expect(page.events.map((event) => event.stage)).toEqual([
      'source.bound',
      'prompt.layers.verified',
      'launch.prepared',
    ]);
  });

  test('rejects a conflicting callback replay without partially appending terminal state', async () => {
    const ownerId = 'owner-callback-conflict';
    const originRef = 'origin-callback-conflict';
    const callbackRef = `callback_sha256:${'4'.repeat(64)}`;
    const completed = {
      ownerId,
      originRef,
      workRef: 'work-callback-conflict',
      runRef: 'run-callback-conflict',
      callbackRef,
      event: 'run.completed',
      workState: 'completed',
      workTerminal: true,
      callbackAt: '2026-08-22T12:00:00.000Z',
      callbackAcceptedAt: '2026-08-22T12:00:00.100Z',
      attemptNumber: 1,
    };
    const scope = {
      ownerScopeHash: fingerprintTraceReference('owner', ownerId),
      originRefHash: fingerprintTraceReference('origin', originRef),
    };

    await service.recordCallback(completed);
    const before = JSON.stringify(await EventModel.find(scope).sort({ sequence: 1 }).lean());

    await expect(
      independentlyLoadedService.recordCallback({
        ...completed,
        event: 'run.failed',
        workState: 'failed',
        callbackAt: '2026-08-22T12:00:01.000Z',
        callbackAcceptedAt: '2026-08-22T12:00:01.100Z',
      }),
    ).rejects.toThrow('orchestration_trace_event_conflict');

    const afterConflict = JSON.stringify(await EventModel.find(scope).sort({ sequence: 1 }).lean());
    expect(afterConflict).toBe(before);
    expect(JSON.parse(afterConflict).map((row) => row.stage)).toEqual([
      'work.completed',
      'callback.accepted',
    ]);

    await service.recordCallback({
      ...completed,
      callbackAcceptedAt: '2026-08-22T12:00:05.900Z',
    });
    const afterExactReplay = JSON.stringify(
      await EventModel.find(scope).sort({ sequence: 1 }).lean(),
    );
    expect(afterExactReplay).toBe(before);
  });

  test('serializes concurrent conflicting callbacks so the rejected batch writes nothing', async () => {
    const ownerId = 'owner-concurrent-callback-conflict';
    const originRef = 'origin-concurrent-callback-conflict';
    const callbackRef = `callback_sha256:${'6'.repeat(64)}`;
    const base = {
      ownerId,
      originRef,
      workRef: 'work-concurrent-callback-conflict',
      runRef: 'run-concurrent-callback-conflict',
      callbackRef,
      callbackAt: '2026-08-22T13:00:00.000Z',
      attemptNumber: 1,
      workTerminal: true,
    };

    const results = await Promise.allSettled([
      independentlyLoadedService.recordCallback({
        ...base,
        event: 'run.completed',
        workState: 'completed',
        callbackAcceptedAt: '2026-08-22T13:00:00.100Z',
      }),
      service.recordCallback({
        ...base,
        event: 'run.failed',
        workState: 'failed',
        callbackAcceptedAt: '2026-08-22T13:00:00.200Z',
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual(['fulfilled', 'rejected']);
    const rows = await EventModel.find({
      ownerScopeHash: fingerprintTraceReference('owner', ownerId),
      originRefHash: fingerprintTraceReference('origin', originRef),
    })
      .sort({ sequence: 1 })
      .lean();
    expect(
      rows.filter(({ stage }) => ['work.completed', 'work.failed'].includes(stage)),
    ).toHaveLength(1);
    expect(rows.filter(({ stage }) => stage === 'callback.accepted')).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  test('keeps concurrent exact callback replays idempotent', async () => {
    const ownerId = 'owner-concurrent-callback-replay';
    const originRef = 'origin-concurrent-callback-replay';
    const callbackRef = `callback_sha256:${'7'.repeat(64)}`;
    const callback = {
      ownerId,
      originRef,
      workRef: 'work-concurrent-callback-replay',
      runRef: 'run-concurrent-callback-replay',
      callbackRef,
      event: 'run.completed',
      workState: 'completed',
      workTerminal: true,
      callbackAt: '2026-08-22T14:00:00.000Z',
      callbackAcceptedAt: '2026-08-22T14:00:00.100Z',
      attemptNumber: 1,
    };

    const results = await Promise.all([
      service.recordCallback(callback),
      independentlyLoadedService.recordCallback({
        ...callback,
        callbackAcceptedAt: '2026-08-22T14:00:00.900Z',
      }),
    ]);
    expect(results).toHaveLength(2);
    const rows = await EventModel.find({
      ownerScopeHash: fingerprintTraceReference('owner', ownerId),
      originRefHash: fingerprintTraceReference('origin', originRef),
    })
      .sort({ sequence: 1 })
      .lean();
    expect(rows.map(({ stage }) => stage)).toEqual(['work.completed', 'callback.accepted']);
    const acceptedAt = rows[1].at.toISOString();
    expect(['2026-08-22T14:00:00.100Z', '2026-08-22T14:00:00.900Z']).toContain(acceptedAt);
    expect(
      results.map((batch) => batch.find(({ stage }) => stage === 'callback.accepted')?.at),
    ).toEqual([acceptedAt, acceptedAt]);
  });

  test('rejects a conflicting producer detail batch without appending its earlier prefix', async () => {
    const ownerId = 'owner-producer-conflict';
    const originRef = completedDetailOriginRef;
    const workRef = completedDetailFixture.workRef;
    const runRef = 'run_synthetic_1';
    await service.append({
      ownerId,
      originRef,
      eventKey: `glasshive.detail.v1:work.admitted:${runRef}:1`,
      stage: 'work.admitted',
      at: '2026-08-22T01:00:03.000Z',
      facts: { workRef, runRef, attemptNumber: 1 },
    });
    const scope = {
      ownerScopeHash: fingerprintTraceReference('owner', ownerId),
      originRefHash: fingerprintTraceReference('origin', originRef),
    };
    const before = JSON.stringify(await EventModel.find(scope).sort({ sequence: 1 }).lean());

    await expect(
      service.recordGlassHiveWorkDetail({
        ownerId,
        originRef,
        workRef,
        runRef,
        detail: completedDetailFixture,
      }),
    ).resolves.toMatchObject({ accepted: false, errors: ['producer_facts_conflict'] });

    const after = JSON.stringify(await EventModel.find(scope).sort({ sequence: 1 }).lean());
    expect(after).toBe(before);
  });

  test.each([
    ['stage', { stage: 'private-stage' }],
    ['state', { facts: { state: '/private/state' } }],
    ['surface', { facts: { surface: 'private-host' } }],
    ['callback event', { facts: { callbackEvent: 'private.callback' } }],
    ['delivery state', { facts: { deliveryState: 'private-delivery' } }],
    ['prompt scope', { facts: { promptProducerScope: 'private.scope' } }],
    ['hash', { eventHash: '/private/hash' }],
    ['attempt number', { facts: { attemptNumber: 1.5 } }],
  ])('rejects an invalid direct model write for %s', async (_label, change) => {
    const source = await EventModel.findOne({}).lean();
    const row = {
      ...source,
      _id: undefined,
      sequence: 500,
      eventKeyHash: fingerprintTraceReference('model-test-key', _label),
      eventHash: fingerprintTraceReference('model-test-event', _label),
      ...change,
      ...(change.facts ? { facts: { ...source.facts, ...change.facts } } : {}),
    };

    await expect(EventModel.create(row)).rejects.toThrow();
  });

  test.each(['path', 'url', 'token', 'argv', 'pid', 'promptText', 'chatText', 'hostId'])(
    'rejects unsafe %s fields in facts at the model boundary',
    async (field) => {
      const hash = `sha256:${'1'.repeat(64)}`;
      await expect(
        EventModel.create({
          schemaVersion: 1,
          ownerScopeHash: hash,
          originRefHash: hash,
          sequence: 1,
          stage: 'source.bound',
          at: new Date(),
          facts: { [field]: '/private/output.html' },
          eventKeyHash: hash,
          contentHash: hash,
          previousEventHash: hash,
          eventHash: `sha256:${'2'.repeat(64)}`,
        }),
      ).rejects.toThrow();
    },
  );

  test('filters invalid legacy rows and marks the chain invalid without exposing unsafe text', async () => {
    const legacyOwner = 'owner-invalid-legacy';
    const legacyOrigin = 'origin-invalid-legacy';
    const hash = `sha256:${'7'.repeat(64)}`;
    await EventModel.collection.insertOne({
      schemaVersion: 1,
      ownerScopeHash: fingerprintTraceReference('owner', legacyOwner),
      originRefHash: fingerprintTraceReference('origin', legacyOrigin),
      sequence: 1,
      stage: 'private-stage',
      at: new Date('2026-08-22T12:00:00.000Z'),
      facts: { path: '/private/legacy-output.html' },
      eventKeyHash: hash,
      contentHash: hash,
      previousEventHash: hash,
      eventHash: `sha256:${'6'.repeat(64)}`,
    });

    const page = await service.read({ ownerId: legacyOwner, originRef: legacyOrigin, limit: 10 });

    expect(page.events).toEqual([]);
    expect(page.chain).toMatchObject({ pageVerified: false, fullChainVerified: false });
    expect(page.chain.errors).toContain('row_contract_invalid:1');
    expect(JSON.stringify(page)).not.toContain('/private/');
  });

  test('ingests an exact GlassHive payload through Mongo and permits completion', async () => {
    const ownerId = 'owner-contract-fixture';
    const originRef = completedDetailOriginRef;
    const workRef = completedDetailFixture.workRef;
    const runRef = 'run_synthetic_1';
    await service.recordLaunch({
      ownerId,
      originRef,
      sourceEventRef: 'source-contract-fixture',
      promptLayers: { contractVersion: 1, unknownLayerNames: [] },
      at: '2026-08-22T00:59:59.000Z',
    });
    await service.recordAcceptedLaunch({
      ownerId,
      originRef,
      workRef,
      at: '2026-08-22T01:00:00.500Z',
    });

    const ingestionInput = {
      ownerId,
      originRef,
      workRef,
      runRef,
      detail: completedDetailFixture,
    };
    const [ingestion, replay] = await Promise.all([
      service.recordGlassHiveWorkDetail(ingestionInput),
      service.recordGlassHiveWorkDetail(ingestionInput),
    ]);
    await service.recordCallback({
      ownerId,
      originRef,
      workRef,
      runRef,
      callbackRef: completedDetailTerminalCallbackRef,
      event: 'run.completed',
      workState: 'completed',
      workTerminal: true,
      callbackAt: '2026-08-22T01:00:07.000Z',
      callbackAcceptedAt: '2026-08-22T01:00:08.000Z',
      attemptNumber: 1,
    });
    await service.recordDelivery({
      ownerId,
      originRef,
      deliveryRef: 'core-surface-receipt-mongo',
      workRef,
      runRef,
      callbackRef: completedDetailTerminalCallbackRef,
      callbackEvent: 'run.completed',
      state: 'completed',
      terminal: true,
      surface: 'telegram',
      status: 'sent',
      at: '2026-08-22T01:00:09.000Z',
      attemptNumber: 1,
    });
    const ledgerPage = await service.read({ ownerId, originRef, limit: 100 });
    const trace = buildUnifiedOrchestrationTrace({
      ownerId,
      originRef,
      binding: { ownerId, originRef, workRef },
      externalWork: { ownerId, originRef, workRef, runId: runRef },
      glassHiveDetail: completedDetailFixture,
      glassHiveReadStatus: 'available',
      ledgerPage,
    });

    expect(ingestion).toMatchObject({ accepted: true, errors: [], eventCount: 10 });
    expect(replay).toMatchObject({ accepted: true, errors: [], eventCount: 10 });
    expect(
      await EventModel.countDocuments({
        ownerScopeHash: fingerprintTraceReference('owner', ownerId),
        originRefHash: fingerprintTraceReference('origin', originRef),
      }),
    ).toBe(17);
    expect(ledgerPage.chain.fullChainVerified).toBe(true);
    expect(trace.completionClaims).toEqual({ allowed: true });
  });
});
