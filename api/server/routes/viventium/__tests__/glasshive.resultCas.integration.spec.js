/* === VIVENTIUM START ===
 * Feature: Durable GlassHive terminal-result receiver CAS integration proof.
 * === VIVENTIUM END === */

const crypto = require('crypto');
const express = require('express');
const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const CALLBACK_RESULTS_COLLECTION = 'viventium_glasshive_callback_results';
const CALLBACK_BINDINGS_COLLECTION = 'viventium_glasshive_callback_bindings';
const EXTERNAL_WORK_COLLECTION = 'viventium_external_work';
const GATE_TIMEOUT_MS = 5000;
const REQUEST_DEADLINE_MS = 10000;
const REQUEST_RESPONSE_TIMEOUT_MS = 5000;

let mockGetConvo;
let mockGetMessages;
let mockSaveMessage;
let mockUpdateMessage;
let mockResolveGlassHiveCallbackContext;
let mockConfirmGlassHiveCallbackContext;
let mockRecordGlassHiveCallbackExternalState;
let mockNotifySchedulerExternalWorkSummary;
let mockEnqueueGlassHiveMissionAdjudication;
let mockRecordGlassHiveSurfaceDeliveryOutcome;
let mockEnqueueGlassHiveCallbackDelivery;
let mockConversationFindOneAndUpdate;
let mockMessages;
let mockAfterTerminalCas;
let mockGetCallSession;
let mockGetVoiceTaskByStreamId;
let mockCreateVoiceTask;
let mockCompleteVoiceTask;
let mockRegisterGlassHiveVoiceTaskActionCapabilities;
let realConfirmGlassHiveCallbackContext;

jest.mock('@librechat/api', () => {
  const actual = jest.requireActual('@librechat/api');
  return {
    ...actual,
    receiveGlassHiveTerminalCallbackResult: async (...args) => {
      const result = await actual.receiveGlassHiveTerminalCallbackResult(...args);
      await mockAfterTerminalCas(args[0]?.body, result);
      return result;
    },
  };
});

jest.mock('~/db/models', () => ({
  ...jest.requireActual('~/db/models'),
  Conversation: {
    findOneAndUpdate: (...args) => mockConversationFindOneAndUpdate(...args),
  },
  Message: { deleteOne: jest.fn().mockResolvedValue({ deletedCount: 0 }) },
}));

jest.mock('~/models', () => ({
  getConvo: (...args) => mockGetConvo(...args),
  getMessages: (...args) => mockGetMessages(...args),
  saveMessage: (...args) => mockSaveMessage(...args),
  updateMessage: (...args) => mockUpdateMessage(...args),
  deleteMessages: jest.fn().mockResolvedValue({ deletedCount: 0 }),
}));

jest.mock('~/server/services/viventium/GlassHiveCallbackDeliveryService', () => ({
  enqueueGlassHiveCallbackDelivery: (...args) => mockEnqueueGlassHiveCallbackDelivery(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveCallbackBindingService', () => {
  const actual = jest.requireActual('~/server/services/viventium/GlassHiveCallbackBindingService');
  return {
    ...actual,
    resolveGlassHiveCallbackContext: (...args) => mockResolveGlassHiveCallbackContext(...args),
    confirmGlassHiveCallbackContext: (...args) => mockConfirmGlassHiveCallbackContext(...args),
    recordGlassHiveCallbackExternalState: (...args) =>
      mockRecordGlassHiveCallbackExternalState(...args),
    notifySchedulerExternalWorkSummary: (...args) =>
      mockNotifySchedulerExternalWorkSummary(...args),
    recordGlassHiveSurfaceDeliveryOutcome: (...args) =>
      mockRecordGlassHiveSurfaceDeliveryOutcome(...args),
  };
});

jest.mock('~/server/services/viventium/GlassHiveMissionAdjudicationService', () => ({
  enqueueGlassHiveMissionAdjudication: (...args) =>
    mockEnqueueGlassHiveMissionAdjudication(...args),
}));

jest.mock('~/server/services/viventium/OrchestrationTraceLedgerService', () => ({
  recordOrchestrationTraceAcceptedLaunch: jest.fn().mockResolvedValue(null),
  recordOrchestrationTraceCallback: jest.fn().mockResolvedValue([]),
  recordOrchestrationTraceFailedLaunch: jest.fn().mockResolvedValue(null),
  recordOrchestrationTraceLaunch: jest.fn().mockResolvedValue([]),
  recordGlassHiveWorkDetailTrace: jest.fn().mockResolvedValue(null),
}));

jest.mock('~/server/services/viventium/CallSessionService', () => ({
  claimOrReplaceCallSessionConversationId: jest.fn(),
  getCallSession: (...args) => mockGetCallSession(...args),
}));

jest.mock('~/server/services/viventium/GlassHiveVoiceTaskActionService', () => ({
  registerGlassHiveVoiceTaskActionCapabilities: (...args) =>
    mockRegisterGlassHiveVoiceTaskActionCapabilities(...args),
}));

jest.mock('~/server/services/viventium/VoiceTaskService', () => ({
  completeVoiceTask: (...args) => mockCompleteVoiceTask(...args),
  confirmVoiceTaskOwnerCancellation: jest.fn(),
  createVoiceTask: (...args) => mockCreateVoiceTask(...args),
  failVoiceTask: jest.fn(),
  getVoiceTaskByStreamId: (...args) => mockGetVoiceTaskByStreamId(...args),
  hydrateVoiceTasksForCall: jest.fn(),
  hydrateVoiceTaskByStreamId: jest.fn(),
  isVoiceTaskSuppressedDurably: jest.fn().mockResolvedValue(false),
  observeGenerationEvent: jest.fn(),
  runVoiceTaskTerminalCallbackMutation: (_taskId, operation) => operation(),
  setVoiceTaskOwnerCapabilities: jest.fn(),
}));

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function signature(body, secret = 'callback-secret') {
  const binding = `${String(body.worker_id || '').trim()}:${String(body.run_id || '').trim()}`;
  const perRunSecret = crypto.createHmac('sha256', secret).update(binding).digest('hex');
  return `sha256=${crypto
    .createHmac('sha256', perRunSecret)
    .update(Buffer.from(stableStringify(body), 'utf8'))
    .digest('hex')}`;
}

function terminalCallbackId(body) {
  const material = [
    body.run_id,
    body.result_state,
    body.result_ended_at,
    body.attempt_number,
    body.result_revision,
    body.result_digest,
  ].join(':');
  return `cb_terminal_${crypto.createHash('sha256').update(material).digest('hex')}`;
}

function terminalBody(revision, digestCharacter, message, overrides = {}) {
  const body = {
    callback_ts: Math.floor(Date.now() / 1000),
    origin_ref: 'ghi_receiver_cas_origin',
    work_ref: 'gh_receiver_cas_work',
    event: 'run.completed',
    work_state: 'completed',
    work_terminal: true,
    message,
    user_id: 'untrusted-owner-value',
    agent_id: 'agent-main',
    conversation_id: 'untrusted-conversation-value',
    parent_message_id: 'untrusted-parent-value',
    message_id: 'untrusted-anchor-value',
    worker_id: 'wrk_receiver_cas',
    run_id: 'run_receiver_cas',
    attempt_number: 1,
    result_state: 'completed',
    result_ended_at: '2026-08-23T18:00:00+00:00',
    result_revision: revision,
    result_digest: `sha256:${digestCharacter.repeat(64)}`,
    surface: 'api',
    ...overrides,
  };
  body.callback_id = terminalCallbackId(body);
  return body;
}

function callbackHeaders(body) {
  return {
    'x-glasshive-signature': signature(body),
    'x-glasshive-callback-id': body.callback_id,
    'x-glasshive-result-revision': String(body.result_revision),
    'x-glasshive-result-digest': body.result_digest,
  };
}

function receiptFor(body, callbackStatus, current) {
  return {
    callback_status: callbackStatus,
    callback_id: body.callback_id,
    run_id: body.run_id,
    result_revision: body.result_revision,
    result_digest: body.result_digest,
    current_callback_id: current.callback_id,
    current_result_revision: current.result_revision,
    current_result_digest: current.result_digest,
  };
}

function trustedContext() {
  return {
    bindingId: 'ghcb-receiver-cas',
    originRef: 'ghi_receiver_cas_origin',
    workRef: 'gh_receiver_cas_work',
    ownerId: 'owner-receiver-cas',
    conversationId: 'conv-receiver-cas',
    anchorMessageId: 'anchor-receiver-cas',
    requestedParentMessageId: 'parent-receiver-cas',
    destinations: [{ surface: 'librechat' }],
  };
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`${label}_timeout`)), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

function callbackRequest(app, body, headers = callbackHeaders(body)) {
  return request(app)
    .post('/api/viventium/glasshive/callback')
    .set(headers)
    .send(body)
    .timeout({ response: REQUEST_RESPONSE_TIMEOUT_MS, deadline: REQUEST_DEADLINE_MS });
}

describe('GlassHive callback terminal-result receiver CAS integration', () => {
  let mongoServer;
  let app;
  let releasePendingGate;
  const originalCallbackSecret = process.env.VIVENTIUM_GLASSHIVE_CALLBACK_SECRET;

  beforeAll(async () => {
    mongoServer = await MongoMemoryReplSet.create({
      replSet: { count: 1 },
      instanceOpts: [{ args: ['--setParameter', 'maxTransactionLockRequestTimeoutMillis=1000'] }],
    });
    await mongoose.connect(mongoServer.getUri());
    await mongoose.connection.createCollection(CALLBACK_RESULTS_COLLECTION).catch((error) => {
      if (Number(error?.code) !== 48) throw error;
    });
    await jest.requireActual('~/db/models').GlassHiveTerminalCallbackResult.syncIndexes();
    process.env.VIVENTIUM_GLASSHIVE_CALLBACK_SECRET = 'callback-secret';
    realConfirmGlassHiveCallbackContext = jest.requireActual(
      '~/server/services/viventium/GlassHiveCallbackBindingService',
    ).confirmGlassHiveCallbackContext;

    const router = require('../glasshive');
    app = express();
    app.use(express.json());
    app.use('/api/viventium/glasshive', router);
  }, 30000);

  beforeEach(async () => {
    releasePendingGate = null;
    mockAfterTerminalCas = jest.fn().mockResolvedValue(undefined);
    await mongoose.connection.db.collection(CALLBACK_RESULTS_COLLECTION).deleteMany({});
    await mongoose.connection.db.collection(CALLBACK_BINDINGS_COLLECTION).deleteMany({});
    await mongoose.connection.db.collection(EXTERNAL_WORK_COLLECTION).deleteMany({});
    mockGetConvo = jest.fn().mockResolvedValue({
      conversationId: 'conv-receiver-cas',
      user: 'owner-receiver-cas',
    });
    mockMessages = [
      {
        messageId: 'parent-receiver-cas',
        parentMessageId: 'prior-assistant',
        text: 'Synthetic request.',
        isCreatedByUser: true,
        createdAt: '2026-08-23T17:59:58.000Z',
      },
      {
        messageId: 'anchor-receiver-cas',
        parentMessageId: 'parent-receiver-cas',
        text: 'On it.',
        isCreatedByUser: false,
        createdAt: '2026-08-23T17:59:59.000Z',
      },
    ];
    mockGetMessages = jest.fn().mockImplementation(async () => mockMessages);
    mockSaveMessage = jest.fn().mockImplementation(async (_request, message) => {
      mockMessages.push(message);
      return message;
    });
    mockUpdateMessage = jest.fn().mockResolvedValue({});
    mockResolveGlassHiveCallbackContext = jest.fn().mockResolvedValue(trustedContext());
    mockRecordGlassHiveCallbackExternalState = jest.fn().mockResolvedValue({ state: 'completed' });
    mockConfirmGlassHiveCallbackContext = jest.fn().mockResolvedValue({});
    mockNotifySchedulerExternalWorkSummary = jest.fn().mockResolvedValue(null);
    mockEnqueueGlassHiveMissionAdjudication = jest.fn().mockResolvedValue(null);
    mockRecordGlassHiveSurfaceDeliveryOutcome = jest.fn().mockResolvedValue(null);
    mockEnqueueGlassHiveCallbackDelivery = jest.fn().mockResolvedValue(null);
    mockConversationFindOneAndUpdate = jest.fn().mockResolvedValue({});
    mockGetCallSession = jest.fn().mockResolvedValue(null);
    mockGetVoiceTaskByStreamId = jest.fn().mockReturnValue(null);
    mockCreateVoiceTask = jest.fn().mockReturnValue(null);
    mockCompleteVoiceTask = jest.fn().mockResolvedValue(null);
    mockRegisterGlassHiveVoiceTaskActionCapabilities = jest.fn();
  }, 10000);

  afterEach(() => {
    releasePendingGate?.();
    releasePendingGate = null;
  });

  afterAll(async () => {
    releasePendingGate?.();
    if (mongoose.connection.readyState !== 0) {
      await mongoose.connection.close(true);
    }
    if (mongoServer) {
      await mongoServer.stop({ doCleanup: true, force: true });
    }
    if (originalCallbackSecret == null) {
      delete process.env.VIVENTIUM_GLASSHIVE_CALLBACK_SECRET;
    } else {
      process.env.VIVENTIUM_GLASSHIVE_CALLBACK_SECRET = originalCallbackSecret;
    }
  }, 15000);

  test('stops A before its first effect when B wins after A has accepted the real CAS', async () => {
    let releaseA;
    let markAEntered;
    const aBlocked = new Promise((resolve) => {
      releaseA = resolve;
      releasePendingGate = resolve;
    });
    const aEntered = new Promise((resolve) => {
      markAEntered = resolve;
    });
    mockAfterTerminalCas = jest.fn().mockImplementation(async (body, gate) => {
      if (body.result_revision === 1 && gate?.receipt?.callback_status === 'accepted') {
        markAEntered();
        await aBlocked;
      }
    });

    mockGetCallSession = jest.fn().mockResolvedValue({
      callSessionId: 'call-receiver-cas',
      userId: 'owner-receiver-cas',
      conversationId: 'conv-receiver-cas',
    });
    mockResolveGlassHiveCallbackContext = jest.fn().mockResolvedValue({
      ...trustedContext(),
      destinations: [
        {
          surface: 'voice',
          voiceCallSessionId: 'call-receiver-cas',
          voiceRequestId: 'voice-request-receiver-cas',
        },
      ],
    });
    mockCreateVoiceTask = jest.fn().mockReturnValue({
      taskId: 'voice-task-receiver-cas',
      callSessionId: 'call-receiver-cas',
      userId: 'owner-receiver-cas',
      conversationId: 'conv-receiver-cas',
    });
    mockGetVoiceTaskByStreamId = jest.fn().mockReturnValue({
      taskId: 'voice-task-receiver-cas',
      callSessionId: 'call-receiver-cas',
      userId: 'owner-receiver-cas',
      conversationId: 'conv-receiver-cas',
      owner: { kind: 'glasshive_run', id: 'run-receiver-cas' },
    });
    const voiceScope = {
      surface: 'voice',
      voice_call_session_id: 'call-receiver-cas',
      voice_request_id: 'voice-request-receiver-cas',
    };
    const resultA = terminalBody(1, 'a', 'Result A must lose.', voiceScope);
    const resultB = terminalBody(2, 'b', 'Result B is canonical.', voiceScope);
    const aResponse = callbackRequest(app, resultA).then((response) => response);
    let bResponse;
    let staleAResponse;
    try {
      await withTimeout(aEntered, GATE_TIMEOUT_MS, 'result_a_entry_gate');
      bResponse = await callbackRequest(app, resultB);
    } finally {
      releaseA();
      releasePendingGate = null;
      staleAResponse = await withTimeout(aResponse, REQUEST_DEADLINE_MS, 'result_a_response');
    }

    expect(bResponse.status).toBe(200);
    expect(bResponse.body).toEqual(
      expect.objectContaining(receiptFor(resultB, 'accepted', resultB)),
    );
    expect(staleAResponse.status).toBe(409);
    expect(staleAResponse.body).toEqual(receiptFor(resultA, 'superseded', resultB));

    const durableRows = await mongoose.connection.db
      .collection(CALLBACK_RESULTS_COLLECTION)
      .find({})
      .toArray();
    expect(durableRows).toHaveLength(1);
    expect(durableRows[0]).toMatchObject({
      ownerId: 'owner-receiver-cas',
      originRef: 'ghi_receiver_cas_origin',
      workRef: 'gh_receiver_cas_work',
      workerId: 'wrk_receiver_cas',
      runId: resultB.run_id,
      callbackId: resultB.callback_id,
      resultRevision: 2,
      resultDigest: resultB.result_digest,
    });
    expect(JSON.stringify(durableRows[0])).not.toContain(resultA.message);
    expect(JSON.stringify(durableRows[0])).not.toContain(resultB.message);

    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(mockUpdateMessage).not.toHaveBeenCalled();
    expect(mockSaveMessage.mock.calls[0][1].metadata.viventium.callbackId).toBe(
      resultB.callback_id,
    );
    expect(mockSaveMessage.mock.calls[0][1].metadata.viventium.callbackId).not.toBe(
      resultA.callback_id,
    );
    expect(mockEnqueueGlassHiveCallbackDelivery).toHaveBeenCalledTimes(1);
    expect(mockEnqueueGlassHiveCallbackDelivery.mock.calls[0][0].body.result_revision).toBe(2);
    expect(mockConfirmGlassHiveCallbackContext).toHaveBeenCalledTimes(1);
    expect(mockConfirmGlassHiveCallbackContext.mock.calls[0][0].body.result_revision).toBe(2);
    expect(mockRecordGlassHiveCallbackExternalState).toHaveBeenCalledTimes(1);
    expect(mockRecordGlassHiveCallbackExternalState.mock.calls[0][0].body.result_revision).toBe(2);
    expect(mockEnqueueGlassHiveMissionAdjudication).toHaveBeenCalledTimes(1);
    expect(mockEnqueueGlassHiveMissionAdjudication.mock.calls[0][0].body.result_revision).toBe(2);
    expect(mockRegisterGlassHiveVoiceTaskActionCapabilities).toHaveBeenCalledTimes(1);
    expect(
      mockRegisterGlassHiveVoiceTaskActionCapabilities.mock.calls[0][0].body.result_revision,
    ).toBe(2);
    expect(mockCompleteVoiceTask).toHaveBeenCalledTimes(1);
  }, 20000);

  test('fences A inside the real non-message durable effect after B wins an expired lease', async () => {
    const binding = trustedContext();
    await mongoose.connection.db.collection(CALLBACK_BINDINGS_COLLECTION).insertOne({
      _id: binding.originRef,
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      anchorMessageId: binding.anchorMessageId,
      requestedParentMessageId: binding.requestedParentMessageId,
      workRef: '',
      launchState: 'dispatch_ready',
    });
    await mongoose.connection.db.collection(EXTERNAL_WORK_COLLECTION).insertOne({
      _id: binding.originRef,
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      anchorMessageId: binding.anchorMessageId,
      workRef: '',
      launchState: 'dispatch_ready',
    });

    let releaseA;
    let markAEntered;
    const aBlocked = new Promise((resolve) => {
      releaseA = resolve;
      releasePendingGate = resolve;
    });
    const aEntered = new Promise((resolve) => {
      markAEntered = resolve;
    });
    const externalWorkCollection = mongoose.connection.collection(EXTERNAL_WORK_COLLECTION);
    const durableUpdateOne = externalWorkCollection.updateOne.bind(externalWorkCollection);
    const updateSpy = jest
      .spyOn(externalWorkCollection, 'updateOne')
      .mockImplementation(async (filter, update, options) => {
        if (update?.$set?.workerId === 'wrk_receiver_cas_a') {
          markAEntered();
          await aBlocked;
        }
        return durableUpdateOne(filter, update, options);
      });
    mockConfirmGlassHiveCallbackContext = jest.fn((input) =>
      realConfirmGlassHiveCallbackContext(input),
    );

    const resultA = terminalBody(1, 'a', 'Result A must leave no durable effect.', {
      worker_id: 'wrk_receiver_cas_a',
    });
    const resultB = terminalBody(2, 'b', 'Result B is canonical.', {
      worker_id: 'wrk_receiver_cas_b',
    });
    const aResponse = callbackRequest(app, resultA).then((response) => response);
    let bResponse;
    let staleAResponse;
    try {
      await withTimeout(aEntered, GATE_TIMEOUT_MS, 'result_a_durable_effect_gate');
      await mongoose.connection.db
        .collection(CALLBACK_RESULTS_COLLECTION)
        .updateOne({ runId: resultA.run_id }, { $set: { effectLeaseExpiresAt: new Date(0) } });
      bResponse = await callbackRequest(app, resultB);
    } finally {
      releaseA();
      releasePendingGate = null;
      staleAResponse = await withTimeout(aResponse, REQUEST_DEADLINE_MS, 'result_a_response');
      updateSpy.mockRestore();
    }

    expect(bResponse.status).toBe(200);
    expect(staleAResponse.status).toBe(409);
    expect(staleAResponse.body).toEqual(receiptFor(resultA, 'superseded', resultB));
    const durableEffect = await mongoose.connection.db
      .collection(EXTERNAL_WORK_COLLECTION)
      .findOne({ _id: binding.originRef });
    expect(durableEffect).toMatchObject({
      workerId: resultB.worker_id,
      terminalCallbackResultRevision: 2,
      terminalCallbackId: resultB.callback_id,
      terminalCallbackResultDigest: resultB.result_digest,
    });
    expect(JSON.stringify(durableEffect)).not.toContain(resultA.callback_id);
  }, 20000);

  test('aborts A durable effect when B wins the CAS but is paused before that destination', async () => {
    const binding = trustedContext();
    await mongoose.connection.db.collection(CALLBACK_BINDINGS_COLLECTION).insertOne({
      _id: binding.originRef,
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      anchorMessageId: binding.anchorMessageId,
      requestedParentMessageId: binding.requestedParentMessageId,
      workRef: '',
      launchState: 'dispatch_ready',
    });
    await mongoose.connection.db.collection(EXTERNAL_WORK_COLLECTION).insertOne({
      _id: binding.originRef,
      ownerId: binding.ownerId,
      conversationId: binding.conversationId,
      anchorMessageId: binding.anchorMessageId,
      workRef: '',
      launchState: 'dispatch_ready',
    });

    let releaseA;
    let markAEntered;
    const aBlocked = new Promise((resolve) => {
      releaseA = resolve;
      releasePendingGate = resolve;
    });
    const aEntered = new Promise((resolve) => {
      markAEntered = resolve;
    });
    let releaseB;
    let markBAccepted;
    const bBlocked = new Promise((resolve) => {
      releaseB = resolve;
    });
    const bAccepted = new Promise((resolve) => {
      markBAccepted = resolve;
    });
    mockAfterTerminalCas = jest.fn().mockImplementation(async (body, gate) => {
      if (body.result_revision === 2 && gate?.receipt?.callback_status === 'accepted') {
        markBAccepted();
        await bBlocked;
      }
    });

    const externalWorkCollection = mongoose.connection.collection(EXTERNAL_WORK_COLLECTION);
    const durableUpdateOne = externalWorkCollection.updateOne.bind(externalWorkCollection);
    const updateSpy = jest
      .spyOn(externalWorkCollection, 'updateOne')
      .mockImplementation(async (filter, update, options) => {
        if (update?.$set?.workerId === 'wrk_receiver_cas_a') {
          markAEntered();
          await aBlocked;
        }
        return durableUpdateOne(filter, update, options);
      });
    mockConfirmGlassHiveCallbackContext = jest.fn((input) =>
      realConfirmGlassHiveCallbackContext(input),
    );

    const resultA = terminalBody(1, 'a', 'Result A must leave no durable effect.', {
      worker_id: 'wrk_receiver_cas_a',
    });
    const resultB = terminalBody(2, 'b', 'Result B is canonical.', {
      worker_id: 'wrk_receiver_cas_b',
    });
    const aResponse = callbackRequest(app, resultA).then((response) => response);
    let bResponsePromise;
    let staleAResponse;
    try {
      await withTimeout(aEntered, GATE_TIMEOUT_MS, 'result_a_destination_entry');
      await mongoose.connection.db
        .collection(CALLBACK_RESULTS_COLLECTION)
        .updateOne({ runId: resultA.run_id }, { $set: { effectLeaseExpiresAt: new Date(0) } });
      bResponsePromise = callbackRequest(app, resultB).then((response) => response);
      await withTimeout(bAccepted, GATE_TIMEOUT_MS, 'result_b_accepted_before_destination');

      releaseA();
      releasePendingGate = null;
      staleAResponse = await withTimeout(aResponse, REQUEST_DEADLINE_MS, 'result_a_response');
      expect(staleAResponse.status).toBe(409);
      expect(staleAResponse.body).toEqual(receiptFor(resultA, 'superseded', resultB));

      const beforeB = await mongoose.connection.db
        .collection(EXTERNAL_WORK_COLLECTION)
        .findOne({ _id: binding.originRef });
      expect(beforeB).not.toHaveProperty('workerId');
      expect(JSON.stringify(beforeB)).not.toContain(resultA.callback_id);

      releaseB();
      const bResponse = await withTimeout(
        bResponsePromise,
        REQUEST_DEADLINE_MS,
        'result_b_response',
      );
      expect(bResponse.status).toBe(200);
      const durableEffect = await mongoose.connection.db
        .collection(EXTERNAL_WORK_COLLECTION)
        .findOne({ _id: binding.originRef });
      expect(durableEffect).toMatchObject({
        workerId: resultB.worker_id,
        terminalCallbackResultRevision: 2,
        terminalCallbackId: resultB.callback_id,
        terminalCallbackResultDigest: resultB.result_digest,
      });
      expect(JSON.stringify(durableEffect)).not.toContain(resultA.callback_id);
    } finally {
      releaseA?.();
      releaseB?.();
      releasePendingGate = null;
      updateSpy.mockRestore();
      if (!staleAResponse) await aResponse.catch(() => undefined);
      if (bResponsePromise) await bResponsePromise.catch(() => undefined);
    }
  }, 25000);

  test('requires exact sender headers and performs no side effect for malformed identity', async () => {
    const resultA = terminalBody(1, 'a', 'Malformed identity must not persist.');
    const response = await callbackRequest(app, resultA, {
      ...callbackHeaders(resultA),
      'x-glasshive-result-digest': `sha256:${'f'.repeat(64)}`,
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'invalid_terminal_result_identity' });
    await expect(
      mongoose.connection.db.collection(CALLBACK_RESULTS_COLLECTION).countDocuments({}),
    ).resolves.toBe(0);
    expect(mockConfirmGlassHiveCallbackContext).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockRecordGlassHiveCallbackExternalState).not.toHaveBeenCalled();
    expect(mockEnqueueGlassHiveMissionAdjudication).not.toHaveBeenCalled();
  }, 15000);

  test('fails closed on an equal-revision conflict and keeps the current exact identity', async () => {
    const resultB = terminalBody(2, 'b', 'Result B is canonical.');
    const conflict = terminalBody(2, 'c', 'A conflicting revision must not persist.');
    const accepted = await callbackRequest(app, resultB);
    const rejected = await callbackRequest(app, conflict);

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(409);
    expect(rejected.body).toEqual(receiptFor(conflict, 'conflict', resultB));
    expect(mockConfirmGlassHiveCallbackContext).toHaveBeenCalledTimes(1);
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    expect(mockRecordGlassHiveCallbackExternalState).toHaveBeenCalledTimes(1);
    expect(mockEnqueueGlassHiveMissionAdjudication).toHaveBeenCalledTimes(1);
  }, 15000);

  test('returns an exact idempotent receipt without creating a second message', async () => {
    const resultB = terminalBody(2, 'b', 'Result B is canonical.');
    const first = await callbackRequest(app, resultB);
    const replay = await callbackRequest(app, resultB);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(
      expect.objectContaining({
        ...receiptFor(resultB, 'idempotent', resultB),
        duplicate: true,
      }),
    );
    expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    await expect(
      mongoose.connection.db.collection(CALLBACK_RESULTS_COLLECTION).countDocuments({}),
    ).resolves.toBe(1);
  }, 15000);

  test.each([
    ['completed', 'run.completed', 'completed'],
    ['failed', 'run.failed', 'failed'],
    ['cancelled', 'run.cancelled', 'cancelled'],
    ['interrupted', 'run.interrupted', 'cancelled'],
  ])(
    'accepts the canonical %s terminal wire result',
    async (_label, event, resultState) => {
      const body = terminalBody(1, 'd', `Canonical ${event} result.`, {
        event,
        work_state: resultState,
        result_state: resultState,
      });
      body.callback_id = terminalCallbackId(body);

      const response = await callbackRequest(app, body);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(expect.objectContaining(receiptFor(body, 'accepted', body)));
      expect(mockSaveMessage).toHaveBeenCalledTimes(1);
    },
    15000,
  );
});
