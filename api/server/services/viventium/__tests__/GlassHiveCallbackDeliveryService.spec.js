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
let mockTerminalCallbackResultUpdateOne;
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
let mockRecordVoiceOrchestrationTraceBestEffort;
let mockRecordVoiceOrchestrationTrace;
let mockTerminalTransactionService;
const mockRegisterDeliveryPresentation = jest.fn();
const mockHydrateDeliveryTask = jest.fn();
const mockFlushTaskPersistence = jest.fn();
const mockGetDeliveryTask = jest.fn();
const mockGetDeliveryTraceBinding = jest.fn();
const mockDeliverySnapshot = jest.fn();
jest.mock('../VoiceTaskService', () => ({
  registerVoiceTaskDeliveryPresentation: (...args) => mockRegisterDeliveryPresentation(...args),
  hydrateVoiceTaskByStreamId: (...args) => mockHydrateDeliveryTask(...args),
  flushVoiceTaskPersistence: (...args) => mockFlushTaskPersistence(...args),
  getVoiceTaskByStreamId: (...args) => mockGetDeliveryTask(...args),
  getVoiceTaskTraceBinding: (...args) => mockGetDeliveryTraceBinding(...args),
  snapshotEvent: (...args) => mockDeliverySnapshot(...args),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  acquireGlassHiveTerminalCallbackAcceptedOperationEffectLease: (...args) =>
    mockAcquireEffectLease(...args),
  fenceGlassHiveTerminalCallbackEffectTransaction: (...args) => mockFenceEffectTransaction(...args),
  releaseGlassHiveTerminalCallbackEffectLease: (...args) => mockReleaseEffectLease(...args),
  renewGlassHiveTerminalCallbackEffectLease: (...args) => mockRenewEffectLease(...args),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('~/db/models', () => ({
  GlassHiveTerminalCallbackResult: {
    findOne: (...args) => mockFindTerminalCallbackResult(...args),
    exists: (...args) => mockTerminalCallbackResultExists(...args),
    updateOne: (...args) => mockTerminalCallbackResultUpdateOne(...args),
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
  currentGlassHiveTerminalCallbackTransaction: () =>
    mockTerminalTransactionService?.currentGlassHiveTerminalCallbackTransaction() ?? null,
  runGlassHiveTerminalCallbackTransaction: (operation, options) =>
    mockTerminalTransactionService
      ? mockTerminalTransactionService.runGlassHiveTerminalCallbackTransaction(operation, options)
      : operation({ inTransaction: () => true }),
  deferGlassHiveTerminalCallbackAfterCommit: (operation) =>
    mockTerminalTransactionService?.deferGlassHiveTerminalCallbackAfterCommit(operation) ?? false,
}));

jest.mock('../GlassHiveCallbackBindingService', () => ({
  isGlassHiveNonterminalAttentionCallback:
    require('@librechat/api').createGlassHiveCallbackBindingService({})
      .isGlassHiveNonterminalAttentionCallback,
  fenceGlassHiveCallbackRunState: jest.fn().mockResolvedValue(null),
  recordGlassHiveSurfaceDeliveryOutcome: (...args) =>
    mockRecordGlassHiveSurfaceDeliveryOutcome(...args),
}));

jest.mock('../OrchestrationTraceLedgerService', () => ({
  recordOrchestrationTraceDelivery: (...args) => mockRecordTraceDelivery(...args),
}));

jest.mock('../VoiceOrchestrationTraceService', () => ({
  recordVoiceOrchestrationTrace: (...args) => mockRecordVoiceOrchestrationTrace(...args),
  recordVoiceOrchestrationTraceBestEffort: (...args) =>
    mockRecordVoiceOrchestrationTraceBestEffort(...args),
}));

jest.mock('~/server/services/TelegramLinkService', () => ({
  resolveTelegramMappingByUserId: (...args) => mockResolveTelegramMappingByUserId(...args),
}));

const {
  authorizeGlassHiveCallbackDeliveryDispatch,
  resolveGlassHiveVoicePresentation,
  completeGlassHiveWorkerCompletionPresentation,
  enqueueGlassHiveCallbackDelivery,
  claimPendingGlassHiveCallbackDeliveries,
  getSettledGlassHiveVoiceCallbackDelivery,
  markGlassHiveCallbackDeliverySent,
  markGlassHiveCallbackDeliveryFailed,
  markGlassHiveCallbackDeliverySuppressed,
  markGlassHiveCallbackDeliveryUnknown,
  releaseGlassHiveCallbackDeliveryDispatch,
  renewGlassHiveCallbackDeliveryDispatch,
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
    callbackKey: '',
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

function completionDiagnosticFixture(mode) {
  const { AsyncLocalStorage } = require('async_hooks');
  const {
    createGlassHiveTerminalCallbackTransactionService,
    createVoiceOrchestrationTraceService,
  } = require('@librechat/api');
  const storage = new AsyncLocalStorage();
  const createSession = () => {
    let active = false;
    return {
      startTransaction: jest.fn(() => {
        active = true;
      }),
      inTransaction: () => active,
      commitTransaction: jest.fn(async () => {
        active = false;
      }),
      abortTransaction: jest.fn(async () => {
        active = false;
      }),
      endSession: jest.fn(async () => {}),
    };
  };
  const session = createSession();
  let starts = 0;
  mockTerminalTransactionService = createGlassHiveTerminalCallbackTransactionService({
    transactionAsyncLocalStorage: storage,
    set: jest.fn(),
    startSession: async () => (starts++ === 0 ? session : createSession()),
  });
  const durable = jest.fn(async (input) => {
    expect(storage.getStore()).toBeUndefined();
    expect(session.inTransaction()).toBe(false);
    if (mode === 'store_failure') {
      throw Object.assign(new Error('trace store unavailable'), {
        code: 'trace_store_unavailable',
      });
    }
    return input;
  });
  const local = jest.fn();
  const service = createVoiceOrchestrationTraceService({
    logger: { warn: jest.fn() },
    recordOrchestrationTraceEvent: durable,
    orchestrationRuntimeTraceBinding: () =>
      mode === 'missing_identity'
        ? null
        : {
            contractVersion: 1,
            candidateDigest: `sha256:${'1'.repeat(64)}`,
            installedArtifactDigest: `sha256:${'2'.repeat(64)}`,
            runtimeOwnerBindingHash: `sha256:${'3'.repeat(64)}`,
          },
    logLocalTrace: (event) => {
      expect(storage.getStore()).toBeUndefined();
      expect(session.inTransaction()).toBe(false);
      local(event);
    },
  });
  mockRecordVoiceOrchestrationTrace = jest.fn(service.recordVoiceOrchestrationTrace);
  mockRecordVoiceOrchestrationTraceBestEffort = jest.fn(
    service.recordVoiceOrchestrationTraceBestEffort,
  );
  return {
    session,
    durable,
    local,
    run: mockTerminalTransactionService.runGlassHiveTerminalCallbackTransaction,
    assertTraceCount(count) {
      expect(session.commitTransaction).toHaveBeenCalled();
      expect(session.abortTransaction).not.toHaveBeenCalled();
      expect(mockRecordVoiceOrchestrationTrace).not.toHaveBeenCalled();
      expect(durable).toHaveBeenCalledTimes(mode === 'missing_identity' ? 0 : count);
      expect(local).toHaveBeenCalledTimes(mode === 'healthy' ? 0 : count);
      if (mode !== 'healthy') {
        expect(local).toHaveBeenCalledWith(
          expect.objectContaining({
            durableTrace: 'unavailable',
            code:
              mode === 'missing_identity'
                ? 'voice_trace_runtime_binding_unavailable'
                : 'trace_store_unavailable',
          }),
        );
      }
    },
  };
}

describe('GlassHiveCallbackDeliveryService', () => {
  describe('settled observer', () => {
    const row = () => ({
      deliveryId: 'delivery-sent',
      callbackId: canonicalCallbackRef('cb-terminal'),
      userId: 'owner-one',
      voiceCallSessionId: 'call-one',
      surface: 'voice',
      status: 'sent',
      terminalCallbackResultKey: 'ghtr_' + 'a'.repeat(64),
      terminalCallbackAcceptedOperationId: 'a'.repeat(32),
      terminalCallbackId: 'cb_terminal_' + 'a'.repeat(64),
      terminalCallbackResultDigest: 'sha256:' + 'a'.repeat(64),
      terminalCallbackResultRevision: 1,
      terminalCallbackEffectGeneration: 1,
    });
    const scope = {
      callbackId: 'cb-terminal',
      userId: 'owner-one',
      voiceCallSessionId: 'call-one',
    };
    test.each(['sent', 'suppressed'])(
      'reads only exact owner Call callback and current %s accepted operation',
      async (status) => {
        const current = { ...row(), status };
        mockFindOne.mockReturnValue(leanResult(current));
        mockFindTerminalCallbackResult.mockReturnValue(
          leanResult({ _id: current.terminalCallbackResultKey }),
        );
        expect(await getSettledGlassHiveVoiceCallbackDelivery(scope)).toEqual({
          deliveryId: current.deliveryId,
          callbackId: current.callbackId,
          userId: current.userId,
          voiceCallSessionId: current.voiceCallSessionId,
          status,
        });
        expect(mockFindOne).toHaveBeenCalledWith(
          expect.objectContaining({
            surface: 'voice',
            callbackId: current.callbackId,
            userId: 'owner-one',
            voiceCallSessionId: 'call-one',
            status: { $in: ['sent', 'suppressed'] },
          }),
        );
        expect(mockFindTerminalCallbackResult).toHaveBeenCalledWith(
          expect.objectContaining({
            _id: current.terminalCallbackResultKey,
            ownerId: 'owner-one',
            acceptedOperationId: current.terminalCallbackAcceptedOperationId,
            acceptedOperationGeneration: 1,
            callbackId: current.terminalCallbackId,
            resultDigest: current.terminalCallbackResultDigest,
            resultRevision: 1,
          }),
        );
        expect(mockUpdateOne).not.toHaveBeenCalled();
        expect(mockUpdateMany).not.toHaveBeenCalled();
      },
    );
    test('rejects missing pending foreign and superseded delivery truth', async () => {
      for (const current of [
        null,
        { ...row(), status: 'pending' },
        { ...row(), status: 'delivery_unknown' },
        { ...row(), status: 'failed' },
        { ...row(), status: 'unresolved' },
        { ...row(), status: 'superseded' },
        { ...row(), userId: 'foreign' },
        { ...row(), voiceCallSessionId: 'foreign' },
        { ...row(), callbackId: canonicalCallbackRef('foreign') },
        { ...row(), terminalCallbackResultKey: '' },
      ]) {
        mockFindOne.mockReturnValue(leanResult(current));
        expect(await getSettledGlassHiveVoiceCallbackDelivery(scope)).toBeNull();
      }
      mockFindOne.mockReturnValue(leanResult(row()));
      mockFindTerminalCallbackResult.mockReturnValue(leanResult(null));
      expect(await getSettledGlassHiveVoiceCallbackDelivery(scope)).toBeNull();
    });
    test('does not query an unscoped settled claim', async () => {
      for (const missing of ['callbackId', 'userId', 'voiceCallSessionId']) {
        expect(
          await getSettledGlassHiveVoiceCallbackDelivery({ ...scope, [missing]: '' }),
        ).toBeNull();
      }
      expect(mockFindOne).not.toHaveBeenCalled();
    });
  });
  beforeEach(() => {
    mockRegisterDeliveryPresentation.mockReset();
    mockHydrateDeliveryTask.mockReset().mockResolvedValue(null);
    mockFlushTaskPersistence.mockReset().mockResolvedValue(undefined);
    mockGetDeliveryTask.mockReset().mockReturnValue(null);
    mockGetDeliveryTraceBinding.mockReset().mockReturnValue(null);
    mockDeliverySnapshot.mockReset().mockReturnValue(null);
    mockFindOneAndUpdate = jest.fn();
    mockFindOne = jest.fn();
    mockFindTerminalCallbackResult = jest.fn().mockReturnValue(leanResult(null));
    mockTerminalCallbackResultUpdateOne = jest.fn(() => ({
      exec: async () => ({ matchedCount: 1 }),
    }));
    mockTerminalCallbackResultExists = jest.fn().mockReturnValue(leanResult(null));
    mockFindDeliveries = jest.fn().mockReturnValue(leanResult([]));
    mockCountDocuments = jest.fn();
    mockUpdateOne = jest.fn().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    mockUpdateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    mockRecordGlassHiveSurfaceDeliveryOutcome = jest.fn().mockResolvedValue(null);
    mockResolveTelegramMappingByUserId = jest.fn().mockResolvedValue(null);
    mockRecordTraceDelivery = jest.fn().mockResolvedValue(null);
    mockRecordVoiceOrchestrationTraceBestEffort = jest.fn().mockResolvedValue(null);
    mockRecordVoiceOrchestrationTrace = jest.fn().mockResolvedValue(null);
    mockTerminalTransactionService = undefined;
    mockMessageFindOne = jest.fn().mockReturnValue(leanResult(null));
    mockAcquireEffectLease = jest.fn();
    mockFenceEffectTransaction = jest.fn().mockResolvedValue(true);
    mockReleaseEffectLease = jest.fn().mockResolvedValue(true);
    mockRenewEffectLease = jest.fn().mockResolvedValue(true);
  });

  describe('Main-authored nonterminal attention Voice authority', () => {
    let collectionSpy;
    let currentWork;
    let evidence;
    let evidenceRows;
    let fixture;
    beforeEach(() => {
      const binding = {
        kind: 'nonterminal_attention',
        originRef: 'origin-attention',
        workRef: 'work-attention',
        workerId: 'worker-attention',
        runId: 'run-attention',
        callbackRef: canonicalCallbackRef('cb-attention'),
        event: 'run.needs_input',
        workTerminal: false,
        evidenceId: 'ghe_' + 'a'.repeat(32),
      };
      const { buildVoiceWorkerCompletionPresentation } = require('@librechat/api');
      const presentation = buildVoiceWorkerCompletionPresentation({
        ownerId: 'owner-attention',
        conversationId: 'conversation-attention',
        callSessionId: 'call-attention',
        responseMessageId: 'authored-attention',
        responseText: 'May I renew access to continue?',
        bindings: [binding],
      });
      const row = {
        deliveryId: 'delivery-attention',
        claimId: 'claim-attention',
        surface: 'voice',
        status: 'claimed',
        userId: 'owner-attention',
        conversationId: 'conversation-attention',
        originRef: binding.originRef,
        workRef: binding.workRef,
        workerId: binding.workerId,
        runId: binding.runId,
        callbackId: binding.callbackRef,
        callbackMessageId: presentation.responseMessageId,
        voiceCallSessionId: presentation.callSessionId,
        voiceRequestId: presentation.turnId,
        event: 'main.followup',
        text: 'May I renew access to continue?',
        workerCompletionPresentation: presentation,
        workerCompletionEffectLeases: [],
        dispatchPermitId: '',
        dispatchPermitGeneration: 0,
        dispatchPermitExpiresAt: null,
      };
      fixture = { row, presentation };
      evidence = {
        _id: binding.evidenceId,
        ownerId: row.userId,
        originRef: binding.originRef,
        workRef: binding.workRef,
        workerId: binding.workerId,
        runId: binding.runId,
        callbackRef: binding.callbackRef,
        event: binding.event,
        workTerminal: false,
        workState: 'needs_input',
        followUpMessageId: row.callbackMessageId,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      };
      evidenceRows = [evidence];
      currentWork = {
        _id: binding.originRef,
        ownerId: row.userId,
        workRef: binding.workRef,
        workerId: binding.workerId,
        runId: binding.runId,
        externalState: 'needs_input',
      };
      collectionSpy = jest
        .spyOn(require('mongoose').connection, 'collection')
        .mockImplementation((name) => ({
          findOne: jest.fn(async (filter, options) => {
            const candidates =
              name === 'viventium_glasshive_mission_evidence' ? evidenceRows : [currentWork];
            return (
              candidates
                .filter(
                  (candidate) =>
                    candidate &&
                    Object.entries(filter).every(([key, value]) => candidate[key] === value),
                )
                .sort((left, right) => {
                  for (const [key, direction] of Object.entries(options?.sort || {})) {
                    const a = left[key],
                      b = right[key];
                    if (a === b) continue;
                    if (a == null) return 1;
                    if (b == null) return -1;
                    return (a > b ? 1 : -1) * direction;
                  }
                  return 0;
                })[0] || null
            );
          }),
        }));
      mockFindOne.mockImplementation(() => leanResult(fixture.row));
      mockMessageFindOne.mockImplementation(() =>
        leanResult({ messageId: fixture.row.callbackMessageId, text: fixture.row.text }),
      );
      mockFindOneAndUpdate.mockImplementation((_filter, update) => {
        fixture.row = { ...fixture.row, ...update.$set };
        return leanResult(fixture.row);
      });
    });
    afterEach(() => collectionSpy.mockRestore());
    const authorize = () =>
      authorizeGlassHiveCallbackDeliveryDispatch({
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        userId: fixture.row.userId,
        voiceCallSessionId: fixture.row.voiceCallSessionId,
      });
    test.each([
      ['voice', 'sent'],
      ['voice', 'delivery_unknown'],
      ['telegram', 'sent'],
      ['telegram', 'delivery_unknown'],
    ])(
      'projects the existing %s %s attention receipt without terminal authority or a resend',
      async (surface, status) => {
        fixture.row = {
          ...fixture.row,
          surface,
          status,
          projectionPendingAt: new Date(),
          ...(surface === 'telegram'
            ? {
                workerCompletionBindings: fixture.presentation.bindings,
                workerCompletionPresentation: null,
              }
            : {}),
        };
        // Delivery already settled; a later Resume must not invalidate its historical receipt.
        currentWork.externalState = 'running';
        mockFindDeliveries
          .mockReturnValueOnce(leanResult([fixture.row]))
          .mockReturnValue(leanResult([{ status }]));
        expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({
          projected: 1,
          pending: 0,
        });
        expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            originRef: fixture.row.originRef,
            state: status === 'sent' ? 'sent' : 'unknown',
            workerCompletion: {
              ownerId: fixture.row.userId,
              responseMessageId: fixture.row.callbackMessageId,
              binding: fixture.presentation.bindings[0],
            },
          }),
        );
        expect(mockTerminalCallbackResultUpdateOne).not.toHaveBeenCalled();
        expect(mockAcquireEffectLease).not.toHaveBeenCalled();
        expect(mockUpdateMany).toHaveBeenCalledWith(
          expect.any(Object),
          expect.objectContaining({
            $set: expect.objectContaining({ projectionPendingAt: null, projectionErrorCode: '' }),
          }),
          expect.any(Object),
        );
        expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      },
    );
    test('strict persistence retains the attention union and rejects terminal fields on it', async () => {
      const mongoose = require('mongoose');
      const connection = mongoose.createConnection();
      const Model = require('../../../../db/viventiumGlassHiveCallbackDelivery')(connection);
      const valid = new Model({ workerCompletionPresentation: fixture.presentation });
      expect(valid.workerCompletionPresentation.toObject().bindings).toEqual(
        fixture.presentation.bindings,
      );
      await expect(
        valid.workerCompletionPresentation.bindings[0].validate(),
      ).resolves.toBeUndefined();
      const invalid = new Model({
        workerCompletionPresentation: {
          ...fixture.presentation,
          bindings: [{ ...fixture.presentation.bindings[0], attemptNumber: 1 }],
        },
      });
      await expect(invalid.workerCompletionPresentation.bindings[0].validate()).rejects.toThrow(
        'binding_invalid',
      );
    });
    test('mints and completes one response permit without any terminal operation lease', async () => {
      const permit = await authorize();
      expect(permit).toMatchObject({
        resultRevision: 1,
        resultDigest: fixture.presentation.responseDigest,
      });
      expect(mockAcquireEffectLease).not.toHaveBeenCalled();
      expect(
        await resolveGlassHiveVoicePresentation({
          deliveryId: fixture.row.deliveryId,
          claimId: fixture.row.claimId,
          userId: fixture.row.userId,
          voiceCallSessionId: fixture.row.voiceCallSessionId,
          conversationId: fixture.row.conversationId,
          dispatchPermit: permit,
          presentationRef: fixture.presentation.presentationRef,
          turnId: fixture.presentation.turnId,
        }),
      ).not.toBeNull();
      const input = {
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        userId: fixture.row.userId,
        voiceCallSessionId: fixture.row.voiceCallSessionId,
        dispatchPermit: permit,
        presentationRef: fixture.presentation.presentationRef,
      };
      expect(await completeGlassHiveWorkerCompletionPresentation(input)).toMatchObject({
        status: 'sent',
      });
      mockFindOne.mockReturnValue(leanResult(null));
      expect(await completeGlassHiveWorkerCompletionPresentation(input)).toBeNull();
      expect(mockFenceEffectTransaction).not.toHaveBeenCalled();
      expect(mockReleaseEffectLease).not.toHaveBeenCalled();
    });
    test('authorizes and settles the exact persisted attention presentation once', async () => {
      const mongoose = require('mongoose');
      const connection = mongoose.createConnection();
      const Model = require('../../../../db/viventiumGlassHiveCallbackDelivery')(connection);
      const persisted = new Model({
        workerCompletionPresentation: fixture.presentation,
      }).workerCompletionPresentation.toObject();
      expect(Object.keys(persisted.bindings[0])).not.toEqual(
        Object.keys(fixture.presentation.bindings[0]),
      );
      fixture.row.workerCompletionPresentation = persisted;
      const permit = await authorize();
      expect(permit).toMatchObject({ resultRevision: 1, resultDigest: persisted.responseDigest });
      expect(
        await resolveGlassHiveVoicePresentation({
          deliveryId: fixture.row.deliveryId,
          claimId: fixture.row.claimId,
          userId: fixture.row.userId,
          voiceCallSessionId: fixture.row.voiceCallSessionId,
          conversationId: fixture.row.conversationId,
          dispatchPermit: permit,
          presentationRef: persisted.presentationRef,
          turnId: persisted.turnId,
        }),
      ).not.toBeNull();
      const input = {
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        userId: fixture.row.userId,
        voiceCallSessionId: fixture.row.voiceCallSessionId,
        dispatchPermit: permit,
        presentationRef: persisted.presentationRef,
      };
      expect(await completeGlassHiveWorkerCompletionPresentation(input)).toMatchObject({
        status: 'sent',
      });
      expect(mockAcquireEffectLease).not.toHaveBeenCalled();
      expect(mockFenceEffectTransaction).not.toHaveBeenCalled();
      expect(mockReleaseEffectLease).not.toHaveBeenCalled();
    });
    test.each([
      { ownerId: 'foreign' },
      { workRef: 'foreign-work' },
      { runId: 'newer-run' },
      { externalState: 'running' },
      { externalState: 'cancelled' },
    ])('rejects stale or foreign current work %p before permit', async (change) => {
      currentWork = { ...currentWork, ...change };
      expect(await authorize()).toBeNull();
      expect(mockAcquireEffectLease).not.toHaveBeenCalled();
    });
    test('superseded attention cannot claim the durable delivery task', async () => {
      fixture.row.status = 'pending';
      currentWork.runId = 'superseding-run';
      mockFindOne.mockReturnValueOnce(leanResult(fixture.row)).mockReturnValue(leanResult(null));
      expect(
        await claimPendingGlassHiveCallbackDeliveries({
          surface: 'voice',
          callbackId: fixture.row.callbackId,
          userId: fixture.row.userId,
          voiceCallSessionId: fixture.row.voiceCallSessionId,
          limit: 1,
        }),
      ).toEqual([]);
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: fixture.row.deliveryId }),
        expect.objectContaining({ $set: expect.objectContaining({ status: 'superseded' }) }),
      );
    });
    test('rejects a foreign authored message association', async () => {
      evidence.followUpMessageId = 'other-response';
      expect(await authorize()).toBeNull();
    });
    test('Telegram uses the same authored evidence permit and settles returned text/audio receipts once', async () => {
      fixture.row = {
        ...fixture.row,
        surface: 'telegram',
        telegramChatId: 'chat-attention',
        workerCompletionBindings: fixture.presentation.bindings,
        workerCompletionPresentation: null,
      };
      const permit = await authorize();
      expect(permit).toMatchObject({
        surface: 'telegram',
        resultDigest: fixture.presentation.responseDigest,
      });
      const renewed = await renewGlassHiveCallbackDeliveryDispatch({
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        userId: fixture.row.userId,
        dispatchPermit: permit,
      });
      expect(renewed).not.toBeNull();
      const input = {
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        userId: fixture.row.userId,
        dispatchPermit: renewed,
        telegramMessageIds: ['101', '102'],
      };
      expect(await markGlassHiveCallbackDeliverySent(input)).toMatchObject({
        status: 'sent',
        telegramSentMessageIds: ['101', '102'],
      });
      mockFindOne.mockReturnValue(leanResult(null));
      mockFindOneAndUpdate.mockReturnValue(leanResult(null));
      expect(await markGlassHiveCallbackDeliverySent(input)).toBeNull();
      expect(mockAcquireEffectLease).not.toHaveBeenCalled();
    });
    test('same-run A then Resume then B allows only the newest blocker to claim or receive a permit', async () => {
      const first = { ...fixture.row };
      currentWork.externalState = 'running';
      currentWork.externalState = 'needs_input';
      const newest = {
        ...evidence,
        _id: 'ghe_' + 'b'.repeat(32),
        callbackRef: canonicalCallbackRef('cb-B'),
        followUpMessageId: 'authored-B',
        createdAt: new Date('2026-01-01T00:01:00Z'),
      };
      evidenceRows.push(newest);
      expect(await authorize()).toBeNull();
      mockFindOne.mockReturnValueOnce(leanResult(first)).mockReturnValueOnce(leanResult(null));
      expect(
        await claimPendingGlassHiveCallbackDeliveries({
          surface: 'voice',
          callbackId: first.callbackId,
          userId: first.userId,
          voiceCallSessionId: first.voiceCallSessionId,
          limit: 1,
        }),
      ).toEqual([]);
      const binding = {
        ...fixture.presentation.bindings[0],
        evidenceId: newest._id,
        callbackRef: newest.callbackRef,
      };
      const presentation = require('@librechat/api').buildVoiceWorkerCompletionPresentation({
        ownerId: first.userId,
        conversationId: first.conversationId,
        callSessionId: first.voiceCallSessionId,
        responseMessageId: newest.followUpMessageId,
        responseText: first.text,
        bindings: [binding],
      });
      fixture.presentation = presentation;
      fixture.row = {
        ...first,
        deliveryId: 'delivery-B',
        claimId: 'claim-B',
        callbackId: newest.callbackRef,
        callbackMessageId: newest.followUpMessageId,
        voiceRequestId: presentation.turnId,
        workerCompletionPresentation: presentation,
      };
      mockFindOne.mockImplementation(() => leanResult(fixture.row));
      expect(await authorize()).not.toBeNull();
    });

    test('older native A retry accepted after B cannot displace B or gain a permit', async () => {
      evidence.callbackCreatedAt = '2026-01-01T00:00:00.000001Z';
      evidence.createdAt = new Date('2026-01-01T00:03:00Z'); // A arrives late after a failed send.
      const newer = {
        ...evidence,
        _id: 'ghe_' + 'b'.repeat(32),
        callbackRef: canonicalCallbackRef('cb-B'),
        followUpMessageId: 'authored-B',
        callbackCreatedAt: '2026-01-01T00:00:00.000002Z',
        createdAt: new Date('2026-01-01T00:02:00Z'),
      };
      evidenceRows.push(newer);
      expect(await authorize()).toBeNull();
      const presentation = require('@librechat/api').buildVoiceWorkerCompletionPresentation({
        ownerId: fixture.row.userId,
        conversationId: fixture.row.conversationId,
        callSessionId: fixture.row.voiceCallSessionId,
        responseMessageId: newer.followUpMessageId,
        responseText: fixture.row.text,
        bindings: [
          {
            ...fixture.presentation.bindings[0],
            evidenceId: newer._id,
            callbackRef: newer.callbackRef,
          },
        ],
      });
      fixture.presentation = presentation;
      fixture.row = {
        ...fixture.row,
        deliveryId: 'delivery-B',
        claimId: 'claim-B',
        callbackId: newer.callbackRef,
        callbackMessageId: newer.followUpMessageId,
        voiceRequestId: presentation.turnId,
        workerCompletionPresentation: presentation,
      };
      expect(await authorize()).not.toBeNull();
    });
    test('equal native creation clocks use stable evidence identity rather than retry arrival time', async () => {
      evidence.callbackCreatedAt = '2026-01-01T00:00:00.123456Z';
      evidence.createdAt = new Date('2026-01-01T00:03:00Z');
      evidenceRows.push({
        ...evidence,
        _id: 'ghe_' + 'b'.repeat(32),
        createdAt: new Date('2026-01-01T00:02:00Z'),
      });
      expect(await authorize()).toBeNull();
    });

    test('an unclocked legacy callback cannot displace accepted native-clock evidence', async () => {
      evidence.createdAt = new Date('2026-01-01T00:03:00Z');
      evidenceRows.push({
        ...evidence,
        _id: 'ghe_' + 'b'.repeat(32),
        callbackCreatedAt: '2026-01-01T00:00:00.000002Z',
        createdAt: new Date('2026-01-01T00:02:00Z'),
      });
      expect(await authorize()).toBeNull();
    });

    test('Resume and a newer blocker before Voice ACK preserve only the original exact issued receipt', async () => {
      const permit = await authorize();
      currentWork.externalState = 'running';
      evidenceRows.push({
        ...evidence,
        _id: 'ghe_' + 'b'.repeat(32),
        callbackRef: canonicalCallbackRef('cb-B'),
        createdAt: new Date('2026-01-01T00:01:00Z'),
      });
      const input = {
        deliveryId: fixture.row.deliveryId,
        claimId: fixture.row.claimId,
        userId: fixture.row.userId,
        voiceCallSessionId: fixture.row.voiceCallSessionId,
        dispatchPermit: permit,
        presentationRef: fixture.presentation.presentationRef,
      };
      expect(
        await completeGlassHiveWorkerCompletionPresentation({
          ...input,
          dispatchPermit: { ...permit, permitId: 'f'.repeat(32) },
        }),
      ).toBeNull();
      expect(await completeGlassHiveWorkerCompletionPresentation(input)).toMatchObject({
        status: 'sent',
      });
      mockFindOne.mockReturnValue(leanResult(null));
      expect(await completeGlassHiveWorkerCompletionPresentation(input)).toBeNull();
      expect(mockAcquireEffectLease).not.toHaveBeenCalled();
    });

    test.each(['sent', 'delivery_unknown'])(
      'Resume before Telegram %s ACK settles the original permit once',
      async (status) => {
        fixture.row = {
          ...fixture.row,
          surface: 'telegram',
          telegramChatId: 'chat-attention',
          workerCompletionBindings: fixture.presentation.bindings,
          workerCompletionPresentation: null,
        };
        const permit = await authorize();
        currentWork.externalState = 'running';
        const input = {
          deliveryId: fixture.row.deliveryId,
          claimId: fixture.row.claimId,
          userId: fixture.row.userId,
          dispatchPermit: permit,
          telegramMessageIds: ['101', '102'],
        };
        const settle =
          status === 'sent'
            ? markGlassHiveCallbackDeliverySent
            : markGlassHiveCallbackDeliveryUnknown;
        expect(
          await settle({ ...input, dispatchPermit: { ...permit, permitId: 'f'.repeat(32) } }),
        ).toBeNull();
        expect(await settle(input)).toMatchObject({ status });
        expect(mockUpdateOne).toHaveBeenCalledWith(
          expect.objectContaining({ dispatchPermitId: permit.permitId }),
          expect.objectContaining({
            $addToSet: { telegramSentMessageIds: { $each: ['101', '102'] } },
          }),
        );
        mockFindOne.mockReturnValue(leanResult(null));
        mockFindOneAndUpdate.mockReturnValue(leanResult(null));
        expect(await settle(input)).toBeNull();
        expect(mockAcquireEffectLease).not.toHaveBeenCalled();
      },
    );

    test('a resumed work invalidates the existing permit at resolution and renewal', async () => {
      const permit = await authorize();
      currentWork.externalState = 'running';
      expect(
        await resolveGlassHiveVoicePresentation({
          deliveryId: fixture.row.deliveryId,
          claimId: fixture.row.claimId,
          userId: fixture.row.userId,
          voiceCallSessionId: fixture.row.voiceCallSessionId,
          conversationId: fixture.row.conversationId,
          dispatchPermit: permit,
          presentationRef: fixture.presentation.presentationRef,
          turnId: fixture.presentation.turnId,
        }),
      ).toBeNull();
      expect(
        await renewGlassHiveCallbackDeliveryDispatch({
          deliveryId: fixture.row.deliveryId,
          claimId: fixture.row.claimId,
          dispatchPermit: permit,
          userId: fixture.row.userId,
          voiceCallSessionId: fixture.row.voiceCallSessionId,
        }),
      ).toBeNull();
    });
    test('ended Call settles the exact issued response without claiming audio completed', async () => {
      const permit = await authorize();
      expect(
        await markGlassHiveCallbackDeliveryUnknown({
          deliveryId: fixture.row.deliveryId,
          claimId: fixture.row.claimId,
          dispatchPermit: permit,
          userId: fixture.row.userId,
          voiceCallSessionId: fixture.row.voiceCallSessionId,
          reason: 'call_ended',
        }),
      ).not.toBeNull();
      expect(fixture.row.workerCompletionAudioCompletedAt).toBeUndefined();
    });
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

  test('wakes Telegram only after its pending outbox transaction commits', async () => {
    const { claimTelegramDeliveriesWhenReady } = require('@librechat/api');
    const afterCommit = [];
    mockTerminalTransactionService = {
      currentGlassHiveTerminalCallbackTransaction: () => null,
      deferGlassHiveTerminalCallbackAfterCommit: (operation) => {
        afterCommit.push(operation);
        return true;
      },
    };
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    let committed = false;
    const claim = jest.fn(async () => (committed ? [{ deliveryId: 'committed-only' }] : []));
    const waiting = claimTelegramDeliveriesWhenReady(claim, 5_000);
    const result = await enqueueGlassHiveCallbackDelivery({
      body: { callback_id: 'callback-main-wake', event: 'main.followup' },
      deliveryContext: {
        ownerId: 'user-wake',
        conversationId: 'conversation-wake',
        anchorMessageId: 'anchor-wake',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat-wake', telegramUserId: 'telegram-wake' },
        ],
      },
      message: { messageId: 'main-wake', text: 'Ready.' },
      text: 'Ready.',
    });
    expect(result.deliveries[0].status).toBe('pending');
    expect(claim).toHaveBeenCalledTimes(1);
    expect(afterCommit).toHaveLength(1);
    committed = true;
    await afterCommit[0]();
    await expect(waiting).resolves.toEqual([{ deliveryId: 'committed-only' }]);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  test('retains the authored file carrier through the existing Main delivery projection', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    const attachments = [
      {
        user: 'user_1',
        file_id: 'file-1',
        filename: 'result.png',
        filepath: '/uploads/result.png',
        bytes: 3,
        type: 'image/png',
        source: 'local',
        object: 'file',
        nativeOutputFile: {
          version: 1,
          status: 'available',
          messageId: 'main-message',
          downloadUrl: 'https://files.example.test/v1/link-refs/synthetic-grant',
        },
      },
      {
        filename: 'unavailable.csv',
        messageId: 'main-message',
        nativeOutputFile: {
          version: 1,
          status: 'unavailable',
          code: 'native_output_file_digest_mismatch',
        },
      },
    ];
    const result = await enqueueGlassHiveCallbackDelivery({
      body: { callback_id: 'callback-main', event: 'main.followup' },
      deliveryContext: {
        ownerId: 'user_1',
        conversationId: 'conv_1',
        anchorMessageId: 'anchor-1',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat-1', telegramUserId: 'telegram-1' },
        ],
      },
      message: {
        messageId: 'main-message',
        text: 'Here is the result.',
        attachments,
        content: [{ type: 'text', text: '[Web File](/files/user_1/file-1/result.png)' }],
      },
      text: 'Here is the result.',
    });
    expect(mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert.attachments).toEqual(attachments);
    expect(result.deliveries[0].attachments).toEqual(attachments);
    expect(result.deliveries[0].text).toBe('Here is the result.');
  });

  test.each(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'])(
    'keeps raw %s lifecycle prose out of conversation delivery',
    async (event) => {
      const result = await enqueueGlassHiveCallbackDelivery({
        body: { callback_id: 'callback-state', event, full_message: 'Internal evidence.' },
        deliveryContext: {
          ownerId: 'owner',
          conversationId: 'conversation',
          destinations: [{ surface: 'telegram', telegramChatId: 'chat' }],
        },
        message: { messageId: 'callback-message', text: 'Internal status.' },
        text: 'Internal status.',
      });
      expect(result).toMatchObject({ enqueued: 0, deferredToMain: true });
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  test('Main presentation identity excludes raw callback rows and cannot rewrite a sent receipt', async () => {
    const rows = new Map();
    const rawKey = `owner:origin:telegram:${canonicalCallbackRef('same-callback')}`;
    rows.set(rawKey, { deliveryKey: rawKey, status: 'sent', text: 'Internal state.' });
    mockFindOneAndUpdate.mockImplementation((filter, update) => {
      expect(filter).toEqual({ deliveryKey: expect.any(String) });
      const key = filter.deliveryKey;
      if (!rows.has(key)) rows.set(key, { ...update.$setOnInsert });
      return leanResult({ ...rows.get(key) });
    });
    const input = {
      body: { callback_id: 'same-callback', event: 'main.followup' },
      deliveryContext: {
        ownerId: 'owner',
        originRef: 'origin',
        conversationId: 'conversation',
        destinations: [{ surface: 'telegram', telegramChatId: 'chat' }],
      },
      message: { messageId: 'main-one', text: 'Useful result.' },
      text: 'Useful result.',
    };
    const first = await enqueueGlassHiveCallbackDelivery(input);
    const firstRow = rows.get(mockFindOneAndUpdate.mock.calls[0][0].deliveryKey);
    firstRow.status = 'sent';
    const replay = await enqueueGlassHiveCallbackDelivery({
      ...input,
      text: 'Changed replay prose.',
    });
    expect(replay.deliveries[0]).toMatchObject({ status: 'sent', text: 'Useful result.' });
    const later = await enqueueGlassHiveCallbackDelivery({
      ...input,
      message: { messageId: 'main-two', text: 'Another useful result.' },
      text: 'Another useful result.',
    });
    expect(later.deliveries[0].deliveryId).not.toBe(first.deliveries[0].deliveryId);
    expect(rows.get(rawKey)).toMatchObject({ status: 'sent', text: 'Internal state.' });
    expect(rows.size).toBe(3);
  });

  test.each(['run.blocked', 'checkpoint.ready', 'takeover.requested'])(
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

  test('keeps raw native attention out of Telegram while Main authors its useful question', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    const nativeCallback = require('./fixtures/nativePermissionCallback.json');
    const pending = {
      ...nativeCallback.pending_native_input,
      message: 'not persisted',
      arguments: 'not persisted',
    };
    const result = await enqueueGlassHiveCallbackDelivery({
      body: {
        ...nativeCallback,
        pending_native_input: pending,
        telegram_message_thread_id: 'attacker-topic',
      },
      deliveryContext: {
        ownerId: 'owner-1',
        conversationId: 'conversation-1',
        workRef: 'work-1',
        destinations: [
          {
            surface: 'telegram',
            telegramChatId: 'chat-1',
            telegramUserId: 'telegram-1',
            telegramMessageThreadId: '9',
          },
        ],
      },
      message: { messageId: 'callback-1', text: 'Input needed.' },
      text: 'Input needed.',
    });
    expect(result).toMatchObject({ configured: 1, enqueued: 0, deferredToMain: true });
    expect(result.deliveries).toEqual([]);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test('a different-run attention binding cannot become actionable callback identity', async () => {
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    const result = await enqueueGlassHiveCallbackDelivery({
      body: {
        callback_id: 'cb_foreign_permission',
        event: 'run.needs_input',
        run_id: 'run-1',
        nativeextras: {
          pending_native_input: {
            version: 1,
            requestId: 'input-1',
            requestFingerprint: 'a'.repeat(64),
            runId: 'run-other',
            attemptId: 'attempt-1',
            sessionId: 'session-1',
            expiresAt: '2099-01-01T00:00:00Z',
          },
        },
      },
      deliveryContext: {
        ownerId: 'owner-1',
        conversationId: 'conversation-1',
        destinations: [
          { surface: 'telegram', telegramChatId: 'chat-1', telegramUserId: 'telegram-1' },
        ],
      },
      message: { messageId: 'callback-other', text: 'Input needed.' },
      text: 'Input needed.',
    });
    expect(result).toMatchObject({ enqueued: 0, deferredToMain: true });
    expect(result.deliveries).toEqual([]);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test.each(['skip', 'eligible'])(
    'saved %s audio disposition applies only to Voice and preserves Telegram text/files',
    async (audio) => {
      const { row, presentation, bindings } = workerCompletionFixture();
      const binding = bindings[0];
      mockFindTerminalCallbackResult.mockReturnValue(leanResult({ _id: binding.resultKey }));
      mockFindOneAndUpdate.mockImplementation((_query, update) =>
        leanResult({ ...update.$setOnInsert, ...update.$set }),
      );
      const attachment = { file_id: 'synthetic-owned-file', filename: 'result.md' };
      const summary = await enqueueGlassHiveCallbackDelivery({
        body: {
          callback_id: binding.terminalCallbackId,
          event: 'main.followup',
          origin_ref: binding.originRef,
          work_ref: binding.workRef,
          worker_id: binding.workerId,
          run_id: binding.runId,
          attempt_number: binding.attemptNumber,
        },
        message: {
          messageId: row.callbackMessageId,
          text: row.text,
          attachments: [attachment],
          metadata: {
            viventium: {
              deliveryDisposition: {
                version: 1,
                audio,
                required: true,
                valid: true,
                source: 'model',
              },
            },
          },
        },
        deliveryContext: {
          ownerId: row.userId,
          conversationId: row.conversationId,
          originRef: row.originRef,
          workRef: row.workRef,
          workerCompletionPresentation: presentation,
          traceIdentity: { callbackRef: binding.callbackRef, attemptNumber: binding.attemptNumber },
          destinations: [
            { surface: 'voice', voiceCallSessionId: row.voiceCallSessionId },
            {
              surface: 'telegram',
              telegramChatId: 'synthetic-chat',
              telegramUserId: 'synthetic-linked-user',
            },
          ],
        },
      });
      expect(summary.deliveries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            surface: 'voice',
            status: audio === 'skip' ? 'suppressed' : 'pending',
            text: row.text,
            attachments: [attachment],
          }),
          expect.objectContaining({
            surface: 'telegram',
            status: 'pending',
            text: row.text,
            attachments: [attachment],
          }),
        ]),
      );
      if (audio === 'skip') expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
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

    expect(result).toMatchObject({ configured: 0, enqueued: 0, unresolved: 0, deliveries: [] });
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
    expect(firstFilter).toEqual({
      deliveryKey: 'owner_a:ghi_owner_a_origin:telegram:main:msg_main_followup',
    });
    expect(secondFilter).toEqual({
      deliveryKey: 'owner_b:ghi_owner_b_origin:telegram:main:msg_main_followup',
    });
    expect(firstFilter.deliveryKey).not.toBe(secondFilter.deliveryKey);
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
        event: 'main.followup',
        run_id: 'run-exact',
        work_ref: 'work-exact',
      },
      deliveryContext: {
        ownerId: 'owner-exact',
        originRef: 'origin-exact',
        workRef: 'work-exact',
        conversationId: 'conversation-exact',
        traceIdentity: { callbackRef, attemptNumber: 3 },
        traceCallbackEvent: 'run.failed',
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
        event: 'run.blocked',
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

  test.each(
    ['run.cancelled', 'run.interrupted', 'run.failed'].flatMap((event) =>
      ['librechat', 'telegram'].map((surface) => [event, surface]),
    ),
  )('delivers an exact accepted pre-runtime %s result through %s', async (event, surface) => {
    const transaction = completionDiagnosticFixture('healthy');
    const terminalResult = {
      _id: 'ghtr_' + 'a'.repeat(64),
      ownerId: 'owner-pre-runtime',
      originRef: 'origin-pre-runtime',
      workRef: 'work-pre-runtime',
      workerId: 'worker-pre-runtime',
      runId: 'run-pre-runtime',
      attemptNumber: 0,
      callbackId: 'cb_terminal_' + 'b'.repeat(64),
      resultDigest: 'sha256:' + 'c'.repeat(64),
      resultRevision: 1,
      acceptedOperationId: 'd'.repeat(32),
      acceptedOperationGeneration: 1,
      resultState: event === 'run.failed' ? 'failed' : 'cancelled',
    };
    const callbackRef = canonicalCallbackRef(terminalResult.callbackId);
    const lease = {
      resultKey: terminalResult._id,
      acceptedOperationId: terminalResult.acceptedOperationId,
      acceptedOperationGeneration: 1,
      generation: 1,
      leaseId: 'e'.repeat(32),
      callbackId: terminalResult.callbackId,
      resultDigest: terminalResult.resultDigest,
      resultRevision: 1,
    };
    const message = {
      messageId: 'followup-pre-runtime',
      text: 'The work stopped before it started.',
    };
    mockAcquireEffectLease.mockResolvedValue(lease);
    // The native accepted-result owner stores pre-runtime null as zero.
    mockFindTerminalCallbackResult.mockImplementation((query) =>
      leanResult(
        !Object.hasOwn(query, 'attemptNumber') ||
          query.attemptNumber === terminalResult.attemptNumber
          ? terminalResult
          : null,
      ),
    );
    mockMessageFindOne.mockReturnValue(leanResult(message));
    mockFindOneAndUpdate.mockImplementation((_query, update) =>
      leanResult({ ...update.$setOnInsert, ...update.$set }),
    );
    const result = await transaction.run(() =>
      enqueueGlassHiveCallbackDelivery({
        body: {
          callback_id: terminalResult.callbackId,
          attempt_number: null,
          event: 'main.followup',
          worker_id: terminalResult.workerId,
          run_id: terminalResult.runId,
          work_ref: terminalResult.workRef,
        },
        deliveryContext: {
          ownerId: terminalResult.ownerId,
          originRef: terminalResult.originRef,
          workRef: terminalResult.workRef,
          conversationId: 'conversation-pre-runtime',
          traceIdentity: { callbackRef, attemptNumber: null },
          traceCallbackEvent: event,
          destinations: [
            {
              surface,
              conversationId: 'conversation-pre-runtime',
              telegramChatId: 'chat-pre-runtime',
            },
          ],
        },
        message,
        text: message.text,
      }),
    );
    expect(result).toMatchObject(
      surface === 'librechat' ? { linkedWebCommitted: true } : { enqueued: 1 },
    );
    expect(mockFindTerminalCallbackResult).toHaveBeenCalledWith({
      ownerId: terminalResult.ownerId,
      originRef: terminalResult.originRef,
      workRef: terminalResult.workRef,
      workerId: terminalResult.workerId,
      runId: terminalResult.runId,
      attemptNumber: 0,
    });
    expect(mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert).toMatchObject({
      userId: terminalResult.ownerId,
      status: surface === 'librechat' ? 'sent' : 'pending',
      surface,
      text: message.text,
      terminalCallbackResultKey: terminalResult._id,
    });
    if (surface === 'librechat') {
      expect(mockFindOneAndUpdate.mock.calls[0][2]).toMatchObject({ session: transaction.session });
      expect(mockFenceEffectTransaction).toHaveBeenCalled();
      expect(mockReleaseEffectLease).toHaveBeenCalled();
    }
    expect(transaction.session.abortTransaction).not.toHaveBeenCalled();
  });

  test.each([
    'completed-without-attempt',
    'missing-trace',
    'wrong-trace',
    'missing-result',
    'wrong-result-event',
    'wrong-result-callback',
  ])('rejects invalid pre-runtime linked Web authority: %s', async (fault) => {
    const callbackId = 'cb_terminal_' + 'b'.repeat(64);
    const callbackRef = canonicalCallbackRef(callbackId);
    const terminalResult = {
      _id: 'ghtr_' + 'a'.repeat(64),
      callbackId,
      resultState: 'cancelled',
      resultDigest: 'sha256:' + 'c'.repeat(64),
      resultRevision: 1,
      acceptedOperationId: 'd'.repeat(32),
      acceptedOperationGeneration: 1,
    };
    if (fault === 'wrong-result-event') terminalResult.resultState = 'completed';
    if (fault === 'wrong-result-callback')
      terminalResult.callbackId = 'cb_terminal_' + 'e'.repeat(64);
    mockFindTerminalCallbackResult.mockReturnValue(
      leanResult(fault === 'missing-result' ? null : terminalResult),
    );
    const traceIdentity =
      fault === 'missing-trace'
        ? undefined
        : {
            callbackRef: fault === 'wrong-trace' ? canonicalCallbackRef('foreign') : callbackRef,
            attemptNumber: null,
          };
    await expect(
      enqueueGlassHiveCallbackDelivery({
        body: {
          callback_id: callbackId,
          attempt_number: null,
          event: 'main.followup',
          worker_id: 'worker-pre-runtime',
          run_id: 'run-pre-runtime',
        },
        deliveryContext: {
          ownerId: 'owner-pre-runtime',
          originRef: 'origin-pre-runtime',
          workRef: 'work-pre-runtime',
          conversationId: 'conversation-pre-runtime',
          traceIdentity,
          traceCallbackEvent:
            fault === 'completed-without-attempt' ? 'run.completed' : 'run.cancelled',
          destinations: [{ surface: 'librechat' }],
        },
        message: { messageId: 'followup-pre-runtime', text: 'A result.' },
        effectSession: { inTransaction: () => true },
      }),
    ).rejects.toThrow(
      /glasshive_(linked_presentation_identity_invalid|callback_terminal_result_mismatch)/,
    );
    expect(mockAcquireEffectLease).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
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
        event: 'main.followup',
        run_id: 'run-pre-runtime-stop',
        work_ref: 'work-pre-runtime-stop',
      },
      deliveryContext: {
        ownerId: 'owner-pre-runtime-stop',
        originRef: 'origin-pre-runtime-stop',
        workRef: 'work-pre-runtime-stop',
        conversationId: 'conversation-pre-runtime-stop',
        traceIdentity: { callbackRef, attemptNumber: null },
        traceCallbackEvent: 'run.cancelled',
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

  test.each(['healthy', 'missing_identity', 'store_failure'])(
    'persists one typed Voice presentation and records its response for every bound Worker (%s)',
    async (mode) => {
      const diagnostics = completionDiagnosticFixture(mode);
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
      const presentation = JSON.parse(
        JSON.stringify(
          buildVoiceWorkerCompletionPresentation({
            ownerId: 'owner-coalesced',
            conversationId: 'conversation-coalesced',
            callSessionId: 'call-coalesced',
            responseMessageId: 'follow-up-coalesced',
            responseText: 'Both Workers completed.',
            bindings,
          }),
        ),
      );
      const expectedTrace = {
        callSessionId: presentation.callSessionId,
        turnId: presentation.turnId,
        presentationRef: presentation.presentationRef,
      };
      let insertedDelivery;
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
      mockFindOneAndUpdate.mockImplementation((_query, update) => {
        insertedDelivery = { ...update.$setOnInsert, ...update.$set };
        return leanResult(insertedDelivery);
      });

      mockFindOne.mockImplementation(() => leanResult(insertedDelivery));
      mockMessageFindOne.mockReturnValue(
        leanResult({ messageId: 'follow-up-coalesced', text: 'Both Workers completed.' }),
      );
      await diagnostics.run(async () => {
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
        expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
        expect(insertedDelivery.workerCompletionPresentation).toEqual(presentation);
        expectedTrace.deliveryRef = insertedDelivery.deliveryId;
        insertedDelivery.userId = 'changed-after-defer';
        insertedDelivery.deliveryId = 'changed-after-defer';
        presentation.callSessionId = 'changed-after-defer';
        presentation.turnId = 'changed-after-defer';
        presentation.presentationRef = 'changed-after-defer';
        presentation.bindings[0].workRef = 'changed-after-defer';
        presentation.bindings.pop();
      });
      diagnostics.assertTraceCount(2);

      expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledTimes(2);
      expect(
        mockRecordVoiceOrchestrationTraceBestEffort.mock.calls.map(
          ([input]) => input.facts.workRef,
        ),
      ).toEqual(['work-a', 'work-b']);
      expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'owner-coalesced',
          callSessionId: expectedTrace.callSessionId,
          turnId: expectedTrace.turnId,
          stage: 'response.completed',
          facts: expect.objectContaining({
            deliveryRef: expectedTrace.deliveryRef,
            presentationRef: expectedTrace.presentationRef,
            responseRef: 'follow-up-coalesced',
          }),
        }),
      );
    },
  );

  test.each(['healthy', 'missing_identity', 'store_failure'])(
    'settles one exact coalesced Voice response through TTS and audio exactly once (%s)',
    async (mode) => {
      const diagnostics = completionDiagnosticFixture(mode);
      const fixture = workerCompletionFixture();
      fixture.presentation = JSON.parse(JSON.stringify(fixture.presentation));
      fixture.row.workerCompletionPresentation = fixture.presentation;
      const expectedTrace = {
        callSessionId: fixture.presentation.callSessionId,
        turnId: fixture.presentation.turnId,
        presentationRef: fixture.presentation.presentationRef,
      };
      const completedRow = {
        ...fixture.row,
        status: 'sent',
        workerCompletionTtsCompletedAt: new Date(),
        workerCompletionAudioCompletedAt: new Date(),
        workerCompletionEffectLeases: [],
      };
      mockFindOne.mockReturnValueOnce(leanResult(fixture.row));
      mockMessageFindOne.mockReturnValueOnce(
        leanResult({ messageId: 'follow-up-coalesced', text: 'Both Workers completed.' }),
      );
      mockFindOneAndUpdate.mockReturnValueOnce(leanResult(completedRow));

      let settlementTimestamp;
      await diagnostics.run(async () => {
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
        expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
        const at = mockFindOneAndUpdate.mock.calls[0][1].$set.workerCompletionTtsCompletedAt;
        settlementTimestamp = at.getTime();
        at.setTime(0);
        completedRow.userId = 'changed-after-defer';
        completedRow.deliveryId = 'changed-after-defer';
        fixture.presentation.callSessionId = 'changed-after-defer';
        fixture.presentation.turnId = 'changed-after-defer';
        fixture.presentation.presentationRef = 'changed-after-defer';
        fixture.presentation.bindings[0].workRef = 'changed-after-defer';
        fixture.presentation.bindings.pop();
      });

      diagnostics.assertTraceCount(4);
      expect(mockFenceEffectTransaction).toHaveBeenCalledTimes(2);
      expect(mockReleaseEffectLease).toHaveBeenCalledTimes(2);
      expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenCalledTimes(4);
      expect(
        mockRecordVoiceOrchestrationTraceBestEffort.mock.calls.map(([input]) => input.stage),
      ).toEqual(['tts.completed', 'tts.completed', 'audio.completed', 'audio.completed']);
      for (const [input] of mockRecordVoiceOrchestrationTraceBestEffort.mock.calls) {
        expect(input).toMatchObject({
          ownerId: 'owner-coalesced',
          callSessionId: expectedTrace.callSessionId,
          turnId: expectedTrace.turnId,
          facts: {
            deliveryRef: 'ghcd-coalesced',
            presentationRef: expectedTrace.presentationRef,
            responseRef: 'follow-up-coalesced',
          },
        });
        expect(input.at.getTime()).toBe(settlementTimestamp);
      }
      expect(
        mockRecordVoiceOrchestrationTraceBestEffort.mock.calls.map(
          ([input]) => input.facts.workRef,
        ),
      ).toEqual(['work-a', 'work-b', 'work-a', 'work-b']);

      mockFindOne.mockReturnValueOnce(leanResult(null));
      mockRecordVoiceOrchestrationTraceBestEffort.mockClear();
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
      expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
    },
  );

  test('aborted callback discards deferred completion diagnostics', async () => {
    const diagnostics = completionDiagnosticFixture('healthy');
    const fixture = workerCompletionFixture();
    mockFindOne.mockReturnValueOnce(leanResult(fixture.row));
    mockMessageFindOne.mockReturnValueOnce(
      leanResult({ messageId: 'follow-up-coalesced', text: 'Both Workers completed.' }),
    );
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({ ...fixture.row, status: 'sent', workerCompletionEffectLeases: [] }),
    );

    await expect(
      diagnostics.run(async () => {
        await completeGlassHiveWorkerCompletionPresentation({
          deliveryId: fixture.row.deliveryId,
          claimId: fixture.row.claimId,
          dispatchPermit: fixture.dispatchPermit,
          presentationRef: fixture.presentation.presentationRef,
          userId: fixture.row.userId,
          voiceCallSessionId: fixture.row.voiceCallSessionId,
        });
        expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
        throw new Error('callback aborted');
      }),
    ).rejects.toThrow('callback aborted');

    expect(diagnostics.session.commitTransaction).not.toHaveBeenCalled();
    expect(diagnostics.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
    expect(diagnostics.durable).not.toHaveBeenCalled();
    expect(diagnostics.local).not.toHaveBeenCalled();
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
    expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
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
    mockFindOne
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'ghcd_claim',
          callbackId: 'cb_claim',
          event: 'run.completed',
          surface: 'telegram',
          status: 'pending',
        }),
      )
      .mockReturnValueOnce(leanResult(null));
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

  test.each([false, true])(
    'Telegram claim carries the same saved native source, text mismatch=%s',
    async (changed) => {
      const text = 'Read-first 🧠.\nUseful spoken result.';
      const disposition = {
        version: 1,
        audio: 'eligible',
        required: true,
        valid: true,
        source: 'model',
      };
      const content = [
        {
          type: 'text',
          text,
          deliveryDispositionRanges: [{ start: 0, end: text.length, disposition }],
        },
      ];
      const row = {
        deliveryId: 'ghcd_source',
        callbackId: 'cb_source',
        callbackMessageId: 'msg-source',
        userId: 'owner-source',
        conversationId: 'conv-source',
        event: 'run.completed',
        surface: 'telegram',
        status: 'pending',
        text: changed ? 'Changed presentation.' : text,
        claimId: 'claim-source',
      };
      mockFindOne.mockReturnValueOnce(leanResult(row));
      mockFindOneAndUpdate.mockReturnValueOnce(leanResult({ ...row, status: 'claimed' }));
      mockMessageFindOne.mockReturnValueOnce(
        leanResult({
          text,
          content,
          metadata: { viventium: { deliveryDisposition: disposition } },
        }),
      );
      const claimed = await claimPendingGlassHiveCallbackDeliveries({
        surface: 'telegram',
        limit: 1,
      });
      expect(claimed[0].deliveryControls).toEqual({
        deliveryDisposition: disposition,
        audioContent: changed ? [] : content,
        sourceTextSha256: require('node:crypto')
          .createHash('sha256')
          .update(row.text)
          .digest('hex'),
      });
      expect(claimed[0].text).toBe(row.text);
      expect(mockMessageFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          user: 'owner-source',
          conversationId: 'conv-source',
          messageId: 'msg-source',
          isCreatedByUser: false,
        }),
      );
    },
  );

  test.each([
    [false, ''],
    [true, ''],
    [false, '\ufeff'],
    [false, '\u00a0'],
    [false, '\u0085'],
  ])(
    'Voice claim returns verified raw speech without changing presentation identity, mismatch=%s edge=%s',
    async (changed, edge) => {
      const transportText = edge + 'A useful result.' + edge;
      const text = transportText.trim();
      const raw = '[chuckle] ' + text;
      const disposition = {
        version: 1,
        audio: 'eligible',
        required: true,
        valid: true,
        source: 'model',
      };
      const part = (value) => ({
        type: 'text',
        text: value,
        deliveryDispositionRanges: [{ start: 0, end: value.length, disposition }],
      });
      const controls = {
        sourceTextSha256: require('node:crypto').createHash('sha256').update(text).digest('hex'),
        audioContent: [part(raw)],
      };
      const row = {
        deliveryId: 'voice-delivery',
        callbackId: 'voice-callback',
        callbackMessageId: 'voice-message',
        userId: 'voice-owner',
        conversationId: 'voice-conversation',
        voiceCallSessionId: 'voice-call',
        event: 'run.completed',
        surface: 'voice',
        status: 'pending',
        text: changed ? 'Changed presentation.' : transportText,
        claimId: 'voice-claim',
        fullText: 'Raw worker body is not the Main-authored presentation.',
      };
      row.workerCompletionPresentation =
        require('@librechat/api').buildVoiceWorkerCompletionPresentation({
          ownerId: row.userId,
          conversationId: row.conversationId,
          callSessionId: row.voiceCallSessionId,
          responseMessageId: row.callbackMessageId,
          responseText: row.text,
          bindings: workerCompletionFixture().presentation.bindings,
        });
      mockFindOne.mockReturnValueOnce(leanResult(row));
      mockFindOneAndUpdate.mockReturnValueOnce(leanResult({ ...row, status: 'claimed' }));
      mockMessageFindOne.mockReturnValueOnce(
        leanResult({
          text,
          content: [part(text)],
          metadata: { viventium: { deliveryDisposition: disposition, deliveryControls: controls } },
        }),
      );
      const claimed = await claimPendingGlassHiveCallbackDeliveries({ surface: 'voice', limit: 1 });
      expect(claimed[0].text).toBe(row.text.trim());
      expect(claimed[0].deliveryControls.sourceTextSha256).toBe(
        require('node:crypto').createHash('sha256').update(claimed[0].text).digest('hex'),
      );
      expect(claimed[0].deliveryControls.audioContent).toEqual(changed ? [] : [part(raw)]);
      expect(mockMessageFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          user: row.userId,
          conversationId: row.conversationId,
          messageId: row.callbackMessageId,
          isCreatedByUser: false,
        }),
      );
    },
  );

  test('claim projects the exact retained native attention identity and signed topic without private form data', async () => {
    const binding = {
      version: 1,
      requestId: 'permission-1',
      requestFingerprint: 'a'.repeat(64),
      runId: 'run-1',
      attemptId: 'attempt-1',
      sessionId: 'session-1',
      expiresAt: '2099-01-01T00:00:00Z',
    };
    mockFindOne.mockReturnValueOnce(
      leanResult({
        deliveryId: 'attention-1',
        event: 'run.needs_input',
        surface: 'telegram',
        status: 'pending',
        workRef: 'work-1',
        runId: 'run-1',
        telegramUserId: 'telegram-1',
        telegramMessageThreadId: '9',
        nativeInputBinding: binding,
      }),
    );
    mockFindOneAndUpdate
      .mockReturnValueOnce(
        leanResult({
          deliveryId: 'attention-1',
          event: 'run.needs_input',
          surface: 'telegram',
          status: 'claimed',
          claimId: 'claim-1',
          workRef: 'work-1',
          runId: 'run-1',
          telegramUserId: 'telegram-1',
          telegramMessageThreadId: '9',
          nativeInputBinding: binding,
        }),
      )
      .mockReturnValueOnce(leanResult(null));
    const rows = await claimPendingGlassHiveCallbackDeliveries({
      surface: 'telegram',
      limit: 1,
      claimOwner: 'telegram-dispatcher',
    });
    expect(rows).toEqual([
      expect.objectContaining({
        workRef: 'work-1',
        runId: 'run-1',
        telegramUserId: 'telegram-1',
        telegramMessageThreadId: '9',
        nativeInputBinding: binding,
      }),
    ]);
    expect(rows[0]).not.toHaveProperty('requestedSchema');
    expect(rows[0]).not.toHaveProperty('nativeextras');
  });

  test('marks an ambiguous Telegram send without making it retryable', async () => {
    mockFindOneAndUpdate.mockReturnValueOnce(
      leanResult({
        deliveryId: 'ghcd_unknown',
        callbackMessageId: 'msg_callback',
        originRef: 'ghi_unknown',
        conversationId: 'conv_1',
        event: 'main.followup',
        surface: 'telegram',
        status: 'delivery_unknown',
        claimId: 'claim_unknown',
      }),
    );
    mockFindDeliveries.mockReturnValueOnce(leanResult([{ status: 'delivery_unknown' }]));

    await markGlassHiveCallbackDeliveryUnknown({
      deliveryId: 'ghcd_unknown',
      claimId: 'claim_unknown',
      reason: 'telegram_receipt_missing',
    });

    expect(mockFindOneAndUpdate.mock.calls[0][1].$set).toMatchObject({
      status: 'delivery_unknown',
      leaseExpiresAt: null,
      nextAttemptAt: null,
    });
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith({
      originRef: 'ghi_unknown',
      state: 'unknown',
    });
  });

  test('retains exact issued Telegram receipts after expiry without granting settlement or replay', async () => {
    const fixture = workerCompletionFixture();
    const candidate = {
      ...fixture.row,
      surface: 'telegram',
      telegramChatId: 'chat-1',
      telegramUserId: 'telegram-1',
      telegramMessageThreadId: '9',
      logicalMessageId: 'follow-up-coalesced',
      dispatchPermitExpiresAt: new Date(Date.now() - 1000),
    };
    const dispatchPermit = { ...fixture.dispatchPermit, surface: 'telegram' };
    mockFindOne.mockReturnValueOnce(leanResult(candidate));
    await expect(
      markGlassHiveCallbackDeliveryUnknown({
        deliveryId: candidate.deliveryId,
        claimId: candidate.claimId,
        dispatchPermit,
        telegramMessageIds: ['701', '701', '702'],
      }),
    ).resolves.toBeNull();
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'claimed',
        deliveryId: candidate.deliveryId,
        claimId: candidate.claimId,
        userId: candidate.userId,
        telegramChatId: 'chat-1',
        telegramMessageThreadId: '9',
        callbackMessageId: candidate.callbackMessageId,
        dispatchPermitId: candidate.dispatchPermitId,
        dispatchPermitGeneration: candidate.dispatchPermitGeneration,
        terminalCallbackResultDigest: candidate.terminalCallbackResultDigest,
        workerCompletionPresentation: candidate.workerCompletionPresentation,
      }),
      {
        $addToSet: { telegramSentMessageIds: { $each: ['701', '702'] } },
        $set: { telegramMessageId: '702', transportReceiptVersion: 1 },
      },
    );
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockFenceEffectTransaction).not.toHaveBeenCalled();
    expect(mockReleaseEffectLease).not.toHaveBeenCalled();
    mockUpdateOne.mockClear();
    mockFindOne.mockReturnValueOnce(leanResult({ ...candidate, dispatchPermitGeneration: 2 }));
    await expect(
      markGlassHiveCallbackDeliveryUnknown({
        deliveryId: candidate.deliveryId,
        claimId: candidate.claimId,
        dispatchPermit,
        telegramMessageIds: ['703'],
      }),
    ).resolves.toBeNull();
    expect(mockUpdateOne).not.toHaveBeenCalled();
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

  test('pending Main voice delivery recovery republishes exact ledger discovery after restart', async () => {
    const { row, bindings } = workerCompletionFixture();
    row.status = 'pending';
    row.claimId = '';
    row.callbackId = bindings[0].callbackRef;
    mockFindDeliveries.mockReturnValueOnce(leanResult([row]));
    mockFindOne.mockReturnValue(leanResult(row));
    mockMessageFindOne.mockReturnValue(
      leanResult({ messageId: row.callbackMessageId, text: row.text }),
    );
    await reconcileGlassHiveSurfaceDeliveryProjections();
    expect(mockHydrateDeliveryTask).toHaveBeenCalledWith(`glasshive-delivery:${row.deliveryId}`, {
      userId: row.userId,
      callSessionId: row.voiceCallSessionId,
      requireDurable: true,
    });
    expect(mockRegisterDeliveryPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: row.deliveryId,
        callbackId: row.callbackId,
        callbackMessageId: row.callbackMessageId,
        status: 'pending',
        workerCompletionPresentation: row.workerCompletionPresentation,
      }),
      { userId: row.userId, callSessionId: row.voiceCallSessionId },
    );
    expect(mockFlushTaskPersistence).toHaveBeenCalledTimes(1);
    row.projectionAppliedAt = new Date();
    row.projectionPendingAt = null;
    mockRecordGlassHiveSurfaceDeliveryOutcome.mockClear();
    mockFindDeliveries.mockReturnValueOnce(leanResult([row]));
    mockGetDeliveryTask.mockReturnValue({
      taskId: 'delivery-task',
      conversationId: row.conversationId,
      owner: { kind: 'glasshive_delivery', id: row.deliveryId },
    });
    mockGetDeliveryTraceBinding.mockReturnValue({
      userId: row.userId,
      callSessionId: row.voiceCallSessionId,
    });
    mockDeliverySnapshot.mockReturnValue({
      resultMessageId: row.callbackMessageId,
      source: { id: row.callbackId },
    });
    mockFindOne.mockClear();
    mockMessageFindOne.mockClear();
    await reconcileGlassHiveSurfaceDeliveryProjections();
    expect(mockRegisterDeliveryPresentation).toHaveBeenCalledTimes(1);
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockMessageFindOne).not.toHaveBeenCalled();
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
    expect(mockFindDeliveries.mock.calls[0][0].$or).toContainEqual({
      surface: 'voice',
      status: 'pending',
      workerCompletionPresentation: { $ne: null },
      $or: [
        { projectionNextAttemptAt: null },
        { projectionNextAttemptAt: { $lte: expect.any(Date) } },
      ],
    });
    expect(mockUpdateMany).toHaveBeenCalledWith(
      { deliveryId: { $in: [row.deliveryId] }, surface: 'voice', status: 'pending' },
      { $set: { projectionNextAttemptAt: expect.any(Date) } },
    );
  });
  test.each(['abort', 'commit'])(
    'pending Main voice discovery waits for transaction %s',
    async (outcome) => {
      const { row, bindings } = workerCompletionFixture();
      row.status = 'pending';
      row.claimId = '';
      row.callbackId = bindings[0].callbackRef;
      const transaction = completionDiagnosticFixture('healthy');
      mockFindDeliveries.mockReturnValueOnce(leanResult([row]));
      mockFindOne.mockReturnValue(leanResult(row));
      mockMessageFindOne.mockReturnValue(
        leanResult({ messageId: row.callbackMessageId, text: row.text }),
      );
      const operation = transaction.run(async () => {
        await reconcileGlassHiveSurfaceDeliveryProjections();
        expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
        if (outcome === 'abort') throw new Error('synthetic transaction abort');
      });
      if (outcome === 'abort') {
        await expect(operation).rejects.toThrow('synthetic transaction abort');
        expect(transaction.session.abortTransaction).toHaveBeenCalledTimes(1);
      } else {
        await operation;
        expect(transaction.session.commitTransaction).toHaveBeenCalledTimes(1);
      }
      expect(mockRegisterDeliveryPresentation).toHaveBeenCalledTimes(outcome === 'commit' ? 1 : 0);
    },
  );
  test('pending Main voice publication failure preserves later commit effects and unrelated projections', async () => {
    const { row, bindings } = workerCompletionFixture();
    row.status = 'pending';
    row.claimId = '';
    row.callbackId = bindings[0].callbackRef;
    const unrelated = {
      deliveryId: 'telegram-delivery',
      originRef: 'origin-telegram',
      surface: 'telegram',
      status: 'sent',
      projectionPendingAt: new Date(),
    };
    const transaction = completionDiagnosticFixture('healthy');
    const nextCommitEffect = jest.fn();
    mockFindDeliveries.mockReturnValueOnce(leanResult([row, unrelated]));
    mockFindOne.mockReturnValue(leanResult(row));
    mockMessageFindOne.mockReturnValue(
      leanResult({ messageId: row.callbackMessageId, text: row.text }),
    );
    mockHydrateDeliveryTask.mockRejectedValueOnce(
      Object.assign(new Error('durable task unavailable'), { code: 'task_store_unavailable' }),
    );
    await transaction.run(async () => {
      await reconcileGlassHiveSurfaceDeliveryProjections();
      mockTerminalTransactionService.deferGlassHiveTerminalCallbackAfterCommit(nextCommitEffect);
      expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
    });
    expect(nextCommitEffect).toHaveBeenCalledTimes(1);
    expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        originRef: unrelated.originRef,
      }),
    );
    expect(require('@librechat/data-schemas').logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][glasshive-delivery] Pending Voice discovery deferred',
      { deliveryId: row.deliveryId, code: 'task_store_unavailable' },
    );
  });
  test('pending Main voice discovery backoff failure cannot abort delivered projections', async () => {
    const { row, bindings } = workerCompletionFixture();
    row.status = 'pending';
    row.claimId = '';
    row.callbackId = bindings[0].callbackRef;
    mockFindDeliveries.mockReturnValueOnce(leanResult([row]));
    mockFindOne.mockReturnValue(leanResult(row));
    mockMessageFindOne.mockReturnValue(
      leanResult({ messageId: row.callbackMessageId, text: row.text }),
    );
    mockUpdateMany.mockImplementation((query) =>
      query.deliveryId
        ? Promise.reject(
            Object.assign(new Error('backoff unavailable'), { code: 'backoff_unavailable' }),
          )
        : Promise.resolve({ modifiedCount: 1 }),
    );
    await expect(reconcileGlassHiveSurfaceDeliveryProjections()).resolves.toMatchObject({
      scanned: 1,
    });
    expect(mockRegisterDeliveryPresentation).toHaveBeenCalledTimes(1);
    expect(require('@librechat/data-schemas').logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][glasshive-delivery] Voice discovery recovery backoff deferred',
      { code: 'backoff_unavailable' },
    );
  });
  test.each(['neutral', 'suppressed', 'changed-response'])(
    'pending Main voice recovery rejects %s before task publication',
    async (fault) => {
      const { row, bindings } = workerCompletionFixture();
      row.status = 'pending';
      row.claimId = '';
      row.callbackId = bindings[0].callbackRef;
      if (fault === 'neutral') row.workerCompletionPresentation = null;
      if (fault === 'suppressed') row.status = 'suppressed';
      mockFindDeliveries.mockReturnValueOnce(leanResult([row]));
      mockFindOne.mockReturnValue(leanResult(row));
      mockMessageFindOne.mockReturnValue(
        leanResult({
          messageId: row.callbackMessageId,
          text: fault === 'changed-response' ? 'Changed text.' : row.text,
        }),
      );
      await reconcileGlassHiveSurfaceDeliveryProjections();
      expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
    },
  );
  test.each([
    ['sent', 'sent'],
    ['delivery_unknown', 'unknown'],
    ['failed', 'failed'],
    ['suppressed', 'suppressed'],
  ])('recovers every signed aggregate member from legacy %s projection', async (status, state) => {
    const { row, bindings } = workerCompletionFixture();
    row.status = status;
    row.projectionAppliedAt = new Date();
    row.projectionPendingAt = null;
    row.workerCompletionEffectLeases = [];
    mockFindDeliveries
      .mockReturnValueOnce(leanResult([row]))
      .mockReturnValue(leanResult([{ status }]));
    mockMessageFindOne.mockReturnValue(
      leanResult({ messageId: row.callbackMessageId, text: row.text }),
    );
    mockFindTerminalCallbackResult.mockImplementation((query) => leanResult({ _id: query._id }));
    expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({ projected: 1 });
    expect(mockFindDeliveries.mock.calls[0][0].$or).toContainEqual(
      expect.objectContaining({
        workerCompletionProjectionAppliedAt: null,
      }),
    );
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledTimes(2);
    for (const binding of bindings) {
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          originRef: binding.originRef,
          state,
          workerCompletion: {
            ownerId: row.userId,
            responseMessageId: row.callbackMessageId,
            binding,
          },
          effectSession: expect.any(Object),
        }),
      );
      expect(mockTerminalCallbackResultUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: binding.resultKey,
          acceptedOperationId: binding.acceptedOperationId,
        }),
        expect.any(Object),
        expect.any(Object),
      );
    }
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: row.deliveryId,
        status,
      }),
      { $set: { workerCompletionProjectionAppliedAt: expect.any(Date) } },
      expect.any(Object),
    );
    expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  test.each(['changed-response', 'superseded-member'])(
    'aggregate recovery rejects %s without projecting either member',
    async (fault) => {
      const { row, bindings } = workerCompletionFixture();
      row.status = 'sent';
      row.projectionPendingAt = new Date();
      mockFindDeliveries.mockReturnValueOnce(leanResult([row]));
      mockMessageFindOne.mockReturnValue(
        leanResult({
          messageId: row.callbackMessageId,
          text: fault === 'changed-response' ? 'Changed.' : row.text,
        }),
      );
      mockFindTerminalCallbackResult.mockImplementation((query) =>
        leanResult(query._id === bindings[1].resultKey ? null : { _id: query._id }),
      );
      expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({ pending: 1 });
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            projectionErrorCode:
              fault === 'changed-response'
                ? 'voice_worker_completion_presentation_superseded'
                : 'glasshive_callback_effect_fenced',
          }),
        }),
      );
      expect(mockUpdateOne).not.toHaveBeenCalledWith(
        expect.anything(),
        { $set: { workerCompletionProjectionAppliedAt: expect.any(Date) } },
        expect.anything(),
      );
    },
  );

  test.each(
    ['voice', 'telegram'].flatMap((surface) =>
      ['sent', 'delivery_unknown'].map((status) => [surface, status]),
    ),
  )(
    'stops only superseded %s %s projection retries while retaining the delivery receipt',
    async (surface, status) => {
      const match = require('sift').default;
      const { row, bindings } = workerCompletionFixture();
      Object.assign(row, {
        surface,
        status,
        projectionPendingAt: new Date(),
        projectionNextAttemptAt: null,
        projectionAppliedAt: null,
        workerCompletionProjectionAppliedAt: null,
      });
      if (surface === 'telegram') {
        row.workerCompletionBindings = bindings;
        row.workerCompletionPresentation = null;
      }
      mockFindDeliveries.mockImplementation((filter) =>
        leanResult(match(filter)(row) ? [row] : []),
      );
      mockMessageFindOne.mockReturnValue(
        leanResult({ messageId: row.callbackMessageId, text: '', unfinished: false }),
      );
      mockUpdateMany.mockImplementation(async (filter, update) => {
        if (!match(filter)(row)) return { modifiedCount: 0 };
        Object.assign(row, update.$set);
        return { modifiedCount: 1 };
      });
      const originalText = row.text;
      expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({
        scanned: 1,
        pending: 1,
      });
      expect(row).toMatchObject({
        status,
        text: originalText,
        projectionPendingAt: null,
        projectionNextAttemptAt: null,
        projectionAppliedAt: null,
        workerCompletionProjectionAppliedAt: null,
        projectionErrorCode:
          surface === 'voice'
            ? 'voice_worker_completion_presentation_superseded'
            : 'worker_completion_presentation_superseded',
      });
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
      expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
      expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toEqual({
        scanned: 0,
        projected: 0,
        pending: 0,
      });
      // An existing delivery transition may re-arm projection; no new retry framework is needed.
      row.projectionPendingAt = new Date();
      mockMessageFindOne.mockReturnValue(
        leanResult({ messageId: row.callbackMessageId, text: row.text, unfinished: false }),
      );
      mockFindTerminalCallbackResult.mockImplementation((query) => leanResult({ _id: query._id }));
      expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({
        scanned: 1,
        projected: 1,
      });
      expect(row.status).toBe(status);
    },
  );

  test.each(
    ['voice', 'telegram'].flatMap((surface) =>
      ['sent', 'delivery_unknown'].map((status) => [surface, status]),
    ),
  )(
    'stops a cleanup-tombstoned %s %s projection without restoring deleted content',
    async (surface, status) => {
      const match = require('sift').default;
      const { row, bindings } = workerCompletionFixture();
      Object.assign(row, {
        surface,
        status,
        projectionPendingAt: new Date(),
        projectionNextAttemptAt: null,
        projectionAppliedAt: null,
        workerCompletionProjectionAppliedAt: null,
      });
      if (surface === 'telegram') {
        row.workerCompletionBindings = bindings;
        row.workerCompletionPresentation = null;
      }
      mockFindDeliveries.mockImplementation((filter) =>
        leanResult(match(filter)(row) ? [row] : []),
      );
      mockMessageFindOne.mockImplementation((filter, projection) => {
        if (!Object.hasOwn(filter, 'deletedAt')) return leanResult(null); // Normal reads hide cleanup tombstones.
        expect(filter).toEqual({
          user: row.userId,
          conversationId: row.conversationId,
          messageId: row.callbackMessageId,
          deletedAt: { $ne: null },
          'cleanupTombstone.contractVersion': 1,
        });
        expect(projection).toEqual({ _id: 1 }); // Never request the erased text.
        return leanResult({ _id: 'retained-cleanup-tombstone' });
      });
      mockUpdateMany.mockImplementation(async (filter, update) => {
        if (!match(filter)(row)) return { modifiedCount: 0 };
        Object.assign(row, update.$set);
        return { modifiedCount: 1 };
      });
      const originalText = row.text;
      expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({
        scanned: 1,
        pending: 1,
      });
      expect(row).toMatchObject({
        status,
        text: originalText,
        projectionPendingAt: null,
        projectionNextAttemptAt: null,
        projectionAppliedAt: null,
        workerCompletionProjectionAppliedAt: null,
        projectionErrorCode: 'worker_completion_presentation_tombstoned',
      });
      expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toEqual({
        scanned: 0,
        projected: 0,
        pending: 0,
      });
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
      expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  test.each(['missing', 'unfinished', 'transport-error'])(
    'keeps %s canonical response recovery on the existing retry path',
    async (failure) => {
      const { row } = workerCompletionFixture();
      row.status = 'sent';
      row.projectionPendingAt = new Date();
      mockFindDeliveries.mockReturnValueOnce(leanResult([row]));
      if (failure === 'transport-error')
        mockMessageFindOne.mockImplementation(() => {
          throw Object.assign(new Error('temporary read failure'), {
            code: 'temporary_read_failure',
          });
        });
      else
        mockMessageFindOne.mockReturnValue(
          leanResult(
            failure === 'missing'
              ? null
              : {
                  messageId: row.callbackMessageId,
                  text: '',
                  unfinished: true,
                },
          ),
        );
      expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({ pending: 1 });
      expect(mockUpdateMany).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          $set: expect.objectContaining({
            projectionPendingAt: expect.any(Date),
            projectionNextAttemptAt: expect.any(Date),
          }),
        }),
      );
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
      expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
    },
  );

  test('retains a historical sent member after its exact accepted result advances', async () => {
    const { row, bindings } = workerCompletionFixture();
    row.status = 'sent';
    row.projectionAppliedAt = new Date();
    mockFindDeliveries
      .mockReturnValueOnce(leanResult([row]))
      .mockReturnValue(leanResult([{ status: 'sent' }]));
    mockMessageFindOne.mockReturnValue(
      leanResult({ messageId: row.callbackMessageId, text: row.text }),
    );
    mockFindTerminalCallbackResult.mockImplementation((query) =>
      leanResult(query._id === bindings[1].resultKey && !query.$or ? null : { _id: query._id }),
    );
    expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({
      projected: 1,
      pending: 0,
    });
    expect(
      mockRecordGlassHiveSurfaceDeliveryOutcome.mock.calls.map(([input]) => input.originRef),
    ).toEqual([bindings[0].originRef]);
    expect(mockUpdateOne).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryId: row.deliveryId }),
      { $set: { workerCompletionProjectionAppliedAt: expect.any(Date) } },
      expect.any(Object),
    );
    expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
  });

  test('a member accepted-operation race aborts all aggregate projection effects', async () => {
    const diagnostics = completionDiagnosticFixture('healthy');
    const { row, bindings } = workerCompletionFixture();
    row.status = 'sent';
    row.projectionPendingAt = new Date();
    mockFindDeliveries
      .mockReturnValueOnce(leanResult([row]))
      .mockReturnValue(leanResult([{ status: 'sent' }]));
    mockMessageFindOne.mockReturnValue(
      leanResult({ messageId: row.callbackMessageId, text: row.text }),
    );
    mockFindTerminalCallbackResult.mockImplementation((query) => leanResult({ _id: query._id }));
    mockTerminalCallbackResultUpdateOne.mockImplementation((query) => ({
      exec: async () => ({ matchedCount: query._id === bindings[1].resultKey ? 0 : 1 }),
    }));
    expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({ pending: 1 });
    expect(diagnostics.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(diagnostics.session.commitTransaction).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalledWith(
      expect.anything(),
      { $set: { workerCompletionProjectionAppliedAt: expect.any(Date) } },
      expect.anything(),
    );
    expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
  });

  test('retains the exact generic aggregate bindings in one Telegram delivery', async () => {
    const { row, bindings } = workerCompletionFixture();
    const representative = bindings[0];
    mockFindTerminalCallbackResult.mockImplementation((query) => {
      const binding = bindings.find((item) => item.resultKey === query._id) || representative;
      return leanResult({
        _id: binding.resultKey,
        callbackId: binding.terminalCallbackId,
        resultDigest: binding.resultDigest,
        resultRevision: binding.resultRevision,
        acceptedOperationId: binding.acceptedOperationId,
        acceptedOperationGeneration: binding.effectGeneration,
        resultState: 'completed',
      });
    });
    mockMessageFindOne.mockReturnValue(
      leanResult({ messageId: row.callbackMessageId, text: row.text }),
    );
    mockFindOneAndUpdate.mockImplementation((_filter, update) => leanResult(update.$setOnInsert));
    const summary = await enqueueGlassHiveCallbackDelivery({
      body: {
        event: 'main.followup',
        callback_id: representative.terminalCallbackId,
        attempt_number: 1,
        worker_id: representative.workerId,
        run_id: representative.runId,
      },
      deliveryContext: {
        ownerId: row.userId,
        conversationId: row.conversationId,
        originRef: representative.originRef,
        workRef: representative.workRef,
        traceIdentity: { callbackRef: representative.callbackRef, attemptNumber: 1 },
        traceCallbackEvent: 'run.completed',
        workerCompletionBindings: bindings,
        destinations: [{ surface: 'telegram', telegramChatId: 'synthetic-chat' }],
      },
      message: { messageId: row.callbackMessageId, text: row.text },
    });
    expect(summary.enqueued).toBe(1);
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    const persisted = mockFindOneAndUpdate.mock.calls[0][1].$setOnInsert;
    expect(persisted.workerCompletionBindings).toEqual(bindings);
    mockFindDeliveries.mockReturnValueOnce(leanResult([persisted]));
    await reconcileGlassHiveSurfaceDeliveryProjections();
    expect(
      mockRecordGlassHiveSurfaceDeliveryOutcome.mock.calls.map(([input]) => input.originRef),
    ).toEqual(bindings.map((binding) => binding.originRef));
  });

  test.each(['telegram', 'librechat'])(
    'projects exact authored aggregate members on %s',
    async (surface) => {
      const { row, bindings } = workerCompletionFixture();
      row.surface = surface;
      row.status = 'sent';
      row.projectionPendingAt = new Date();
      row.workerCompletionBindings = bindings;
      delete row.workerCompletionPresentation;
      mockFindDeliveries
        .mockReturnValueOnce(leanResult([row]))
        .mockReturnValue(leanResult([{ status: 'sent' }]));
      mockMessageFindOne.mockReturnValue(
        leanResult({ messageId: row.callbackMessageId, text: row.text }),
      );
      mockFindTerminalCallbackResult.mockImplementation((query) => leanResult({ _id: query._id }));
      expect(await reconcileGlassHiveSurfaceDeliveryProjections()).toMatchObject({ projected: 1 });
      expect(
        mockRecordGlassHiveSurfaceDeliveryOutcome.mock.calls.map(([input]) => input.originRef),
      ).toEqual(bindings.map((binding) => binding.originRef));
      expect(mockRegisterDeliveryPresentation).not.toHaveBeenCalled();
    },
  );

  test('aggregate member projection retains unresolved sibling surface precedence', async () => {
    const { row, bindings } = workerCompletionFixture();
    row.status = 'sent';
    row.projectionPendingAt = new Date();
    mockFindDeliveries
      .mockReturnValueOnce(leanResult([row]))
      .mockReturnValueOnce(leanResult([{ status: 'sent' }]))
      .mockReturnValueOnce(leanResult([{ status: 'sent' }, { status: 'unresolved' }]));
    mockMessageFindOne.mockReturnValue(
      leanResult({ messageId: row.callbackMessageId, text: row.text }),
    );
    mockFindTerminalCallbackResult.mockImplementation((query) => leanResult({ _id: query._id }));
    await reconcileGlassHiveSurfaceDeliveryProjections();
    expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        originRef: bindings[1].originRef,
        state: 'unresolved',
      }),
    );
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

  test('claim query excludes old raw needs-input prose and preserves only Main or other supported presentations', async () => {
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const { MongoClient } = require('mongodb');
    const server = await MongoMemoryServer.create();
    const client = new MongoClient(server.getUri());
    try {
      await client.connect();
      const collection = client.db('delivery_claim_contract').collection('deliveries');
      const common = {
        surface: 'telegram',
        status: 'pending',
        leaseExpiresAt: null,
        originRef: 'shared-origin',
      };
      await collection.insertMany([
        {
          ...common,
          deliveryId: 'raw-completed',
          event: 'run.completed',
          callbackKey: 'raw-replay-a',
        },
        { ...common, deliveryId: 'raw-failed', event: 'run.failed', callbackKey: 'raw-replay-b' },
        {
          ...common,
          deliveryId: 'main-new',
          event: 'run.needs_input',
          callbackKey: 'source-replay',
          presentationKind: 'main',
        },
        { ...common, deliveryId: 'main-legacy', event: 'run.completed', callbackKey: '' },
        {
          ...common,
          deliveryId: 'native-input',
          event: 'run.needs_input',
          callbackKey: 'raw-replay-c',
        },
        { ...common, deliveryId: 'native-input-legacy', event: 'run.needs_input', callbackKey: '' },
        {
          ...common,
          deliveryId: 'other-surface',
          surface: 'voice',
          event: 'run.completed',
          callbackKey: '',
          presentationKind: 'main',
        },
      ]);
      mockFindOne.mockReturnValueOnce(leanResult(null));
      await claimPendingGlassHiveCallbackDeliveries({ surface: 'telegram', limit: 1 });
      const filter = mockFindOne.mock.calls[0][0];
      const rows = await collection.find(filter).toArray();
      expect(rows.map((row) => row.deliveryId).sort()).toEqual(['main-legacy', 'main-new']);
      await collection.updateMany(
        { deliveryId: { $in: ['main-legacy', 'main-new', 'native-input', 'other-surface'] } },
        { $set: { status: 'sent' } },
      );
      mockFindOneAndUpdate.mockReturnValueOnce(
        leanResult({
          deliveryId: 'main-new',
          originRef: 'shared-origin',
          surface: 'telegram',
          event: 'main.followup',
          presentationKind: 'main',
          status: 'sent',
        }),
      );
      mockFindDeliveries.mockImplementation((query) => ({
        lean: () => collection.find(query).toArray(),
      }));
      await markGlassHiveCallbackDeliverySent({ deliveryId: 'main-new', claimId: 'claim-main' });
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenLastCalledWith(
        expect.objectContaining({ originRef: 'shared-origin', state: 'sent' }),
      );
    } finally {
      await client.close();
      await server.stop();
    }
  }, 30000);

  test('voice delivery claim and mark can be scoped to user and call session', async () => {
    mockFindOne.mockReturnValueOnce(
      leanResult({
        deliveryId: 'ghcd_voice',
        callbackId: 'cb_voice',
        event: 'run.completed',
        surface: 'voice',
        status: 'pending',
        userId: 'user_1',
        voiceCallSessionId: 'call_1',
      }),
    );
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

  describe('exact Worker speech presentation authority', () => {
    function fixture() {
      const f = workerCompletionFixture();
      f.row.anchorMessageId = 'main-anchor';
      f.row.requestedParentMessageId = 'main-anchor';
      mockFindOne.mockReturnValue(leanResult(f.row));
      mockMessageFindOne.mockReturnValue(
        leanResult({
          messageId: f.presentation.responseMessageId,
          text: f.row.text,
        }),
      );
      mockTerminalCallbackResultExists.mockResolvedValue(true);
      return f;
    }
    function input(f) {
      return {
        deliveryId: f.row.deliveryId,
        claimId: f.row.claimId,
        dispatchPermit: f.dispatchPermit,
        presentationRef: f.presentation.presentationRef,
        turnId: f.presentation.turnId,
        userId: f.row.userId,
        voiceCallSessionId: f.row.voiceCallSessionId,
        conversationId: f.row.conversationId,
        anchorMessageId: 'main-anchor',
      };
    }
    test.each(['unissued', 'arbitrary', 'stale', 'expired'])(
      'ended settlement rejects %s issued-permit proof',
      async (failure) => {
        const f = fixture();
        let row = f.row,
          permit = f.dispatchPermit;
        if (failure === 'unissued')
          row = {
            deliveryId: 'legacy',
            claimId: 'legacy-claim',
            userId: 'owner-a',
            surface: 'voice',
            status: 'claimed',
            voiceCallSessionId: 'call-a',
          };
        if (failure === 'arbitrary') permit = { permitId: 'arbitrary' };
        if (failure === 'stale') permit = { ...permit, permitGeneration: 99 };
        if (failure === 'expired') row = { ...row, dispatchPermitExpiresAt: new Date(0) };
        mockFindOne.mockReturnValue(leanResult(row));
        await expect(
          markGlassHiveCallbackDeliveryUnknown({
            deliveryId: row.deliveryId,
            claimId: row.claimId,
            userId: row.userId,
            voiceCallSessionId: row.voiceCallSessionId,
            dispatchPermit: permit,
            requireIssuedPermit: true,
          }),
        ).resolves.toBeNull();
        expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
        expect(mockFenceEffectTransaction).not.toHaveBeenCalled();
        expect(mockReleaseEffectLease).not.toHaveBeenCalled();
      },
    );

    test('current aggregate presentation retains its own turn and every verified effect binding', async () => {
      const f = fixture();
      expect(await resolveGlassHiveVoicePresentation(input(f))).toMatchObject({
        deliveryId: f.row.deliveryId,
        callbackMessageId: f.presentation.responseMessageId,
        presentationRef: f.presentation.presentationRef,
        turnId: f.presentation.turnId,
        workerCompletionPresentation: f.presentation,
      });
      expect(mockTerminalCallbackResultExists).toHaveBeenCalledTimes(2);
      expect(mockFindOne).toHaveBeenCalledWith(
        expect.objectContaining({
          surface: 'voice',
          status: 'claimed',
          userId: f.row.userId,
          voiceCallSessionId: f.row.voiceCallSessionId,
          conversationId: f.row.conversationId,
        }),
      );
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
      expect(mockReleaseEffectLease).not.toHaveBeenCalled();
    });
    test.each(['NO_PARENT', 'prior-call-anchor', 'web-origin-anchor', 'telegram-origin-anchor'])(
      '%s never selects or denies canonical Worker presentation ownership',
      async (anchorMessageId) => {
        const f = fixture();
        f.row.anchorMessageId = anchorMessageId;
        f.row.requestedParentMessageId = anchorMessageId;
        expect(
          await resolveGlassHiveVoicePresentation({ ...input(f), anchorMessageId }),
        ).toMatchObject({
          deliveryId: f.row.deliveryId,
          presentationRef: f.presentation.presentationRef,
          turnId: f.presentation.turnId,
        });
      },
    );
    test('verified neutral Worker callback retains its own stored delivery identity', async () => {
      const f = fixture();
      delete f.row.workerCompletionPresentation;
      f.row.event = 'run.failed';
      f.row.workerId = 'worker-a';
      f.row.runId = 'run-a';
      f.row.callbackId = canonicalCallbackRef('cb_terminal_' + 'a'.repeat(64));
      f.row.voiceRequestId = 'stored-voice-request';
      mockMessageFindOne.mockReturnValue(
        leanResult({
          messageId: f.row.callbackMessageId,
          text: f.row.text,
          metadata: {
            viventium: {
              type: 'glasshive_worker_callback',
              status: { kind: 'mission_status', state: 'failed' },
              originRef: f.row.originRef,
              workRef: f.row.workRef,
              workerId: f.row.workerId,
              runId: f.row.runId,
              callbackId: 'cb_terminal_' + 'a'.repeat(64),
              voiceCallSessionId: f.row.voiceCallSessionId,
            },
          },
        }),
      );
      expect(
        await resolveGlassHiveVoicePresentation({
          ...input(f),
          presentationRef: f.row.deliveryId,
          turnId: f.row.voiceRequestId,
        }),
      ).toMatchObject({
        deliveryId: f.row.deliveryId,
        callbackMessageId: f.row.callbackMessageId,
        presentationRef: f.row.deliveryId,
        turnId: f.row.voiceRequestId,
      });
    });
    test.each([
      'ref',
      'turn',
      'permit',
      'digest',
      'lease',
      'missing',
      'owner',
      'call',
      'conversation',
      'expired',
    ])('rejects %s authority mismatch without granting a Main presentation', async (field) => {
      const f = fixture();
      const value = input(f);
      if (field === 'ref') value.presentationRef = 'other-ref';
      if (field === 'turn') value.turnId = 'other-turn';
      if (field === 'permit') value.dispatchPermit = { ...f.dispatchPermit, permitId: 'wrong' };
      if (field === 'digest')
        mockMessageFindOne.mockReturnValue(
          leanResult({
            messageId: f.presentation.responseMessageId,
            text: 'Changed canonical response.',
          }),
        );
      if (field === 'lease') mockTerminalCallbackResultExists.mockResolvedValue(false);
      if (field === 'missing') mockFindOne.mockReturnValue(leanResult(null));
      if (field === 'owner') f.row.userId = 'foreign';
      if (field === 'call') f.row.voiceCallSessionId = 'foreign';
      if (field === 'conversation') f.row.conversationId = 'foreign';
      if (field === 'expired') f.row.dispatchPermitExpiresAt = new Date(0);
      expect(await resolveGlassHiveVoicePresentation(value)).toBeNull();
    });
  });

  describe('issued Voice expiry preserves unknown delivery without re-speaking', () => {
    function stateFixture({ issued = true, renewed = false } = {}) {
      const f = workerCompletionFixture();
      const row = {
        ...f.row,
        leaseExpiresAt: new Date(0),
        dispatchPermitExpiresAt: renewed ? new Date(Date.now() + 60000) : new Date(0),
      };
      if (!issued) {
        row.dispatchPermitId = '';
        row.dispatchPermitGeneration = 0;
      }
      const match = require('sift').default;
      mockFindDeliveries.mockImplementation((filter) =>
        leanResult(match(filter)(row) ? [row] : []),
      );
      mockFindOne.mockImplementation((filter) =>
        leanResult(match(filter)(row) ? { ...row } : null),
      );
      mockFindOneAndUpdate.mockImplementation((filter, update) => {
        if (!match(filter)(row)) return leanResult(null);
        Object.assign(row, update.$set || {});
        return leanResult({ ...row });
      });
      mockMessageFindOne.mockReturnValue(
        leanResult({ messageId: row.callbackMessageId, text: row.text }),
      );
      mockFindTerminalCallbackResult.mockImplementation((query) => leanResult({ _id: query._id }));
      return { f, row };
    }
    test('failed interrupted receipt followed by expiry quarantines issued aggregate without another permit', async () => {
      const { f, row } = stateFixture();
      await claimPendingGlassHiveCallbackDeliveries({
        surface: 'voice',
        limit: 1,
        userId: row.userId,
        voiceCallSessionId: row.voiceCallSessionId,
      });
      expect(row.status).toBe('delivery_unknown');
      expect(row.dispatchPermitId).toBe('');
      expect(row.callbackMessageId).toBe(f.presentation.responseMessageId);
      expect(row.text).toBe(f.row.text);
      expect(row.workerCompletionPresentation).toEqual(f.presentation);
      expect(mockAcquireEffectLease).not.toHaveBeenCalled();
      expect(mockTerminalCallbackResultUpdateOne.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(mockReleaseEffectLease).toHaveBeenCalledTimes(2);
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'unknown' }),
      );
      const second = await claimPendingGlassHiveCallbackDeliveries({
        surface: 'voice',
        limit: 1,
        userId: row.userId,
        voiceCallSessionId: row.voiceCallSessionId,
      });
      expect(second).toEqual([]);
    });
    test('unissued expired claim remains recoverable and issued renewed permit is not quarantined', async () => {
      const unissued = stateFixture({ issued: false });
      const recovered = await claimPendingGlassHiveCallbackDeliveries({
        surface: 'voice',
        limit: 1,
        userId: unissued.row.userId,
        voiceCallSessionId: unissued.row.voiceCallSessionId,
      });
      expect(recovered).toHaveLength(1);
      expect(unissued.row.status).toBe('claimed');
      expect(unissued.row.claimId).not.toBe(unissued.f.row.claimId);
      const active = stateFixture({ renewed: true });
      expect(
        await claimPendingGlassHiveCallbackDeliveries({
          surface: 'voice',
          limit: 1,
          userId: active.row.userId,
          voiceCallSessionId: active.row.voiceCallSessionId,
        }),
      ).toEqual([]);
      expect(active.row.status).toBe('claimed');
      expect(active.row.claimId).toBe(active.f.row.claimId);
    });
    test.each(['new-claim', 'new-permit', 'new-result'])(
      '%s cannot be cleared or settled by the old expiry snapshot',
      async (race) => {
        const { f, row } = stateFixture();
        const read = mockFindOne.getMockImplementation();
        mockFindOne.mockImplementationOnce((filter) => {
          if (race === 'new-claim') row.claimId = 'new-claim';
          if (race === 'new-permit') row.dispatchPermitId = '9'.repeat(32);
          if (race === 'new-result')
            mockTerminalCallbackResultUpdateOne.mockReturnValue({
              exec: async () => ({ matchedCount: 0 }),
            });
          return read(filter);
        });
        await claimPendingGlassHiveCallbackDeliveries({
          surface: 'voice',
          limit: 1,
          userId: row.userId,
          voiceCallSessionId: row.voiceCallSessionId,
        });
        expect(row.status).toBe('claimed');
        expect(row.callbackMessageId).toBe(f.presentation.responseMessageId);
        expect(mockReleaseEffectLease).not.toHaveBeenCalled();
      },
    );
  });

  describe('replayable persisted claims retain exact delivery fences', () => {
    const fence = require('../GlassHiveCallbackBindingService').fenceGlassHiveCallbackRunState;
    beforeEach(() => fence.mockReset().mockResolvedValue(null));
    afterEach(() => fence.mockReset().mockResolvedValue(null));
    function fixture(surface = 'voice') {
      const { AsyncLocalStorage } = require('async_hooks');
      const { createGlassHiveTerminalCallbackTransactionService } = require('@librechat/api');
      const storage = new AsyncLocalStorage();
      const sessions = [];
      mockTerminalTransactionService = createGlassHiveTerminalCallbackTransactionService({
        transactionAsyncLocalStorage: storage,
        set: jest.fn(),
        startSession: async () => {
          let active = false;
          const session = {
            inTransaction: () => active,
            startTransaction: jest.fn(() => {
              active = true;
            }),
            commitTransaction: jest.fn(async () => {
              active = false;
            }),
            abortTransaction: jest.fn(async () => {
              active = false;
            }),
            endSession: jest.fn(async () => {}),
            withTransaction: jest.fn(async (operation) => {
              for (let attempt = 0; attempt < 2; attempt++) {
                active = true;
                try {
                  const result = await operation();
                  active = false;
                  return result;
                } catch (error) {
                  active = false;
                  if (attempt || !error?.hasErrorLabel?.('TransientTransactionError')) throw error;
                }
              }
            }),
          };
          sessions.push(session);
          return session;
        },
      });
      const row = {
        deliveryId: 'delivery-causal',
        callbackId: 'callback-causal',
        userId: 'owner-causal',
        conversationId: 'conversation-causal',
        voiceCallSessionId: surface === 'voice' ? 'call-causal' : '',
        surface,
        event: 'run.needs_input',
        originRef: 'origin-causal',
        workRef: 'work-causal',
        workerId: 'worker-causal',
        runId: 'run-causal',
        status: 'pending',
        text: 'Which shape?',
        claimId: '',
      };
      mockFindOne.mockReturnValue(leanResult(row));
      const write = jest.fn((_filter, update, options) => {
        const session = options.session || storage.getStore()?.session;
        expect(session).toBeDefined();
        expect(session.inTransaction()).toBe(true);
        return leanResult({ ...row, ...update.$set });
      });
      mockFindOneAndUpdate.mockImplementation(write);
      return {
        row,
        write,
        sessions,
        scope: {
          surface,
          limit: 1,
          callbackId: row.callbackId,
          userId: row.userId,
          voiceCallSessionId: row.voiceCallSessionId,
        },
      };
    }
    function conflict() {
      return Object.assign(new Error('synthetic write conflict'), {
        code: 112,
        hasErrorLabel: (label) => label === 'TransientTransactionError',
      });
    }
    test.each(['voice', 'telegram'])(
      '%s claim retries transient DB conflict with the same scope and claim',
      async (surface) => {
        const f = fixture(surface);
        mockFindOneAndUpdate.mockImplementationOnce(() => ({
          lean: async () => {
            throw conflict();
          },
        }));
        const claimed = await claimPendingGlassHiveCallbackDeliveries(f.scope);
        expect(claimed).toHaveLength(1);
        const calls = mockFindOneAndUpdate.mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0][0]).toEqual(calls[1][0]);
        expect(calls[0][1]).toEqual(calls[1][1]);
        expect(calls[0][2].session).toBeTruthy();
        expect(calls[0][2].session).toBe(calls[1][2].session);
        expect(fence).toHaveBeenCalledTimes(3); // two claim attempts, then claimed trace.
        expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
        expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
      },
    );
    test('claimed trace conflict replays only the trace DB transaction, not the successful claim', async () => {
      const f = fixture();
      fence
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(conflict())
        .mockResolvedValueOnce(null);
      expect(await claimPendingGlassHiveCallbackDeliveries(f.scope)).toHaveLength(1);
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
      expect(fence).toHaveBeenCalledTimes(3);
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
    });
    test('supersession after conflict fences the replay before another claim write', async () => {
      const f = fixture();
      mockFindOneAndUpdate.mockImplementationOnce(() => ({
        lean: async () => {
          throw conflict();
        },
      }));
      fence.mockResolvedValueOnce(null).mockRejectedValueOnce(
        Object.assign(new Error('superseded'), {
          code: 'glasshive_callback_notice_superseded',
        }),
      );
      mockFindOne.mockReturnValueOnce(leanResult(f.row)).mockReturnValue(leanResult(null));
      expect(await claimPendingGlassHiveCallbackDeliveries(f.scope)).toEqual([]);
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
      expect(mockUpdateOne).toHaveBeenCalledWith(
        expect.objectContaining({ deliveryId: f.row.deliveryId }),
        expect.any(Object),
      );
    });
    test('nontransient claim errors propagate without replay or presentation', async () => {
      const f = fixture();
      const failure = new Error('synthetic nontransient failure');
      mockFindOneAndUpdate.mockImplementationOnce(() => ({
        lean: async () => {
          throw failure;
        },
      }));
      await expect(claimPendingGlassHiveCallbackDeliveries(f.scope)).rejects.toBe(failure);
      expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(mockRecordTraceDelivery).not.toHaveBeenCalled();
      expect(mockRecordGlassHiveSurfaceDeliveryOutcome).not.toHaveBeenCalled();
    });
  });
});
