const mockAssertVoiceWorkAuthority = jest.fn();
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
  mainDelegationJsonSchema: (...args) =>
    jest.requireActual('@librechat/api').mainDelegationJsonSchema(...args),
  resolveBackgroundWorkerRoute: (...args) =>
    jest.requireActual('@librechat/api').resolveBackgroundWorkerRoute(...args),
  backgroundWorkerResources: (...args) =>
    jest.requireActual('@librechat/api').backgroundWorkerResources(...args),
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
      if (!Object.prototype.hasOwnProperty.call(args, 'resourceClass')) {
        throw new TypeError('resourceClass is required');
      }
      if (!['standard', 'light'].includes(String(args.resourceClass))) {
        throw new TypeError('resourceClass must be one of: standard, light');
      }
      return {
        title: String(args.title || '').trim(),
        instruction: String(args.instruction || '').trim(),
        ...(args.goal ? { goal: String(args.goal).trim() } : {}),
        ...(args.profile ? { profile: String(args.profile).trim() } : {}),
        ...(args.effort ? { effort: String(args.effort).trim() } : {}),
        ...(args.resourceClass ? { resourceClass: args.resourceClass } : {}),
        ...(args.longMission === true ? { longMission: true } : {}),
        ...(args.requiresHostAccess === true ? { requiresHostAccess: true } : {}),
        ...(Array.isArray(args.sourceOrdinals)
          ? { sourceOrdinals: Array.from(new Set(args.sourceOrdinals)).sort((a, b) => a - b) }
          : {}),
      };
    }
    if (toolName === 'active_work_action') {
      return {
        workRef: String(args.workRef || '').trim(),
        action: String(args.action || '')
          .trim()
          .toLowerCase(),
        ...(args.instruction ? { instruction: String(args.instruction).trim() } : {}),
      };
    }
    return args;
  };
  return {
    ACTIVE_WORK_ACTION_DESCRIPTION: 'Control one existing durable mission.',
    ACTIVE_WORK_ACTION_JSON_SCHEMA: {
      type: 'object',
      properties: {
        workRef: { type: 'string' },
        action: {
          type: 'string',
          enum: ['queue', 'message', 'steer', 'pause', 'resume', 'stop', 'retry', 'dismiss'],
        },
        instruction: { type: 'string' },
      },
      required: ['workRef', 'action'],
      additionalProperties: false,
    },
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
  selectTrustedLaunchRequestBody: (requestBody) => ({ requestBody }),
  trustedUploadedFilesFromRequestBody: (requestBody = {}) =>
    (requestBody.files || []).map(({ file_id, filename }) => ({ file_id, filename })),
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
    mockCreateCapabilityAuthorization.mockResolvedValue({
      authorizationRef: 'gha-synthetic-authorization',
      originRef: 'ghi-synthetic',
      scopeFingerprint: 'synthetic-scope-fingerprint',
      maxExpiresAt: new Date('2026-09-03T00:00:00.000Z'),
    });
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
        request_body: { conversationId: 'conv-1', messageId: 'msg-1' },
        worker_profile: 'codex-cli',
        fallback_worker_profile: 'claude-code',
        mission_host_tools: [],
      },
    });
    expect(bundle.glasshive_capability_broker.allowed_host_tools).toEqual(grant.allowed_host_tools);
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

  test('commits an active-work mutation once with a turn-derived operation id', async () => {
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
      args: { workRef: 'work-1', action: 'pause' },
    });

    expect(mockExecuteGlassHiveWorkAction).toHaveBeenCalledTimes(2);
    const firstOperationId = mockExecuteGlassHiveWorkAction.mock.calls[0][0].operationId;
    expect(firstOperationId).toMatch(/^ghno_[a-f0-9]{64}$/);
    expect(mockExecuteGlassHiveWorkAction.mock.calls[1][0].operationId).toBe(firstOperationId);
  });

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

  test('revokes a grant idempotently and blocks it throughout its renewal window', async () => {
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
      renewableTtlSeconds: 15 * 60,
      nowMs: 1_000_000,
    });
    const grant = verifyBrokerGrant(token, {
      nowMs: 1_061_000,
      allowRenewal: true,
      expectedTenantId: 'tenant-a',
    });

    await expect(assertBrokerGrantActive(grant, { nowMs: 1_061_000 })).resolves.toMatchObject({
      active: true,
    });
    await expect(revokeBrokerGrant(grant, { nowMs: 1_061_000 })).resolves.toMatchObject({
      revoked: true,
    });
    await expect(revokeBrokerGrant(grant, { nowMs: 1_062_000 })).resolves.toMatchObject({
      revoked: true,
    });
    await expect(assertBrokerGrantActive(grant, { nowMs: 1_063_000 })).rejects.toThrow(/revoked/);
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
    expect(mockReinitMCPServer).toHaveBeenCalledTimes(1);
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
  });

  test('injects run memory and the pinned feeling capsule into every worker instruction bundle', async () => {
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
    expect(withMemory.bootstrap_bundle_json.claude_md).toContain('- Energy: steady');
    expect(withMemory.bootstrap_bundle_json.codex_md).toContain('</viventium_feeling_state>');
    for (const field of ['agents_md', 'claude_md', 'codex_md']) {
      expect(withMemory.bootstrap_bundle_json[field].trim().endsWith(feelings)).toBe(true);
      expect(withMemory.bootstrap_bundle_json[field].split(feelings)).toHaveLength(2);
    }
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
    expect(result.bootstrap_bundle_json.claude_md).toContain(capsule);
    expect(result.bootstrap_bundle_json.codex_md).toContain(capsule);
    expect(result.bootstrap_bundle_json.agents_md.trim().endsWith(capsule)).toBe(true);
    expect(result.bootstrap_bundle_json.claude_md.trim().endsWith(capsule)).toBe(true);
    expect(result.bootstrap_bundle_json.codex_md.trim().endsWith(capsule)).toBe(true);
    expect(result.bootstrap_bundle_json.glasshive_capability_broker).toBeUndefined();
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
    expect(definitions.map((tool) => tool.name)).toContain('gh_google_workspace__calendar_create');

    const blocked = await handleToolCall({
      grant,
      toolName: 'gh_google_workspace__calendar_create',
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
      (tool) => tool.name === 'gh_scheduling_cortex__schedule_create',
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
      definitions.find((tool) => tool.name === 'gh_ms_365__mail_search')?.annotations.access,
    ).toBe('content_read');
    expect(definitions.find((tool) => tool.name === 'gh_ms_365__mail_search')?.annotations).toEqual(
      expect.objectContaining({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      }),
    );
    expect(
      definitions.find((tool) => tool.name === 'gh_ms_365__calendar_delete')?.annotations.access,
    ).toBe('write');
    expect(
      definitions.find((tool) => tool.name === 'gh_ms_365__calendar_delete')?.annotations,
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
      'gh_google_workspace__search_gmail_messages',
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
