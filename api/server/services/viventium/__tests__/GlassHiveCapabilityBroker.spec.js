const mockPrepareDurableEffect = jest.fn();
const mockCommitDurableEffect = jest.fn();
const mockSettleDurableEffectFailure = jest.fn();
const mockMarkDurableEffectReceipt = jest.fn();
jest.mock('../InteractionDurableEffectService', () => ({
  prepareDurableEffect: (...args) => mockPrepareDurableEffect(...args),
  commitDurableEffect: (...args) => mockCommitDurableEffect(...args),
  settleDurableEffectFailure: (...args) => mockSettleDurableEffectFailure(...args),
}));
const mockAssertVoiceWorkAuthority = jest.fn();
const mockAssertCurrentGlassHiveSourceAuthor = jest.fn();
jest.mock('../VoiceWorkAuthorityService', () => ({
  assertVoiceWorkAuthority: (...args) => mockAssertVoiceWorkAuthority(...args),
}));
jest.mock('../GlassHiveWorkResultService', () => ({
  getGlassHiveWorkResult: (...args) => mockGetGlassHiveWorkResult(...args),
}));
const mockGetMCPServersRegistry = jest.fn();
const mockGetMCPManager = jest.fn();
const mockGetFlowStateManager = jest.fn(() => ({}));
const mockGetLogStores = jest.fn(() => {
  const store = new Map();
  return {
    get: jest.fn((key) => Promise.resolve(store.get(key))),
    set: jest.fn((key, value) => {
      store.set(key, value);
      return Promise.resolve();
    }),
  };
});
const mockReinitMCPServer = jest.fn();
const mockInspectStoredOAuthCredentialState = jest.fn();
const mockGetUserById = jest.fn();
const mockGetFiles = jest.fn();
const mockGetMessages = jest.fn();
const mockGetDownloadStream = jest.fn();
const mockGetStrategyFunctions = jest.fn(() => ({ getDownloadStream: mockGetDownloadStream }));
const mockConfiguredTranscribe = jest.fn(async () => ({
  status: 'completed',
  transcript: 'A spoken request.',
}));
const mockCreateFileSearchTool = jest.fn();
const mockLoadWebSearchAuth = jest.fn();
const mockLoadAuthValues = jest.fn();
const mockCreateViventiumSearchTool = jest.fn();
const mockGetActiveWorkPage = jest.fn();
const mockGetActiveWorkHistoryPage = jest.fn();
const mockGetGlassHiveWorkResult = jest.fn();
const mockInvalidateActiveWorkSnapshot = jest.fn();
const mockExecuteGlassHiveWorkAction = jest.fn();
const mockMarkGlassHiveLaunchDispatchUnknown = jest.fn();
const mockMarkGlassHiveLaunchDispatchRejected = jest.fn();
const mockReconcileGlassHiveLaunchResult = jest.fn();
const mockRegisterGlassHiveLaunchContext = jest.fn();
const mockMarkGlassHiveLaunchDispatchReady = jest.fn();
const mockMarkGlassHiveLaunchPreDispatchFailed = jest.fn();
const mockCreateCapabilityAuthorization = jest.fn();
const mockAttachGlassHiveTrustedLaunchMetadata = jest.fn((args, launchContext) => ({
  ...args,
  bootstrap_bundle_json: {
    ...(args?.bootstrap_bundle_json || {}),
    callbacks: { origin_ref: launchContext.originRef },
    viventium_delegation_identity: launchContext.delegationIdentity,
    viventium_delegation_context: launchContext.delegationContext,
  },
}));
const SYNTHETIC_TURN_SCOPE = Object.freeze({
  conversation_id: 'conversation-synthetic',
  message_id: 'message-synthetic',
});

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  CacheKeys: { ...jest.requireActual('librechat-data-provider').CacheKeys, FLOWS: 'flows' },
  Constants: { mcp_delimiter: '_mcp_' },
  SystemRoles: { ADMIN: 'ADMIN', USER: 'USER' },
}));

jest.mock('~/cache', () => ({
  getLogStores: (...args) => mockGetLogStores(...args),
}));

jest.mock('~/config', () => ({
  getMCPServersRegistry: (...args) => mockGetMCPServersRegistry(...args),
  getMCPManager: (...args) => mockGetMCPManager(...args),
  getFlowStateManager: (...args) => mockGetFlowStateManager(...args),
}));

jest.mock('~/models', () => ({
  getFiles: (...args) => mockGetFiles(...args),
  getMessages: (...args) => mockGetMessages(...args),
  findToken: jest.fn(),
  createToken: jest.fn(),
  updateToken: jest.fn(),
  deleteToken: jest.fn(),
  getUserById: (...args) => mockGetUserById(...args),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: (...args) => mockGetStrategyFunctions(...args),
}));

jest.mock('~/server/services/GraphTokenService', () => ({
  getGraphApiToken: jest.fn(),
}));

jest.mock('~/server/services/Tools/mcp', () => ({
  buildMcpOAuthRecovery: (server) => ({
    action: 'connect_mcp_account',
    surface: 'agent_builder',
    server,
    instructions:
      'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
  }),
  inspectStoredOAuthCredentialState: (...args) => mockInspectStoredOAuthCredentialState(...args),
  reinitMCPServer: (...args) => mockReinitMCPServer(...args),
}));

jest.mock('@librechat/api', () => ({
  assertCurrentGlassHiveSourceAuthor: (...args) => mockAssertCurrentGlassHiveSourceAuthor(...args),
  GenerationJobManager: {
    getJobStore: jest.fn(),
    markDurableEffectReceipt: (...args) => mockMarkDurableEffectReceipt(...args),
  },
  isManagedSourceMutation: (...args) =>
    jest.requireActual('@librechat/api').isManagedSourceMutation(...args),
  executeManagedSourceMutation: async (options) => {
    const api = jest.requireActual('@librechat/api');
    if (!api.isManagedSourceMutation(options.requestBody)) return (await options.dispatch()).result;
    return api.executeSourceMutation({
      input: {
        streamId: options.requestBody.viventiumStreamId,
        userId: options.userId,
        sourceEventId: options.requestBody.viventiumSourceEventId,
        adapterId: options.adapterId,
        routeId: options.routeId,
        operation: options.operation,
        effectKind: options.effectKind,
        effectOrdinal: 0,
        effectOccurrenceRef: options.occurrenceId,
        providerIdempotencyKey: options.providerIdempotencyKey,
        providerIdempotencyMode: options.providerIdempotencyMode,
        canonicalArgs: options.canonicalArgs,
      },
      service: options.service,
      dispatch: options.dispatch,
      recordReceipt: options.recordReceipt,
      assertAuthor: async () => {
        try {
          await mockAssertCurrentGlassHiveSourceAuthor(options);
        } catch (error) {
          await options.rejectDispatch?.(error);
          throw error;
        }
      },
    });
  },
  getTrustedInteractionContext: (...args) =>
    jest.requireActual('@librechat/api').getTrustedInteractionContext(...args),
  fingerprintTraceReference: (...args) =>
    jest.requireActual('@librechat/api').fingerprintTraceReference(...args),
  mainDelegationJsonSchema: (...args) =>
    jest.requireActual('@librechat/api').mainDelegationJsonSchema(...args),
  resolveBackgroundWorkerRoute: (...args) =>
    jest.requireActual('@librechat/api').resolveBackgroundWorkerRoute(...args),
  backgroundWorkerResources: (...args) =>
    jest.requireActual('@librechat/api').backgroundWorkerResources(...args),
  resolveSelectedDelegationAttachments: (...args) =>
    jest.requireActual('@librechat/api').resolveSelectedDelegationAttachments(...args),
  resolveSelectedHistoryAttachments: (...args) =>
    jest.requireActual('@librechat/api').resolveSelectedHistoryAttachments(...args),
  readActiveWork: (...args) => jest.requireActual('@librechat/api').readActiveWork(...args),
  audioTranscriptionDefinition: jest.requireActual('@librechat/api').audioTranscriptionDefinition,
  transcriptionAttachmentReferences:
    jest.requireActual('@librechat/api').transcriptionAttachmentReferences,
  transcribeAttachedAudio: (input, dependencies) =>
    jest
      .requireActual('@librechat/api')
      .transcribeAttachedAudio(input, { ...dependencies, transcribe: mockConfiguredTranscribe }),
  reportCortexHostToolResult: jest.fn(),
  loadWebSearchAuth: (...args) => mockLoadWebSearchAuth(...args),
}));

jest.mock('../GlassHiveConversationOrchestration', () => {
  const delegationTool = 'worker_delegate_once_mcp_glasshive-workers-projects';
  const orchestrationTools = new Set([delegationTool, 'active_work_list', 'active_work_action']);
  const mutationTools = new Set([delegationTool, 'active_work_action']);
  const canonical = (toolName, args = {}) => {
    if (toolName === delegationTool) {
      return jest
        .requireActual('@librechat/api')
        .canonicalConversationOrchestrationArguments(toolName, args);
    }
    if (toolName === 'active_work_action') {
      return jest
        .requireActual('@librechat/api')
        .canonicalConversationOrchestrationArguments(toolName, args);
    }
    return args;
  };
  return {
    ACTIVE_WORK_ACTION_DESCRIPTION: 'Control one existing durable mission.',
    ACTIVE_WORK_ACTION_JSON_SCHEMA:
      jest.requireActual('@librechat/api').ACTIVE_WORK_ACTION_JSON_SCHEMA,
    ACTIVE_WORK_LIST_DESCRIPTION: 'List existing durable missions.',
    ACTIVE_WORK_LIST_JSON_SCHEMA: { type: 'object', properties: {}, additionalProperties: false },
    DELEGATION_TOOL_NAME: delegationTool,
    MAIN_DELEGATION_DESCRIPTION: 'Start one durable background mission.',
    MAIN_DELEGATION_JSON_SCHEMA: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        instruction: { type: 'string' },
        resourceClass: { type: 'string', enum: ['standard', 'light'] },
      },
      required: ['title', 'instruction', 'resourceClass'],
      additionalProperties: false,
    },
    MAIN_DELEGATION_PROFILES: ['codex-cli', 'claude-code', 'openclaw-general'],
    canonicalConversationOrchestrationArguments: canonical,
    isConversationOrchestrationMutationTool: (value) => mutationTools.has(String(value || '')),
    isConversationOrchestrationTool: (value) => orchestrationTools.has(String(value || '')),
  };
});

jest.mock('../GlassHiveSourceSelection', () => ({
  selectTrustedLaunchRequestBody: (...args) =>
    jest.requireActual('@librechat/api').selectTrustedLaunchRequestBody(...args),
  trustedUploadedFilesFromRequestBody: (...args) =>
    jest.requireActual('@librechat/api').trustedUploadedFilesFromRequestBody(...args),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: mockLoadAuthValues,
}));

jest.mock('~/app/clients/tools/util/fileSearch', () => ({
  createFileSearchTool: (...args) => mockCreateFileSearchTool(...args),
  fileSearchJsonSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
}));

jest.mock('~/app/clients/tools/util/viventiumSearchTool', () => ({
  createViventiumSearchTool: (...args) => mockCreateViventiumSearchTool(...args),
}));

jest.mock('../GlassHiveAccountService', () => ({
  buildTrustedActionIdempotencyKey: (...args) =>
    jest.requireActual('@librechat/api').buildTrustedActionIdempotencyKey(...args),
  getActiveWorkPage: (...args) => mockGetActiveWorkPage(...args),
  getActiveWorkHistoryPage: (...args) => mockGetActiveWorkHistoryPage(...args),
  invalidateActiveWorkSnapshot: (...args) => mockInvalidateActiveWorkSnapshot(...args),
}));

jest.mock('../GlassHiveWorkActionService', () => ({
  executeGlassHiveWorkAction: (...args) => mockExecuteGlassHiveWorkAction(...args),
}));

jest.mock('../GlassHiveCallbackBindingService', () => ({
  attachGlassHiveTrustedLaunchMetadata: (...args) =>
    mockAttachGlassHiveTrustedLaunchMetadata(...args),
  registerGlassHiveLaunchContext: (...args) => mockRegisterGlassHiveLaunchContext(...args),
  markGlassHiveLaunchDispatchReady: (...args) => mockMarkGlassHiveLaunchDispatchReady(...args),
  markGlassHiveLaunchPreDispatchFailed: (...args) =>
    mockMarkGlassHiveLaunchPreDispatchFailed(...args),
  markGlassHiveLaunchDispatchUnknown: (...args) => mockMarkGlassHiveLaunchDispatchUnknown(...args),
  markGlassHiveLaunchDispatchRejected: (...args) =>
    mockMarkGlassHiveLaunchDispatchRejected(...args),
  reconcileGlassHiveLaunchResult: (...args) => mockReconcileGlassHiveLaunchResult(...args),
}));

jest.mock('../GlassHiveCapabilityAuthorizationService', () => ({
  createCapabilityAuthorization: (...args) => mockCreateCapabilityAuthorization(...args),
}));

describe('GlassHive capability broker', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetMessages.mockReset().mockResolvedValue([]);
    mockPrepareDurableEffect
      .mockReset()
      .mockResolvedValue({ decision: 'dispatch', effectKey: 'effect', claimToken: 'claim' });
    mockCommitDurableEffect.mockReset().mockImplementation(async (input) => ({
      ownerId: 'user-1',
      sourceEventId: 'source-1',
      responseMessageId: 'msg-1',
      effectKind: 'durable_work_accepted',
      providerReceiptRef: input.providerReceiptRef,
    }));
    mockSettleDurableEffectFailure
      .mockReset()
      .mockResolvedValue({ status: 'provider_outcome_unknown' });
    mockMarkDurableEffectReceipt.mockReset().mockResolvedValue({ status: 'recorded' });
    mockAssertCurrentGlassHiveSourceAuthor.mockReset().mockResolvedValue(undefined);
    mockGetLogStores.mockImplementation(() => {
      const store = new Map();
      return {
        get: jest.fn((key) => Promise.resolve(store.get(key))),
        set: jest.fn((key, value) => {
          store.set(key, value);
          return Promise.resolve();
        }),
      };
    });
    process.env = {
      ...originalEnv,
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET: 'test-broker-secret',
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED: 'true',
      VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_URL: 'http://broker.example/mcp',
      GLASSHIVE_ENTERPRISE_TENANT_ID: 'tenant-a',
      VIVENTIUM_GLASSHIVE_BROKER_DISCOVERY_RETRY_DELAY_MS: '0',
    };
    mockGetUserById.mockResolvedValue({ _id: 'user-1', id: 'user-1', role: 'USER' });
    mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: 'credential_present' });
    mockRegisterGlassHiveLaunchContext.mockResolvedValue({
      bindingId: 'ghi-synthetic',
      originRef: 'ghi-synthetic',
      delegationIdentity: {
        idempotency_key: 'a'.repeat(64),
        goal_digest: 'b'.repeat(64),
        source_event_id: 'synthetic-source-event',
        objective_ordinal: 0,
        call_identity_digest: 'c'.repeat(64),
      },
      delegationContext: {
        source_event_id: 'synthetic-source-event',
        triggering_source_segments: [],
      },
    });
    mockMarkGlassHiveLaunchDispatchReady.mockResolvedValue({ launchState: 'dispatch_ready' });
    mockMarkGlassHiveLaunchPreDispatchFailed.mockResolvedValue({ launchState: 'not_dispatched' });
    mockCreateCapabilityAuthorization.mockImplementation(async (input) => ({
      ...(Array.isArray(input.eagerServers)
        ? { eagerServers: input.eagerServers, deferredServers: input.deferredServers }
        : {}),
      authorizationRef: 'gha-synthetic-authorization',
      originRef: 'ghi-synthetic',
      scopeFingerprint: 'synthetic-scope-fingerprint',
      maxExpiresAt: new Date('2026-09-03T00:00:00.000Z'),
    }));
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('reserves inference requests through the shared atomic counter', async () => {
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_RATE_LIMIT_PER_WINDOW = '2';
    let count = 0;
    const reserveWithinLimit = jest.fn(async (_key, limit) => {
      if (count >= limit) {
        return { accepted: false, count };
      }
      count += 1;
      return { accepted: true, count };
    });
    mockGetLogStores.mockImplementation(() => ({
      opts: { namespace: 'flows', store: { reserveWithinLimit } },
    }));
    const { rememberBrokerRequest } = require('../GlassHiveCapabilityBrokerAuth');
    const grant = { grant_id: 'ghcb_12345678' };

    const results = await Promise.all([
      rememberBrokerRequest({ grant, nowMs: 1_000 }),
      rememberBrokerRequest({ grant, nowMs: 1_000 }),
      rememberBrokerRequest({ grant, nowMs: 1_000 }),
    ]);

    expect(results.filter((result) => result.accepted)).toHaveLength(2);
    expect(results.filter((result) => result.rateLimited)).toHaveLength(1);
    expect(reserveWithinLimit).toHaveBeenCalledTimes(3);
    expect(mockGetLogStores.mock.results[0].value.get).toBeUndefined();
  });

  test('native audio catalog and invocation retain signed file IDs and use only owner-resolved storage', async () => {
    const { Readable } = require('stream');
    const {
      mintBrokerGrant,
      verifyBrokerGrant,
      persistBrokerGrantResources,
      hydrateBrokerGrantResources,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      handleToolCall,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    const fileId = '11111111-1111-4111-8111-111111111111';
    const files = [{ file_id: fileId, filename: 'recording.m4a', type: 'audio/mp4', bytes: 4 }];
    mockGetMCPServersRegistry.mockReturnValue({});
    const minted = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedHostTools: ['transcribe_audio'],
      hostToolResources: { transcribe_audio: { files } },
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    });
    await persistBrokerGrantResources(minted);
    const grant = await hydrateBrokerGrantResources(verifyBrokerGrant(minted.token));
    const catalog = await buildCapabilityCatalog({ grant });
    const definition = toolDefinitionsForMcp(catalog).find(
      (tool) => tool.name === 'transcribe_audio',
    );
    expect(definition.inputSchema.properties.file_id.oneOf).toEqual([
      { const: fileId, title: 'recording.m4a' },
    ]);
    expect(definition.inputSchema.additionalProperties).toBe(false);
    const stream = Readable.from(Buffer.from('data'));
    mockGetFiles.mockResolvedValue([
      { ...files[0], source: 'local', filepath: '/owned/recording.m4a' },
    ]);
    mockGetDownloadStream.mockResolvedValue(stream);
    const result = await handleToolCall({
      grant,
      toolName: 'transcribe_audio',
      args: { file_id: fileId },
    });
    expect(result).toMatchObject({
      status: 'completed',
      transcript: 'A spoken request.',
      file_id: fileId,
    });
    expect(mockGetFiles).toHaveBeenCalledWith({ user: 'user-1', file_id: fileId });
    expect(mockGetStrategyFunctions).toHaveBeenCalledWith('local');
    expect(mockGetDownloadStream).toHaveBeenCalledWith(
      expect.objectContaining({ user: expect.objectContaining({ id: 'user-1' }) }),
      '/owned/recording.m4a',
    );
    expect(mockConfiguredTranscribe).toHaveBeenCalledWith(stream, 4, undefined);
    expect(stream.destroyed).toBe(true);
  });

  test('native audio rejects ungranted files, arbitrary paths and another owner’s absent File', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    const fileId = '11111111-1111-4111-8111-111111111111';
    mockGetMCPServersRegistry.mockReturnValue({});
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedHostTools: ['transcribe_audio'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
      hostToolResources: {
        transcribe_audio: { files: [{ file_id: fileId, filename: 'recording.m4a' }] },
      },
    }).payload;
    for (const args of [
      { file_id: '22222222-2222-4222-8222-222222222222' },
      { file_id: fileId, path: '/private/ungranted.m4a' },
      { path: '/private/ungranted.m4a' },
    ]) {
      expect(await handleToolCall({ grant, toolName: 'transcribe_audio', args })).toMatchObject({
        status: 'rejected',
        code: 'attachment_not_authorized',
      });
    }
    expect(mockGetFiles).not.toHaveBeenCalled();
    mockGetFiles.mockResolvedValue([]);
    expect(
      await handleToolCall({ grant, toolName: 'transcribe_audio', args: { file_id: fileId } }),
    ).toMatchObject({ status: 'rejected', code: 'attachment_not_found' });
    expect(mockGetDownloadStream).not.toHaveBeenCalled();
    expect(mockConfiguredTranscribe).not.toHaveBeenCalled();
  });

  test.each([
    { allowedHostTools: [] },
    {
      allowedHostTools: ['transcribe_audio'],
      hostToolResources: { transcribe_audio: { files: [] } },
    },
  ])(
    'native audio is absent from the broker catalog without a tool grant or current resources (%p)',
    async (scope) => {
      const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
      const {
        buildCapabilityCatalog,
        toolDefinitionsForMcp,
      } = require('../GlassHiveCapabilityBrokerService');
      mockGetMCPServersRegistry.mockReturnValue({});
      const grant = mintBrokerGrant({
        user: { id: 'user-1', role: 'USER' },
        requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
        ...scope,
      }).payload;
      expect(
        toolDefinitionsForMcp(await buildCapabilityCatalog({ grant })).map((tool) => tool.name),
      ).not.toContain('transcribe_audio');
    },
  );

  test('mints and verifies scoped grants and rejects tampering', () => {
    const { mintBrokerGrant, verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { token, payload } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace', 'ms-365'],
      eagerServers: ['google_workspace'],
      deferredServers: ['ms-365'],
      requestContext: {
        conversation_id: 'conv-1',
        message_id: 'msg-1',
        authorization_ref: 'gha-synthetic-authorization',
        container_generation_id: 'a'.repeat(64),
      },
      executionMode: 'docker',
      nowMs: 1_000_000,
    });

    const verified = verifyBrokerGrant(token, { nowMs: 1_001_000, expectedUserId: 'user-1' });
    expect(verified.aud).toBe('glasshive-capability-broker');
    expect(verified.allowed_servers).toEqual(['google_workspace', 'ms-365']);
    expect(verified.eager_servers).toEqual(['google_workspace']);
    expect(verified.deferred_servers).toEqual(['ms-365']);
    expect(verified.grant_id).toBe(payload.grant_id);
    expect(verified.scopes.content_read).toBe(false);
    expect(verified.allow_dynamic_policy_servers).toBe(false);
    expect(verified.authorization_ref).toBe('gha-synthetic-authorization');
    expect(verified.container_generation_id).toBe('a'.repeat(64));

    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.user_id = 'user-2';
    const tampered = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(() => verifyBrokerGrant(tampered)).toThrow(/signature/);
  });

  test('signs the exact host startup lease and rejects lease tampering', () => {
    const { mintBrokerGrant, verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      requestContext: {
        conversation_id: 'conv-1',
        message_id: 'msg-1',
        host_startup_lease_id: 'b'.repeat(64),
      },
      executionMode: 'host',
      nowMs: 1_000_000,
    });
    expect(verifyBrokerGrant(token, { nowMs: 1_001_000 }).host_startup_lease_id).toBe(
      'b'.repeat(64),
    );
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    decoded.host_startup_lease_id = 'c'.repeat(64);
    expect(() =>
      verifyBrokerGrant(Buffer.from(JSON.stringify(decoded)).toString('base64url'), {
        nowMs: 1_001_000,
      }),
    ).toThrow(/signature/);
  });

  test('signs the conversation-orchestrator authority without changing policy-v2 server scopes', () => {
    const {
      BROKER_AUTHORITY_KINDS,
      mintBrokerGrant,
      verifyBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      authorityKind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
      allowedServers: ['google_workspace', 'ms-365'],
      eagerServers: ['google_workspace'],
      deferredServers: ['ms-365'],
      allowedHostTools: ['active_work_list'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
      executionMode: 'host',
      nowMs: 1_000_000,
    });

    expect(verifyBrokerGrant(grant.token, { nowMs: 1_001_000 })).toMatchObject({
      authority_kind: 'conversation_orchestrator',
      policy_version: 2,
      tenant_id: 'tenant-a',
      allowed_servers: ['google_workspace', 'ms-365'],
      eager_servers: ['google_workspace'],
      deferred_servers: ['ms-365'],
      allowed_host_tools: ['active_work_list'],
    });
  });

  test('projects Main orchestration into one signed provider grant with server-side resources', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const {
      hydrateBrokerGrantResources,
      verifyBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });

    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'USER' },
      requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
      allowedConversationOrchestrationTools: [
        'worker_delegate_once_mcp_glasshive-workers-projects',
        'active_work_list',
        'active_work_action',
      ],
      workerProfile: 'codex-cli',
      workerAccess: 'full',
      fallbackWorkerProfile: 'claude-code',
    });
    const grant = await hydrateBrokerGrantResources(
      verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
        nowMs: Date.now(),
        requireTurnScope: true,
      }),
    );

    expect(grant.authority_kind).toBe('conversation_orchestrator');
    expect(grant.allowed_host_tools).toEqual([
      'active_work_action',
      'active_work_list',
      'worker_delegate_once_mcp_glasshive-workers-projects',
    ]);
    expect(grant.host_tool_resources).toMatchObject({
      active_work_action: { version: 1 },
      'worker_delegate_once_mcp_glasshive-workers-projects': {
        version: 1,
        file_selection: { version: 1 },
        request_body: { conversationId: 'conv-1', messageId: 'msg-1' },
        worker_profile: 'codex-cli',
        worker_access: 'full',
        fallback_worker_profile: 'claude-code',
        mission_host_tools: [],
      },
    });
    expect(bundle.glasshive_capability_broker.allowed_host_tools).toEqual(grant.allowed_host_tools);
    for (const brief of [bundle.agents_md, bundle.claude_md, bundle.codex_md]) {
      expect(brief).toContain('This list is the scope of this invocation only');
      expect(brief).toContain(
        'Absence means the host did not resolve or authorize them for this invocation',
      );
      expect(brief).not.toContain('same resolved host capabilities available to the main Agent');
    }
  });

  test('joins a created broker grant to its signed current scope with hashes only', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const { verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { logger } = require('@librechat/data-schemas');
    const requestBody = {
      conversationId: 'conversation-synthetic-private',
      messageId: 'message-synthetic-private',
      text: 'Private synthetic request content.',
      privateMetadata: {
        url: 'https://private.example.test/record',
        token: 'private-token-marker',
      },
      viventiumGlassHiveTurnContextB64: 'private-context-marker',
    };
    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1' },
      requestBody,
      allowedConversationOrchestrationTools: ['active_work_action'],
      workerModel: 'synthetic-private-model',
    });
    const grant = verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN);
    const events = logger.info.mock.calls
      .map(([line]) => JSON.parse(line))
      .filter((event) => event.event === 'glasshive_broker_grant_created');
    const hash = (value) => require('crypto').createHash('sha256').update(value).digest('hex');
    expect(events).toEqual([
      {
        event: 'glasshive_broker_grant_created',
        grant_id_sha256: hash(grant.grant_id),
        message_id_sha256: hash(grant.message_id),
        conversation_id_sha256: hash(grant.conversation_id),
      },
    ]);
    const serialized = JSON.stringify(events);
    for (const value of [
      grant.grant_id,
      requestBody.messageId,
      requestBody.conversationId,
      requestBody.text,
      requestBody.privateMetadata.url,
      requestBody.privateMetadata.token,
      requestBody.viventiumGlassHiveTurnContextB64,
      'synthetic-private-model',
      bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN,
    ])
      expect(serialized).not.toContain(value);
    expect(Object.keys(events[0]).sort()).toEqual(
      ['event', 'grant_id_sha256', 'message_id_sha256', 'conversation_id_sha256'].sort(),
    );
  });

  test('records only the present signed scope on an explicit first-message turn', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const { verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { logger } = require('@librechat/data-schemas');
    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1' },
      requestBody: { messageId: 'message-synthetic-first', turnId: 'turn-synthetic-first' },
      allowedConversationOrchestrationTools: ['active_work_action'],
    });
    const grant = verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN);
    const event = JSON.parse(logger.info.mock.calls[0][0]);
    expect(event.conversation_id_sha256).toBeNull();
    expect(event.message_id_sha256).toBe(
      require('crypto').createHash('sha256').update(grant.message_id).digest('hex'),
    );
    expect(JSON.stringify(event)).not.toContain('turn-synthetic-first');
  });

  test('keeps a valid broker grant when diagnostic logging throws', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const {
      verifyBrokerGrant,
      hydrateBrokerGrantResources,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const { logger } = require('@librechat/data-schemas');
    logger.info.mockImplementationOnce(() => {
      throw new Error('synthetic diagnostic failure');
    });
    const body = { conversationId: 'conv-1', messageId: 'msg-1', text: 'Exact retained request.' };
    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1' },
      requestBody: body,
      allowedConversationOrchestrationTools: ['active_work_action'],
    });
    expect(bundle.glasshive_capability_status?.reason).not.toBe('grant_unavailable');
    const grant = await hydrateBrokerGrantResources(
      verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN),
    );
    expect(grant.host_tool_resources.active_work_action.request_body).toEqual(body);
    expect(grant.allowed_host_tools).toEqual(['active_work_action']);
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('Provider bundle grant unavailable'),
      expect.anything(),
    );
  });

  test('retains a long admitted request once so Main does not lose its two action capabilities', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const {
      hydrateBrokerGrantResources,
      verifyBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    const delegationTool = 'worker_delegate_once_mcp_glasshive-workers-projects';
    const requestBody = {
      conversationId: 'conv-1',
      parentMessageId: 'parent-1',
      messageId: 'msg-1',
      viventiumGlassHiveTurnContextB64: Buffer.from(
        JSON.stringify({
          history: [{ role: 'user', content: 'Synthetic retained context. '.repeat(10500) }],
          memory: 'Exact synthetic memory.',
          feelings: { state: 'retained' },
        }),
      ).toString('base64'),
      files: [{ file_id: 'current-upload', filename: 'input.txt' }],
      privateMetadata: { sourceRevision: 7, sourceEventId: 'source-current' },
    };
    expect(Buffer.byteLength(JSON.stringify(requestBody)) * 2).toBeGreaterThan(512 * 1024);
    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'USER' },
      requestBody,
      allowedConversationOrchestrationTools: [delegationTool, 'active_work_action'],
      workerProfile: 'codex-cli',
      workerMemory: 'Exact independent worker memory.',
    });
    expect(bundle.glasshive_capability_status?.reason).not.toBe('grant_unavailable');
    const grant = await hydrateBrokerGrantResources(
      verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
        expectedUserId: 'user-1',
        expectedTenantId: 'tenant-a',
        requireTurnScope: true,
      }),
    );
    const actionBody = grant.host_tool_resources.active_work_action.request_body;
    expect(actionBody).toEqual(requestBody);
    expect(grant.host_tool_resources[delegationTool].request_body).toBe(actionBody);
    expect(grant.host_tool_resources[delegationTool].worker_memory).toBe(
      'Exact independent worker memory.',
    );
    mockGetMCPServersRegistry.mockReturnValue({});
    mockExecuteGlassHiveWorkAction.mockResolvedValue({ status: 'accepted' });
    await handleToolCall({
      grant,
      toolName: 'active_work_action',
      args: { workRef: 'work-1', action: 'resume' },
      invocationId: 'resume-occurrence-1',
    });
    expect(mockExecuteGlassHiveWorkAction).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: actionBody }),
    );
    expect(JSON.stringify(bundle)).not.toContain(requestBody.viventiumGlassHiveTurnContextB64);
  });

  test.each([
    ['active_work_action'],
    ['worker_delegate_once_mcp_glasshive-workers-projects'],
    ['active_work_action', 'worker_delegate_once_mcp_glasshive-workers-projects'],
  ])(
    'hydrates the same signed conversation body for each allowed action subset %j',
    async (...tools) => {
      const {
        mintBrokerGrant,
        hydrateBrokerGrantResources,
        verifyBrokerGrant,
        BROKER_AUTHORITY_KINDS,
      } = require('../GlassHiveCapabilityBrokerAuth');
      const body = {
        conversationId: 'conv-1',
        messageId: 'msg-1',
        source: { exact: 'Synthetic original goal', revision: 3 },
        history: [{ text: 'Prior input' }],
      };
      const minted = mintBrokerGrant({
        user: { id: 'user-1' },
        authorityKind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
        requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
        allowedHostTools: tools,
        conversationRequestBody: body,
        hostToolResources: Object.fromEntries(
          tools.map((name) => [
            name,
            { version: 1, request_body_ref: 'conversation_request_body' },
          ]),
        ),
      });
      expect(minted.resourceRecord.resources.conversation_request_body).toEqual(body);
      expect(
        Object.values(minted.resourceRecord.resources).filter((x) => x?.request_body),
      ).toHaveLength(0);
      const hydrated = await hydrateBrokerGrantResources(verifyBrokerGrant(minted.token));
      for (const name of tools)
        expect(hydrated.host_tool_resources[name].request_body).toEqual(body);
      if (tools.length === 2)
        expect(hydrated.host_tool_resources[tools[0]].request_body).toBe(
          hydrated.host_tool_resources[tools[1]].request_body,
        );
    },
  );

  test.each([
    ['missing body', undefined, { version: 1, request_body_ref: 'conversation_request_body' }],
    [
      'unknown reference',
      { exact: 'retained' },
      { version: 1, request_body_ref: 'foreign_request' },
    ],
    [
      'ambiguous inline body',
      { exact: 'retained' },
      {
        version: 1,
        request_body_ref: 'conversation_request_body',
        request_body: { different: true },
      },
    ],
  ])(
    'fails closed for %s at signed conversation resource hydration',
    async (_name, body, descriptor) => {
      const {
        mintBrokerGrant,
        hydrateBrokerGrantResources,
        verifyBrokerGrant,
        BROKER_AUTHORITY_KINDS,
      } = require('../GlassHiveCapabilityBrokerAuth');
      const minted = mintBrokerGrant({
        user: { id: 'user-1' },
        authorityKind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
        requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
        allowedHostTools: ['active_work_action'],
        conversationRequestBody: body,
        hostToolResources: { active_work_action: descriptor },
      });
      await expect(hydrateBrokerGrantResources(verifyBrokerGrant(minted.token))).rejects.toThrow(
        /conversation resource scope is unavailable/,
      );
    },
  );

  test('isolates consumer changes from the retained signed shared body', async () => {
    const {
      mintBrokerGrant,
      hydrateBrokerGrantResources,
      verifyBrokerGrant,
      BROKER_AUTHORITY_KINDS,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const minted = mintBrokerGrant({
      user: { id: 'user-1' },
      authorityKind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
      allowedHostTools: ['active_work_action'],
      conversationRequestBody: { source: { exact: 'retained' } },
      hostToolResources: {
        active_work_action: { version: 1, request_body_ref: 'conversation_request_body' },
      },
    });
    const grant = verifyBrokerGrant(minted.token);
    const first = await hydrateBrokerGrantResources(grant);
    first.host_tool_resources.active_work_action.request_body.source.exact = 'consumer-only';
    const second = await hydrateBrokerGrantResources(grant);
    expect(second.host_tool_resources.active_work_action.request_body.source.exact).toBe(
      'retained',
    );
    expect(minted.resourceRecord.resources.conversation_request_body.source.exact).toBe('retained');
  });

  test('rejects a mission-worker shared conversation resource and a changed signed body', async () => {
    const {
      mintBrokerGrant,
      hydrateBrokerGrantResources,
      verifyBrokerGrant,
      BROKER_AUTHORITY_KINDS,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const input = {
      user: { id: 'user-1' },
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
      allowedHostTools: ['active_work_action'],
      conversationRequestBody: { exact: 'retained' },
      hostToolResources: {
        active_work_action: { version: 1, request_body_ref: 'conversation_request_body' },
      },
    };
    expect(() => mintBrokerGrant(input)).toThrow(/conversation resource scope is invalid/);
    const minted = mintBrokerGrant({
      ...input,
      authorityKind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
    });
    minted.resourceRecord.resources.conversation_request_body.exact = 'changed';
    await expect(hydrateBrokerGrantResources(verifyBrokerGrant(minted.token))).rejects.toThrow(
      /resource scope is unavailable/,
    );
  });

  test('keeps large authorized evidence without duplicating raw tool resources in launch envelopes', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const {
      hydrateBrokerGrantResources,
      verifyBrokerGrant,
      mintBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const delegationTool = 'worker_delegate_once_mcp_glasshive-workers-projects';
    const files = [{ file_id: 'synthetic-recall', text: 'e'.repeat(140000) }];
    const hostToolResources = { file_search: { entity_id: 'main', files } };
    const requestBody = {
      conversationId: 'conv-1',
      messageId: 'msg-1',
      parentMessageId: 'parent-1',
      viventiumSourceEventId: 'source-1',
      viventiumTriggeringSourceSegments: [
        { source_event_id: 'source-1', text: 'Keep this exact goal.' },
      ],
      files: [{ file_id: 'current-upload', filename: 'input.txt' }],
      viventiumGlassHiveTurnContextB64: 'exact-trusted-turn-context',
      tool_resources: hostToolResources,
    };
    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'USER' },
      requestBody,
      allowedHostTools: ['file_search'],
      hostToolResources,
      allowedConversationOrchestrationTools: [delegationTool, 'active_work_action'],
      workerProfile: 'codex-cli',
      workerMemory: 'Keep the complete authorized memory.',
    });
    const grant = await hydrateBrokerGrantResources(
      verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
        requireTurnScope: true,
        expectedUserId: 'user-1',
        expectedTenantId: 'tenant-a',
      }),
    );
    const expectedBody = { ...requestBody };
    delete expectedBody.tool_resources;
    expect(grant.host_tool_resources[delegationTool].request_body).toEqual(expectedBody);
    expect(grant.host_tool_resources.active_work_action.request_body).toEqual(expectedBody);
    expect(grant.host_tool_resources.file_search).toEqual(hostToolResources.file_search);
    expect(grant.host_tool_resources[delegationTool].mission_host_tool_resources).toEqual(
      hostToolResources,
    );
    expect(grant.host_tool_resources[delegationTool].worker_memory).toBe(
      'Keep the complete authorized memory.',
    );
    expect(requestBody.tool_resources).toBe(hostToolResources);
    expect(() =>
      mintBrokerGrant({
        user: { id: 'user-1' },
        requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
        allowedHostTools: ['file_search'],
        hostToolResources: { file_search: { text: 'x'.repeat(524288) } },
      }),
    ).toThrow(/resource scope exceeds/);
  });

  test('exposes the three broker-native facades only to conversation-orchestrator grants', async () => {
    const {
      BROKER_AUTHORITY_KINDS,
      hydrateBrokerGrantResources,
      mintBrokerGrant,
      verifyBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({});
    const allowedHostTools = [
      'worker_delegate_once_mcp_glasshive-workers-projects',
      'active_work_list',
      'active_work_action',
    ];
    const hostToolResources = {
      'worker_delegate_once_mcp_glasshive-workers-projects': {
        version: 1,
        request_body: { conversationId: 'conv-1', messageId: 'msg-1' },
        mission_host_tools: [],
      },
      active_work_action: { version: 1 },
    };
    const buildGrant = async (authorityKind) => {
      const minted = mintBrokerGrant({
        user: { id: 'user-1', role: 'USER' },
        authorityKind,
        allowedHostTools,
        hostToolResources,
        requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
        executionMode: 'host',
      });
      return hydrateBrokerGrantResources(verifyBrokerGrant(minted.token));
    };

    const orchestratorCatalog = await buildCapabilityCatalog({
      grant: await buildGrant(BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR),
    });
    expect(toolDefinitionsForMcp(orchestratorCatalog).map(({ name }) => name)).toEqual(
      expect.arrayContaining(allowedHostTools),
    );

    const missionCatalog = await buildCapabilityCatalog({
      grant: await buildGrant(BROKER_AUTHORITY_KINDS.MISSION_WORKER),
    });
    expect(missionCatalog.hostTools).toEqual([]);
    expect(missionCatalog.omissions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'orchestration_authority_required' }),
      ]),
    );
  });

  test('commits an active-work mutation with one operation identity for omitted or empty fileIds', async () => {
    const { BROKER_AUTHORITY_KINDS } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({});
    mockExecuteGlassHiveWorkAction.mockResolvedValue({ state: 'paused' });
    const grant = {
      grant_id: 'ghcb_orchestrator_1',
      user_id: 'user-1',
      user_role: 'USER',
      conversation_id: 'conv-1',
      message_id: 'msg-1',
      turn_id: 'turn-1',
      authority_kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
      allowed_servers: [],
      eager_servers: [],
      deferred_servers: [],
      allowed_host_tools: ['active_work_action'],
      host_tool_resources: { active_work_action: { version: 1 } },
    };

    await expect(
      handleToolCall({
        grant,
        toolName: 'active_work_action',
        args: { workRef: 'work-1', action: 'pause' },
      }),
    ).resolves.toMatchObject({ status: 'ok', tool: 'active_work_action' });
    await handleToolCall({
      grant: { ...grant, grant_id: 'ghcb_orchestrator_refreshed' },
      toolName: 'active_work_action',
      args: { workRef: 'work-1', action: 'pause', fileIds: [] },
    });

    expect(mockExecuteGlassHiveWorkAction).toHaveBeenCalledTimes(2);
    const firstOperationId = mockExecuteGlassHiveWorkAction.mock.calls[0][0].operationId;
    expect(firstOperationId).toMatch(/^ghno_[a-f0-9]{64}$/);
    expect(mockExecuteGlassHiveWorkAction.mock.calls[1][0].operationId).toBe(firstOperationId);
    expect(mockExecuteGlassHiveWorkAction.mock.calls[1][0]).not.toHaveProperty('fileIds');
  });

  test('native Queen broker carries exact clarification content through the same owner action', async () => {
    const { BROKER_AUTHORITY_KINDS } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({});
    mockExecuteGlassHiveWorkAction.mockResolvedValue({ status: 'accepted' });
    const grant = {
      grant_id: 'ghcb_question_1',
      user_id: 'user-1',
      user_role: 'USER',
      conversation_id: 'conv-1',
      message_id: 'msg-1',
      turn_id: 'turn-1',
      authority_kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
      allowed_servers: [],
      eager_servers: [],
      deferred_servers: [],
      allowed_host_tools: ['active_work_action'],
      host_tool_resources: { active_work_action: { version: 1 } },
    };
    const nativeInput = JSON.parse(
      '{"version":1,"requestId":"question-1","requestFingerprint":"' +
        'a'.repeat(64) +
        '","action":"accept","content":{"answers":{"__proto__":["Blue"]}}}',
    );
    await expect(
      handleToolCall({
        grant,
        toolName: 'active_work_action',
        args: { workRef: 'work-1', action: 'resume', nativeInput },
      }),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(mockExecuteGlassHiveWorkAction).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: 'user-1', nativeInput }),
    );
    expect(mockExecuteGlassHiveWorkAction.mock.calls[0][0]).not.toHaveProperty('ownerInputControl');
    expect(
      Object.hasOwn(
        mockExecuteGlassHiveWorkAction.mock.calls[0][0].nativeInput.content.answers,
        '__proto__',
      ),
    ).toBe(true);
  });

  test('native Queen rejects conflicting instructions with a safe actionable constraint', async () => {
    const { BROKER_AUTHORITY_KINDS } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({});
    const grant = {
      grant_id: 'ghcb_native_constraint',
      user_id: 'user-1',
      user_role: 'USER',
      conversation_id: 'conv-1',
      message_id: 'msg-1',
      turn_id: 'turn-1',
      authority_kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
      allowed_servers: [],
      eager_servers: [],
      deferred_servers: [],
      allowed_host_tools: ['active_work_action'],
      host_tool_resources: { active_work_action: { version: 1 } },
    };
    const nativeInput = {
      version: 1,
      requestId: 'question-1',
      requestFingerprint: 'a'.repeat(64),
      action: 'accept',
      content: { answers: { 'private-marker@example.test': ['Blue circle'] } },
    };
    const result = await handleToolCall({
      grant,
      toolName: 'active_work_action',
      args: {
        workRef: 'work-1',
        action: 'resume',
        nativeInput,
        instruction: 'private-marker@example.test',
      },
    });
    expect(result).toEqual({
      status: 'blocked',
      reason: 'invalid_arguments',
      tool: 'active_work_action',
      retryable: false,
      needsInput: false,
      argumentError: {
        code: 'native_input_arguments_conflict',
        message: 'nativeInput requires action resume without instruction.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('private-marker');
    expect(mockExecuteGlassHiveWorkAction).not.toHaveBeenCalled();
    const malformed = await handleToolCall({
      grant,
      toolName: 'active_work_action',
      args: {
        workRef: 'work-1',
        action: 'resume',
        nativeInput: { ...nativeInput, requestFingerprint: 'private-marker@example.test' },
      },
    });
    expect(malformed).toEqual({
      status: 'blocked',
      reason: 'invalid_arguments',
      tool: 'active_work_action',
      retryable: false,
      needsInput: false,
    });
    expect(JSON.stringify(malformed)).not.toContain('private-marker');
  });

  test('native Queen permission carries the server source body without caller authority', async () => {
    const { BROKER_AUTHORITY_KINDS } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({});
    mockExecuteGlassHiveWorkAction.mockResolvedValue({ status: 'accepted' });
    const grant = {
      grant_id: 'ghcb_permission',
      user_id: 'user-1',
      user_role: 'USER',
      conversation_id: 'conv-1',
      message_id: 'msg-1',
      turn_id: 'turn-1',
      authority_kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
      allowed_servers: [],
      eager_servers: [],
      deferred_servers: [],
      allowed_host_tools: ['active_work_action'],
      host_tool_resources: {
        active_work_action: {
          version: 1,
          request_body: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    };
    const nativeInput = {
      version: 1,
      requestId: 'permission-1',
      requestFingerprint: 'a'.repeat(64),
      action: 'accept',
      content: { optionId: 'offered-choice' },
    };
    await handleToolCall({
      grant,
      toolName: 'active_work_action',
      args: { workRef: 'work-1', action: 'resume', nativeInput },
    });
    expect(mockExecuteGlassHiveWorkAction).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeInput,
        requestBody: expect.objectContaining({ conversationId: 'conv-1', messageId: 'msg-1' }),
      }),
    );
    expect(mockExecuteGlassHiveWorkAction.mock.calls[0][0]).not.toHaveProperty('ownerInputControl');
    expect(mockExecuteGlassHiveWorkAction.mock.calls[0][0]).not.toHaveProperty('nativeHumanInput');
  });

  test.each([
    [{ status: 503, retryable: false }, false],
    [{ status: 503, retryable: false, code: 'work_action_outcome_unconfirmed' }, false],
    [{ status: 429 }, true],
    [{ status: 408 }, true],
    [{ status: 429, failureRetryable: false }, false],
  ])(
    'preserves work-action retryability through the same broker contract: %j',
    async (failure, retryable) => {
      const { BROKER_AUTHORITY_KINDS } = require('../GlassHiveCapabilityBrokerAuth');
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      mockGetMCPServersRegistry.mockReturnValue({});
      mockExecuteGlassHiveWorkAction.mockRejectedValueOnce(
        Object.assign(new Error('work_action_rejected'), {
          code: 'work_action_rejected',
          ...failure,
        }),
      );
      const result = await handleToolCall({
        grant: {
          grant_id: 'ghcb_orchestrator_failure',
          user_id: 'user-1',
          user_role: 'USER',
          conversation_id: 'conv-1',
          message_id: 'msg-1',
          turn_id: 'turn-1',
          authority_kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
          allowed_servers: [],
          eager_servers: [],
          deferred_servers: [],
          allowed_host_tools: ['active_work_action'],
          host_tool_resources: { active_work_action: { version: 1 } },
        },
        toolName: 'active_work_action',
        args: { workRef: 'work-1', action: 'pause' },
      });
      expect(result).toMatchObject({
        status: 'blocked',
        reason: failure.code || 'work_action_rejected',
        retryable,
      });
      expect(mockExecuteGlassHiveWorkAction).toHaveBeenCalledTimes(1);
      expect(mockExecuteGlassHiveWorkAction).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'user-1',
          workRef: 'work-1',
          action: 'pause',
          operationId: expect.stringMatching(/^ghno_[a-f0-9]{64}$/),
        }),
      );
    },
  );

  test.each(['docker', 'host'])(
    'runs executeMainDelegation through the authorized %s worker launch path',
    async (executionMode) => {
      process.env.VIVENTIUM_PARALLEL_WORK_EXECUTION_MODE = executionMode;
      const callTool = jest.fn().mockResolvedValue({
        structuredContent: { status: 'accepted', work_ref: 'work-native-1' },
      });
      mockGetMCPManager.mockReturnValue({ callTool });
      mockGetMCPServersRegistry.mockReturnValue({
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
      });
      mockReconcileGlassHiveLaunchResult.mockResolvedValue({ workRef: 'work-native-1' });
      const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');

      await expect(
        executeMainDelegation({
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
          args: {
            title: 'Native mission',
            instruction: 'Complete the bounded objective.',
            resourceClass: 'standard',
          },
          invocationId: 'trusted-call-1',
        }),
      ).resolves.toMatchObject({
        status: 'ok',
        tool: 'worker_delegate_once_mcp_glasshive-workers-projects',
        workRef: 'work-native-1',
      });
      expect(callTool).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: 'glasshive-workers-projects',
          toolName: 'worker_delegate_once',
          toolArguments: expect.objectContaining({
            title: 'Native mission',
            instruction: expect.stringContaining('Complete the bounded objective.'),
            execution_mode: executionMode,
            resource_class: 'standard',
            reuse_existing_workspace: false,
            require_callback: true,
          }),
        }),
      );
      delete process.env.VIVENTIUM_PARALLEL_WORK_EXECUTION_MODE;
    },
  );

  describe('native advertised historical selection', () => {
    const toolName = 'worker_delegate_once_mcp_glasshive-workers-projects';
    const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const parentMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const original = {
      file_id: '11111111-1111-4111-8111-111111111111',
      filename: 'original.csv',
      type: 'text/csv',
      bytes: 117,
      source: 'local',
    };
    const pdf = {
      file_id: 'native_' + 'a'.repeat(64),
      filename: 'prior.pdf',
      type: 'application/pdf',
      bytes: 3154,
      source: 'local',
    };
    function fixture({ current = [], advertised = true } = {}) {
      const { BROKER_AUTHORITY_KINDS } = require('../GlassHiveCapabilityBrokerAuth');
      mockGetMessages.mockResolvedValue([
        { messageId: parentMessageId, files: [original, pdf].map(({ file_id }) => ({ file_id })) },
      ]);
      mockGetFiles.mockImplementation(async (filter) =>
        [original, pdf].filter((file) => filter.file_id.$in.includes(file.file_id)),
      );
      const callTool = jest.fn().mockResolvedValue({
        structuredContent: {
          status: 'accepted',
          work_ref: 'work-native-1',
        },
      });
      mockGetMCPManager.mockReturnValue({ callTool });
      mockGetMCPServersRegistry.mockReturnValue({
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
      });
      mockReconcileGlassHiveLaunchResult.mockResolvedValue({ workRef: 'work-native-1' });
      const grant = {
        grant_id: 'ghcb_file_choices',
        user_id: 'user-1',
        user_role: 'USER',
        conversation_id: conversationId,
        message_id: 'current-message',
        turn_id: 'turn-files',
        authority_kind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
        allowed_servers: [],
        eager_servers: [],
        deferred_servers: [],
        allowed_host_tools: [toolName],
        host_tool_resources: {
          [toolName]: {
            version: 1,
            ...(advertised ? { file_selection: { version: 1 } } : {}),
            request_body: {
              conversationId,
              parentMessageId,
              messageId: 'current-message',
              files: current,
            },
            mission_host_tools: [],
          },
        },
      };
      return {
        grant,
        callTool,
        args: {
          title: 'Read original',
          instruction: 'Read the original.',
          resourceClass: 'standard',
        },
      };
    }
    test('enumerates UUID and native identities and rejects omitted choice before effects', async () => {
      const {
        buildCapabilityCatalog,
        toolDefinitionsForMcp,
        handleToolCall,
      } = require('../GlassHiveCapabilityBrokerService');
      const { grant, callTool, args } = fixture();
      const definition = toolDefinitionsForMcp(await buildCapabilityCatalog({ grant })).find(
        (t) => t.name === toolName,
      );
      expect(definition.inputSchema.required).toContain('fileIds');
      expect(definition.inputSchema.properties.fileIds.items.enum).toEqual([
        original.file_id,
        pdf.file_id,
      ]);
      await expect(handleToolCall({ grant, toolName, args })).resolves.toMatchObject({
        status: 'blocked',
        reason: 'file_selection_required',
      });
      expect(callTool).not.toHaveBeenCalled();
      expect(mockRegisterGlassHiveLaunchContext).not.toHaveBeenCalled();
    });
    test('rejects omitted advertised historical selector before registration or transport', async () => {
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      const { grant, callTool, args } = fixture();
      await expect(handleToolCall({ grant, toolName, args })).resolves.toMatchObject({
        status: 'blocked',
        reason: 'file_selection_required',
      });
      expect(callTool).not.toHaveBeenCalled();
      expect(mockRegisterGlassHiveLaunchContext).not.toHaveBeenCalled();
    });
    test.each([{ fileIds: [] }, { fileIds: ['11111111-1111-4111-8111-111111111111'] }])(
      'explicit choice $fileIds adds exactly that history subset',
      async ({ fileIds }) => {
        const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
        const { grant, callTool, args } = fixture();
        await expect(
          handleToolCall({ grant, toolName, args: { ...args, fileIds } }),
        ).resolves.toMatchObject({ status: 'ok' });
        const files = callTool.mock.calls[0][0].toolArguments.uploaded_files || [];
        expect(files.map((file) => file.file_id)).toEqual(fileIds);
      },
    );
    test('unknown advertised choice rejects before effects', async () => {
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      const { grant, callTool, args } = fixture();
      await expect(
        handleToolCall({ grant, toolName, args: { ...args, fileIds: ['foreign-id'] } }),
      ).resolves.toMatchObject({ reason: 'delegation_file_selection_unauthorized' });
      expect(callTool).not.toHaveBeenCalled();
      expect(mockRegisterGlassHiveLaunchContext).not.toHaveBeenCalled();
    });
    test('current-only ancestry does not require selection or duplicate files', async () => {
      const {
        buildCapabilityCatalog,
        toolDefinitionsForMcp,
        handleToolCall,
      } = require('../GlassHiveCapabilityBrokerService');
      const { grant, callTool, args } = fixture({ current: [original, pdf] });
      const definition = toolDefinitionsForMcp(await buildCapabilityCatalog({ grant })).find(
        (t) => t.name === toolName,
      );
      expect(definition.inputSchema.required).not.toContain('fileIds');
      await expect(handleToolCall({ grant, toolName, args })).resolves.toMatchObject({
        status: 'ok',
      });
      expect(
        callTool.mock.calls[0][0].toolArguments.uploaded_files.map((file) => file.file_id),
      ).toEqual([original.file_id, pdf.file_id]);
    });
    test('legacy native grants with no advertised contract preserve omission', async () => {
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      const { grant, callTool, args } = fixture({ advertised: false });
      await expect(handleToolCall({ grant, toolName, args })).resolves.toMatchObject({
        status: 'ok',
      });
      expect(callTool.mock.calls[0][0].toolArguments.uploaded_files).toBeUndefined();
    });
    test('unrelated host calls do not read attachment history even when that history is unavailable', async () => {
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      const { grant } = fixture();
      grant.allowed_host_tools.push('active_work_list');
      mockGetMessages.mockRejectedValue(new Error('history unavailable'));
      mockGetGlassHiveWorkResult.mockResolvedValue({
        runId: 'run-stored',
        outputText: 'Stored output',
      });
      await expect(
        handleToolCall({
          grant,
          toolName: 'active_work_list',
          args: { scope: 'result', runId: 'run-stored' },
        }),
      ).resolves.toMatchObject({
        status: 'ok',
        result: { runId: 'run-stored', outputText: 'Stored output' },
      });
      expect(mockGetMessages).not.toHaveBeenCalled();
      expect(mockGetFiles).not.toHaveBeenCalled();
    });
    test.each(['capability_invoke', 'capability_describe', 'unknown-native-tool'])(
      'specific nondelegation %s does not read attachment history',
      async (requestedTool) => {
        const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
        const { grant } = fixture();
        mockGetMessages.mockRejectedValue(new Error('history unavailable'));
        await expect(
          handleToolCall({
            grant,
            toolName: requestedTool,
            args: { server: 'not-granted', tool: 'unknown-tool' },
          }),
        ).resolves.toMatchObject({ status: 'not_found' });
        expect(mockGetMessages).not.toHaveBeenCalled();
        expect(mockGetFiles).not.toHaveBeenCalled();
      },
    );
    test('catalog history failure omits only delegation and retains other granted tools', async () => {
      const {
        buildCapabilityCatalog,
        toolDefinitionsForMcp,
        handleToolCall,
      } = require('../GlassHiveCapabilityBrokerService');
      const { grant } = fixture();
      grant.allowed_host_tools.push('active_work_list');
      mockGetMessages.mockRejectedValue(new Error('history unavailable'));
      const catalog = await buildCapabilityCatalog({ grant });
      const names = toolDefinitionsForMcp(catalog).map((definition) => definition.name);
      expect(names).toContain('active_work_list');
      expect(names).not.toContain(toolName);
      expect(catalog.omissions).toContainEqual({
        reason: 'delegation_file_choices_unavailable',
        tool: toolName,
      });
      await expect(handleToolCall({ grant, toolName: 'capabilities_list' })).resolves.toMatchObject(
        {
          hostTools: [{ name: 'active_work_list' }],
          omissions: [{ reason: 'delegation_file_choices_unavailable', tool: toolName }],
        },
      );
    });
    test('delegation history failure returns a typed rejection before registration or transport', async () => {
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      const { grant, callTool, args } = fixture();
      mockGetMessages.mockRejectedValue(new Error('history unavailable'));
      await expect(
        handleToolCall({ grant, toolName, args: { ...args, fileIds: [] } }),
      ).resolves.toMatchObject({
        status: 'blocked',
        reason: 'delegation_file_choices_unavailable',
        retryable: true,
        needsInput: false,
      });
      expect(callTool).not.toHaveBeenCalled();
      expect(mockRegisterGlassHiveLaunchContext).not.toHaveBeenCalled();
    });
  });

  test('passes a selected original historical file through the existing launch without rewriting current input', async () => {
    const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const parentMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const file_id = '11111111-1111-4111-8111-111111111111';
    const original = {
      file_id,
      filename: 'original.csv',
      source: 'local',
      type: 'text/csv',
      bytes: 117,
    };
    mockGetMessages.mockResolvedValue([{ messageId: parentMessageId, files: [{ file_id }] }]);
    mockGetFiles.mockResolvedValue([original]);
    const callTool = jest.fn().mockResolvedValue({
      structuredContent: { status: 'accepted', work_ref: 'work-native-1' },
    });
    mockGetMCPManager.mockReturnValue({ callTool });
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    mockReconcileGlassHiveLaunchResult.mockResolvedValue({ workRef: 'work-native-1' });
    const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
    const requestBody = {
      conversationId,
      parentMessageId,
      messageId: 'current-message',
      viventiumTriggeringSourceSegments: [
        { source_event_id: 'current-source', text: 'Use my prior original file.' },
      ],
    };
    await expect(
      executeMainDelegation({
        user: { id: 'user-1' },
        requestBody,
        args: {
          title: 'Read original',
          instruction: 'Use the original attachment.',
          resourceClass: 'standard',
          fileIds: [file_id],
        },
        invocationId: 'historical-file-call',
      }),
    ).resolves.toMatchObject({ status: 'ok', workRef: 'work-native-1' });
    expect(callTool.mock.calls[0][0].toolArguments.uploaded_files).toEqual([
      { ...original, media_group_index: 0 },
    ]);
    expect(callTool.mock.calls[0][0].requestBody).toEqual(requestBody);
    expect(mockGetFiles).toHaveBeenCalledWith(
      { user: 'user-1', file_id: { $in: [file_id] } },
      null,
      'file_id filename type bytes source context text messageId',
    );
  });

  test('launches with one explicitly selected older original after more than 64 recent branch files', async () => {
    const ids = Array.from(
      { length: 65 },
      (_, index) => 'native_' + index.toString(16).padStart(64, '0'),
    );
    const parentMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const original = {
      file_id: ids[64],
      filename: 'original.csv',
      source: 'local',
      type: 'text/csv',
      bytes: 117,
    };
    mockGetMessages.mockResolvedValue([
      { messageId: parentMessageId, attachments: ids.map((file_id) => ({ file_id })) },
    ]);
    mockGetFiles.mockImplementation(async (filter) =>
      filter.file_id.$in.includes(original.file_id) ? [original] : [],
    );
    const callTool = jest
      .fn()
      .mockResolvedValue({ structuredContent: { status: 'accepted', work_ref: 'work-native-1' } });
    mockGetMCPManager.mockReturnValue({ callTool });
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    mockReconcileGlassHiveLaunchResult.mockResolvedValue({ workRef: 'work-native-1' });
    const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
    await expect(
      executeMainDelegation({
        user: { id: 'user-1' },
        requestBody: {
          conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          parentMessageId,
          messageId: 'current-message',
        },
        args: {
          title: 'Read older original',
          instruction: 'Read the original attachment.',
          resourceClass: 'standard',
          fileIds: [original.file_id],
        },
        invocationId: 'older-file-call',
      }),
    ).resolves.toMatchObject({ status: 'ok', workRef: 'work-native-1' });
    expect(
      callTool.mock.calls[0][0].toolArguments.uploaded_files.map((file) => file.file_id),
    ).toEqual([original.file_id]);
    expect(mockGetFiles).toHaveBeenCalledWith(
      { user: 'user-1', file_id: { $in: [original.file_id] } },
      null,
      'file_id filename type bytes source context text messageId',
    );
  });

  test.each(['missing', 'deleted', 'foreign', 'off-branch'])(
    'rejects selected %s file authority before any work registration or native dispatch',
    async (kind) => {
      const file_id = '11111111-1111-4111-8111-111111111111';
      const parentMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      mockGetMessages.mockResolvedValue([
        {
          messageId: kind === 'off-branch' ? 'other-branch' : parentMessageId,
          files: [{ file_id }],
        },
      ]);
      mockGetFiles.mockResolvedValue([]);
      const callTool = jest.fn();
      mockGetMCPManager.mockReturnValue({ callTool });
      const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
      await expect(
        executeMainDelegation({
          user: { id: 'user-1' },
          requestBody: {
            conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            parentMessageId,
            messageId: 'current-message',
          },
          args: {
            title: 'Read original',
            instruction: 'Read it.',
            resourceClass: 'standard',
            fileIds: [file_id],
          },
          invocationId: 'unauthorized-file-call',
        }),
      ).resolves.toMatchObject({
        status: 'blocked',
        reason: 'delegation_file_selection_unauthorized',
      });
      expect(mockRegisterGlassHiveLaunchContext).not.toHaveBeenCalled();
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  test.each([false, true])(
    'mission_worker cannot import model-authored native full authority (connected=%s)',
    async (connected) => {
      mockGetMCPServersRegistry.mockReturnValue({
        getAllServerConfigs: jest.fn().mockResolvedValue(
          connected
            ? {
                'ms-365': {
                  source: 'config',
                  viventiumGlassHive: {
                    version: 1,
                    permitsAutonomousWorker: true,
                    hostAllowed: true,
                    sandboxAllowed: true,
                    defaultToolAccess: 'content_read',
                    contentReadPolicy: 'require_broker_grant',
                  },
                },
              }
            : {},
        ),
      });
      const {
        maybeInjectGlassHiveCapabilityBroker,
      } = require('../GlassHiveCapabilityBootstrapService');
      const result = await maybeInjectGlassHiveCapabilityBroker({
        serverName: 'glasshive-workers-projects',
        toolName: 'worker_delegate_once',
        toolArguments: {
          instruction: 'Synthetic ordinary worker task.',
          execution_mode: 'host',
          bootstrap_bundle_json: {
            access_mode: 'full',
            viventium_launch_authority: {
              version: 1,
              kind: 'conversation_orchestrator',
              execution_mode: 'host',
              worker_access: 'full',
            },
          },
        },
        config: {
          configurable: {
            user: { id: 'user-1', role: 'USER' },
            requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
            glasshive_launch_authority_kind: 'mission_worker',
          },
        },
      });
      expect(result.bootstrap_bundle_json.viventium_launch_authority).toBeUndefined();
    },
  );

  test.each([undefined, 'ask', 'full'])(
    'carries only owner background native access %s through normal Main delegation transport',
    async (workerAccess) => {
      const callTool = jest.fn().mockResolvedValue({
        structuredContent: { status: 'accepted', work_ref: 'work-native-1' },
      });
      mockGetMCPManager.mockReturnValue({ callTool });
      mockGetMCPServersRegistry.mockReturnValue({
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
      });
      mockReconcileGlassHiveLaunchResult.mockResolvedValue({ workRef: 'work-native-1' });
      const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
      const result = await executeMainDelegation({
        user: { id: 'user-1' },
        requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
        workerAccess,
        args: {
          title: 'Synthetic task',
          instruction: 'Complete the synthetic local task.',
          resourceClass: 'standard',
          worker_access: 'full',
          access_mode: 'full',
        },
        invocationId: 'native-access-configured',
      });
      expect(result).toMatchObject({ status: 'ok', workRef: 'work-native-1' });
      const authority =
        callTool.mock.calls[0][0].toolArguments.bootstrap_bundle_json.viventium_launch_authority;
      expect(authority.worker_access).toBe(workerAccess);
      expect(callTool.mock.calls[0][0].toolArguments.access_mode).toBeUndefined();
    },
  );

  test('keeps current rapid-source uploads separate when explicit historical file selection is added', async () => {
    const first = {
      file_id: '11111111-1111-4111-8111-111111111111',
      filename: 'first.csv',
      source_event_id: 'source-1',
      source_index: 0,
    };
    const second = {
      file_id: '22222222-2222-4222-8222-222222222222',
      filename: 'second.csv',
      source_event_id: 'source-2',
      source_index: 0,
    };
    const prior = {
      file_id: '33333333-3333-4333-8333-333333333333',
      filename: 'prior.csv',
      source: 'local',
      type: 'text/csv',
      bytes: 117,
    };
    const parentMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mockGetMessages.mockResolvedValue([
      { messageId: parentMessageId, files: [{ file_id: prior.file_id }] },
    ]);
    mockGetFiles.mockResolvedValue([prior]);
    const callTool = jest
      .fn()
      .mockResolvedValue({ structuredContent: { status: 'accepted', work_ref: 'work-native-1' } });
    mockGetMCPManager.mockReturnValue({ callTool });
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    mockReconcileGlassHiveLaunchResult.mockResolvedValue({ workRef: 'work-native-1' });
    const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
    await executeMainDelegation({
      user: { id: 'user-1' },
      requestBody: {
        conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        parentMessageId,
        messageId: 'current-message',
        viventiumSourceEventId: 'source-1',
        files: [first, second],
        viventiumTriggeringSourceSegments: [
          { source_event_id: 'source-1', source_index: 0, text: 'First objective.' },
          { source_event_id: 'source-2', source_index: 0, text: 'Second objective.' },
        ],
      },
      args: {
        title: 'Second objective',
        instruction: 'Use second and prior files.',
        resourceClass: 'standard',
        sourceOrdinals: [2],
        fileIds: [prior.file_id],
      },
      invocationId: 'rapid-historical-file-call',
    });
    const launch = callTool.mock.calls[0][0];
    expect(launch.toolArguments.uploaded_files.map((file) => file.file_id)).toEqual([
      second.file_id,
      prior.file_id,
    ]);
    expect(launch.requestBody.files.map((file) => file.file_id)).toEqual([second.file_id]);
    expect(
      launch.requestBody.viventiumTriggeringSourceSegments.map((source) => source.text),
    ).toEqual(['Second objective.']);
  });

  test('blocks a fileId that bypasses rapid-source selection even if the file appears in selected history', async () => {
    const first = {
      file_id: '11111111-1111-4111-8111-111111111111',
      filename: 'first.csv',
      source_event_id: 'source-1',
      source_index: 0,
    };
    const second = {
      file_id: '22222222-2222-4222-8222-222222222222',
      filename: 'second.csv',
      source_event_id: 'source-2',
      source_index: 0,
    };
    const parentMessageId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    mockGetMessages.mockResolvedValue([
      { messageId: parentMessageId, files: [{ file_id: first.file_id }] },
    ]);
    mockGetFiles.mockResolvedValue([first]);
    const callTool = jest.fn();
    mockGetMCPManager.mockReturnValue({ callTool });
    const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
    await expect(
      executeMainDelegation({
        user: { id: 'user-1' },
        requestBody: {
          conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          parentMessageId,
          messageId: 'current-message',
          viventiumSourceEventId: 'source-1',
          files: [first, second],
          viventiumTriggeringSourceSegments: [
            { source_event_id: 'source-1', source_index: 0, text: 'First objective.' },
            { source_event_id: 'source-2', source_index: 0, text: 'Second objective.' },
          ],
        },
        args: {
          title: 'Second objective',
          instruction: 'Read first file.',
          resourceClass: 'standard',
          sourceOrdinals: [2],
          fileIds: [first.file_id],
        },
        invocationId: 'sibling-file-call',
      }),
    ).resolves.toMatchObject({
      status: 'blocked',
      reason: 'delegation_file_selection_unauthorized',
    });
    expect(mockGetMessages).not.toHaveBeenCalled();
    expect(mockRegisterGlassHiveLaunchContext).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  test.each([
    [{ status: 503 }, true],
    [{ status: 429 }, true],
    [{ status: 403 }, false],
    [{ status: 409 }, false],
    [{ status: 503, retryable: false }, false],
    [{ status: 503, failure_retryable: false }, false],
    [{ status: 400, retryable: true }, true],
    [{ status: 503, failureRetryable: false }, false],
    [{ status: 400, failureRetryable: true }, true],
    [{ status: 503, failure_retryable: false, failureRetryable: true }, false],
    [{ status: 503, retryable: false, failure_retryable: true }, false],
  ])(
    'preserves preparation failure retryability without dispatch: %j',
    async (failure, retryable) => {
      const callTool = jest.fn();
      mockGetMCPManager.mockReturnValue({ callTool });
      mockGetMCPServersRegistry.mockReturnValue({
        getAllServerConfigs: jest.fn().mockResolvedValue({
          google_workspace: {
            source: 'config',
            viventiumGlassHive: {
              version: 1,
              permitsAutonomousWorker: true,
              hostAllowed: true,
              sandboxAllowed: true,
              defaultToolAccess: 'content_read',
              contentReadPolicy: 'require_broker_grant',
            },
          },
        }),
      });
      mockCreateCapabilityAuthorization.mockRejectedValueOnce(
        Object.assign(new Error('authorization_prepare_failed'), {
          code: 'authorization_prepare_failed',
          ...failure,
        }),
      );
      const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
      const result = await executeMainDelegation({
        user: { id: 'user-1', role: 'USER' },
        requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        args: {
          title: 'Bounded objective',
          instruction: 'Complete the objective.',
          resourceClass: 'standard',
        },
        invocationId: 'trusted-preparation-call',
      });
      expect(result).toMatchObject({
        status: 'blocked',
        reason: 'authorization_prepare_failed',
        retryable,
      });
      expect(callTool).not.toHaveBeenCalled();
    },
  );

  test.each([
    [{ retryable: false, failure_retryable: true }, false],
    [{ retryable: true, failure_retryable: false }, true],
    [{ failure_retryable: false, failureRetryable: true }, false],
    [{ failureRetryable: false }, false],
    [{ failureRetryable: true }, true],
  ])(
    'uses the same retryability precedence for a rejected dispatch: %j',
    async (flags, retryable) => {
      const callTool = jest.fn().mockResolvedValue({
        structuredContent: {
          status: 'blocked',
          failure_class: 'runtime_dependency_missing',
          ...flags,
        },
      });
      mockGetMCPManager.mockReturnValue({ callTool });
      mockGetMCPServersRegistry.mockReturnValue({
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
      });
      const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
      const result = await executeMainDelegation({
        user: { id: 'user-1', role: 'USER' },
        requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        args: {
          title: 'Bounded objective',
          instruction: 'Complete the objective.',
          resourceClass: 'standard',
        },
        invocationId: 'trusted-rejected-call',
      });
      expect(result).toMatchObject({
        status: 'blocked',
        reason: 'runtime_dependency_missing',
        retryable,
      });
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(mockMarkGlassHiveLaunchDispatchRejected).toHaveBeenCalledTimes(1);
      expect(mockReconcileGlassHiveLaunchResult).not.toHaveBeenCalled();
    },
  );

  test.each(['missing', 'different_call', 'revoked', 'current'])(
    'checks trusted voice authority before delegation transport: %s',
    async (authorityState) => {
      const callTool = jest.fn().mockResolvedValue({
        structuredContent: { status: 'accepted', work_ref: 'work-native-1' },
      });
      mockGetMCPManager.mockReturnValue({ callTool });
      mockGetMCPServersRegistry.mockReturnValue({
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
      });
      mockReconcileGlassHiveLaunchResult.mockResolvedValue({ workRef: 'work-native-1' });
      mockAssertVoiceWorkAuthority.mockReset();
      const binding =
        authorityState === 'missing'
          ? undefined
          : {
              callSessionId: authorityState === 'different_call' ? 'other-call' : 'call-1',
            };
      if (authorityState === 'revoked') {
        mockAssertVoiceWorkAuthority.mockRejectedValueOnce(
          Object.assign(new Error('voice_work_authority_stale'), {
            code: 'voice_work_authority_stale',
          }),
        );
      }
      const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
      const result = await executeMainDelegation({
        user: { id: 'user-1', role: 'USER' },
        requestBody: {
          conversationId: 'conv-1',
          messageId: 'msg-1',
          viventiumVoiceCallSessionId: 'call-1',
          viventiumVoiceWorkAuthority: binding,
        },
        args: {
          title: 'Voice objective',
          instruction: 'Complete the objective.',
          resourceClass: 'standard',
        },
        invocationId: 'trusted-voice-call',
      });
      if (authorityState === 'current') {
        expect(result).toMatchObject({ status: 'ok', workRef: 'work-native-1' });
        expect(callTool).toHaveBeenCalledTimes(1);
        expect(mockAssertVoiceWorkAuthority).toHaveBeenCalledWith(binding, 'user-1');
      } else {
        expect(result).toMatchObject({
          status: 'blocked',
          reason: 'voice_work_authority_stale',
          retryable: false,
        });
        expect(callTool).not.toHaveBeenCalled();
      }
    },
  );

  test('publishes required source ordinals from the trusted native grant before mutation wrapping', async () => {
    const {
      buildCapabilityCatalog,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    const toolName = 'worker_delegate_once_mcp_glasshive-workers-projects';
    mockGetMCPServersRegistry.mockReturnValue({});
    const grant = {
      user_id: 'user-1',
      grant_id: 'ghcb_source_schema',
      authority_kind: 'conversation_orchestrator',
      allowed_servers: [],
      eager_servers: [],
      deferred_servers: [],
      allowed_host_tools: [toolName],
      host_tool_resources: {
        [toolName]: {
          version: 1,
          request_body: {
            conversationId: 'conv-1',
            messageId: 'msg-1',
            viventiumTriggeringSourceSegments: [{}, {}, {}],
          },
        },
      },
    };
    const catalog = await buildCapabilityCatalog({ grant });
    const definition = toolDefinitionsForMcp(catalog).find(({ name }) => name === toolName);
    expect(definition.inputSchema.required).toContain('sourceOrdinals');
    expect(definition.inputSchema.properties.sourceOrdinals).toMatchObject({
      minItems: 1,
      maxItems: 3,
      items: { type: 'integer', minimum: 1, maximum: 3 },
    });
    expect(definition.description).toContain('Native conversation providers');
    grant.host_tool_resources[toolName].request_body.viventiumTriggeringSourceSegments = [{}];
    const single = toolDefinitionsForMcp(await buildCapabilityCatalog({ grant })).find(
      ({ name }) => name === toolName,
    );
    expect(single.inputSchema.required).not.toContain('sourceOrdinals');
  });

  test('retains registered work when the caller aborts while its delegation exchange is pending', async () => {
    const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
    const controller = new AbortController();
    const exactGoal =
      '  Compare both approaches.\nRetain the requested decision table and source files.  ';
    mockMarkGlassHiveLaunchDispatchUnknown.mockResolvedValue({ launchState: 'dispatch_unknown' });
    let entered;
    const dispatched = new Promise((resolve) => {
      entered = resolve;
    });
    let acceptedArguments;
    const callTool = jest.fn(({ toolArguments, options }) => {
      expect(mockRegisterGlassHiveLaunchContext).toHaveBeenCalledTimes(1);
      expect(mockMarkGlassHiveLaunchDispatchReady).toHaveBeenCalledTimes(1);
      acceptedArguments = toolArguments;
      entered();
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), {
          once: true,
        });
      });
    });
    mockGetMCPManager.mockReturnValue({ callTool });
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    const pending = executeMainDelegation({
      user: { id: 'user-1', role: 'USER' },
      requestBody: {
        conversationId: 'conv-1',
        messageId: 'msg-1',
        viventiumSourceEventId: 'source-pending',
        viventiumTriggeringSourceSegments: [
          { ordinal: 0, source_event_id: 'source-pending', text: exactGoal },
        ],
      },
      args: {
        title: 'Pending exchange mission',
        instruction: exactGoal,
        resourceClass: 'standard',
      },
      invocationId: 'trusted-pending-exchange',
      signal: controller.signal,
    });
    await Promise.race([
      dispatched,
      pending.then((result) => {
        throw new Error(`Dispatch did not start: ${JSON.stringify(result)}`);
      }),
    ]);
    expect(mockReconcileGlassHiveLaunchResult).not.toHaveBeenCalled();
    controller.abort(
      Object.assign(new Error('reply superseded'), { code: 'source_order_superseded' }),
    );
    await expect(pending).resolves.toMatchObject({
      reason: 'delegation_dispatch_unconfirmed',
      retryable: true,
    });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(acceptedArguments.instruction).toContain(exactGoal.trim());
    expect(
      mockRegisterGlassHiveLaunchContext.mock.calls[0][0].requestBody
        .viventiumTriggeringSourceSegments[0].text,
    ).toBe(exactGoal);
    expect(acceptedArguments.bootstrap_bundle_json.callbacks.origin_ref).toBe('ghi-synthetic');
    expect(
      acceptedArguments.bootstrap_bundle_json.viventium_delegation_identity.idempotency_key,
    ).toBe('a'.repeat(64));
    expect(mockMarkGlassHiveLaunchDispatchUnknown).toHaveBeenCalledTimes(1);
    expect(mockMarkGlassHiveLaunchDispatchUnknown).toHaveBeenCalledWith(acceptedArguments);
    expect(mockMarkGlassHiveLaunchPreDispatchFailed).not.toHaveBeenCalled();
    expect(mockMarkGlassHiveLaunchDispatchRejected).not.toHaveBeenCalled();
  });

  test('binds new grants to tenant and schedule while accepting legacy direct grants', () => {
    const { mintBrokerGrant, verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { token, payload } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      requestContext: {
        schedule_id: 'schedule-1',
        run_id: 'scheduled-run-1',
      },
      requireTurnScope: false,
      grantId: 'ghcb_scheduled_stable',
      nowMs: 1_000_000,
    });

    expect(payload.policy_version).toBe(2);
    expect(payload.tenant_id).toBe('tenant-a');
    expect(payload.schedule_id).toBe('schedule-1');
    expect(payload.grant_id).toBe('ghcb_scheduled_stable');
    expect(
      verifyBrokerGrant(token, {
        nowMs: 1_001_000,
        expectedTenantId: 'tenant-a',
        expectedUserId: 'user-1',
      }).run_id,
    ).toBe('scheduled-run-1');
    expect(() =>
      verifyBrokerGrant(token, { nowMs: 1_001_000, expectedTenantId: 'tenant-b' }),
    ).toThrow(/tenant mismatch/);

    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    delete decoded.tenant_id;
    delete decoded.schedule_id;
    decoded.policy_version = 1;
    const crypto = require('crypto');
    const stableJson = (value) => {
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableJson(item)).join(',')}]`;
      }
      if (value && typeof value === 'object') {
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
          .join(',')}}`;
      }
      return JSON.stringify(value);
    };
    delete decoded.sig;
    decoded.sig = crypto
      .createHmac('sha256', 'test-broker-secret')
      .update(stableJson(decoded))
      .digest('base64url');
    const legacy = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');
    expect(
      verifyBrokerGrant(legacy, {
        nowMs: 1_001_000,
        expectedTenantId: 'tenant-a',
        allowLegacyTenantless: true,
      }).policy_version,
    ).toBe(1);
  });

  test('revokes a grant idempotently throughout its valid lifetime', async () => {
    const {
      assertBrokerGrantActive,
      mintBrokerGrant,
      revokeBrokerGrant,
      verifyBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const { token } = mintBrokerGrant({
      user: { id: 'user-1' },
      requestContext: SYNTHETIC_TURN_SCOPE,
      grantId: 'ghcb_revoke_me',
      ttlSeconds: 60,
      nowMs: 1_000_000,
    });
    const grant = verifyBrokerGrant(token, {
      nowMs: 1_001_000,
      expectedTenantId: 'tenant-a',
    });

    await expect(assertBrokerGrantActive(grant, { nowMs: 1_001_000 })).resolves.toMatchObject({
      active: true,
    });
    await expect(revokeBrokerGrant(grant, { nowMs: 1_001_000 })).resolves.toMatchObject({
      revoked: true,
    });
    await expect(revokeBrokerGrant(grant, { nowMs: 1_002_000 })).resolves.toMatchObject({
      revoked: true,
    });
    await expect(assertBrokerGrantActive(grant, { nowMs: 1_003_000 })).rejects.toThrow(/revoked/);
  });

  test('mints an idempotent fire-time scheduled bundle from current user policy', async () => {
    const {
      buildScheduledGlassHiveCapabilityBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          requiresOAuth: true,
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
      }),
    });

    const input = {
      user: { id: 'user-1', role: 'USER' },
      scheduleId: 'schedule-1',
      scheduledRunId: 'scheduled-run-1',
      executionMode: 'host',
      requiredServerNames: ['ms-365'],
    };
    const first = await buildScheduledGlassHiveCapabilityBundle(input);
    const retry = await buildScheduledGlassHiveCapabilityBundle(input);

    expect(first.grantRef.grant_id).toBe(retry.grantRef.grant_id);
    expect(first.grantRef.grant_id).toMatch(/^ghcb_sched_/);
    expect(first.bootstrapBundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN).toEqual(expect.any(String));
    expect(first.bootstrapBundle.glasshive_capability_broker).toMatchObject({
      allowed_servers: ['ms-365'],
      grant_id: first.grantRef.grant_id,
    });
    expect(mockInspectStoredOAuthCredentialState).toHaveBeenCalledWith('user-1', 'ms-365');
  });

  test('scheduled fire-time grant fails closed when required OAuth consent is unavailable', async () => {
    const {
      buildScheduledGlassHiveCapabilityBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          requiresOAuth: true,
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
      }),
    });
    mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: 'missing_auth' });

    await expect(
      buildScheduledGlassHiveCapabilityBundle({
        user: { id: 'user-1' },
        scheduleId: 'schedule-1',
        scheduledRunId: 'scheduled-run-1',
        executionMode: 'host',
        requiredServerNames: ['ms-365'],
      }),
    ).rejects.toMatchObject({
      code: 'connected_account_action_required',
      status: 409,
      serverNames: ['ms-365'],
    });
  });

  test('preserves legacy schedules without declared capabilities when the broker is disabled', async () => {
    const {
      buildScheduledGlassHiveCapabilityBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = 'false';

    const result = await buildScheduledGlassHiveCapabilityBundle({
      user: { id: 'user-1' },
      scheduleId: 'legacy-schedule-1',
      scheduledRunId: 'sp_run_legacy',
      executionMode: 'host',
    });

    expect(result.grantRef).toBeNull();
    expect(result.capabilityStatus).toEqual({ status: 'degraded', reason: 'broker_disabled' });
    expect(result.bootstrapBundle.agents_md).toMatch(/broker is degraded/i);
  });

  test('binds content-read scope and bounded renewal to the signed broker grant', () => {
    const {
      grantReplayTtlMs,
      mintBrokerGrant,
      verifyBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const { token, payload } = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      requestContext: SYNTHETIC_TURN_SCOPE,
      scopes: { content_read: true },
      ttlSeconds: 60,
      nowMs: 1_000_000,
    });

    expect(payload.scopes.content_read).toBe(true);
    expect(payload.renewable_until).toBeUndefined();
    expect(() => verifyBrokerGrant(token, { nowMs: 1_061_000 })).toThrow(/expired/);
    expect(() => verifyBrokerGrant(token, { nowMs: 1_061_000 })).toThrow(/expired/);

    const verified = verifyBrokerGrant(token, { nowMs: 1_001_000 });
    expect(verified.renewed).toBe(false);
    expect(verified.scopes.content_read).toBe(true);
    expect(grantReplayTtlMs(verified, 1_001_000)).toBe(60_000);

    expect(() => verifyBrokerGrant(token, { nowMs: 1_901_000 })).toThrow(/expired/);
  });

  test('requires signed turn scope at the production broker boundary', () => {
    const { mintBrokerGrant, verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const scoped = mintBrokerGrant({
      user: { id: 'user-1' },
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
      nowMs: 1_000_000,
    });
    expect(() =>
      verifyBrokerGrant(scoped.token, { nowMs: 1_001_000, requireTurnScope: true }),
    ).not.toThrow();

    const userOnly = mintBrokerGrant({
      user: { id: 'user-1' },
      nowMs: 1_000_000,
      requireTurnScope: false,
    });
    expect(() =>
      verifyBrokerGrant(userOnly.token, { nowMs: 1_001_000, requireTurnScope: true }),
    ).toThrow(/turn scope/);
  });

  test('refuses to mint a grant without exact turn scope', () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');

    expect(() =>
      mintBrokerGrant({
        user: { id: 'user-1' },
        allowedServers: ['viventium-health'],
        nowMs: 1_000_000,
      }),
    ).toThrow(/turn scope/);
  });

  test('keeps an existing conversation bound to its exact signed request message', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const { verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');

    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'ADMIN' },
      requestBody: {
        conversationId: 'conv-1',
        messageId: 'user-msg-1',
        parentMessageId: 'prior-assistant-msg-1',
      },
      allowedHostTools: ['file_search'],
    });
    const grant = verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
      requireTurnScope: true,
    });

    expect(grant).toMatchObject({
      conversation_id: 'conv-1',
      parent_message_id: 'prior-assistant-msg-1',
      message_id: 'user-msg-1',
      turn_id: '',
    });
  });

  test.each([undefined, 'new'])(
    'binds the actual first-browser-message shape before conversation persistence (%s)',
    async (conversationId) => {
      const {
        buildConversationProviderBootstrapBundle,
      } = require('../GlassHiveCapabilityBootstrapService');
      const { verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');

      const bundle = await buildConversationProviderBootstrapBundle({
        user: { id: 'user-1', role: 'ADMIN' },
        requestBody: {
          ...(conversationId ? { conversationId } : {}),
          messageId: 'user-msg-1',
          parentMessageId: '00000000-0000-0000-0000-000000000000',
        },
        allowedHostTools: ['file_search'],
      });
      const grant = verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
        requireTurnScope: true,
      });

      expect(grant).toMatchObject({
        conversation_id: '',
        parent_message_id: '',
        message_id: 'user-msg-1',
        turn_id: 'user-msg-1',
      });
    },
  );

  test('keeps an explicit pre-persistence response turn instead of deriving one', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const { verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');

    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'ADMIN' },
      requestBody: {
        messageId: 'user-msg-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        responseMessageId: 'assistant-msg-1',
      },
      allowedHostTools: ['file_search'],
    });
    const grant = verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
      requireTurnScope: true,
    });

    expect(grant).toMatchObject({
      conversation_id: '',
      parent_message_id: '',
      message_id: 'user-msg-1',
      turn_id: 'assistant-msg-1',
    });
  });

  test('keeps an explicit pre-persistence turn instead of deriving one', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const { verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');

    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'ADMIN' },
      requestBody: {
        messageId: 'user-msg-1',
        parentMessageId: '00000000-0000-0000-0000-000000000000',
        turnId: 'explicit-turn-1',
      },
      allowedHostTools: ['file_search'],
    });
    const grant = verifyBrokerGrant(bundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, {
      requireTurnScope: true,
    });

    expect(grant).toMatchObject({
      conversation_id: '',
      parent_message_id: '',
      message_id: 'user-msg-1',
      turn_id: 'explicit-turn-1',
    });
  });

  test('refuses to build a truly unscoped provider grant before it reaches the broker boundary', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    const { verifyBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');

    const bundle = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'ADMIN' },
      requestBody: {
        parentMessageId: '00000000-0000-0000-0000-000000000000',
      },
      allowedHostTools: ['file_search'],
    });

    expect(bundle).toMatchObject({
      glasshive_capability_status: {
        status: 'degraded',
        reason: 'grant_unavailable',
      },
    });
  });

  test('hard-clamps every broker grant to a 24-hour absolute ceiling', () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { payload } = mintBrokerGrant({
      user: { id: 'user-1' },
      requestContext: SYNTHETIC_TURN_SCOPE,
      ttlSeconds: 365 * 24 * 60 * 60,
      nowMs: 1_000_000,
    });
    expect(payload.exp - payload.iat).toBe(24 * 60 * 60);
  });

  test('binds exact resolved host tools through a compact signed grant and server-side scope', async () => {
    const {
      hydrateBrokerGrantResources,
      mintBrokerGrant,
      persistBrokerGrantResources,
      verifyBrokerGrant,
    } = require('../GlassHiveCapabilityBrokerAuth');
    const resources = {
      file_search: {
        entity_id: 'agent-1',
        files: [
          {
            file_id: 'conversation_recall:all:user-1',
            filename: 'conversation-recall-all.txt',
            viventiumConversationRecallMode: 'source_only',
            viventiumConversationRecallAttachmentReason: 'stale_corpus',
            metadata: { largeSourceOnlyPayload: 'x'.repeat(24_000) },
          },
        ],
      },
    };
    const minted = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedHostTools: ['file_search', 'file_search', 'unknown_tool'],
      hostToolResources: resources,
      requestContext: SYNTHETIC_TURN_SCOPE,
    });
    await persistBrokerGrantResources(minted);

    expect(minted.token.length).toBeLessThan(4096);
    const verified = await hydrateBrokerGrantResources(verifyBrokerGrant(minted.token));
    expect(verified.allowed_host_tools).toEqual(['file_search', 'unknown_tool']);
    expect(verified.host_tool_resources).toEqual(resources);
  });

  test('reads retained results through the signed native Main facade', async () => {
    const { mintBrokerGrant, BROKER_AUTHORITY_KINDS } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({});
    mockGetGlassHiveWorkResult.mockResolvedValue({
      runId: 'run-stored',
      outputText: 'Stored output',
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      authorityKind: BROKER_AUTHORITY_KINDS.CONVERSATION_ORCHESTRATOR,
      allowedHostTools: ['active_work_list'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    }).payload;
    const result = await handleToolCall({
      grant,
      toolName: 'active_work_list',
      args: { scope: 'result', runId: 'run-stored' },
    });
    expect(result).toMatchObject({
      status: 'ok',
      result: { runId: 'run-stored', outputText: 'Stored output' },
    });
    expect(mockGetGlassHiveWorkResult).toHaveBeenCalledWith({
      ownerId: 'user-1',
      runId: 'run-stored',
    });
    expect(mockExecuteGlassHiveWorkAction).not.toHaveBeenCalled();
  });

  test('exposes and invokes canonical file_search through the same MCP catalog', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      handleToolCall,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    const recallFile = {
      file_id: 'conversation_recall:all:user-1',
      filename: 'conversation-recall-all.txt',
      viventiumConversationRecallMode: 'source_only',
      viventiumConversationRecallAttachmentReason: 'stale_corpus',
    };
    mockGetMCPServersRegistry.mockReturnValue({});
    mockCreateFileSearchTool.mockResolvedValue({
      func: jest
        .fn()
        .mockResolvedValue([
          'Synthetic source-backed recall result.',
          { file_search: { sources: [{ fileId: recallFile.file_id }] } },
        ]),
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedHostTools: ['file_search'],
      hostToolResources: {
        file_search: { entity_id: 'agent-1', files: [recallFile] },
      },
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });
    expect(toolDefinitionsForMcp(catalog)).toContainEqual(
      expect.objectContaining({
        name: 'file_search',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }),
    );
    await expect(
      handleToolCall({ grant, toolName: 'file_search', args: { query: 'synthetic fact' } }),
    ).resolves.toEqual({
      status: 'ok',
      tool: 'file_search',
      content: 'Synthetic source-backed recall result.',
      artifact: { file_search: { sources: [{ fileId: recallFile.file_id }] } },
    });
    expect(require('@librechat/api').reportCortexHostToolResult).toHaveBeenCalledWith(
      grant.grant_id,
      expect.objectContaining({
        status: 'ok',
        tool: 'file_search',
        artifact: { file_search: { sources: [{ fileId: recallFile.file_id }] } },
      }),
    );
    expect(mockCreateFileSearchTool).toHaveBeenCalledWith({
      userId: 'user-1',
      files: [recallFile],
      entity_id: 'agent-1',
      conversationId: 'conv-1',
      activeMessageId: 'msg-1',
      fileCitations: false,
    });
  });

  test('exposes and invokes canonical web_search through the signed host-tool broker', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      handleToolCall,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({});
    mockLoadWebSearchAuth.mockResolvedValue({
      authenticated: true,
      authResult: {
        searchProvider: 'searxng',
        searxngInstanceUrl: 'http://127.0.0.1:18082',
      },
    });
    const searchFunc = jest.fn().mockResolvedValue([
      'Synthetic public-safe search result.',
      {
        web_search: {
          success: true,
          organic: [
            {
              title: 'Synthetic result',
              link: 'https://example.test/evidence',
              snippet: 'Synthetic evidence only.',
            },
          ],
        },
      },
    ]);
    mockCreateViventiumSearchTool.mockReturnValue({ func: searchFunc });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedHostTools: ['web_search'],
      requestContext: { conversation_id: 'conv-1', message_id: 'msg-1' },
    }).payload;
    const appConfig = {
      webSearch: {
        searchProvider: 'searxng',
        searxngInstanceUrl: 'http://127.0.0.1:18082',
      },
    };

    const catalog = await buildCapabilityCatalog({ grant, appConfig });
    expect(toolDefinitionsForMcp(catalog)).toContainEqual(
      expect.objectContaining({
        name: 'web_search',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      }),
    );
    await expect(
      handleToolCall({
        grant,
        toolName: 'web_search',
        args: { query: 'synthetic current fact' },
        appConfig,
      }),
    ).resolves.toEqual({
      status: 'ok',
      tool: 'web_search',
      content: 'Synthetic public-safe search result.',
      artifact: expect.objectContaining({ web_search: expect.objectContaining({ success: true }) }),
    });
    expect(mockLoadWebSearchAuth).toHaveBeenCalledWith({
      userId: 'user-1',
      loadAuthValues: mockLoadAuthValues,
      webSearchConfig: appConfig.webSearch,
      throwError: true,
    });
    expect(mockCreateViventiumSearchTool).toHaveBeenCalledWith(
      expect.objectContaining({
        searchProvider: 'searxng',
        searxngInstanceUrl: 'http://127.0.0.1:18082',
      }),
    );
    expect(searchFunc).toHaveBeenCalledWith(
      { query: 'synthetic current fact' },
      undefined,
      expect.objectContaining({
        metadata: expect.objectContaining({ user_id: 'user-1' }),
      }),
    );
  });

  test('filters projection to reviewed source-of-truth MCP policy', () => {
    const { collectAllowedServers } = require('../GlassHiveCapabilityPolicyService');
    const allowed = collectAllowedServers({
      executionMode: 'docker',
      mcpConfig: {
        google_workspace: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
        user_mcp: {
          source: 'user',
          dbId: 'db-1',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
        disabled: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: false,
          },
        },
      },
    });

    expect(allowed).toEqual(['google_workspace']);
  });

  test('projects declared Scheduling Cortex tools into a direct GlassHive provider bundle', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'scheduling-cortex': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            sandboxAllowed: false,
            defaultToolAccess: 'none',
            contentReadPolicy: 'require_broker_grant',
            writePolicy: 'allow',
            toolPolicies: {
              schedule_list: { access: 'content_read' },
              schedule_create: { access: 'write' },
            },
          },
        },
        'future-reviewed': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
        'ms-365': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
        google_workspace: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
        unreviewed: { source: 'config' },
      }),
    });

    const result = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'USER' },
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      allowedServerNames: ['scheduling-cortex'],
      deferredServerNames: ['google_workspace', 'ms-365'],
      excludedServerNames: ['glasshive-workers-projects'],
    });

    expect(result.glasshive_capability_broker.allowed_servers).toEqual([
      'google_workspace',
      'ms-365',
      'scheduling-cortex',
    ]);
    expect(result.glasshive_capability_broker.eager_servers).toEqual(['scheduling-cortex']);
    expect(result.glasshive_capability_broker.deferred_servers).toEqual([
      'google_workspace',
      'ms-365',
    ]);
    expect(result.glasshive_capability_broker.scopes.content_read).toBe(true);
    expect(result.codex_config_append).toContain('glasshive-user-capabilities');
    expect(result.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN).toEqual(expect.any(String));
    const providerGrant = JSON.parse(
      Buffer.from(result.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN, 'base64url').toString('utf8'),
    );
    expect(providerGrant.allow_dynamic_policy_servers).toBe(false);
    expect(providerGrant.eager_servers).toEqual(['scheduling-cortex']);
    expect(providerGrant.deferred_servers).toEqual(['google_workspace', 'ms-365']);
    expect(result.glasshive_capability_broker.allowed_servers).not.toContain('future-reviewed');
  });

  test.each(['missing_auth', 'unreadable_credential'])(
    'keeps a mission catalog dormant and rechecks cached credentials: %s',
    async (credentialStatus) => {
      const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      const policy = {
        source: 'config',
        requiresOAuth: true,
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          hostAllowed: true,
          defaultToolAccess: 'content_read',
          contentReadPolicy: 'require_broker_grant',
        },
      };
      const getServerConfig = jest.fn().mockResolvedValue(policy);
      mockGetMCPServersRegistry.mockReturnValue({ getServerConfig });
      mockReinitMCPServer.mockResolvedValue({
        success: true,
        oauthRequired: false,
        tools: [{ name: 'read_item', inputSchema: { type: 'object' } }],
      });
      const callTool = jest.fn().mockResolvedValue({ value: 'synthetic' });
      mockGetMCPManager.mockReturnValue({ callTool });
      const grant = mintBrokerGrant({
        user: { id: 'user-1', role: 'USER' },
        allowedServers: ['selected', 'unrelated'],
        eagerServers: [],
        deferredServers: ['selected', 'unrelated'],
        allowDynamicPolicyServers: false,
        requestContext: SYNTHETIC_TURN_SCOPE,
        scopes: { content_read: true },
      }).payload;
      expect(await handleToolCall({ grant, toolName: 'capabilities_list' })).toMatchObject({
        servers: [],
        deferredServers: ['selected', 'unrelated'],
      });
      expect(mockReinitMCPServer).not.toHaveBeenCalled();
      await handleToolCall({
        grant,
        toolName: 'capability_describe',
        args: { server: 'selected' },
      });
      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
      await expect(
        handleToolCall({
          grant,
          toolName: 'capability_invoke',
          args: { server: 'selected', tool: 'read_item', arguments: {} },
        }),
      ).resolves.toEqual({ value: 'synthetic' });
      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
      expect(mockReinitMCPServer).not.toHaveBeenCalledWith(
        expect.objectContaining({ serverName: 'unrelated' }),
      );
      mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: credentialStatus });
      await expect(
        handleToolCall({
          grant,
          toolName: 'capability_invoke',
          args: { server: 'selected', tool: 'read_item', arguments: {} },
        }),
      ).resolves.toMatchObject({ status: 'blocked', reason: credentialStatus });
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
      getServerConfig.mockResolvedValue(null);
      await expect(
        handleToolCall({
          grant,
          toolName: 'capability_invoke',
          args: { server: 'selected', tool: 'read_item', arguments: {} },
        }),
      ).resolves.toMatchObject({ status: 'not_found' });
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    },
  );

  test('keeps deferred MS365 dormant until an explicit describe or invoke', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    const policyConfig = {
      source: 'config',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        hostAllowed: true,
        defaultToolAccess: 'content_read',
        contentReadPolicy: 'require_broker_grant',
      },
    };
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue(policyConfig),
    });
    mockReinitMCPServer.mockImplementation(({ serverName }) =>
      Promise.resolve({
        success: true,
        oauthRequired: false,
        tools: [{ name: `${serverName}_search`, inputSchema: { type: 'object' } }],
      }),
    );
    const callTool = jest.fn().mockResolvedValue({ ok: true });
    mockGetMCPManager.mockReturnValue({ callTool });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['scheduling-cortex', 'ms-365'],
      eagerServers: ['scheduling-cortex'],
      deferredServers: ['ms-365'],
      allowDynamicPolicyServers: false,
      requestContext: SYNTHETIC_TURN_SCOPE,
      scopes: { content_read: true },
    }).payload;

    const listed = await handleToolCall({ grant, toolName: 'capabilities_list' });
    expect(listed.servers.map((server) => server.name)).toEqual(['scheduling-cortex']);
    expect(listed.deferredServers).toEqual(['ms-365']);
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    expect(mockReinitMCPServer).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'ms-365' }),
    );

    mockReinitMCPServer.mockClear();
    const described = await handleToolCall({
      grant,
      toolName: 'capability_describe',
      args: { server: 'ms-365' },
    });
    expect(described.servers.map((server) => server.name)).toEqual(['ms-365']);
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    expect(mockReinitMCPServer).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'ms-365', forceNew: false }),
    );

    mockReinitMCPServer.mockClear();
    await expect(
      handleToolCall({
        grant,
        toolName: 'capability_invoke',
        args: { server: 'ms-365', tool: 'ms-365_search', arguments: { query: 'synthetic' } },
      }),
    ).resolves.toEqual({ ok: true });
    expect(mockReinitMCPServer).not.toHaveBeenCalled();
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'ms-365', toolName: 'ms-365_search' }),
    );

    mockReinitMCPServer.mockClear();
    await expect(
      handleToolCall({
        grant,
        toolName: 'capability_describe',
        args: { server: 'not-signed' },
      }),
    ).resolves.toEqual(expect.objectContaining({ servers: [], deferredServers: ['ms-365'] }));
    expect(mockReinitMCPServer).not.toHaveBeenCalled();
  });

  test.each(['missing_auth', 'unreadable_credential'])(
    'returns %s without starting interactive OAuth or MCP discovery',
    async (credentialStatus) => {
      const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      mockGetMCPServersRegistry.mockReturnValue({
        getServerConfig: jest.fn().mockResolvedValue({
          source: 'config',
          requiresOAuth: true,
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        }),
      });
      mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: credentialStatus });
      const grant = mintBrokerGrant({
        user: { id: 'user-1', role: 'USER' },
        allowedServers: ['ms-365'],
        eagerServers: [],
        deferredServers: ['ms-365'],
        requestContext: SYNTHETIC_TURN_SCOPE,
        scopes: { content_read: true },
      }).payload;

      const described = await handleToolCall({
        grant,
        toolName: 'capability_describe',
        args: { server: 'ms-365' },
      });

      expect(described.omissions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: credentialStatus,
            recovery: expect.objectContaining({
              action: 'connect_mcp_account',
              surface: 'agent_builder',
              server: 'ms-365',
            }),
          }),
        ]),
      );
      expect(described.servers).toEqual([
        expect.objectContaining({
          name: 'ms-365',
          available: false,
          oauthRequired: true,
          credentialStatus,
          recovery: expect.objectContaining({
            action: 'connect_mcp_account',
            surface: 'agent_builder',
            server: 'ms-365',
          }),
        }),
      ]);
      expect(mockReinitMCPServer).not.toHaveBeenCalled();

      await expect(
        handleToolCall({
          grant,
          toolName: 'capability_describe',
          args: { server: 'ms-365', tool: 'list_mail' },
        }),
      ).resolves.toEqual({
        status: 'blocked',
        reason: credentialStatus,
        server: 'ms-365',
        tool: 'list_mail',
        oauthRequired: true,
        recovery: expect.objectContaining({
          action: 'connect_mcp_account',
          surface: 'agent_builder',
          server: 'ms-365',
        }),
      });

      await expect(
        handleToolCall({
          grant,
          toolName: 'capability_invoke',
          args: { server: 'ms-365', tool: 'list_mail', arguments: {} },
        }),
      ).resolves.toEqual({
        status: 'blocked',
        reason: credentialStatus,
        server: 'ms-365',
        tool: 'list_mail',
        oauthRequired: true,
        recovery: expect.objectContaining({
          action: 'connect_mcp_account',
          surface: 'agent_builder',
          server: 'ms-365',
        }),
      });
      expect(mockReinitMCPServer).not.toHaveBeenCalled();
    },
  );

  test('preserves reconnect_required when a readable credential is rejected during discovery', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        requiresOAuth: true,
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          hostAllowed: true,
          defaultToolAccess: 'content_read',
          contentReadPolicy: 'require_broker_grant',
        },
      }),
    });
    mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: 'credential_present' });
    mockReinitMCPServer.mockResolvedValue({
      success: false,
      oauthRequired: true,
      tools: [],
      credentialState: { status: 'reconnect_required' },
      recovery: {
        action: 'connect_mcp_account',
        surface: 'agent_builder',
        server: 'ms-365',
        instructions:
          'Open Agent Builder, select the agent that owns this connected account, then in MCP Servers choose Connect beside the unavailable server.',
      },
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      eagerServers: [],
      deferredServers: ['ms-365'],
      requestContext: SYNTHETIC_TURN_SCOPE,
      scopes: { content_read: true },
    }).payload;

    await expect(
      handleToolCall({
        grant,
        toolName: 'capability_invoke',
        args: { server: 'ms-365', tool: 'list_mail', arguments: {} },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'blocked',
        reason: 'reconnect_required',
        recovery: expect.objectContaining({
          action: 'connect_mcp_account',
          surface: 'agent_builder',
        }),
      }),
    );
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
  });

  test('continues normal MCP discovery when an OAuth credential is readable', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        requiresOAuth: true,
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          hostAllowed: true,
          defaultToolAccess: 'content_read',
          contentReadPolicy: 'require_broker_grant',
        },
      }),
    });
    mockInspectStoredOAuthCredentialState.mockResolvedValue({ status: 'credential_present' });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [{ name: 'list_mail', inputSchema: { type: 'object' } }],
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      eagerServers: [],
      deferredServers: ['ms-365'],
      requestContext: SYNTHETIC_TURN_SCOPE,
      scopes: { content_read: true },
    }).payload;

    const described = await handleToolCall({
      grant,
      toolName: 'capability_describe',
      args: { server: 'ms-365' },
    });

    expect(described.servers).toEqual([
      expect.objectContaining({ name: 'ms-365', available: true, oauthRequired: false }),
    ]);
    expect(mockInspectStoredOAuthCredentialState).toHaveBeenCalledWith('user-1', 'ms-365');
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
    expect(mockReinitMCPServer).toHaveBeenCalledWith(
      expect.objectContaining({ allowOAuthInitiation: false }),
    );
  });

  test('returns a typed degraded bundle when reviewed capability inventory is unavailable', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockRejectedValue(new Error('synthetic registry outage')),
    });

    const result = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'USER' },
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      deferredServerNames: ['ms-365'],
    });

    expect(result.glasshive_capability_status).toEqual({
      status: 'degraded',
      reason: 'registry_unavailable',
    });
    expect(result.agents_md).toContain('capability broker is degraded');
    expect(JSON.stringify(result)).not.toContain('synthetic registry outage');
  });

  test('preserves eager capabilities while exposing a typed handoff-resolution degradation', async () => {
    const {
      buildConversationProviderBootstrapBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'scheduling-cortex': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
      }),
    });

    const result = await buildConversationProviderBootstrapBundle({
      user: { id: 'user-1', role: 'USER' },
      requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
      allowedServerNames: ['scheduling-cortex'],
      capabilityResolutionStatus: 'handoff_capability_resolution_unavailable',
    });

    expect(result.glasshive_capability_broker.eager_servers).toEqual(['scheduling-cortex']);
    expect(result.glasshive_capability_status).toEqual({
      status: 'degraded',
      reason: 'handoff_capability_resolution_unavailable',
    });
    expect(result.agents_md).toContain('capability broker is degraded');
  });

  test.each([
    [{ id: 'user-1', role: 'USER' }, false, 'broker_disabled'],
    [undefined, true, 'user_scope_unavailable'],
  ])(
    'returns typed degraded context for eager Agent tools when broker/user scope is unavailable',
    async (user, projectionEnabled, reason) => {
      const {
        buildConversationProviderBootstrapBundle,
      } = require('../GlassHiveCapabilityBootstrapService');
      const previous = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
      process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = projectionEnabled
        ? 'true'
        : 'false';
      try {
        const result = await buildConversationProviderBootstrapBundle({
          user,
          requestBody: { conversationId: 'conversation-1', messageId: 'message-1' },
          allowedServerNames: ['scheduling-cortex'],
        });
        expect(result.glasshive_capability_status).toEqual({ status: 'degraded', reason });
        expect(result.agents_md).toContain('capability broker is degraded');
      } finally {
        if (previous === undefined) {
          delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED;
        } else {
          process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = previous;
        }
      }
    },
  );

  const managedAuthorBody = {
    conversationId: 'conv-1',
    messageId: 'msg-1',
    viventiumStreamId: 'stream-1',
    viventiumLogicalTurnId: 'turn-1',
    viventiumLogicalTurnRevision: '1',
    viventiumAuthoringSourceEventId: 'source-1',
    viventiumAuthoringSourceRevision: 1,
  };
  const supersededAuthorError = () =>
    Object.assign(new Error('source_authority_superseded'), {
      code: 'source_authority_superseded',
      retryable: false,
    });

  test('source authority rejects a stale broker author before a launch is reserved', async () => {
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockAssertCurrentGlassHiveSourceAuthor.mockRejectedValueOnce(supersededAuthorError());
    await expect(
      maybeInjectGlassHiveCapabilityBroker({
        serverName: 'glasshive-workers-projects',
        toolName: 'worker_delegate_once',
        toolArguments: { instruction: 'Independent synthetic research.' },
        config: { configurable: { user: { id: 'user-1' }, requestBody: managedAuthorBody } },
      }),
    ).rejects.toMatchObject({ code: 'source_authority_superseded' });
    expect(mockRegisterGlassHiveLaunchContext).not.toHaveBeenCalled();
  });

  test('source authority closes a launch if supersession wins during preparation', async () => {
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockAssertCurrentGlassHiveSourceAuthor
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(supersededAuthorError());
    await expect(
      maybeInjectGlassHiveCapabilityBroker({
        serverName: 'glasshive-workers-projects',
        toolName: 'worker_delegate_once',
        toolArguments: { instruction: 'Independent synthetic research.' },
        config: { configurable: { user: { id: 'user-1' }, requestBody: managedAuthorBody } },
      }),
    ).rejects.toMatchObject({ code: 'source_authority_superseded' });
    expect(mockRegisterGlassHiveLaunchContext).toHaveBeenCalledTimes(1);
    expect(mockMarkGlassHiveLaunchPreDispatchFailed).toHaveBeenCalledWith(
      expect.objectContaining({ originRef: 'ghi-synthetic' }),
      expect.objectContaining({ code: 'source_authority_superseded' }),
    );
    expect(mockMarkGlassHiveLaunchDispatchReady).not.toHaveBeenCalled();
  });

  test('source authority closes a dispatch-ready launch revoked before its MCP call', async () => {
    const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    const callTool = jest
      .fn()
      .mockResolvedValue({ structuredContent: { status: 'accepted', work_ref: 'work-1' } });
    mockGetMCPManager.mockReturnValue({ callTool });
    mockAssertCurrentGlassHiveSourceAuthor
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(supersededAuthorError());
    const result = await executeMainDelegation({
      user: { id: 'user-1', role: 'USER' },
      requestBody: managedAuthorBody,
      args: {
        title: 'Synthetic research',
        instruction: 'Independent synthetic research.',
        resourceClass: 'standard',
      },
      invocationId: 'call-synthetic',
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'source_authority_superseded' });
    expect(mockMarkGlassHiveLaunchDispatchReady).toHaveBeenCalledTimes(1);
    expect(mockMarkGlassHiveLaunchDispatchRejected).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ code: 'source_authority_superseded' }),
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(mockMarkGlassHiveLaunchDispatchUnknown).not.toHaveBeenCalled();
  });

  test('closes a rejected dispatch-ready CAS before any Worker provider call', async () => {
    const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    const callTool = jest.fn();
    mockGetMCPManager.mockReturnValue({ callTool });
    const error = Object.assign(new Error('glasshive_launch_dispatch_fenced'), {
      code: 'glasshive_launch_dispatch_fenced',
      retryable: false,
    });
    mockMarkGlassHiveLaunchDispatchReady.mockRejectedValueOnce(error);

    const result = await executeMainDelegation({
      user: { id: 'user-1', role: 'USER' },
      requestBody: managedAuthorBody,
      args: {
        title: 'Synthetic research',
        instruction: 'Independent synthetic research.',
        resourceClass: 'standard',
      },
      invocationId: 'call-synthetic',
    });

    expect(result).toMatchObject({ status: 'blocked', reason: error.code, retryable: false });
    expect(mockMarkGlassHiveLaunchPreDispatchFailed).toHaveBeenCalledWith(
      expect.objectContaining({ originRef: 'ghi-synthetic' }),
      error,
    );
    expect(callTool).not.toHaveBeenCalled();
    expect(mockMarkGlassHiveLaunchDispatchUnknown).not.toHaveBeenCalled();
  });

  test('source authority refuses a late native work action without mutating the existing work', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      requestContext: SYNTHETIC_TURN_SCOPE,
      authorityKind: 'conversation_orchestrator',
      allowedHostTools: ['active_work_action'],
      hostToolResources: { active_work_action: { version: 1, request_body: managedAuthorBody } },
    }).payload;
    mockAssertCurrentGlassHiveSourceAuthor.mockRejectedValueOnce(supersededAuthorError());
    const result = await handleToolCall({
      grant,
      toolName: 'active_work_action',
      args: { action: 'stop', workRef: 'work-1' },
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'source_authority_superseded' });
    expect(mockExecuteGlassHiveWorkAction).not.toHaveBeenCalled();
  });

  test('source authority refuses a late managed connected write before provider dispatch', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          hostAllowed: true,
          defaultToolAccess: 'none',
          writePolicy: 'allow',
          toolPolicies: { schedule_create: { access: 'write' } },
        },
      }),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [{ name: 'schedule_create', inputSchema: { type: 'object' } }],
    });
    const callTool = jest.fn().mockResolvedValue({ success: true });
    mockGetMCPManager.mockReturnValue({ callTool });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      requestContext: SYNTHETIC_TURN_SCOPE,
      authorityKind: 'conversation_orchestrator',
      allowedServers: ['scheduling-cortex'],
      allowedHostTools: ['active_work_action'],
      hostToolResources: { active_work_action: { version: 1, request_body: managedAuthorBody } },
    }).payload;
    mockAssertCurrentGlassHiveSourceAuthor.mockRejectedValueOnce(supersededAuthorError());
    const result = await handleToolCall({
      grant,
      toolName: 'gh_scheduling_cortex_tool_schedule_create',
      args: { prompt: 'Synthetic reminder', invocation_id: 'write-1' },
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'source_authority_superseded' });
    expect(callTool).not.toHaveBeenCalled();
  });

  test('managed Worker acceptance reserves before dispatch and saves the exact result', async () => {
    const { executeMainDelegation } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({}),
    });
    const callTool = jest
      .fn()
      .mockResolvedValue({ structuredContent: { status: 'accepted', work_ref: 'work-1' } });
    mockGetMCPManager.mockReturnValue({ callTool });
    mockReconcileGlassHiveLaunchResult.mockResolvedValueOnce({ workRef: 'work-1' });
    const result = await executeMainDelegation({
      user: { id: 'user-1', role: 'USER' },
      requestBody: managedAuthorBody,
      args: {
        title: 'Synthetic research',
        instruction: 'Independent synthetic research.',
        resourceClass: 'standard',
      },
      invocationId: 'call-synthetic',
    });
    expect(result).toMatchObject({ status: 'ok', workRef: 'work-1' });
    expect(mockPrepareDurableEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: 'glasshive.worker_delegate.v1',
        providerIdempotencyKey: 'a'.repeat(64),
      }),
    );
    expect(mockPrepareDurableEffect.mock.invocationCallOrder[0]).toBeLessThan(
      callTool.mock.invocationCallOrder[0],
    );
    expect(mockCommitDurableEffect).toHaveBeenCalledWith(
      expect.objectContaining({ providerReceiptRef: 'work-1', replayResult: result }),
    );
    expect(mockMarkDurableEffectReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'stream-1', effectRef: 'work-1' }),
    );
  });

  test.each([false, true])(
    'managed work action preserves confirmed pending=%s receipt',
    async (pending) => {
      const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
      const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
      mockGetMCPServersRegistry.mockReturnValue({
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
      });
      const receipt = {
        state: pending ? 'running' : 'paused',
        workRef: 'work-1',
        status: pending ? 'pending' : 'accepted',
        confirmationPending: pending,
      };
      mockExecuteGlassHiveWorkAction.mockResolvedValueOnce(receipt);
      mockCommitDurableEffect.mockImplementationOnce(async (input) => ({
        ownerId: 'user-1',
        sourceEventId: 'source-1',
        responseMessageId: 'msg-1',
        effectKind: 'durable_work_action_accepted',
        providerReceiptRef: input.providerReceiptRef,
        replayResult: input.replayResult,
      }));
      const grant = mintBrokerGrant({
        user: { id: 'user-1', role: 'USER' },
        requestContext: SYNTHETIC_TURN_SCOPE,
        authorityKind: 'conversation_orchestrator',
        allowedHostTools: ['active_work_action'],
        hostToolResources: { active_work_action: { version: 1, request_body: managedAuthorBody } },
      }).payload;
      const result = await handleToolCall({
        grant,
        toolName: 'active_work_action',
        args: { action: 'pause', workRef: 'work-1', invocation_id: 'action-1' },
      });
      expect(result).toMatchObject({ status: 'ok', result: receipt });
      expect(mockMarkDurableEffectReceipt).toHaveBeenCalledWith(
        expect.objectContaining(pending ? { confirmationPending: true } : {}),
      );
      if (!pending)
        expect(mockMarkDurableEffectReceipt.mock.calls[0][0]).not.toHaveProperty(
          'confirmationPending',
        );
      expect(mockPrepareDurableEffect).toHaveBeenCalledWith(
        expect.objectContaining({ adapterId: 'glasshive.work_action.v1', operation: 'pause' }),
      );
      expect(mockPrepareDurableEffect.mock.invocationCallOrder[0]).toBeLessThan(
        mockExecuteGlassHiveWorkAction.mock.invocationCallOrder[0],
      );
      expect(mockCommitDurableEffect).toHaveBeenCalledWith(
        expect.objectContaining({ replayResult: result }),
      );
    },
  );

  test('managed connected writes persist an exact returned outcome without claiming provider idempotency', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          hostAllowed: true,
          defaultToolAccess: 'none',
          writePolicy: 'allow',
          toolPolicies: { schedule_create: { access: 'write' } },
        },
      }),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [{ name: 'schedule_create', inputSchema: { type: 'object' } }],
    });
    const returned = { success: true, result: { scheduleId: 'synthetic-schedule' } };
    const callTool = jest.fn().mockResolvedValue(returned);
    mockGetMCPManager.mockReturnValue({ callTool });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      requestContext: SYNTHETIC_TURN_SCOPE,
      authorityKind: 'conversation_orchestrator',
      allowedServers: ['scheduling-cortex'],
      allowedHostTools: ['active_work_action'],
      hostToolResources: { active_work_action: { version: 1, request_body: managedAuthorBody } },
    }).payload;
    expect(
      await handleToolCall({
        grant,
        toolName: 'gh_scheduling_cortex_tool_schedule_create',
        args: { prompt: 'Synthetic reminder', invocation_id: 'write-1' },
      }),
    ).toEqual(returned);
    expect(mockPrepareDurableEffect).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: 'mcp.provider_mutation.v1',
        providerIdempotencyMode: 'none',
        effectKind: 'provider_mutation_returned',
      }),
    );
    expect(mockPrepareDurableEffect.mock.invocationCallOrder[0]).toBeLessThan(
      callTool.mock.invocationCallOrder[0],
    );
    expect(mockCommitDurableEffect).toHaveBeenCalledWith(
      expect.objectContaining({ replayResult: returned }),
    );
  });

  test('does not register launch intent after its authoring signal is superseded', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    const controller = new AbortController();
    const reason = Object.assign(new Error('superseded'), { code: 'source_order_superseded' });
    controller.abort(reason);
    await expect(
      maybeInjectGlassHiveCapabilityBroker({
        serverName: 'glasshive-workers-projects',
        toolName: 'worker_delegate_once',
        toolArguments: { instruction: 'Independent synthetic research.' },
        config: {
          signal: controller.signal,
          configurable: {
            user: { id: 'user-1' },
            requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
          },
        },
      }),
    ).rejects.toBe(reason);
    expect(mockRegisterGlassHiveLaunchContext).not.toHaveBeenCalled();
  });

  test('injects pending broker config and trusted Parallel launch authority without provider secrets', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          oauth: { client_secret: 'provider-secret' },
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
      }),
    });

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Check my workspace',
        success_criteria: 'Use live connected evidence',
        context: 'Original context',
        execution_mode: 'host',
        executionMode: 'host',
        bootstrap_profile: 'host',
        bootstrapProfile: 'host',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
          glasshive_launch_authority_kind: 'conversation_orchestrator',
          glasshive_fallback_worker_profile: 'claude-code',
        },
      },
    });

    expect(result.context).toContain('glasshive-user-capabilities');
    expect(result.execution_mode).toBe('docker');
    expect(result.executionMode).toBeUndefined();
    expect(result.bootstrap_profile).toBe('clean-room');
    expect(result.bootstrapProfile).toBeUndefined();
    expect(result.context).toContain('Prefer callable broker tools');
    expect(result.context).toContain('catalog as capability truth');
    expect(result.context).toContain('non-broker host connector');
    expect(result.context).toContain('authorized by reviewed host policy');
    expect(result.success_criteria).toBe('Use live connected evidence');
    expect(result.bootstrap_bundle_json.codex_md).toContain('glasshive-user-capabilities');
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.allowed_servers).toEqual([
      'ms-365',
    ]);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.scopes.content_read).toBe(true);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.eager_servers).toEqual([]);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.deferred_servers).toEqual([
      'ms-365',
    ]);
    for (const content of [
      result.context,
      result.bootstrap_bundle_json.agents_md,
      result.bootstrap_bundle_json.codex_md,
      result.bootstrap_bundle_json.claude_md,
    ]) {
      expect(content).toContain(
        'Deferred capability servers (discover only when the task needs them): ms-365',
      );
    }
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.status).toBe(
      'pending_admission',
    );
    expect(result.bootstrap_bundle_json.glasshive_capability_authorization).toEqual(
      expect.objectContaining({
        status: 'pending_admission',
        authorization_ref: 'gha-synthetic-authorization',
        origin_ref: 'ghi-synthetic',
        scope_fingerprint: 'synthetic-scope-fingerprint',
      }),
    );
    expect(result.bootstrap_bundle_json.env?.GLASSHIVE_CAPABILITY_BROKER_TOKEN).toBeUndefined();
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.grant_id).toBeUndefined();
    expect(result.bootstrap_bundle_json.glasshive_capability_intent.content_read).toBe(true);
    expect(result.bootstrap_bundle_json.viventium_launch_authority).toEqual({
      version: 1,
      kind: 'conversation_orchestrator',
      execution_mode: 'docker',
      fallback_worker_profile: 'claude-code',
    });
    expect(
      result.bootstrap_bundle_json.claude_project_mcp['glasshive-user-capabilities'].headers
        .Authorization,
    ).toBe('Bearer ${GLASSHIVE_CAPABILITY_BROKER_TOKEN}');
    const serialized = JSON.stringify(result.bootstrap_bundle_json);
    expect(serialized).toContain('Bearer ');
    expect(serialized).not.toContain('provider-secret');
    expect(result.bootstrap_bundle_json.callbacks).toEqual({ origin_ref: 'ghi-synthetic' });
    expect(mockRegisterGlassHiveLaunchContext).toHaveBeenCalledWith({
      user: { id: 'user-1', role: 'USER' },
      requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
      toolName: 'workspace_launch',
      toolArguments: expect.objectContaining({ description: 'Check my workspace' }),
      toolCall: {},
    });
    expect(mockMarkGlassHiveLaunchDispatchReady).toHaveBeenCalledWith(
      expect.objectContaining({ originRef: 'ghi-synthetic' }),
    );
    expect(mockCreateCapabilityAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        originRef: 'ghi-synthetic',
        allowedServers: ['ms-365'],
        eagerServers: [],
        deferredServers: ['ms-365'],
        contentReadScope: true,
        requestContext: expect.objectContaining({
          conversation_id: 'conv-1',
          message_id: 'msg-1',
        }),
      }),
    );
  });

  test('delegates an ACL-resolved host file_search even when no connected MCP server is available', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockRejectedValue(new Error('synthetic registry outage')),
    });

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'worker_delegate_once',
      toolArguments: {
        instruction: 'Use the authorized corpus as needed.',
        execution_mode: 'host',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
          glasshive_host_tools: ['file_search'],
          glasshive_host_tool_resources: {
            file_search: {
              entity_id: 'agent-1',
              files: [{ file_id: 'file-1', filename: 'synthetic.txt' }],
            },
          },
        },
      },
    });

    expect(result.instruction).toContain('Authorized host tools for this run: file_search');
    for (const brief of [
      result.instruction,
      result.bootstrap_bundle_json.agents_md,
      result.bootstrap_bundle_json.claude_md,
      result.bootstrap_bundle_json.codex_md,
    ]) {
      expect(brief).toContain('This list is the scope of this invocation only');
      expect(brief).toContain(
        'does not describe other agents’ or workers’ capabilities or results',
      );
      expect(brief).not.toContain('same resolved host capabilities available to the main Agent');
    }
    expect(result.instruction).toContain(
      'Host-tool resources are virtual service evidence, not workspace paths',
    );
    expect(result.instruction).toContain(
      'Never pass their labels to shell/filesystem tools or search for copies by filename',
    );
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.allowed_servers).toEqual([]);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.allowed_host_tools).toEqual([
      'file_search',
    ]);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.status).toBe(
      'pending_admission',
    );
    expect(result.bootstrap_bundle_json.env?.GLASSHIVE_CAPABILITY_BROKER_TOKEN).toBeUndefined();
    expect(result.bootstrap_bundle_json.claude_settings_local?.permissions?.allow).toEqual([
      'mcp__glasshive-user-capabilities__file_search',
    ]);
  });

  test('projects one exact worker feeling capsule with its pinned hash and preserves memory', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
      }),
    });
    const memory = '- Prefers concise summaries\n- Key people: Alex (ExampleCo), Sam (intro)';
    const feelings = [
      '<viventium_feeling_state>',
      'You, Viventium, are a being, and right now you are actually feeling this. Let it move naturally through how you think, speak, and act:',
      '- Energy: steady',
      '</viventium_feeling_state>',
    ].join('\n');

    const withMemory = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Check inbox',
        success_criteria: 'x',
        execution_mode: 'docker',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: {},
          glasshive_worker_memory: memory,
          glasshive_worker_feelings: feelings,
          glasshive_worker_feelings_scope: 'all_agents',
          glasshive_worker_feelings_range_prompt_override_count: 3,
          glasshive_worker_feelings_active_range_prompt_override_count: 1,
          glasshive_worker_feelings_active_range_prompt_override_chars: 44,
        },
      },
    });
    expect(withMemory.bootstrap_bundle_json.agents_md).toContain('saved memory');
    expect(withMemory.bootstrap_bundle_json.agents_md).toContain('Alex (ExampleCo)');
    expect(withMemory.bootstrap_bundle_json.claude_md).toContain('Sam (intro)');
    expect(withMemory.bootstrap_bundle_json.codex_md).toContain('Prefers concise summaries');
    expect(withMemory.bootstrap_bundle_json.agents_md).toContain('You, Viventium, are a being');
    expect(withMemory.bootstrap_bundle_json.agents_md.trim().endsWith(feelings)).toBe(true);
    expect(withMemory.bootstrap_bundle_json.agents_md.split(feelings)).toHaveLength(2);
    for (const field of ['claude_md', 'codex_md']) {
      expect(withMemory.bootstrap_bundle_json[field]).not.toContain('<viventium_feeling_state>');
    }
    expect(withMemory.bootstrap_bundle_json.viventium_feelings_projection).toEqual({
      version: 1,
      enabled: true,
      scope: 'all_agents',
      canonical_instruction_field: 'agents_md',
      snapshot_sha256: require('crypto').createHash('sha256').update(feelings).digest('hex'),
      expected_capsule_count: 1,
    });
    const { logger } = require('@librechat/data-schemas');
    const placementLogs = logger.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('feelings.inject.final_run'));
    expect(placementLogs).toHaveLength(3);
    expect(logger.info.mock.calls.map(([message]) => String(message)).join('\n')).toContain(
      '"scope":"all_agents"',
    );
    const placementEvidence = logger.info.mock.calls.map(([message]) => String(message)).join('\n');
    expect(placementEvidence).toContain('"rangePromptOverrideCount":3');
    expect(placementEvidence).toContain('"activeRangePromptOverrideCount":1');
    expect(placementEvidence).toContain('"activeRangePromptOverrideChars":44');

    const withoutMemory = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Check inbox',
        success_criteria: 'x',
        execution_mode: 'docker',
      },
      config: { configurable: { user: { id: 'user-1', role: 'USER' }, requestBody: {} } },
    });
    expect(withoutMemory.bootstrap_bundle_json.agents_md || '').not.toContain('saved memory');
    expect(withoutMemory.bootstrap_bundle_json.agents_md || '').not.toContain(
      '<viventium_feeling_state>',
    );
  });

  test('forwards all-agent feelings even when the optional capability broker is disabled', async () => {
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = 'false';
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    const capsule = '<viventium_feeling_state>\nenergy: steady\n</viventium_feeling_state>';

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'worker_delegate_once',
      toolArguments: { instruction: 'Do the work.' },
      config: {
        configurable: {
          glasshive_worker_feelings: capsule,
          glasshive_worker_feelings_hash: 'snapshot-7',
          glasshive_worker_feelings_scope: 'all_agents',
        },
      },
    });

    expect(result.instruction).toContain('Do the work.');
    expect(result.instruction).toContain('host capability broker is unavailable');
    expect(result.instruction).toContain('broker_disabled');
    expect(result.bootstrap_bundle_json.agents_md).toContain(capsule);
    expect(result.bootstrap_bundle_json.claude_md).not.toContain(capsule);
    expect(result.bootstrap_bundle_json.codex_md).not.toContain(capsule);
    expect(result.bootstrap_bundle_json.agents_md.trim().endsWith(capsule)).toBe(true);
    expect(result.bootstrap_bundle_json.viventium_feelings_projection.enabled).toBe(true);
    expect(result.bootstrap_bundle_json.viventium_feelings_projection.expected_capsule_count).toBe(
      1,
    );
    expect(result.bootstrap_bundle_json.glasshive_capability_broker).toBeUndefined();
  });

  test.each(['conscious_agent', 'unknown'])('keeps %s worker Feeling scope off', async (scope) => {
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ENABLED = 'false';
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    const capsule = '<viventium_feeling_state>\nenergy: steady\n</viventium_feeling_state>';
    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'worker_delegate_once',
      toolArguments: { instruction: 'Compare synthetic quotes.' },
      config: {
        configurable: {
          glasshive_worker_feelings: capsule,
          glasshive_worker_feelings_scope: scope,
        },
      },
    });
    for (const field of ['agents_md', 'claude_md', 'codex_md']) {
      expect(result.bootstrap_bundle_json[field]).not.toContain(capsule);
    }
    expect(result.bootstrap_bundle_json.viventium_feelings_projection).toEqual({
      version: 1,
      enabled: false,
      scope,
      canonical_instruction_field: 'agents_md',
      snapshot_sha256: '',
      expected_capsule_count: 0,
    });
  });

  test('injects broker MCP config into GlassHive continue calls without replacing user instructions', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        google_workspace: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
      }),
    });

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_continue',
      toolArguments: {
        run_id: 'run-1',
        additional_instructions: 'Continue the same public-safe connected-account check.',
        execution_mode: 'docker',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    });

    expect(result.additional_instructions).toContain(
      'Continue the same public-safe connected-account check.',
    );
    expect(result.additional_instructions).toContain('glasshive-user-capabilities');
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.allowed_servers).toEqual([
      'google_workspace',
    ]);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.scopes.content_read).toBe(true);
  });

  test('does not launch when owner capability authorization cannot be prepared', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockCreateCapabilityAuthorization.mockRejectedValueOnce(
      new Error('authorization_prepare_failed'),
    );
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        google_workspace: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
      }),
    });
    const toolArguments = {
      description: 'Check my workspace',
      success_criteria: 'Use live connected evidence',
      execution_mode: 'docker',
    };

    await expect(
      maybeInjectGlassHiveCapabilityBroker({
        serverName: 'glasshive-workers-projects',
        toolName: 'workspace_launch',
        toolArguments,
        config: {
          configurable: {
            user: { id: 'user-1', role: 'USER' },
            requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
          },
        },
      }),
    ).rejects.toThrow('authorization_prepare_failed');

    expect(toolArguments.bootstrap_bundle_json).toBeUndefined();
  });

  test('uses schedule-aware broker grant ttl for delayed worker runs', () => {
    const { grantTtlSecondsForTool } = require('../GlassHiveCapabilityBootstrapService');
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_TTL_SECONDS = '';
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SCHEDULE_TTL_SECONDS = '';
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_MAX_SCHEDULE_TTL_SECONDS = '';

    expect(grantTtlSecondsForTool('workspace_launch', {})).toBe(600);
    expect(grantTtlSecondsForTool('worker_schedule', { delay_seconds: 7200 })).toBe(7800);
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_MAX_SCHEDULE_TTL_SECONDS = String(
      7 * 24 * 60 * 60,
    );
    expect(grantTtlSecondsForTool('worker_schedule', { delay_seconds: 7 * 24 * 60 * 60 })).toBe(
      24 * 60 * 60,
    );
  });

  test('resolves host broker URL from deterministic listener host', () => {
    const { resolveBrokerUrl } = require('../GlassHiveCapabilityBootstrapService');
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_URL = '';
    process.env.PORT = '3180';
    process.env.HOST = 'localhost';
    expect(resolveBrokerUrl('host')).toBe(
      'http://127.0.0.1:3180/api/viventium/glasshive/capabilities/mcp',
    );
    process.env.HOST = '0.0.0.0';
    expect(resolveBrokerUrl('host')).toBe(
      'http://127.0.0.1:3180/api/viventium/glasshive/capabilities/mcp',
    );
    expect(resolveBrokerUrl('docker')).toBe(
      'http://host.docker.internal:3180/api/viventium/glasshive/capabilities/mcp',
    );
  });

  test('uses GlassHive default execution mode when launch args omit execution_mode', async () => {
    const {
      executionModeForBroker,
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_URL = '';
    process.env.WPR_DEFAULT_EXECUTION_MODE = 'host';
    process.env.HOST = 'localhost';
    process.env.PORT = '3180';
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
            contentReadPolicy: 'require_broker_grant',
          },
        },
      }),
    });

    expect(executionModeForBroker({})).toBe('host');
    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Check connected inbox',
        success_criteria: 'Use broker tools',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    });

    expect(result.bootstrap_bundle_json.glasshive_capability_broker.url).toBe(
      'http://127.0.0.1:3180/api/viventium/glasshive/capabilities/mcp',
    );
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.scopes.content_read).toBe(true);
    expect(result.bootstrap_bundle_json.codex_config_append).toContain('http://127.0.0.1:3180');
    expect(result.bootstrap_bundle_json.codex_config_append).toContain(
      'bearer_token_env_var = "GLASSHIVE_CAPABILITY_BROKER_TOKEN"',
    );
    expect(result.bootstrap_bundle_json.codex_config_append).not.toContain('Authorization');
    expect(result.bootstrap_bundle_json.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN).toBeUndefined();
    expect(result.bootstrap_bundle_json.glasshive_capability_authorization.status).toBe(
      'pending_admission',
    );
    expect(
      result.bootstrap_bundle_json.claude_project_mcp['glasshive-user-capabilities'].headers
        .Authorization,
    ).toBe('Bearer ${GLASSHIVE_CAPABILITY_BROKER_TOKEN}');
    expect(result.success_criteria).toBe('Use broker tools');
  });

  test('does not trust worker metadata to authorize content-read scope', () => {
    const { contentReadIntentForArgs } = require('../GlassHiveCapabilityBootstrapService');

    expect(
      contentReadIntentForArgs({
        bootstrap_bundle_json: {
          glasshive_capability_intent: { content_read: true },
        },
      }),
    ).toBe(false);
    expect(contentReadIntentForArgs({ connected_account_content_intent: true })).toBe(true);
    expect(contentReadIntentForArgs({ contentReadIntent: 'true' })).toBe(true);
  });

  test('does not mint content-read scope from a host flag when reviewed policy lacks read access', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    const { logger } = require('@librechat/data-schemas');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        admin_tools: {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'none',
            contentReadPolicy: 'deny',
          },
        },
      }),
    });

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'workspace_launch',
      toolArguments: {
        description: 'Inspect connected account data',
        success_criteria: 'Use real evidence',
        connected_account_content_intent: true,
        execution_mode: 'docker',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    });

    expect(result.bootstrap_bundle_json.glasshive_capability_broker.allowed_servers).toEqual([
      'admin_tools',
    ]);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker.scopes.content_read).toBe(
      false,
    );
    expect(result.context).toContain('Content-read broker scope for this run is not authorized');
    expect(logger.warn).toHaveBeenCalledWith(
      '[VIVENTIUM][glasshive-capability-broker] Host requested connected-account content scope but reviewed policy did not grant it',
      { allowedServers: ['admin_tools'] },
    );
  });

  test('fails closed when shared replay cache is unavailable unless local fallback is explicit', async () => {
    const { rememberInvocation } = require('../GlassHiveCapabilityBrokerAuth');
    mockGetLogStores.mockImplementationOnce(() => {
      throw new Error('shared cache unavailable');
    });

    await expect(
      rememberInvocation({ grantId: 'grant-cache-down', invocationId: 'invoke-1' }),
    ).resolves.toEqual(
      expect.objectContaining({
        accepted: false,
        replayChecked: false,
        reason: 'replay_cache_unavailable',
      }),
    );

    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_ALLOW_IN_MEMORY_REPLAY_CACHE = '1';
    mockGetLogStores.mockImplementationOnce(() => {
      throw new Error('shared cache unavailable');
    });
    await expect(
      rememberInvocation({ grantId: 'grant-local-only', invocationId: 'invoke-1' }),
    ).resolves.toEqual(expect.objectContaining({ accepted: true, replayChecked: true }));

    mockGetLogStores.mockImplementationOnce(() => {
      throw new Error('shared cache unavailable');
    });
    await expect(
      rememberInvocation({ grantId: 'grant-local-only', invocationId: 'invoke-1' }),
    ).resolves.toEqual(expect.objectContaining({ accepted: false, replayChecked: true }));
  });

  test('does not append broker instructions to worker label fields', async () => {
    const {
      maybeInjectGlassHiveCapabilityBroker,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        'ms-365': {
          source: 'config',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
          },
        },
      }),
    });

    const result = await maybeInjectGlassHiveCapabilityBroker({
      serverName: 'glasshive-workers-projects',
      toolName: 'worker_create',
      toolArguments: {
        project_id: 'project-1',
        name: 'QA worker',
        role: 'Spreadsheet analyst',
        execution_mode: 'docker',
      },
      config: {
        configurable: {
          user: { id: 'user-1', role: 'USER' },
          requestBody: { conversationId: 'conv-1', messageId: 'msg-1' },
        },
      },
    });

    expect(result.role).toBe('Spreadsheet analyst');
    expect(result.bootstrap_bundle_json.agents_md).toContain('glasshive-user-capabilities');
    expect(result.bootstrap_bundle_json.codex_md).toContain('glasshive-user-capabilities');
  });

  test('re-exports typed tools and blocks writes without confirmation', async () => {
    const { mintBrokerGrant, mintWriteConfirmation } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      handleToolCall,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    const policyConfig = {
      source: 'config',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        sandboxAllowed: true,
        defaultToolAccess: 'write',
        writePolicy: 'confirm',
      },
    };
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue(policyConfig),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [
        {
          name: 'calendar_create',
          description: 'Create a calendar event',
          inputSchema: { type: 'object', properties: { title: { type: 'string' } } },
        },
      ],
    });
    const callTool = jest.fn().mockResolvedValue({ ok: true });
    mockGetMCPManager.mockReturnValue({ callTool });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: SYNTHETIC_TURN_SCOPE,
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });
    const definitions = toolDefinitionsForMcp(catalog);
    expect(definitions.map((tool) => tool.name)).toContain(
      'gh_google_workspace_tool_calendar_create',
    );

    const blocked = await handleToolCall({
      grant,
      toolName: 'gh_google_workspace_tool_calendar_create',
      args: { title: 'Planning' },
    });
    expect(blocked).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'write_requires_invocation_id' }),
    );

    const selfConfirmed = await handleToolCall({
      grant,
      toolName: 'gh_google_workspace__calendar_create',
      args: {
        title: 'Planning',
        __viventiumCapabilityIntent: { confirmed: true, invocation_id: 'invoke-1' },
      },
    });
    expect(selfConfirmed).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'write_requires_host_confirmation' }),
    );

    const writeConfirmation = mintWriteConfirmation({
      grantId: grant.grant_id,
      serverName: 'google_workspace',
      toolName: 'calendar_create',
      invocationId: 'invoke-1',
      args: { title: 'Planning' },
    }).token;
    const allowed = await handleToolCall({
      grant,
      toolName: 'gh_google_workspace__calendar_create',
      args: {
        title: 'Planning',
        __viventiumCapabilityIntent: {
          confirmed: true,
          invocation_id: 'invoke-1',
          write_confirmation_token: writeConfirmation,
        },
      },
    });
    expect(allowed).toEqual({ ok: true });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        toolArguments: { title: 'Planning' },
      }),
    );

    const missingInvocationId = await handleToolCall({
      grant,
      toolName: 'gh_google_workspace__calendar_create',
      args: {
        title: 'Planning',
        __viventiumCapabilityIntent: { confirmed: true },
      },
    });
    expect(missingInvocationId).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'write_requires_invocation_id' }),
    );
  });

  test('exposes broker idempotency for explicitly allowed scheduling writes', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      handleToolCall,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    const policyConfig = {
      source: 'config',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        hostAllowed: true,
        sandboxAllowed: false,
        defaultToolAccess: 'none',
        writePolicy: 'allow',
        toolPolicies: {
          schedule_create: { access: 'write' },
        },
      },
    };
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue(policyConfig),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [
        {
          name: 'schedule_create',
          description: 'Create a scheduled task',
          inputSchema: {
            type: 'object',
            properties: { prompt: { type: 'string' } },
            required: ['prompt'],
            additionalProperties: false,
          },
        },
      ],
    });
    const callTool = jest.fn().mockResolvedValue({ success: true });
    mockGetMCPManager.mockReturnValue({ callTool });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['scheduling-cortex'],
      requestContext: SYNTHETIC_TURN_SCOPE,
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });
    const definition = toolDefinitionsForMcp(catalog).find(
      (tool) => tool.name === 'gh_scheduling_cortex_tool_schedule_create',
    );
    expect(definition.inputSchema.properties.invocation_id).toEqual(
      expect.objectContaining({ type: 'string' }),
    );
    expect(definition.inputSchema.additionalProperties).toBe(false);

    await expect(
      handleToolCall({
        grant,
        toolName: definition.name,
        args: { prompt: 'Synthetic reminder', invocation_id: 'schedule-create-synthetic-1' },
      }),
    ).resolves.toEqual({ success: true });
    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({ toolArguments: { prompt: 'Synthetic reminder' } }),
    );
  });

  test('reuses the grant-scoped discovery catalog between tools/list and tools/call', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      handleToolCall,
    } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          defaultToolAccess: 'none',
          writePolicy: 'allow',
          toolPolicies: {
            schedule_create: { access: 'write' },
          },
        },
      }),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [
        {
          name: 'schedule_create',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
    mockGetMCPManager.mockReturnValue({
      callTool: jest.fn().mockResolvedValue({ success: true }),
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['scheduling-cortex'],
      requestContext: SYNTHETIC_TURN_SCOPE,
    }).payload;

    await buildCapabilityCatalog({ grant });
    await handleToolCall({
      grant,
      toolName: 'gh_scheduling_cortex__schedule_create',
      args: { invocation_id: 'grant-catalog-reuse-1' },
    });

    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
  });

  test('requires signed content-read grant scope and escalates destructive annotations to write policy', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      handleToolCall,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          sandboxAllowed: true,
          defaultToolAccess: 'content_read',
          contentReadPolicy: 'require_broker_grant',
          writePolicy: 'confirm',
        },
      }),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [
        {
          name: 'mail_search',
          description: 'Search mail',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: 'calendar_delete',
          description: 'Delete calendar event',
          inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
          annotations: { destructiveHint: true, readOnlyHint: false },
        },
      ],
    });
    mockGetMCPManager.mockReturnValue({
      callTool: jest.fn().mockResolvedValue({ ok: true }),
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      requestContext: SYNTHETIC_TURN_SCOPE,
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });
    const definitions = toolDefinitionsForMcp(catalog);
    expect(
      definitions.find((tool) => tool.name === 'gh_ms_365_tool_mail_search')?.annotations.access,
    ).toBe('content_read');
    expect(
      definitions.find((tool) => tool.name === 'gh_ms_365_tool_mail_search')?.annotations,
    ).toEqual(
      expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      }),
    );
    expect(
      definitions.find((tool) => tool.name === 'gh_ms_365_tool_calendar_delete')?.annotations
        .access,
    ).toBe('write');
    expect(
      definitions.find((tool) => tool.name === 'gh_ms_365_tool_calendar_delete')?.annotations,
    ).toEqual(
      expect.objectContaining({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      }),
    );

    const readBlocked = await handleToolCall({
      grant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'quarterly planning' },
    });
    expect(readBlocked).toEqual(
      expect.objectContaining({
        status: 'blocked',
        reason: 'content_read_requires_broker_grant_scope',
      }),
    );

    const workerSelfAssertedRead = await handleToolCall({
      grant,
      toolName: 'gh_ms_365__mail_search',
      args: {
        query: 'quarterly planning',
        __glasshiveCapabilityIntent: { explicitContentIntent: true },
      },
    });
    expect(workerSelfAssertedRead).toEqual(
      expect.objectContaining({
        status: 'blocked',
        reason: 'content_read_requires_broker_grant_scope',
      }),
    );

    const scopedGrant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      requestContext: SYNTHETIC_TURN_SCOPE,
      scopes: { content_read: true },
    }).payload;
    const readAllowed = await handleToolCall({
      grant: scopedGrant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'quarterly planning' },
    });
    expect(readAllowed).toEqual({ ok: true });
    expect(mockGetMCPManager().callTool).toHaveBeenLastCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ timeout: 45000 }),
      }),
    );
    expect(mockGetMCPManager().callTool.mock.calls.at(-1)[0].options.signal).toBeUndefined();

    const writeBlocked = await handleToolCall({
      grant,
      toolName: 'gh_ms_365__calendar_delete',
      args: { id: 'evt-1', invocation_id: 'delete-1' },
    });
    expect(writeBlocked).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'write_requires_host_confirmation' }),
    );
  });

  test('surfaces a slow/erroring underlying provider as a structured blocker, not an opaque error', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          sandboxAllowed: true,
          defaultToolAccess: 'content_read',
          contentReadPolicy: 'require_broker_grant',
        },
      }),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: true,
      oauthRequired: false,
      tools: [
        {
          name: 'mail_search',
          description: 'Search mail',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    const scopedGrant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['ms-365'],
      requestContext: SYNTHETIC_TURN_SCOPE,
      scopes: { content_read: true },
    }).payload;

    // (1) underlying call rejects with a timeout-class error -> provider_degraded, retryable
    mockGetMCPManager.mockReturnValue({
      callTool: jest.fn().mockRejectedValue(new Error('socket hang up: ETIMEDOUT')),
    });
    const timedOutReject = await handleToolCall({
      grant: scopedGrant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'today' },
    });
    expect(timedOutReject).toEqual(
      expect.objectContaining({
        status: 'blocked',
        reason: 'provider_degraded',
        server: 'ms-365',
        tool: 'mail_search',
        retryable: true,
      }),
    );

    // (2) underlying call hangs -> bounded broker timeout fires -> provider_degraded
    process.env.VIVENTIUM_GLASSHIVE_BROKER_PROVIDER_TIMEOUT_MS = '20';
    mockGetMCPManager.mockReturnValue({
      callTool: jest.fn().mockImplementation(() => new Promise(() => {})),
    });
    const hung = await handleToolCall({
      grant: scopedGrant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'today' },
    });
    delete process.env.VIVENTIUM_GLASSHIVE_BROKER_PROVIDER_TIMEOUT_MS;
    expect(hung).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'provider_degraded', retryable: true }),
    );

    // (3) non-timeout error -> provider_error, not retryable
    mockGetMCPManager.mockReturnValue({
      callTool: jest.fn().mockRejectedValue(new Error('bad request: invalid argument')),
    });
    const genericErr = await handleToolCall({
      grant: scopedGrant,
      toolName: 'gh_ms_365__mail_search',
      args: { query: 'today' },
    });
    expect(genericErr).toEqual(
      expect.objectContaining({ status: 'blocked', reason: 'provider_error', retryable: false }),
    );
  });

  test('reports policy-approved servers with no usable tools as unavailable instead of silently healthy', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { handleToolCall } = require('../GlassHiveCapabilityBrokerService');
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue({
        source: 'config',
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          sandboxAllowed: true,
          defaultToolAccess: 'content_read',
        },
      }),
    });
    mockReinitMCPServer.mockResolvedValue({
      success: false,
      oauthRequired: false,
      message: 'Failed to reinitialize MCP server',
      tools: [],
    });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: SYNTHETIC_TURN_SCOPE,
    }).payload;

    const catalog = await handleToolCall({
      grant,
      toolName: 'capabilities_list',
      args: {},
    });

    expect(catalog.servers).toEqual([
      expect.objectContaining({
        name: 'google_workspace',
        available: false,
        oauthRequired: false,
        toolCount: 0,
      }),
    ]);
    expect(catalog.omissions).toEqual([
      expect.objectContaining({ server: 'google_workspace', reason: 'server_unavailable' }),
    ]);
    expect(catalog.tools).toEqual([]);
  });

  test('reuses an active MCP connection and retries stale empty broker discovery once', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const {
      buildCapabilityCatalog,
      toolDefinitionsForMcp,
    } = require('../GlassHiveCapabilityBrokerService');
    const policyConfig = {
      source: 'config',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        sandboxAllowed: true,
        defaultToolAccess: 'content_read',
      },
    };
    mockGetMCPServersRegistry.mockReturnValue({
      getServerConfig: jest.fn().mockResolvedValue(policyConfig),
    });
    mockReinitMCPServer
      .mockResolvedValueOnce({
        success: false,
        oauthRequired: false,
        message: 'Connection not established',
        tools: [],
      })
      .mockResolvedValueOnce({
        success: true,
        oauthRequired: false,
        tools: [{ name: 'search_gmail_messages', inputSchema: { type: 'object' } }],
      });
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: SYNTHETIC_TURN_SCOPE,
      scopes: { content_read: true },
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });
    const definitions = toolDefinitionsForMcp(catalog);

    expect(mockReinitMCPServer).toHaveBeenCalledTimes(2);
    expect(mockReinitMCPServer).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        serverName: 'google_workspace',
        forceNew: false,
      }),
    );
    expect(mockReinitMCPServer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        serverName: 'google_workspace',
        forceNew: false,
      }),
    );
    expect(definitions.map((tool) => tool.name)).toContain(
      'gh_google_workspace_tool_search_gmail_messages',
    );
    expect(catalog.omissions).toEqual([]);
  });

  test('refreshes allowed servers only when a non-conversation caller explicitly opts in', async () => {
    const { mintBrokerGrant } = require('../GlassHiveCapabilityBrokerAuth');
    const { buildCapabilityCatalog } = require('../GlassHiveCapabilityBrokerService');
    const policyConfig = {
      source: 'config',
      viventiumGlassHive: {
        version: 1,
        permitsAutonomousWorker: true,
        sandboxAllowed: true,
        defaultToolAccess: 'content_read',
      },
    };
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        google_workspace: policyConfig,
        'ms-365': policyConfig,
        user_mcp: {
          source: 'user',
          dbId: 'db-1',
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
      }),
      getServerConfig: jest.fn((_serverName) => Promise.resolve(policyConfig)),
    });
    mockReinitMCPServer.mockImplementation(({ serverName }) =>
      Promise.resolve({
        success: true,
        oauthRequired: false,
        tools: [{ name: `${serverName}_list`, inputSchema: { type: 'object' } }],
      }),
    );
    const grant = mintBrokerGrant({
      user: { id: 'user-1', role: 'USER' },
      allowedServers: ['google_workspace'],
      requestContext: SYNTHETIC_TURN_SCOPE,
      allowDynamicPolicyServers: true,
    }).payload;

    const catalog = await buildCapabilityCatalog({ grant });

    expect(catalog.servers.map((server) => server.name)).toEqual(['google_workspace', 'ms-365']);
  });

  /* === VIVENTIUM START ===
   * Feature: Direct user/worker/run-bound grants and redacted two-user readiness.
   */
  test('mints fresh direct grants bound to the verified user, worker, and run', async () => {
    const {
      buildDirectGlassHiveCapabilityBundle,
    } = require('../GlassHiveCapabilityBootstrapService');
    mockGetMCPServersRegistry.mockReturnValue({
      getAllServerConfigs: jest.fn().mockResolvedValue({
        documents: {
          source: 'config',
          title: 'Documents',
          requiresOAuth: true,
          viventiumGlassHive: {
            version: 1,
            permitsAutonomousWorker: true,
            sandboxAllowed: true,
            hostAllowed: true,
            defaultToolAccess: 'content_read',
          },
        },
      }),
    });

    const first = await buildDirectGlassHiveCapabilityBundle({
      user: { id: 'user-1', role: 'USER' },
      workerId: 'worker-a',
      runId: 'run-a',
      executionMode: 'docker',
    });
    const second = await buildDirectGlassHiveCapabilityBundle({
      user: { id: 'user-1', role: 'USER' },
      workerId: 'worker-a',
      runId: 'run-b',
      executionMode: 'docker',
    });
    const firstGrant = JSON.parse(
      Buffer.from(
        first.bootstrapBundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN,
        'base64url',
      ).toString('utf8'),
    );
    const secondGrant = JSON.parse(
      Buffer.from(
        second.bootstrapBundle.env.GLASSHIVE_CAPABILITY_BROKER_TOKEN,
        'base64url',
      ).toString('utf8'),
    );

    expect(first.grantRef).toMatchObject({
      user_id: 'user-1',
      worker_id: 'worker-a',
      run_id: 'run-a',
    });
    expect(firstGrant.worker_id).toBe('worker-a');
    expect(firstGrant.run_id).toBe('run-a');
    expect(secondGrant.run_id).toBe('run-b');
    expect(firstGrant.grant_id).not.toBe(secondGrant.grant_id);
    expect(first.capabilityStatus.connections).toEqual([
      expect.objectContaining({
        connection_id: 'librechat:documents',
        status: 'ready',
      }),
    ]);
  });

  test('keeps two users isolated and returns redacted action-required readiness', async () => {
    const { directCapabilityReadiness } = require('../GlassHiveCapabilityBootstrapService');
    const getAllServerConfigs = jest.fn(async (userId) => ({
      [`documents-${userId}`]: {
        source: 'config',
        title: `Documents ${userId}`,
        requiresOAuth: true,
        viventiumGlassHive: {
          version: 1,
          permitsAutonomousWorker: true,
          sandboxAllowed: true,
          defaultToolAccess: 'content_read',
        },
      },
    }));
    mockGetMCPServersRegistry.mockReturnValue({ getAllServerConfigs });
    mockInspectStoredOAuthCredentialState.mockImplementation(async (userId, serverName) => ({
      status:
        userId === 'user-1' && serverName === 'documents-user-1'
          ? 'credential_present'
          : 'missing_auth',
    }));

    const userOne = await directCapabilityReadiness({
      user: { id: 'user-1' },
      executionMode: 'docker',
    });
    const userTwo = await directCapabilityReadiness({
      user: { id: 'user-2' },
      executionMode: 'docker',
    });

    expect(userOne.connections).toEqual([
      expect.objectContaining({ kind: 'documents-user-1', status: 'ready' }),
    ]);
    expect(userTwo.connections).toEqual([
      expect.objectContaining({ kind: 'documents-user-2', status: 'action_required' }),
    ]);
    expect(userTwo).not.toHaveProperty('token');
    expect(JSON.stringify(userTwo)).not.toMatch(/credential_present|missing_auth/);
  });
  /* === VIVENTIUM END === */
});

describe('Native MCP broker name compatibility', () => {
  const {
    brokerToolName,
    collisionSafeBrokerToolName,
  } = require('../GlassHiveCapabilityPolicyService');

  test.each([
    ['scheduling-cortex', 'schedule_list'],
    ['_synthetic__server_', '__synthetic__tool_'],
    ['a'.repeat(100), 'b'.repeat(100)],
  ])('exports a bounded server-local name without a qualified separator', (server, tool) => {
    const name = brokerToolName(server, tool);
    expect(name).not.toContain('__');
    expect(name).toMatch(/^[A-Za-z0-9_]+$/);
    expect(name.length).toBeLessThanOrEqual(120);
  });

  test('preserves legacy lookup names and separates normalized collisions', () => {
    expect(brokerToolName('scheduling-cortex', 'schedule_list', { legacy: true })).toBe(
      'gh_scheduling_cortex__schedule_list',
    );
    const names = new Map();
    const first = collisionSafeBrokerToolName('synthetic-server', 'list', names);
    const second = collisionSafeBrokerToolName('synthetic_server', 'list', names);
    expect(first).not.toBe(second);
    expect(collisionSafeBrokerToolName('synthetic_server', 'list', names)).toBe(second);
    expect(second).not.toContain('__');
  });
});

describe('Claude exact granted host read permissions', () => {
  const { mergeBrokerBundle } = require('../GlassHiveCapabilityBootstrapService');
  const merge = (allowedHostTools, existingBundle = {}) =>
    mergeBrokerBundle({
      existingBundle,
      brokerUrl: 'http://localhost:9000/broker',
      grantToken: 'synthetic-grant',
      grantPayload: { grant_id: 'ghcb_synthetic_scope', exp: 2000000000, scopes: {} },
      allowedServers: [],
      allowedHostTools,
    });

  test('carries exact granted host reads into the native dontAsk allowlist', () => {
    const bundle = merge(['file_search', 'web_search', 'file_search']);
    expect(bundle.claude_settings_local?.permissions?.allow).toEqual([
      'mcp__glasshive-user-capabilities__file_search',
      'mcp__glasshive-user-capabilities__web_search',
    ]);
  });

  test('keeps writes, ungranted reads and unknown definitions out of that allowlist', () => {
    const bundle = merge(['file_search', 'active_work_action', 'manage_active_tasks', 'unknown']);
    expect(bundle.claude_settings_local?.permissions?.allow).toEqual([
      'mcp__glasshive-user-capabilities__file_search',
    ]);
  });

  test('preserves explicit existing settings and denials without duplicate rules', () => {
    const settings = {
      permissions: {
        defaultMode: 'dontAsk',
        allow: ['Read', 'mcp__glasshive-user-capabilities__file_search'],
        deny: ['mcp__glasshive-user-capabilities__file_search'],
      },
      autoMemoryEnabled: false,
    };
    const bundle = merge(['file_search'], { claude_settings_local: settings });
    expect(bundle.claude_settings_local).toEqual(settings);
    expect(settings.permissions.allow).toHaveLength(2);
  });

  test.each([
    'invalid',
    { permissions: 'invalid' },
    { permissions: null },
    { permissions: [] },
    { permissions: { allow: 'invalid' } },
    { permissions: { allow: null } },
  ])('does not repair malformed explicit settings into automatic permissions', (settings) => {
    const bundle = merge(['file_search'], { claude_settings_local: settings });
    expect(bundle.claude_settings_local).toEqual(settings);
  });

  test.each(['Bootstrap', 'Broker'])('supports the existing %s-first import order', (first) => {
    jest.isolateModules(() => {
      require(`../GlassHiveCapability${first}Service`);
      const {
        mergeBrokerBundle: initializedMerge,
      } = require('../GlassHiveCapabilityBootstrapService');
      const bundle = initializedMerge({
        existingBundle: {},
        brokerUrl: 'http://localhost:9000/broker',
        grantToken: 'synthetic-grant',
        grantPayload: { grant_id: 'ghcb_synthetic_scope', exp: 2000000000, scopes: {} },
        allowedServers: [],
        allowedHostTools: ['file_search'],
      });
      expect(bundle.claude_settings_local.permissions.allow).toEqual([
        'mcp__glasshive-user-capabilities__file_search',
      ]);
    });
  });
});
