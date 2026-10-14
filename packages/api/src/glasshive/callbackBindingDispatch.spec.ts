import type { GlassHiveCallbackBindingDependencies } from './callbackBinding';

import { createGlassHiveCallbackBindingService } from './callbackBinding';
import { normalizeInteractionSourceSegments } from './interactionSourceSegments';

/* === VIVENTIUM START === A closed launch cannot regain provider dispatch authority. === */
function fixture(bindingState = 'prepared', externalState = 'prepared') {
  const rows = new Map([
    [
      'viventium_glasshive_callback_bindings',
      { ownerId: 'owner', workRef: '', launchState: bindingState },
    ],
    ['viventium_external_work', { ownerId: 'owner', workRef: '', launchState: externalState }],
  ]);
  const cursor = {
    sort: () => cursor,
    limit: () => cursor,
    toArray: async () => [],
  };
  const positiveFence = jest.fn(async () => true);
  const dependencies: GlassHiveCallbackBindingDependencies = {
    mongoose: {
      connection: {
        collection: (name) => ({
          find: () => cursor,
          findOne: async () => rows.get(name) || null,
          findOneAndUpdate: async () => null,
          updateOne: async (filter, update) => {
            const row = rows.get(name);
            const matchesState =
              typeof filter.launchState === 'string'
                ? row?.launchState === filter.launchState
                : filter.launchState?.$in?.includes(row?.launchState);
            if (!row || !matchesState || (filter.ownerId && row.ownerId !== filter.ownerId)) {
              return { acknowledged: true, matchedCount: 0 };
            }
            Object.assign(row, update.$set);
            return { acknowledged: true, matchedCount: 1 };
          },
        }),
      },
    },
    logger: { info: jest.fn(), warn: jest.fn() },
    canonicalizeGlassHiveCallbackRef: (value) => value,
    resolveTelegramMappingByUserId: async () => null,
    getMessages: async () => [],
    markUserParallelWorkKnown: positiveFence,
    buildTrustedDelegationIdentity: () => ({ idempotencyKey: 'key', goalDigest: 'digest' }),
    requestAccountApi: async () => ({}),
    signTrustedDelegationIdentity: () => 'signature',
    normalizeInteractionSourceSegments,
    promptLayerIntegritySnapshot: () => ({}),
    recordOrchestrationTraceAcceptedLaunch: async () => null,
    recordOrchestrationTraceCallback: async () => null,
    recordOrchestrationTraceFailedLaunch: async () => null,
    recordOrchestrationTraceLaunch: async () => null,
    recordGlassHiveWorkDetailTrace: async () => null,
    deferGlassHiveWorkStateReconciliation: async () => null,
    reconcileAuthoritativeGlassHiveWorkState: async () => null,
  };
  const service = createGlassHiveCallbackBindingService(dependencies);
  const launch = {
    bindingId: 'origin',
    originRef: 'origin',
    ownerId: 'owner',
    sourceEventId: 'source',
    objectiveOrdinal: 0,
    objectiveDigest: 'digest',
    callIdentityDigest: 'call',
    delegationIdentity: {},
    delegationContext: {},
    delegationPacket: {},
    schedulerDispatchDocumentId: '',
    scheduleOccurrenceKey: '',
    required: false,
  };
  return { service, launch, rows, positiveFence, dependencies };
}

test.each(['current', 'historical', 'foreign', 'replay', 'no-write', 'wrapped-no-write', 'fenced'])(
  'invalidates cached roster only after a current owned state transition (%s)',
  async (scenario) => {
    const { dependencies } = fixture();
    const invalidate = jest.fn();
    dependencies.invalidateActiveWorkSnapshot = invalidate;
    const row = {
      _id: 'origin',
      ownerId: 'owner',
      workRef: 'work',
      runId: 'run',
      externalState: scenario === 'replay' ? 'completed' : 'running',
    };
    const update = jest.fn().mockResolvedValue({ ...row, externalState: 'completed' });
    if (scenario === 'no-write' || scenario === 'fenced') update.mockResolvedValue(null);
    if (scenario === 'wrapped-no-write') update.mockResolvedValue({ value: null });
    dependencies.mongoose.connection.collection = () => ({
      find: jest.fn(),
      findOne: async (filter) => (filter.ownerId === row.ownerId ? row : null),
      findOneAndUpdate: update,
      updateOne: async () => ({ matchedCount: 1 }),
    });
    const service = createGlassHiveCallbackBindingService(dependencies);
    const body = {
      work_ref: 'work',
      worker_id: 'worker',
      run_id: scenario === 'historical' ? 'old-run' : 'run',
      event: 'run.completed',
      work_state: 'completed',
      work_terminal: true,
      ...(scenario === 'fenced'
        ? {
            callback_id: 'cb_terminal_' + 'a'.repeat(64),
            result_revision: 1,
            result_ended_at: '2026-08-27T12:00:00Z',
            result_digest: 'sha256:' + 'b'.repeat(64),
          }
        : {}),
    };
    const effectFence =
      scenario === 'fenced'
        ? {
            resultKey: 'ghtr_' + 'e'.repeat(64),
            callbackId: body.callback_id,
            resultRevision: 1,
            resultDigest: body.result_digest,
            acceptedOperationId: 'c'.repeat(32),
            generation: 1,
            leaseId: 'd'.repeat(32),
            acceptedOperationGeneration: 1,
          }
        : undefined;
    const operation = service.recordGlassHiveCallbackExternalState({
      binding: {
        bindingId: 'origin',
        conversationId: 'conversation',
        anchorMessageId: 'anchor',
        requestedParentMessageId: 'parent',
        schedulerDispatchDocumentId: '',
        scheduleOccurrenceKey: '',
        scheduleId: '',
        mainAgentId: 'main',
        destinations: [],
        ownerId: scenario === 'foreign' ? 'other-owner' : 'owner',
        originRef: 'origin',
        workRef: 'work',
        currentRunId: 'run',
        currentRunState: 'completed',
      },
      body,
      effectFence,
    });
    if (scenario === 'fenced')
      await expect(operation).rejects.toMatchObject({ code: 'glasshive_callback_effect_fenced' });
    else await operation;
    if (scenario === 'current') {
      expect(invalidate).toHaveBeenCalledWith({
        ownerId: 'owner',
        fetchImpl: expect.any(Function),
      });
      expect(update.mock.invocationCallOrder[0]).toBeLessThan(
        invalidate.mock.invocationCallOrder[0],
      );
    } else expect(invalidate).not.toHaveBeenCalled();
  },
);

test('admits provider dispatch only after both exact prepared rows transition', async () => {
  const { service, launch, rows, positiveFence } = fixture();
  await expect(service.markGlassHiveLaunchDispatchReady(launch)).resolves.toEqual({
    originRef: 'origin',
    launchState: 'dispatch_ready',
  });
  expect([...rows.values()].map((row) => row.launchState)).toEqual([
    'dispatch_ready',
    'dispatch_ready',
  ]);
  expect(positiveFence).toHaveBeenCalledTimes(1);
});

test.each(['not_dispatched', 'accepted', 'dispatch_unknown', 'callback_confirmed'])(
  'does not reopen a %s reservation',
  async (state) => {
    const { service, launch, rows, positiveFence } = fixture(state, state);
    await expect(service.markGlassHiveLaunchDispatchReady(launch)).rejects.toMatchObject({
      code: 'glasshive_launch_dispatch_fenced',
    });
    expect([...rows.values()].map((row) => row.launchState)).toEqual([state, state]);
    expect(positiveFence).not.toHaveBeenCalled();
  },
);

test('does not authorize dispatch if the external projection closed during preparation', async () => {
  const { service, launch, positiveFence } = fixture('prepared', 'not_dispatched');
  await expect(service.markGlassHiveLaunchDispatchReady(launch)).rejects.toMatchObject({
    code: 'glasshive_launch_dispatch_fenced',
  });
  expect(positiveFence).not.toHaveBeenCalled();
});

test('does not authorize another owner through a matching origin reference', async () => {
  const { service, launch, positiveFence } = fixture();
  await expect(
    service.markGlassHiveLaunchDispatchReady({ ...launch, ownerId: 'other' }),
  ).rejects.toMatchObject({
    code: 'glasshive_launch_dispatch_fenced',
  });
  expect(positiveFence).not.toHaveBeenCalled();
});

function attachSelectedFiles(uploadedFiles: object[]) {
  const { service, launch } = fixture();
  return service.attachGlassHiveTrustedLaunchMetadata(
    { uploaded_files: uploadedFiles },
    {
      ...launch,
      delegationPacket: undefined,
      delegationIdentity: {
        version: 1,
        idempotency_key: 'a'.repeat(64),
        goal_digest: 'b'.repeat(64),
        call_identity_digest: 'c'.repeat(64),
        source_event_id: 'source',
        objective_ordinal: 0,
      },
      delegationContext: {
        version: 1,
        source_event_id: 'source',
        triggering_source_segments: [],
      },
    },
  );
}

test('keeps distinct owned upload refs when filenames collide', () => {
  const uploadedFiles = [
    { file_id: 'owned-file-a', filename: 'brief.txt', text: 'First selected source.' },
    { file_id: 'owned-file-b', filename: 'brief.txt', text: 'Second selected source.' },
  ];
  expect(attachSelectedFiles(uploadedFiles)).toEqual(
    expect.objectContaining({
      uploaded_files: uploadedFiles,
      bootstrap_bundle_json: expect.objectContaining({
        viventium_delegation_packet: expect.objectContaining({
          selected_files: [
            { ordinal: 0, ref: 'owned-file-a' },
            { ordinal: 1, ref: 'owned-file-b' },
          ],
        }),
      }),
    }),
  );
});

test.each(['file_id', 'fileId', 'id'])('retains the stable %s ref with display metadata', (key) => {
  const attached = attachSelectedFiles([{ [key]: 'owned-file-a', filename: 'brief.txt' }]);
  expect(attached).toMatchObject({
    bootstrap_bundle_json: {
      viventium_delegation_packet: { selected_files: [{ ordinal: 0, ref: 'owned-file-a' }] },
    },
  });
});

test.each([{ filename: 'brief.txt' }, { file_id: '', filename: 'brief.txt' }])(
  'rejects a selected upload without stable identity before dispatch: %j',
  (file) => {
    expect(() => attachSelectedFiles([file])).toThrow('glasshive_selected_file_ref_unavailable');
  },
);

/* === VIVENTIUM END === */
