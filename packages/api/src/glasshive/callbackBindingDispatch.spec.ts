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
  return { service, launch, rows, positiveFence };
}

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
/* === VIVENTIUM END === */
