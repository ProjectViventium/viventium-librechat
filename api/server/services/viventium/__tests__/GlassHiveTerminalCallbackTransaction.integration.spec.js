/* === VIVENTIUM START ===
 * Feature: all-destination terminal callback generation fence.
 * Purpose: Prove with a real replica set that a stale transaction cannot commit after a newer
 * central result wins, even while the newer operation is paused before its destination write.
 * === VIVENTIUM END === */
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const {
  acquireGlassHiveTerminalCallbackEffectLease,
  compareAndSetGlassHiveTerminalCallbackResult,
  fenceGlassHiveTerminalCallbackAcceptedOperationTransaction,
  fenceGlassHiveTerminalCallbackEffectTransaction,
  releaseGlassHiveTerminalCallbackEffectLease,
} = require('@librechat/data-schemas');
const {
  Conversation,
  GlassHiveTerminalCallbackResult,
  Message,
  ViventiumCallSession,
  ViventiumCortexInsightDelivery,
  ViventiumGlassHiveCallbackDelivery,
  ViventiumGlassHiveCallbackEffectOutbox,
  ViventiumOrchestrationTraceEvent,
  ViventiumVoiceTask,
} = require('~/db/models');
const { saveConvo, saveMessage } = require('~/models');
const {
  currentGlassHiveTerminalCallbackTransaction,
  deferGlassHiveTerminalCallbackAfterCommit,
  runGlassHiveTerminalCallbackTransaction,
} = require('../GlassHiveTerminalCallbackTransaction');
const { createCortexInsightDeliveryService } = require('../CortexInsightDeliveryService');
const {
  dispatchGlassHiveSchedulerCallbackOutbox,
  enqueueGlassHiveSchedulerCallbackOutbox,
} = require('../GlassHiveTerminalCallbackOutboxService');
const {
  authorizeGlassHiveCallbackDeliveryDispatch,
  claimPendingGlassHiveCallbackDeliveries,
  enqueueGlassHiveCallbackDelivery,
  markGlassHiveCallbackDeliverySent,
  releaseGlassHiveCallbackDeliveryDispatch,
  renewGlassHiveCallbackDeliveryDispatch,
} = require('../GlassHiveCallbackDeliveryService');
const {
  confirmGlassHiveCallbackContext,
  recordGlassHiveCallbackExternalState,
  recordGlassHiveSurfaceDeliveryOutcome,
} = require('../GlassHiveCallbackBindingService');
const {
  clearAdjudicationTimersForTests,
  persistGlassHiveMissionEvidence,
} = require('../GlassHiveMissionAdjudicationService');
const { recordOrchestrationTraceCallback } = require('../OrchestrationTraceLedgerService');
const { getCoreWorkDelivery } = require('../GlassHiveActiveWorkProjectionService');
const { claimOrReplaceCallSessionConversationId } = require('../CallSessionService');
const {
  completeVoiceTask,
  createVoiceTask,
  failVoiceTask,
  flushVoiceTaskPersistence,
  getVoiceTask,
  resetVoiceTasksForTests,
  runVoiceTaskTerminalCallbackMutation,
  subscribeVoiceTask,
} = require('../VoiceTaskService');
const {
  registerGlassHiveVoiceTaskActionCapabilities,
} = require('../GlassHiveVoiceTaskActionService');

const CALLBACK_BINDINGS_COLLECTION = 'viventium_glasshive_callback_bindings';
const EXTERNAL_WORK_COLLECTION = 'viventium_external_work';
const MISSION_EVIDENCE_COLLECTION = 'viventium_glasshive_mission_evidence';
const PRESENTATION_CONVERSATION_ID = '00000000-0000-4000-8000-000000000001';

function identity(revision, character, scope, resultState = 'completed') {
  return {
    ownerId: `owner-${scope}`,
    originRef: `origin-${scope}`,
    workRef: `work-${scope}`,
    workerId: `worker-${character}`,
    runId: `run-${scope}`,
    callbackId: `cb_terminal_${character.repeat(64)}`,
    attemptNumber: 1,
    resultState,
    resultEndedAt: '2026-08-23T18:00:00.000Z',
    resultRevision: revision,
    resultDigest: `sha256:${character.repeat(64)}`,
  };
}

function callbackBody(result, overrides = {}) {
  return {
    callback_id: result.callbackId,
    callback_ts: Math.floor(Date.now() / 1000),
    attempt_number: result.attemptNumber,
    origin_ref: result.originRef,
    work_ref: result.workRef,
    worker_id: result.workerId,
    run_id: result.runId,
    event: 'run.completed',
    work_state: result.resultState,
    work_terminal: true,
    result_state: result.resultState,
    result_ended_at: result.resultEndedAt,
    result_revision: result.resultRevision,
    result_digest: result.resultDigest,
    message: `Canonical result revision ${result.resultRevision}.`,
    full_message: `Canonical durable evidence revision ${result.resultRevision}.`,
    ...overrides,
  };
}

function callbackBinding(result, overrides = {}) {
  return {
    bindingId: result.originRef,
    originRef: result.originRef,
    workRef: result.workRef,
    ownerId: result.ownerId,
    conversationId: `conversation-${result.workRef}`,
    anchorMessageId: `anchor-${result.workRef}`,
    requestedParentMessageId: `parent-${result.workRef}`,
    mainAgentId: 'agent-main',
    destinations: [{ surface: 'librechat' }],
    ...overrides,
  };
}

async function seedExternalWork(result, { claimed = false } = {}) {
  const binding = callbackBinding(result);
  const now = new Date('2026-08-23T17:59:00.000Z');
  const base = {
    _id: result.originRef,
    originRef: result.originRef,
    workRef: claimed ? result.workRef : '',
    ownerId: result.ownerId,
    conversationId: binding.conversationId,
    anchorMessageId: binding.anchorMessageId,
    requestedParentMessageId: binding.requestedParentMessageId,
    launchState: 'dispatch_ready',
    externalState: 'running',
    createdAt: now,
    updatedAt: now,
  };
  await mongoose.connection.collection(CALLBACK_BINDINGS_COLLECTION).insertOne(base);
  await mongoose.connection.collection(EXTERNAL_WORK_COLLECTION).insertOne(base);
  return binding;
}

async function syncProofIndexes() {
  for (const Model of [
    GlassHiveTerminalCallbackResult,
    Conversation,
    Message,
    ViventiumCallSession,
    ViventiumCortexInsightDelivery,
    ViventiumGlassHiveCallbackDelivery,
    ViventiumGlassHiveCallbackEffectOutbox,
    ViventiumOrchestrationTraceEvent,
    ViventiumVoiceTask,
  ]) {
    await Model.syncIndexes();
  }
}

const REAL_DESTINATIONS = [
  {
    name: 'callback binding and external-work services',
    scope: 'binding-external',
    prepare: ({ resultA }) => seedExternalWork(resultA),
    apply: async ({ result, effectFence, effectSession, prepared: binding }) => {
      const body = callbackBody(result);
      await confirmGlassHiveCallbackContext({
        binding,
        body,
        effectFence,
        effectSession,
      });
      await recordGlassHiveCallbackExternalState({
        binding,
        body,
        effectFence,
        effectSession,
      });
    },
    read: async ({ resultA }) => ({
      binding: await mongoose.connection
        .collection(CALLBACK_BINDINGS_COLLECTION)
        .findOne({ _id: resultA.originRef }),
      external: await mongoose.connection
        .collection(EXTERNAL_WORK_COLLECTION)
        .findOne({ _id: resultA.originRef }),
    }),
    assertAfterA: (snapshot) => {
      expect(snapshot.binding).not.toHaveProperty('terminalCallbackResultRevision');
      expect(snapshot.external).not.toHaveProperty('terminalCallbackResultRevision');
      expect(snapshot.external.workerId).toBeUndefined();
    },
    assertAfterB: (snapshot, resultB) => {
      expect(snapshot.binding).toMatchObject({
        workRef: resultB.workRef,
        launchState: 'callback_confirmed',
        terminalCallbackResultRevision: 2,
        terminalCallbackId: resultB.callbackId,
        terminalCallbackResultDigest: resultB.resultDigest,
      });
      expect(snapshot.external).toMatchObject({
        workRef: resultB.workRef,
        workerId: resultB.workerId,
        runId: resultB.runId,
        externalState: 'completed',
        terminalCallbackResultRevision: 2,
        terminalCallbackId: resultB.callbackId,
        terminalCallbackResultDigest: resultB.resultDigest,
      });
    },
  },
  {
    name: 'orchestration trace ledger service',
    scope: 'trace-ledger',
    apply: ({ result }) =>
      recordOrchestrationTraceCallback({
        ownerId: result.ownerId,
        originRef: result.originRef,
        workRef: result.workRef,
        runRef: result.runId,
        callbackRef: `callback_sha256:${result.resultDigest.slice('sha256:'.length)}`,
        event: 'run.completed',
        workState: 'completed',
        workTerminal: true,
        callbackAt: result.resultEndedAt,
        callbackAcceptedAt: result.resultEndedAt,
        attemptNumber: result.attemptNumber,
      }),
    read: () => ViventiumOrchestrationTraceEvent.find({}).sort({ sequence: 1 }).lean(),
    assertAfterA: (snapshot) => expect(snapshot).toEqual([]),
    assertAfterB: (snapshot) => {
      const [completed, accepted] = snapshot;
      expect(snapshot).toHaveLength(2);
      expect(completed).toMatchObject({ stage: 'work.completed', sequence: 1 });
      expect(accepted).toMatchObject({ stage: 'callback.accepted', sequence: 2 });
    },
  },
  {
    name: 'mission adjudication continuation-evidence service',
    scope: 'mission-evidence',
    apply: ({ result, effectFence, effectSession }) =>
      persistGlassHiveMissionEvidence({
        binding: callbackBinding(result),
        body: callbackBody(result),
        effectFence,
        effectSession,
      }),
    read: () => mongoose.connection.collection(MISSION_EVIDENCE_COLLECTION).find({}).toArray(),
    assertAfterA: (snapshot) => expect(snapshot).toEqual([]),
    assertAfterB: (snapshot, resultB) => {
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]).toMatchObject({
        ownerId: resultB.ownerId,
        originRef: resultB.originRef,
        workRef: resultB.workRef,
        runId: resultB.runId,
        state: 'pending',
        terminalCallbackResultRevision: 2,
        terminalCallbackId: resultB.callbackId,
        terminalCallbackResultDigest: resultB.resultDigest,
      });
      expect(snapshot[0].evidence).toContain('revision 2');
    },
  },
  {
    name: 'Telegram and voice delivery ledger service',
    scope: 'surface-delivery',
    resultState: 'failed',
    apply: ({ result, effectFence, effectSession }) =>
      enqueueGlassHiveCallbackDelivery({
        body: callbackBody(result, {
          event: 'run.failed',
          work_state: 'failed',
          result_state: 'failed',
        }),
        message: {
          messageId: 'message-surface-delivery',
          text: `Neutral failure revision ${result.resultRevision}.`,
          metadata: { viventium: { callbackKey: result.callbackId } },
        },
        text: `Neutral failure revision ${result.resultRevision}.`,
        fullText: '',
        deliveryContext: callbackBinding(result, {
          destinations: [
            {
              surface: 'telegram',
              telegramChatId: 'telegram-chat-surface-delivery',
              telegramUserId: 'telegram-user-surface-delivery',
            },
            {
              surface: 'voice',
              voiceCallSessionId: 'voice-call-surface-delivery',
              voiceRequestId: 'voice-request-surface-delivery',
            },
          ],
        }),
        effectFence,
        effectSession,
      }),
    read: () => ViventiumGlassHiveCallbackDelivery.find({}).sort({ surface: 1 }).lean(),
    assertAfterA: (snapshot) => expect(snapshot).toEqual([]),
    assertAfterB: (snapshot, resultB) => {
      expect(snapshot).toHaveLength(2);
      expect(snapshot).toEqual([
        expect.objectContaining({
          surface: 'telegram',
          status: 'pending',
          terminalCallbackResultRevision: 2,
          terminalCallbackId: resultB.callbackId,
          terminalCallbackResultDigest: resultB.resultDigest,
          text: expect.stringContaining('revision 2'),
        }),
        expect.objectContaining({
          surface: 'voice',
          status: 'pending',
          terminalCallbackResultRevision: 2,
          terminalCallbackId: resultB.callbackId,
          terminalCallbackResultDigest: resultB.resultDigest,
          text: expect.stringContaining('revision 2'),
        }),
      ]);
    },
  },
  {
    name: 'message presentation and conversation touch models',
    scope: 'message-presentation',
    prepare: async ({ resultA }) => {
      await Conversation.create({
        conversationId: PRESENTATION_CONVERSATION_ID,
        user: resultA.ownerId,
        title: 'Baseline conversation',
        endpoint: 'agents',
        messages: [],
      });
      return {
        req: {
          user: { id: resultA.ownerId },
          body: {
            viventiumQaRun: true,
            viventiumEvalIsolation: { conversationRecall: true },
          },
          config: {},
        },
      };
    },
    apply: async ({ result, prepared }) => {
      const messageId = 'message-terminal-presentation';
      await saveMessage(
        prepared.req,
        {
          messageId,
          conversationId: PRESENTATION_CONVERSATION_ID,
          parentMessageId: 'parent-terminal-presentation',
          sender: 'AI',
          endpoint: 'agents',
          model: 'agent-main',
          text: `Presented callback revision ${result.resultRevision}.`,
          isCreatedByUser: false,
          unfinished: false,
          error: false,
          metadata: {
            viventium: {
              callbackId: result.callbackId,
              resultRevision: result.resultRevision,
              resultDigest: result.resultDigest,
            },
          },
        },
        { context: 'viventium/tests/terminal-callback-presentation' },
      );
      const saved = await saveConvo(
        prepared.req,
        {
          conversationId: PRESENTATION_CONVERSATION_ID,
          title: `Callback revision ${result.resultRevision}`,
          endpoint: 'agents',
          model: 'agent-main',
          agent_id: 'agent-main',
        },
        { context: 'viventium/tests/terminal-callback-conversation-touch', noUpsert: true },
      );
      if (!saved || saved.message === 'Error saving conversation') {
        throw new Error('conversation_touch_failed');
      }
    },
    read: async ({ resultA }) => ({
      messages: await Message.find({ user: resultA.ownerId }).lean(),
      conversation: await Conversation.findOne({
        user: resultA.ownerId,
        conversationId: PRESENTATION_CONVERSATION_ID,
      }).lean(),
    }),
    assertAfterA: (snapshot) => {
      expect(snapshot.messages).toEqual([]);
      expect(snapshot.conversation).toMatchObject({
        title: 'Baseline conversation',
        messages: [],
      });
    },
    assertAfterB: (snapshot, resultB) => {
      expect(snapshot.messages).toHaveLength(1);
      expect(snapshot.messages[0]).toMatchObject({
        text: 'Presented callback revision 2.',
        metadata: {
          viventium: expect.objectContaining({
            callbackId: resultB.callbackId,
            resultRevision: 2,
            resultDigest: resultB.resultDigest,
          }),
        },
      });
      expect(snapshot.conversation).toMatchObject({ title: 'Callback revision 2' });
      expect(snapshot.conversation.messages).toHaveLength(1);
      expect(String(snapshot.conversation.messages[0])).toBe(String(snapshot.messages[0]._id));
    },
  },
  {
    name: 'scheduler durable outbox service',
    scope: 'scheduler-outbox',
    apply: ({ result, effectFence, effectSession }) =>
      enqueueGlassHiveSchedulerCallbackOutbox({
        binding: {
          ownerId: result.ownerId,
          scheduleOccurrenceKey: 'occurrence-terminal-transaction',
        },
        summary: {
          requiredTotal: 1,
          requiredTerminal: 1,
          requiredFailed: 0,
          allRequiredTerminal: true,
          state: 'completed',
        },
        effectFence,
        effectSession,
      }),
    read: () => ViventiumGlassHiveCallbackEffectOutbox.find({}).lean(),
    assertAfterA: (snapshot) => expect(snapshot).toEqual([]),
    assertAfterB: (snapshot, resultB) => {
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0]).toMatchObject({
        destination: 'scheduler',
        status: 'pending',
        terminalCallbackResultRevision: 2,
        terminalCallbackId: resultB.callbackId,
        terminalCallbackResultDigest: resultB.resultDigest,
      });
    },
  },
  {
    name: 'active-work callback projection service',
    scope: 'callback-projection',
    prepare: ({ resultA }) => seedExternalWork(resultA, { claimed: true }),
    apply: ({ result, effectFence, effectSession }) =>
      recordGlassHiveSurfaceDeliveryOutcome({
        originRef: result.originRef,
        state: 'sent',
        body: callbackBody(result),
        effectFence,
        effectSession,
      }),
    read: async ({ resultA }) => ({
      row: await mongoose.connection
        .collection(EXTERNAL_WORK_COLLECTION)
        .findOne({ _id: resultA.originRef }),
      projection: await getCoreWorkDelivery({
        ownerId: resultA.ownerId,
        workRef: resultA.workRef,
      }),
    }),
    assertAfterA: (snapshot) => {
      expect(snapshot.row).not.toHaveProperty('terminalCallbackResultRevision');
      expect(snapshot.projection).toEqual({ state: 'pending', unreadTerminal: true });
    },
    assertAfterB: (snapshot, resultB) => {
      expect(snapshot.row).toMatchObject({
        deliveryState: 'sent',
        terminalCallbackResultRevision: 2,
        terminalCallbackId: resultB.callbackId,
        terminalCallbackResultDigest: resultB.resultDigest,
      });
      expect(snapshot.projection).toEqual({ state: 'delivered', unreadTerminal: false });
    },
  },
];

describe('GlassHive terminal callback all-destination transaction fence', () => {
  let replicaSet;
  let providerUrlBeforeTest;

  beforeAll(async () => {
    replicaSet = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ args: ['--setParameter', 'maxTransactionLockRequestTimeoutMillis=1000'] }],
    });
    await mongoose.connect(replicaSet.getUri());
    await syncProofIndexes();
  }, 30000);

  afterEach(async () => {
    if (providerUrlBeforeTest !== undefined) {
      if (providerUrlBeforeTest == null) delete process.env.GLASSHIVE_PROVIDER_BASE_URL;
      else process.env.GLASSHIVE_PROVIDER_BASE_URL = providerUrlBeforeTest;
      providerUrlBeforeTest = undefined;
    }
    await flushVoiceTaskPersistence();
    resetVoiceTasksForTests();
    clearAdjudicationTimersForTests();
    await mongoose.connection.dropDatabase();
    await syncProofIndexes();
  });

  afterAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await replicaSet?.stop({ doCleanup: true, force: true });
  }, 15000);

  test('a newer retry run at revision one replaces a legacy prior-run revision one without allowing the older run back', async () => {
    const prior = identity(1, 'a', 'cross-run-order');
    const newer = {
      ...identity(1, 'b', 'cross-run-order'),
      runId: 'run-cross-run-order-retry',
      resultEndedAt: '2026-08-23T19:00:00.000Z',
    };
    const binding = await seedExternalWork(prior, { claimed: true });
    const acceptedPrior = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: prior,
    });
    const legacyProjection = {
      $set: {
        terminalCallbackResultRevision: prior.resultRevision,
        terminalCallbackId: prior.callbackId,
        terminalCallbackResultDigest: prior.resultDigest,
        terminalCallbackAcceptedOperationId: acceptedPrior.acceptedOperationId,
        terminalCallbackEffectLeaseId: 'f'.repeat(32),
        terminalCallbackEffectLeaseGeneration: 1,
        updatedAt: new Date('2026-08-23T18:30:00.000Z'),
      },
    };
    await mongoose.connection
      .collection(CALLBACK_BINDINGS_COLLECTION)
      .updateOne({ _id: prior.originRef }, legacyProjection);
    await mongoose.connection.collection(EXTERNAL_WORK_COLLECTION).updateOne(
      { _id: prior.originRef },
      {
        ...legacyProjection,
        $set: {
          ...legacyProjection.$set,
          runId: newer.runId,
          workerId: newer.workerId,
        },
      },
    );

    const acceptedNewer = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: newer,
    });
    const newerLease = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: newer,
      acceptedOperationId: acceptedNewer.acceptedOperationId,
    });
    expect(newerLease.status).toBe('acquired');
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      await confirmGlassHiveCallbackContext({
        binding,
        body: callbackBody(newer),
        effectFence: newerLease.lease,
        effectSession: session,
      });
      await expect(
        fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease: newerLease.lease,
          session,
        }),
      ).resolves.toBe(true);
    });
    await releaseGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease: newerLease.lease,
    });

    for (const collectionName of [CALLBACK_BINDINGS_COLLECTION, EXTERNAL_WORK_COLLECTION]) {
      await expect(
        mongoose.connection.collection(collectionName).findOne({ _id: prior.originRef }),
      ).resolves.toMatchObject({
        terminalCallbackResultRevision: 1,
        terminalCallbackId: newer.callbackId,
        terminalCallbackResultDigest: newer.resultDigest,
        terminalCallbackRunId: newer.runId,
        terminalCallbackResultEndedAt: new Date(newer.resultEndedAt),
      });
    }

    const staleHigherRevision = {
      ...identity(2, 'c', 'cross-run-order'),
      resultEndedAt: prior.resultEndedAt,
    };
    const acceptedStale = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: staleHigherRevision,
    });
    const staleLease = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: staleHigherRevision,
      acceptedOperationId: acceptedStale.acceptedOperationId,
    });
    expect(staleLease.status).toBe('acquired');
    await expect(
      runGlassHiveTerminalCallbackTransaction((session) =>
        confirmGlassHiveCallbackContext({
          binding,
          body: callbackBody(staleHigherRevision),
          effectFence: staleLease.lease,
          effectSession: session,
        }),
      ),
    ).rejects.toMatchObject({ code: 'glasshive_callback_effect_fenced' });
    await releaseGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease: staleLease.lease,
    });

    await expect(
      mongoose.connection.collection(EXTERNAL_WORK_COLLECTION).findOne({ _id: prior.originRef }),
    ).resolves.toMatchObject({
      terminalCallbackResultRevision: 1,
      terminalCallbackId: newer.callbackId,
      terminalCallbackRunId: newer.runId,
      terminalCallbackResultEndedAt: new Date(newer.resultEndedAt),
    });
  }, 15000);

  test('Cortex insight batch shares the outer callback transaction rollback and commit fence', async () => {
    let sequence = 0;
    const service = createCortexInsightDeliveryService({
      DeliveryModel: ViventiumCortexInsightDelivery,
      now: () => new Date('2026-08-23T18:00:00.000Z'),
      randomUUID: () => `transaction-proof-${++sequence}`,
      runtimeSlot: 'transaction-proof-slot',
      runtimeEpoch: 'transaction-proof-epoch',
      consumeFault: async () => ({ triggered: false }),
    });
    const request = {
      ownerId: 'owner-cortex-transaction-proof',
      conversationId: 'conversation-cortex-transaction-proof',
      parentMessageId: 'parent-cortex-transaction-proof',
      surface: 'telegram',
      insights: [
        { cortexId: 'cortex-a', insight: 'First committed transaction proof.' },
        { cortexId: 'cortex-b', insight: 'Second committed transaction proof.' },
      ],
    };

    await expect(
      runGlassHiveTerminalCallbackTransaction(async () => {
        const aborted = await service.claimBatch(request);
        expect(aborted.claimed).toHaveLength(2);
        throw new Error('synthetic outer callback abort');
      }),
    ).rejects.toThrow('synthetic outer callback abort');
    await expect(
      ViventiumCortexInsightDelivery.countDocuments({ userId: request.ownerId }),
    ).resolves.toBe(0);

    const committed = await runGlassHiveTerminalCallbackTransaction(() =>
      service.claimBatch(request),
    );
    expect(committed.claimed).toHaveLength(2);
    expect(new Set(committed.claimed.map((row) => row.claimToken))).toEqual(
      new Set([committed.claimId]),
    );
    const rows = await ViventiumCortexInsightDelivery.find({ userId: request.ownerId })
      .sort({ deliveryId: 1 })
      .lean();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.status)).toEqual(['claimed', 'claimed']);
    expect(rows.map((row) => row.claimGeneration)).toEqual([1, 1]);
    expect(new Set(rows.map((row) => row.claimToken))).toEqual(new Set([committed.claimId]));
  });

  test('post-commit work runs outside the callback session and abort drops it', async () => {
    let committedContext = 'not_run';
    let committedStoreSession = 'not_run';
    let abortedWorkRan = false;

    await runGlassHiveTerminalCallbackTransaction(async () => {
      expect(currentGlassHiveTerminalCallbackTransaction()).not.toBeNull();
      expect(
        deferGlassHiveTerminalCallbackAfterCommit(() => {
          committedContext = currentGlassHiveTerminalCallbackTransaction();
          committedStoreSession =
            mongoose.transactionAsyncLocalStorage?.getStore()?.session ?? null;
        }),
      ).toBe(true);
    });

    expect(committedContext).toBeNull();
    expect(committedStoreSession).toBeNull();

    await expect(
      runGlassHiveTerminalCallbackTransaction(async () => {
        expect(
          deferGlassHiveTerminalCallbackAfterCommit(() => {
            abortedWorkRan = true;
          }),
        ).toBe(true);
        throw new Error('synthetic callback abort');
      }),
    ).rejects.toThrow('synthetic callback abort');
    expect(abortedWorkRan).toBe(false);
  });

  test.each(REAL_DESTINATIONS)(
    '$name rolls back paused A and commits only current B through the real destination',
    async (destination) => {
      const resultA = identity(1, 'a', destination.scope, destination.resultState);
      const resultB = identity(2, 'b', destination.scope, destination.resultState);
      const acceptedAt = new Date('2026-08-23T18:00:00.000Z');
      const expiredAt = new Date('2026-08-23T18:00:02.000Z');
      const prepared = await destination.prepare?.({ resultA, resultB });
      const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultA,
        now: acceptedAt,
      });
      const acquiredA = await acquireGlassHiveTerminalCallbackEffectLease({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultA,
        acceptedOperationId: acceptedA.acceptedOperationId,
        now: acceptedAt,
        leaseDurationMs: 1000,
      });
      expect(acquiredA.status).toBe('acquired');
      if (acquiredA.status !== 'acquired') throw new Error('A lease unavailable');

      let releaseA;
      let enterA;
      const aBlocked = new Promise((resolve) => {
        releaseA = resolve;
      });
      const aEntered = new Promise((resolve) => {
        enterA = resolve;
      });
      const aWrite = runGlassHiveTerminalCallbackTransaction(async (session) => {
        await destination.apply({
          result: resultA,
          effectFence: acquiredA.lease,
          effectSession: session,
          prepared,
        });
        enterA();
        await aBlocked;
        const current = await fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease: acquiredA.lease,
          session,
          now: expiredAt,
        });
        if (!current) throw new Error('glasshive_callback_effect_fenced');
      });

      await aEntered;
      const acceptedB = await compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultB,
        now: expiredAt,
      });
      expect(acceptedB.status).toBe('accepted');
      // B is now the central winner and remains paused before this destination.
      releaseA();
      await expect(aWrite).rejects.toThrow('glasshive_callback_effect_fenced');
      const afterA = await destination.read({ resultA, resultB, prepared });
      destination.assertAfterA(afterA, resultA);
      expect(JSON.stringify(afterA)).not.toContain(resultA.callbackId);
      expect(JSON.stringify(afterA)).not.toContain(resultA.resultDigest);

      const acquiredB = await acquireGlassHiveTerminalCallbackEffectLease({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultB,
        acceptedOperationId: acceptedB.acceptedOperationId,
        now: expiredAt,
        leaseDurationMs: 60_000,
      });
      expect(acquiredB.status).toBe('acquired');
      if (acquiredB.status !== 'acquired') throw new Error('B lease unavailable');
      await runGlassHiveTerminalCallbackTransaction(async (session) => {
        await destination.apply({
          result: resultB,
          effectFence: acquiredB.lease,
          effectSession: session,
          prepared,
        });
        const current = await fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease: acquiredB.lease,
          session,
          now: expiredAt,
        });
        if (!current) throw new Error('B unexpectedly fenced');
      });

      const afterB = await destination.read({ resultA, resultB, prepared });
      destination.assertAfterB(afterB, resultB);
      expect(JSON.stringify(afterB)).not.toContain(resultA.callbackId);
    },
    20000,
  );

  test('scheduler consumer reauthorizes after its stall and never sends stale A', async () => {
    const resultA = identity(1, 'a', 'scheduler-dispatch');
    const resultB = identity(2, 'b', 'scheduler-dispatch');
    const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultA,
    });
    const fenceA = {
      resultKey: String((await GlassHiveTerminalCallbackResult.findOne({}).lean())._id),
      acceptedOperationId: acceptedA.acceptedOperationId,
      callbackId: resultA.callbackId,
      resultDigest: resultA.resultDigest,
      resultRevision: 1,
      generation: 1,
    };
    let outboxA;
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      outboxA = await enqueueGlassHiveSchedulerCallbackOutbox({
        binding: {
          ownerId: resultA.ownerId,
          scheduleOccurrenceKey: 'occurrence-scheduler-dispatch',
        },
        summary: {
          requiredTotal: 1,
          requiredTerminal: 1,
          requiredFailed: 0,
          allRequiredTerminal: true,
          state: 'completed',
        },
        effectFence: fenceA,
        effectSession: session,
      });
      const current = await fenceGlassHiveTerminalCallbackAcceptedOperationTransaction({
        ResultModel: GlassHiveTerminalCallbackResult,
        reference: fenceA,
        session,
      });
      expect(current).toBe(true);
    });

    let releaseA;
    let enterA;
    const blocked = new Promise((resolve) => {
      releaseA = resolve;
    });
    const entered = new Promise((resolve) => {
      enterA = resolve;
    });
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    const priorUrl = process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL;
    const priorSecret = process.env.VIVENTIUM_SCHEDULER_SECRET;
    process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL =
      'https://scheduler.invalid/internal/external-work';
    process.env.VIVENTIUM_SCHEDULER_SECRET = 'synthetic-scheduler-secret';
    try {
      const dispatchA = dispatchGlassHiveSchedulerCallbackOutbox({
        outboxId: outboxA.outboxId,
        fetchImpl,
        beforeAuthorize: async () => {
          enterA();
          await blocked;
        },
      });
      await entered;
      const acceptedB = await compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultB,
      });
      const durable = await GlassHiveTerminalCallbackResult.findOne({}).lean();
      const fenceB = {
        resultKey: String(durable._id),
        acceptedOperationId: acceptedB.acceptedOperationId,
        callbackId: resultB.callbackId,
        resultDigest: resultB.resultDigest,
        resultRevision: 2,
        generation: 2,
      };
      let outboxB;
      await runGlassHiveTerminalCallbackTransaction(async (session) => {
        outboxB = await enqueueGlassHiveSchedulerCallbackOutbox({
          binding: {
            ownerId: resultB.ownerId,
            scheduleOccurrenceKey: 'occurrence-scheduler-dispatch',
          },
          summary: {
            requiredTotal: 1,
            requiredTerminal: 1,
            requiredFailed: 0,
            allRequiredTerminal: true,
            state: 'completed',
          },
          effectFence: fenceB,
          effectSession: session,
        });
        const current = await fenceGlassHiveTerminalCallbackAcceptedOperationTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          reference: fenceB,
          session,
        });
        expect(current).toBe(true);
      });

      releaseA();
      await expect(dispatchA).resolves.toMatchObject({ status: 'superseded' });
      expect(fetchImpl).not.toHaveBeenCalled();
      await expect(
        dispatchGlassHiveSchedulerCallbackOutbox({ outboxId: outboxB.outboxId, fetchImpl }),
      ).resolves.toMatchObject({ status: 'sent' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body).toMatchObject({
        callback_id: resultB.callbackId,
        result_revision: 2,
        result_digest: resultB.resultDigest,
      });
      await expect(
        ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: outboxA.outboxId }).lean(),
      ).resolves.toMatchObject({ status: 'superseded' });
      await expect(
        ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: outboxB.outboxId }).lean(),
      ).resolves.toMatchObject({ status: 'sent' });
    } finally {
      releaseA?.();
      if (priorUrl == null) delete process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL;
      else process.env.VIVENTIUM_SCHEDULING_EXTERNAL_WORK_CALLBACK_URL = priorUrl;
      if (priorSecret == null) delete process.env.VIVENTIUM_SCHEDULER_SECRET;
      else process.env.VIVENTIUM_SCHEDULER_SECRET = priorSecret;
    }
  }, 15000);

  test('scheduler outbox deduplicates lease-generation replay for one accepted operation', async () => {
    const result = identity(1, 'a', 'scheduler-replay');
    const accepted = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: result,
    });
    const firstLease = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: result,
      acceptedOperationId: accepted.acceptedOperationId,
    });
    expect(firstLease.status).toBe('acquired');
    if (firstLease.status !== 'acquired') throw new Error('first replay lease unavailable');
    const first = await runGlassHiveTerminalCallbackTransaction(async (session) => {
      const row = await enqueueGlassHiveSchedulerCallbackOutbox({
        binding: { ownerId: result.ownerId, scheduleOccurrenceKey: 'occurrence-replay' },
        summary: {
          requiredTotal: 1,
          requiredTerminal: 1,
          requiredFailed: 0,
          allRequiredTerminal: true,
          state: 'completed',
        },
        effectFence: firstLease.lease,
        effectSession: session,
      });
      const current = await fenceGlassHiveTerminalCallbackEffectTransaction({
        ResultModel: GlassHiveTerminalCallbackResult,
        lease: firstLease.lease,
        session,
      });
      expect(current).toBe(true);
      return row;
    });
    await ViventiumGlassHiveCallbackEffectOutbox.updateOne(
      { outboxId: first.outboxId },
      { $set: { status: 'sent', sentAt: new Date(), nextAttemptAt: null } },
    );
    await releaseGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease: firstLease.lease,
    });

    const replayLease = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: result,
      acceptedOperationId: accepted.acceptedOperationId,
    });
    expect(replayLease.status).toBe('acquired');
    if (replayLease.status !== 'acquired') throw new Error('replay lease unavailable');
    const replay = await runGlassHiveTerminalCallbackTransaction(async (session) => {
      const row = await enqueueGlassHiveSchedulerCallbackOutbox({
        binding: { ownerId: result.ownerId, scheduleOccurrenceKey: 'occurrence-replay' },
        summary: {
          requiredTotal: 1,
          requiredTerminal: 1,
          requiredFailed: 0,
          allRequiredTerminal: true,
          state: 'completed',
        },
        effectFence: replayLease.lease,
        effectSession: session,
      });
      const current = await fenceGlassHiveTerminalCallbackEffectTransaction({
        ResultModel: GlassHiveTerminalCallbackResult,
        lease: replayLease.lease,
        session,
      });
      expect(current).toBe(true);
      return row;
    });

    expect(replay.outboxId).toBe(first.outboxId);
    await expect(ViventiumGlassHiveCallbackEffectOutbox.countDocuments({})).resolves.toBe(1);
    await expect(
      ViventiumGlassHiveCallbackEffectOutbox.findOne({ outboxId: first.outboxId }).lean(),
    ).resolves.toMatchObject({ status: 'sent', terminalCallbackEffectGeneration: 1 });
  }, 15000);

  test('real voice task, publication, and action binding roll back A after B wins central CAS', async () => {
    const resultA = identity(1, 'a', 'voice-task-service');
    const resultB = identity(2, 'b', 'voice-task-service');
    const acceptedAt = new Date('2026-08-23T18:00:00.000Z');
    const expiredAt = new Date('2026-08-23T18:00:02.000Z');
    const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultA,
      now: acceptedAt,
    });
    const acquiredA = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultA,
      acceptedOperationId: acceptedA.acceptedOperationId,
      now: acceptedAt,
      leaseDurationMs: 1000,
    });
    expect(acquiredA.status).toBe('acquired');
    if (acquiredA.status !== 'acquired') throw new Error('A lease unavailable');

    await ViventiumCallSession.create({
      callSessionId: 'voice-call-service',
      userId: resultA.ownerId,
      agentId: 'agent-main',
      conversationId: 'new',
      roomName: 'room-voice-call-service',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const task = createVoiceTask({
      callSessionId: 'voice-call-service',
      userId: resultA.ownerId,
      conversationId: 'voice-conversation-service',
      turnId: resultA.runId,
      streamId: `glasshive:${resultA.runId}`,
      owner: { kind: 'glasshive_run', id: resultA.runId },
    });
    await flushVoiceTaskPersistence();
    const published = [];
    const unsubscribe = subscribeVoiceTask(task.taskId, (event) => published.push(event));
    published.length = 0;
    providerUrlBeforeTest = process.env.GLASSHIVE_PROVIDER_BASE_URL ?? null;
    process.env.GLASSHIVE_PROVIDER_BASE_URL = 'https://glasshive.invalid';
    const actionBody = (result) => ({
      event: 'run.failed',
      worker_id: result.workerId,
      run_id: result.runId,
      failure_retryable: true,
      actionCapabilities: [
        {
          version: 1,
          action: 'retry',
          operation: 'workspace_continue',
          endpoint: '/v1/run-actions',
          capabilityId: `capability-${result.resultRevision}`,
          projectId: 'synthetic-project',
          workerId: result.workerId,
          runId: result.runId,
          capability: `synthetic-capability-${result.resultRevision}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      ],
    });

    let releaseA;
    let enterA;
    const blocked = new Promise((resolve) => {
      releaseA = resolve;
    });
    const entered = new Promise((resolve) => {
      enterA = resolve;
    });
    const aEffect = runGlassHiveTerminalCallbackTransaction(async (session) => {
      await claimOrReplaceCallSessionConversationId('voice-call-service', 'voice-conversation-A');
      enterA();
      await blocked;
      await runVoiceTaskTerminalCallbackMutation(task.taskId, () => {
        failVoiceTask(task.taskId, { code: 'failure-A', message: 'Synthetic failure A.' });
        return registerGlassHiveVoiceTaskActionCapabilities({
          body: actionBody(resultA),
          task,
        });
      });
      const current = await fenceGlassHiveTerminalCallbackEffectTransaction({
        ResultModel: GlassHiveTerminalCallbackResult,
        lease: acquiredA.lease,
        session,
        now: expiredAt,
      });
      if (!current) throw new Error('glasshive_callback_effect_fenced');
    });

    await entered;
    const acceptedB = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultB,
      now: expiredAt,
    });
    expect(acceptedB.status).toBe('accepted');
    releaseA();
    await expect(aEffect).rejects.toThrow('glasshive_callback_effect_fenced');
    expect(getVoiceTask(task.taskId)).toMatchObject({ state: 'running', retryable: false });
    expect(published).toEqual([]);
    await expect(ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).resolves.toMatchObject(
      {
        payload: expect.objectContaining({ state: 'running' }),
      },
    );
    await expect(
      ViventiumCallSession.findOne({ callSessionId: 'voice-call-service' }).lean(),
    ).resolves.toMatchObject({ conversationId: 'new' });

    const acquiredB = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultB,
      acceptedOperationId: acceptedB.acceptedOperationId,
      now: expiredAt,
      leaseDurationMs: 60_000,
    });
    expect(acquiredB.status).toBe('acquired');
    if (acquiredB.status !== 'acquired') throw new Error('B lease unavailable');
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      await claimOrReplaceCallSessionConversationId('voice-call-service', 'voice-conversation-B');
      await runVoiceTaskTerminalCallbackMutation(task.taskId, () => {
        failVoiceTask(task.taskId, { code: 'failure-B', message: 'Synthetic failure B.' });
        return registerGlassHiveVoiceTaskActionCapabilities({
          body: actionBody(resultB),
          task,
        });
      });
      const current = await fenceGlassHiveTerminalCallbackEffectTransaction({
        ResultModel: GlassHiveTerminalCallbackResult,
        lease: acquiredB.lease,
        session,
        now: expiredAt,
      });
      if (!current) throw new Error('B unexpectedly fenced');
    });

    expect(getVoiceTask(task.taskId)).toMatchObject({ state: 'failed', retryable: true });
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      error: expect.objectContaining({ code: 'failure-B', message: 'Synthetic failure B.' }),
    });
    await expect(ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).resolves.toMatchObject(
      {
        payload: expect.objectContaining({
          state: 'failed',
          retryable: true,
          current: expect.objectContaining({
            error: expect.objectContaining({ code: 'failure-B', message: 'Synthetic failure B.' }),
          }),
        }),
      },
    );
    await expect(
      ViventiumCallSession.findOne({ callSessionId: 'voice-call-service' }).lean(),
    ).resolves.toMatchObject({ conversationId: 'voice-conversation-B' });
    await expect(ViventiumCallSession.countDocuments({})).resolves.toBe(1);
    unsubscribe();
  }, 15000);

  test('committed voice task persistence survives a throwing first subscriber without starving a later subscriber', async () => {
    const result = identity(1, 'a', 'voice-task-subscriber-isolation');
    const accepted = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: result,
    });
    const acquired = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: result,
      acceptedOperationId: accepted.acceptedOperationId,
      leaseDurationMs: 60_000,
    });
    expect(acquired.status).toBe('acquired');
    if (acquired.status !== 'acquired') throw new Error('subscriber proof lease unavailable');

    const task = createVoiceTask({
      callSessionId: 'voice-call-subscriber-isolation',
      userId: result.ownerId,
      conversationId: 'voice-conversation-subscriber-isolation',
      turnId: result.runId,
      streamId: `glasshive:${result.runId}`,
      owner: { kind: 'glasshive_run', id: result.runId },
    });
    await flushVoiceTaskPersistence();

    let brokenTerminalDeliveries = 0;
    const laterDeliveries = [];
    const unsubscribeBroken = subscribeVoiceTask(task.taskId, (event) => {
      if (event.type !== 'result') return;
      brokenTerminalDeliveries += 1;
      throw new Error('synthetic closed first task subscriber');
    });
    const unsubscribeLater = subscribeVoiceTask(task.taskId, (event) => {
      if (event.type === 'result') laterDeliveries.push(event);
    });

    try {
      await expect(
        runGlassHiveTerminalCallbackTransaction(async (session) => {
          const completed = await runVoiceTaskTerminalCallbackMutation(task.taskId, () =>
            completeVoiceTask(task.taskId, {
              resultMessageId: 'message-subscriber-isolation-result',
            }),
          );
          const current = await fenceGlassHiveTerminalCallbackEffectTransaction({
            ResultModel: GlassHiveTerminalCallbackResult,
            lease: acquired.lease,
            session,
          });
          if (!current) throw new Error('subscriber proof unexpectedly fenced');
          return completed;
        }),
      ).resolves.toMatchObject({
        type: 'result',
        state: 'completed',
        resultMessageId: 'message-subscriber-isolation-result',
      });

      expect(brokenTerminalDeliveries).toBe(1);
      expect(laterDeliveries).toEqual([
        expect.objectContaining({
          type: 'result',
          state: 'completed',
          resultMessageId: 'message-subscriber-isolation-result',
        }),
      ]);
      expect(getVoiceTask(task.taskId)).toMatchObject({ state: 'completed' });
      await expect(
        ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean(),
      ).resolves.toMatchObject({
        payload: expect.objectContaining({
          state: 'completed',
          current: expect.objectContaining({
            resultMessageId: 'message-subscriber-isolation-result',
          }),
        }),
      });
      await expect(ViventiumVoiceTask.countDocuments({ taskId: task.taskId })).resolves.toBe(1);
    } finally {
      unsubscribeBroken();
      unsubscribeLater();
    }
  }, 15000);

  test.each(['telegram', 'voice'])(
    '%s delivery settlement rejects a claimed stale generation and sends only B',
    async (surface) => {
      const resultA = identity(1, 'a', `delivery-${surface}`);
      const resultB = identity(2, 'b', `delivery-${surface}`);
      const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultA,
      });
      const durableA = await GlassHiveTerminalCallbackResult.findOne({}).lean();
      const common = {
        callbackMessageId: `message-${surface}`,
        callbackId: `callback_sha256:${'a'.repeat(64)}`,
        originRef: resultA.originRef,
        workRef: resultA.workRef,
        userId: resultA.ownerId,
        conversationId: `conversation-${surface}`,
        surface,
        event: 'run.completed',
        runId: resultA.runId,
        status: 'pending',
        text: 'Synthetic terminal result.',
        nextAttemptAt: new Date(0),
        expiresAt: new Date(Date.now() + 60_000),
        terminalCallbackResultKey: String(durableA._id),
        terminalCallbackAcceptedOperationId: acceptedA.acceptedOperationId,
        terminalCallbackId: resultA.callbackId,
        terminalCallbackResultDigest: resultA.resultDigest,
        terminalCallbackResultRevision: 1,
        terminalCallbackEffectGeneration: 1,
        ...(surface === 'telegram'
          ? { telegramChatId: 'telegram-chat' }
          : { voiceCallSessionId: 'voice-call' }),
      };
      const rowA = await ViventiumGlassHiveCallbackDelivery.create({
        ...common,
        deliveryKey: `delivery-${surface}-A`,
        deliveryId: `delivery-${surface}-A`,
      });
      const [claimedA] = await claimPendingGlassHiveCallbackDeliveries({ surface, limit: 1 });
      expect(claimedA).toMatchObject({ deliveryId: rowA.deliveryId, status: 'claimed' });

      const acceptedB = await compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultB,
      });
      const sendBoundary = jest.fn();
      const stalePermit = await authorizeGlassHiveCallbackDeliveryDispatch({
        deliveryId: claimedA.deliveryId,
        claimId: claimedA.claimId,
        ...(surface === 'voice'
          ? { userId: resultA.ownerId, voiceCallSessionId: 'voice-call' }
          : {}),
      });
      if (stalePermit) sendBoundary('A');
      expect(stalePermit).toBeNull();
      expect(sendBoundary).not.toHaveBeenCalled();
      await expect(
        ViventiumGlassHiveCallbackDelivery.findOne({ deliveryId: rowA.deliveryId }).lean(),
      ).resolves.toMatchObject({ status: 'superseded' });

      const rowB = await ViventiumGlassHiveCallbackDelivery.create({
        ...common,
        deliveryKey: `delivery-${surface}-B`,
        deliveryId: `delivery-${surface}-B`,
        callbackId: `callback_sha256:${'b'.repeat(64)}`,
        terminalCallbackAcceptedOperationId: acceptedB.acceptedOperationId,
        terminalCallbackId: resultB.callbackId,
        terminalCallbackResultDigest: resultB.resultDigest,
        terminalCallbackResultRevision: 2,
        terminalCallbackEffectGeneration: 2,
      });
      const [claimedB] = await claimPendingGlassHiveCallbackDeliveries({ surface, limit: 1 });
      expect(claimedB).toMatchObject({ deliveryId: rowB.deliveryId, status: 'claimed' });
      const permitB = await authorizeGlassHiveCallbackDeliveryDispatch({
        deliveryId: claimedB.deliveryId,
        claimId: claimedB.claimId,
        ...(surface === 'voice'
          ? { userId: resultB.ownerId, voiceCallSessionId: 'voice-call' }
          : {}),
      });
      expect(permitB).toMatchObject({
        deliveryId: rowB.deliveryId,
        claimId: claimedB.claimId,
        surface,
        resultRevision: 2,
        resultDigest: resultB.resultDigest,
      });
      sendBoundary('B');
      await expect(
        markGlassHiveCallbackDeliverySent({
          deliveryId: claimedB.deliveryId,
          claimId: claimedB.claimId,
          dispatchPermit: permitB,
          ...(surface === 'voice'
            ? { userId: resultB.ownerId, voiceCallSessionId: 'voice-call' }
            : { telegramMessageIds: ['telegram-message-B'] }),
        }),
      ).resolves.toMatchObject({ deliveryId: rowB.deliveryId, status: 'sent' });
      expect(sendBoundary).toHaveBeenCalledTimes(1);
      expect(sendBoundary).toHaveBeenCalledWith('B');
      await expect(
        ViventiumGlassHiveCallbackDelivery.countDocuments({ status: 'sent' }),
      ).resolves.toBe(1);
      await expect(
        ViventiumGlassHiveCallbackDelivery.countDocuments({
          status: 'sent',
          terminalCallbackResultRevision: 1,
        }),
      ).resolves.toBe(0);
    },
    15000,
  );

  test('a replayable dispatch permit serializes the remote side effect until settlement', async () => {
    const resultA = identity(1, 'a', 'dispatch-permit');
    const resultB = identity(2, 'b', 'dispatch-permit');
    const acceptedA = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: resultA,
    });
    const durableA = await GlassHiveTerminalCallbackResult.findOne({}).lean();
    await ViventiumGlassHiveCallbackDelivery.create({
      deliveryKey: 'delivery-permit-A',
      deliveryId: 'delivery-permit-A',
      callbackMessageId: 'message-permit',
      callbackId: `callback_sha256:${'a'.repeat(64)}`,
      originRef: resultA.originRef,
      workRef: resultA.workRef,
      userId: resultA.ownerId,
      conversationId: 'conversation-permit',
      surface: 'telegram',
      event: 'run.completed',
      runId: resultA.runId,
      status: 'pending',
      text: 'Synthetic permit result.',
      telegramChatId: 'telegram-permit-chat',
      nextAttemptAt: new Date(0),
      expiresAt: new Date(Date.now() + 60_000),
      terminalCallbackResultKey: String(durableA._id),
      terminalCallbackAcceptedOperationId: acceptedA.acceptedOperationId,
      terminalCallbackId: resultA.callbackId,
      terminalCallbackResultDigest: resultA.resultDigest,
      terminalCallbackResultRevision: 1,
      terminalCallbackEffectGeneration: 1,
    });
    const [claimedA] = await claimPendingGlassHiveCallbackDeliveries({
      surface: 'telegram',
      limit: 1,
    });
    const permitA = await authorizeGlassHiveCallbackDeliveryDispatch({
      deliveryId: claimedA.deliveryId,
      claimId: claimedA.claimId,
      leaseMs: 5000,
    });
    expect(permitA).toMatchObject({
      deliveryId: claimedA.deliveryId,
      claimId: claimedA.claimId,
      resultRevision: 1,
      resultDigest: resultA.resultDigest,
    });
    await expect(
      authorizeGlassHiveCallbackDeliveryDispatch({
        deliveryId: claimedA.deliveryId,
        claimId: claimedA.claimId,
        leaseMs: 5000,
      }),
    ).resolves.toEqual(permitA);
    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultB,
      }),
    ).rejects.toThrow('glasshive_terminal_callback_effects_in_progress');

    const renewed = await renewGlassHiveCallbackDeliveryDispatch({
      deliveryId: claimedA.deliveryId,
      claimId: claimedA.claimId,
      dispatchPermit: permitA,
      leaseMs: 10000,
    });
    expect(new Date(renewed.expiresAt).getTime()).toBeGreaterThan(
      new Date(permitA.expiresAt).getTime(),
    );
    await expect(
      releaseGlassHiveCallbackDeliveryDispatch({
        deliveryId: claimedA.deliveryId,
        claimId: claimedA.claimId,
        dispatchPermit: renewed,
      }),
    ).resolves.toBe(true);
    await expect(
      compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: resultB,
      }),
    ).resolves.toMatchObject({ status: 'accepted', current: { resultRevision: 2 } });
    await expect(
      renewGlassHiveCallbackDeliveryDispatch({
        deliveryId: claimedA.deliveryId,
        claimId: claimedA.claimId,
        dispatchPermit: renewed,
      }),
    ).resolves.toBeNull();
  }, 15000);
});
