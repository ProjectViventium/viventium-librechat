/* === VIVENTIUM START ===
 * Feature: terminal callback transport-unknown settlement.
 * Purpose: Prove partial Telegram/voice effects become non-retryable and release only the exact
 * dispatch permit, so a newer terminal result can proceed without replaying the old effect.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const { compareAndSetGlassHiveTerminalCallbackResult } = require('@librechat/data-schemas');
const {
  GlassHiveTerminalCallbackResult,
  ViventiumGlassHiveCallbackDelivery,
} = require('~/db/models');
const {
  authorizeGlassHiveCallbackDeliveryDispatch,
  claimPendingGlassHiveCallbackDeliveries,
  markGlassHiveCallbackDeliveryUnknown,
} = require('../GlassHiveCallbackDeliveryService');

function identity(revision, character, surface) {
  return {
    ownerId: `owner-unknown-${surface}`,
    originRef: `origin-unknown-${surface}`,
    workRef: `work-unknown-${surface}`,
    workerId: `worker-${character}`,
    runId: `run-unknown-${surface}`,
    callbackId: `cb_terminal_${character.repeat(64)}`,
    attemptNumber: 1,
    resultState: revision === 1 ? 'completed' : 'cancelled',
    resultEndedAt: '2026-08-23T20:00:00.000Z',
    resultRevision: revision,
    resultDigest: `sha256:${character.repeat(64)}`,
  };
}

describe('GlassHive delivery unknown dispatch permit', () => {
  let replicaSet;

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replicaSet.getUri());
    await GlassHiveTerminalCallbackResult.syncIndexes();
    await ViventiumGlassHiveCallbackDelivery.syncIndexes();
  }, 30000);

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await GlassHiveTerminalCallbackResult.syncIndexes();
    await ViventiumGlassHiveCallbackDelivery.syncIndexes();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await replicaSet?.stop({ doCleanup: true, force: true });
  }, 15000);

  test.each(['telegram', 'voice'])(
    '%s ambiguous effect settles once, never retries, and releases B',
    async (surface) => {
      const resultA = identity(1, 'a', surface);
      const resultB = identity(2, 'b', surface);
      const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultA,
      });
      const durableA = await GlassHiveTerminalCallbackResult.findOne({}).lean();
      const delivery = await ViventiumGlassHiveCallbackDelivery.create({
        deliveryKey: `unknown-${surface}`,
        deliveryId: `unknown-${surface}`,
        callbackMessageId: `message-unknown-${surface}`,
        callbackId: `callback_sha256:${'a'.repeat(64)}`,
        originRef: resultA.originRef,
        workRef: resultA.workRef,
        userId: resultA.ownerId,
        conversationId: `conversation-unknown-${surface}`,
        surface,
        event: 'run.completed',
        runId: resultA.runId,
        status: 'pending',
        text: 'Synthetic ambiguous terminal result.',
        nextAttemptAt: new Date(0),
        expiresAt: new Date(Date.now() + 60_000),
        terminalCallbackResultKey: String(durableA._id),
        terminalCallbackAcceptedOperationId: acceptedA.acceptedOperationId,
        terminalCallbackId: resultA.callbackId,
        terminalCallbackResultDigest: resultA.resultDigest,
        terminalCallbackResultRevision: 1,
        terminalCallbackEffectGeneration: 1,
        ...(surface === 'telegram'
          ? { telegramChatId: 'telegram-unknown-chat' }
          : { voiceCallSessionId: 'voice-unknown-call' }),
      });
      const [claimed] = await claimPendingGlassHiveCallbackDeliveries({ surface, limit: 1 });
      const scope =
        surface === 'voice'
          ? { userId: resultA.ownerId, voiceCallSessionId: 'voice-unknown-call' }
          : {};
      const permit = await authorizeGlassHiveCallbackDeliveryDispatch({
        deliveryId: claimed.deliveryId,
        claimId: claimed.claimId,
        ...scope,
      });

      await expect(
        markGlassHiveCallbackDeliveryUnknown({
          deliveryId: claimed.deliveryId,
          claimId: claimed.claimId,
          reason: 'missing_exact_dispatch_permit',
          ...scope,
        }),
      ).resolves.toBeNull();
      await expect(
        ViventiumGlassHiveCallbackDelivery.findOne({ deliveryId: delivery.deliveryId }).lean(),
      ).resolves.toMatchObject({ status: 'claimed', dispatchPermitId: permit.permitId });

      await expect(
        markGlassHiveCallbackDeliveryUnknown({
          deliveryId: claimed.deliveryId,
          claimId: claimed.claimId,
          dispatchPermit: permit,
          reason: `${surface}_effect_outcome_unknown api_key=example-sensitive-value`,
          ...scope,
        }),
      ).resolves.toMatchObject({ deliveryId: delivery.deliveryId, status: 'delivery_unknown' });
      const settled = await ViventiumGlassHiveCallbackDelivery.findOne({
        deliveryId: delivery.deliveryId,
      }).lean();
      expect(settled).toMatchObject({
        status: 'delivery_unknown',
        nextAttemptAt: null,
        lastError: `${surface}_effect_outcome_unknown api_key=<redacted>`,
        dispatchPermitId: '',
        dispatchPermitGeneration: 0,
        dispatchPermitExpiresAt: null,
      });
      expect(JSON.stringify(settled)).not.toContain('example-sensitive-value');
      await expect(claimPendingGlassHiveCallbackDeliveries({ surface, limit: 1 })).resolves.toEqual(
        [],
      );
      await expect(
        compareAndSetGlassHiveTerminalCallbackResult({
          ResultModel: GlassHiveTerminalCallbackResult,
          incoming: resultB,
        }),
      ).resolves.toMatchObject({ status: 'accepted', current: { resultRevision: 2 } });
    },
    15000,
  );
});
