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
  createGlassHiveMissionAdjudicationService,
  fenceGlassHiveTerminalCallbackAcceptedOperation,
  buildVoiceWorkerCompletionPresentation,
} = require('@librechat/api');

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
  reconcileGlassHiveSurfaceDeliveryProjections,
  markGlassHiveCallbackDeliverySent,
  releaseGlassHiveCallbackDeliveryDispatch,
  renewGlassHiveCallbackDeliveryDispatch,
} = require('../GlassHiveCallbackDeliveryService');
const {
  confirmGlassHiveCallbackContext,
  fenceGlassHiveCallbackRunState,
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
    name: 'raw Telegram and voice lifecycle delivery suppression',
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
    assertAfterB: (snapshot) => {
      // Lifecycle evidence is not a conversational presenter, even after its current fence wins.
      expect(snapshot).toEqual([]);
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

async function authoredDeliveryProof(
  scope,
  { rowCount = 1, traceOperation, outcomeOperation } = {},
) {
  const result = identity(1, 'a', scope);
  const conversationId = PRESENTATION_CONVERSATION_ID;
  await Conversation.create({
    conversationId,
    user: result.ownerId,
    title: 'Local guide',
    endpoint: 'agents',
    agent_id: 'agent-main',
  });
  const accepted = await compareAndSetGlassHiveTerminalCallbackResult({
    ResultModel: GlassHiveTerminalCallbackResult,
    incoming: result,
  });
  const acquired = await acquireGlassHiveTerminalCallbackEffectLease({
    ResultModel: GlassHiveTerminalCallbackResult,
    incoming: result,
    acceptedOperationId: accepted.acceptedOperationId,
  });
  expect(acquired.status).toBe('acquired');
  const collection = mongoose.connection.collection(MISSION_EVIDENCE_COLLECTION);
  const receipts = mongoose.connection.collection('test_authored_delivery_receipts');
  const preparedText = 'The local guide is complete. Its original answer stays intact.';
  const authoredId = `authored-${scope}`;
  const request = {
    user: { id: result.ownerId },
    body: { viventiumQaRun: true, viventiumEvalIsolation: { conversationRecall: true } },
    config: {},
  };
  const writeAuthored = async (messageId = authoredId) => {
    const message = {
      messageId,
      conversationId,
      parentMessageId: 'original-anchor',
      sender: 'AI',
      endpoint: 'agents',
      model: 'agent-main',
      text: preparedText,
      isCreatedByUser: false,
      unfinished: false,
      error: false,
    };
    await saveMessage(request, message, {
      context: 'viventium/tests/authored-delivery-transaction',
    });
    return { messageId, text: preparedText };
  };
  const prepare = jest.fn(async () => ({ text: preparedText }));
  const persist = jest.fn(async () => writeAuthored());
  let failDelivery = true;
  const delivery = jest.fn(async () => {
    if (failDelivery)
      throw Object.assign(new Error('synthetic surface unavailable'), {
        code: 'surface_unavailable',
      });
    return { configured: 1, enqueued: 1 };
  });
  const logger = { info: jest.fn(), warn: jest.fn() };
  const service = createGlassHiveMissionAdjudicationService({
    mongoose,
    logger,
    buildVoiceWorkerCompletionPresentation,
    fenceGlassHiveTerminalCallbackAcceptedOperation,
    getConvo: (ownerId, id) => Conversation.findOne({ user: ownerId, conversationId: id }).lean(),
    getUserById: async () => ({ id: result.ownerId, role: 'USER' }),
    getFeelingState: async () => null,
    logFeelingsEvent: jest.fn(),
    saveConvo,
    getAgent: async () => ({ id: 'agent-main' }),
    getAppConfig: async () => ({}),
    prepareCortexFollowUpMessage: prepare,
    persistPreparedCortexFollowUpMessage: persist,
    isGlassHiveWorkTerminalCallback: (body) => body.work_terminal === true,
    recordGlassHiveAdjudicationOutcome: async () => {
      if (outcomeOperation)
        await outcomeOperation(currentGlassHiveTerminalCallbackTransaction()?.session);
      return {};
    },
    recordOrchestrationTraceDelivery: async (receipt) => {
      const session = currentGlassHiveTerminalCallbackTransaction()?.session;
      if (traceOperation) await traceOperation(receipt, session);
      return receipts.insertOne(receipt, { session });
    },
    getActiveCallSessionForConversation: async () => null,
    sanitizeGlassHiveCallbackText: (value) => String(value || ''),
    deferGlassHiveTerminalCallbackAfterCommit,
    runGlassHiveTerminalCallbackTransaction,
    enqueueGlassHiveCallbackDelivery: delivery,
    getTerminalCallbackResultModel: () => GlassHiveTerminalCallbackResult,
  });
  const evidenceRows = [];
  for (let index = 0; index < rowCount; index += 1) {
    const memberResult =
      index === 0
        ? result
        : {
            ...identity(1, 'b', `${scope}-sibling`),
            ownerId: result.ownerId,
          };
    const memberAccepted =
      index === 0
        ? accepted
        : await compareAndSetGlassHiveTerminalCallbackResult({
            ResultModel: GlassHiveTerminalCallbackResult,
            incoming: memberResult,
          });
    const memberAcquired =
      index === 0
        ? acquired
        : await acquireGlassHiveTerminalCallbackEffectLease({
            ResultModel: GlassHiveTerminalCallbackResult,
            incoming: memberResult,
            acceptedOperationId: memberAccepted.acceptedOperationId,
          });
    await Message.create({
      messageId: callbackBinding(memberResult).requestedParentMessageId,
      user: memberResult.ownerId,
      conversationId,
      text: 'Prepare the requested local guide.',
      isCreatedByUser: true,
    });
    await runGlassHiveTerminalCallbackTransaction(async (session) => {
      evidenceRows.push(
        await service.persistGlassHiveMissionEvidence({
          binding: callbackBinding(memberResult, {
            conversationId,
            anchorMessageId: 'original-anchor',
            traceIdentity: {
              callbackRef:
                'callback_sha256:' +
                require('crypto')
                  .createHash('sha256')
                  .update(memberResult.callbackId)
                  .digest('hex'),
              attemptNumber: 1,
            },
          }),
          body: callbackBody(memberResult),
          effectFence: memberAcquired.lease,
          effectSession: session,
        }),
      );
    });
  }
  const evidence = evidenceRows[0];
  // Control the direct-flush retry fixture; automatic reconciliation has separate scheduling tests.
  const due = async () => {
    await collection.updateOne(
      { _id: evidence._id },
      { $set: { state: 'pending', nextAttemptAt: new Date(0), updatedAt: new Date(0) } },
    );
  };
  return {
    result,
    lease: acquired.lease,
    logger,
    conversationId,
    collection,
    receipts,
    evidence,
    evidenceRows,
    prepare,
    persist,
    delivery,
    service,
    authoredId,
    preparedText,
    writeAuthored,
    due,
    allowDelivery: () => {
      failDelivery = false;
    },
  };
}

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

  test.each(['current', 'newer-child', 'member-fence-race'])(
    'legacy sent aggregate status recovery commits all current members atomically: %s',
    async (scenario) => {
      const ownerId = 'owner-aggregate-recovery';
      const bindings = [];
      for (const suffix of ['a', 'b']) {
        const result = { ...identity(1, suffix, `aggregate-${suffix}`), ownerId };
        const accepted = await compareAndSetGlassHiveTerminalCallbackResult({
          ResultModel: GlassHiveTerminalCallbackResult,
          incoming: result,
        });
        const persisted = await GlassHiveTerminalCallbackResult.findOne({
          ownerId,
          originRef: result.originRef,
          runId: result.runId,
        }).lean();
        const binding = {
          originRef: result.originRef,
          workRef: result.workRef,
          workerId: result.workerId,
          runId: result.runId,
          callbackRef: require('@librechat/api').canonicalizeGlassHiveCallbackRef(
            result.callbackId,
          ),
          attemptNumber: 1,
          resultKey: persisted._id,
          acceptedOperationId: accepted.acceptedOperationId,
          terminalCallbackId: result.callbackId,
          resultDigest: result.resultDigest,
          resultRevision: 1,
          effectGeneration: accepted.acceptedOperationGeneration,
        };
        bindings.push(binding);
        await mongoose.connection.collection(EXTERNAL_WORK_COLLECTION).insertOne({
          _id: binding.originRef,
          ownerId,
          workRef: binding.workRef,
          runId: binding.runId,
          terminalCallbackRunId: binding.runId,
          terminalCallbackId: binding.terminalCallbackId,
          terminalCallbackResultDigest: binding.resultDigest,
          terminalCallbackResultRevision: scenario === 'newer-child' && suffix === 'b' ? 2 : 1,
          terminalCallbackAcceptedOperationId: binding.acceptedOperationId,
          terminalCallbackEffectLeaseGeneration: binding.effectGeneration,
          followUpMessageId: 'aggregate-reply',
          deliveryState: 'enqueued',
          attentionPending: false,
        });
      }
      await Message.create({
        messageId: 'aggregate-reply',
        user: ownerId,
        conversationId: PRESENTATION_CONVERSATION_ID,
        sender: 'AI',
        isCreatedByUser: false,
        text: 'Both results delivered.',
      });
      const presentation = buildVoiceWorkerCompletionPresentation({
        ownerId,
        conversationId: PRESENTATION_CONVERSATION_ID,
        callSessionId: 'aggregate-call',
        responseMessageId: 'aggregate-reply',
        responseText: 'Both results delivered.',
        bindings,
      });
      await ViventiumGlassHiveCallbackDelivery.create({
        deliveryId: 'aggregate-delivery',
        deliveryKey: 'aggregate-delivery-key',
        callbackId: bindings[0].callbackRef,
        callbackMessageId: 'aggregate-reply',
        userId: ownerId,
        conversationId: PRESENTATION_CONVERSATION_ID,
        originRef: bindings[0].originRef,
        workRef: bindings[0].workRef,
        runId: bindings[0].runId,
        event: 'main.followup',
        presentationKind: 'main',
        surface: 'voice',
        status: 'sent',
        voiceCallSessionId: 'aggregate-call',
        voiceRequestId: presentation.turnId,
        text: 'Both results delivered.',
        workerCompletionPresentation: presentation,
        terminalCallbackResultKey: bindings[0].resultKey,
        terminalCallbackAcceptedOperationId: bindings[0].acceptedOperationId,
        terminalCallbackId: bindings[0].terminalCallbackId,
        terminalCallbackResultDigest: bindings[0].resultDigest,
        terminalCallbackResultRevision: 1,
        terminalCallbackEffectGeneration: bindings[0].effectGeneration,
        projectionAppliedAt: new Date(),
        projectionPendingAt: null,
        expiresAt: new Date(Date.now() + 60000),
      });
      const updateBefore = GlassHiveTerminalCallbackResult.updateOne.bind(
        GlassHiveTerminalCallbackResult,
      );
      const spy =
        scenario === 'member-fence-race'
          ? jest
              .spyOn(GlassHiveTerminalCallbackResult, 'updateOne')
              .mockImplementation((filter, ...args) =>
                filter._id === bindings[1].resultKey
                  ? { exec: async () => ({ matchedCount: 0 }) }
                  : updateBefore(filter, ...args),
              )
          : null;
      try {
        await reconcileGlassHiveSurfaceDeliveryProjections();
      } finally {
        spy?.mockRestore();
      }
      const works = await mongoose.connection
        .collection(EXTERNAL_WORK_COLLECTION)
        .find({ ownerId })
        .sort({ _id: 1 })
        .toArray();
      expect(works.map((row) => row.deliveryState)).toEqual(
        scenario === 'member-fence-race'
          ? ['enqueued', 'enqueued']
          : scenario === 'newer-child'
            ? ['sent', 'enqueued']
            : ['sent', 'sent'],
      );
      const delivery = await ViventiumGlassHiveCallbackDelivery.findOne({
        deliveryId: 'aggregate-delivery',
      }).lean();
      expect(Boolean(delivery.workerCompletionProjectionAppliedAt)).toBe(
        scenario !== 'member-fence-race',
      );
      expect(delivery.status).toBe('sent');
      expect(await Message.countDocuments({ user: ownerId })).toBe(1);
      expect(await ViventiumGlassHiveCallbackDelivery.countDocuments({ userId: ownerId })).toBe(1);
      if (scenario !== 'member-fence-race')
        expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({
          scanned: 0,
          projected: 0,
        });
    },
  );

  test.each(['current', 'superseded', 'wrong-owner'])(
    'native DB callback admission rereads after real write conflict (%s)',
    async (outcome) => {
      const result = identity(1, 'a', `native-admission-${outcome}`);
      const binding = await seedExternalWork(result, { claimed: true });
      const body = {
        worker_id: result.workerId,
        run_id: result.runId,
        event: 'run.needs_input',
        work_state: 'needs_input',
        work_terminal: false,
      };
      const collection = mongoose.connection.collection(EXTERNAL_WORK_COLLECTION);
      let attempts = 0;
      let committedEffects = 0;
      const seenRevisions = [];
      const operation = runGlassHiveTerminalCallbackTransaction(
        async (session) => {
          attempts += 1;
          const snapshot = await collection.findOne({ _id: result.originRef }, { session });
          seenRevisions.push(snapshot.syntheticRevision || 0);
          if (attempts === 1) {
            // A separate native collection write invalidates this transaction snapshot and
            // reproduces Mongo code112, as the real callback admission failure did.
            await collection.updateOne(
              { _id: result.originRef },
              {
                $set: {
                  syntheticRevision: 1,
                  ...(outcome === 'superseded' ? { terminalCallbackRunId: result.runId } : {}),
                  ...(outcome === 'wrong-owner' ? { ownerId: 'different-owner' } : {}),
                },
              },
            );
          }
          await fenceGlassHiveCallbackRunState({ binding, body, effectSession: session });
          await confirmGlassHiveCallbackContext({ binding, body, effectSession: session });
          deferGlassHiveTerminalCallbackAfterCommit(() => {
            committedEffects += 1;
          });
          return 'accepted';
        },
        { retry: 'native' },
      );
      if (outcome === 'current') {
        await expect(operation).resolves.toBe('accepted');
        expect(committedEffects).toBe(1);
        expect((await collection.findOne({ _id: result.originRef })).launchState).toBe(
          'callback_confirmed',
        );
      } else {
        await expect(operation).rejects.toMatchObject({
          code:
            outcome === 'superseded'
              ? 'glasshive_callback_notice_superseded'
              : 'glasshive_callback_run_binding_not_ready',
        });
        expect(committedEffects).toBe(0);
      }
      expect(attempts).toBe(2);
      expect(seenRevisions).toEqual([0, 1]);
    },
  );

  async function neutralEndedCallProof(scope, callStatus = 'ended') {
    const result = identity(1, 'a', scope, 'cancelled');
    const binding = await seedExternalWork(result, { claimed: true });
    const conversationId = PRESENTATION_CONVERSATION_ID;
    await mongoose.connection
      .collection(EXTERNAL_WORK_COLLECTION)
      .updateOne({ _id: result.originRef }, { $set: { conversationId, runId: result.runId } });
    const accepted = await compareAndSetGlassHiveTerminalCallbackResult({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: result,
    });
    const acquired = await acquireGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      incoming: result,
      acceptedOperationId: accepted.acceptedOperationId,
    });
    expect(acquired.status).toBe('acquired');
    const callSessionId = `call-${scope}`;
    await ViventiumCallSession.create({
      callSessionId,
      userId: result.ownerId,
      conversationId,
      agentId: 'agent-main',
      roomName: `room-${scope}`,
      mode: 'call',
      callStatus,
      expiresAt: new Date(Date.now() + 3600000),
    });
    const message = await Message.create({
      messageId: `neutral-${scope}`,
      user: result.ownerId,
      conversationId,
      parentMessageId: 'anchor',
      sender: 'AI',
      endpoint: 'agents',
      text: 'Mission stopped.',
      isCreatedByUser: false,
      metadata: {
        viventium: {
          type: 'glasshive_worker_callback',
          status: { kind: 'mission_status', state: 'cancelled' },
          originRef: result.originRef,
          workRef: result.workRef,
          workerId: result.workerId,
          runId: result.runId,
          callbackId: result.callbackId,
          voiceCallSessionId: callSessionId,
          configuredDestinations: [
            { surface: 'voice', resolved: true },
            { surface: 'librechat', resolved: true },
          ],
        },
      },
    });
    const body = callbackBody(result, { event: 'run.cancelled' });
    const context = {
      ...binding,
      conversationId,
      traceIdentity: {
        callbackRef: `callback_sha256:${require('crypto').createHash('sha256').update(result.callbackId).digest('hex')}`,
        attemptNumber: 1,
      },
      traceSurface: 'voice',
      traceCallbackEvent: 'run.cancelled',
      destinations: [
        { surface: 'voice', voiceCallSessionId: callSessionId },
        { surface: 'librechat' },
      ],
    };
    const enqueue = (overrides = {}) =>
      runGlassHiveTerminalCallbackTransaction(async (session) => {
        await fenceGlassHiveTerminalCallbackEffectTransaction({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease: acquired.lease,
          session,
        });
        return enqueueGlassHiveCallbackDelivery({
          body,
          message: message.toObject(),
          deliveryContext: context,
          effectFence: acquired.lease,
          effectSession: session,
          ...overrides,
        });
      });
    return { result, acquired, callSessionId, message, body, context, enqueue };
  }

  test('ended Call raw lifecycle status creates no chat or Voice presenter', async () => {
    const h = await neutralEndedCallProof('ended-neutral');
    await h.enqueue();
    await h.enqueue();
    const rows = await ViventiumGlassHiveCallbackDelivery.find({
      originRef: h.result.originRef,
    }).lean();
    expect(rows).toHaveLength(0);
    expect(
      await ViventiumVoiceTask.countDocuments({ conversationId: h.context.conversationId }),
    ).toBe(0);
  });

  test('reconciliation does not turn a raw lifecycle status into chat after Call End', async () => {
    const h = await neutralEndedCallProof('retained-neutral', 'working');
    await h.enqueue();
    await releaseGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease: h.acquired.lease,
    });
    await ViventiumCallSession.updateOne(
      { callSessionId: h.callSessionId },
      { $set: { callStatus: 'ended' } },
    );
    await ViventiumGlassHiveCallbackDelivery.updateMany(
      {},
      {
        $set: {
          projectionPendingAt: null,
          projectionAppliedAt: new Date(),
          projectionNextAttemptAt: null,
        },
      },
    );
    await reconcileGlassHiveSurfaceDeliveryProjections();
    await reconcileGlassHiveSurfaceDeliveryProjections();
    const rows = await ViventiumGlassHiveCallbackDelivery.find({
      originRef: h.result.originRef,
    }).lean();
    expect(rows).toHaveLength(0);
    expect(
      await ViventiumVoiceTask.countDocuments({ conversationId: h.context.conversationId }),
    ).toBe(0);
  });

  test.each([
    'active_call',
    'wrong_owner',
    'wrong_conversation',
    'missing_message',
    'claimed_voice',
    'superseded_callback',
    'main_followup',
  ])('raw lifecycle status stays nonconversational under %s', async (scenario) => {
    const h = await neutralEndedCallProof(`fence-${scenario}`, 'working');
    await h.enqueue();
    await releaseGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease: h.acquired.lease,
    });
    if (scenario !== 'active_call')
      await ViventiumCallSession.updateOne(
        { callSessionId: h.callSessionId },
        { $set: { callStatus: 'ended' } },
      );
    if (scenario === 'wrong_owner')
      await ViventiumCallSession.updateOne(
        { callSessionId: h.callSessionId },
        { $set: { userId: 'another-owner' } },
      );
    if (scenario === 'wrong_conversation')
      await ViventiumCallSession.updateOne(
        { callSessionId: h.callSessionId },
        { $set: { conversationId: 'another-conversation' } },
      );
    if (scenario === 'missing_message') await Message.deleteOne({ messageId: h.message.messageId });
    if (scenario === 'claimed_voice')
      await ViventiumGlassHiveCallbackDelivery.updateMany(
        {},
        { $set: { status: 'claimed', claimId: 'actual-claim', claimedAt: new Date() } },
      );
    if (scenario === 'superseded_callback')
      await compareAndSetGlassHiveTerminalCallbackResult({
        ResultModel: GlassHiveTerminalCallbackResult,
        incoming: identity(2, 'b', `fence-${scenario}`, 'completed'),
      });
    if (scenario === 'main_followup')
      await ViventiumGlassHiveCallbackDelivery.updateMany({}, { $set: { event: 'main.followup' } });
    await reconcileGlassHiveSurfaceDeliveryProjections();
    const rows = await ViventiumGlassHiveCallbackDelivery.find({
      originRef: h.result.originRef,
    }).lean();
    expect(rows).toHaveLength(0);
    expect(
      await ViventiumVoiceTask.countDocuments({ conversationId: h.context.conversationId }),
    ).toBe(0);
  });

  test('Main linked Web acquires current authority without a callback-route lease', async () => {
    const h = await neutralEndedCallProof('main-accepted', 'working');
    await releaseGlassHiveTerminalCallbackEffectLease({
      ResultModel: GlassHiveTerminalCallbackResult,
      lease: h.acquired.lease,
    });
    const run = () =>
      runGlassHiveTerminalCallbackTransaction(() =>
        enqueueGlassHiveCallbackDelivery({
          body: {
            ...h.body,
            callback_id: h.context.traceIdentity.callbackRef,
            event: 'main.followup',
          },
          message: h.message.toObject(),
          deliveryContext: { ...h.context, destinations: [{ surface: 'librechat' }] },
        }),
      );
    await expect(run()).resolves.toMatchObject({ linkedWebCommitted: true });
    await expect(run()).resolves.toMatchObject({ linkedWebCommitted: true });
    expect(
      await ViventiumGlassHiveCallbackDelivery.countDocuments({ originRef: h.result.originRef }),
    ).toBe(1);
  });

  test('Main linked Web requires an actual Message and leaves an unresolved external destination intact', async () => {
    const h = await neutralEndedCallProof('main-local', 'working');
    const context = { ...h.context, destinations: [{ surface: 'librechat' }] };
    const body = { ...h.body, event: 'main.followup' };
    const summary = await h.enqueue({ body, deliveryContext: context });
    expect(summary).toMatchObject({ configured: 0, linkedWebCommitted: true });
    await expect(
      h.enqueue({
        body,
        deliveryContext: context,
        message: { messageId: 'not-saved', text: h.message.text },
      }),
    ).rejects.toThrow('glasshive_linked_presentation_message_unavailable');
    const externalOrigin = await neutralEndedCallProof('main-external', 'working');
    const external = await externalOrigin.enqueue({
      body: { ...externalOrigin.body, event: 'main.followup' },
      deliveryContext: {
        ...externalOrigin.context,
        destinations: [
          { surface: 'librechat' },
          { surface: 'telegram', unresolvedReason: 'mapping_missing' },
        ],
      },
    });
    expect(external).toMatchObject({ configured: 1, unresolved: 1 });
    expect(external.linkedWebCommitted).toBeUndefined();
    expect(
      await ViventiumGlassHiveCallbackDelivery.findOne({
        originRef: externalOrigin.result.originRef,
      }).lean(),
    ).toMatchObject({
      status: 'unresolved',
      projectionPendingAt: null,
      projectionAppliedAt: expect.any(Date),
    });
    expect(
      await mongoose.connection
        .collection(EXTERNAL_WORK_COLLECTION)
        .findOne({ _id: externalOrigin.result.originRef }),
    ).toMatchObject({ deliveryState: 'unresolved' });
  });

  test('authored Message and evidence survive a later surface rollback and more than ten delivery failures', async () => {
    const h = await authoredDeliveryProof('authored-commit');
    const flush = () => h.service.flushGlassHiveMissionAdjudications({ ownerId: h.result.ownerId });
    try {
      await expect(flush()).resolves.toMatchObject({ failed: 1 });
      const committed = await Message.findOne({
        user: h.result.ownerId,
        messageId: h.authoredId,
      }).lean();
      expect(committed).toMatchObject({ text: h.preparedText, conversationId: h.conversationId });
      let evidence = await h.collection.findOne({ _id: h.evidence._id });
      expect(evidence).toMatchObject({
        state: 'delivery_pending',
        followUpMessageId: h.authoredId,
        followUpText: h.preparedText,
        authoredAt: expect.any(Date),
      });
      expect(await h.receipts.countDocuments({})).toBe(0);
      for (let attempt = 2; attempt <= 11; attempt += 1) {
        await h.due();
        await expect(flush()).resolves.toMatchObject({ failed: 1 });
      }
      evidence = await h.collection.findOne({ _id: h.evidence._id });
      expect(evidence).toMatchObject({
        state: 'delivery_pending',
        attempts: 11,
        followUpMessageId: h.authoredId,
      });
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(h.persist).toHaveBeenCalledTimes(1);
      expect(
        await Message.countDocuments({ user: h.result.ownerId, messageId: h.authoredId }),
      ).toBe(1);
      h.allowDelivery();
      await h.due();
      await expect(flush()).resolves.toMatchObject({ visible: 1, failed: 0 });
      expect(await h.collection.findOne({ _id: h.evidence._id })).toMatchObject({
        state: 'completed',
        attempts: 12,
      });
      expect(await h.receipts.countDocuments({ deliveryRef: `main-web:${h.authoredId}` })).toBe(1);
      await h.service.reconcilePendingGlassHiveMissionAdjudications();
      h.service.clearAdjudicationTimersForTests();
      await flush();
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(h.delivery).toHaveBeenCalledTimes(12);
    } finally {
      h.service.clearAdjudicationTimersForTests();
    }
  });

  test('due delivery retry reconciles through the real pending claim lane without duplicate publication', async () => {
    const h = await authoredDeliveryProof('due-reconcile-lane');
    let releaseClaim;
    let claim;
    try {
      await expect(
        h.service.flushGlassHiveMissionAdjudications({
          ownerId: h.result.ownerId,
        }),
      ).resolves.toMatchObject({ failed: 1 });
      expect(await h.collection.findOne({ _id: h.evidence._id })).toMatchObject({
        state: 'delivery_pending',
        attempts: 1,
        followUpMessageId: h.authoredId,
      });
      await h.collection.updateOne(
        { _id: h.evidence._id },
        {
          $set: { nextAttemptAt: new Date(0), updatedAt: new Date(0) },
        },
      );
      const blocked = new Promise((resolve) => {
        releaseClaim = resolve;
      });
      let enteredClaim;
      const pendingClaim = new Promise((resolve) => {
        enteredClaim = resolve;
      });
      const originalClaim = h.collection.findOneAndUpdate.bind(h.collection);
      claim = jest.spyOn(h.collection, 'findOneAndUpdate').mockImplementation(async (...args) => {
        const [filter, , options] = args;
        if (filter._id === h.evidence._id && filter.state === 'pending') {
          const pending = await h.collection.findOne(
            { _id: filter._id },
            { session: options.session },
          );
          enteredClaim(pending);
          await blocked;
        }
        return originalClaim(...args);
      });
      let delivered;
      const committed = new Promise((resolve) => {
        delivered = resolve;
      });
      const originalDelivery = h.delivery.getMockImplementation();
      h.delivery.mockImplementation(async (...args) => {
        const result = await originalDelivery(...args);
        expect(deferGlassHiveTerminalCallbackAfterCommit(delivered)).toBe(true);
        return result;
      });
      h.allowDelivery();
      await expect(h.service.reconcilePendingGlassHiveMissionAdjudications()).resolves.toEqual({
        rows: 1,
        owners: 1,
      });
      await expect(pendingClaim).resolves.toMatchObject({ state: 'pending', attempts: 1 });
      await expect(h.service.reconcilePendingGlassHiveMissionAdjudications()).resolves.toEqual({
        rows: 1,
        owners: 1,
      });
      expect(claim).toHaveBeenCalledTimes(1);
      releaseClaim();
      await committed;
      expect(await h.collection.findOne({ _id: h.evidence._id })).toMatchObject({
        state: 'completed',
        attempts: 2,
        followUpMessageId: h.authoredId,
      });
      await expect(h.service.reconcilePendingGlassHiveMissionAdjudications()).resolves.toEqual({
        rows: 0,
        owners: 0,
      });
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(h.persist).toHaveBeenCalledTimes(1);
      expect(h.delivery).toHaveBeenCalledTimes(2);
      expect(claim).toHaveBeenCalledTimes(1);
      expect(
        await Message.countDocuments({ user: h.result.ownerId, messageId: h.authoredId }),
      ).toBe(1);
      expect(await h.receipts.countDocuments({ deliveryRef: `main-web:${h.authoredId}` })).toBe(1);
    } finally {
      releaseClaim?.();
      claim?.mockRestore();
      h.service.clearAdjudicationTimersForTests();
    }
  }, 15000);

  test.each(['trace', 'after_enqueue'])(
    'a two-row Main delivery retries real Mongo conflict without resynthesis or lost presentation rows (%s)',
    async (phase) => {
      const conflicts = mongoose.connection.collection('test_delivery_conflict');
      await conflicts.insertOne({ _id: 'delivery-conflict', revision: 0 });
      let injected = false;
      const firstErrors = [];
      let committedWakes = 0;
      const conflictOperation = async (session) => {
        if (injected) return;
        injected = true;
        await conflicts.findOne({ _id: 'delivery-conflict' }, { session });
        await conflicts.updateOne({ _id: 'delivery-conflict' }, { $inc: { revision: 1 } });
        try {
          await conflicts.updateOne(
            { _id: 'delivery-conflict' },
            { $inc: { revision: 1 } },
            { session },
          );
        } catch (error) {
          firstErrors.push({ code: error.code, labels: [...error.errorLabels] });
          throw error;
        }
      };
      const h = await authoredDeliveryProof('delivery-native-conflict', {
        rowCount: 2,
        traceOperation:
          phase === 'trace' ? (_receipt, session) => conflictOperation(session) : undefined,
        outcomeOperation: phase === 'after_enqueue' ? conflictOperation : undefined,
      });
      h.delivery.mockImplementation(async () => {
        deferGlassHiveTerminalCallbackAfterCommit(() => {
          committedWakes += 1;
        });
        return { configured: 1, enqueued: 1 };
      });
      try {
        const summary = await h.service.flushGlassHiveMissionAdjudications({
          ownerId: h.result.ownerId,
        });
        const observed = await h.collection.find({ ownerId: h.result.ownerId }).toArray();
        expect({
          summary,
          firstErrors,
          warningStages: h.logger.warn.mock.calls.map((call) => call[1]),
          errorCodes: observed.map((row) => row.errorCode),
        }).toEqual({
          summary: { claimed: 2, groups: 1, visible: 2, silent: 0, failed: 0 },
          firstErrors: [{ code: 112, labels: ['TransientTransactionError'] }],
          warningStages: [],
          errorCodes: ['', ''],
        });
        expect(h.prepare).toHaveBeenCalledTimes(1);
        expect(h.persist).toHaveBeenCalledTimes(1);
        expect(
          await Message.countDocuments({ user: h.result.ownerId, messageId: h.authoredId }),
        ).toBe(1);
        const rows = await h.collection.find({ ownerId: h.result.ownerId }).toArray();
        expect(rows).toHaveLength(2);
        for (const row of rows)
          expect(row).toMatchObject({
            state: 'completed',
            followUpMessageId: h.authoredId,
            webPresentationMessageId: h.authoredId,
            webPresentedAt: expect.any(Date),
          });
        expect(await h.receipts.countDocuments({ deliveryRef: `main-web:${h.authoredId}` })).toBe(
          2,
        );
        expect(committedWakes).toBe(1);
      } finally {
        h.service.clearAdjudicationTimersForTests();
      }
    },
  );

  test.each(['superseded', 'nontransient'])(
    'Main delivery retains its committed answer without publishing an invalid projection (%s)',
    async (outcome) => {
      let checked = false;
      let committedWakes = 0;
      let h;
      h = await authoredDeliveryProof(`delivery-native-${outcome}`, {
        rowCount: 2,
        traceOperation: async () => {
          if (checked) return;
          checked = true;
          if (outcome === 'nontransient')
            throw Object.assign(new Error('fixed_projection_failure'), {
              code: 'fixed_projection_failure',
            });
          const replacement = {
            ...h.result,
            resultRevision: 2,
            callbackId: `cb_terminal_${'c'.repeat(64)}`,
            resultDigest: `sha256:${'c'.repeat(64)}`,
          };
          const accepted = await compareAndSetGlassHiveTerminalCallbackResult({
            ResultModel: GlassHiveTerminalCallbackResult,
            incoming: replacement,
          });
          expect(accepted.status).toBe('accepted');
        },
      });
      // The accepted result lease must be released before a legitimate replacement can win.
      if (outcome === 'superseded')
        await releaseGlassHiveTerminalCallbackEffectLease({
          ResultModel: GlassHiveTerminalCallbackResult,
          lease: h.lease,
        });
      h.delivery.mockImplementation(async () => {
        deferGlassHiveTerminalCallbackAfterCommit(() => {
          committedWakes += 1;
        });
        return { configured: 1, enqueued: 1 };
      });
      try {
        const summary = await h.service.flushGlassHiveMissionAdjudications({
          ownerId: h.result.ownerId,
        });
        expect(summary.visible).toBe(0);
        expect(h.prepare).toHaveBeenCalledTimes(1);
        expect(h.persist).toHaveBeenCalledTimes(1);
        expect(
          await Message.countDocuments({ user: h.result.ownerId, messageId: h.authoredId }),
        ).toBe(1);
        expect(await h.receipts.countDocuments({})).toBe(0);
        expect(committedWakes).toBe(0);
        const rows = await h.collection.find({ ownerId: h.result.ownerId }).toArray();
        for (const row of rows)
          expect(row.state).toBe(outcome === 'superseded' ? 'superseded' : 'delivery_pending');
        if (outcome === 'nontransient') {
          expect(h.logger.warn).toHaveBeenCalledTimes(1);
          expect(h.logger.warn.mock.calls[0][0]).toContain(
            '{"stage":"record_web_presentation","code":"fixed_projection_failure"}',
          );
          expect(h.delivery).not.toHaveBeenCalled();
        }
      } finally {
        h.service.clearAdjudicationTimersForTests();
      }
    },
  );

  test('a two-row Main no-response decision stays silent through the shared transaction', async () => {
    const h = await authoredDeliveryProof('delivery-silent', { rowCount: 2 });
    h.prepare.mockResolvedValue({
      followUpDecisionRecord: {
        generationFailed: false,
        forceVisibleFollowUp: false,
        llmResult: 'nta',
        selectedStrategy: 'no_response_suppressed',
      },
    });
    h.persist.mockResolvedValue(null);
    try {
      await expect(
        h.service.flushGlassHiveMissionAdjudications({ ownerId: h.result.ownerId }),
      ).resolves.toMatchObject({ claimed: 2, silent: 2, visible: 0, failed: 0 });
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(await Message.countDocuments({ user: h.result.ownerId, isCreatedByUser: false })).toBe(
        0,
      );
      expect(await h.receipts.countDocuments({})).toBe(0);
      expect(h.delivery).not.toHaveBeenCalled();
      const rows = await h.collection.find({ ownerId: h.result.ownerId }).toArray();
      for (const row of rows) expect(row).toMatchObject({ state: 'silent', errorCode: '' });
    } finally {
      h.service.clearAdjudicationTimersForTests();
    }
  });

  test('an authored return value without a real Message commit cannot publish a delivery receipt', async () => {
    const h = await authoredDeliveryProof('missing-message-commit');
    try {
      h.persist.mockResolvedValueOnce({ messageId: 'never-saved-message', text: h.preparedText });
      h.allowDelivery();
      await expect(
        h.service.flushGlassHiveMissionAdjudications({ ownerId: h.result.ownerId }),
      ).resolves.toMatchObject({ failed: 1, visible: 0 });
      expect(await Message.countDocuments({ user: h.result.ownerId, isCreatedByUser: false })).toBe(
        0,
      );
      expect(await h.receipts.countDocuments({})).toBe(0);
      expect(h.delivery).not.toHaveBeenCalled();
      const evidence = await h.collection.findOne({ _id: h.evidence._id });
      expect(evidence.followUpMessageId || '').toBe('');
      expect(evidence.authoredAt).toBeUndefined();
    } finally {
      h.service.clearAdjudicationTimersForTests();
    }
  });

  test('a transient committed Message read preserves the durable pointer for retry', async () => {
    const h = await authoredDeliveryProof('committed-read-outage');
    let read;
    try {
      await expect(
        h.service.flushGlassHiveMissionAdjudications({ ownerId: h.result.ownerId }),
      ).resolves.toMatchObject({ failed: 1 });
      await h.due();
      read = jest
        .spyOn(mongoose.connection.collection('messages'), 'findOne')
        .mockRejectedValueOnce(new Error('synthetic_message_read_outage'));
      await expect(
        h.service.flushGlassHiveMissionAdjudications({ ownerId: h.result.ownerId }),
      ).resolves.toMatchObject({ failed: 1 });
      expect(read).toHaveBeenCalled();
      read.mockRestore();
      read = null;
      const evidence = await h.collection.findOne({ _id: h.evidence._id });
      expect(evidence).toMatchObject({
        followUpMessageId: h.authoredId,
        followUpText: h.preparedText,
        authoredAt: expect.any(Date),
      });
      expect(await Message.findOne({ messageId: h.authoredId }).lean()).toMatchObject({
        text: h.preparedText,
      });
      expect(h.prepare).toHaveBeenCalledTimes(1);
      h.allowDelivery();
      await h.due();
      await expect(
        h.service.flushGlassHiveMissionAdjudications({ ownerId: h.result.ownerId }),
      ).resolves.toMatchObject({ visible: 1, failed: 0 });
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(h.persist).toHaveBeenCalledTimes(1);
    } finally {
      read?.mockRestore();
      h.service.clearAdjudicationTimersForTests();
    }
  });

  test('a real rolled-back Message and dangling catch pointer are not presentation proof', async () => {
    const h = await authoredDeliveryProof('dangling-rollback');
    const danglingId = 'rolled-back-message';
    try {
      await expect(
        runGlassHiveTerminalCallbackTransaction(async (session) => {
          await h.writeAuthored(danglingId);
          await h.collection.updateOne(
            { _id: h.evidence._id },
            {
              $set: {
                followUpMessageId: danglingId,
                followUpText: h.preparedText,
                authoredAt: new Date(),
              },
            },
            { session },
          );
          throw new Error('surface_enqueue_failed_after_message');
        }),
      ).rejects.toThrow('surface_enqueue_failed_after_message');
      expect(await Message.findOne({ messageId: danglingId }).lean()).toBeNull();
      expect(await h.collection.findOne({ _id: h.evidence._id })).not.toHaveProperty('authoredAt');
      // Reproduce the former catch write, which survived the failed transaction without its text.
      await h.collection.updateOne(
        { _id: h.evidence._id },
        {
          $set: {
            followUpMessageId: danglingId,
            state: 'deadletter',
            attempts: 10,
            errorCode: 'mission_adjudication_retry_exhausted',
            updatedAt: new Date(0),
          },
        },
      );
      h.allowDelivery();
      await h.due();
      await expect(
        h.service.flushGlassHiveMissionAdjudications({ ownerId: h.result.ownerId }),
      ).resolves.toMatchObject({ visible: 1, failed: 0 });
      expect(h.prepare).toHaveBeenCalledTimes(1);
      expect(h.persist).toHaveBeenCalledTimes(1);
      expect(await Message.findOne({ messageId: danglingId }).lean()).toBeNull();
      expect(await Message.findOne({ messageId: h.authoredId }).lean()).toMatchObject({
        user: h.result.ownerId,
        text: h.preparedText,
      });
      expect(await h.receipts.countDocuments({ deliveryRef: `main-web:${danglingId}` })).toBe(0);
      expect(await h.collection.findOne({ _id: h.evidence._id })).toMatchObject({
        state: 'completed',
        followUpMessageId: h.authoredId,
        followUpText: h.preparedText,
      });
    } finally {
      h.service.clearAdjudicationTimersForTests();
    }
  });

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
      error: expect.objectContaining({
        code: 'generation_failed',
        message: 'The task failed. Please try again.',
      }),
    });
    await expect(ViventiumVoiceTask.findOne({ taskId: task.taskId }).lean()).resolves.toMatchObject(
      {
        payload: expect.objectContaining({
          state: 'failed',
          retryable: true,
          current: expect.objectContaining({
            error: expect.objectContaining({
              code: 'generation_failed',
              message: 'The task failed. Please try again.',
            }),
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
