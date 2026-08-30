/* === VIVENTIUM START === Immutable owner-scoped orchestration trace tests. === VIVENTIUM END === */

import {
  appendOrchestrationTraceEvent,
  buildUnifiedOrchestrationTrace,
  projectGlassHiveProducerFactFingerprints,
  readOrchestrationTraceLedger,
} from '../index';
import completedDetailFixture from '../__fixtures__/glassHiveCompletedWorkDetail.v1.json';

import type {
  OrchestrationTraceEventRow,
  OrchestrationTraceLedgerStore,
  TraceStage,
} from '../orchestrationTraceLedger';

const ownerId = 'owner-synthetic-1';
const originRef = 'ghi_0123456789abcdef0123456789abcdef';
const workRef = 'work_synthetic_1';
const runRef = 'run_synthetic_1';
const callbackRef = String(
  completedDetailFixture.callbackDeliveries.find((item) => item.event === 'run.completed')
    ?.callbackRef || '',
);

function completedDetailV2() {
  const value = JSON.parse(JSON.stringify(completedDetailFixture));
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
    (total: number, rows: unknown) => total + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
  const overflowCount = overflowCounts.reduce(
    (total: number, count: unknown) => total + (Number.isInteger(count) ? Number(count) : 0),
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
}

class MemoryLedgerStore implements OrchestrationTraceLedgerStore {
  rows: OrchestrationTraceEventRow[] = [];

  async findByEventKey(query: {
    ownerScopeHash: string;
    originRefHash: string;
    eventKeyHash: string;
  }) {
    return (
      this.rows.find(
        (row) =>
          row.ownerScopeHash === query.ownerScopeHash &&
          row.originRefHash === query.originRefHash &&
          row.eventKeyHash === query.eventKeyHash,
      ) || null
    );
  }

  async findLatest(query: { ownerScopeHash: string; originRefHash: string }) {
    return (
      this.rows
        .filter(
          (row) =>
            row.ownerScopeHash === query.ownerScopeHash &&
            row.originRefHash === query.originRefHash,
        )
        .sort((left, right) => right.sequence - left.sequence)[0] || null
    );
  }

  async findBySequence(query: { ownerScopeHash: string; originRefHash: string; sequence: number }) {
    return (
      this.rows.find(
        (row) =>
          row.ownerScopeHash === query.ownerScopeHash &&
          row.originRefHash === query.originRefHash &&
          row.sequence === query.sequence,
      ) || null
    );
  }

  async insert(row: OrchestrationTraceEventRow) {
    this.rows.push({ ...row, facts: { ...row.facts } });
    return row;
  }

  async listPage(query: {
    ownerScopeHash: string;
    originRefHash: string;
    afterSequence: number;
    limit: number;
  }) {
    return this.rows
      .filter(
        (row) =>
          row.ownerScopeHash === query.ownerScopeHash &&
          row.originRefHash === query.originRefHash &&
          row.sequence > query.afterSequence,
      )
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, query.limit);
  }

  async countAfter(query: {
    ownerScopeHash: string;
    originRefHash: string;
    afterSequence: number;
  }) {
    return this.rows.filter(
      (row) =>
        row.ownerScopeHash === query.ownerScopeHash &&
        row.originRefHash === query.originRefHash &&
        row.sequence > query.afterSequence,
    ).length;
  }
}

async function appendLifecycle(
  store: MemoryLedgerStore,
  terminalStage: 'work.completed' | 'work.failed' | 'work.cancelled' = 'work.completed',
  terminalOrder: Array<'work' | 'callback' | 'delivery'> = ['work', 'callback', 'delivery'],
  launchWorkRef = workRef,
  callbackOverrides: {
    event?: string;
    state?: string;
    attemptNumber?: number;
    deliveryEvent?: string;
    deliveryState?: string;
    deliveryTerminal?: boolean;
    workState?: string;
    workTerminal?: boolean;
    deliveryRef?: string;
  } = {},
  terminalAt: Partial<Record<'work' | 'callback' | 'delivery', string>> = {},
) {
  const producerFingerprints =
    projectGlassHiveProducerFactFingerprints({
      workRef,
      runRef,
      detail: completedDetailV2(),
    }) || {};
  const stages: Array<{ stage: TraceStage; at: string }> = [
    { stage: 'source.bound', at: '2026-08-22T01:00:00.000Z' },
    { stage: 'prompt.layers.verified', at: '2026-08-22T01:00:00.100Z' },
    { stage: 'launch.accepted', at: '2026-08-22T01:00:00.200Z' },
    { stage: 'work.queued', at: '2026-08-22T01:00:01.000Z' },
    { stage: 'work.claimed', at: '2026-08-22T01:00:02.000Z' },
    { stage: 'work.admitted', at: '2026-08-22T01:00:03.000Z' },
    { stage: 'runtime.invoked', at: '2026-08-22T01:00:04.000Z' },
    { stage: 'work.running', at: '2026-08-22T01:00:05.000Z' },
    { stage: 'provider.request.forwarded', at: '2026-08-22T01:00:05.500Z' },
    { stage: 'attempt.history.complete', at: '2026-08-22T01:00:05.100Z' },
    { stage: 'capacity.history.complete', at: '2026-08-22T01:00:05.200Z' },
    ...terminalOrder.map((item, index) => {
      let stage: TraceStage = 'callback.delivery.sent';
      if (item === 'work') stage = terminalStage;
      if (item === 'callback') stage = 'callback.accepted';
      return { stage, at: terminalAt[item] || `2026-08-22T01:00:0${6 + index}.000Z` };
    }),
    { stage: 'callback.history.complete', at: '2026-08-22T01:00:09.500Z' },
  ];
  for (const item of stages) {
    const terminalState = terminalStage.slice(5);
    const callbackAttempt = callbackOverrides.attemptNumber ?? 1;
    await appendOrchestrationTraceEvent({
      store,
      ownerId,
      originRef,
      eventKey: `${item.stage}:1`,
      stage: item.stage,
      at: item.at,
      facts: {
        ...(![
          'source.bound',
          'launch.accepted',
          'callback.accepted',
          'callback.delivery.sent',
          'provider.request.forwarded',
        ].includes(item.stage)
          ? { ...producerFingerprints, producerTraceContractVersion: 2 }
          : {}),
        workRef: item.stage === 'launch.accepted' ? launchWorkRef : workRef,
        runRef,
        ...(!['source.bound', 'launch.accepted'].includes(item.stage)
          ? {
              attemptNumber: [
                'callback.accepted',
                'callback.delivery.sent',
                'callback.history.complete',
              ].includes(item.stage)
                ? callbackAttempt
                : 1,
            }
          : {}),
        ...(item.stage === 'source.bound'
          ? { sourceEventRef: 'telegram:update:12346', logicalTurnRef: 'logical-turn-9' }
          : {}),
        ...(item.stage === 'prompt.layers.verified'
          ? {
              promptLayerContractVersion: 1,
              promptProducerScope: 'glasshive.worker_prompt_registry',
              unknownPromptLayerCount: 0,
            }
          : {}),
        ...(item.stage === 'callback.history.complete'
          ? { callbackRef, callbackEvent: 'run.completed' }
          : {}),
        ...(item.stage === 'provider.request.forwarded'
          ? {
              providerRequestRef: 'provider-request-synthetic-1',
              provider: 'openai',
              providerStatus: 'completed',
            }
          : {}),
        ...(item.stage === terminalStage
          ? {
              state: callbackOverrides.workState || terminalState,
              terminal: callbackOverrides.workTerminal ?? true,
            }
          : {}),
        ...(item.stage === 'callback.accepted' || item.stage === 'callback.delivery.sent'
          ? {
              callbackRef,
              callbackEvent:
                item.stage === 'callback.delivery.sent'
                  ? callbackOverrides.deliveryEvent ||
                    callbackOverrides.event ||
                    (terminalStage === 'work.completed' ? 'run.completed' : `run.${terminalState}`)
                  : callbackOverrides.event ||
                    (terminalStage === 'work.completed' ? 'run.completed' : `run.${terminalState}`),
              state:
                item.stage === 'callback.delivery.sent'
                  ? callbackOverrides.deliveryState || callbackOverrides.state || terminalState
                  : callbackOverrides.state || terminalState,
              terminal:
                item.stage === 'callback.delivery.sent'
                  ? (callbackOverrides.deliveryTerminal ?? true)
                  : true,
              ...(item.stage === 'callback.delivery.sent'
                ? { deliveryRef: callbackOverrides.deliveryRef ?? 'delivery-synthetic-1' }
                : {}),
              deliveryState: item.stage === 'callback.delivery.sent' ? 'sent' : undefined,
            }
          : {}),
      },
    });
  }
}

async function buildTrace(
  store: MemoryLedgerStore,
  overrides: Partial<Parameters<typeof buildUnifiedOrchestrationTrace>[0]> = {},
) {
  const ledgerPage = await readOrchestrationTraceLedger({
    store,
    ownerId,
    originRef,
    limit: 100,
  });
  return buildUnifiedOrchestrationTrace({
    ownerId,
    originRef,
    binding: { ownerId, originRef, workRef, launchState: 'callback_confirmed' },
    externalWork: {
      ownerId,
      originRef,
      workRef,
      runId: runRef,
      externalState: 'completed',
      deliveryState: 'sent',
    },
    deliveries: [],
    promptLayers: { contractVersion: 1, unknownLayerNames: [] },
    glassHiveDetail: {
      ...completedDetailV2(),
      viewRef: 'https://private-host.invalid/w/signed-view-token',
    },
    ledgerPage,
    ...overrides,
  });
}

describe('buildUnifiedOrchestrationTrace', () => {
  test('claims only completed work with a verified chain and matching terminal delivery', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const trace = await buildTrace(store);

    expect(trace.integrity).toMatchObject({
      ownerScoped: true,
      persistence: {
        appendOnlyApi: true,
        databaseImmutable: false,
        hashChainVerified: true,
      },
      completionClaimable: true,
      terminalTruth: { isTerminal: true, successful: true, state: 'completed' },
      lifecycleChronology: { status: 'verified' },
      missingStages: [],
      conflicts: [],
    });
    expect(trace.ledger).toMatchObject({
      chain: { pageVerified: true, fullChainVerified: true },
      pagination: { hasMore: false, overflow: false },
    });
    expect(trace.completionClaims.allowed).toBe(true);
    expect(trace.traceability.promptLayers.producerScope).toBe('glasshive.worker_prompt_registry');
    expect(trace.traceability.promptLayers).toEqual(trace.integrity.promptLayers);
    expect(trace.current.viewRef).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(trace.current.artifactRefs.refs[0]?.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);

    const serialized = JSON.stringify(trace);
    for (const forbidden of [
      ownerId,
      originRef,
      workRef,
      runRef,
      callbackRef,
      'private-host.invalid',
      'signed-view-token',
      '/private/',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  test('does not claim completion without an actual completed provider-forwarding receipt', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    store.rows = store.rows.filter((row) => row.stage !== 'provider.request.forwarded');
    const trace = await buildTrace(store);

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toContain('provider_request_forwarded');
  });

  test('HTTP-accepted terminal callback without a surface receipt remains non-claimable', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store, 'work.completed', ['work', 'callback']);
    const trace = await buildTrace(store);

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toContain('terminal_callback_delivery');
  });

  test.each(['work.failed', 'work.cancelled'] as const)(
    'never claims %s work as successful completion',
    async (terminalStage) => {
      const store = new MemoryLedgerStore();
      await appendLifecycle(store, terminalStage);
      const trace = await buildTrace(store, {
        externalWork: {
          ownerId,
          originRef,
          workRef,
          externalState: terminalStage.slice(5),
          deliveryState: 'sent',
        },
        glassHiveDetail: { workRef, state: terminalStage.slice(5) },
      });

      expect(trace.integrity.completionClaimable).toBe(false);
      expect(trace.integrity.terminalTruth).toEqual({
        isTerminal: true,
        successful: false,
        state: terminalStage.slice(5),
        evidenceExact: true,
      });
      expect(trace.integrity.missingStages).toContain('successful_terminal_work');
    },
  );

  test('launch callback confirmation alone is not terminal callback or delivery proof', async () => {
    const store = new MemoryLedgerStore();
    await appendOrchestrationTraceEvent({
      store,
      ownerId,
      originRef,
      eventKey: 'source',
      stage: 'source.bound',
      facts: { workRef },
    });
    const trace = await buildTrace(store);

    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.missingStages).toEqual(
      expect.arrayContaining(['terminal_callback_acceptance', 'terminal_callback_delivery']),
    );
  });

  test('does not borrow launch acceptance from another work item', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store, 'work.completed', ['work', 'callback', 'delivery'], 'other-work');
    const trace = await buildTrace(store);

    expect(trace.ledger?.chain.fullChainVerified).toBe(true);
    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.missingStages).toContain('launch_accepted');
  });

  test('requires terminal callback and delivery to match work, run, and callback', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const deliveryIndex = store.rows.findIndex((row) => row.stage === 'callback.delivery.sent');
    store.rows[deliveryIndex] = {
      ...store.rows[deliveryIndex],
      facts: { ...store.rows[deliveryIndex].facts, runRefHash: `sha256:${'f'.repeat(64)}` },
    };
    const trace = await buildTrace(store);

    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.conflicts).toContain('terminal_callback_delivery_mismatch');
  });

  test('does not let completed work borrow a callback from another run', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const terminalIndex = store.rows.findIndex((row) => row.stage === 'work.completed');
    store.rows[terminalIndex] = {
      ...store.rows[terminalIndex],
      facts: { ...store.rows[terminalIndex].facts, runRefHash: `sha256:${'e'.repeat(64)}` },
    };
    const trace = await buildTrace(store);

    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.conflicts).toContain('terminal_callback_identity_mismatch');
    expect(trace.integrity.missingStages).toContain('terminal_callback_acceptance');
  });

  test('does not assemble one lifecycle from different runs', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const claimedIndex = store.rows.findIndex((row) => row.stage === 'work.claimed');
    store.rows[claimedIndex] = {
      ...store.rows[claimedIndex],
      facts: { ...store.rows[claimedIndex].facts, runRefHash: `sha256:${'d'.repeat(64)}` },
    };
    const trace = await buildTrace(store);

    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.lifecycleChronology).toMatchObject({
      status: 'missing',
      reason: 'lifecycle_stage_missing',
    });
    expect(trace.integrity.missingStages).toContain('monotonic_lifecycle');
  });

  test('does not borrow attempt or capacity history from another run', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    for (const stage of ['attempt.history.complete', 'capacity.history.complete']) {
      const index = store.rows.findIndex((row) => row.stage === stage);
      store.rows[index] = {
        ...store.rows[index],
        facts: { ...store.rows[index].facts, runRefHash: `sha256:${'c'.repeat(64)}` },
      };
    }
    const trace = await buildTrace(store);

    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.missingStages).toEqual(
      expect.arrayContaining(['attempt_history', 'capacity_attempt_history']),
    );
  });

  test('run.failed callback evidence cannot satisfy completed work', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store, 'work.completed', ['work', 'callback', 'delivery'], workRef, {
      event: 'run.failed',
      state: 'failed',
    });
    const trace = await buildTrace(store);

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toEqual(
      expect.arrayContaining(['terminal_callback_acceptance', 'terminal_callback_delivery']),
    );
  });

  test('a completed stage with contradictory terminal facts cannot satisfy completion', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store, 'work.completed', ['work', 'callback', 'delivery'], workRef, {
      workState: 'failed',
      workTerminal: false,
    });
    const trace = await buildTrace(store);

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.conflicts).toContain('terminal_work_fact_mismatch');
  });

  test('does not mix attempts across lifecycle, callback, and delivery', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store, 'work.completed', ['work', 'callback', 'delivery'], workRef, {
      attemptNumber: 2,
    });
    const trace = await buildTrace(store);

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toContain('terminal_callback_acceptance');
  });

  test('duplicate terminal callback identities fail closed', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    await appendOrchestrationTraceEvent({
      store,
      ownerId,
      originRef,
      eventKey: 'callback.accepted:duplicate-terminal',
      stage: 'callback.accepted',
      at: '2026-08-22T01:00:08.500Z',
      facts: {
        workRef,
        runRef,
        attemptNumber: 1,
        callbackRef:
          'callback_sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        callbackEvent: 'run.completed',
        state: 'completed',
        terminal: true,
      },
    });
    const trace = await buildTrace(store);

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.conflicts).toContain('duplicate_terminal_callbacks');
  });

  test('requires an immutable identity for the matching sent delivery', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store, 'work.completed', ['work', 'callback', 'delivery'], workRef, {
      deliveryRef: '',
    });
    const trace = await buildTrace(store);

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toContain('terminal_callback_delivery');
  });

  test('fails closed when a second surface claims the same terminal presentation', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    await appendOrchestrationTraceEvent({
      store,
      ownerId,
      originRef,
      eventKey: 'callback.delivery.sent:second-surface',
      stage: 'callback.delivery.sent',
      at: '2026-08-22T01:00:10.000Z',
      facts: {
        deliveryRef: 'delivery-synthetic-2',
        workRef,
        runRef,
        attemptNumber: 1,
        callbackRef,
        callbackEvent: 'run.completed',
        state: 'completed',
        terminal: true,
        surface: 'web',
        deliveryState: 'sent',
      },
    });

    const trace = await buildTrace(store);

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.conflicts).toContain('duplicate_terminal_deliveries');
    expect(trace.integrity.missingStages).toContain('terminal_callback_delivery');
  });

  test.each([
    ['wrong event', { deliveryEvent: 'run.failed' }],
    ['wrong state', { deliveryState: 'failed' }],
    ['nonterminal delivery', { deliveryTerminal: false }],
  ] as const)('rejects a settled delivery with %s', async (_label, overrides) => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(
      store,
      'work.completed',
      ['work', 'callback', 'delivery'],
      workRef,
      overrides,
    );
    const trace = await buildTrace(store);

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toContain('terminal_callback_delivery');
  });

  test('blocks reversed lifecycle chronology', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const admittedIndex = store.rows.findIndex((row) => row.stage === 'work.admitted');
    store.rows[admittedIndex] = {
      ...store.rows[admittedIndex],
      at: '2026-08-22T00:59:59.000Z',
    };
    const trace = await buildTrace(store);

    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.lifecycleChronology.status).toBe('invalid');
    expect(trace.integrity.missingStages).toContain('monotonic_lifecycle');
  });

  test('blocks a sent delivery that precedes its matching terminal callback', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store, 'work.completed', ['work', 'delivery', 'callback']);
    const trace = await buildTrace(store);

    expect(trace.ledger?.chain.fullChainVerified).toBe(true);
    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.lifecycleChronology).toMatchObject({
      status: 'invalid',
      reason: 'terminal_causal_order_invalid',
    });
    expect(trace.integrity.missingStages).toContain('monotonic_lifecycle');
  });

  test('blocks a terminal callback that precedes completed work', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store, 'work.completed', ['callback', 'work', 'delivery']);
    const trace = await buildTrace(store);

    expect(trace.ledger?.chain.fullChainVerified).toBe(true);
    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.lifecycleChronology).toMatchObject({
      status: 'invalid',
      reason: 'terminal_causal_order_invalid',
    });
    expect(trace.integrity.missingStages).toContain('monotonic_lifecycle');
  });

  test.each([
    ['sent delivery before callback', ['work', 'delivery', 'callback']],
    ['callback before completed work', ['callback', 'work', 'delivery']],
  ] as const)(
    'blocks %s by sequence even when timestamps claim the correct order',
    async (_label, terminalOrder) => {
      const store = new MemoryLedgerStore();
      await appendLifecycle(
        store,
        'work.completed',
        [...terminalOrder],
        workRef,
        {},
        {
          work: '2026-08-22T01:00:06.000Z',
          callback: '2026-08-22T01:00:07.000Z',
          delivery: '2026-08-22T01:00:08.000Z',
        },
      );
      const trace = await buildTrace(store);

      expect(trace.ledger?.chain.fullChainVerified).toBe(true);
      expect(trace.integrity.completionClaimable).toBe(false);
      expect(trace.integrity.lifecycleChronology).toMatchObject({
        status: 'invalid',
        reason: 'terminal_causal_order_invalid',
      });
      expect(trace.integrity.missingStages).toContain('monotonic_lifecycle');
    },
  );

  test('invalid prompt-layer names fail instead of being filtered into verified', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const trace = await buildTrace(store, {
      glassHiveDetail: {
        workRef,
        state: 'completed',
        traceability: {
          promptLayers: {
            contractVersion: 1,
            producerScope: 'glasshive.worker_prompt_registry',
            unknownLayerNames: ['bad layer text'],
          },
        },
      },
    });

    expect(trace.integrity.promptLayers).toMatchObject({
      status: 'invalid',
      invalidNameCount: 1,
    });
    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.missingStages).toContain('prompt_layers_verified');
  });

  test('local-only prompt telemetry cannot satisfy remote worker proof', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const trace = await buildTrace(store, {
      promptLayers: { contractVersion: 1, unknownLayerNames: [] },
      glassHiveDetail: { workRef, state: 'completed' },
    });

    expect(trace.integrity.promptLayers).toMatchObject({
      status: 'unknown',
      reason: 'remote_prompt_layer_capability_missing',
    });
    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toContain('prompt_layers_verified');
  });

  test('producer run identity is required and must match the immutable terminal run', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const trace = await buildTrace(store, {
      glassHiveDetail: {
        workRef,
        state: 'completed',
        traceability: {
          promptLayers: {
            contractVersion: 1,
            producerScope: 'glasshive.worker_prompt_registry',
            unknownLayerNames: [],
          },
        },
      },
    });

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toContain('producer_run_identity');
  });

  test('redacts arbitrary worker diagnostic labels', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const trace = await buildTrace(store, {
      glassHiveDetail: {
        workRef,
        state: 'private-worker-state',
        capacity: { class: 'private-host-id' },
        artifactRefs: {
          available: true,
          refs: [{ kind: 'private-customer-kind', ref: 'private-artifact-ref' }],
          overflowCount: 0,
        },
      },
    });

    expect(trace.current.workState).toBe('unknown');
    expect(trace.current.capacity?.class).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(trace.current.artifactRefs).toEqual({ available: false, refs: [], overflowCount: 0 });
    expect(JSON.stringify(trace)).not.toContain('private-');
  });

  test('an invalid supplied work identity cannot be filtered out of a completion claim', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const trace = await buildTrace(store, {
      glassHiveDetail: {
        workRef: '/private/invalid-work',
        runRef: 'run_sha256:31c7ab224ea37b31d7ee20d3c86b698f4accc215ac08afa90b70c80471cece7b',
        state: 'completed',
        traceability: {
          promptLayers: {
            contractVersion: 1,
            producerScope: 'glasshive.worker_prompt_registry',
            unknownLayerNames: [],
          },
        },
        artifactRefs: { available: false, refs: [], overflowCount: 0 },
      },
    });

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.conflicts).toContain('work_ref_invalid');
  });

  test('an invalid artifact contract cannot reuse prior completion evidence', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const trace = await buildTrace(store, {
      glassHiveDetail: {
        workRef,
        runRef: 'run_sha256:31c7ab224ea37b31d7ee20d3c86b698f4accc215ac08afa90b70c80471cece7b',
        state: 'completed',
        traceability: {
          promptLayers: {
            contractVersion: 1,
            producerScope: 'glasshive.worker_prompt_registry',
            unknownLayerNames: [],
          },
        },
        artifactRefs: {
          available: true,
          refs: [{ artifactRef: 'artifact_sha256:unsafe', path: '/private/output.html' }],
          overflowCount: 0,
        },
      },
    });

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toContain('artifact_refs_verified');
    expect(JSON.stringify(trace)).not.toContain('/private/');
  });

  test('an inconsistent producer-history overflow blocks prior complete ledger evidence', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    const detail = JSON.parse(JSON.stringify(completedDetailFixture));
    detail.callbackDeliveryOverflowCount = 1;
    const trace = await buildTrace(store, { glassHiveDetail: detail });

    expect(trace.completionClaims.allowed).toBe(false);
    expect(trace.integrity.missingStages).toContain('producer_trace_contract');
    expect(trace.integrity.producerTraceContract.errors).toContain('callback_history_invalid');
  });

  test('an invalid launch prompt contract cannot be repaired into verified by a later replay', async () => {
    const store = new MemoryLedgerStore();
    await appendOrchestrationTraceEvent({
      store,
      ownerId,
      originRef,
      eventKey: 'prompt-invalid-before-launch',
      stage: 'prompt.layers.invalid',
      facts: { promptLayerContractVersion: 1, unknownPromptLayerCount: 1 },
    });
    await appendLifecycle(store);
    const trace = await buildTrace(store);

    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.conflicts).toContain('prompt_layer_contract_invalid');
    expect(trace.integrity.missingStages).toContain('prompt_layers_verified');
  });

  test('fails explicitly when attempt and capacity history producers are absent', async () => {
    const store = new MemoryLedgerStore();
    await appendLifecycle(store);
    store.rows = store.rows.filter(
      (row) => !['attempt.history.complete', 'capacity.history.complete'].includes(row.stage),
    );
    const trace = await buildTrace(store);

    expect(trace.integrity.completionClaimable).toBe(false);
    expect(trace.integrity.missingStages).toEqual(
      expect.arrayContaining(['attempt_history', 'capacity_attempt_history']),
    );
  });
});
