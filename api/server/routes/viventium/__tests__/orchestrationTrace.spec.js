/* === VIVENTIUM START === Owner-scoped immutable orchestration trace route tests. === VIVENTIUM END === */

const express = require('express');
const request = require('supertest');
const {
  fingerprintTraceReference,
  projectGlassHiveProducerFactFingerprints,
} = require('@librechat/api');

const mockCollection = jest.fn();
const mockCollectionFindOne = jest.fn();
const mockRequestAccountApi = jest.fn();
const mockReadTraceEvents = jest.fn();
const mockRecordGlassHiveDetail = jest.fn();
const completedDetailV1 = require('../../../../../packages/api/src/trace/__fixtures__/glassHiveCompletedWorkDetail.v1.json');
const completedDetailFixture = (() => {
  const value = JSON.parse(JSON.stringify(completedDetailV1));
  const providerAttempt = value.traceability.providerAttempts?.[0];
  delete value.traceability.providerAttempts;
  value.traceability.contractVersion = 2;
  value.traceability.runtimeInvocations = providerAttempt
    ? [
        {
          attemptNumber: providerAttempt.attemptNumber,
          model: providerAttempt.model,
          profile: providerAttempt.profile,
          runtimeInvocationRef: `runtime_invocation_sha256:${'e'.repeat(64)}`,
          runtime: providerAttempt.runtime,
          runtimeInvokedAt: providerAttempt.runtimeInvokedAt,
        },
      ]
    : [];
  value.traceability.providerAuthorizationPreflights = [
    {
      attemptNumber: 1,
      failureClass: null,
      observedAt: '2026-08-22T01:00:02.500Z',
      provider: 'openai',
      providerAuthorizationPreflightRef: `provider_authorization_preflight_sha256:${'d'.repeat(64)}`,
      status: 'authorized',
    },
  ];
  const historyRows = [
    value.attemptHistory,
    value.capacityAttempts,
    value.callbackDeliveries,
    value.artifactHistory,
  ];
  const overflowCounts = [
    value.attemptHistoryOverflowCount,
    value.capacityAttemptOverflowCount,
    value.callbackDeliveryOverflowCount,
    value.artifactHistoryOverflowCount,
  ];
  const showing = historyRows.reduce(
    (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
  const overflowCount = overflowCounts.reduce(
    (total, count) => total + (Number.isInteger(count) ? count : 0),
    0,
  );
  value.historyPage = {
    cursor: null,
    nextCursor: null,
    limit: 16,
    total: showing + overflowCount,
    showing,
    overflowCount,
  };
  return value;
})();

jest.mock('mongoose', () => ({
  ...jest.requireActual('mongoose'),
  connection: { collection: (...args) => mockCollection(...args) },
}));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => {
    const ownerId = String(req.get('X-Test-Owner') || '');
    if (!ownerId) return res.status(401).json({ error: 'unauthorized' });
    req.user = { id: ownerId };
    return next();
  },
}));
jest.mock('~/server/services/viventium/GlassHiveAccountService', () => ({
  requestAccountApi: (...args) => mockRequestAccountApi(...args),
}));
jest.mock('~/server/services/viventium/OrchestrationTraceLedgerService', () => ({
  readOrchestrationTraceEvents: (...args) => mockReadTraceEvents(...args),
  recordGlassHiveWorkDetailTrace: (...args) => mockRecordGlassHiveDetail(...args),
}));

const originRef = 'ghi_0123456789abcdef0123456789abcdef';
const workRef = 'work_synthetic_1';
const runRef = 'run_synthetic_1';
const callbackRef = completedDetailFixture.callbackDeliveries.find(
  (delivery) => delivery.event === 'run.completed',
).callbackRef;

function createApp() {
  const app = express();
  app.use('/api/viventium/orchestration-traces', require('../orchestrationTrace'));
  return app;
}

function ledgerPage(ownerId = 'owner-a', options = {}) {
  const producerFingerprints = projectGlassHiveProducerFactFingerprints({
    workRef,
    runRef,
    detail: completedDetailFixture,
  });
  const workRefHash = fingerprintTraceReference('work', workRef);
  const runRefHash = fingerprintTraceReference('run', runRef);
  const callbackRefHash = fingerprintTraceReference('callback', callbackRef);
  const stages = [
    'source.bound',
    'prompt.layers.verified',
    'launch.accepted',
    'work.queued',
    'work.claimed',
    'work.admitted',
    'runtime.invoked',
    'provider.request.forwarded',
    'work.running',
    'attempt.history.complete',
    'capacity.history.complete',
    'work.completed',
    'callback.accepted',
    'callback.delivery.sent',
    'callback.history.complete',
  ].filter((stage) => options.httpAcceptedOnly !== true || stage !== 'callback.delivery.sent');
  const events = stages.map((stage, index) => ({
    sequence: index + 1,
    stage,
    at: new Date(Date.UTC(2026, 7, 22, 1, 0, index)).toISOString(),
    previousEventHash: `sha256:${String(index).padStart(64, '0')}`,
    eventHash: `sha256:${String(index + 1).padStart(64, '0')}`,
    facts: {
      ...(![
        'source.bound',
        'launch.accepted',
        'callback.accepted',
        'callback.delivery.sent',
      ].includes(stage)
        ? producerFingerprints
        : {}),
      workRefHash,
      runRefHash,
      ...(!['source.bound', 'launch.accepted'].includes(stage) ? { attemptNumber: 1 } : {}),
      ...(stage === 'source.bound'
        ? {
            sourceEventRefHash: fingerprintTraceReference('source_event', 'source-private'),
            logicalTurnRefHash: fingerprintTraceReference('logical_turn', 'turn-private'),
          }
        : {}),
      ...(stage === 'prompt.layers.verified'
        ? {
            promptLayerContractVersion: 1,
            promptProducerScope: 'glasshive.worker_prompt_registry',
            unknownPromptLayerCount: 0,
          }
        : {}),
      ...(stage === 'work.completed' ? { state: 'completed', terminal: true } : {}),
      ...(stage === 'work.completed' ? { producerTraceContractVersion: 2 } : {}),
      ...(stage === 'provider.request.forwarded'
        ? {
            provider: 'openai',
            providerStatus: 'completed',
            providerRequestRefHash: fingerprintTraceReference(
              'provider_request',
              'provider-request-synthetic-1',
            ),
          }
        : {}),
      ...(stage === 'callback.history.complete'
        ? { callbackRefHash, callbackEvent: 'run.completed' }
        : {}),
      ...(stage === 'callback.accepted' || stage === 'callback.delivery.sent'
        ? {
            callbackRefHash,
            ...(stage === 'callback.delivery.sent'
              ? { deliveryRefHash: fingerprintTraceReference('delivery', 'delivery-synthetic-1') }
              : {}),
            callbackEvent: 'run.completed',
            state: 'completed',
            terminal: true,
            ...(stage === 'callback.delivery.sent' ? { deliveryState: 'sent' } : {}),
          }
        : {}),
    },
  }));
  return {
    version: 1,
    ownerScopeHash: fingerprintTraceReference('owner', ownerId),
    originRefHash: fingerprintTraceReference('origin', originRef),
    events,
    chain: {
      pageVerified: true,
      fullChainVerified: options.hasMore !== true,
      errors: [],
      previousEventHash: `sha256:${'0'.repeat(64)}`,
      headEventHash: events.at(-1).eventHash,
    },
    pagination: {
      afterSequence: options.afterSequence || 0,
      limit: options.limit || 50,
      returned: events.length,
      remaining: options.hasMore ? 4 : 0,
      hasMore: options.hasMore === true,
      overflow: options.hasMore === true,
      nextCursor: options.hasMore ? events.at(-1).sequence : null,
    },
  };
}

describe('/api/viventium/orchestration-traces/:originRef', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCollection.mockImplementation((name) => ({
      findOne: (...args) => mockCollectionFindOne(name, ...args),
    }));
    mockCollectionFindOne.mockImplementation(async (name, filter) => {
      if (filter.ownerId !== 'owner-a') return null;
      if (name === 'viventium_glasshive_callback_bindings') {
        return {
          ownerId: 'owner-a',
          originRef,
          workRef,
          launchState: 'callback_confirmed',
        };
      }
      if (name === 'viventium_external_work') {
        return {
          ownerId: 'owner-a',
          originRef,
          workRef,
          runId: runRef,
          externalState: 'completed',
          deliveryState: 'sent',
        };
      }
      throw new Error(`unexpected collection ${name}`);
    });
    mockReadTraceEvents.mockResolvedValue(ledgerPage());
    mockRecordGlassHiveDetail.mockResolvedValue({ accepted: true, errors: [], eventCount: 10 });
    mockRequestAccountApi.mockResolvedValue(completedDetailFixture);
  });

  test('requires JWT ownership before reading trace existence', async () => {
    await request(createApp()).get(`/api/viventium/orchestration-traces/${originRef}`).expect(401);
    expect(mockCollection).not.toHaveBeenCalled();
    expect(mockReadTraceEvents).not.toHaveBeenCalled();
  });

  test('returns a completion claim from the immutable owner ledger', async () => {
    const response = await request(createApp())
      .get(`/api/viventium/orchestration-traces/${originRef}`)
      .set('X-Test-Owner', 'owner-a')
      .expect(200);

    expect(mockReadTraceEvents).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      originRef,
      afterSequence: 0,
      limit: 50,
    });
    expect(mockRecordGlassHiveDetail).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      originRef,
      workRef,
      runRef,
      detail: completedDetailFixture,
    });
    expect(mockCollectionFindOne).toHaveBeenCalledWith(
      'viventium_external_work',
      expect.any(Object),
      expect.objectContaining({ projection: expect.objectContaining({ runId: 1 }) }),
    );
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body).toMatchObject({
      version: 2,
      traceRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      integrity: { ownerScoped: true, completionClaimable: true },
      completionClaims: { allowed: true },
      ledger: { chain: { fullChainVerified: true } },
    });
    const serialized = JSON.stringify(response.body);
    for (const forbidden of ['owner-a', originRef, workRef, runRef, callbackRef]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('does not claim delivery from HTTP acceptance without a Core surface receipt', async () => {
    mockReadTraceEvents.mockResolvedValueOnce(ledgerPage('owner-a', { httpAcceptedOnly: true }));

    const response = await request(createApp())
      .get(`/api/viventium/orchestration-traces/${originRef}`)
      .set('X-Test-Owner', 'owner-a')
      .expect(200);

    expect(response.body.completionClaims.allowed).toBe(false);
    expect(response.body.integrity.missingStages).toContain('terminal_callback_delivery');
  });

  test('valid mutable producer facts cannot reuse older ledger fingerprints', async () => {
    const changedDetail = JSON.parse(JSON.stringify(completedDetailFixture));
    changedDetail.traceability.origin.sourceRevision += 1;
    mockRequestAccountApi.mockResolvedValueOnce(changedDetail);
    mockRecordGlassHiveDetail.mockResolvedValueOnce({
      accepted: false,
      errors: ['producer_facts_conflict'],
      eventCount: 0,
    });

    const response = await request(createApp())
      .get(`/api/viventium/orchestration-traces/${originRef}`)
      .set('X-Test-Owner', 'owner-a')
      .expect(200);

    expect(response.body.completionClaims.allowed).toBe(false);
    expect(response.body.integrity.conflicts).toContain('producer_fact_fingerprint_mismatch');
  });

  test('uses bounded cursor pagination and reports overflow', async () => {
    mockReadTraceEvents.mockResolvedValueOnce(
      ledgerPage('owner-a', { afterSequence: 4, limit: 25, hasMore: true }),
    );
    const response = await request(createApp())
      .get(`/api/viventium/orchestration-traces/${originRef}?after=4&limit=25`)
      .set('X-Test-Owner', 'owner-a')
      .expect(200);

    expect(mockReadTraceEvents).toHaveBeenCalledWith({
      ownerId: 'owner-a',
      originRef,
      afterSequence: 4,
      limit: 25,
    });
    expect(response.body.ledger.pagination).toMatchObject({
      hasMore: true,
      overflow: true,
      nextCursor: 15,
    });
    expect(response.body.integrity.completionClaimable).toBe(false);
  });

  test('does not ingest a noncompleted GlassHive detail as completion evidence', async () => {
    const detail = JSON.parse(JSON.stringify(completedDetailFixture));
    detail.state = 'running';
    mockRequestAccountApi.mockResolvedValueOnce(detail);

    const response = await request(createApp())
      .get(`/api/viventium/orchestration-traces/${originRef}`)
      .set('X-Test-Owner', 'owner-a')
      .expect(200);

    expect(mockRecordGlassHiveDetail).not.toHaveBeenCalled();
    expect(response.body.completionClaims.allowed).toBe(false);
  });

  test('fails closed when the remote producer scope is omitted', async () => {
    const detail = JSON.parse(JSON.stringify(completedDetailFixture));
    delete detail.traceability.promptLayers.producerScope;
    mockRequestAccountApi.mockResolvedValueOnce(detail);
    mockRecordGlassHiveDetail.mockResolvedValueOnce({
      accepted: false,
      errors: ['prompt_producer_scope_invalid'],
      eventCount: 0,
    });

    const response = await request(createApp())
      .get(`/api/viventium/orchestration-traces/${originRef}`)
      .set('X-Test-Owner', 'owner-a')
      .expect(200);

    expect(response.body.completionClaims.allowed).toBe(false);
    expect(response.body.integrity.missingStages).toContain('prompt_layers_verified');
  });

  test.each([
    ['run identity is omitted', (detail) => delete detail.runRef, 'producer_run_identity'],
    [
      'required callback history overflows',
      (detail) => {
        detail.callbackDeliveryOverflowCount = 1;
      },
      'producer_trace_contract',
    ],
  ])('fails closed when %s', async (_label, mutate, missingStage) => {
    const detail = JSON.parse(JSON.stringify(completedDetailFixture));
    mutate(detail);
    mockRequestAccountApi.mockResolvedValueOnce(detail);
    mockRecordGlassHiveDetail.mockResolvedValueOnce({
      accepted: false,
      errors: ['producer_contract_invalid'],
      eventCount: 0,
    });

    const response = await request(createApp())
      .get(`/api/viventium/orchestration-traces/${originRef}`)
      .set('X-Test-Owner', 'owner-a')
      .expect(200);

    expect(response.body.completionClaims.allowed).toBe(false);
    expect(response.body.integrity.missingStages).toContain(missingStage);
  });

  test('returns 404 for another owner without calling GlassHive', async () => {
    mockReadTraceEvents.mockResolvedValueOnce({
      ...ledgerPage('owner-b'),
      events: [],
      chain: {
        pageVerified: true,
        fullChainVerified: true,
        errors: [],
        previousEventHash: `sha256:${'0'.repeat(64)}`,
        headEventHash: null,
      },
    });
    await request(createApp())
      .get(`/api/viventium/orchestration-traces/${originRef}`)
      .set('X-Test-Owner', 'owner-b')
      .expect(404);

    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('rejects invalid pagination before database work', async () => {
    await request(createApp())
      .get(`/api/viventium/orchestration-traces/${originRef}?after=-1&limit=1000`)
      .set('X-Test-Owner', 'owner-a')
      .expect(400);
    expect(mockCollection).not.toHaveBeenCalled();
    expect(mockReadTraceEvents).not.toHaveBeenCalled();
  });
});
