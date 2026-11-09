const mockContextFactory = jest.fn((dependencies) => dependencies);
const mockPresenterFactory = jest.fn((dependencies) => dependencies);
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  createNativeCoordinatorContextAdapter: (...args) => mockContextFactory(...args),
  createNativeCoordinatorResultPresenter: (...args) => mockPresenterFactory(...args),
  nativeCoordinatorResultVoiceTurnId: jest.fn(() => 'native-result-voice-turn'),
}));
jest.mock('mongoose', () => ({
  ...jest.requireActual('mongoose'),
  connection: { collection: jest.fn() },
}));
jest.mock('~/models', () => ({ getUserById: jest.fn(), getMessages: jest.fn() }));
jest.mock('~/models/Agent', () => ({ loadAgent: jest.fn() }));
jest.mock('~/server/services/Config', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/services/Endpoints/agents/initialize', () => ({ initializeClient: jest.fn() }));
jest.mock('../ViventiumMainContextService', () => ({
  getMainContextAttemptState: jest.fn(),
  buildInheritedConversationContext: jest.fn(),
}));
jest.mock('../interactionContext', () => ({
  setTrustedInteractionContext: jest.fn((req, context) => {
    req.testInteraction = context;
  }),
  getTrustedInteractionContext: (req) => req.testInteraction,
  projectTrustedClientPresentation: (body) => body,
}));
jest.mock('../GlassHiveConversationProviderService', () => ({
  declaredMcpServerNames: jest.fn(() => ['authorized-server']),
  resolveHostToolCapabilityState: jest.fn(),
  resolveConversationProviderUploadedFiles: jest.fn(async () => []),
  resolveConversationProviderId: jest.fn((agent) => agent.endpoint || agent.provider),
  attachConversationProviderBootstrapBundle: jest.fn(),
}));
jest.mock('../GlassHiveCapabilityAuthorizationService', () => ({
  readCapabilityAuthorizationServerScope: jest.fn(),
}));
jest.mock('../GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: jest.fn(),
  maybeInjectGlassHiveCapabilityBroker: jest.fn(),
  mergeWorkerContextBundle: jest.fn(({ existingBundle }) => ({ ...existingBundle })),
  projectWorkerFeelingBundle: jest.fn(({ bundle }) => bundle),
}));
jest.mock('../GlassHiveCallbackBindingService', () => ({
  reconcileGlassHiveLaunchResult: jest.fn(),
  resolveConfiguredGlassHiveDestinations: jest.fn(),
}));
jest.mock('../GlassHiveAccountService', () => ({
  invalidateActiveWorkSnapshot: jest.fn(),
  requestAccountApi: jest.fn(),
}));
jest.mock('../BackgroundCortexFollowUpService', () => ({
  createCortexFollowUpMessage: jest.fn(),
  bindOwnedVoiceCortexRecovery: jest.fn(),
  publishCortexVoiceFollowUp: jest.fn(),
}));
jest.mock('../CortexInsightDeliveryService', () => ({
  getCortexInsightDeliveriesForParent: jest.fn(),
  claimPendingCortexInsightDeliveriesForParent: jest.fn(),
}));
jest.mock('../GlassHiveCallbackDeliveryService', () => ({
  enqueueGlassHiveCallbackDelivery: jest.fn(),
}));
jest.mock('../staleCortexMessageRecovery', () => ({ resolveOwnedVoiceCortexRecovery: jest.fn() }));
jest.mock('../CallSessionService', () => ({ getActiveCallSessionForConversation: jest.fn() }));
jest.mock('../NativeCoordinatorPresentationService', () => ({
  persistAuthority: jest.fn(async (message) => message),
  settleLinkedWeb: jest.fn(async () => true),
  resolve: jest.fn(async () => null),
  recover: jest.fn(async () => true),
}));

const db = require('~/models');
const { loadAgent } = require('~/models/Agent');
const { getAppConfig } = require('~/server/services/Config');
const { initializeClient } = require('~/server/services/Endpoints/agents/initialize');
const { getTrustedInteractionContext } = require('../interactionContext');
const { getMainContextAttemptState } = require('../ViventiumMainContextService');
const {
  resolveHostToolCapabilityState,
  declaredMcpServerNames,
  resolveConversationProviderUploadedFiles,
} = require('../GlassHiveConversationProviderService');
const {
  buildConversationProviderBootstrapBundle,
} = require('../GlassHiveCapabilityBootstrapService');
const { bindOwnedVoiceCortexRecovery } = require('../BackgroundCortexFollowUpService');
const { resolveOwnedVoiceCortexRecovery } = require('../staleCortexMessageRecovery');
const service = require('../NativeCoordinatorContextService');

const original = {
  conversationId: 'core-chat',
  agent_id: 'main',
  messageId: 'actual-main-answer',
  parentMessageId: 'original-user',
  viventiumSourceEventId: 'original-source',
  viventiumTriggeringSourceSegments: [
    {
      source_event_id: 'original-source',
      source_index: 0,
      text: 'Original source exactly.',
      source_message_id: 'original-user',
      source_persisted: true,
    },
  ],
  viventiumSurface: 'telegram',
  viventiumStreamId: 'finished-stream',
  viventiumLogicalTurnId: 'old-turn',
  viventiumLogicalTurnRevision: 1,
};
const binding = {
  _id: 'binding',
  nativeConversationId: 'native-chat',
  ownerId: 'owner',
  conversationId: 'core-chat',
  agentId: 'main',
};
const nativeResultData = {
  goal_id: 'goal',
  run_id: 'run',
  result_revision: 1,
  result_digest: `sha256:${'a'.repeat(64)}`,
};
const agent = { id: 'main', provider: 'native', tools: [], model_parameters: {} };
const inherited = { version: 1, conversation_id: 'core-chat', sources: [] };

beforeEach(() => {
  jest.clearAllMocks();
  resolveConversationProviderUploadedFiles.mockReset().mockResolvedValue([]);
  require('../CallSessionService').getActiveCallSessionForConversation.mockResolvedValue(null);
  require('../GlassHiveCallbackDeliveryService').enqueueGlassHiveCallbackDelivery.mockResolvedValue(
    {
      configured: 1,
      enqueued: 1,
      unresolved: 0,
    },
  );
  db.getUserById.mockResolvedValue({ id: 'owner', role: 'USER' });
  db.getMessages.mockResolvedValue([]);
  loadAgent.mockResolvedValue(agent);
  getAppConfig.mockResolvedValue({
    endpoints: {
      agents: {
        providerCapabilities: {
          native: { workspace_binding: true, native_tools: true },
        },
      },
    },
  });
  getMainContextAttemptState.mockReturnValue({ inheritedConversation: inherited });
  declaredMcpServerNames.mockReturnValue(['authorized-server']);
  resolveHostToolCapabilityState.mockResolvedValue({
    authorizedHostTools: ['file_search', 'active_work_list'],
    hostToolResources: { file_search: { files: [{ file_id: 'file' }] } },
  });
  buildConversationProviderBootstrapBundle.mockResolvedValue({
    glasshive_capability_broker: { id: 'fresh-grant' },
  });
  initializeClient.mockImplementation(async ({ req }) => ({
    client: {
      options: { agent },
      prepareMainResultContext: async () => {
        req._viventiumGlassHiveWorkerMemory = 'Current authorized memory.';
        req._viventiumGlassHiveWorkerFeelings = 'Current feelings.';
        req._viventiumGlassHiveWorkerFeelingsScope = 'all_agents';
        return {
          instructions: 'Current personality.',
          memoryContext: 'Current memory.',
          messages: [{ _getType: () => 'human', content: 'Original source exactly.' }],
        };
      },
    },
  }));
});

test.each(['owned', 'foreign', 'sibling', 'deselected'])(
  'carries only existing-reader %s prior text attachments when the current source has none',
  async (visibility) => {
    const { resolveSelectedHistoryAttachments, trustedUploadedFilesFromRequestBody } =
      jest.requireActual('@librechat/api');
    const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const parent = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const earlier = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const fileId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const text = 'item: sample\nquantity: 2\nunit_price: 4';
    const file = { file_id: fileId, filename: 'retained-table.csv', type: 'text/csv',
      source: 'text', context: 'message_attachment', bytes: Buffer.byteLength(text), text };
    const reads = {
      getMessages: jest.fn(async (filter) => filter.user === 'owner' ? [
        { messageId: parent, ...(visibility !== 'sibling' ? { parentMessageId: earlier } : {}) },
        { messageId: earlier, files: [{ file_id: fileId }] },
      ] : []),
      getFiles: jest.fn(async (filter) => filter.user === 'owner' && visibility !== 'foreign' &&
        filter.file_id.$in.includes(fileId) ? [file] : []),
    };
    resolveConversationProviderUploadedFiles.mockImplementationOnce(async (req, body, options) => {
      expect(options).toEqual({ includeHistory: true });
      return trustedUploadedFilesFromRequestBody({ files: await resolveSelectedHistoryAttachments({
        userId: req.user.id, conversationId: body.conversationId, parentMessageId: body.parentMessageId,
      }, reads, visibility === 'deselected' ? [] : undefined) });
    });
    const context = await service.prepareContext({
      binding: { ...binding, conversationId },
      source: { requestBody: { ...original, conversationId, parentMessageId: parent, files: [] } },
      eventId: 'native-history-turn', purpose: 'worker',
    });
    const expected = visibility === 'owned' ? [{ ...file, media_group_index: 0 }] : [];
    expect(context.workerContext.glasshive_uploaded_files).toEqual(expected);
    expect(context.bundle.glasshive_upload_context?.tool_uploaded_files || []).toEqual(expected);
    const actionBundle = await service.prepareActionBundle(context);
    expect(actionBundle.glasshive_upload_context?.tool_uploaded_files || []).toEqual(expected);
    expect(context.requestBody.files).toEqual([]);
    const { maybeInjectGlassHiveCapabilityBroker } = require('../GlassHiveCapabilityBootstrapService');
    await service.injectDelegation({ toolArguments: { goal: 'Use the selected source.' },
      user: context.user, requestBody: context.requestBody, workerContext: context.workerContext,
      invocationId: 'native-chat:historical-goal', route: {
        profile: 'codex-cli', model: 'codex-cli:synthetic-configured-model', effort: 'high',
      } });
    const transported = maybeInjectGlassHiveCapabilityBroker.mock.calls.at(-1)[0].toolArguments;
    expect(transported.uploaded_files || []).toEqual(expected);
    expect(JSON.stringify(transported)).not.toContain('filepath');
    if (visibility === 'owned') {
      expect(reads.getFiles).toHaveBeenCalledWith(expect.objectContaining({ user: 'owner' }), null,
        'file_id filename type bytes source context text messageId');
      expect(transported.uploaded_files[0].text).toBe(text);
    }
  },
);

test('uses the declared Native endpoint capability after initializeClient remaps the transport provider', async () => {
  const initialize = initializeClient.getMockImplementation();
  initializeClient.mockImplementationOnce(async (input) => {
    const result = await initialize(input);
    result.client.options.agent = { ...agent, provider: 'openAI', endpoint: 'glasshive-harness' };
    return result;
  });
  const capability = { workspace_binding: true, native_tools: true };
  getAppConfig.mockResolvedValue({ endpoints: { agents: { providerCapabilities: {
    'glasshive-harness': capability, openAI: { native_tools: false },
  } } } });
  const context = await service.prepareContext({ binding, source: { requestBody: original },
    eventId: 'native-turn', purpose: 'worker' });
  expect(context.bundle.glasshive_capability_broker).toBeDefined();
  expect(resolveHostToolCapabilityState).toHaveBeenCalledWith(expect.objectContaining({ capability,
    targetAgent: expect.objectContaining({ provider: 'openAI', endpoint: 'glasshive-harness' }),
  }));
});

test('fails before preparing a broker when the declared Native endpoint has no workspace capability', async () => {
  getAppConfig.mockResolvedValue({ endpoints: { agents: { providerCapabilities: {} } } });
  await expect(service.prepareContext({ binding, source: { requestBody: original },
    eventId: 'native-turn', purpose: 'worker' }))
    .rejects.toMatchObject({ code: 'coordinator_capabilities_unavailable' });
  expect(resolveHostToolCapabilityState).not.toHaveBeenCalled();
  expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
});

test('inherits current Main context and fresh capabilities without foreground generation authority', async () => {
  const context = await service.prepareContext({
    binding,
    source: { requestBody: original },
    eventId: 'native-turn',
    purpose: 'worker',
  });
  expect(context.instructions).toBe('Current personality.');
  expect(context.workerContext.glasshive_worker_memory).toBe('Current authorized memory.');
  expect(context.workerContext.glasshive_worker_feelings).toBe('Current feelings.');
  expect(context.inheritedConversation).toBe(inherited);
  expect(context.requestBody.messageId).toBe('actual-main-answer');
  expect(context.requestBody.parentMessageId).toBe('original-user');
  expect(context.requestBody).not.toHaveProperty('viventiumStreamId');
  expect(context.requestBody).not.toHaveProperty('viventiumLogicalTurnId');
  expect(getTrustedInteractionContext(context.req)).toMatchObject({
    actor_kind: 'system',
    origin: 'worker',
  });
  expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(
    expect.objectContaining({
      allowedConversationOrchestrationTools: [],
      allowedHostTools: ['file_search'],
      workerMemory: 'Current authorized memory.',
      workerFeelings: 'Current feelings.',
    }),
  );
});

test.each([undefined, 'ask', 'full', 'unrecognized'])(
  'uses existing Worker launch authority with only the current saved access %s',
  async (access) => {
    const initialize = initializeClient.getMockImplementation();
    initializeClient.mockImplementationOnce(async (input) => {
      const result = await initialize(input);
      result.client.options.agent = {
        ...agent,
        glasshive_options: { orchestration: {
          worker_profile: 'claude-code', worker_model: 'configured-other-route',
          worker_reasoning_effort: 'high', worker_access: access,
        } },
      };
      return result;
    });
    const context = await service.prepareContext({
      binding, source: { requestBody: original }, eventId: 'native-turn', purpose: 'worker',
    });
    const route = { profile: 'codex-cli', model: 'codex-cli:synthetic-configured-model', effort: 'high' };
    const preparationAuthority = { kind: 'native_coordinator_dispatch', generation: 2,
      notificationRef: 'current-native-notification', expiresAt: '2026-08-22T13:00:00.000Z' };
    const { maybeInjectGlassHiveCapabilityBroker } = require('../GlassHiveCapabilityBootstrapService');
    await service.injectDelegation({
      toolArguments: { goal: 'Original work.', worker_access: 'full' },
      user: context.user, requestBody: context.requestBody, workerContext: context.workerContext,
      invocationId: 'native-chat:goal', route, preparationAuthority,
    });
    const injected = maybeInjectGlassHiveCapabilityBroker.mock.calls.at(-1)[0];
    expect(injected.config.configurable.glasshive_launch_authority_kind).toBe('conversation_orchestrator');
    expect(injected.config.configurable.glasshive_launch_preparation_authority).toBe(preparationAuthority);
    expect(injected.config.configurable.glasshive_worker_route).toEqual({
      worker_model: route.model, worker_reasoning_effort: route.effort,
      ...(['ask', 'full'].includes(access) ? { worker_access: access } : {}),
    });
    expect(injected.config.configurable.glasshive_worker_route).not.toHaveProperty('worker_profile');
    expect(injected.config.configurable.glasshive_worker_route).not.toHaveProperty('execution_mode');
  },
);

test('preserves independent authorized tools during an optional connector outage', async () => {
  buildConversationProviderBootstrapBundle.mockResolvedValue({
    glasshive_capability_broker: { id: 'fresh-grant' },
    glasshive_capability_status: { status: 'degraded', reason: 'registry_unavailable' },
  });
  const context = await service.prepareContext({
    binding,
    source: { requestBody: original },
    eventId: 'native-turn',
    purpose: 'worker',
  });
  expect(context.workerContext.glasshive_host_tools).toEqual(['file_search']);
  expect(context.bundle.glasshive_capability_status.reason).toBe('registry_unavailable');
});

test('fails typed when no authorized capability grant is available', async () => {
  buildConversationProviderBootstrapBundle.mockResolvedValue({
    glasshive_capability_status: {
      status: 'degraded',
      reason: 'grant_unavailable',
    },
  });
  await expect(
    service.prepareContext({
      binding,
      source: { requestBody: original },
      eventId: 'native-turn',
      purpose: 'worker',
    }),
  ).rejects.toThrow('coordinator_capabilities_unavailable');
});

test('an intentional zero-MCP/host scope retains independently authorized native execution', async () => {
  declaredMcpServerNames.mockReturnValue([]);
  resolveHostToolCapabilityState.mockResolvedValue({
    authorizedHostTools: [],
    hostToolResources: {},
  });
  buildConversationProviderBootstrapBundle.mockResolvedValue({});
  const context = await service.prepareContext({
    binding,
    source: { requestBody: original },
    eventId: 'native-turn',
    purpose: 'worker',
  });
  expect(context.bundle).toEqual({});
  expect(context.workerContext.glasshive_host_tools).toEqual([]);
  expect(context.inheritedConversation).toBe(inherited);
});

test('an accepted Native result detaches obsolete foreground Voice authority while keeping source refs private', async () => {
  const body = {
    ...original,
    viventiumSurface: 'voice',
    viventiumVoiceTaskId: 'task',
    viventiumCallSessionId: 'call',
  };
  db.getMessages.mockResolvedValue([
    { messageId: 'actual-main-answer', metadata: { viventium: {} } },
  ]);
  resolveOwnedVoiceCortexRecovery.mockResolvedValue({ state: 'linked_text' });
  const context = await service.prepareContext({
    binding,
    source: { requestBody: body },
    eventId: 'native-result',
    purpose: 'callback',
  });
  expect(getTrustedInteractionContext(context.req)).toMatchObject({
    actor_kind: 'system',
    origin: 'callback',
    surface: 'web',
  });
  expect(context.req.body.viventiumVoiceTaskId).toBeUndefined();
  expect(context.req.body.viventiumCallSessionId).toBeUndefined();
  expect(context.req.body.voiceMode).toBe(false);
  expect(context.presentationSurface).toBe('web');
  expect(body.viventiumVoiceTaskId).toBe('task');
  expect(bindOwnedVoiceCortexRecovery).not.toHaveBeenCalled();
});

test.each([
  null,
  { callSessionId: 'different', userId: 'owner', conversationId: 'core-chat' },
  { callSessionId: 'call', userId: 'other', conversationId: 'core-chat' },
])(
  'accepted result keeps linked text without speaking to an ended/moved/foreign Call: %p',
  async (activeCall) => {
    const { publishCortexVoiceFollowUp } = require('../BackgroundCortexFollowUpService');
    const {
      resolveConfiguredGlassHiveDestinations,
    } = require('../GlassHiveCallbackBindingService');
    const body = {
      ...original,
      viventiumSurface: 'voice',
      viventiumVoiceTaskId: 'task',
      viventiumCallSessionId: 'call',
    };
    require('../CallSessionService').getActiveCallSessionForConversation.mockResolvedValue(
      activeCall,
    );
    resolveConfiguredGlassHiveDestinations.mockResolvedValue([
      { surface: 'voice' },
      { surface: 'librechat' },
    ]);
    const receipt = await service.presentResult.enqueue({
      binding,
      source: { requestBody: body },
      eventId: 'native-result',
      message: { messageId: 'persisted-main-result', text: 'Completed work.' },
      data: nativeResultData,
    });
    expect(receipt.linkedWebCommitted).toBe(true);
    expect(publishCortexVoiceFollowUp).not.toHaveBeenCalled();
  },
);

test('a live Native goal result uses its own verified voice source after the old foreground task was interrupted', async () => {
  const { publishCortexVoiceFollowUp } = require('../BackgroundCortexFollowUpService');
  const { resolveConfiguredGlassHiveDestinations } = require('../GlassHiveCallbackBindingService');
  const { enqueueGlassHiveCallbackDelivery } = require('../GlassHiveCallbackDeliveryService');
  const body = {
    ...original,
    viventiumSurface: 'voice',
    viventiumVoiceTaskId: 'task',
    viventiumCallSessionId: 'call',
  };
  resolveOwnedVoiceCortexRecovery.mockResolvedValue({ state: 'suppressed' });
  require('../CallSessionService').getActiveCallSessionForConversation.mockResolvedValue({
    callSessionId: 'call',
    userId: 'owner',
    conversationId: 'core-chat',
  });
  resolveConfiguredGlassHiveDestinations.mockResolvedValue([
    { surface: 'voice' },
    { surface: 'librechat' },
  ]);
  await service.presentResult.enqueue({
    binding,
    source: { turnId: 'source-turn', requestBody: body },
    eventId: 'native-result',
    message: { messageId: 'persisted-main-result', text: 'Completed work.' },
    data: {
      goal_id: 'goal',
      run_id: 'run',
      result_revision: 1,
      result_digest: `sha256:${'a'.repeat(64)}`,
    },
  });
  expect(publishCortexVoiceFollowUp).not.toHaveBeenCalled();
  expect(resolveOwnedVoiceCortexRecovery).not.toHaveBeenCalled();
  expect(enqueueGlassHiveCallbackDelivery).toHaveBeenCalledTimes(1);
  expect(enqueueGlassHiveCallbackDelivery).toHaveBeenCalledWith(
    expect.objectContaining({
      deliveryContext: expect.objectContaining({
        originRef: 'binding',
        destinations: [
          { surface: 'librechat' },
          {
            surface: 'voice',
            voiceCallSessionId: 'call',
            voiceRequestId: 'native-result-voice-turn',
          },
        ],
        mainGenerationPresentation: {
          nativeCoordinatorResult: expect.objectContaining({
            bindingRef: 'binding',
            nativeConversationId: 'native-chat',
            goalId: 'goal',
            runId: 'run',
            sourceTurnId: 'source-turn',
            sourceCallSessionId: 'call',
          }),
        },
      }),
    }),
  );
});

test('acknowledges existing canonical linked text without forging a Worker callback transaction', async () => {
  const { resolveConfiguredGlassHiveDestinations } = require('../GlassHiveCallbackBindingService');
  const { enqueueGlassHiveCallbackDelivery } = require('../GlassHiveCallbackDeliveryService');
  resolveConfiguredGlassHiveDestinations.mockResolvedValue([{ surface: 'librechat' }]);
  const receipt = await service.presentResult.enqueue({
    binding,
    source: { requestBody: original },
    eventId: 'native-result',
    message: { messageId: 'verified-cortex-result', text: 'Result.' },
    data: nativeResultData,
  });
  expect(receipt).toEqual({ configured: 0, enqueued: 0, unresolved: 0, linkedWebCommitted: true });
  expect(enqueueGlassHiveCallbackDelivery).not.toHaveBeenCalled();
});

test('Telegram self-results carry genuine Native authority with no invented Call', async () => {
  const { resolveConfiguredGlassHiveDestinations } = require('../GlassHiveCallbackBindingService');
  const { enqueueGlassHiveCallbackDelivery } = require('../GlassHiveCallbackDeliveryService');
  const destinations = [
    {
      surface: 'telegram',
      telegramChatId: 'chat',
      telegramUserId: 'telegram-user',
      telegramMessageThreadId: 'thread',
    },
    { surface: 'librechat' },
  ];
  resolveConfiguredGlassHiveDestinations.mockResolvedValue(destinations);
  await service.presentResult.enqueue({
    binding,
    source: { turnId: 'source-turn', requestBody: original },
    eventId: 'native-result',
    message: { messageId: 'persisted-main-result', text: 'Completed work.' },
    data: nativeResultData,
  });
  expect(enqueueGlassHiveCallbackDelivery).toHaveBeenCalledWith(
    expect.objectContaining({
      deliveryContext: expect.objectContaining({
        destinations,
        mainGenerationPresentation: {
          nativeCoordinatorResult: {
            bindingRef: 'binding',
            nativeConversationId: 'native-chat',
            goalId: 'goal',
            runId: 'run',
            resultRevision: 1,
            resultDigest: nativeResultData.result_digest,
            sourceTurnId: 'source-turn',
            sourceCallSessionId: '',
          },
        },
      }),
    }),
  );
  expect(
    require('../CallSessionService').getActiveCallSessionForConversation,
  ).not.toHaveBeenCalled();
});

test('an ended Voice Call retains its authorized Telegram result and Native source without speech', async () => {
  const { resolveConfiguredGlassHiveDestinations } = require('../GlassHiveCallbackBindingService');
  const { enqueueGlassHiveCallbackDelivery } = require('../GlassHiveCallbackDeliveryService');
  const telegram = { surface: 'telegram', telegramChatId: 'chat', telegramUserId: 'telegram-user' };
  resolveConfiguredGlassHiveDestinations.mockResolvedValue([
    { surface: 'voice', voiceCallSessionId: 'call' },
    telegram,
    { surface: 'librechat' },
  ]);
  await service.presentResult.enqueue({
    binding,
    source: {
      turnId: 'source-turn',
      requestBody: {
        ...original,
        viventiumSurface: 'voice',
        viventiumCallSessionId: 'call',
      },
    },
    eventId: 'native-result',
    message: { messageId: 'persisted-main-result', text: 'Completed work.' },
    data: nativeResultData,
  });
  expect(enqueueGlassHiveCallbackDelivery).toHaveBeenCalledWith(
    expect.objectContaining({
      deliveryContext: expect.objectContaining({
        destinations: [telegram, { surface: 'librechat' }],
        mainGenerationPresentation: {
          nativeCoordinatorResult: expect.objectContaining({
            sourceCallSessionId: 'call',
            sourceTurnId: 'source-turn',
            runId: 'run',
          }),
        },
      }),
    }),
  );
});

test('mixed live Voice and Telegram keep both existing targets under one Native result source', async () => {
  const { resolveConfiguredGlassHiveDestinations } = require('../GlassHiveCallbackBindingService');
  const { enqueueGlassHiveCallbackDelivery } = require('../GlassHiveCallbackDeliveryService');
  const telegram = { surface: 'telegram', telegramChatId: 'chat', telegramUserId: 'telegram-user' };
  resolveConfiguredGlassHiveDestinations.mockResolvedValue([
    { surface: 'voice', voiceCallSessionId: 'call' },
    telegram,
    { surface: 'librechat' },
  ]);
  require('../CallSessionService').getActiveCallSessionForConversation.mockResolvedValue({
    callSessionId: 'call',
    userId: 'owner',
    conversationId: 'core-chat',
  });
  await service.presentResult.enqueue({
    binding,
    source: {
      turnId: 'source-turn',
      requestBody: {
        ...original,
        viventiumSurface: 'voice',
        viventiumCallSessionId: 'call',
      },
    },
    eventId: 'native-result',
    message: { messageId: 'persisted-main-result', text: 'Completed work.' },
    data: nativeResultData,
  });
  expect(enqueueGlassHiveCallbackDelivery).toHaveBeenCalledWith(
    expect.objectContaining({
      deliveryContext: expect.objectContaining({
        destinations: [
          telegram,
          { surface: 'librechat' },
          {
            surface: 'voice',
            voiceCallSessionId: 'call',
            voiceRequestId: 'native-result-voice-turn',
          },
        ],
        mainGenerationPresentation: {
          nativeCoordinatorResult: expect.objectContaining({
            sourceCallSessionId: 'call',
            sourceTurnId: 'source-turn',
            runId: 'run',
          }),
        },
      }),
    }),
  );
});

test('refreshes continuation memory and scoped Feelings through the existing launch projection', async () => {
  const {
    mergeWorkerContextBundle,
    projectWorkerFeelingBundle,
  } = require('../GlassHiveCapabilityBootstrapService');
  const context = {
    bundle: { current_grant: true },
    inheritedConversation: inherited,
    workerContext: {
      glasshive_worker_memory: 'New memory.',
      glasshive_worker_feelings: 'New feelings.',
      glasshive_worker_feelings_scope: 'all_agents',
    },
    user: { id: 'owner' },
    requestBody: original,
  };
  const result = await service.prepareActionBundle(context);
  expect(mergeWorkerContextBundle).toHaveBeenCalledWith({
    existingBundle: {
      current_grant: true,
      application_context_format: 'opaque_v1',
      inherited_conversation: inherited,
    },
    workerMemory: 'New memory.',
    workerFeelings: 'New feelings.',
  });
  expect(projectWorkerFeelingBundle).toHaveBeenCalledWith({
    bundle: result,
    workerFeelings: 'New feelings.',
    workerFeelingsScope: 'all_agents',
  });
});

test('recognizes only exact owner/conversation/candidate terminal dropped receipts', async () => {
  const { getCortexInsightDeliveriesForParent } = require('../CortexInsightDeliveryService');
  const read = service.presentResult.readPresentation;
  getCortexInsightDeliveriesForParent.mockImplementation(async ({ownerId,parentMessageId}) =>
    ownerId === 'owner' && parentMessageId === 'parent' ? [
    {
      conversationId: 'core-chat',
      parentMessageId: 'parent',
      deliveryId: 'delivery',
      status: 'dropped',
      dropReason: 'no_response',
    },
  ] : []);
  await expect(
    read({
      ownerId: 'owner',
      conversationId: 'core-chat',
      parentMessageId: 'parent',
      deliveryIds: ['delivery'],
    }),
  ).resolves.toEqual({ presentationDisposition: 'dropped', dropReason: 'no_response' });
  await expect(
    read({
      ownerId: 'other',
      conversationId: 'core-chat',
      parentMessageId: 'parent',
      deliveryIds: ['delivery'],
    }),
  ).resolves.toBeNull();
  await expect(
    read({
      ownerId: 'owner',
      conversationId: 'other',
      parentMessageId: 'parent',
      deliveryIds: ['delivery'],
    }),
  ).resolves.toBeNull();
  await expect(
    read({
      ownerId: 'owner',
      conversationId: 'core-chat',
      parentMessageId: 'parent',
      deliveryIds: ['missing'],
    }),
  ).resolves.toBeNull();
});

test('recognizes a persisted Main result through the actual owner-scoped public delivery shape', async () => {
  const {getCortexInsightDeliveriesForParent}=require('../CortexInsightDeliveryService');
  const input={ownerId:'owner',conversationId:'core-chat',parentMessageId:'parent',deliveryIds:['delivery']};
  const row={conversationId:'core-chat',parentMessageId:'parent',deliveryId:'delivery',status:'claimed',persistenceStatus:'persisted',persistedMessageId:'same-main-message'};
  const message={messageId:'same-main-message',user:'owner',conversationId:'core-chat',parentMessageId:'parent',text:'The existing Main result.',metadata:{viventium:{cortexInsightDeliveryIds:['delivery']}}};
  getCortexInsightDeliveriesForParent.mockImplementation(async ({ownerId,parentMessageId})=>
    ownerId==='owner' && parentMessageId==='parent' ? [row] : []);
  db.getMessages.mockResolvedValue([message]);
  const read=service.presentResult.readPresentation;
  await expect(read(input)).resolves.toBe(message);
  await expect(read(input)).resolves.toBe(message);
  expect(getCortexInsightDeliveriesForParent).toHaveBeenCalledWith({ownerId:'owner',parentMessageId:'parent',deliveryIds:['delivery']});
  expect(db.getMessages).toHaveBeenLastCalledWith({user:'owner',conversationId:'core-chat',messageId:'same-main-message',isCreatedByUser:false});
  expect(row).not.toHaveProperty('userId');
  await expect(read({...input,ownerId:'foreign'})).resolves.toBeNull();
  await expect(read({...input,parentMessageId:'foreign-parent'})).resolves.toBeNull();
  await expect(read({...input,conversationId:'foreign-conversation'})).resolves.toBeNull();
  await expect(read({...input,deliveryIds:['delivery','missing']})).resolves.toBeNull();
  db.getMessages.mockResolvedValue([{...message,user:'foreign'}]);
  await expect(read(input)).rejects.toThrow('coordinator_presentation_unavailable');
  db.getMessages.mockResolvedValue([{...message,parentMessageId:'foreign-parent'}]);
  await expect(read(input)).rejects.toThrow('coordinator_presentation_unavailable');
  db.getMessages.mockResolvedValue([{...message,metadata:{viventium:{cortexInsightDeliveryIds:['different']}}}]);
  await expect(read(input)).rejects.toThrow('coordinator_presentation_unavailable');
});

test('keeps a transport-exhausted persisted message recoverable instead of treating it as silence', async () => {
  const { getCortexInsightDeliveriesForParent } = require('../CortexInsightDeliveryService');
  getCortexInsightDeliveriesForParent.mockResolvedValue([{ conversationId: 'core-chat', parentMessageId: 'parent',
    deliveryId: 'delivery', status: 'dropped', dropReason: 'delivery_attempts_exhausted',
    persistedMessageId: 'saved-main' }]);
  const message = { user: 'owner', conversationId: 'core-chat', parentMessageId: 'later-leaf',
    messageId: 'saved-main', text: 'The same saved result.', metadata: { viventium: {
      cortexInsightDeliveryIds: ['delivery'], cortexPresentationParentMessageId: 'parent' } } };
  db.getMessages.mockResolvedValue([message]);
  await expect(service.presentResult.readPresentation({ ownerId: 'owner', conversationId: 'core-chat',
    parentMessageId: 'parent', deliveryIds: ['delivery'] })).resolves.toBe(message);
});

test('binds the existing Native v2 source before saving a no-file Main reply', async () => {
  const { createCortexFollowUpMessage } = require('../BackgroundCortexFollowUpService');
  require('../CortexInsightDeliveryService').getCortexInsightDeliveriesForParent.mockResolvedValue([]);
  db.saveMessage = jest.fn(async (_req, value) => value);
  const source = { turnId: 'original-native-turn', requestBody: original };
  const data = { goal_id: 'goal', run_id: 'run', result_revision: 1, result_digest: `sha256:${'a'.repeat(64)}` };
  await service.presentResult.createFollowUp({ context: { req: { user: { id: 'owner' } }, agent: {} },
    binding, source, parentMessageId: original.messageId, eventId: 'native-result', insights: [], data });
  const [{ dependencies }] = createCortexFollowUpMessage.mock.calls.at(-1);
  await dependencies.saveMessage({}, { messageId: 'saved-main', text: 'Main reply.', metadata: {} }, {});
  expect(db.saveMessage.mock.calls[0][1].metadata.viventium.mainGenerationPresentation).toMatchObject({
    version: 2, responseMessageId: 'saved-main', nativeCoordinatorResult: {
      sourceTurnId: 'original-native-turn', goalId: 'goal', runId: 'run' } });
});

test.each(['retained-publication', ''])('same-event author replay preserves accepted admission scope %s and fresh cognition', async (publicationId) => {
  const { getCortexInsightDeliveriesForParent, claimPendingCortexInsightDeliveriesForParent } = require('../CortexInsightDeliveryService');
  const { createCortexFollowUpMessage } = require('../BackgroundCortexFollowUpService');
  const insights = [{ cortexId: 'native-event', status: 'completed', insight: 'The exact accepted result.',
    authority: { kind: 'native_coordinator_result', goalId: 'goal' } }];
  const candidates = require('@librechat/api').buildCortexInsightDeliveryCandidates({ ownerId: binding.ownerId,
    conversationId: binding.conversationId, parentMessageId: original.messageId, surface: 'web', insights });
  getCortexInsightDeliveriesForParent.mockResolvedValue(candidates.map(row => ({ ...row, publicationId })));
  const accepted = { claimed: candidates.map(row => ({ ...row, claimToken: 'accepted-claim', claimGeneration: 2 })),
    deliveries: candidates, recoveryContext: { feelingSnapshot: { version: 1, capsule: 'Original admission.' } } };
  claimPendingCortexInsightDeliveriesForParent.mockResolvedValue(accepted);
  const req = { user: { id: 'owner' }, body: { viventiumSurface: 'web' },
    _viventiumFeelingSnapshot: { version: 2, capsule: 'Current author cognition.' } };
  await service.presentResult.createFollowUp({ context: { req, agent: {} }, binding,
    source: { turnId: 'source', requestBody: original }, parentMessageId: original.messageId,
    eventId: 'native-event', insights, data: nativeResultData });
  expect(claimPendingCortexInsightDeliveriesForParent).toHaveBeenCalledWith({ ownerId: 'owner',
    parentMessageId: original.messageId, deliveryIds: candidates.map(row => row.deliveryId), surface: 'web' });
  expect(createCortexFollowUpMessage).toHaveBeenCalledWith(expect.objectContaining({ req,
    claimedDeliveryBatch: accepted, publicationId, insightsData: expect.objectContaining({ insights }) }));
  expect(req._viventiumFeelingSnapshot.version).toBe(2);
  expect(accepted.recoveryContext.feelingSnapshot.version).toBe(1);
});

test('an active exact Native author claim does not start another author or readmit fresh Feelings', async () => {
  const { getCortexInsightDeliveriesForParent, claimPendingCortexInsightDeliveriesForParent } = require('../CortexInsightDeliveryService');
  const { createCortexFollowUpMessage } = require('../BackgroundCortexFollowUpService');
  const insights = [{ cortexId: 'native-event', status: 'completed', insight: 'Exact accepted result.' }];
  const candidates = require('@librechat/api').buildCortexInsightDeliveryCandidates({ ownerId: 'owner',
    conversationId: binding.conversationId, parentMessageId: original.messageId, surface: 'web', insights });
  getCortexInsightDeliveriesForParent.mockResolvedValue(candidates);
  claimPendingCortexInsightDeliveriesForParent.mockResolvedValue({ claimed: [], deliveries: candidates });
  await expect(service.presentResult.createFollowUp({ context: { req: { user: { id: 'owner' }, body: {} }, agent: {} },
    binding, source: { turnId: 'source', requestBody: original }, parentMessageId: original.messageId,
    eventId: 'native-event', insights, data: nativeResultData })).resolves.toBeNull();
  expect(createCortexFollowUpMessage).not.toHaveBeenCalled();
});


test.each([
  { scope: ['authorized-server'], expected: ['authorized-server'], name: 'old mission excludes new Chrome' },
  { scope: ['authorized-server', 'chrome-devtools'], expected: ['authorized-server', 'chrome-devtools'], name: 'authorized mission retains Core Chrome' },
  { scope: [], expected: [], name: 'empty original mission scope stays empty' },
])('fresh Worker continuation uses original mission server ceiling: $name', async ({ scope, expected }) => {
  const { readCapabilityAuthorizationServerScope } = require('../GlassHiveCapabilityAuthorizationService');
  readCapabilityAuthorizationServerScope.mockResolvedValueOnce(scope);
  declaredMcpServerNames.mockReturnValueOnce(['authorized-server', 'chrome-devtools', 'new-unrelated']);
  await service.prepareContext({
    binding, source: { requestBody: original }, eventId: 'continuation', purpose: 'worker',
    workerWorkRef: 'actual-native-work',
  });
  expect(readCapabilityAuthorizationServerScope).toHaveBeenCalledWith({
    ownerId: 'owner', workRef: 'actual-native-work',
  });
  expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith(expect.objectContaining({
    allowedServerNames: expected,
  }));
});

test('missing original mission scope cannot mint a fresh broader Core grant or Native mask', async () => {
  const { readCapabilityAuthorizationServerScope } = require('../GlassHiveCapabilityAuthorizationService');
  readCapabilityAuthorizationServerScope.mockResolvedValueOnce(null);
  await expect(service.prepareContext({
    binding, source: { requestBody: original }, eventId: 'continuation', purpose: 'worker',
    workerWorkRef: 'actual-native-work',
  })).rejects.toMatchObject({ code: 'coordinator_worker_capabilities_unavailable' });
  expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
});
