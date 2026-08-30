/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new file).
 * Feature: Durable GlassHive callback delivery ledger tests.
 *
 * Added: 2026-05-06
 * === VIVENTIUM END === */

let mockFindOneAndUpdate;
let mockFindOne;
let mockFindTerminalCallbackResult;
let mockTerminalCallbackResultExists;
let mockFindDeliveries;
let mockCountDocuments;
let mockUpdateOne;
let mockUpdateMany;
let mockMessageFindOne;
let mockAcquireEffectLease;
let mockFenceEffectTransaction;
let mockReleaseEffectLease;
let mockRenewEffectLease;
let mockRecordGlassHiveSurfaceDeliveryOutcome;
let mockResolveTelegramMappingByUserId;
let mockRecordTraceDelivery;
let mockRecordVoiceOrchestrationTrace;

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease: (...args) =>
    mockAcquireEffectLease(...args),
  fenceGlassHiveTerminalCallbackEffectTransaction: (...args) => mockFenceEffectTransaction(...args),
  releaseGlassHiveTerminalCallbackEffectLease: (...args) => mockReleaseEffectLease(...args),
  renewGlassHiveTerminalCallbackEffectLease: (...args) => mockRenewEffectLease(...args),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('~/db/models', () => ({
  GlassHiveTerminalCallbackResult: {
    findOne: (...args) => mockFindTerminalCallbackResult(...args),
    exists: (...args) => mockTerminalCallbackResultExists(...args),
  },
  Message: {
    findOne: (...args) => mockMessageFindOne(...args),
  },
  ViventiumGlassHiveCallbackDelivery: {
    findOneAndUpdate: (...args) => mockFindOneAndUpdate(...args),
    findOne: (...args) => mockFindOne(...args),
    find: (...args) => mockFindDeliveries(...args),
    countDocuments: (...args) => mockCountDocuments(...args),
    updateOne: (...args) => mockUpdateOne(...args),
    updateMany: (...args) => mockUpdateMany(...args),
  },
}));

jest.mock('../GlassHiveTerminalCallbackTransaction', () => ({
  runGlassHiveTerminalCallbackTransaction: (operation) => operation({ inTransaction: () => true }),
}));

jest.mock('../GlassHiveCallbackBindingService', () => ({
  recordGlassHiveSurfaceDeliveryOutcome: (...args) =>
    mockRecordGlassHiveSurfaceDeliveryOutcome(...args),
}));

jest.mock('../OrchestrationTraceLedgerService', () => ({
  recordOrchestrationTraceDelivery: (...args) => mockRecordTraceDelivery(...args),
}));

jest.mock('../VoiceOrchestrationTraceService', () => ({
  recordVoiceOrchestrationTrace: (...args) => mockRecordVoiceOrchestrationTrace(...args),
}));

jest.mock('~/server/services/TelegramLinkService', () => ({
  resolveTelegramMappingByUserId: (...args) => mockResolveTelegramMappingByUserId(...args),
}));

const {
  completeGlassHiveWorkerCompletionPresentation,
  enqueueGlassHiveCallbackDelivery,
  claimPendingGlassHiveCallbackDeliveries,
  markGlassHiveCallbackDeliverySent,
  markGlassHiveCallbackDeliveryFailed,
  markGlassHiveCallbackDeliverySuppressed,
  markGlassHiveCallbackDeliveryUnknown,
  reconcileUnresolvedGlassHiveCallbackDeliveries,
  reconcileGlassHiveSurfaceDeliveryProjections,
} = require('../GlassHiveCallbackDeliveryService');

function leanResult(value) {
  const query = {
    lean: async () => value,
    session: jest.fn(() => query),
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
  };
  return query;
}

function syntheticLocalPath(...parts) {
  return ['', 'Users', 'synthetic-user', ...parts].join('/');
}

function canonicalCallbackRef(value) {
  const crypto = require('crypto');
  return `callback_sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function workerCompletionFixture() {
  const { buildVoiceWorkerCompletionPresentation } = require('@librechat/api');
  const binding = (suffix) => ({
    originRef: `origin-${suffix}`,
    workRef: `work-${suffix}`,
    workerId: `worker-${suffix}`,
    runId: `run-${suffix}`,
    callbackRef: canonicalCallbackRef(`cb_terminal_${suffix.repeat(64)}`),
    attemptNumber: 1,
    resultKey: `ghtr_${suffix.repeat(64)}`,
    acceptedOperationId: suffix.repeat(32),
    terminalCallbackId: `cb_terminal_${suffix.repeat(64)}`,
    resultDigest: `sha256:${suffix.repeat(64)}`,
    resultRevision: 1,
    effectGeneration: 1,
  });
  const bindings = [binding('a'), binding('b')];
  const presentation = buildVoiceWorkerCompletionPresentation({
    ownerId: 'owner-coalesced',
    conversationId: 'conversation-coalesced',
    callSessionId: 'call-coalesced',
    responseMessageId: 'follow-up-coalesced',
    responseText: 'Both Workers completed.',
    bindings,
  });
  const leases = bindings.map((item, index) => ({
    resultKey: item.resultKey,
    acceptedOperationId: item.acceptedOperationId,
    acceptedOperationGeneration: item.effectGeneration,
    leaseId: String(index + 1).repeat(32),
    generation: 1,
    resultRevision: item.resultRevision,
    callbackId: item.terminalCallbackId,
    resultDigest: item.resultDigest,
  }));
  const row = {
    deliveryId: 'ghcd-coalesced',
    claimId: 'claim-coalesced',
    callbackMessageId: presentation.responseMessageId,
    originRef: bindings[0].originRef,
    workRef: bindings[0].workRef,
    userId: 'owner-coalesced',
    conversationId: 'conversation-coalesced',
    event: 'main.followup',
    surface: 'voice',
    status: 'claimed',
    text: 'Both Workers completed.',
    voiceCallSessionId: 'call-coalesced',
    voiceRequestId: presentation.turnId,
    terminalCallbackResultKey: bindings[0].resultKey,
    terminalCallbackAcceptedOperationId: bindings[0].acceptedOperationId,
    terminalCallbackId: bindings[0].terminalCallbackId,
    terminalCallbackResultDigest: bindings[0].resultDigest,
    terminalCallbackResultRevision: bindings[0].resultRevision,
    terminalCallbackEffectGeneration: bindings[0].effectGeneration,
    dispatchPermitId: leases[0].leaseId,
    dispatchPermitGeneration: leases[0].generation,
    dispatchPermitExpiresAt: new Date(Date.now() + 60_000),
    workerCompletionPresentation: presentation,
    workerCompletionEffectLeases: leases,
    workerCompletionTtsCompletedAt: null,
    workerCompletionAudioCompletedAt: null,
    retryCount: 0,
  };
  const dispatchPermit = {
    deliveryId: row.deliveryId,
    claimId: row.claimId,
    surface: 'voice',
    permitId: leases[0].leaseId,
    permitGeneration: leases[0].generation,
    expiresAt: row.dispatchPermitExpiresAt.toISOString(),
    resultRevision: bindings[0].resultRevision,
    resultDigest: bindings[0].resultDigest,
  };
  return { bindings, dispatchPermit, leases, presentation, row };
}

describe('GlassHiveCallbackDeliveryService', () => {
  beforeEach(() => {
    mockFindOneAndUpdate = jest.fn();
    mockFindOne = jest.fn().mockReturnValue(leanResult(null));
    mockFindTerminalCallbackResult = jest.fn().mockReturnValue(leanResult(null));
    mockTerminalCallbackResultExists = jest.fn().mockReturnValue(leanResult(null));
    mockFindDeliveries = jest.fn().mockReturnValue(leanResult([]));
    mockCountDocuments = jest.fn();
    mockUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockUpdateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    mockRecordGlassHiveSurfaceDeliveryOutcome = jest.fn().mockResolvedValue(null);
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue(null);
    mockRecordTraceDelivery = jest.fn().mockResolvedValue(null);
    mockRecordVoiceOrchestrationTrace = jest.fn().mockResolvedValue(null);
    mockMessageFindOne = jest.fn().mockReturnValue(leanResult(null));
    mockAcquireEffectLease = jest.fn();
    mockFenceEffectTransaction = jest.fn().mockResolvedValue(true);
    mockReleaseEffectLease = jest.fn().mockResolvedValue(true);
    mockRenewEffectLease = jest.fn().mockResolvedValue(true);
  });

  test('successful terminal evidence waits for Main adjudication instead of direct surface delivery', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({
        ...update.$setOnInsert,
        ...update.$set,
      }),
    );

    const summary = await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'cb_private_raw',
        event: 'run.completed',
        user_id: 'user_1',
        conversation_id: 'conv_1',
        parent_message_id: 'msg_user',
        message_id: 'msg_anchor',
        surface: 'telegram',
        telegram_chat_id: 'callback-supplied-chat-must-be-ignored',
        full_message: `Created ${syntheticLocalPath('private', 'report.md')}`,
      },
      deliveryContext: {
        bindingId: 'ghcb_binding_1',
        ownerId: 'user_1',
        conversationId: 'conv_1',
        anchorMessageId: 'msg_anchor',
        requestedParentMessageId: 'msg_user',
        destinations: [
          {
            surface: 'telegram',
            telegramChatId: 'chat_1',
            telegramUserId: 'telegram_user_1',
          },
          { surface: 'librechat' },
        ],
      },
      message: {
        messageId: 'msg_callback',
        text: 'Created [local path]',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Created [local path]',
      fullText: '',
    });

    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(summary).toEqual({
      configured: 1,
      enqueued: 0,
      unresolved: 0,
      deliveries: [],
      deferredToMain: true,
    });
  });

  test('immediate neutral attention status never falls back to raw callback full_message text', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'cb_failed',
        event: 'run.failed',
        full_message: `Created ${syntheticLocalPath('private', 'report.md')}`,
      },
      deliveryContext: {
        ownerId: 'user_1',
        conversationId: 'conv_1',
        anchorMessageId: 'msg_anchor',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat_1', telegramUserId: 'telegram_user_1' },
        ],
      },
      message: {
        messageId: 'msg_callback',
        text: 'Mission needs attention.',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Mission needs attention.',
      fullText: '',
    });

    const update = mockFindOneAndUpdate.mock.calls[0][1];
    expect(update.$set.fullText).toBe('');
    expect(update.$setOnInsert.telegramChatId).toBe('chat_1');
    expect(JSON.stringify(update)).not.toContain(syntheticLocalPath());
  });

  test.each(['run.needs_input', 'run.blocked'])(
    'delivers %s immediately to the trusted Telegram destination',
    async (event) => {
      mockFindOneAndUpdate.mockImplementation((_query, update) =>
        leanResult({ ...update.$setOnInsert, ...update.$set }),
      );

      const summary = await enqueueGlassHiveCallbackDelivery({
        body: { callback_id: `cb_${event}`, event },
        deliveryContext: {
          ownerId: 'user_1',
          conversationId: 'conv_1',
          anchorMessageId: 'msg_anchor',
          destinations: [
            { surface: 'telegram', telegramChatId: 'chat_1', telegramUserId: 'telegram_user_1' },
          ],
        },
        message: {
          messageId: 'msg_callback',
          text: 'Mission needs user input.',
          metadata: { viventium: { callbackKey: 'safe_key' } },
        },
        text: 'Mission needs user input.',
        fullText: '',
      });

      expect(summary.enqueued).toBe(1);
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    },
  );

  test('semantic silence persists one suppressed row for a resolved terminal Telegram destination', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    const summary = await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'main:origin:silent:evidence-1',
        event: 'main.followup',
        origin_ref: 'origin-1',
        work_ref: 'work-1',
      },
      message: {
        messageId: 'silent:evidence-1',
        text: '',
        metadata: { viventium: { callbackKey: 'silent:evidence-1' } },
      },
      text: '',
      fullText: '',
      suppress: true,
      deliveryContext: {
        ownerId: 'user-1',
        originRef: 'origin-1',
        workRef: 'work-1',
        conversationId: 'conversation-1',
        anchorMessageId: 'assistant-anchor',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat-1', telegramUserId: 'telegram-user-1' },
        ],
      },
    });

    expect(summary).toMatchObject({ configured: 1, enqueued: 1, unresolved: 0 });
    const update = mockFindOneAndUpdate.mock.calls[0][1];
    expect(update.$setOnInsert).toMatchObject({
      status: 'suppressed',
      nextAttemptAt: null,
      telegramChatId: 'chat-1',
    });
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'origin-1',
      state: 'suppressed',
    });
  });

  test('does not enqueue external delivery without a resolved Core binding', async () => {
    const result = await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'cb_unbound',
        event: 'run.completed',
        user_id: 'user_1',
        conversation_id: 'conv_1',
        surface: 'telegram',
        telegram_chat_id: 'untrusted-chat',
      },
      message: {
        messageId: 'msg_callback',
        text: 'Mission completed.',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Mission completed.',
    });

    expect(result).toEqual({ configured: 0, enqueued: 0, unresolved: 0, deliveries: [] });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('alerts and persists unresolved truth when a configured terminal destination cannot resolve', async () => {
    const { logger } = require('@librechat/data-schemas');
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    const result = await enqueueGlassHiveCallbackDelivery({
      body: { callback_id: 'cb_unresolved', event: 'main.followup' },
      deliveryContext: {
        originRef: 'ghi_origin_unresolved',
        ownerId: 'user_1',
        conversationId: 'conv_1',
        anchorMessageId: 'msg_anchor',
        destinations: [
          { surface: 'telegram', unresolvedReason: 'telegram_account_not_linked' },
          { surface: 'librechat' },
        ],
      },
      message: {
        messageId: 'msg_main_followup',
        text: 'Main-authored result.',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Main-authored result.',
      fullText: '',
    });

    expect(result).toEqual({
      configured: 1,
      enqueued: 0,
      unresolved: 1,
      deliveries: [expect.objectContaining({ status: 'unresolved' })],
    });
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_origin_unresolved',
      state: 'unresolved',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][glasshive-delivery] Terminal surface destination unresolved',
      expect.objectContaining({
        originRef: 'ghi_origin_unresolved',
        event: 'main.followup',
        configured: 1,
        unresolved: 1,
      }),
    );
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const unresolvedUpdate = mockFindOneAndUpdate.mock.calls[0][1];
    expect(unresolvedUpdate.$setOnInsert).toEqual(
      expect.objectContaining({
        surface: 'telegram',
        status: 'unresolved',
        unresolvedReason: 'telegram_account_not_linked',
      }),
    );
  });

  test('persists mixed resolved and unresolved destinations as partial durable truth', async () => {
    const { logger } = require('@librechat/data-schemas');
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    const result = await enqueueGlassHiveCallbackDelivery({
      body: { callback_id: 'cb_partial', event: 'main.followup' },
      deliveryContext: {
        originRef: 'ghi_origin_partial',
        workRef: 'ghw_work_partial',
        ownerId: 'user_1',
        conversationId: 'conv_1',
        anchorMessageId: 'msg_anchor',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat_1', telegramUserId: 'telegram_user_1' },
          { surface: 'voice', unresolvedReason: 'voice_session_not_bound' },
        ],
      },
      message: {
        messageId: 'msg_main_followup',
        text: 'Main-authored result.',
        metadata: { viventium: { callbackKey: 'safe_key' } },
      },
      text: 'Main-authored result.',
      fullText: '',
    });

    expect(result).toEqual({
      configured: 2,
      enqueued: 1,
      unresolved: 1,
      deliveries: [
        expect.objectContaining({ surface: 'telegram', status: 'pending' }),
        expect.objectContaining({ surface: 'voice', status: 'unresolved' }),
      ],
    });
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_origin_partial',
      state: 'unresolved',
    });
    expect(logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][glasshive-delivery] Terminal surface destination unresolved',
      expect.objectContaining({ configured: 2, enqueued: 1, unresolved: 1 }),
    );
  });

  test('same callback id on the same surface is isolated by trusted owner and origin', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    const common = {
      body: { callback_id: 'cb_shared_vendor_id', event: 'main.followup' },
      message: {
        messageId: 'msg_main_followup',
        text: 'Main-authored result.',
        metadata: { viventium: { callbackKey: 'same_callback_key' } },
      },
      text: 'Main-authored result.',
      fullText: '',
    };

    await enqueueGlassHiveCallbackDelivery({
      ...common,
      deliveryContext: {
        originRef: 'ghi_owner_a_origin',
        ownerId: 'owner_a',
        conversationId: 'conv_a',
        destinations: [{ surface: 'telegram', telegramChatId: 'chat_a' }],
      },
    });
    await enqueueGlassHiveCallbackDelivery({
      ...common,
      deliveryContext: {
        originRef: 'ghi_owner_b_origin',
        ownerId: 'owner_b',
        conversationId: 'conv_b',
        destinations: [{ surface: 'telegram', telegramChatId: 'chat_b' }],
      },
    });

    const firstFilter = mockFindOneAndUpdate.mock.calls[0][0];
    const secondFilter = mockFindOneAndUpdate.mock.calls[1][0];
    const firstKey = firstFilter.$or[0].deliveryKey;
    const secondKey = secondFilter.$or[0].deliveryKey;
    expect(firstKey).not.toBe(secondKey);
    expect(firstKey).toContain(
      `owner_a:ghi_owner_a_origin:telegram:${canonicalCallbackRef('cb_shared_vendor_id')}`,
    );
    expect(secondKey).toContain(
      `owner_b:ghi_owner_b_origin:telegram:${canonicalCallbackRef('cb_shared_vendor_id')}`,
    );
    expect(firstFilter.$or[0]).toMatchObject({
      userId: 'owner_a',
      originRef: 'ghi_owner_a_origin',
    });
    expect(secondFilter.$or[0]).toMatchObject({
      userId: 'owner_b',
      originRef: 'ghi_owner_b_origin',
    });
    expect(firstFilter.$or[1]).toEqual({
      deliveryKey: `telegram:${canonicalCallbackRef('cb_shared_vendor_id')}`,
      userId: 'owner_a',
      $or: [
        { originRef: { $exists: false } },
        { originRef: '' },
        { originRef: 'ghi_owner_a_origin' },
      ],
    });
    expect(secondFilter.$or[1]).toEqual({
      deliveryKey: `telegram:${canonicalCallbackRef('cb_shared_vendor_id')}`,
      userId: 'owner_b',
      $or: [
        { originRef: { $exists: false } },
        { originRef: '' },
        { originRef: 'ghi_owner_b_origin' },
      ],
    });
  });

  test.each([
    [
      'candidate-HEAD owner-scoped',
      (callbackRef) => `owner-upgrade:origin-upgrade:telegram:${callbackRef}`,
    ],
    ['public-base surface-only', (callbackRef) => `telegram:${callbackRef}`],
  ])('queries the exact %s delivery key during upgrade', async (_name, legacyKey) => {
    const callbackRef = canonicalCallbackRef('raw-upgrade-callback');
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'raw-upgrade-callback',
        attempt_number: 4,
        event: 'run.failed',
        origin_ref: 'origin-upgrade',
        work_ref: 'work-upgrade',
      },
      deliveryContext: {
        ownerId: 'owner-upgrade',
        originRef: 'origin-upgrade',
        workRef: 'work-upgrade',
        conversationId: 'conversation-upgrade',
        traceIdentity: { callbackRef, attemptNumber: 4 },
        destinations: [{ surface: 'telegram', telegramChatId: 'chat-upgrade' }],
      },
      message: { messageId: 'message-upgrade', text: 'Mission needs attention.' },
      text: 'Mission needs attention.',
    });

    const filter = mockFindOneAndUpdate.mock.calls[0][0];
    const branch = filter.$or.find((candidate) => candidate.deliveryKey === legacyKey(callbackRef));
    expect(branch).toMatchObject({ userId: 'owner-upgrade' });
    if (_name === 'candidate-HEAD owner-scoped') {
      expect(branch).toMatchObject({ originRef: 'origin-upgrade' });
    } else {
      expect(branch.$or).toEqual([
        { originRef: { $exists: false } },
        { originRef: '' },
        { originRef: 'origin-upgrade' },
      ]);
    }
  });

  test('carries one canonical callback ref and exact attempt from enqueue through trace evidence', async () => {
    const callbackRef = canonicalCallbackRef('raw-failed-callback');
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'raw-failed-callback',
        attempt_number: 3,
        event: 'run.failed',
        run_id: 'run-exact',
        work_ref: 'work-exact',
      },
      deliveryContext: {
        ownerId: 'owner-exact',
        originRef: 'origin-exact',
        workRef: 'work-exact',
        conversationId: 'conversation-exact',
        traceIdentity: { callbackRef, attemptNumber: 3 },
        destinations: [{ surface: 'telegram', telegramChatId: 'chat-exact' }],
      },
      message: { messageId: 'message-exact', text: 'Mission failed.' },
      text: 'Mission failed.',
    });

    expect(mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert.callbackId).toBe(callbackRef);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert.deliveryKey).toContain(':attempt:3');
    expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackRef,
        attemptNumber: 3,
        runRef: 'run-exact',
        workRef: 'work-exact',
      }),
    );
  });

  test('carries an exact pre-runtime Stop identity through Telegram trace evidence', async () => {
    const callbackRef = canonicalCallbackRef('raw-pre-runtime-stop');
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'raw-pre-runtime-stop',
        attempt_number: null,
        event: 'run.cancelled',
        run_id: 'run-pre-runtime-stop',
        work_ref: 'work-pre-runtime-stop',
      },
      deliveryContext: {
        ownerId: 'owner-pre-runtime-stop',
        originRef: 'origin-pre-runtime-stop',
        workRef: 'work-pre-runtime-stop',
        conversationId: 'conversation-pre-runtime-stop',
        traceIdentity: { callbackRef, attemptNumber: null },
        destinations: [{ surface: 'telegram', telegramChatId: 'chat-pre-runtime-stop' }],
      },
      message: { messageId: 'message-pre-runtime-stop', text: 'Mission stopped.' },
      text: 'Mission stopped.',
    });

    expect(mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert.callbackId).toBe(callbackRef);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert.deliveryKey).not.toContain(
      ':attempt:',
    );
    expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        callbackRef,
        callbackEvent: 'run.cancelled',
        state: 'cancelled',
        terminal: true,
        attemptNumber: undefined,
        runRef: 'run-pre-runtime-stop',
        workRef: 'work-pre-runtime-stop',
      }),
    );
  });

  test('forwards the trusted terminal identity through a Main-authored Telegram receipt', async () => {
    const callbackRef = canonicalCallbackRef('raw-main-callback');
    mockFindOneAndUpdate
      .mockImplementationOnce((_query, update) =>
        leanResult({
          ...update.$setOnInsert,
          ...update.$set,
          createdAt: new Date('2026-08-22T15:00:00.000Z'),
        }),
      )
      .mockImplementationOnce((_query, update) =>
        leanResult({
          deliveryId: 'ghcd-main-exact',
          deliveryKey: `owner-main:origin-main:telegram:${callbackRef}:attempt:5`,
          callbackId: callbackRef,
          callbackMessageId: 'follow-up-main-exact',
          userId: 'owner-main',
          originRef: 'origin-main',
          workRef: 'work-main',
          runId: 'run-main',
          conversationId: 'conversation-main',
          event: 'run.completed',
          surface: 'telegram',
          status: 'sent',
          claimId: 'claim-main',
          sentAt: update.$set.sentAt,
        }),
      );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: callbackRef,
        attempt_number: 5,
        event: 'main.followup',
        run_id: 'run-main',
        work_ref: 'work-main',
      },
      deliveryContext: {
        ownerId: 'owner-main',
        originRef: 'origin-main',
        workRef: 'work-main',
        conversationId: 'conversation-main',
        traceIdentity: { callbackRef, attemptNumber: 5 },
        traceCallbackEvent: 'run.completed',
        traceSurface: 'telegram',
        destinations: [{ surface: 'telegram', telegramChatId: 'chat-main' }],
      },
      message: { messageId: 'follow-up-main-exact', text: 'Main-authored result.' },
      text: 'Main-authored result.',
    });
    mockRecordTraceDelivery.mockClear();

    await markGlassHiveCallbackDeliverySent({
      deliveryId: 'ghcd-main-exact',
      claimId: 'claim-main',
      telegramMessageIds: ['701'],
    });

    expect(mockRecordTraceDelivery).toHaveBeenCalledTimes(1);
    expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner-main',
        originRef: 'origin-main',
        workRef: 'work-main',
        runRef: 'run-main',
        callbackRef,
        callbackEvent: 'run.completed',
        state: 'completed',
        terminal: true,
        surface: 'telegram',
        status: 'sent',
        attemptNumber: 5,
      }),
    );
  });

  test('recovers the exact accepted terminal fence for every Main-authored delivery destination', async () => {
    const rawCallbackId = `cb_terminal_${'b'.repeat(64)}`;
    const callbackRef = canonicalCallbackRef(rawCallbackId);
    const terminalResult = {
      _id: `ghtr_${'a'.repeat(64)}`,
      ownerId: 'owner-main-fenced',
      originRef: 'origin-main-fenced',
      workRef: 'work-main-fenced',
      workerId: 'worker-main-fenced',
      runId: 'run-main-fenced',
      callbackId: rawCallbackId,
      attemptNumber: 2,
      resultState: 'completed',
      resultRevision: 4,
      resultDigest: `sha256:${'c'.repeat(64)}`,
      acceptedOperationId: 'd'.repeat(32),
      acceptedOperationGeneration: 7,
    };
    mockFindTerminalCallbackResult.mockReturnValue(leanResult(terminalResult));
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    const { buildVoiceWorkerCompletionPresentation } = require('@librechat/api');
    const workerCompletionPresentation = buildVoiceWorkerCompletionPresentation({
      ownerId: terminalResult.ownerId,
      conversationId: 'conversation-main-fenced',
      callSessionId: 'call-main-fenced',
      responseMessageId: 'follow-up-main-fenced',
      responseText: 'Main-authored terminal result.',
      bindings: [
        {
          originRef: terminalResult.originRef,
          workRef: terminalResult.workRef,
          workerId: terminalResult.workerId,
          runId: terminalResult.runId,
          callbackRef,
          attemptNumber: terminalResult.attemptNumber,
          resultKey: terminalResult._id,
          acceptedOperationId: terminalResult.acceptedOperationId,
          terminalCallbackId: terminalResult.callbackId,
          resultDigest: terminalResult.resultDigest,
          resultRevision: terminalResult.resultRevision,
          effectGeneration: terminalResult.acceptedOperationGeneration,
        },
      ],
    });

    const summary = await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: callbackRef,
        attempt_number: 2,
        event: 'main.followup',
        origin_ref: terminalResult.originRef,
        work_ref: terminalResult.workRef,
        worker_id: terminalResult.workerId,
        run_id: terminalResult.runId,
      },
      deliveryContext: {
        ownerId: terminalResult.ownerId,
        originRef: terminalResult.originRef,
        workRef: terminalResult.workRef,
        conversationId: 'conversation-main-fenced',
        traceIdentity: { callbackRef, attemptNumber: 2 },
        traceCallbackEvent: 'run.completed',
        traceSurface: 'telegram',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat-main-fenced' },
          { surface: 'voice', voiceCallSessionId: 'call-main-fenced' },
        ],
        workerCompletionPresentation,
      },
      message: { messageId: 'follow-up-main-fenced', text: 'Main-authored terminal result.' },
      text: 'Main-authored terminal result.',
    });

    expect(mockFindTerminalCallbackResult).toHaveBeenCalledWith({
      ownerId: terminalResult.ownerId,
      originRef: terminalResult.originRef,
      workRef: terminalResult.workRef,
      workerId: terminalResult.workerId,
      runId: terminalResult.runId,
      attemptNumber: terminalResult.attemptNumber,
    });
    expect(summary).toMatchObject({ configured: 2, enqueued: 2, unresolved: 0 });
    for (const [, update] of mockFindOneAndUpdate.mock.calls) {
      expect(update.$setOnInsert).toMatchObject({
        terminalCallbackResultKey: terminalResult._id,
        terminalCallbackAcceptedOperationId: terminalResult.acceptedOperationId,
        terminalCallbackId: terminalResult.callbackId,
        terminalCallbackResultDigest: terminalResult.resultDigest,
        terminalCallbackResultRevision: terminalResult.resultRevision,
        terminalCallbackEffectGeneration: terminalResult.acceptedOperationGeneration,
      });
    }
  });

  test('persists one typed Voice presentation and records its response for every bound Worker', async () => {
    const { buildVoiceWorkerCompletionPresentation } = require('@librechat/api');
    const binding = (suffix) => ({
      originRef: `origin-${suffix}`,
      workRef: `work-${suffix}`,
      workerId: `worker-${suffix}`,
      runId: `run-${suffix}`,
      callbackRef: canonicalCallbackRef(`cb_terminal_${suffix.repeat(64)}`),
      attemptNumber: 1,
      resultKey: `ghtr_${suffix.repeat(64)}`,
      acceptedOperationId: suffix.repeat(32),
      terminalCallbackId: `cb_terminal_${suffix.repeat(64)}`,
      resultDigest: `sha256:${suffix.repeat(64)}`,
      resultRevision: 1,
      effectGeneration: 1,
    });
    const bindings = [binding('a'), binding('b')];
    const presentation = buildVoiceWorkerCompletionPresentation({
      ownerId: 'owner-coalesced',
      conversationId: 'conversation-coalesced',
      callSessionId: 'call-coalesced',
      responseMessageId: 'follow-up-coalesced',
      responseText: 'Both Workers completed.',
      bindings,
    });
    mockFindTerminalCallbackResult.mockImplementation((query) => {
      const binding = bindings.find(
        (candidate) =>
          candidate.resultKey === query._id ||
          (candidate.originRef === query.originRef && candidate.workRef === query.workRef),
      );
      return leanResult(
        binding
          ? {
              _id: binding.resultKey,
              ownerId: 'owner-coalesced',
              ...binding,
              callbackId: binding.terminalCallbackId,
              resultState: 'completed',
              acceptedOperationGeneration: binding.effectGeneration,
            }
          : null,
      );
    });
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: bindings[0].callbackRef,
        attempt_number: 1,
        event: 'main.followup',
        origin_ref: bindings[0].originRef,
        work_ref: bindings[0].workRef,
        worker_id: bindings[0].workerId,
        run_id: bindings[0].runId,
      },
      deliveryContext: {
        ownerId: 'owner-coalesced',
        originRef: bindings[0].originRef,
        workRef: bindings[0].workRef,
        conversationId: 'conversation-coalesced',
        traceIdentity: { callbackRef: bindings[0].callbackRef, attemptNumber: 1 },
        traceCallbackEvent: 'run.completed',
        traceSurface: 'voice',
        destinations: [{ surface: 'voice', voiceCallSessionId: 'call-coalesced' }],
        workerCompletionPresentation: presentation,
      },
      message: { messageId: 'follow-up-coalesced', text: 'Both Workers completed.' },
      text: 'Both Workers completed.',
    });

    const inserted = mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert;
    expect(inserted.workerCompletionPresentation).toEqual(presentation);
    expect(mockRecordVoiceOrchestrationTrace).toHaveBeenCalledTimes(2);
    expect(
      mockRecordVoiceOrchestrationTrace.mock.calls.map(([input]) => input.facts.workRef),
    ).toEqual(['work-a', 'work-b']);
    expect(mockRecordVoiceOrchestrationTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        callSessionId: 'call-coalesced',
        turnId: presentation.turnId,
        stage: 'response.completed',
        facts: expect.objectContaining({
          presentationRef: presentation.presentationRef,
          responseRef: 'follow-up-coalesced',
        }),
      }),
    );
  });

  test('settles one exact coalesced Voice response through TTS and audio exactly once', async () => {
    const fixture = workerCompletionFixture();
    mockFindOne.mockReturnValueOnce(leanResult(fixture.row));
    mockMessageFindOne.mockReturnValueOnce(
      leanResult({ messageId: 'follow-up-coalesced', text: 'Both Workers completed.' }),
    );
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({
        ...fixture.row,
        status: 'sent',
        workerCompletionTtsCompletedAt: new Date(),
        workerCompletionAudioCompletedAt: new Date(),
        workerCompletionEffectLeases: [],
      }),
    );

    await expect(
      completeGlassHiveWorkerCompletionPresentation({
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        dispatchPermit: fixture.dispatchPermit,
        presentationRef: fixture.presentation.presentationRef,
        userId: fixture.row.userId,
        voiceCallSessionId: fixture.row.voiceCallSessionId,
      }),
    ).resolves.toMatchObject({ status: 'sent' });

    expect(mockFenceEffectTransaction).toHaveBeenCalledTimes(2);
    expect(mockReleaseEffectLease).toHaveBeenCalledTimes(2);
    expect(mockRecordVoiceOrchestrationTrace).toHaveBeenCalledTimes(4);
    expect(mockRecordVoiceOrchestrationTrace.mock.calls.map(([input]) => input.stage)).toEqual([
      'tts.completed',
      'tts.completed',
      'audio.completed',
      'audio.completed',
    ]);

    mockFindOne.mockReturnValueOnce(leanResult(null));
    mockRecordVoiceOrchestrationTrace.mockClear();
    await expect(
      completeGlassHiveWorkerCompletionPresentation({
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        dispatchPermit: fixture.dispatchPermit,
        presentationRef: fixture.presentation.presentationRef,
        userId: fixture.row.userId,
        voiceCallSessionId: fixture.row.voiceCallSessionId,
      }),
    ).resolves.toBeNull();
    expect(mockRecordVoiceOrchestrationTrace).not.toHaveBeenCalled();
  });

  test.each([
    ['substituted response', ({ row }) => row, 'Changed after authorization.'],
    [
      'mixed Worker lease',
      ({ row }) => ({
        ...row,
        workerCompletionEffectLeases: row.workerCompletionEffectLeases.map((lease, index) =>
          index === 1 ? { ...lease, resultDigest: `sha256:${'f'.repeat(64)}` } : lease,
        ),
      }),
      'Both Workers completed.',
    ],
  ])('rejects %s before recording TTS or audio', async (_name, mutate, responseText) => {
    const fixture = workerCompletionFixture();
    mockFindOne.mockReturnValueOnce(leanResult(mutate(fixture)));
    mockMessageFindOne.mockReturnValueOnce(
      leanResult({ messageId: 'follow-up-coalesced', text: responseText }),
    );

    await expect(
      completeGlassHiveWorkerCompletionPresentation({
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        dispatchPermit: fixture.dispatchPermit,
        presentationRef: fixture.presentation.presentationRef,
        userId: fixture.row.userId,
        voiceCallSessionId: fixture.row.voiceCallSessionId,
      }),
    ).resolves.toBeNull();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockRecordVoiceOrchestrationTrace).not.toHaveBeenCalled();
  });

  test.each([
    ['delivery_unknown', markGlassHiveCallbackDeliveryUnknown],
    ['failed', markGlassHiveCallbackDeliveryFailed],
  ])('releases every grouped Worker lease on %s', async (status, settle) => {
    const fixture = workerCompletionFixture();
    mockFindOne
      .mockReturnValueOnce(leanResult(fixture.row))
      .mockReturnValueOnce(leanResult(fixture.row));
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({
        ...fixture.row,
        status,
        workerCompletionEffectLeases: [],
      }),
    );

    await expect(
      settle({
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        dispatchPermit: fixture.dispatchPermit,
        userId: fixture.row.userId,
        voiceCallSessionId: fixture.row.voiceCallSessionId,
      }),
    ).resolves.toMatchObject({ status });
    expect(mockFenceEffectTransaction).toHaveBeenCalledTimes(2);
    expect(mockReleaseEffectLease).toHaveBeenCalledTimes(2);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
      dispatchPermitId: '',
      workerCompletionEffectLeases: [],
    });
  });

  test.each([
    { reason: 'missing accepted terminal result', result: null },
    {
      reason: 'different accepted callback identity',
      result: {
        _id: `ghtr_${'a'.repeat(64)}`,
        callbackId: `cb_terminal_${'c'.repeat(64)}`,
        resultState: 'completed',
        resultRevision: 1,
        resultDigest: `sha256:${'d'.repeat(64)}`,
        acceptedOperationId: 'e'.repeat(32),
        acceptedOperationGeneration: 1,
      },
    },
  ])('rejects a Main-authored terminal delivery with $reason', async ({ result }) => {
    const callbackRef = canonicalCallbackRef(`cb_terminal_${'b'.repeat(64)}`);
    mockFindTerminalCallbackResult.mockReturnValueOnce(leanResult(result));
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    await expect(
      enqueueGlassHiveCallbackDelivery({
        body: {
          callback_id: callbackRef,
          attempt_number: 1,
          event: 'main.followup',
          origin_ref: 'origin-main-rejected',
          work_ref: 'work-main-rejected',
          worker_id: 'worker-main-rejected',
          run_id: 'run-main-rejected',
        },
        deliveryContext: {
          ownerId: 'owner-main-rejected',
          originRef: 'origin-main-rejected',
          workRef: 'work-main-rejected',
          conversationId: 'conversation-main-rejected',
          traceIdentity: { callbackRef, attemptNumber: 1 },
          traceCallbackEvent: 'run.completed',
          destinations: [{ surface: 'telegram', telegramChatId: 'chat-main-rejected' }],
        },
        message: { messageId: 'follow-up-main-rejected', text: 'Main-authored terminal result.' },
        text: 'Main-authored terminal result.',
      }),
    ).rejects.toMatchObject({ code: 'glasshive_callback_effect_fenced' });

    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('only the bound presentation surface can append terminal delivery evidence', async () => {
    const callbackRef = canonicalCallbackRef('raw-multi-surface-callback');
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({
        ...update.$setOnInsert,
        ...update.$set,
        createdAt: new Date('2026-08-22T15:30:00.000Z'),
      }),
    );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: callbackRef,
        attempt_number: 2,
        event: 'main.followup',
        run_id: 'run-multi',
        work_ref: 'work-multi',
      },
      deliveryContext: {
        ownerId: 'owner-multi',
        originRef: 'origin-multi',
        workRef: 'work-multi',
        conversationId: 'conversation-multi',
        traceIdentity: { callbackRef, attemptNumber: 2 },
        traceCallbackEvent: 'run.completed',
        traceSurface: 'telegram',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat-multi' },
          { surface: 'voice', unresolvedReason: 'voice_active_session_not_bound' },
        ],
      },
      message: { messageId: 'follow-up-multi', text: 'One presentation.' },
      text: 'One presentation.',
    });

    expect(mockRecordTraceDelivery).toHaveBeenCalledTimes(1);
    expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'telegram', callbackRef, attemptNumber: 2 }),
    );
  });

  test('a repeated sent receipt cannot append a duplicate delivery event', async () => {
    const callbackRef = canonicalCallbackRef('raw-duplicate-receipt');
    const sent = {
      deliveryId: 'ghcd-duplicate-receipt',
      deliveryKey: `owner-duplicate:origin-duplicate:telegram:${callbackRef}:attempt:1`,
      callbackId: callbackRef,
      callbackMessageId: 'follow-up-duplicate',
      userId: 'owner-duplicate',
      originRef: 'origin-duplicate',
      workRef: 'work-duplicate',
      runId: 'run-duplicate',
      conversationId: 'conversation-duplicate',
      event: 'run.completed',
      surface: 'telegram',
      status: 'sent',
      claimId: 'claim-duplicate',
      sentAt: new Date('2026-08-22T15:45:00.000Z'),
    };
    mockFindOneAndUpdate
      .mockReturnValueOnce(leanResult(sent))
      .mockReturnValueOnce(leanResult(null));

    await markGlassHiveCallbackDeliverySent({
      deliveryId: sent.deliveryId,
      claimId: sent.claimId,
      telegramMessageIds: ['801'],
    });
    await markGlassHiveCallbackDeliverySent({
      deliveryId: sent.deliveryId,
      claimId: sent.claimId,
      telegramMessageIds: ['801'],
    });

    expect(mockRecordTraceDelivery).toHaveBeenCalledTimes(1);
    expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ callbackRef, attemptNumber: 1, status: 'sent' }),
    );
  });

  test('a callback attempt that disagrees with trusted ingress cannot create delivery evidence', async () => {
    const callbackRef = canonicalCallbackRef('raw-mismatched-callback');
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'raw-mismatched-callback',
        attempt_number: 2,
        event: 'run.failed',
        run_id: 'run-mismatch',
        work_ref: 'work-mismatch',
      },
      deliveryContext: {
        ownerId: 'owner-mismatch',
        originRef: 'origin-mismatch',
        workRef: 'work-mismatch',
        conversationId: 'conversation-mismatch',
        traceIdentity: { callbackRef, attemptNumber: 1 },
        destinations: [{ surface: 'telegram', telegramChatId: 'chat-mismatch' }],
      },
      message: { messageId: 'message-mismatch', text: 'Mission failed.' },
      text: 'Mission failed.',
    });

    expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
  });

  test('raw callback identity without the trusted ingress binding cannot create delivery evidence', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );

    await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'raw-untrusted-downstream-callback',
        attempt_number: 1,
        event: 'run.failed',
        run_id: 'run-untrusted',
        work_ref: 'work-untrusted',
      },
      deliveryContext: {
        ownerId: 'owner-untrusted',
        originRef: 'origin-untrusted',
        workRef: 'work-untrusted',
        conversationId: 'conversation-untrusted',
        destinations: [{ surface: 'telegram', telegramChatId: 'chat-untrusted' }],
      },
      message: { messageId: 'message-untrusted', text: 'Mission failed.' },
      text: 'Mission failed.',
    });

    expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
  });

  test('one sent target cannot clear a sibling unresolved target from Core projection', async () => {
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({
        deliveryId: 'ghcd_partial_sent',
        callbackId: canonicalCallbackRef('cb_terminal'),
        deliveryKey: `owner_partial:ghi_origin_partial:telegram:${canonicalCallbackRef(
          'cb_terminal',
        )}:attempt:1`,
        callbackMessageId: 'msg_callback',
        userId: 'owner_partial',
        originRef: 'ghi_origin_partial',
        workRef: 'work_partial',
        runId: 'run_partial',
        conversationId: 'conv_1',
        event: 'run.completed',
        surface: 'telegram',
        status: 'sent',
        claimId: 'claim_partial',
      }),
    );
    mockFindDeliveries.mockReturnValueOnce(
      leanResult([{ status: 'sent' }, { status: 'unresolved' }]),
    );

    await markGlassHiveCallbackDeliverySent({
      deliveryId: 'ghcd_partial_sent',
      claimId: 'claim_partial',
      telegramMessageIds: ['501', '502'],
    });

    expect(mockFindOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
      telegramSentMessageIds: ['501', '502'],
      telegramMessageId: '502',
      transportReceiptVersion: 1,
    });

    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_origin_partial',
      state: 'unresolved',
    });
    expect(mockRecordTraceDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner_partial',
        originRef: 'ghi_origin_partial',
        workRef: 'work_partial',
        runRef: 'run_partial',
        callbackRef: canonicalCallbackRef('cb_terminal'),
        callbackEvent: 'run.completed',
        state: 'completed',
        terminal: true,
        status: 'sent',
        attemptNumber: 1,
      }),
    );
  });

  test('repairs an unresolved Telegram target after account linking without a GH replay', async () => {
    const unresolvedQuery = {
      sort: jest.fn(() => unresolvedQuery),
      limit: jest.fn(() => unresolvedQuery),
      lean: jest.fn().mockResolvedValue([
        {
          deliveryId: 'ghcd_unresolved_link',
          userId: 'owner_linked',
          originRef: 'ghi_origin_linked',
          surface: 'telegram',
          status: 'unresolved',
        },
      ]),
    };
    mockFindDeliveries
      .mockReturnValueOnce(unresolvedQuery)
      .mockReturnValueOnce(leanResult([{ status: 'pending' }]));
    mockResolveTelegramMappingByUserId.mockResolvedValueOnce({
      telegramUserId: 'tg_linked',
      telegramChatId: 'chat_linked',
    });
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({
        deliveryId: 'ghcd_unresolved_link',
        userId: 'owner_linked',
        originRef: 'ghi_origin_linked',
        surface: 'telegram',
        status: 'pending',
        telegramUserId: 'tg_linked',
        telegramChatId: 'chat_linked',
      }),
    );

    await expect(
      reconcileUnresolvedGlassHiveCallbackDeliveries({ userId: 'owner_linked' }),
    ).resolves.toEqual({ scanned: 1, repaired: 1, pending: 0 });
    expect(mockResolveTelegramMappingByUserId).toHaveBeenCalledWith({
      libreChatUserId: 'owner_linked',
    });
    expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
      {
        deliveryId: 'ghcd_unresolved_link',
        userId: 'owner_linked',
        surface: 'telegram',
        status: 'unresolved',
      },
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'pending',
          telegramUserId: 'tg_linked',
          telegramChatId: 'chat_linked',
          unresolvedReason: '',
        }),
      }),
      { new: true },
    );
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_origin_linked',
      state: 'enqueued',
    });
  });

  test('claim uses the surface ledger without user-prompt matching', async () => {
    mockFindOneAndUpdate
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_claim',
          callbackId: 'cb_claim',
          callbackMessageId: 'msg_callback',
          conversationId: 'conv_1',
          event: 'run.completed',
          surface: 'telegram',
          status: 'claimed',
          text: 'Worker finished.',
          telegramChatId: 'chat_1',
          claimId: 'claim_1',
          retryCount: 0,
        }),
      )
      .mockReturnValueOnce(leanResult(null));

    const claimed = await claimPendingGlassHiveCallbackDeliveries({
      surface: 'telegram',
      limit: 5,
      claimOwner: 'telegram-dispatcher',
    });

    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: 'telegram',
        status: 'claimed',
        leaseExpiresAt: expect.objectContaining({ $lte: expect.any(Date) }),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({ status: 'delivery_unknown' }),
      }),
    );

    expect(claimed).toEqual([
      expect.objectContaining({
        deliveryId: 'ghcd_claim',
        callbackId: 'cb_claim',
        telegramChatId: 'chat_1',
        claimId: 'claim_1',
      }),
    ]);
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter.surface).toBe('telegram');
    expect(filter).not.toHaveProperty('text');
    expect(update.$set.status).toBe('claimed');
    expect(update.$set.claimOwner).toBe('telegram-dispatcher');
    expect(update.$set.leaseExpiresAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
  });

  test('refuses an ambiguous Telegram settlement without the exact dispatch permit', async () => {
    mockFindOne.mockReturnValue(
      leanResult({
        deliveryId: 'ghcd_unknown',
        callbackMessageId: 'msg_callback',
        originRef: 'ghi_unknown',
        conversationId: 'conv_1',
        event: 'main.followup',
        surface: 'telegram',
        status: 'claimed',
        claimId: 'claim_unknown',
        terminalCallbackResultKey: `ghtr_${'a'.repeat(64)}`,
        terminalCallbackAcceptedOperationId: 'b'.repeat(32),
        terminalCallbackId: `cb_terminal_${'c'.repeat(64)}`,
        terminalCallbackResultDigest: `sha256:${'d'.repeat(64)}`,
        terminalCallbackResultRevision: 1,
        terminalCallbackEffectGeneration: 1,
        dispatchPermitId: 'e'.repeat(32),
        dispatchPermitGeneration: 1,
        dispatchPermitExpiresAt: new Date(Date.now() + 60_000),
      }),
    );

    await expect(
      markGlassHiveCallbackDeliveryUnknown({
        deliveryId: 'ghcd_unknown',
        claimId: 'claim_unknown',
        reason: 'telegram_receipt_missing',
      }),
    ).resolves.toBeNull();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
  });

  test('retries a durable Core projection without requiring a GlassHive callback replay', async () => {
    const pendingProjection = {
      deliveryId: 'ghcd_projection_retry',
      originRef: 'ghi_projection_retry',
      status: 'delivery_unknown',
      projectionPendingAt: new Date('2026-08-24T12:00:00.000Z'),
      projectionNextAttemptAt: new Date('2026-08-24T12:00:00.000Z'),
    };
    mockFindDeliveries
      .mockReturnValueOnce(leanResult([pendingProjection]))
      .mockReturnValueOnce(leanResult([{ status: 'delivery_unknown' }]));

    await expect(reconcileGlassHiveSurfaceDeliveryProjections({ limit: 25 })).resolves.toEqual({
      scanned: 1,
      projected: 1,
      pending: 0,
    });

    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_projection_retry',
      state: 'unknown',
    });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        originRef: 'ghi_projection_retry',
        $or: expect.arrayContaining([{ projectionPendingAt: { $lte: expect.any(Date) } }]),
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          projectionPendingAt: null,
          projectionNextAttemptAt: null,
          projectionErrorCode: '',
          projectionAppliedAt: expect.any(Date),
        }),
      }),
    );
  });

  test('keeps a failed Core projection due for bounded retry', async () => {
    mockFindDeliveries
      .mockReturnValueOnce(
        leanResult([
          {
            deliveryId: 'ghcd_projection_failed',
            originRef: 'ghi_projection_failed',
            status: 'sent',
            projectionPendingAt: new Date('2026-08-24T12:00:00.000Z'),
          },
        ]),
      )
      .mockReturnValueOnce(leanResult([{ status: 'sent' }]));
    mockRecordGlassHiveSurfaceDeliveryOutcome.mockRejectedValueOnce(
      Object.assign(new Error('core unavailable'), { code: 'core_unavailable' }),
    );

    await expect(reconcileGlassHiveSurfaceDeliveryProjections({ limit: 25 })).resolves.toEqual({
      scanned: 1,
      projected: 0,
      pending: 1,
    });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { originRef: 'ghi_projection_failed' },
      expect.objectContaining({
        $set: expect.objectContaining({
          projectionErrorCode: 'core_unavailable',
          projectionNextAttemptAt: expect.any(Date),
        }),
        $inc: { projectionAttempts: 1 },
      }),
    );
  });

  test('delivery status failures redact tokens before persistence', async () => {
    mockFindOne.mockReturnValueOnce(
      leanResult({
        deliveryId: 'ghcd_secret',
        claimId: 'claim_secret',
        retryCount: 0,
      }),
    );
    mockFindOneAndUpdate
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_secret',
          claimId: 'claim_secret',
          status: 'failed',
          lastError: 'redacted',
        }),
      )
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_secret',
          claimId: 'claim_secret',
          status: 'suppressed',
          lastError: 'redacted',
        }),
      );

    const secretUrl =
      'https://api.telegram.org/bot1234567890:ABCdef_1234567890SECRET_TOKEN/sendMessage?access_token=raw-token';
    await markGlassHiveCallbackDeliveryFailed({
      deliveryId: 'ghcd_secret',
      claimId: 'claim_secret',
      error: `failed calling ${secretUrl}`,
    });
    await markGlassHiveCallbackDeliverySuppressed({
      deliveryId: 'ghcd_secret',
      claimId: 'claim_secret',
      reason: `suppressed after ${secretUrl}`,
    });

    const failedUpdate = mockFindOneAndUpdate.mock.calls[0][1];
    const suppressedUpdate = mockFindOneAndUpdate.mock.calls[1][1];
    expect(failedUpdate.$set.lastError).toContain('/bot<redacted>');
    expect(failedUpdate.$set.lastError).toContain('access_token=<redacted>');
    expect(suppressedUpdate.$set.lastError).toContain('/bot<redacted>');
    expect(JSON.stringify(failedUpdate)).not.toContain('ABCdef_1234567890SECRET_TOKEN');
    expect(JSON.stringify(suppressedUpdate)).not.toContain('ABCdef_1234567890SECRET_TOKEN');
    expect(JSON.stringify(failedUpdate)).not.toContain('raw-token');
    expect(JSON.stringify(suppressedUpdate)).not.toContain('raw-token');
  });

  test.each([
    ['failed', markGlassHiveCallbackDeliveryFailed],
    ['suppressed', markGlassHiveCallbackDeliverySuppressed],
  ])(
    'a post-projection %s transition re-arms and applies durable Core truth',
    async (status, mark) => {
      const existing = {
        deliveryId: `ghcd_projection_${status}`,
        claimId: `claim_projection_${status}`,
        originRef: `origin_projection_${status}`,
        surface: 'telegram',
        status: 'claimed',
        retryCount: 0,
        projectionPendingAt: null,
        projectionAppliedAt: new Date('2026-08-23T12:00:00.000Z'),
      };
      if (status === 'failed') mockFindOne.mockReturnValueOnce(leanResult(existing));
      mockFindOneAndUpdate.mockReturnValueOnce(leanResult({ ...existing, status }));
      mockFindDeliveries.mockReturnValueOnce(leanResult([{ status }]));

      await mark({
        deliveryId: existing.deliveryId,
        claimId: existing.claimId,
        ...(status === 'failed' ? { error: 'synthetic failure' } : { reason: 'synthetic silence' }),
      });

      expect(mockFindOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
        status,
        projectionPendingAt: expect.any(Date),
        projectionNextAttemptAt: expect.any(Date),
      });
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
        originRef: existing.originRef,
        state: status,
      });
      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({ originRef: existing.originRef }),
        expect.objectContaining({
          $set: expect.objectContaining({
            projectionPendingAt: null,
            projectionAppliedAt: expect.any(Date),
          }),
        }),
      );
    },
  );

  test('voice delivery claim and mark can be scoped to user and call session', async () => {
    mockFindOneAndUpdate
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_voice',
          callbackId: 'cb_voice',
          callbackMessageId: 'msg_callback',
          conversationId: 'conv_1',
          event: 'run.completed',
          surface: 'voice',
          status: 'claimed',
          text: 'Worker finished.',
          voiceCallSessionId: 'call_1',
          claimId: 'claim_voice',
          retryCount: 0,
        }),
      )
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_voice',
          callbackId: 'cb_voice',
          callbackMessageId: 'msg_callback',
          conversationId: 'conv_1',
          event: 'run.completed',
          surface: 'voice',
          status: 'sent',
          text: 'Worker finished.',
          voiceCallSessionId: 'call_1',
          claimId: 'claim_voice',
          retryCount: 0,
        }),
      );

    await claimPendingGlassHiveCallbackDeliveries({
      surface: 'voice',
      callbackId: 'cb_voice',
      userId: 'user_1',
      voiceCallSessionId: 'call_1',
    });
    await markGlassHiveCallbackDeliverySent({
      deliveryId: 'ghcd_voice',
      claimId: 'claim_voice',
      userId: 'user_1',
      voiceCallSessionId: 'call_1',
    });

    const claimFilter = mockFindOneAndUpdate.mock.calls[0][0];
    expect(claimFilter.userId).toBe('user_1');
    expect(claimFilter.voiceCallSessionId).toBe('call_1');
    const markFilter = mockFindOneAndUpdate.mock.calls[1][0];
    expect(markFilter.userId).toBe('user_1');
    expect(markFilter.voiceCallSessionId).toBe('call_1');
  });
});
