import {
  createGlassHiveCallbackDeliveryDispatchService,
  type GlassHiveCallbackDeliveryDispatchDependencies,
  type GlassHiveCallbackDeliveryDispatchPermit,
  type GlassHiveCallbackDeliveryDispatchRow,
} from './callbackDeliveryDispatch';

function query<T>(value: T) {
  const result = {
    lean: async () => value,
    session: (_session: object) => result,
  };
  return result;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

function matches(row: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(
    ([key, value]) => !key.startsWith('$') && sameValue(row[key], value),
  );
}

function callbackRow(
  overrides: Partial<GlassHiveCallbackDeliveryDispatchRow> = {},
): GlassHiveCallbackDeliveryDispatchRow {
  return {
    deliveryId: 'delivery-race',
    claimId: 'claim-old',
    surface: 'voice',
    status: 'claimed',
    userId: 'owner-race',
    voiceCallSessionId: 'call-race',
    terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
    terminalCallbackAcceptedOperationId: 'b'.repeat(32),
    terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
    terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
    terminalCallbackResultRevision: 1,
    terminalCallbackEffectGeneration: 1,
    dispatchPermitId: '',
    dispatchPermitGeneration: 0,
    dispatchPermitExpiresAt: null,
    ...overrides,
  };
}

function permit(
  row: GlassHiveCallbackDeliveryDispatchRow,
): GlassHiveCallbackDeliveryDispatchPermit {
  return {
    deliveryId: row.deliveryId,
    claimId: row.claimId,
    surface: row.surface,
    permitId: String(row.dispatchPermitId),
    permitGeneration: Number(row.dispatchPermitGeneration),
    resultRevision: Number(row.terminalCallbackResultRevision),
    resultDigest: String(row.terminalCallbackResultDigest),
    expiresAt: new Date(row.dispatchPermitExpiresAt as Date).toISOString(),
  };
}

function harness({
  findRows,
  updateRows = [],
  liveRow,
  acquireEffectLease = jest.fn(async () => null),
  fenceEffectTransaction = jest.fn(async () => false),
}: {
  findRows: Array<GlassHiveCallbackDeliveryDispatchRow | null>;
  updateRows?: Array<GlassHiveCallbackDeliveryDispatchRow | null>;
  liveRow: GlassHiveCallbackDeliveryDispatchRow;
  acquireEffectLease?: GlassHiveCallbackDeliveryDispatchDependencies['acquireEffectLease'];
  fenceEffectTransaction?: GlassHiveCallbackDeliveryDispatchDependencies['fenceEffectTransaction'];
}) {
  const state = liveRow as GlassHiveCallbackDeliveryDispatchRow & Record<string, unknown>;
  const updateOne = jest.fn(
    async (filter: Record<string, unknown>, update: { $set?: Record<string, unknown> }) => {
      if (!matches(state, filter)) return { matchedCount: 0 };
      Object.assign(state, update.$set || {});
      return { matchedCount: 1 };
    },
  );
  const dependencies: GlassHiveCallbackDeliveryDispatchDependencies = {
    DeliveryModel: {
      findOne: jest.fn(() => query(findRows.shift() ?? null)),
      findOneAndUpdate: jest.fn(() => query(updateRows.shift() ?? null)),
      updateOne,
    },
    resultExists: jest.fn(async () => false),
    acquireEffectLease,
    renewEffectLease: jest.fn(async () => true),
    fenceEffectTransaction,
    releaseEffectLease: jest.fn(async () => true),
    runTransaction: async (operation) => operation({}),
  };
  return {
    liveRow: state,
    service: createGlassHiveCallbackDeliveryDispatchService(dependencies),
    updateOne,
  };
}

describe('GlassHive callback delivery stale-claim fences', () => {
  test('authorize cannot supersede a newer claim after its observed claim loses the race', async () => {
    const observed = callbackRow();
    const newer = callbackRow({
      claimId: 'claim-new',
      dispatchPermitId: 'e'.repeat(32),
      dispatchPermitGeneration: 2,
      dispatchPermitExpiresAt: new Date(Date.now() + 60_000),
    });
    const testHarness = harness({ findRows: [observed, observed, null], liveRow: newer });

    await expect(
      testHarness.service.authorizeGlassHiveCallbackDeliveryDispatch({
        deliveryId: observed.deliveryId,
        claimId: observed.claimId,
        userId: observed.userId,
        voiceCallSessionId: observed.voiceCallSessionId,
      }),
    ).resolves.toBeNull();

    expect(testHarness.liveRow).toMatchObject({
      status: 'claimed',
      claimId: 'claim-new',
      dispatchPermitId: 'e'.repeat(32),
      dispatchPermitGeneration: 2,
    });
    expect(testHarness.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: observed.deliveryId,
        claimId: observed.claimId,
        status: 'claimed',
        userId: observed.userId,
        voiceCallSessionId: observed.voiceCallSessionId,
      }),
      expect.any(Object),
    );
  });

  test.each(['sent', 'delivery_unknown'] as const)(
    '%s fallback cannot supersede a newer claim or permit generation',
    async (settlement) => {
      const expiresAt = new Date(Date.now() + 60_000);
      const observed = callbackRow({
        dispatchPermitId: 'e'.repeat(32),
        dispatchPermitGeneration: 1,
        dispatchPermitExpiresAt: expiresAt,
      });
      const provisional = callbackRow({
        ...observed,
        status: settlement === 'sent' ? 'sent' : 'delivery_unknown',
      });
      const newer = callbackRow({
        claimId: 'claim-new',
        dispatchPermitId: 'f'.repeat(32),
        dispatchPermitGeneration: 2,
        dispatchPermitExpiresAt: new Date(expiresAt.getTime() + 60_000),
      });
      const testHarness = harness({
        findRows: [observed, observed],
        updateRows: [provisional],
        liveRow: newer,
      });
      const input = {
        deliveryId: observed.deliveryId,
        claimId: observed.claimId,
        dispatchPermit: permit(observed),
        userId: observed.userId,
        voiceCallSessionId: observed.voiceCallSessionId,
      };

      const result =
        settlement === 'sent'
          ? await testHarness.service.settleGlassHiveCallbackDeliverySent(input)
          : await testHarness.service.settleGlassHiveCallbackDeliveryUnknown(input);
      expect(result).toEqual({ handled: true, row: null });
      expect(testHarness.liveRow).toMatchObject({
        status: 'claimed',
        claimId: 'claim-new',
        dispatchPermitId: 'f'.repeat(32),
        dispatchPermitGeneration: 2,
      });
      expect(testHarness.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          deliveryId: observed.deliveryId,
          claimId: observed.claimId,
          status: 'claimed',
          dispatchPermitId: observed.dispatchPermitId,
          dispatchPermitGeneration: observed.dispatchPermitGeneration,
        }),
        expect.any(Object),
      );
    },
  );
});
