const mockGetFiles = jest.fn();
const mockGetMessages = jest.fn();
const mockGetDownloadStream = jest.fn();
const mockProjectTrustedClientPresentation = jest.fn();
let mockActionFileDependencies;
jest.mock('~/models', () => ({
  getFiles: (...args) => mockGetFiles(...args),
  getMessages: (...args) => mockGetMessages(...args),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: () => ({ getDownloadStream: (...args) => mockGetDownloadStream(...args) }),
}));
jest.mock('../interactionContext', () => ({
  projectTrustedClientPresentation: (...args) => mockProjectTrustedClientPresentation(...args),
}));
/* === VIVENTIUM START ===
 * Feature: Authenticated GlassHive work actions and exact capability reauthorization.
 * === VIVENTIUM END === */

const mockRequestAccountApi = jest.fn();
const mockBuildTrustedActionIdempotencyKey = jest.fn();
const mockReauthorizeCapabilityAuthorization = jest.fn();
const mockGetActiveWorkSnapshot = jest.fn();
const mockInvalidateActiveWorkSnapshot = jest.fn();
const mockDismissCoreOnlyPreDispatchAttention = jest.fn();
const mockGetCoreWorkDelivery = jest.fn();
const mockGetCoreWorkOriginRef = jest.fn();
const mockGetGenerationJob = jest.fn();
const mockRecordVoiceOrchestrationTraceBestEffort = jest.fn();

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createGlassHiveWorkActionService: (deps) => {
    mockActionFileDependencies = deps;
    return jest.requireActual('@librechat/api').createGlassHiveWorkActionService(deps);
  },
  GenerationJobManager: {
    getJob: (...args) => mockGetGenerationJob(...args),
  },
}));

jest.mock('../VoiceOrchestrationTraceService', () => ({
  recordVoiceOrchestrationTraceBestEffort: (...args) =>
    mockRecordVoiceOrchestrationTraceBestEffort(...args),
}));

jest.mock('../GlassHiveAccountService', () => ({
  requestAccountApi: (...args) => mockRequestAccountApi(...args),
  getActiveWorkSnapshot: (...args) => mockGetActiveWorkSnapshot(...args),
  invalidateActiveWorkSnapshot: (...args) => mockInvalidateActiveWorkSnapshot(...args),
  buildTrustedActionIdempotencyKey: (...args) => mockBuildTrustedActionIdempotencyKey(...args),
}));

jest.mock('../GlassHiveCapabilityAuthorizationService', () => ({
  reauthorizeCapabilityAuthorization: (...args) => mockReauthorizeCapabilityAuthorization(...args),
}));

jest.mock('../GlassHiveActiveWorkProjectionService', () => ({
  dismissCoreOnlyPreDispatchAttention: (...args) =>
    mockDismissCoreOnlyPreDispatchAttention(...args),
  getCoreWorkDelivery: (...args) => mockGetCoreWorkDelivery(...args),
  getCoreWorkOriginRef: (...args) => mockGetCoreWorkOriginRef(...args),
}));

const { executeGlassHiveWorkAction } = require('../GlassHiveWorkActionService');

describe('GlassHiveWorkActionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildTrustedActionIdempotencyKey.mockReturnValue('trusted-action-key');
    mockGetGenerationJob.mockResolvedValue({
      metadata: {
        userId: 'owner-1',
        viventiumCallSessionId: 'call-session-1',
        viventiumVoiceTaskId: 'voice-task-1',
        interactionContext: {
          surface: 'voice',
          logical_turn_id: 'logical-turn-1',
          source_event_id: 'voice:session-1:request-1',
        },
      },
    });
    mockRecordVoiceOrchestrationTraceBestEffort.mockResolvedValue({ sequence: 1 });
    mockDismissCoreOnlyPreDispatchAttention.mockResolvedValue(null);
    mockGetCoreWorkDelivery.mockResolvedValue({ state: 'delivered', unreadTerminal: false });
    mockGetCoreWorkOriginRef.mockResolvedValue('ghi_original_launch');
    mockGetActiveWorkSnapshot.mockResolvedValue({
      snapshot: 'fresh',
      work: [{ workRef: 'work_00000001', delivery: { state: 'delivered' } }],
    });
    mockReauthorizeCapabilityAuthorization.mockResolvedValue({
      status: 'reauthorized',
      authorizationRef: 'gha_authorization_1',
      workRef: 'work_00000001',
      scopeFingerprint: 'scope-fingerprint-1',
      maxExpiresAt: '2027-01-17T07:59:02.000Z',
    });
    mockRequestAccountApi.mockImplementation(async ({ method = 'GET' }) => {
      if (method === 'GET') {
        return {
          workRef: 'work_00000001',
          attention: { kind: 'auth', code: 'capability_authorization_horizon_expired' },
        };
      }
      return { workRef: 'work_00000001', state: 'queued' };
    });
  });

  test('resume reauthorizes only after owner-scoped GlassHive reports exact auth attention', async () => {
    const action = 'resume';
    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action,
        operationId: 'operation-1',
      }),
    ).resolves.toMatchObject({ state: 'queued' });

    expect(mockRequestAccountApi.mock.calls[0][0]).toEqual({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001',
    });
    expect(mockReauthorizeCapabilityAuthorization).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
    });
    expect(mockRequestAccountApi.mock.calls[1][0]).toEqual({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: {
        action,
        idempotencyKey: 'trusted-action-key',
        capabilityReauthorization: {
          version: 1,
          authorizationRef: 'gha_authorization_1',
          maxExpiresAt: '2027-01-17T07:59:02.000Z',
          scopeFingerprint: 'scope-fingerprint-1',
        },
      },
    });
  });

  test('a rejected retry cannot consume reauthorization before a later resume', async () => {
    mockRequestAccountApi.mockImplementation(async ({ method = 'GET', body }) => {
      if (method === 'GET') {
        return {
          workRef: 'work_00000001',
          attention: { kind: 'auth', code: 'capability_authorization_horizon_expired' },
        };
      }
      if (body?.action === 'retry') {
        throw Object.assign(new Error('retry_not_supported'), { status: 400 });
      }
      return { workRef: 'work_00000001', state: 'queued' };
    });

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'retry',
        operationId: 'operation-retry-rejected',
      }),
    ).rejects.toMatchObject({ status: 400 });

    expect(mockReauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
    expect(mockRequestAccountApi).toHaveBeenLastCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: {
        action: 'retry',
        idempotencyKey: 'trusted-action-key',
        sourceContext: {
          version: 1,
          originRef: 'ghi_original_launch',
          sourceEventId: expect.stringMatching(/^work_action_event_[a-f0-9]{64}$/),
          sourceRevision: 1,
          surface: 'web',
          outputContract: { mode: 'inherit' },
        },
      },
    });

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'resume',
        operationId: 'operation-resume-after-retry',
      }),
    ).resolves.toMatchObject({ state: 'queued' });
    expect(mockReauthorizeCapabilityAuthorization).toHaveBeenCalledTimes(1);
  });

  test('ordinary resume checks authoritative detail but cannot trigger reauthorization from client input', async () => {
    mockRequestAccountApi.mockImplementation(async ({ method = 'GET' }) =>
      method === 'GET'
        ? { workRef: 'work_00000001', attention: { kind: 'input' } }
        : { workRef: 'work_00000001', state: 'running' },
    );

    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'resume',
      operationId: 'operation-2',
    });

    expect(mockReauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(mockRequestAccountApi.mock.calls[1][0].body).toEqual({
      action: 'resume',
      idempotencyKey: 'trusted-action-key',
    });
  });

  test.each([
    'capability_policy_changed',
    'capability_account_unavailable',
    'capability_registry_unavailable',
  ])(
    'repaired needs-input code %s resumes through GH re-admission without horizon refresh',
    async (code) => {
      mockRequestAccountApi.mockImplementation(async ({ method = 'GET' }) =>
        method === 'GET'
          ? { workRef: 'work_00000001', attention: { kind: 'auth', code } }
          : { workRef: 'work_00000001', state: 'queued' },
      );

      await expect(
        executeGlassHiveWorkAction({
          ownerId: 'owner-1',
          workRef: 'work_00000001',
          action: 'resume',
          operationId: `operation-${code}`,
        }),
      ).resolves.toMatchObject({ state: 'queued' });

      expect(mockReauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
      expect(mockRequestAccountApi).toHaveBeenNthCalledWith(2, {
        ownerId: 'owner-1',
        path: '/v1/work/work_00000001/actions',
        method: 'POST',
        body: { action: 'resume', idempotencyKey: 'trusted-action-key' },
      });
    },
  );

  test('non-resume actions stay on the one-request fast path', async () => {
    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'stop',
      operationId: 'operation-3',
    });

    expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: { action: 'stop', idempotencyKey: 'trusted-action-key' },
    });
    expect(mockReauthorizeCapabilityAuthorization).not.toHaveBeenCalled();
    expect(mockInvalidateActiveWorkSnapshot).toHaveBeenCalledWith({ ownerId: 'owner-1' });
  });

  test('a Web Steer carries trusted event-time source context into its replacement run', async () => {
    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'steer',
      instruction: 'Add the requested footer.',
      operationId: 'operation-web-steer-1',
    });

    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: {
        action: 'steer',
        instruction: 'Add the requested footer.',
        idempotencyKey: 'trusted-action-key',
        sourceContext: {
          version: 1,
          originRef: 'ghi_original_launch',
          sourceEventId: expect.stringMatching(/^work_action_event_[a-f0-9]{64}$/),
          sourceRevision: 1,
          surface: 'web',
          outputContract: { mode: 'inherit' },
        },
      },
    });
  });

  test('traces the exact accepted operation from the shared action layer', async () => {
    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'message',
      instruction: 'Add the new evidence section.',
      operationId: 'operation-native-provider-1',
      durableEffectContext: {
        streamId: 'stream-native-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'response-native-1',
      },
    });

    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/work_00000001/actions',
      method: 'POST',
      body: {
        action: 'message',
        instruction: 'Add the new evidence section.',
        idempotencyKey: 'trusted-action-key',
        sourceContext: {
          version: 1,
          originRef: 'ghi_original_launch',
          sourceEventId: expect.stringMatching(/^work_action_event_[a-f0-9]{64}$/),
          sourceRevision: 7,
          surface: 'voice',
          outputContract: { mode: 'inherit' },
        },
      },
    });

    const effectRef = 'operation-native-provider-1';
    expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenNthCalledWith(1, {
      ownerId: 'owner-1',
      callSessionId: 'call-session-1',
      turnId: 'logical-turn-1',
      eventRef: 'operation-native-provider-1',
      stage: 'action.accepted',
      facts: {
        workRef: 'work_00000001',
        streamRef: 'stream-native-1',
        taskRef: 'voice-task-1',
        actionRef: 'operation-native-provider-1',
        receiptRef: effectRef,
        action: 'message',
        effectCount: 1,
      },
    });
    expect(mockRecordVoiceOrchestrationTraceBestEffort).toHaveBeenNthCalledWith(2, {
      ownerId: 'owner-1',
      callSessionId: 'call-session-1',
      turnId: 'logical-turn-1',
      eventRef: effectRef,
      stage: 'control.completed',
      facts: {
        workRef: 'work_00000001',
        streamRef: 'stream-native-1',
        taskRef: 'voice-task-1',
        actionRef: 'operation-native-provider-1',
        receiptRef: effectRef,
        action: 'message',
        effectCount: 1,
      },
    });
  });

  test('does not make accepted actions fail when stream tracing is unavailable', async () => {
    mockGetGenerationJob.mockRejectedValueOnce(new Error('store unavailable'));

    await executeGlassHiveWorkAction({
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'steer',
      instruction: 'Use the shorter heading.',
      operationId: 'operation-unbound-1',
      durableEffectContext: {
        streamId: 'stream-native-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'response-native-1',
      },
    });

    expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
    expect(mockRecordVoiceOrchestrationTraceBestEffort).not.toHaveBeenCalled();
  });

  test('replays the exact durable source context after the generation job expires', async () => {
    mockGetGenerationJob
      .mockResolvedValueOnce({
        metadata: {
          userId: 'owner-1',
          interactionContext: { surface: 'voice', revision: 99, source_event_id: 'ephemeral' },
        },
      })
      .mockResolvedValueOnce(null);
    const input = {
      ownerId: 'owner-1',
      workRef: 'work_00000001',
      action: 'message',
      instruction: 'Keep the same durable instruction.',
      operationId: 'operation-stable-replay',
      durableEffectContext: {
        streamId: 'stream-native-1',
        sourceEventId: 'voice:session-1:request-1',
        sourceRevision: 7,
        sourceSurface: 'voice',
        responseMessageId: 'response-native-1',
      },
    };

    await executeGlassHiveWorkAction(input);
    await executeGlassHiveWorkAction(input);

    const bodies = mockRequestAccountApi.mock.calls.map(([request]) => request.body);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0].sourceContext).toMatchObject({
      originRef: 'ghi_original_launch',
      sourceRevision: 7,
      surface: 'voice',
    });
  });

  test('fails closed when a durable action lacks stamped event-time provenance', async () => {
    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'steer',
        instruction: 'Use the revised heading.',
        operationId: 'operation-missing-provenance',
        durableEffectContext: {
          streamId: 'stream-native-1',
          sourceEventId: 'voice:session-1:request-1',
          responseMessageId: 'response-native-1',
        },
      }),
    ).rejects.toMatchObject({ code: 'glasshive_action_source_context_unavailable', status: 409 });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test('fails closed before dispatch when the original launch origin is unavailable', async () => {
    mockGetCoreWorkOriginRef.mockResolvedValueOnce(null);

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'queue',
        instruction: 'Continue with the next task.',
        operationId: 'operation-origin-missing',
      }),
    ).rejects.toMatchObject({ code: 'glasshive_action_origin_unavailable', status: 409 });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
  });

  test.each(['delivered', 'acknowledged', 'silent'])(
    'dismiss allows only settled Core delivery state %s and refreshes the post-action roster',
    async (deliveryState) => {
      mockGetCoreWorkDelivery.mockResolvedValueOnce({ state: deliveryState });
      mockGetActiveWorkSnapshot
        .mockResolvedValueOnce({
          snapshot: 'fresh',
          work: [{ workRef: 'work_00000001', delivery: { state: deliveryState } }],
        })
        .mockResolvedValueOnce({ snapshot: 'fresh', work: [] });
      await executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'dismiss',
        operationId: 'operation-dismiss',
      });

      expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
      expect(mockGetActiveWorkSnapshot).toHaveBeenCalledTimes(1);
      expect(mockGetActiveWorkSnapshot).toHaveBeenLastCalledWith({
        ownerId: 'owner-1',
        forceRefresh: true,
      });
      expect(mockInvalidateActiveWorkSnapshot).toHaveBeenCalledWith({ ownerId: 'owner-1' });
    },
  );

  test('dismiss resolves exact Core delivery even when the terminal card is beyond the first 50 roster rows', async () => {
    mockGetActiveWorkSnapshot.mockResolvedValue({
      snapshot: 'fresh',
      work: Array.from({ length: 50 }, (_, index) => ({
        workRef: `newer-work-${index}`,
        delivery: { state: 'delivered' },
      })),
    });
    mockGetCoreWorkDelivery.mockResolvedValueOnce({
      state: 'acknowledged',
      unreadTerminal: false,
    });

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'older-terminal-work',
        action: 'dismiss',
        operationId: 'operation-dismiss-page-2',
      }),
    ).resolves.toMatchObject({ state: 'queued' });

    expect(mockGetCoreWorkDelivery).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      workRef: 'older-terminal-work',
    });
    expect(mockRequestAccountApi).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      path: '/v1/work/older-terminal-work/actions',
      method: 'POST',
      body: { action: 'dismiss', idempotencyKey: 'trusted-action-key' },
    });
  });

  test('dismisses a Core-only pre-dispatch failure idempotently without sending a fake workRef to GlassHive', async () => {
    const receipt = {
      accepted: true,
      action: 'dismiss',
      workRef: 'ghi_failed_launch',
      state: 'dismissed',
    };
    mockDismissCoreOnlyPreDispatchAttention.mockResolvedValueOnce(receipt);
    mockGetActiveWorkSnapshot.mockResolvedValueOnce({ snapshot: 'fresh', work: [] });

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'ghi_failed_launch',
        action: 'dismiss',
        operationId: 'operation-local-dismiss',
      }),
    ).resolves.toEqual(receipt);

    expect(mockDismissCoreOnlyPreDispatchAttention).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      originRef: 'ghi_failed_launch',
      operationId: 'operation-local-dismiss',
    });
    expect(mockRequestAccountApi).not.toHaveBeenCalled();
    expect(mockBuildTrustedActionIdempotencyKey).not.toHaveBeenCalled();
    expect(mockInvalidateActiveWorkSnapshot).toHaveBeenCalledWith({ ownerId: 'owner-1' });
    expect(mockGetActiveWorkSnapshot).toHaveBeenCalledWith({
      ownerId: 'owner-1',
      forceRefresh: true,
    });
  });

  test.each(['pending', 'failed', 'unresolved'])(
    'dismiss rejects unsettled Core delivery state %s before proxying to GlassHive',
    async (deliveryState) => {
      mockGetCoreWorkDelivery.mockResolvedValueOnce({ state: deliveryState });
      mockGetActiveWorkSnapshot.mockResolvedValueOnce({
        snapshot: 'fresh',
        work: [{ workRef: 'work_00000001', delivery: { state: deliveryState } }],
      });

      await expect(
        executeGlassHiveWorkAction({
          ownerId: 'owner-1',
          workRef: 'work_00000001',
          action: 'dismiss',
          operationId: `operation-${deliveryState}`,
        }),
      ).rejects.toMatchObject({ code: 'glasshive_dismiss_delivery_not_settled', status: 409 });
      expect(mockRequestAccountApi).not.toHaveBeenCalled();
    },
  );

  test('fails closed before action dispatch when same-scope reauthorization is unavailable', async () => {
    mockReauthorizeCapabilityAuthorization.mockRejectedValueOnce(
      Object.assign(new Error('capability_policy_changed'), { status: 409 }),
    );

    await expect(
      executeGlassHiveWorkAction({
        ownerId: 'owner-1',
        workRef: 'work_00000001',
        action: 'resume',
        operationId: 'operation-4',
      }),
    ).rejects.toThrow('capability_policy_changed');

    expect(mockRequestAccountApi).toHaveBeenCalledTimes(1);
    expect(mockInvalidateActiveWorkSnapshot).not.toHaveBeenCalled();
  });
});

describe('owner-scoped selected action-file adapter', () => {
  const ownerId = 'owner-1';
  const idA = '11111111-1111-4111-8111-111111111111';
  const idB = '22222222-2222-4222-8222-222222222222';
  const foreign = '33333333-3333-4333-8333-333333333333';
  const conversationId = '44444444-4444-4444-8444-444444444444';
  const rootMessage = '55555555-5555-4555-8555-555555555555';
  const parentMessageId = '66666666-6666-4666-8666-666666666666';
  const otherBranch = '77777777-7777-4777-8777-777777777777';
  let rows, body, req;
  beforeEach(() => {
    jest.clearAllMocks();
    rows = [
      {
        file_id: idA,
        user: ownerId,
        filename: 'exact.csv',
        source: 'local',
        bytes: 5,
        filepath: '/owner/original',
      },
      {
        file_id: idB,
        user: ownerId,
        filename: 'parsed.txt',
        source: 'text',
        bytes: 99,
        text: 'Café\n',
      },
      {
        file_id: foreign,
        user: ownerId,
        filename: 'other.csv',
        source: 'local',
        bytes: 1,
        filepath: '/owner/other',
      },
    ];
    body = {
      conversationId,
      parentMessageId,
      files: [
        {
          file_id: idA,
          filename: 'display only',
          media_group_index: 8,
          filepath: '/untrusted/path',
        },
      ],
    };
    req = { user: { id: ownerId } };
    mockProjectTrustedClientPresentation.mockImplementation(() => body);
    mockGetMessages.mockResolvedValue([
      { messageId: rootMessage, parentMessageId: null, files: [{ file_id: idB }] },
      { messageId: parentMessageId, parentMessageId: rootMessage, files: [] },
      { messageId: otherBranch, parentMessageId: rootMessage, files: [{ file_id: foreign }] },
    ]);
    mockGetFiles.mockImplementation(async (filter, _sort, selectFields = { text: 0 }) =>
      rows
        .filter(
          (file) =>
            file.user === filter.user &&
            (typeof filter.file_id === 'string'
              ? file.file_id === filter.file_id
              : filter.file_id.$in.includes(file.file_id)),
        )
        .map((file) => {
          const selected = { ...file };
          if (typeof selectFields === 'object' && selectFields.text === 0) delete selected.text;
          return selected;
        }),
    );
    mockGetDownloadStream.mockImplementation(async () =>
      (async function* () {
        yield Buffer.from('a,b\n1');
      })(),
    );
  });
  const read = async (file) => {
    const chunks = [];
    for await (const chunk of await file.openStream()) chunks.push(chunk);
    return Buffer.concat(chunks);
  };
  test('uses exact owner DB original stream and preserves selected order and current group', async () => {
    const sources = await mockActionFileDependencies.getActionFileSources({
      ownerId,
      fileIds: [idA, idB],
      requestBody: { ignored: true },
      serverReq: req,
    });
    expect(sources.map((f) => f.fileId)).toEqual([idA, idB]);
    expect(sources[0]).toMatchObject({
      filename: 'exact.csv',
      sizeBytes: 5,
      inputKind: 'original',
      mediaGroupIndex: 8,
    });
    expect(await read(sources[0])).toEqual(Buffer.from('a,b\n1'));
    expect(mockGetDownloadStream).toHaveBeenCalledWith(req, '/owner/original');
    expect(mockProjectTrustedClientPresentation).toHaveBeenCalledWith({ ignored: true }, req);
    expect(mockGetMessages).toHaveBeenCalledWith(
      { user: ownerId, conversationId },
      expect.any(String),
    );
  });
  test('labels exact stored UTF-8 extraction without pretending the original is available', async () => {
    const [file] = await mockActionFileDependencies.getActionFileSources({
      ownerId,
      fileIds: [idB],
      requestBody: body,
      serverReq: req,
    });
    expect(file).toMatchObject({ inputKind: 'extracted_text', sizeBytes: 6 });
    expect(await read(file)).toEqual(Buffer.from('Café\n'));
    expect(file.mediaGroupIndex).toBeUndefined();
    expect(mockGetDownloadStream).not.toHaveBeenCalled();
  });
  test('foreign branch selection rejects before stream access', async () => {
    await expect(
      mockActionFileDependencies.getActionFileSources({
        ownerId,
        fileIds: [foreign],
        requestBody: body,
        serverReq: req,
      }),
    ).rejects.toThrow('selection_unauthorized');
    expect(mockGetDownloadStream).not.toHaveBeenCalled();
  });
  test('foreign request owner rejects before selected history or DB access', async () => {
    await expect(
      mockActionFileDependencies.getActionFileSources({
        ownerId,
        fileIds: [idA],
        requestBody: body,
        serverReq: { user: { id: 'other' } },
      }),
    ).rejects.toThrow('owner_unconfirmed');
    expect(mockGetMessages).not.toHaveBeenCalled();
    expect(mockGetFiles).not.toHaveBeenCalled();
  });
  test('deleted or transferred current file rejects despite presented selected ID', async () => {
    rows[0].user = 'other';
    await expect(
      mockActionFileDependencies.getActionFileSources({
        ownerId,
        fileIds: [idA],
        requestBody: body,
        serverReq: req,
      }),
    ).rejects.toThrow('selection_unauthorized');
    expect(mockGetDownloadStream).not.toHaveBeenCalled();
  });
  test('extracted source with missing stored body rejects', async () => {
    delete rows[1].text;
    await expect(
      mockActionFileDependencies.getActionFileSources({
        ownerId,
        fileIds: [idB],
        requestBody: body,
        serverReq: req,
      }),
    ).rejects.toThrow('text_unavailable');
  });
  test('raw source without durable storage path rejects', async () => {
    delete rows[0].filepath;
    await expect(
      mockActionFileDependencies.getActionFileSources({
        ownerId,
        fileIds: [idA],
        requestBody: body,
        serverReq: req,
      }),
    ).rejects.toThrow('original_unavailable');
  });
});
