import { buildMainGenerationPresentation } from './mainGenerationPresentation';
import { createGlassHiveCallbackDeliveryDispatchService } from './callbackDeliveryDispatch';
import type {
  GlassHiveCallbackDeliveryDispatchDependencies,
  GlassHiveCallbackDeliveryDispatchRow,
} from './callbackDeliveryDispatch';

function fixture() {
  let row: GlassHiveCallbackDeliveryDispatchRow = {
    deliveryId: 'delivery-a',
    claimId: 'claim-a',
    surface: 'telegram',
    status: 'claimed',
    userId: 'owner-a',
    conversationId: 'conversation-a',
    callbackMessageId: 'message-a',
    originRef: 'binding-a',
    event: 'main.followup',
    text: 'Actual Main reply',
    dispatchPermitId: '',
    dispatchPermitGeneration: 0,
    dispatchPermitExpiresAt: null,
    mainGenerationPresentation: buildMainGenerationPresentation(
      { streamId: 'stream-a', admissionId: 'admission-a' },
      'message-a',
      'Actual Main reply',
    ),
  };
  const query = () => {
    const result = { lean: async () => row, session: (_session: object) => result };
    return result;
  };
  const update = (value: object) => {
    row = { ...row, ...(value as { $set: Partial<GlassHiveCallbackDeliveryDispatchRow> }).$set };
  };
  const deps: GlassHiveCallbackDeliveryDispatchDependencies = {
    DeliveryModel: {
      findOne: () => query(),
      findOneAndUpdate: (_filter, value) => {
        update(value);
        return query();
      },
      updateOne: async (_filter, value) => {
        update(value);
        return { matchedCount: 1 };
      },
    },
    mainPresentationCurrent: jest.fn(async () => true),
    resultExists: jest.fn(async () => false),
    acquireEffectLease: jest.fn(async () => null),
    renewEffectLease: jest.fn(async () => false),
    releaseEffectLease: jest.fn(async () => false),
    fenceEffectTransaction: jest.fn(async () => false),
    runTransaction: async (operation) => operation({}),
  };
  return {
    deps,
    service: createGlassHiveCallbackDeliveryDispatchService(deps),
    input: { deliveryId: 'delivery-a', claimId: 'claim-a', userId: 'owner-a' },
    read: () => row,
    change: (value: Partial<typeof row>) => {
      row = { ...row, ...value };
    },
  };
}

test('Main authorizes, renews, releases and reacquires its existing outbox permit without worker leases', async () => {
  const f = fixture();
  const permit = await f.service.authorizeGlassHiveCallbackDeliveryDispatch(f.input);
  expect(permit?.resultDigest).toBe(f.read().mainGenerationPresentation!.responseDigest);
  expect(
    await f.service.renewGlassHiveCallbackDeliveryDispatch({ ...f.input, dispatchPermit: permit! }),
  ).toMatchObject({ permitId: permit!.permitId });
  expect(
    await f.service.releaseGlassHiveCallbackDeliveryDispatch({
      ...f.input,
      dispatchPermit: permit!,
    }),
  ).toBe(true);
  expect(f.read().dispatchPermitGeneration).toBe(permit!.permitGeneration);
  const second = await f.service.authorizeGlassHiveCallbackDeliveryDispatch(f.input);
  expect(second!.permitGeneration).toBe(permit!.permitGeneration + 1);
  expect(second!.permitId).not.toBe(permit!.permitId);
  expect(
    await f.service.renewGlassHiveCallbackDeliveryDispatch({ ...f.input, dispatchPermit: permit! }),
  ).toBeNull();
  expect(f.deps.acquireEffectLease).not.toHaveBeenCalled();
  expect(f.deps.renewEffectLease).not.toHaveBeenCalled();
  expect(f.deps.releaseEffectLease).not.toHaveBeenCalled();
});

test.each(['sent', 'unknown'])(
  'Main %s records transport receipt only with its issued exact permit',
  async (state) => {
    const f = fixture();
    const permit = await f.service.authorizeGlassHiveCallbackDeliveryDispatch(f.input);
    const result =
      state === 'sent'
        ? await f.service.settleGlassHiveCallbackDeliverySent({
            ...f.input,
            dispatchPermit: permit,
            telegramMessageIds: ['transport-a'],
          })
        : await f.service.settleGlassHiveCallbackDeliveryUnknown({
            ...f.input,
            dispatchPermit: permit,
            lastError: 'transport outcome unknown',
          });
    expect(result.handled).toBe(true);
    expect(f.read().status).toBe(state === 'sent' ? 'sent' : 'delivery_unknown');
    expect(f.read().dispatchPermitId).toBe('');
    if (state === 'sent') expect(f.read().telegramSentMessageIds).toEqual(['transport-a']);
    expect(f.deps.fenceEffectTransaction).not.toHaveBeenCalled();
  },
);

test('Main cannot borrow a missing verifier or a stale canonical message/claim permit', async () => {
  const f = fixture();
  const permit = await f.service.authorizeGlassHiveCallbackDeliveryDispatch(f.input);
  f.change({
    mainGenerationPresentation: {
      ...f.read().mainGenerationPresentation!,
      responseDigest: 'sha256:' + 'b'.repeat(64),
    },
  });
  expect(
    (await f.service.settleGlassHiveCallbackDeliverySent({ ...f.input, dispatchPermit: permit }))
      .handled,
  ).toBe(true);
  expect(f.read().status).toBe('claimed');
  f.change({ claimId: 'newer-claim' });
  expect(
    await f.service.releaseGlassHiveCallbackDeliveryDispatch({
      ...f.input,
      dispatchPermit: permit!,
    }),
  ).toBe(false);
  delete f.deps.mainPresentationCurrent;
  const denied = createGlassHiveCallbackDeliveryDispatchService(f.deps);
  expect(
    await denied.authorizeGlassHiveCallbackDeliveryDispatch({ ...f.input, claimId: 'newer-claim' }),
  ).toBeNull();
});
