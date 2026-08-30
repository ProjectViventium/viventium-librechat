/* === VIVENTIUM START ===
 * Feature: Permit-fenced grouped Voice Worker-completion delivery.
 * Purpose: Prove the production authorization and presentation-settlement contract against a
 * transactional Mongo replica set without requiring an installed-runtime trace identity.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const {
  buildVoiceWorkerCompletionPresentation,
  canonicalizeGlassHiveCallbackRef,
} = require('@librechat/api');
const { compareAndSetGlassHiveTerminalCallbackResult } = require('@librechat/data-schemas');
const {
  GlassHiveTerminalCallbackResult,
  Message,
  ViventiumGlassHiveCallbackDelivery,
} = require('~/db/models');
const { saveMessage } = require('~/models');

const mockRecordGlassHiveSurfaceDeliveryOutcome = jest.fn().mockResolvedValue(null);
const mockRecordVoiceOrchestrationTrace = jest.fn().mockResolvedValue(null);

jest.mock('../GlassHiveCallbackBindingService', () => ({
  recordGlassHiveSurfaceDeliveryOutcome: (...args) =>
    mockRecordGlassHiveSurfaceDeliveryOutcome(...args),
}));

jest.mock('../VoiceOrchestrationTraceService', () => ({
  recordVoiceOrchestrationTrace: (...args) => mockRecordVoiceOrchestrationTrace(...args),
}));

const {
  authorizeGlassHiveCallbackDeliveryDispatch,
  claimPendingGlassHiveCallbackDeliveries,
  completeGlassHiveWorkerCompletionPresentation,
  enqueueGlassHiveCallbackDelivery,
  markGlassHiveCallbackDeliverySent,
  renewGlassHiveCallbackDeliveryDispatch,
} = require('../GlassHiveCallbackDeliveryService');

function terminalIdentity(character, suffix, ownerId) {
  return {
    ownerId,
    originRef: `origin-${suffix}`,
    workRef: `work-${suffix}`,
    workerId: `worker-${suffix}`,
    runId: `run-${suffix}`,
    callbackId: `cb_terminal_${character.repeat(64)}`,
    attemptNumber: 1,
    resultState: 'completed',
    resultEndedAt: '2026-08-23T18:00:00.000Z',
    resultRevision: 1,
    resultDigest: `sha256:${character.repeat(64)}`,
  };
}

describe('GlassHive grouped Voice completion dispatch permit', () => {
  let replicaSet;

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replicaSet.getUri());
    await GlassHiveTerminalCallbackResult.syncIndexes();
    await Message.syncIndexes();
    await ViventiumGlassHiveCallbackDelivery.syncIndexes();
  }, 30000);

  afterEach(async () => {
    mockRecordGlassHiveSurfaceDeliveryOutcome.mockClear();
    mockRecordVoiceOrchestrationTrace.mockClear();
    await mongoose.connection.dropDatabase();
    await GlassHiveTerminalCallbackResult.syncIndexes();
    await Message.syncIndexes();
    await ViventiumGlassHiveCallbackDelivery.syncIndexes();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await replicaSet?.stop({ doCleanup: true, force: true });
  }, 15000);

  test('authorize then presentation-complete owns, fences, and releases every binding', async () => {
    const ownerId = 'owner-grouped-voice';
    const resultA = terminalIdentity('a', 'grouped-voice-a', ownerId);
    const resultB = terminalIdentity('b', 'grouped-voice-b', ownerId);
    const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultA,
    });
    const acceptedB = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultB,
    });
    const durableResults = await GlassHiveTerminalCallbackResult.find({ ownerId }).lean();
    const durableByCallback = new Map(durableResults.map((row) => [row.callbackId, row]));
    const bindings = [
      [resultA, acceptedA],
      [resultB, acceptedB],
    ].map(([result, accepted]) => {
      const durable = durableByCallback.get(result.callbackId);
      return {
        originRef: result.originRef,
        workRef: result.workRef,
        workerId: result.workerId,
        runId: result.runId,
        callbackRef: canonicalizeGlassHiveCallbackRef(result.callbackId),
        attemptNumber: result.attemptNumber,
        resultKey: String(durable._id),
        acceptedOperationId: accepted.acceptedOperationId,
        terminalCallbackId: result.callbackId,
        resultDigest: result.resultDigest,
        resultRevision: result.resultRevision,
        effectGeneration: durable.acceptedOperationGeneration,
      };
    });
    const conversationId = '00000000-0000-4000-8000-000000000002';
    const responseText = 'Both synthetic Workers completed.';
    const presentation = buildVoiceWorkerCompletionPresentation({
      ownerId,
      conversationId,
      callSessionId: 'call-grouped-voice',
      responseMessageId: 'message-grouped-voice',
      responseText,
      bindings,
    });
    const representative = presentation.bindings[0];
    await saveMessage(
      {
        user: { id: ownerId },
        body: { viventiumQaRun: true, viventiumEvalIsolation: { conversationRecall: true } },
        config: {},
      },
      {
        messageId: presentation.responseMessageId,
        conversationId,
        parentMessageId: 'parent-grouped-voice',
        sender: 'AI',
        endpoint: 'agents',
        model: 'agent-main',
        text: responseText,
        isCreatedByUser: false,
        unfinished: false,
        error: false,
      },
      { context: 'viventium/tests/grouped-voice-presentation' },
    );
    await ViventiumGlassHiveCallbackDelivery.create({
      deliveryKey: 'delivery-grouped-voice',
      deliveryId: 'delivery-grouped-voice',
      callbackMessageId: presentation.responseMessageId,
      callbackId: representative.callbackRef,
      originRef: representative.originRef,
      workRef: representative.workRef,
      userId: ownerId,
      conversationId,
      surface: 'voice',
      event: 'main.followup',
      status: 'pending',
      text: responseText,
      voiceCallSessionId: presentation.callSessionId,
      voiceRequestId: presentation.turnId,
      nextAttemptAt: new Date(0),
      expiresAt: new Date(Date.now() + 60_000),
      terminalCallbackResultKey: representative.resultKey,
      terminalCallbackAcceptedOperationId: representative.acceptedOperationId,
      terminalCallbackId: representative.terminalCallbackId,
      terminalCallbackResultDigest: representative.resultDigest,
      terminalCallbackResultRevision: representative.resultRevision,
      terminalCallbackEffectGeneration: representative.effectGeneration,
      workerCompletionPresentation: presentation,
    });

    const [claimed] = await claimPendingGlassHiveCallbackDeliveries({
      surface: 'voice',
      userId: ownerId,
      voiceCallSessionId: presentation.callSessionId,
      limit: 1,
    });
    const initialPermit = await authorizeGlassHiveCallbackDeliveryDispatch({
      deliveryId: claimed.deliveryId,
      claimId: claimed.claimId,
      userId: ownerId,
      voiceCallSessionId: presentation.callSessionId,
    });
    expect(initialPermit).toMatchObject({
      deliveryId: claimed.deliveryId,
      claimId: claimed.claimId,
      surface: 'voice',
      resultRevision: representative.resultRevision,
      resultDigest: representative.resultDigest,
    });
    const permit = await renewGlassHiveCallbackDeliveryDispatch({
      deliveryId: claimed.deliveryId,
      claimId: claimed.claimId,
      dispatchPermit: initialPermit,
      leaseMs: 120_000,
      userId: ownerId,
      voiceCallSessionId: presentation.callSessionId,
    });
    expect(permit).toMatchObject({
      permitId: initialPermit.permitId,
      permitGeneration: initialPermit.permitGeneration,
    });
    expect(new Date(permit.expiresAt).getTime()).toBeGreaterThan(
      new Date(initialPermit.expiresAt).getTime(),
    );
    const authorized = await ViventiumGlassHiveCallbackDelivery.findOne({
      deliveryId: claimed.deliveryId,
    }).lean();
    expect(authorized).toMatchObject({
      status: 'claimed',
      dispatchPermitId: permit.permitId,
      dispatchPermitGeneration: permit.permitGeneration,
      workerCompletionEffectLeases: [
        expect.objectContaining({ resultKey: presentation.bindings[0].resultKey }),
        expect.objectContaining({ resultKey: presentation.bindings[1].resultKey }),
      ],
    });

    await expect(
      completeGlassHiveWorkerCompletionPresentation({
        deliveryId: claimed.deliveryId,
        claimId: claimed.claimId,
        dispatchPermit: { ...permit, permitId: 'f'.repeat(32) },
        presentationRef: presentation.presentationRef,
        userId: ownerId,
        voiceCallSessionId: presentation.callSessionId,
      }),
    ).resolves.toBeNull();
    await expect(
      ViventiumGlassHiveCallbackDelivery.findOne({ deliveryId: claimed.deliveryId }).lean(),
    ).resolves.toMatchObject({
      status: 'claimed',
      dispatchPermitId: permit.permitId,
      workerCompletionEffectLeases: expect.arrayContaining([
        expect.objectContaining({ resultKey: presentation.bindings[0].resultKey }),
        expect.objectContaining({ resultKey: presentation.bindings[1].resultKey }),
      ]),
    });
    await expect(
      markGlassHiveCallbackDeliverySent({
        deliveryId: claimed.deliveryId,
        claimId: claimed.claimId,
        dispatchPermit: permit,
        userId: ownerId,
        voiceCallSessionId: presentation.callSessionId,
      }),
    ).resolves.toBeNull();
    await expect(
      ViventiumGlassHiveCallbackDelivery.findOne({ deliveryId: claimed.deliveryId }).lean(),
    ).resolves.toMatchObject({ status: 'claimed', dispatchPermitId: permit.permitId });

    await expect(
      completeGlassHiveWorkerCompletionPresentation({
        deliveryId: claimed.deliveryId,
        claimId: claimed.claimId,
        dispatchPermit: permit,
        presentationRef: presentation.presentationRef,
        userId: ownerId,
        voiceCallSessionId: presentation.callSessionId,
      }),
    ).resolves.toMatchObject({ status: 'sent' });
    await expect(
      ViventiumGlassHiveCallbackDelivery.findOne({ deliveryId: claimed.deliveryId }).lean(),
    ).resolves.toMatchObject({
      status: 'sent',
      dispatchPermitId: '',
      dispatchPermitGeneration: 0,
      dispatchPermitExpiresAt: null,
      workerCompletionEffectLeases: [],
    });
    const releasedResults = await GlassHiveTerminalCallbackResult.find({ ownerId }).lean();
    expect(releasedResults).toHaveLength(2);
    for (const result of releasedResults) {
      expect(result.effectLeaseId).toBeUndefined();
      expect(result.effectLeaseExpiresAt).toBeUndefined();
    }
    expect(mockRecordVoiceOrchestrationTrace).toHaveBeenCalledTimes(4);
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: representative.originRef,
      state: 'sent',
    });
  }, 15000);

  test('reuses a public-base delivery row whose originRef field is absent', async () => {
    const ownerId = 'owner-public-base-upgrade';
    const originRef = 'origin-public-base-upgrade';
    const callbackId = 'raw-public-base-upgrade';
    const callbackRef = canonicalizeGlassHiveCallbackRef(callbackId);
    const legacyDeliveryKey = `telegram:${callbackRef}`;
    const now = new Date();
    await ViventiumGlassHiveCallbackDelivery.collection.insertOne({
      deliveryKey: legacyDeliveryKey,
      deliveryId: 'delivery-public-base-upgrade',
      callbackId: callbackRef,
      traceIdentityVerified: false,
      callbackKey: '',
      callbackMessageId: 'message-public-base-upgrade',
      userId: ownerId,
      conversationId: 'conversation-public-base-upgrade',
      surface: 'telegram',
      event: 'run.needs_input',
      status: 'pending',
      text: 'Legacy delivery text.',
      retryCount: 0,
      nextAttemptAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      enqueueGlassHiveCallbackDelivery({
        body: {
          callback_id: callbackId,
          attempt_number: 4,
          event: 'run.needs_input',
          origin_ref: originRef,
          work_ref: 'work-public-base-upgrade',
        },
        deliveryContext: {
          ownerId,
          originRef,
          workRef: 'work-public-base-upgrade',
          conversationId: 'conversation-public-base-upgrade',
          traceIdentity: { callbackRef, attemptNumber: 4 },
          destinations: [{ surface: 'telegram', telegramChatId: 'chat-public-base-upgrade' }],
        },
        message: {
          messageId: 'message-public-base-upgrade',
          text: 'Current delivery text.',
        },
        text: 'Current delivery text.',
      }),
    ).resolves.toMatchObject({
      configured: 1,
      enqueued: 1,
      deliveries: [
        expect.objectContaining({ deliveryId: 'delivery-public-base-upgrade', status: 'pending' }),
      ],
    });
    await expect(ViventiumGlassHiveCallbackDelivery.countDocuments({})).resolves.toBe(1);
    const persisted = await ViventiumGlassHiveCallbackDelivery.collection.findOne({
      deliveryKey: legacyDeliveryKey,
    });
    expect(persisted).toMatchObject({
      deliveryId: 'delivery-public-base-upgrade',
      userId: ownerId,
      text: 'Current delivery text.',
    });
    expect(persisted).not.toHaveProperty('originRef');
  }, 15000);
});
