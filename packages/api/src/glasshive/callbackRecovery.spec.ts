import { createGlassHiveCallbackBindingService } from './callbackBinding';
import { hasKnownExternalWork } from './knownExternalWork';

const terminal = {
  _id: 'origin-test',
  originRef: 'origin-test',
  ownerId: 'owner-test',
  workRef: 'work-test',
  runId: 'run-test',
  externalState: 'completed',
  launchState: 'callback_confirmed',
  deliveryState: 'pending',
};
const receipt = {
  ownerId: 'owner-test',
  originRef: 'origin-test',
  workRef: 'work-test',
  runId: 'run-test',
  workerId: 'worker-test',
  callbackId: 'cb_terminal_' + 'a'.repeat(64),
  resultRevision: 1,
  resultDigest: 'sha256:' + 'b'.repeat(64),
  acceptedOperationId: 'c'.repeat(32),
};

function harness(row = terminal) {
  const cursor = { sort: jest.fn(), limit: jest.fn(), toArray: jest.fn().mockResolvedValue([row]) };
  cursor.sort.mockReturnValue(cursor);
  cursor.limit.mockReturnValue(cursor);
  const update = jest.fn().mockResolvedValue({ matchedCount: 1 });
  const accepted = jest.fn().mockResolvedValue(receipt);
  const evidence = jest.fn().mockResolvedValue(null);
  const request = jest.fn().mockResolvedValue({ state: 'delivering' });
  const defer = jest.fn().mockResolvedValue(null);
  const trace = jest.fn().mockResolvedValue({ accepted: true });
  const projectionUpdate = jest.fn();
  const invalidate = jest.fn();
  const collection = jest.fn((name) => ({
    find: jest.fn().mockReturnValue(cursor),
    findOne: name === 'viventium_glasshive_callback_results' ? accepted : evidence,
    findOneAndUpdate: projectionUpdate,
    updateOne: update,
  }));
  const service = createGlassHiveCallbackBindingService({
    mongoose: { connection: { collection } },
    logger: { info: jest.fn(), warn: jest.fn() },
    canonicalizeGlassHiveCallbackRef: jest.fn(),
    resolveTelegramMappingByUserId: jest.fn(),
    getMessages: jest.fn(),
    markUserParallelWorkKnown: jest.fn().mockResolvedValue(true),
    buildTrustedDelegationIdentity: jest.fn(),
    requestAccountApi: request,
    signTrustedDelegationIdentity: jest.fn(),
    normalizeInteractionSourceSegments: jest.fn(),
    promptLayerIntegritySnapshot: jest.fn(),
    recordOrchestrationTraceAcceptedLaunch: jest.fn(),
    recordOrchestrationTraceCallback: jest.fn(),
    recordOrchestrationTraceFailedLaunch: jest.fn(),
    recordOrchestrationTraceLaunch: jest.fn(),
    recordGlassHiveWorkDetailTrace: trace,
    deferGlassHiveWorkStateReconciliation: defer,
    reconcileAuthoritativeGlassHiveWorkState: jest.fn(),
    invalidateActiveWorkSnapshot: invalidate,
  });
  return { service, accepted, evidence, request, update, defer, trace, projectionUpdate, collection,
    invalidate,
  };
}

test('existing reconciliation requests only the exact accepted terminal result', async () => {
  const h = harness();
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.accepted).toHaveBeenCalledWith(
    {
      ownerId: terminal.ownerId,
      originRef: terminal.originRef,
      workRef: terminal.workRef,
      runId: terminal.runId,
    },
    expect.any(Object),
  );
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(h.request).toHaveBeenCalledWith({
    ownerId: terminal.ownerId,
    path: '/v1/callback-associations/recover',
    method: 'POST',
    timeoutMs: 3000,
    body: {
      originRef: terminal.originRef,
      workRef: terminal.workRef,
      runId: terminal.runId,
      workerId: receipt.workerId,
      callbackId: receipt.callbackId,
      resultRevision: receipt.resultRevision,
      resultDigest: receipt.resultDigest,
    },
  });
  expect(h.update).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerId: terminal.ownerId,
      originRef: terminal.originRef,
      runId: terminal.runId,
    }),
    expect.objectContaining({
      $set: expect.objectContaining({ stateReconciliationNextAt: expect.any(Date) }),
    }),
  );
});

test('reconciliation does not replay existing useful evidence', async () => {
  const h = harness();
  h.evidence.mockResolvedValue({ _id: 'existing-useful-result' });
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.request).not.toHaveBeenCalled();
  expect(h.evidence).toHaveBeenCalledWith(
    expect.objectContaining({
      ownerId: terminal.ownerId,
      originRef: terminal.originRef,
      workRef: terminal.workRef,
      runId: terminal.runId,
      terminalCallbackId: receipt.callbackId,
      terminalCallbackResultDigest: receipt.resultDigest,
      terminalCallbackResultRevision: 1,
    }),
    expect.any(Object),
  );
});

test('an unaccepted result cannot request sender recovery', async () => {
  const h = harness();
  h.accepted.mockResolvedValue(null);
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.request).not.toHaveBeenCalled();
});

test('cooldown and settled delivery do not request recovery', async () => {
  for (const row of [
    { ...terminal, stateReconciliationNextAt: new Date(Date.now() + 60_000) },
    { ...terminal, deliveryState: 'sent' },
  ]) {
    const h = harness(row);
    await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
    expect(h.request).not.toHaveBeenCalled();
  }
});

test('receiver request failure uses existing bounded reconciliation delay', async () => {
  const h = harness();
  const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
  h.request.mockRejectedValue(error);
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.defer).toHaveBeenCalledWith({ ownerId: terminal.ownerId, row: terminal, error });
});

test('after the existing callback owner persists useful evidence, another scan requests nothing', async () => {
  const h = harness();
  h.request.mockImplementation(async () => {
    h.evidence.mockResolvedValue({ _id: 'persisted-by-existing-callback-effect-owner' });
    return { state: 'delivering' };
  });
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.request).toHaveBeenCalledTimes(1);
});


const retainedStop = {
  ...terminal, workerId: 'worker-test', externalState: 'cancelled',
};
const stopDelivery = {
  callbackRef: 'callback_sha256:' + 'd'.repeat(64), callbackRevision: 27,
  event: 'run.cancelled', status: 'dead_lettered', resultRevision: 0, resultDigest: null,
  payloadSha256: 'sha256:' + 'e'.repeat(64), authoritySha256: 'sha256:' + 'f'.repeat(64),
};
const stopDetail = { workRef: terminal.workRef, state: 'cancelled', callbackDeliveries: [stopDelivery] };

/* === VIVENTIUM START: Silent settlement must remove only the current owned pending delivery. === */
function matchesRow(filter: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === '$or')
      return (expected as Record<string, unknown>[]).some((part) => matchesRow(part, row));
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      const condition = expected as Record<string, unknown>;
      if ('$exists' in condition) return Object.hasOwn(row, key) === condition.$exists;
      if ('$in' in condition) return (condition.$in as unknown[]).includes(row[key]);
      if ('$nin' in condition) return !(condition.$nin as unknown[]).includes(row[key]);
      if ('$ne' in condition) return row[key] !== condition.$ne;
    }
    return expected instanceof Date && row[key] instanceof Date
      ? expected.getTime() === (row[key] as Date).getTime()
      : row[key] === expected;
  });
}

function silentHarness(typed = false) {
  const row = {
    ...retainedStop,
    deliveryState: 'enqueued',
    adjudicationState: 'silent',
    attentionPending: false,
    followUpMessageId: '',
    updatedAt: new Date('2026-10-24T01:00:00Z'),
    ...(typed
      ? {
          terminalCallbackRunId: receipt.runId,
          terminalCallbackId: receipt.callbackId,
          terminalCallbackResultDigest: receipt.resultDigest,
          terminalCallbackResultRevision: 1,
          terminalCallbackAcceptedOperationId: receipt.acceptedOperationId,
          terminalCallbackEffectLeaseGeneration: 2,
        }
      : {}),
  };
  const stored: Record<string, unknown> = { ...row };
  const evidence: Record<string, unknown> = {
    ownerId: row.ownerId,
    originRef: row.originRef,
    workRef: row.workRef,
    workerId: row.workerId,
    runId: row.runId,
    state: 'silent',
    workState: 'cancelled',
    workTerminal: true,
    event: 'run.cancelled',
    callbackRef: stopDelivery.callbackRef,
    attemptNumber: 1,
    followUpMessageId: '',
    errorCode: '',
    ...(typed
      ? {
          terminalCallbackId: receipt.callbackId,
          terminalCallbackResultDigest: receipt.resultDigest,
          terminalCallbackResultRevision: 1,
          terminalCallbackAcceptedOperationId: receipt.acceptedOperationId,
          terminalCallbackEffectGeneration: 2,
        }
      : {}),
  };
  const h = harness(row);
  const findOne = jest.fn(async (filter) => (matchesRow(filter, stored) ? { ...stored } : null));
  const findEvidence = jest.fn(async (filter) =>
    matchesRow(filter, evidence) ? { ...evidence } : null,
  );
  const cursor = {
    sort: () => cursor,
    limit: () => cursor,
    toArray: async () =>
      matchesRow({ deliveryState: { $in: ['pending', 'enqueued'] } }, stored)
        ? [{ ...stored }]
        : [],
  };
  const write = jest.fn(async (filter, update) => {
    if (!matchesRow(filter, stored)) return null;
    Object.assign(stored, update.$set);
    return { ...stored };
  });
  h.collection.mockImplementation((name) => ({
    find: () => cursor,
    findOne:
      name === 'viventium_external_work'
        ? findOne
        : name === 'viventium_glasshive_callback_results'
          ? h.accepted
          : findEvidence,
    findOneAndUpdate: write,
    updateOne: h.update,
  }));
  h.accepted.mockResolvedValue(typed ? receipt : null);
  h.request.mockResolvedValue({
    ...stopDetail,
    callbackDeliveries: [{ ...stopDelivery, status: 'http_accepted' }],
  });
  return {
    ...h,
    row,
    stored,
    evidence,
    findEvidence,
    findOne,
    write,
    known: () => hasKnownExternalWork({ ownerId: row.ownerId, collection: { findOne } }),
  };
}

test.each(['', 'mission_origin_cleanup_tombstoned'])(
  'ordinary adjudication settles silent delivery without queueing (%s)',
  async (errorCode) => {
    const h = silentHarness();
    h.stored.deliveryState = 'pending';
    await h.service.recordGlassHiveAdjudicationOutcome({
      originRef: terminal.originRef,
      state: 'silent',
      errorCode,
    });
    expect(h.stored.deliveryState).toBe(errorCode ? 'suppressed' : 'silent');
    expect(h.stored.attentionPending).toBe(false);
    await expect(h.known()).resolves.toBe(false);
    expect(h.request).not.toHaveBeenCalled();
  },
);

test.each([false, true])(
  'legacy silent delivery self-heals once without producer polling (typed=%s)',
  async (typed) => {
    const h = silentHarness(typed);
    await expect(h.known()).resolves.toBe(true);
    for (let pass = 0; pass < 3; pass++)
      await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
    expect(h.stored.deliveryState).toBe('silent');
    await expect(h.known()).resolves.toBe(false);
    expect(h.write).toHaveBeenCalledTimes(1);
    expect(h.invalidate).toHaveBeenCalledTimes(1);
    expect(h.request).not.toHaveBeenCalled();
    expect(h.write).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: terminal.originRef,
        ownerId: terminal.ownerId,
        workRef: terminal.workRef,
        workerId: retainedStop.workerId,
        runId: terminal.runId,
        updatedAt: h.row.updatedAt,
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ deliveryState: 'silent', attentionPending: false }),
      }),
      { returnDocument: 'after' },
    );
  },
);

test('settling an old silent delivery leaves another current mission known', async () => {
  const h = silentHarness();
  const newer = {
    ...h.row,
    _id: 'new-origin',
    originRef: 'new-origin',
    workRef: 'new-work',
    runId: 'new-run',
    externalState: 'running',
    deliveryState: 'pending',
    adjudicationState: '',
  };
  h.findOne.mockImplementation(
    async (filter) => [h.stored, newer].find((row) => matchesRow(filter, row)) || null,
  );
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.stored.deliveryState).toBe('silent');
  expect(newer.externalState).toBe('running');
  await expect(h.known()).resolves.toBe(true);
});

test.each([
  'ownerId',
  'workRef',
  'workerId',
  'runId',
  'terminalCallbackId',
  'terminalCallbackResultRevision',
  'terminalCallbackAcceptedOperationId',
  'terminalCallbackEffectGeneration',
])('legacy silent evidence for another identity cannot settle current work (%s)', async (field) => {
  const h = silentHarness(true);
  h.evidence[field] = typeof h.evidence[field] === 'number' ? 3 : 'other-identity';
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.stored.deliveryState).toBe('enqueued');
  expect(h.write).not.toHaveBeenCalled();
  expect(h.invalidate).not.toHaveBeenCalled();
  await expect(h.known()).resolves.toBe(true);
});

test.each(['nonterminal', 'untrusted-ref', 'newer-run', 'newer-generation'])(
  'silent repair preserves current work after an invalid or stale observation (%s)',
  async (scenario) => {
    const h = silentHarness(true);
    if (scenario === 'nonterminal') h.evidence.workTerminal = false;
    if (scenario === 'untrusted-ref') h.evidence.callbackRef = 'unverified';
    if (scenario.startsWith('newer-')) {
      h.write.mockImplementation(async () => {
        h.stored.runId = 'newer-run';
        h.stored.externalState = 'running';
        h.stored.updatedAt = new Date('2026-10-24T01:00:01Z');
        if (scenario === 'newer-generation') h.stored.terminalCallbackEffectLeaseGeneration = 3;
        return null;
      });
    }
    await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
    expect(h.stored.deliveryState).toBe('enqueued');
    expect(h.invalidate).not.toHaveBeenCalled();
    await expect(h.known()).resolves.toBe(true);
    if (scenario.startsWith('newer-')) expect(h.request).not.toHaveBeenCalled();
  },
);
/* === VIVENTIUM END === */

function stopHarness() {
  const h = harness(retainedStop);
  h.accepted.mockResolvedValue(null);
  h.request.mockImplementation(async ({ method }) => method === 'POST' ? { state: 'delivering' } : stopDetail);
  return h;
}

test('existing reconciliation requests the exact verified retained Stop callback', async () => {
  const h = stopHarness();
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.trace).toHaveBeenCalledWith({
    ownerId: terminal.ownerId, originRef: terminal.originRef, workRef: terminal.workRef,
    runRef: terminal.runId, detail: stopDetail,
  });
  expect(h.request).toHaveBeenLastCalledWith({
    ownerId: terminal.ownerId, path: '/v1/callback-associations/recover',
    method: 'POST', timeoutMs: 3000,
    body: {
      originRef: terminal.originRef, workRef: terminal.workRef, runId: terminal.runId,
      workerId: retainedStop.workerId, callbackRef: stopDelivery.callbackRef,
      payloadSha256: stopDelivery.payloadSha256, authoritySha256: stopDelivery.authoritySha256,
    },
  });
  expect(h.update).toHaveBeenCalledWith(
    expect.objectContaining({ ownerId: terminal.ownerId, runId: terminal.runId }),
    { $set: { stateReconciliationNextAt: expect.any(Date) } },
  );
});

test('unverified Stop trace cannot request recovery', async () => {
  const h = stopHarness();
  h.trace.mockResolvedValue({ accepted: false });
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(h.update).not.toHaveBeenCalled();
});

test.each([
  { ...stopDetail, workRef: 'other-work' },
  { ...stopDetail, state: 'running' },
  { ...stopDetail, callbackDeliveries: [stopDelivery, { ...stopDelivery, callbackRevision: 28, status: 'http_accepted' }] },
  { ...stopDetail, callbackDeliveries: [{ ...stopDelivery, payloadSha256: '' }] },
])('changed or settled Stop evidence cannot be replayed: %j', async (detail) => {
  const h = stopHarness();
  h.request.mockResolvedValue(detail);
  await h.service.reconcileKnownExternalWorkHints({ limit: 10 });
  expect(h.request).toHaveBeenCalledTimes(1);
  expect(h.update).not.toHaveBeenCalled();
});


test.each(['accepted', 'revoked', 'not-newer'])(
  'historical delivery preserves newer aggregate only with an exact active accepted lease: %s', async (mode) => {
    const h = harness();
    const body = { run_id: receipt.runId, callback_id: receipt.callbackId,
      result_ended_at: '2026-08-27T12:00:00Z', result_revision: receipt.resultRevision,
      result_digest: receipt.resultDigest };
    const fence = { resultKey: 'ghtr_' + 'e'.repeat(64), callbackId: receipt.callbackId,
      resultDigest: receipt.resultDigest, resultRevision: 1,
      acceptedOperationId: receipt.acceptedOperationId, leaseId: 'd'.repeat(32),
      generation: 3, acceptedOperationGeneration: 1 };
    const newer = { ...terminal, terminalCallbackRunId: 'corrected-run',
      terminalCallbackResultEndedAt: new Date('2026-08-27T12:01:00Z'), deliveryState: 'pending' };
    const session = { inTransaction: () => true };
    h.projectionUpdate.mockResolvedValue(null);
    h.evidence.mockResolvedValue(mode === 'not-newer' ? null : newer);
    h.accepted.mockResolvedValue(mode === 'revoked' ? null : receipt);
    const operation = h.service.recordGlassHiveSurfaceDeliveryOutcome({
      originRef: terminal.originRef, state: 'sent', body,
      effectFence: fence, effectSession: session as never,
    });
    if (mode === 'accepted') await expect(operation).resolves.toEqual(newer);
    else await expect(operation).rejects.toMatchObject({ code: 'glasshive_callback_effect_fenced' });
    expect(h.projectionUpdate).toHaveBeenCalledTimes(1);
    expect(h.evidence).toHaveBeenCalledWith({
      _id: terminal.originRef,
      terminalCallbackRunId: { $exists: true, $nin: ['', receipt.runId] },
      terminalCallbackResultEndedAt: { $gt: new Date(body.result_ended_at) },
    }, { session });
    if (mode !== 'not-newer') expect(h.accepted).toHaveBeenCalledWith({
      _id: fence.resultKey, ownerId: terminal.ownerId, originRef: terminal.originRef,
      workRef: terminal.workRef, runId: receipt.runId,
      acceptedOperationId: receipt.acceptedOperationId, acceptedOperationGeneration: 1,
      callbackId: receipt.callbackId, resultDigest: receipt.resultDigest,
      resultRevision: 1, effectLeaseId: fence.leaseId,
      effectLeaseGeneration: 3, effectLeaseExpiresAt: { $gt: expect.any(Date) },
    }, { session });
  },
);


test.each(['current-pending', 'historical-only', 'correction-advances'])(
  'surface projection uses current result only and compare-and-sets its snapshot: %s', async (scenario) => {
    const h = harness();
    const current = { ...terminal, terminalCallbackRunId: 'current-run',
      terminalCallbackId: 'cb_terminal_' + '2'.repeat(64),
      terminalCallbackResultDigest: 'sha256:' + '3'.repeat(64),
      terminalCallbackResultRevision: 2, terminalCallbackAcceptedOperationId: '4'.repeat(32),
      terminalCallbackEffectLeaseGeneration: 2,
      terminalCallbackResultEndedAt: new Date('2026-08-28T12:01:00Z'),
      updatedAt: new Date('2026-08-28T12:02:00Z') };
    h.evidence.mockResolvedValue(current);
    const historical = { originRef: terminal.originRef, userId: terminal.ownerId,
      workRef: terminal.workRef, runId: 'older-run', status: 'sent',
      terminalCallbackId: receipt.callbackId };
    const latest = { originRef: terminal.originRef, userId: terminal.ownerId,
      workRef: terminal.workRef, runId: current.terminalCallbackRunId, status: 'pending',
      terminalCallbackId: current.terminalCallbackId,
      terminalCallbackResultDigest: current.terminalCallbackResultDigest,
      terminalCallbackResultRevision: current.terminalCallbackResultRevision,
      terminalCallbackAcceptedOperationId: current.terminalCallbackAcceptedOperationId };
    const receipts = scenario === 'historical-only' ? [historical] : [historical, latest];
    const find = jest.fn((filter) => ({ toArray: async () => receipts.filter(row =>
      Object.entries(filter).every(([key, value]) => row[key as keyof typeof row] === value)) }));
    const priorCollection = h.collection.getMockImplementation()!;
    h.collection.mockImplementation(name => name === 'viventiumglasshivecallbackdeliveries'
      ? { find } as never : priorCollection(name));
    h.projectionUpdate.mockResolvedValue(scenario === 'correction-advances' ? null : { ...current, deliveryState: 'enqueued' });
    const operation = h.service.reconcileGlassHiveSurfaceDeliveryOutcome({ originRef: terminal.originRef });
    if (scenario === 'correction-advances') {
      await expect(operation).rejects.toMatchObject({ code: 'glasshive_delivery_projection_snapshot_changed' });
    } else await expect(operation).resolves.toBeTruthy();
    expect(find).toHaveBeenCalledWith({ originRef: terminal.originRef, userId: terminal.ownerId,
      workRef: terminal.workRef, runId: 'current-run', terminalCallbackId: current.terminalCallbackId,
      terminalCallbackResultDigest: current.terminalCallbackResultDigest,
      terminalCallbackResultRevision: 2, terminalCallbackAcceptedOperationId: current.terminalCallbackAcceptedOperationId,
    }, { projection: { status: 1 } });
    if (scenario === 'historical-only') expect(h.projectionUpdate).not.toHaveBeenCalled();
    else expect(h.projectionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      _id: terminal.originRef, ownerId: terminal.ownerId, updatedAt: current.updatedAt,
      terminalCallbackRunId: 'current-run', terminalCallbackId: current.terminalCallbackId,
      terminalCallbackResultRevision: 2,
    }), expect.objectContaining({ $set: expect.objectContaining({ deliveryState: 'enqueued' }) }),
    { returnDocument: 'after' });
  },
);


test.each(['current', 'same-result-advanced-lease', 'newer-result', 'other-owner', 'other-followup'])(
  'aggregate delivery projection compares exact current member snapshot: %s',
  async (scenario) => {
    const h = harness();
    const binding = {
      originRef: terminal.originRef,
      workRef: terminal.workRef,
      workerId: receipt.workerId,
      runId: terminal.runId,
      callbackRef: 'callback_sha256:' + 'a'.repeat(64),
      attemptNumber: 1,
      resultKey: 'ghtr_' + 'a'.repeat(64),
      acceptedOperationId: receipt.acceptedOperationId,
      terminalCallbackId: receipt.callbackId,
      resultDigest: receipt.resultDigest,
      resultRevision: 1,
      effectGeneration: 1,
    };
    const current = {
      ...terminal,
      terminalCallbackRunId: binding.runId,
      terminalCallbackId: binding.terminalCallbackId,
      terminalCallbackResultDigest: binding.resultDigest,
      terminalCallbackResultRevision: scenario === 'newer-result' ? 2 : 1,
      terminalCallbackAcceptedOperationId: binding.acceptedOperationId,
      terminalCallbackEffectLeaseGeneration: scenario === 'same-result-advanced-lease' ? 2 : 1,
      ownerId: scenario === 'other-owner' ? 'another-owner' : terminal.ownerId,
      followUpMessageId: scenario === 'other-followup' ? 'another-reply' : 'combined-reply',
    };
    h.projectionUpdate.mockImplementation(async (filter) =>
      Object.entries(filter).every(([key, value]) => current[key as keyof typeof current] === value)
        ? { ...current, deliveryState: 'sent' }
        : null,
    );
    const result = await h.service.recordGlassHiveSurfaceDeliveryOutcome({
      originRef: binding.originRef,
      state: 'sent',
      workerCompletion: { ownerId: terminal.ownerId, responseMessageId: 'combined-reply', binding },
    });
    expect(Boolean(result)).toBe(['current', 'same-result-advanced-lease'].includes(scenario));
    expect(h.projectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: terminal.ownerId,
        workRef: binding.workRef,
        terminalCallbackRunId: binding.runId,
        terminalCallbackResultRevision: 1,
        terminalCallbackId: binding.terminalCallbackId,
        terminalCallbackAcceptedOperationId: binding.acceptedOperationId,
        followUpMessageId: 'combined-reply',
      }),
      expect.any(Object),
      expect.any(Object),
    );
  },
);


test.each(['current', 'newer-run', 'running', 'other-owner', 'other-worker', 'other-followup'])(
  'attention delivery projection preserves current work identity: %s',
  async (scenario) => {
    const h = harness();
    const binding = { kind: 'nonterminal_attention' as const, originRef: terminal.originRef,
      workRef: terminal.workRef, workerId: receipt.workerId, runId: terminal.runId,
      callbackRef: 'callback_sha256:' + 'a'.repeat(64), event: 'run.needs_input' as const,
      workTerminal: false as const, evidenceId: 'ghe_' + 'a'.repeat(32) };
    const current = { ...terminal, workerId: scenario === 'other-worker' ? 'other-worker' : binding.workerId,
      runId: scenario === 'newer-run' ? 'newer-run' : binding.runId,
      ownerId: scenario === 'other-owner' ? 'other-owner' : terminal.ownerId,
      externalState: scenario === 'running' ? 'running' : 'needs_input',
      followUpMessageId: scenario === 'other-followup' ? 'other-reply' : 'attention-reply' };
    h.projectionUpdate.mockImplementation(async (filter) =>
      Object.entries(filter).every(([key, value]) => current[key as keyof typeof current] === value)
        ? { ...current, deliveryState: 'sent' } : null);
    const result = await h.service.recordGlassHiveSurfaceDeliveryOutcome({ originRef: binding.originRef,
      state: 'sent', workerCompletion: { ownerId: terminal.ownerId, responseMessageId: 'attention-reply', binding } });
    expect(Boolean(result)).toBe(scenario === 'current');
    expect(h.projectionUpdate).toHaveBeenCalledWith({ _id: binding.originRef, ownerId: terminal.ownerId,
      workRef: binding.workRef, workerId: binding.workerId, runId: binding.runId,
      externalState: 'needs_input', followUpMessageId: 'attention-reply' },
      expect.objectContaining({ $set: expect.objectContaining({ deliveryState: 'sent' }) }),
      expect.any(Object));
  },
);
