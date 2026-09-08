import { createGlassHiveCallbackBindingService } from './callbackBinding';

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
  });
  return { service, accepted, evidence, request, update, defer, trace, projectionUpdate, collection };
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
