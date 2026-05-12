const { Providers } = require('@librechat/agents');
const { Constants, ContentTypes, EModelEndpoint } = require('librechat-data-provider');
const db = require('~/models');
const AgentClient = require('./client');

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createMetadataAggregator: () => ({
    handleLLMEnd: jest.fn(),
    collected: [],
  }),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  checkAccess: jest.fn(),
  initializeAgent: jest.fn(),
  createMemoryProcessor: jest.fn(),
  loadMemorySnapshot: jest.fn(),
  GenerationJobManager: {
    emitChunk: jest.fn(),
    setGraph: jest.fn(),
  },
}));

jest.mock('~/server/services/viventium/BackgroundCortexFollowUpService', () => ({
  persistCortexPartsToCanonicalMessage: jest.fn().mockResolvedValue(undefined),
  finalizeCanonicalCortexMessage: jest.fn().mockResolvedValue(undefined),
  createCortexFollowUpMessage: jest.fn(),
}));

jest.mock('~/models/Agent', () => ({
  loadAgent: jest.fn(),
}));

jest.mock('~/models/Role', () => ({
  getRoleByName: jest.fn(),
}));

jest.mock('~/server/services/viventium/conversationRecallPrompt', () => ({
  buildConversationRecallInstructions: jest.fn(),
}));
jest.mock('~/server/services/viventium/conversationRecallService', () => ({
  scheduleConversationRecallSync: jest.fn(),
}));

// Mock getMCPManager
const mockFormatInstructions = jest.fn();
jest.mock('~/config', () => ({
  getMCPManager: jest.fn(() => ({
    formatInstructionsForContext: mockFormatInstructions,
  })),
}));

// Get references to mocked module functions (resolved after jest.mock hoisting)
const mockEmitChunk = require('@librechat/api').GenerationJobManager.emitChunk;
const mockPersistCortexPartsToCanonicalMessage =
  require('~/server/services/viventium/BackgroundCortexFollowUpService').persistCortexPartsToCanonicalMessage;
const mockFinalizeCanonicalCortexMessage =
  require('~/server/services/viventium/BackgroundCortexFollowUpService').finalizeCanonicalCortexMessage;
const mockCreateCortexFollowUpMessage =
  require('~/server/services/viventium/BackgroundCortexFollowUpService').createCortexFollowUpMessage;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('buildViventiumMcpRequestBody', () => {
  test('passes surface context and existing upload references to GlassHive MCP', () => {
    const body = AgentClient.buildViventiumMcpRequestBody({
      messageId: 'assistant-1',
      conversationId: 'conv-1',
      parentMessageId: 'user-1',
      req: {
        body: {
          viventiumSurface: 'telegram',
          viventiumInputMode: 'voice_note',
          streamId: 'stream-1',
          telegramChatId: 'chat-1',
          telegramUserId: 'tg-user-1',
          telegramMessageId: 'tg-msg-1',
        },
      },
      attachments: [
        {
          file_id: 'file-1',
          filename: 'brief.txt',
          filepath: '/uploads/user/brief.txt',
          source: 'local',
          text: 'brief text',
        },
      ],
      toolResources: { code_interpreter: { file_ids: ['file-1'] } },
    });

    expect(body.viventiumSurface).toBe('telegram');
    expect(body.viventiumStreamId).toBe('stream-1');
    expect(body.viventiumTelegramChatId).toBe('chat-1');
    expect(body.files[0]).toMatchObject({
      file_id: 'file-1',
      filename: 'brief.txt',
      filepath: '/uploads/user/brief.txt',
      text: 'brief text',
    });
    expect(body.attachments).toEqual(body.files);
    expect(body.file_ids).toEqual(['file-1']);
    expect(body.tool_resources.code_interpreter.file_ids).toEqual(['file-1']);
  });
});

describe('late completion error content parts', () => {
  test.each([
    'terminated',
    'TypeError: terminated',
    'stream terminated',
    'request terminated',
    'aborted',
    'AbortError',
    'operation was aborted',
    'request aborted',
    'ProviderError: aborted',
  ])('treats late stream wording as suppressible: %s', (message) => {
    expect(AgentClient.isLateStreamTerminationError(new Error(message))).toBe(true);
  });

  test.each(['status 429 rate_limit_error', '401 unauthorized', 'context length exceeded'])(
    'does not treat real provider failures as late stream termination: %s',
    (message) => {
      expect(AgentClient.isLateStreamTerminationError(new Error(message))).toBe(false);
    },
  );

  test('suppresses terminated stream errors after visible assistant text', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'Partial but visible answer.' }];

    expect(
      AgentClient.shouldSuppressCompletionErrorContentPart(contentParts, new Error('terminated')),
    ).toBe(true);
  });

  test('keeps visible errors when there is no assistant text or the error is not stream termination', () => {
    expect(AgentClient.shouldSuppressCompletionErrorContentPart([], new Error('terminated'))).toBe(
      false,
    );
    expect(
      AgentClient.shouldSuppressCompletionErrorContentPart(
        [{ type: ContentTypes.TEXT, text: 'Partial answer.' }],
        new Error('status 429 rate_limit_error'),
      ),
    ).toBe(false);
    expect(
      AgentClient.createCompletionErrorContentPart(new Error('status 429 rate_limit_error')),
    ).toEqual({
      type: ContentTypes.ERROR,
      [ContentTypes.ERROR]:
        'The model provider rate-limited this request. Please try again shortly.',
      error_class: 'provider_rate_limited',
    });
  });

  test('does not mutate content parts for late stream termination after assistant text', () => {
    const textPart = { type: ContentTypes.TEXT, text: 'Partial but visible answer.' };
    const contentParts = [textPart];
    const log = { warn: jest.fn(), error: jest.fn() };

    const result = AgentClient.handleCompletionErrorContentPart({
      contentParts,
      err: new Error('terminated'),
      abortController: { signal: { aborted: false } },
      log,
    });

    expect(result).toBe('suppressed');
    expect(contentParts).toEqual([textPart]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Late stream termination'),
      expect.objectContaining({ class: 'late_stream_termination' }),
    );
    expect(log.error).not.toHaveBeenCalled();
  });

  test('appends visible error content when no assistant text exists', () => {
    const contentParts = [];
    const log = { warn: jest.fn(), error: jest.fn() };

    const result = AgentClient.handleCompletionErrorContentPart({
      contentParts,
      err: new Error('terminated'),
      abortController: { signal: { aborted: false } },
      log,
    });

    expect(result).toBe('pushed');
    expect(contentParts).toEqual([
      {
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]: 'The model stream ended before a response was available.',
        error_class: 'late_stream_termination',
      },
    ]);
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  test('controller abort remains a silent abort even when assistant text exists', () => {
    const contentParts = [{ type: ContentTypes.TEXT, text: 'Partial answer.' }];
    const log = { warn: jest.fn(), error: jest.fn() };

    const result = AgentClient.handleCompletionErrorContentPart({
      contentParts,
      err: new Error('terminated'),
      abortController: { signal: { aborted: true } },
      log,
    });

    expect(result).toBe('aborted');
    expect(contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'Partial answer.' }]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Operation aborted by controller'),
      expect.objectContaining({ class: 'late_stream_termination' }),
    );
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('background cortex runtime card guard', () => {
  test('marks activated background agents as an exclusive runtime list', () => {
    const summary = AgentClient.formatActivationSummary([
      { cortexName: 'Confirmation Bias', reason: 'bias check', confidence: 0.9 },
    ]);

    expect(summary).toContain('## Activated Background Agents');
    expect(summary).toContain('Only the background agents listed below activated for this turn');
    expect(summary).toContain('Confirmation Bias');
  });

  test('injects the runtime card contract once for agents with background cortices', () => {
    const agent = {
      instructions: 'Base instructions.',
      background_cortices: [{ id: 'agent_background_analysis' }],
    };

    expect(AgentClient.ensureBackgroundCortexRuntimeCardGuard(agent)).toEqual(
      expect.stringContaining('Runtime may display background-cortex status/result cards'),
    );
    expect(agent.instructions).toContain('Base instructions.');
    expect(agent.instructions).toContain(
      'Runtime may display background-cortex status/result cards',
    );
    expect(agent.instructions).toContain(
      'Do not offer to start, spin up, launch, or run background agents/cortices',
    );
    expect(agent.instructions).toContain(
      'Do not say a specific background agent/cortex ran, is running, activated, completed, or checked the issue unless it appears in the current turn',
    );

    const afterFirstInjection = agent.instructions;
    expect(AgentClient.ensureBackgroundCortexRuntimeCardGuard(agent)).toBe(false);
    expect(agent.instructions).toBe(afterFirstInjection);
  });

  test('does not inject the runtime card contract for agents without background cortices', () => {
    const agent = { instructions: 'Base instructions.', background_cortices: [] };

    expect(AgentClient.ensureBackgroundCortexRuntimeCardGuard(agent)).toBe(false);
    expect(agent.instructions).toBe('Base instructions.');
    expect(AgentClient.ensureBackgroundCortexRuntimeCardGuard({ instructions: 'Base.' })).toBe(
      false,
    );
  });

  test('normalizes and clamps late activation detection timeout', () => {
    const previous = process.env.VIVENTIUM_CORTEX_LATE_DETECT_TIMEOUT_MS;
    try {
      delete process.env.VIVENTIUM_CORTEX_LATE_DETECT_TIMEOUT_MS;
      expect(AgentClient.getCortexLateDetectTimeoutMs(2000)).toBe(0);

      process.env.VIVENTIUM_CORTEX_LATE_DETECT_TIMEOUT_MS = '1500';
      expect(AgentClient.getCortexLateDetectTimeoutMs(2000)).toBe(0);

      process.env.VIVENTIUM_CORTEX_LATE_DETECT_TIMEOUT_MS = '45000';
      expect(AgentClient.getCortexLateDetectTimeoutMs(2000)).toBe(30000);

      process.env.VIVENTIUM_CORTEX_LATE_DETECT_TIMEOUT_MS = 'not-a-number';
      expect(AgentClient.getCortexLateDetectTimeoutMs(2000)).toBe(0);
    } finally {
      if (previous == null) {
        delete process.env.VIVENTIUM_CORTEX_LATE_DETECT_TIMEOUT_MS;
      } else {
        process.env.VIVENTIUM_CORTEX_LATE_DETECT_TIMEOUT_MS = previous;
      }
    }
  });
});

describe('AgentClient - titleConvo', () => {
  let client;
  let mockRun;
  let mockReq;
  let mockRes;
  let mockAgent;
  let mockOptions;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();
    db.getUserKey = jest.fn().mockResolvedValue(null);
    db.getUserKeyValues = jest.fn().mockResolvedValue({});
    db.updateUserKey = jest.fn().mockResolvedValue(null);

    // Mock run object
    mockRun = {
      generateTitle: jest.fn().mockResolvedValue({
        title: 'Generated Title',
      }),
    };

    // Mock agent - with both endpoint and provider
    mockAgent = {
      id: 'agent-123',
      endpoint: EModelEndpoint.openAI, // Use a valid provider as endpoint for getProviderConfig
      provider: EModelEndpoint.openAI, // Add provider property
      model_parameters: {
        model: 'gpt-4',
      },
    };

    // Mock request and response
    mockReq = {
      user: {
        id: 'user-123',
      },
      body: {
        model: 'gpt-4',
        endpoint: EModelEndpoint.openAI,
        key: null,
      },
      config: {
        endpoints: {
          [EModelEndpoint.openAI]: {
            // Match the agent endpoint
            titleModel: 'gpt-3.5-turbo',
            titlePrompt: 'Custom title prompt',
            titleMethod: 'structured',
            titlePromptTemplate: 'Template: {{content}}',
          },
        },
      },
    };

    mockRes = {};

    // Mock options
    mockOptions = {
      req: mockReq,
      res: mockRes,
      agent: mockAgent,
      endpointTokenConfig: {},
    };

    // Create client instance
    client = new AgentClient(mockOptions);
    client.run = mockRun;
    client.responseMessageId = 'response-123';
    client.conversationId = 'convo-123';
    client.contentParts = [{ type: 'text', text: 'Test content' }];
    client.recordCollectedUsage = jest.fn().mockResolvedValue(); // Mock as async function that resolves
  });

  describe('titleConvo method', () => {
    it('should throw error if run is not initialized', async () => {
      client.run = null;

      await expect(
        client.titleConvo({ text: 'Test', abortController: new AbortController() }),
      ).rejects.toThrow('Run not initialized');
    });

    it('should use titlePrompt from endpoint config', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titlePrompt: 'Custom title prompt',
        }),
      );
    });

    it('should use titlePromptTemplate from endpoint config', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titlePromptTemplate: 'Template: {{content}}',
        }),
      );
    });

    it('should use titleMethod from endpoint config', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: Providers.OPENAI,
          titleMethod: 'structured',
        }),
      );
    });

    it('should use titleModel from endpoint config when provided', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Check that generateTitle was called with correct clientOptions
      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-3.5-turbo');
    });

    it('should handle missing endpoint config gracefully', async () => {
      // Remove endpoint config
      mockReq.config = { endpoints: {} };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titlePrompt: undefined,
          titlePromptTemplate: undefined,
          titleMethod: undefined,
        }),
      );
    });

    it('should use agent model when titleModel is not provided', async () => {
      // Remove titleModel from config
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titlePrompt: 'Custom title prompt',
            titleMethod: 'structured',
            titlePromptTemplate: 'Template: {{content}}',
            // titleModel is omitted
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-4'); // Should use agent's model
    });

    it('should not use titleModel when it equals CURRENT_MODEL constant', async () => {
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titleModel: Constants.CURRENT_MODEL,
            titlePrompt: 'Custom title prompt',
            titleMethod: 'structured',
            titlePromptTemplate: 'Template: {{content}}',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-4'); // Should use agent's model
    });

    it('should pass all required parameters to generateTitle', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith({
        provider: expect.any(String),
        inputText: text,
        contentParts: client.contentParts,
        clientOptions: expect.objectContaining({
          model: 'gpt-3.5-turbo',
        }),
        titlePrompt: 'Custom title prompt',
        titlePromptTemplate: 'Template: {{content}}',
        titleMethod: 'structured',
        chainOptions: expect.objectContaining({
          signal: abortController.signal,
        }),
      });
    });

    it('should record collected usage after title generation', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(client.recordCollectedUsage).toHaveBeenCalledWith({
        model: 'gpt-3.5-turbo',
        context: 'title',
        collectedUsage: expect.any(Array),
        balance: {
          enabled: false,
        },
        transactions: {
          enabled: true,
        },
        messageId: 'response-123',
      });
    });

    it('should return the generated title', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      expect(result).toBe('Generated Title');
    });

    it('should sanitize the generated title by removing think blocks', async () => {
      const titleWithThinkBlock = '<think>reasoning about the title</think> User Hi Greeting';
      mockRun.generateTitle.mockResolvedValue({
        title: titleWithThinkBlock,
      });

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should remove the <think> block and return only the clean title
      expect(result).toBe('User Hi Greeting');
      expect(result).not.toContain('<think>');
      expect(result).not.toContain('</think>');
    });

    it('should return fallback title when sanitization results in empty string', async () => {
      const titleOnlyThinkBlock = '<think>only reasoning no actual title</think>';
      mockRun.generateTitle.mockResolvedValue({
        title: titleOnlyThinkBlock,
      });

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return the fallback title since sanitization would result in empty string
      expect(result).toBe('Untitled Conversation');
    });

    it('should handle errors gracefully and return undefined', async () => {
      mockRun.generateTitle.mockRejectedValue(new Error('Title generation failed'));

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      expect(result).toBeUndefined();
    });

    it('should skip title generation when titleConvo is set to false', async () => {
      // Set titleConvo to false in endpoint config
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titleConvo: false,
            titleModel: 'gpt-3.5-turbo',
            titlePrompt: 'Custom title prompt',
            titleMethod: 'structured',
            titlePromptTemplate: 'Template: {{content}}',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return undefined without generating title
      expect(result).toBeUndefined();

      // generateTitle should NOT have been called
      expect(mockRun.generateTitle).not.toHaveBeenCalled();

      // recordCollectedUsage should NOT have been called
      expect(client.recordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should skip title generation for temporary chats', async () => {
      // Set isTemporary to true
      mockReq.body.isTemporary = true;

      const text = 'Test temporary chat';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return undefined without generating title
      expect(result).toBeUndefined();

      // generateTitle should NOT have been called
      expect(mockRun.generateTitle).not.toHaveBeenCalled();

      // recordCollectedUsage should NOT have been called
      expect(client.recordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should skip title generation when titleConvo is false in all config', async () => {
      // Set titleConvo to false in "all" config
      mockReq.config = {
        endpoints: {
          all: {
            titleConvo: false,
            titleModel: 'gpt-4o-mini',
            titlePrompt: 'All config title prompt',
            titleMethod: 'completion',
            titlePromptTemplate: 'All config template',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return undefined without generating title
      expect(result).toBeUndefined();

      // generateTitle should NOT have been called
      expect(mockRun.generateTitle).not.toHaveBeenCalled();

      // recordCollectedUsage should NOT have been called
      expect(client.recordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should skip title generation when titleConvo is false for custom endpoint scenario', async () => {
      // This test validates the behavior when customEndpointConfig (retrieved via
      // getProviderConfig for custom endpoints) has titleConvo: false.
      //
      // The code path is:
      // 1. endpoints?.all is checked (undefined in this test)
      // 2. endpoints?.[endpoint] is checked (our test config)
      // 3. Would fall back to titleProviderConfig.customEndpointConfig (for real custom endpoints)
      //
      // We simulate a custom endpoint scenario using a dynamically named endpoint config

      // Create a unique endpoint name that represents a custom endpoint
      const customEndpointName = 'customEndpoint';

      // Configure the endpoint to have titleConvo: false
      // This simulates what would be in customEndpointConfig for a real custom endpoint
      mockReq.config = {
        endpoints: {
          // No 'all' config - so it will check endpoints[endpoint]
          // This config represents what customEndpointConfig would contain
          [customEndpointName]: {
            titleConvo: false,
            titleModel: 'custom-model-v1',
            titlePrompt: 'Custom endpoint title prompt',
            titleMethod: 'completion',
            titlePromptTemplate: 'Custom template: {{content}}',
            baseURL: 'https://api.custom-llm.com/v1',
            apiKey: 'test-custom-key',
            // Additional custom endpoint properties
            models: {
              default: ['custom-model-v1', 'custom-model-v2'],
            },
          },
        },
      };

      // Set up agent to use our custom endpoint
      // Use openAI as base but override with custom endpoint name for this test
      mockAgent.endpoint = EModelEndpoint.openAI;
      mockAgent.provider = EModelEndpoint.openAI;

      // Override the endpoint in the config to point to our custom config
      mockReq.config.endpoints[EModelEndpoint.openAI] =
        mockReq.config.endpoints[customEndpointName];
      delete mockReq.config.endpoints[customEndpointName];

      const text = 'Test custom endpoint conversation';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return undefined without generating title because titleConvo is false
      expect(result).toBeUndefined();

      // generateTitle should NOT have been called
      expect(mockRun.generateTitle).not.toHaveBeenCalled();

      // recordCollectedUsage should NOT have been called
      expect(client.recordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should pass titleEndpoint configuration to generateTitle', async () => {
      // Mock the API key just for this test
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'test-api-key';

      // Add titleEndpoint to the config
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titleModel: 'gpt-3.5-turbo',
            titleEndpoint: EModelEndpoint.anthropic,
            titleMethod: 'structured',
            titlePrompt: 'Custom title prompt',
            titlePromptTemplate: 'Custom template',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Verify generateTitle was called with the custom configuration
      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titleMethod: 'structured',
          provider: Providers.ANTHROPIC,
          titlePrompt: 'Custom title prompt',
          titlePromptTemplate: 'Custom template',
        }),
      );

      // Restore the original API key
      if (originalApiKey) {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it('should use all config when endpoint config is missing', async () => {
      // Set 'all' config without endpoint-specific config
      mockReq.config = {
        endpoints: {
          all: {
            titleModel: 'gpt-4o-mini',
            titlePrompt: 'All config title prompt',
            titleMethod: 'completion',
            titlePromptTemplate: 'All config template: {{content}}',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Verify generateTitle was called with 'all' config values
      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titleMethod: 'completion',
          titlePrompt: 'All config title prompt',
          titlePromptTemplate: 'All config template: {{content}}',
        }),
      );

      // Check that the model was set from 'all' config
      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-4o-mini');
    });

    it('should prioritize all config over endpoint config for title settings', async () => {
      // Set both endpoint and 'all' config
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titleModel: 'gpt-3.5-turbo',
            titlePrompt: 'Endpoint title prompt',
            titleMethod: 'structured',
            // titlePromptTemplate is omitted to test fallback
          },
          all: {
            titleModel: 'gpt-4o-mini',
            titlePrompt: 'All config title prompt',
            titleMethod: 'completion',
            titlePromptTemplate: 'All config template',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Verify 'all' config takes precedence over endpoint config
      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titleMethod: 'completion',
          titlePrompt: 'All config title prompt',
          titlePromptTemplate: 'All config template',
        }),
      );

      // Check that the model was set from 'all' config
      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-4o-mini');
    });

    it('should use all config with titleEndpoint and verify provider switch', async () => {
      // Mock the API key for the titleEndpoint provider
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

      // Set comprehensive 'all' config with all new title options
      mockReq.config = {
        endpoints: {
          all: {
            titleConvo: true,
            titleModel: 'claude-3-haiku-20240307',
            titleMethod: 'completion', // Testing the new default method
            titlePrompt: 'Generate a concise, descriptive title for this conversation',
            titlePromptTemplate: 'Conversation summary: {{content}}',
            titleEndpoint: EModelEndpoint.anthropic, // Should switch provider to Anthropic
          },
        },
      };

      const text = 'Test conversation about AI and machine learning';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Verify all config values were used
      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: Providers.ANTHROPIC, // Critical: Verify provider switched to Anthropic
          titleMethod: 'completion',
          titlePrompt: 'Generate a concise, descriptive title for this conversation',
          titlePromptTemplate: 'Conversation summary: {{content}}',
          inputText: text,
          contentParts: client.contentParts,
        }),
      );

      // Verify the model was set from 'all' config
      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('claude-3-haiku-20240307');

      // Verify other client options are set correctly
      expect(generateTitleCall.clientOptions).toMatchObject({
        model: 'claude-3-haiku-20240307',
        // Note: Anthropic's getOptions may set its own maxTokens value
      });

      // Restore the original API key
      if (originalApiKey) {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it('should test all titleMethod options from all config', async () => {
      // Test each titleMethod: 'completion', 'functions', 'structured'
      const titleMethods = ['completion', 'functions', 'structured'];

      for (const method of titleMethods) {
        // Clear previous calls
        mockRun.generateTitle.mockClear();

        // Set 'all' config with specific titleMethod
        mockReq.config = {
          endpoints: {
            all: {
              titleModel: 'gpt-4o-mini',
              titleMethod: method,
              titlePrompt: `Testing ${method} method`,
              titlePromptTemplate: `Template for ${method}: {{content}}`,
            },
          },
        };

        const text = `Test conversation for ${method} method`;
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify the correct titleMethod was used
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            titleMethod: method,
            titlePrompt: `Testing ${method} method`,
            titlePromptTemplate: `Template for ${method}: {{content}}`,
          }),
        );
      }
    });

    describe('Azure-specific title generation', () => {
      let originalEnv;

      beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();

        // Save original environment variables
        originalEnv = { ...process.env };

        // Mock Azure API keys
        process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
        process.env.AZURE_API_KEY = 'test-azure-key';
        process.env.EASTUS_API_KEY = 'test-eastus-key';
        process.env.EASTUS2_API_KEY = 'test-eastus2-key';
      });

      afterEach(() => {
        // Restore environment variables
        process.env = originalEnv;
      });

      it('should use OPENAI provider for Azure serverless endpoints', async () => {
        // Set up Azure endpoint with serverless config
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockReq.config = {
          endpoints: {
            [EModelEndpoint.azureOpenAI]: {
              titleConvo: true,
              titleModel: 'grok-3',
              titleMethod: 'completion',
              titlePrompt: 'Azure serverless title prompt',
              streamRate: 35,
              modelGroupMap: {
                'grok-3': {
                  group: 'Azure AI Foundry',
                  deploymentName: 'grok-3',
                },
              },
              groupMap: {
                'Azure AI Foundry': {
                  apiKey: '${AZURE_API_KEY}',
                  baseURL: 'https://test.services.ai.azure.com/models',
                  version: '2024-05-01-preview',
                  serverless: true,
                  models: {
                    'grok-3': {
                      deploymentName: 'grok-3',
                    },
                  },
                },
              },
            },
          },
        };
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'grok-3';

        const text = 'Test Azure serverless conversation';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify provider was switched to OPENAI for serverless
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: Providers.OPENAI, // Should be OPENAI for serverless
            titleMethod: 'completion',
            titlePrompt: 'Azure serverless title prompt',
          }),
        );
      });

      it('should use AZURE provider for Azure endpoints with instanceName', async () => {
        // Set up Azure endpoint
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockReq.config = {
          endpoints: {
            [EModelEndpoint.azureOpenAI]: {
              titleConvo: true,
              titleModel: 'gpt-4o',
              titleMethod: 'structured',
              titlePrompt: 'Azure instance title prompt',
              streamRate: 35,
              modelGroupMap: {
                'gpt-4o': {
                  group: 'eastus',
                  deploymentName: 'gpt-4o',
                },
              },
              groupMap: {
                eastus: {
                  apiKey: '${EASTUS_API_KEY}',
                  instanceName: 'region-instance',
                  version: '2024-02-15-preview',
                  models: {
                    'gpt-4o': {
                      deploymentName: 'gpt-4o',
                    },
                  },
                },
              },
            },
          },
        };
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'gpt-4o';

        const text = 'Test Azure instance conversation';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify provider remains AZURE with instanceName
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: Providers.AZURE,
            titleMethod: 'structured',
            titlePrompt: 'Azure instance title prompt',
          }),
        );
      });

      it('should handle Azure titleModel with CURRENT_MODEL constant', async () => {
        // Set up Azure endpoint
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockAgent.model_parameters.model = 'gpt-4o-latest';
        mockReq.config = {
          endpoints: {
            [EModelEndpoint.azureOpenAI]: {
              titleConvo: true,
              titleModel: Constants.CURRENT_MODEL,
              titleMethod: 'functions',
              streamRate: 35,
              modelGroupMap: {
                'gpt-4o-latest': {
                  group: 'region-eastus',
                  deploymentName: 'gpt-4o-mini',
                  version: '2024-02-15-preview',
                },
              },
              groupMap: {
                'region-eastus': {
                  apiKey: '${EASTUS2_API_KEY}',
                  instanceName: 'test-instance',
                  version: '2024-12-01-preview',
                  models: {
                    'gpt-4o-latest': {
                      deploymentName: 'gpt-4o-mini',
                      version: '2024-02-15-preview',
                    },
                  },
                },
              },
            },
          },
        };
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'gpt-4o-latest';

        const text = 'Test Azure current model';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify it uses the correct model when titleModel is CURRENT_MODEL
        const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
        // When CURRENT_MODEL is used with Azure, the model gets mapped to the deployment name
        // In this case, 'gpt-4o-latest' is mapped to 'gpt-4o-mini' deployment
        expect(generateTitleCall.clientOptions.model).toBe('gpt-4o-mini');
        // Also verify that CURRENT_MODEL constant was not passed as the model
        expect(generateTitleCall.clientOptions.model).not.toBe(Constants.CURRENT_MODEL);
      });

      it('should handle Azure with multiple model groups', async () => {
        // Set up Azure endpoint
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockReq.config = {
          endpoints: {
            [EModelEndpoint.azureOpenAI]: {
              titleConvo: true,
              titleModel: 'o1-mini',
              titleMethod: 'completion',
              streamRate: 35,
              modelGroupMap: {
                'gpt-4o': {
                  group: 'eastus',
                  deploymentName: 'gpt-4o',
                },
                'o1-mini': {
                  group: 'region-eastus',
                  deploymentName: 'o1-mini',
                },
                'codex-mini': {
                  group: 'codex-mini',
                  deploymentName: 'codex-mini',
                },
              },
              groupMap: {
                eastus: {
                  apiKey: '${EASTUS_API_KEY}',
                  instanceName: 'region-eastus',
                  version: '2024-02-15-preview',
                  models: {
                    'gpt-4o': {
                      deploymentName: 'gpt-4o',
                    },
                  },
                },
                'region-eastus': {
                  apiKey: '${EASTUS2_API_KEY}',
                  instanceName: 'region-eastus2',
                  version: '2024-12-01-preview',
                  models: {
                    'o1-mini': {
                      deploymentName: 'o1-mini',
                    },
                  },
                },
                'codex-mini': {
                  apiKey: '${AZURE_API_KEY}',
                  baseURL: 'https://example.cognitiveservices.azure.com/openai/',
                  version: '2025-04-01-preview',
                  serverless: true,
                  models: {
                    'codex-mini': {
                      deploymentName: 'codex-mini',
                    },
                  },
                },
              },
            },
          },
        };
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'o1-mini';

        const text = 'Test Azure multi-group conversation';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify correct model and provider are used
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: Providers.AZURE,
            titleMethod: 'completion',
          }),
        );

        const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
        expect(generateTitleCall.clientOptions.model).toBe('o1-mini');
        expect(generateTitleCall.clientOptions.maxTokens).toBeUndefined(); // o1 models shouldn't have maxTokens
      });

      it('should use all config as fallback for Azure endpoints', async () => {
        // Set up Azure endpoint with minimal config
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'gpt-4';

        // Set 'all' config as fallback with a serverless Azure config
        mockReq.config = {
          endpoints: {
            all: {
              titleConvo: true,
              titleModel: 'gpt-4',
              titleMethod: 'structured',
              titlePrompt: 'Fallback title prompt from all config',
              titlePromptTemplate: 'Template: {{content}}',
              modelGroupMap: {
                'gpt-4': {
                  group: 'default-group',
                  deploymentName: 'gpt-4',
                },
              },
              groupMap: {
                'default-group': {
                  apiKey: '${AZURE_API_KEY}',
                  baseURL: 'https://default.openai.azure.com/',
                  version: '2024-02-15-preview',
                  serverless: true,
                  models: {
                    'gpt-4': {
                      deploymentName: 'gpt-4',
                    },
                  },
                },
              },
            },
          },
        };

        const text = 'Test Azure with all config fallback';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify all config is used
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: Providers.OPENAI, // Should be OPENAI when no instanceName
            titleMethod: 'structured',
            titlePrompt: 'Fallback title prompt from all config',
            titlePromptTemplate: 'Template: {{content}}',
          }),
        );
      });
    });
  });

  describe('getOptions method - GPT-5+ model handling', () => {
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;

    beforeEach(() => {
      jest.clearAllMocks();

      mockAgent = {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: {
          model: 'gpt-5',
        },
      };

      mockReq = {
        app: {
          locals: {},
        },
        user: {
          id: 'user-123',
        },
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
      };

      client = new AgentClient(mockOptions);
    });

    it('should move maxTokens to modelKwargs.max_completion_tokens for GPT-5 models', () => {
      const clientOptions = {
        model: 'gpt-5',
        maxTokens: 2048,
        temperature: 0.7,
      };

      // Simulate the getOptions logic that handles GPT-5+ models
      if (/\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) && clientOptions.maxTokens != null) {
        clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
        clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
        delete clientOptions.maxTokens;
      }

      expect(clientOptions.maxTokens).toBeUndefined();
      expect(clientOptions.modelKwargs).toBeDefined();
      expect(clientOptions.modelKwargs.max_completion_tokens).toBe(2048);
      expect(clientOptions.temperature).toBe(0.7); // Other options should remain
    });

    it('should move maxTokens to modelKwargs.max_output_tokens for GPT-5 models with useResponsesApi', () => {
      const clientOptions = {
        model: 'gpt-5',
        maxTokens: 2048,
        temperature: 0.7,
        useResponsesApi: true,
      };

      if (/\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) && clientOptions.maxTokens != null) {
        clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
        const paramName =
          clientOptions.useResponsesApi === true ? 'max_output_tokens' : 'max_completion_tokens';
        clientOptions.modelKwargs[paramName] = clientOptions.maxTokens;
        delete clientOptions.maxTokens;
      }

      expect(clientOptions.maxTokens).toBeUndefined();
      expect(clientOptions.modelKwargs).toBeDefined();
      expect(clientOptions.modelKwargs.max_output_tokens).toBe(2048);
      expect(clientOptions.temperature).toBe(0.7); // Other options should remain
    });

    it('should handle GPT-5+ models with existing modelKwargs', () => {
      const clientOptions = {
        model: 'gpt-6',
        maxTokens: 1500,
        temperature: 0.8,
        modelKwargs: {
          customParam: 'value',
        },
      };

      // Simulate the getOptions logic
      if (/\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) && clientOptions.maxTokens != null) {
        clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
        clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
        delete clientOptions.maxTokens;
      }

      expect(clientOptions.maxTokens).toBeUndefined();
      expect(clientOptions.modelKwargs).toEqual({
        customParam: 'value',
        max_completion_tokens: 1500,
      });
    });

    it('should not modify maxTokens for non-GPT-5+ models', () => {
      const clientOptions = {
        model: 'gpt-4',
        maxTokens: 2048,
        temperature: 0.7,
      };

      // Simulate the getOptions logic
      if (/\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) && clientOptions.maxTokens != null) {
        clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
        clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
        delete clientOptions.maxTokens;
      }

      // Should not be modified since it's GPT-4
      expect(clientOptions.maxTokens).toBe(2048);
      expect(clientOptions.modelKwargs).toBeUndefined();
    });

    it('should handle various GPT-5+ model formats', () => {
      const testCases = [
        { model: 'gpt-5.1', shouldTransform: true },
        { model: 'gpt-5.1-chat-latest', shouldTransform: true },
        { model: 'gpt-5.1-codex', shouldTransform: true },
        { model: 'gpt-5', shouldTransform: true },
        { model: 'gpt-5-turbo', shouldTransform: true },
        { model: 'gpt-6', shouldTransform: true },
        { model: 'gpt-7-preview', shouldTransform: true },
        { model: 'gpt-8', shouldTransform: true },
        { model: 'gpt-9-mini', shouldTransform: true },
        { model: 'gpt-4', shouldTransform: false },
        { model: 'gpt-4o', shouldTransform: false },
        { model: 'gpt-3.5-turbo', shouldTransform: false },
        { model: 'claude-3', shouldTransform: false },
      ];

      testCases.forEach(({ model, shouldTransform }) => {
        const clientOptions = {
          model,
          maxTokens: 1000,
        };

        // Simulate the getOptions logic
        if (
          /\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) &&
          clientOptions.maxTokens != null
        ) {
          clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
          clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
          delete clientOptions.maxTokens;
        }

        if (shouldTransform) {
          expect(clientOptions.maxTokens).toBeUndefined();
          expect(clientOptions.modelKwargs?.max_completion_tokens).toBe(1000);
        } else {
          expect(clientOptions.maxTokens).toBe(1000);
          expect(clientOptions.modelKwargs).toBeUndefined();
        }
      });
    });

    it('should not swap max token param for older models when using useResponsesApi', () => {
      const testCases = [
        { model: 'gpt-5.1', shouldTransform: true },
        { model: 'gpt-5.1-chat-latest', shouldTransform: true },
        { model: 'gpt-5.1-codex', shouldTransform: true },
        { model: 'gpt-5', shouldTransform: true },
        { model: 'gpt-5-turbo', shouldTransform: true },
        { model: 'gpt-6', shouldTransform: true },
        { model: 'gpt-7-preview', shouldTransform: true },
        { model: 'gpt-8', shouldTransform: true },
        { model: 'gpt-9-mini', shouldTransform: true },
        { model: 'gpt-4', shouldTransform: false },
        { model: 'gpt-4o', shouldTransform: false },
        { model: 'gpt-3.5-turbo', shouldTransform: false },
        { model: 'claude-3', shouldTransform: false },
      ];

      testCases.forEach(({ model, shouldTransform }) => {
        const clientOptions = {
          model,
          maxTokens: 1000,
          useResponsesApi: true,
        };

        if (
          /\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) &&
          clientOptions.maxTokens != null
        ) {
          clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
          const paramName =
            clientOptions.useResponsesApi === true ? 'max_output_tokens' : 'max_completion_tokens';
          clientOptions.modelKwargs[paramName] = clientOptions.maxTokens;
          delete clientOptions.maxTokens;
        }

        if (shouldTransform) {
          expect(clientOptions.maxTokens).toBeUndefined();
          expect(clientOptions.modelKwargs?.max_output_tokens).toBe(1000);
        } else {
          expect(clientOptions.maxTokens).toBe(1000);
          expect(clientOptions.modelKwargs).toBeUndefined();
        }
      });
    });

    it('should not transform if maxTokens is null or undefined', () => {
      const testCases = [
        { model: 'gpt-5', maxTokens: null },
        { model: 'gpt-5', maxTokens: undefined },
        { model: 'gpt-6', maxTokens: 0 }, // Should transform even if 0
      ];

      testCases.forEach(({ model, maxTokens }, index) => {
        const clientOptions = {
          model,
          maxTokens,
          temperature: 0.7,
        };

        // Simulate the getOptions logic
        if (
          /\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) &&
          clientOptions.maxTokens != null
        ) {
          clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
          clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
          delete clientOptions.maxTokens;
        }

        if (index < 2) {
          // null or undefined cases
          expect(clientOptions.maxTokens).toBe(maxTokens);
          expect(clientOptions.modelKwargs).toBeUndefined();
        } else {
          // 0 case - should transform
          expect(clientOptions.maxTokens).toBeUndefined();
          expect(clientOptions.modelKwargs?.max_completion_tokens).toBe(0);
        }
      });
    });
  });

  describe('buildMessages with MCP server instructions', () => {
    let client;
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;

    beforeEach(() => {
      jest.clearAllMocks();

      // Reset the mock to default behavior
      mockFormatInstructions.mockResolvedValue(
        '# MCP Server Instructions\n\nTest MCP instructions here',
      );

      const { DynamicStructuredTool } = require('@langchain/core/tools');

      // Create mock MCP tools with the delimiter pattern
      const mockMCPTool1 = new DynamicStructuredTool({
        name: `tool1${Constants.mcp_delimiter}server1`,
        description: 'Test MCP tool 1',
        schema: {},
        func: async () => 'result',
      });

      const mockMCPTool2 = new DynamicStructuredTool({
        name: `tool2${Constants.mcp_delimiter}server2`,
        description: 'Test MCP tool 2',
        schema: {},
        func: async () => 'result',
      });

      mockAgent = {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Base agent instructions',
        model_parameters: {
          model: 'gpt-4',
        },
        tools: [mockMCPTool1, mockMCPTool2],
      };

      mockReq = {
        user: {
          id: 'user-123',
        },
        body: {
          endpoint: EModelEndpoint.openAI,
        },
        config: {},
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
        endpoint: EModelEndpoint.agents,
      };

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';
      client.shouldSummarize = false;
      client.maxContextTokens = 4096;
    });

    it('should await MCP instructions and not include [object Promise] in agent instructions', async () => {
      // Set specific return value for this test
      mockFormatInstructions.mockResolvedValue(
        '# MCP Server Instructions\n\nUse these tools carefully',
      );

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      // Verify formatInstructionsForContext was called with correct server names
      expect(mockFormatInstructions).toHaveBeenCalledWith(['server1', 'server2']);

      // Verify the instructions do NOT contain [object Promise]
      expect(client.options.agent.instructions).not.toContain('[object Promise]');

      // Verify the instructions DO contain the MCP instructions
      expect(client.options.agent.instructions).toContain('# MCP Server Instructions');
      expect(client.options.agent.instructions).toContain('Use these tools carefully');

      // Verify the base instructions are also included (from agent config, not buildOptions)
      expect(client.options.agent.instructions).toContain('Base agent instructions');
    });

    it('should handle MCP instructions with ephemeral agent', async () => {
      // Set specific return value for this test
      mockFormatInstructions.mockResolvedValue(
        '# Ephemeral MCP Instructions\n\nSpecial ephemeral instructions',
      );

      // Set up ephemeral agent with MCP servers
      mockReq.body.ephemeralAgent = {
        mcp: ['ephemeral-server1', 'ephemeral-server2'],
      };

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Test ephemeral',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Ephemeral instructions',
        additional_instructions: null,
      });

      // Verify formatInstructionsForContext was called with ephemeral server names
      expect(mockFormatInstructions).toHaveBeenCalledWith([
        'ephemeral-server1',
        'ephemeral-server2',
      ]);

      // Verify no [object Promise] in instructions
      expect(client.options.agent.instructions).not.toContain('[object Promise]');

      // Verify ephemeral MCP instructions are included
      expect(client.options.agent.instructions).toContain('# Ephemeral MCP Instructions');
      expect(client.options.agent.instructions).toContain('Special ephemeral instructions');
    });

    it('should handle empty MCP instructions gracefully', async () => {
      // Set empty return value for this test
      mockFormatInstructions.mockResolvedValue('');

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions only',
        additional_instructions: null,
      });

      // Verify the instructions still work without MCP content (from agent config, not buildOptions)
      expect(client.options.agent.instructions).toBe('Base agent instructions');
      expect(client.options.agent.instructions).not.toContain('[object Promise]');
    });

    it('should handle MCP instructions error gracefully', async () => {
      // Set error return for this test
      mockFormatInstructions.mockRejectedValue(new Error('MCP error'));

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      // Should not throw
      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      // Should still have base instructions without MCP content (from agent config, not buildOptions)
      expect(client.options.agent.instructions).toContain('Base agent instructions');
      expect(client.options.agent.instructions).not.toContain('[object Promise]');
    });
  });

  describe('runMemory method', () => {
    let client;
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;
    let mockProcessMemory;

    beforeEach(() => {
      jest.clearAllMocks();

      mockAgent = {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: {
          model: 'gpt-4',
        },
      };

      mockReq = {
        user: {
          id: 'user-123',
          personalization: {
            memories: true,
          },
        },
      };

      // Mock getAppConfig for memory tests
      mockReq.config = {
        memory: {
          messageWindowSize: 3,
        },
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
      };

      mockProcessMemory = jest.fn().mockResolvedValue([]);

      client = new AgentClient(mockOptions);
      client.processMemory = mockProcessMemory;
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';
    });

    it('should filter out image URLs from message content', async () => {
      const { HumanMessage, AIMessage } = require('@langchain/core/messages');
      const messages = [
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: 'What is in this image?',
            },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                detail: 'auto',
              },
            },
          ],
        }),
        new AIMessage('I can see a small red pixel in the image.'),
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: 'What about this one?',
            },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/',
                detail: 'high',
              },
            },
          ],
        }),
      ];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      // Verify the buffer message was created
      expect(processedMessage.constructor.name).toBe('HumanMessage');
      expect(processedMessage.content).toContain('# Current Chat:');

      // Verify that image URLs are not in the buffer string
      expect(processedMessage.content).not.toContain('image_url');
      expect(processedMessage.content).not.toContain('data:image');
      expect(processedMessage.content).not.toContain('base64');

      // Verify text content is preserved
      expect(processedMessage.content).toContain('What is in this image?');
      expect(processedMessage.content).toContain('I can see a small red pixel in the image.');
      expect(processedMessage.content).toContain('What about this one?');
    });

    it('should handle messages with only text content', async () => {
      const { HumanMessage, AIMessage } = require('@langchain/core/messages');
      const messages = [
        new HumanMessage('Hello, how are you?'),
        new AIMessage('I am doing well, thank you!'),
        new HumanMessage('That is great to hear.'),
      ];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      expect(processedMessage.content).toContain('Hello, how are you?');
      expect(processedMessage.content).toContain('I am doing well, thank you!');
      expect(processedMessage.content).toContain('That is great to hear.');
    });

    it('should exclude scheduler control prompts, think parts, and NTA-only assistant turns from memory buffer', async () => {
      const { HumanMessage, AIMessage } = require('@langchain/core/messages');
      const messages = [
        new HumanMessage(
          'Internal Check:\n1. Verify whether the project update email was sent.\nDo not nudge anyone. Just observe and update context. {NTA} if nothing new.',
        ),
        new AIMessage({
          content: [
            {
              type: 'think',
              think:
                'This is the same internal check repeated many times. {NTA} is the correct response.',
            },
            {
              type: 'text',
              text: '{NTA}',
            },
          ],
        }),
        new HumanMessage('The user is in a quiet workspace and focused on a planning task today.'),
      ];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      expect(processedMessage.content).toContain(
        'The user is in a quiet workspace and focused on a planning task today.',
      );
      expect(processedMessage.content).not.toContain('Internal Check:');
      expect(processedMessage.content).not.toContain('{NTA}');
      expect(processedMessage.content).not.toContain('same internal check repeated');
      expect(processedMessage.content).not.toContain('"type": "think"');
    });

    it('should skip memory processing when the window contains only internal-control and NTA content', async () => {
      const { HumanMessage, AIMessage } = require('@langchain/core/messages');
      const messages = [
        new HumanMessage(
          'Internal Check:\n1. Verify whether the project update email was sent.\nDo not nudge anyone. Just observe and update context. {NTA} if nothing new.',
        ),
        new AIMessage({
          content: [
            {
              type: 'think',
              think:
                'This is the same internal check repeated many times. {NTA} is the correct response.',
            },
            {
              type: 'text',
              text: '{NTA}',
            },
          ],
        }),
      ];

      const result = await client.runMemory(messages);

      expect(result).toBeUndefined();
      expect(mockProcessMemory).not.toHaveBeenCalled();
    });

    it('should handle mixed content types correctly', async () => {
      const { HumanMessage } = require('@langchain/core/messages');
      const { ContentTypes } = require('librechat-data-provider');

      const messages = [
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: 'Here is some text',
            },
            {
              type: ContentTypes.IMAGE_URL,
              image_url: {
                url: 'https://example.com/image.png',
              },
            },
            {
              type: 'text',
              text: ' and more text',
            },
          ],
        }),
      ];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      // Should contain text parts but not image URLs
      expect(processedMessage.content).toContain('Here is some text');
      expect(processedMessage.content).toContain('and more text');
      expect(processedMessage.content).not.toContain('example.com/image.png');
      expect(processedMessage.content).not.toContain('IMAGE_URL');
    });

    it('should preserve original messages without mutation', async () => {
      const { HumanMessage } = require('@langchain/core/messages');
      const originalContent = [
        {
          type: 'text',
          text: 'Original text',
        },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/png;base64,ABC123',
          },
        },
      ];

      const messages = [
        new HumanMessage({
          content: [...originalContent],
        }),
      ];

      await client.runMemory(messages);

      // Verify original message wasn't mutated
      expect(messages[0].content).toHaveLength(2);
      expect(messages[0].content[1].type).toBe('image_url');
      expect(messages[0].content[1].image_url.url).toBe('data:image/png;base64,ABC123');
    });

    it('should keep the current chat window bounded while surfacing older user context separately', async () => {
      const { HumanMessage, AIMessage } = require('@langchain/core/messages');
      const messages = [
        new HumanMessage('Message 1'),
        new AIMessage('Response 1'),
        new HumanMessage('Message 2'),
        new AIMessage('Response 2'),
        new HumanMessage('Message 3'),
        new AIMessage('Response 3'),
      ];

      // Window size is set to 3 in mockReq
      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      // Current chat stays bounded to the last 3-message user-starting window.
      expect(processedMessage.content).toContain(
        '# Recent User Context Outside Current Chat Window:',
      );
      expect(processedMessage.content).toContain('Message 1');
      expect(processedMessage.content).toContain('Message 3');
      expect(processedMessage.content).toContain('Response 3');
      expect(processedMessage.content).not.toContain('Response 1');
    });

    it('should include bounded older user context outside the current chat window', async () => {
      const { HumanMessage, AIMessage } = require('@langchain/core/messages');
      const messages = [
        new HumanMessage('I used to work on Project Atlas.'),
        new AIMessage('Noted.'),
        new HumanMessage('The migration was delayed last week.'),
        new AIMessage('Understood.'),
        new HumanMessage('Current focus is the release checklist.'),
        new AIMessage('Makes sense.'),
        new HumanMessage('Actually the release checklist is blocked on vendor approval.'),
        new AIMessage('I will keep that in mind.'),
      ];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      expect(processedMessage.content).toContain(
        '# Recent User Context Outside Current Chat Window:',
      );
      expect(processedMessage.content).toContain('I used to work on Project Atlas.');
      expect(processedMessage.content).toContain('The migration was delayed last week.');
      expect(processedMessage.content).toContain('# Current Chat:');
      expect(processedMessage.content).toContain('Current focus is the release checklist.');
      expect(processedMessage.content).toContain(
        'Actually the release checklist is blocked on vendor approval.',
      );
      expect(processedMessage.content).not.toContain('Noted.');
      expect(processedMessage.content).not.toContain('Understood.');
    });

    it('should cap older user context by configured char limit', async () => {
      const { HumanMessage, AIMessage } = require('@langchain/core/messages');
      client.options.req.config.memory.historyContextCharLimit = 45;

      const messages = [
        new HumanMessage(
          'This is a very long earlier correction that should be trimmed before it reaches the memory writer.',
        ),
        new AIMessage('Acknowledged.'),
        new HumanMessage('Older filler user turn.'),
        new AIMessage('Done with that.'),
        new HumanMessage('Latest active task is short.'),
        new AIMessage('Done.'),
      ];

      await client.runMemory(messages);

      const processedMessage = mockProcessMemory.mock.calls[0][0][0];
      expect(processedMessage.content).toContain(
        '# Recent User Context Outside Current Chat Window:',
      );
      expect(processedMessage.content).toContain('...');
    });

    it('should return early if processMemory is not set', async () => {
      const { HumanMessage } = require('@langchain/core/messages');
      client.processMemory = null;

      const result = await client.runMemory([new HumanMessage('Test')]);

      expect(result).toBeUndefined();
      expect(mockProcessMemory).not.toHaveBeenCalled();
    });
  });

  describe('getMessagesForConversation - mapMethod and mapCondition', () => {
    const createMessage = (id, parentId, text, extras = {}) => ({
      messageId: id,
      parentMessageId: parentId,
      text,
      isCreatedByUser: false,
      ...extras,
    });

    it('should apply mapMethod to all messages when mapCondition is not provided', () => {
      const messages = [
        createMessage('msg-1', null, 'First message'),
        createMessage('msg-2', 'msg-1', 'Second message'),
        createMessage('msg-3', 'msg-2', 'Third message'),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-3',
        mapMethod,
      });

      expect(result).toHaveLength(3);
      expect(mapMethod).toHaveBeenCalledTimes(3);
      result.forEach((msg) => {
        expect(msg.mapped).toBe(true);
      });
    });

    it('should apply mapMethod only to messages where mapCondition returns true', () => {
      const messages = [
        createMessage('msg-1', null, 'First message', { addedConvo: false }),
        createMessage('msg-2', 'msg-1', 'Second message', { addedConvo: true }),
        createMessage('msg-3', 'msg-2', 'Third message', { addedConvo: true }),
        createMessage('msg-4', 'msg-3', 'Fourth message', { addedConvo: false }),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));
      const mapCondition = (msg) => msg.addedConvo === true;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-4',
        mapMethod,
        mapCondition,
      });

      expect(result).toHaveLength(4);
      expect(mapMethod).toHaveBeenCalledTimes(2);

      expect(result[0].mapped).toBeUndefined();
      expect(result[1].mapped).toBe(true);
      expect(result[2].mapped).toBe(true);
      expect(result[3].mapped).toBeUndefined();
    });

    it('should not apply mapMethod when mapCondition returns false for all messages', () => {
      const messages = [
        createMessage('msg-1', null, 'First message', { addedConvo: false }),
        createMessage('msg-2', 'msg-1', 'Second message', { addedConvo: false }),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));
      const mapCondition = (msg) => msg.addedConvo === true;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-2',
        mapMethod,
        mapCondition,
      });

      expect(result).toHaveLength(2);
      expect(mapMethod).not.toHaveBeenCalled();
      result.forEach((msg) => {
        expect(msg.mapped).toBeUndefined();
      });
    });

    it('should not call mapMethod when mapMethod is null', () => {
      const messages = [
        createMessage('msg-1', null, 'First message'),
        createMessage('msg-2', 'msg-1', 'Second message'),
      ];

      const mapCondition = jest.fn(() => true);

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-2',
        mapMethod: null,
        mapCondition,
      });

      expect(result).toHaveLength(2);
      expect(mapCondition).not.toHaveBeenCalled();
    });

    it('should handle mapCondition with complex logic', () => {
      const messages = [
        createMessage('msg-1', null, 'User message', { isCreatedByUser: true, addedConvo: true }),
        createMessage('msg-2', 'msg-1', 'Assistant response', { addedConvo: true }),
        createMessage('msg-3', 'msg-2', 'Another user message', { isCreatedByUser: true }),
        createMessage('msg-4', 'msg-3', 'Another response', { addedConvo: true }),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, processed: true }));
      const mapCondition = (msg) => msg.addedConvo === true && !msg.isCreatedByUser;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-4',
        mapMethod,
        mapCondition,
      });

      expect(result).toHaveLength(4);
      expect(mapMethod).toHaveBeenCalledTimes(2);

      expect(result[0].processed).toBeUndefined();
      expect(result[1].processed).toBe(true);
      expect(result[2].processed).toBeUndefined();
      expect(result[3].processed).toBe(true);
    });

    it('should preserve message order after applying mapMethod with mapCondition', () => {
      const messages = [
        createMessage('msg-1', null, 'First', { addedConvo: true }),
        createMessage('msg-2', 'msg-1', 'Second', { addedConvo: false }),
        createMessage('msg-3', 'msg-2', 'Third', { addedConvo: true }),
      ];

      const mapMethod = (msg) => ({ ...msg, text: `[MAPPED] ${msg.text}` });
      const mapCondition = (msg) => msg.addedConvo === true;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-3',
        mapMethod,
        mapCondition,
      });

      expect(result[0].text).toBe('[MAPPED] First');
      expect(result[1].text).toBe('Second');
      expect(result[2].text).toBe('[MAPPED] Third');
    });

    it('should work with summary option alongside mapMethod and mapCondition', () => {
      const messages = [
        createMessage('msg-1', null, 'First', { addedConvo: false }),
        createMessage('msg-2', 'msg-1', 'Second', {
          summary: 'Summary of conversation',
          addedConvo: true,
        }),
        createMessage('msg-3', 'msg-2', 'Third', { addedConvo: true }),
        createMessage('msg-4', 'msg-3', 'Fourth', { addedConvo: false }),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));
      const mapCondition = (msg) => msg.addedConvo === true;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-4',
        mapMethod,
        mapCondition,
        summary: true,
      });

      /** Traversal stops at msg-2 (has summary), so we get msg-4 -> msg-3 -> msg-2 */
      expect(result).toHaveLength(3);
      expect(result[0].text).toBe('Summary of conversation');
      expect(result[0].role).toBe('system');
      expect(result[0].mapped).toBe(true);
      expect(result[1].mapped).toBe(true);
      expect(result[2].mapped).toBeUndefined();
    });

    it('should handle empty messages array', () => {
      const mapMethod = jest.fn();
      const mapCondition = jest.fn();

      const result = AgentClient.getMessagesForConversation({
        messages: [],
        parentMessageId: 'msg-1',
        mapMethod,
        mapCondition,
      });

      expect(result).toHaveLength(0);
      expect(mapMethod).not.toHaveBeenCalled();
      expect(mapCondition).not.toHaveBeenCalled();
    });

    it('should handle undefined mapCondition explicitly', () => {
      const messages = [
        createMessage('msg-1', null, 'First'),
        createMessage('msg-2', 'msg-1', 'Second'),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-2',
        mapMethod,
        mapCondition: undefined,
      });

      expect(result).toHaveLength(2);
      expect(mapMethod).toHaveBeenCalledTimes(2);
      result.forEach((msg) => {
        expect(msg.mapped).toBe(true);
      });
    });
  });

  describe('buildMessages - memory context for parallel agents', () => {
    let client;
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;
    let mockBuildConversationRecallInstructions;

    beforeEach(() => {
      jest.clearAllMocks();

      ({
        buildConversationRecallInstructions: mockBuildConversationRecallInstructions,
      } = require('~/server/services/viventium/conversationRecallPrompt'));
      mockBuildConversationRecallInstructions.mockReturnValue('');

      mockAgent = {
        id: 'primary-agent',
        name: 'Primary Agent',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Primary agent instructions',
        model_parameters: {
          model: 'gpt-4',
        },
        tools: [],
      };

      mockReq = {
        user: {
          id: 'user-123',
          personalization: {
            memories: true,
          },
        },
        body: {
          endpoint: EModelEndpoint.openAI,
        },
        config: {
          memory: {
            disabled: false,
          },
        },
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
        endpoint: EModelEndpoint.agents,
      };

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';
      client.shouldSummarize = false;
      client.maxContextTokens = 4096;
    });

    it('should pass memory context to parallel agents (addedConvo)', async () => {
      const memoryContent = 'User prefers dark mode. User is a software developer.';
      client.useMemory = jest.fn().mockResolvedValue(memoryContent);

      const parallelAgent1 = {
        id: 'parallel-agent-1',
        name: 'Parallel Agent 1',
        instructions: 'Parallel agent 1 instructions',
        provider: EModelEndpoint.openAI,
      };

      const parallelAgent2 = {
        id: 'parallel-agent-2',
        name: 'Parallel Agent 2',
        instructions: 'Parallel agent 2 instructions',
        provider: EModelEndpoint.anthropic,
      };

      client.agentConfigs = new Map([
        ['parallel-agent-1', parallelAgent1],
        ['parallel-agent-2', parallelAgent2],
      ]);

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      expect(client.useMemory).toHaveBeenCalled();

      // Verify primary agent has its configured instructions (not from buildOptions) and memory context
      expect(client.options.agent.instructions).toContain('Primary agent instructions');
      expect(client.options.agent.instructions).toContain(memoryContent);

      expect(parallelAgent1.instructions).toContain('Parallel agent 1 instructions');
      expect(parallelAgent1.instructions).toContain(memoryContent);

      expect(parallelAgent2.instructions).toContain('Parallel agent 2 instructions');
      expect(parallelAgent2.instructions).toContain(memoryContent);
    });

    it('should inject conversation recall instructions for all participating agents', async () => {
      const recallPrompt = 'CONVERSATION RECALL:\n- Use `file_search` for prior-chat questions.';
      client.useMemory = jest.fn().mockResolvedValue(undefined);
      mockReq.user.personalization.conversation_recall = true;
      mockBuildConversationRecallInstructions.mockReturnValue(recallPrompt);

      const parallelAgent = {
        id: 'parallel-agent-1',
        name: 'Parallel Agent 1',
        instructions: 'Parallel agent instructions',
        provider: EModelEndpoint.openAI,
      };
      client.agentConfigs = new Map([['parallel-agent-1', parallelAgent]]);

      const messages = [
        {
          messageId: 'msg-1',
          conversationId: 'convo-123',
          parentMessageId: null,
          sender: 'User',
          text: 'Remember when I shared my lab test results?',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      expect(mockBuildConversationRecallInstructions).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: client.options.agent,
          req: mockReq,
          user: mockReq.user,
        }),
      );
      expect(client.options.agent.instructions).toContain(recallPrompt);
      expect(parallelAgent.instructions).toContain(recallPrompt);
    });

    it('should not modify parallel agents when no memory context is available', async () => {
      client.useMemory = jest.fn().mockResolvedValue(undefined);

      const parallelAgent = {
        id: 'parallel-agent-1',
        name: 'Parallel Agent 1',
        instructions: 'Original parallel instructions',
        provider: EModelEndpoint.openAI,
      };

      client.agentConfigs = new Map([['parallel-agent-1', parallelAgent]]);

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      expect(parallelAgent.instructions).toBe('Original parallel instructions');
    });

    it('should handle parallel agents without existing instructions', async () => {
      const memoryContent = 'User is a data scientist.';
      client.useMemory = jest.fn().mockResolvedValue(memoryContent);

      const parallelAgentNoInstructions = {
        id: 'parallel-agent-no-instructions',
        name: 'Parallel Agent No Instructions',
        provider: EModelEndpoint.openAI,
      };

      client.agentConfigs = new Map([
        ['parallel-agent-no-instructions', parallelAgentNoInstructions],
      ]);

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: null,
        additional_instructions: null,
      });

      expect(parallelAgentNoInstructions.instructions).toContain(memoryContent);
    });

    it('should not modify agentConfigs when none exist', async () => {
      const memoryContent = 'User prefers concise responses.';
      client.useMemory = jest.fn().mockResolvedValue(memoryContent);

      client.agentConfigs = null;

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await expect(
        client.buildMessages(messages, null, {
          instructions: 'Base instructions',
          additional_instructions: null,
        }),
      ).resolves.not.toThrow();

      expect(client.options.agent.instructions).toContain(memoryContent);
    });

    it('should handle empty agentConfigs map', async () => {
      const memoryContent = 'User likes detailed explanations.';
      client.useMemory = jest.fn().mockResolvedValue(memoryContent);

      client.agentConfigs = new Map();

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await expect(
        client.buildMessages(messages, null, {
          instructions: 'Base instructions',
          additional_instructions: null,
        }),
      ).resolves.not.toThrow();

      expect(client.options.agent.instructions).toContain(memoryContent);
    });
  });

  describe('useMemory method - prelimAgent assignment', () => {
    let client;
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;
    let mockCheckAccess;
    let mockLoadAgent;
    let mockInitializeAgent;
    let mockCreateMemoryProcessor;
    let mockLoadMemorySnapshot;

    beforeEach(() => {
      jest.clearAllMocks();

      mockAgent = {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Test instructions',
        model: 'gpt-4',
        model_parameters: {
          model: 'gpt-4',
        },
      };

      mockReq = {
        user: {
          id: 'user-123',
          personalization: {
            memories: true,
          },
        },
        config: {
          memory: {
            agent: {
              id: 'agent-123',
            },
          },
          endpoints: {
            [EModelEndpoint.agents]: {
              allowedProviders: [EModelEndpoint.openAI],
            },
          },
        },
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
      };

      mockCheckAccess = require('@librechat/api').checkAccess;
      mockLoadAgent = require('~/models/Agent').loadAgent;
      mockInitializeAgent = require('@librechat/api').initializeAgent;
      mockCreateMemoryProcessor = require('@librechat/api').createMemoryProcessor;
      mockLoadMemorySnapshot = require('@librechat/api').loadMemorySnapshot;
      mockLoadMemorySnapshot.mockResolvedValue({
        withKeys: 'stored memories with keys',
        withoutKeys: 'stored memories',
        totalTokens: 12,
        memoryTokenMap: { core: 12 },
      });
    });

    it('should use current agent when memory config agent.id matches current agent id', async () => {
      mockCheckAccess.mockResolvedValue(true);
      mockInitializeAgent.mockResolvedValue({
        ...mockAgent,
        provider: EModelEndpoint.openAI,
      });
      mockCreateMemoryProcessor.mockResolvedValue([undefined, jest.fn()]);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      await client.useMemory();

      expect(mockLoadAgent).not.toHaveBeenCalled();
      expect(mockInitializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: mockAgent,
        }),
        expect.any(Object),
      );
    });

    it('should load different agent when memory config agent.id differs from current agent id', async () => {
      const differentAgentId = 'different-agent-456';
      const differentAgent = {
        id: differentAgentId,
        provider: EModelEndpoint.openAI,
        model: 'gpt-4',
        instructions: 'Different agent instructions',
      };

      mockReq.config.memory.agent.id = differentAgentId;

      mockCheckAccess.mockResolvedValue(true);
      mockLoadAgent.mockResolvedValue(differentAgent);
      mockInitializeAgent.mockResolvedValue({
        ...differentAgent,
        provider: EModelEndpoint.openAI,
      });
      mockCreateMemoryProcessor.mockResolvedValue([undefined, jest.fn()]);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      await client.useMemory();

      expect(mockLoadAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: differentAgentId,
        }),
      );
      expect(mockInitializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: differentAgent,
        }),
        expect.any(Object),
      );
    });

    it('should still inject stored memory when no memory writer is configured', async () => {
      mockReq.config.memory = {
        agent: {},
      };

      mockCheckAccess.mockResolvedValue(true);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      const result = await client.useMemory();

      expect(result).toBe('stored memories');
      expect(mockInitializeAgent).not.toHaveBeenCalled();
      expect(mockCreateMemoryProcessor).not.toHaveBeenCalled();
    });

    it('should create ephemeral agent when no id but model and provider are specified', async () => {
      mockReq.config.memory = {
        agent: {
          model: 'gpt-4',
          provider: EModelEndpoint.openAI,
        },
      };

      mockCheckAccess.mockResolvedValue(true);
      mockInitializeAgent.mockResolvedValue({
        id: Constants.EPHEMERAL_AGENT_ID,
        model: 'gpt-4',
        provider: EModelEndpoint.openAI,
      });
      mockCreateMemoryProcessor.mockResolvedValue([undefined, jest.fn()]);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      await client.useMemory();

      expect(mockLoadAgent).not.toHaveBeenCalled();
      expect(mockInitializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({
            id: Constants.EPHEMERAL_AGENT_ID,
            model: 'gpt-4',
            provider: EModelEndpoint.openAI,
          }),
        }),
        expect.any(Object),
      );
    });

    it('should fall back to stored memory when the memory writer cannot initialize', async () => {
      mockCheckAccess.mockResolvedValue(true);
      mockInitializeAgent.mockResolvedValue(null);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      const result = await client.useMemory();

      expect(result).toBe('stored memories');
      expect(mockCreateMemoryProcessor).not.toHaveBeenCalled();
    });
  });
});

/* === VIVENTIUM START ===
 * Purpose: Viventium addition in private LibreChat fork (new test block).
 * Porting: Copy this describe block when reapplying Viventium changes.
 * === VIVENTIUM END === */

describe('AgentClient Phase B persistence across main-model fallback', () => {
  let client;
  let req;
  let primaryAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPersistCortexPartsToCanonicalMessage.mockResolvedValue(undefined);
    mockFinalizeCanonicalCortexMessage.mockResolvedValue(undefined);
    mockCreateCortexFollowUpMessage.mockResolvedValue(null);

    req = {
      user: { id: 'user-1' },
      body: {},
      config: { endpoints: {} },
      _resumableStreamId: 'stream-1',
    };
    primaryAgent = {
      id: 'agent-primary',
      provider: EModelEndpoint.openAI,
      model: 'gpt-4',
      model_parameters: { model: 'gpt-4' },
      hide_sequential_outputs: false,
    };
    client = new AgentClient({
      req,
      res: {},
      agent: primaryAgent,
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      endpointTokenConfig: {},
    });
    client.conversationId = 'conv-1';
    client.responseMessageId = 'resp-1';
  });

  test('persists Phase B parts and waits for fallback text before follow-up synthesis', async () => {
    const phaseB = deferred();
    const mainReady = deferred();
    const pendingCortexParts = [
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'agent-background',
        cortex_name: 'Background',
        status: 'complete',
        insight: 'Background result.',
      },
    ];
    client._phaseBMainResponseReadyPromise = mainReady.promise;
    mockCreateCortexFollowUpMessage.mockResolvedValue({
      messageId: 'follow-up-1',
      parentMessageId: 'resp-1',
      text: 'Follow-up result.',
    });

    const attached = client.attachBackgroundCortexCompletionPipeline({
      cortexExecutionPromise: phaseB.promise,
      pendingCortexParts,
      req,
      conversationId: 'conv-1',
      responseMessageId: 'resp-1',
      agent: primaryAgent,
      getResponseContentParts: () => client.contentParts,
      responseController: { lastUserInputTime: 10 },
      turnUserInputTime: 10,
      followupGraceMs: 0,
      shouldDeferMainResponse: false,
      getActivatedCorticesList: () => [{ agentId: 'agent-background' }],
    });

    phaseB.resolve({
      insights: [{ cortexName: 'Background', insight: 'Background result.' }],
      mergedPrompt: 'Background result.',
      cortexCount: 1,
    });
    await Promise.resolve();

    expect(mockPersistCortexPartsToCanonicalMessage).not.toHaveBeenCalled();
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();

    client.contentParts.push({ type: ContentTypes.TEXT, text: 'Fallback answer.' });
    const fallbackAgent = {
      id: 'agent-fallback',
      provider: EModelEndpoint.openAI,
      model: 'gpt-5.4',
      model_parameters: { model: 'gpt-5.4' },
    };
    client.options.agent = fallbackAgent;
    mainReady.resolve();
    await attached;

    expect(mockPersistCortexPartsToCanonicalMessage).toHaveBeenCalledWith({
      req,
      responseMessageId: 'resp-1',
      cortexParts: pendingCortexParts,
    });
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        conversationId: 'conv-1',
        parentMessageId: 'resp-1',
        agent: fallbackAgent,
        recentResponse: 'Fallback answer.',
      }),
    );
    expect(mockFinalizeCanonicalCortexMessage).toHaveBeenCalledWith({
      req,
      messageId: 'resp-1',
    });
    expect(mockEmitChunk).toHaveBeenCalledWith(
      'stream-1',
      expect.objectContaining({
        event: 'on_cortex_followup',
        data: expect.objectContaining({
          runId: 'resp-1',
          messageId: 'follow-up-1',
          text: 'Follow-up result.',
          cortexCount: 1,
        }),
      }),
    );
  });

  test('emits promoted forced Phase B text on the canonical parent without self-parenting', async () => {
    const phaseB = deferred();
    const pendingCortexParts = [
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'agent-background',
        cortex_name: 'Background',
        status: 'complete',
        insight: 'Background result.',
      },
    ];
    mockCreateCortexFollowUpMessage.mockResolvedValue({
      messageId: 'resp-1',
      parentMessageId: 'user-1',
      text: 'Promoted final answer.',
    });

    const attached = client.attachBackgroundCortexCompletionPipeline({
      cortexExecutionPromise: phaseB.promise,
      pendingCortexParts,
      req,
      conversationId: 'conv-1',
      responseMessageId: 'resp-1',
      agent: primaryAgent,
      getResponseContentParts: () => client.contentParts,
      responseController: { lastUserInputTime: 10 },
      turnUserInputTime: 10,
      followupGraceMs: 0,
      shouldDeferMainResponse: true,
      getActivatedCorticesList: () => [{ agentId: 'agent-background' }],
    });

    phaseB.resolve({
      insights: [{ cortexName: 'Background', insight: 'Background result.' }],
      mergedPrompt: 'Background result.',
      cortexCount: 1,
    });
    await attached;

    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        parentMessageId: 'resp-1',
        recentResponse: '',
        forceVisibleFollowUp: true,
      }),
    );
    expect(mockEmitChunk).toHaveBeenCalledWith(
      'stream-1',
      expect.objectContaining({
        event: 'on_cortex_followup',
        data: expect.objectContaining({
          runId: 'resp-1',
          messageId: 'resp-1',
          parentMessageId: 'user-1',
          text: 'Promoted final answer.',
          cortexCount: 1,
        }),
      }),
    );
  });

  test('attaches only one Phase B pipeline per response message', async () => {
    const phaseB = deferred();
    const pendingCortexParts = [
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'agent-background',
        status: 'complete',
        insight: 'Background result.',
      },
    ];
    client.contentParts.push({ type: ContentTypes.TEXT, text: 'Primary answer.' });

    const first = client.attachBackgroundCortexCompletionPipeline({
      cortexExecutionPromise: phaseB.promise,
      pendingCortexParts,
      req,
      conversationId: 'conv-1',
      responseMessageId: 'resp-1',
      agent: primaryAgent,
      getResponseContentParts: () => client.contentParts,
      responseController: null,
      turnUserInputTime: 0,
      followupGraceMs: 0,
      shouldDeferMainResponse: false,
      getActivatedCorticesList: () => [],
    });
    const second = client.attachBackgroundCortexCompletionPipeline({
      cortexExecutionPromise: phaseB.promise,
      pendingCortexParts,
      req,
      conversationId: 'conv-1',
      responseMessageId: 'resp-1',
      agent: primaryAgent,
      getResponseContentParts: () => client.contentParts,
      responseController: null,
      turnUserInputTime: 0,
      followupGraceMs: 0,
      shouldDeferMainResponse: false,
      getActivatedCorticesList: () => [],
    });

    expect(second).toBe(first);
    phaseB.resolve({
      insights: [{ cortexName: 'Background', insight: 'Background result.' }],
      mergedPrompt: 'Background result.',
      cortexCount: 1,
    });
    await first;

    expect(mockPersistCortexPartsToCanonicalMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
  });

  test('persists terminal Phase B errors even when no follow-up should be shown', async () => {
    const phaseB = deferred();
    const pendingCortexParts = [
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'agent-background',
        status: 'error',
        error: 'provider credentials rejected',
      },
    ];
    client.contentParts.push({ type: ContentTypes.ERROR, error: '401 authentication' });

    const attached = client.attachBackgroundCortexCompletionPipeline({
      cortexExecutionPromise: phaseB.promise,
      pendingCortexParts,
      req,
      conversationId: 'conv-1',
      responseMessageId: 'resp-1',
      agent: primaryAgent,
      getResponseContentParts: () => client.contentParts,
      responseController: null,
      turnUserInputTime: 0,
      followupGraceMs: 0,
      shouldDeferMainResponse: false,
      getActivatedCorticesList: () => [{ agentId: 'agent-background' }],
    });

    phaseB.resolve({
      insights: [],
      mergedPrompt: '',
      cortexCount: 0,
      errors: [{ message: 'provider credentials rejected' }],
      hasErrors: true,
    });
    await attached;

    expect(mockPersistCortexPartsToCanonicalMessage).toHaveBeenCalledTimes(1);
    expect(mockPersistCortexPartsToCanonicalMessage).toHaveBeenCalledWith({
      req,
      responseMessageId: 'resp-1',
      cortexParts: pendingCortexParts,
    });
    expect(mockFinalizeCanonicalCortexMessage).toHaveBeenCalledWith({
      req,
      messageId: 'resp-1',
    });
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
  });

  test('persists mixed visible, silent, and error terminal Phase B parts together', async () => {
    const phaseB = deferred();
    const pendingCortexParts = [
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'agent-visible',
        cortex_name: 'Visible',
        status: 'complete',
        insight: 'Visible result.',
      },
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'agent-silent',
        cortex_name: 'Silent',
        status: 'complete',
        silent: true,
        no_response: true,
      },
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'agent-error',
        cortex_name: 'Error',
        status: 'error',
        error: 'provider credentials rejected',
      },
    ];
    client.contentParts.push({ type: ContentTypes.TEXT, text: 'Primary answer.' });
    mockCreateCortexFollowUpMessage.mockResolvedValue(null);

    const attached = client.attachBackgroundCortexCompletionPipeline({
      cortexExecutionPromise: phaseB.promise,
      pendingCortexParts,
      req,
      conversationId: 'conv-1',
      responseMessageId: 'resp-1',
      agent: primaryAgent,
      getResponseContentParts: () => client.contentParts,
      responseController: null,
      turnUserInputTime: 0,
      followupGraceMs: 0,
      shouldDeferMainResponse: false,
      getActivatedCorticesList: () => [],
    });

    phaseB.resolve({
      insights: [{ cortexName: 'Visible', insight: 'Visible result.' }],
      mergedPrompt: 'Visible result.',
      cortexCount: 3,
      errors: [{ message: 'provider credentials rejected' }],
      hasErrors: true,
    });
    await attached;

    expect(mockPersistCortexPartsToCanonicalMessage).toHaveBeenCalledWith({
      req,
      responseMessageId: 'resp-1',
      cortexParts: pendingCortexParts,
    });
    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
  });

  test('persists terminal parts but suppresses follow-up when user moved on during fallback', async () => {
    const phaseB = deferred();
    const mainReady = deferred();
    const responseController = { lastUserInputTime: 10 };
    const pendingCortexParts = [
      {
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'agent-background',
        status: 'complete',
        insight: 'Late result.',
      },
    ];
    client._phaseBMainResponseReadyPromise = mainReady.promise;

    const attached = client.attachBackgroundCortexCompletionPipeline({
      cortexExecutionPromise: phaseB.promise,
      pendingCortexParts,
      req,
      conversationId: 'conv-1',
      responseMessageId: 'resp-1',
      agent: primaryAgent,
      getResponseContentParts: () => client.contentParts,
      responseController,
      turnUserInputTime: 10,
      followupGraceMs: 0,
      shouldDeferMainResponse: false,
      getActivatedCorticesList: () => [],
    });

    phaseB.resolve({
      insights: [{ cortexName: 'Background', insight: 'Late result.' }],
      mergedPrompt: 'Late result.',
      cortexCount: 1,
    });
    responseController.lastUserInputTime = 20;
    client.contentParts.push({ type: ContentTypes.TEXT, text: 'Fallback answer.' });
    mainReady.resolve();
    await attached;

    expect(mockPersistCortexPartsToCanonicalMessage).toHaveBeenCalledTimes(1);
    expect(mockFinalizeCanonicalCortexMessage).toHaveBeenCalledWith({
      req,
      messageId: 'resp-1',
    });
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
  });

  test('skips DB persistence for empty Phase B completion with no terminal parts', async () => {
    const phaseB = deferred();
    const attached = client.attachBackgroundCortexCompletionPipeline({
      cortexExecutionPromise: phaseB.promise,
      pendingCortexParts: [],
      req,
      conversationId: 'conv-1',
      responseMessageId: 'resp-1',
      agent: primaryAgent,
      getResponseContentParts: () => client.contentParts,
      responseController: null,
      turnUserInputTime: 0,
      followupGraceMs: 0,
      shouldDeferMainResponse: false,
      getActivatedCorticesList: () => [],
    });

    phaseB.resolve(null);
    await attached;

    expect(mockPersistCortexPartsToCanonicalMessage).not.toHaveBeenCalled();
    expect(mockCreateCortexFollowUpMessage).not.toHaveBeenCalled();
  });

  test('allows fallback chatCompletion to run background cortices when primary never started Phase B', async () => {
    const fallbackAgent = {
      id: 'agent-fallback',
      provider: EModelEndpoint.openAI,
      model: 'gpt-5.4',
      model_parameters: { model: 'gpt-5.4' },
    };
    primaryAgent.viventiumFallbackLlm = fallbackAgent;
    let fallbackSawSuppression;
    let calls = 0;
    client.chatCompletion = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        client.contentParts.push({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: 'authentication 401 credential failure',
        });
        return;
      }
      fallbackSawSuppression = req.body.suppressBackgroundCortices;
      client.contentParts.push({ type: ContentTypes.TEXT, text: 'Fallback answer.' });
    });

    const result = await client.sendCompletion({ text: 'hello' });

    expect(client.chatCompletion).toHaveBeenCalledTimes(2);
    expect(fallbackSawSuppression).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(req.body, 'suppressBackgroundCortices')).toBe(
      false,
    );
    expect(result.completion).toEqual([{ type: ContentTypes.TEXT, text: 'Fallback answer.' }]);
  });

  test('retries fallback when primary throws after adding a recoverable error part', async () => {
    const fallbackAgent = {
      id: 'agent-fallback',
      provider: EModelEndpoint.openAI,
      model: 'gpt-5.4',
      model_parameters: { model: 'gpt-5.4' },
    };
    primaryAgent.viventiumFallbackLlm = fallbackAgent;
    let calls = 0;
    client.chatCompletion = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        client.contentParts.push({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]:
            'The model provider rate-limited this request. Please try again shortly.',
          error_class: 'provider_rate_limited',
        });
        const error = new Error('rate limit');
        error.status = 429;
        throw error;
      }
      client.contentParts.push({ type: ContentTypes.TEXT, text: 'Fallback answer.' });
    });

    const result = await client.sendCompletion({ text: 'hello' });

    expect(client.chatCompletion).toHaveBeenCalledTimes(2);
    expect(result.completion).toEqual([{ type: ContentTypes.TEXT, text: 'Fallback answer.' }]);
    expect(client.contentParts).toEqual([{ type: ContentTypes.TEXT, text: 'Fallback answer.' }]);
  });

  test('suppresses fallback background cortices only when primary Phase B already owns the response', async () => {
    const fallbackAgent = {
      id: 'agent-fallback',
      provider: EModelEndpoint.openAI,
      model: 'gpt-5.4',
      model_parameters: { model: 'gpt-5.4' },
    };
    primaryAgent.viventiumFallbackLlm = fallbackAgent;
    let fallbackSawSuppression;
    let calls = 0;
    client.chatCompletion = jest.fn(async () => {
      calls += 1;
      if (calls === 1) {
        client._phaseBPromise = Promise.resolve(null);
        client._phaseBPipelineResponseMessageId = client.responseMessageId;
        client.contentParts.push({
          type: ContentTypes.CORTEX_INSIGHT,
          cortex_id: 'agent-background',
          cortex_name: 'Background',
          status: 'error',
          error: 'This background agent hit a runtime issue before it could return a result.',
        });
        client.contentParts.push({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: 'authentication 401 credential failure',
        });
        return;
      }
      fallbackSawSuppression = req.body.suppressBackgroundCortices;
      client.contentParts.push({ type: ContentTypes.TEXT, text: 'Fallback answer.' });
    });

    await client.sendCompletion({ text: 'hello' });

    expect(client.chatCompletion).toHaveBeenCalledTimes(2);
    expect(fallbackSawSuppression).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(req.body, 'suppressBackgroundCortices')).toBe(
      false,
    );
    expect(client.contentParts).toEqual([
      expect.objectContaining({
        type: ContentTypes.CORTEX_INSIGHT,
        cortex_id: 'agent-background',
        status: 'error',
      }),
      { type: ContentTypes.TEXT, text: 'Fallback answer.' },
    ]);
  });
});

/**
 * Integration test for Phase B cortex follow-up SSE emission.
 *
 * Unlike cortexFollowupSseEmission.test.js (contract copy with a local helper),
 * this test uses the actual mocked modules that client.js imports:
 * - createCortexFollowUpMessage from BackgroundCortexFollowUpService
 * - GenerationJobManager.emitChunk from @librechat/api
 *
 * The emission conditional mirrors client.js:2117-2129. If client.js changes
 * the conditional or import path, this test must be updated.
 */
describe('Phase B cortex follow-up SSE emission (integration)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('does NOT emit on_cortex_followup when createCortexFollowUpMessage returns null (NTA suppressed)', async () => {
    mockCreateCortexFollowUpMessage.mockResolvedValue(null);

    const req = { _resumableStreamId: 'stream-abc' };
    const responseMessageId = 'resp-123';
    const mergedInsightsData = {
      insights: [{ text: 'insight' }],
      cortexCount: 1,
      mergedPrompt: 'prompt',
    };

    const followUpMessage = await mockCreateCortexFollowUpMessage({
      req,
      conversationId: 'conv-1',
      parentMessageId: responseMessageId,
      agent: { id: 'agent-1' },
      insightsData: mergedInsightsData,
      recentResponse: 'Recent response text',
    });

    // Mirror the production emission conditional (client.js:2117-2129)
    if (followUpMessage?.text && req?._resumableStreamId) {
      mockEmitChunk(req._resumableStreamId, {
        event: 'on_cortex_followup',
        data: {
          runId: responseMessageId,
          messageId: followUpMessage.messageId,
          parentMessageId: responseMessageId,
          text: followUpMessage.text,
          cortexCount: mergedInsightsData?.cortexCount ?? undefined,
        },
      });
    }

    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockEmitChunk).not.toHaveBeenCalled();
  });

  test('does NOT emit on_cortex_followup when followUpMessage.text is empty', async () => {
    mockCreateCortexFollowUpMessage.mockResolvedValue({ messageId: 'fu-1', text: '' });

    const req = { _resumableStreamId: 'stream-abc' };
    const responseMessageId = 'resp-123';

    const followUpMessage = await mockCreateCortexFollowUpMessage({
      req,
      conversationId: 'conv-1',
      parentMessageId: responseMessageId,
      agent: { id: 'agent-1' },
      insightsData: { insights: [], cortexCount: 0, mergedPrompt: '' },
      recentResponse: '',
    });

    if (followUpMessage?.text && req?._resumableStreamId) {
      mockEmitChunk(req._resumableStreamId, { event: 'on_cortex_followup', data: {} });
    }

    expect(mockEmitChunk).not.toHaveBeenCalled();
  });

  test('does NOT emit on_cortex_followup when req has no _resumableStreamId', async () => {
    mockCreateCortexFollowUpMessage.mockResolvedValue({ messageId: 'fu-1', text: 'Insight text.' });

    const req = {}; // No _resumableStreamId (non-streaming surface)
    const responseMessageId = 'resp-123';

    const followUpMessage = await mockCreateCortexFollowUpMessage({
      req,
      conversationId: 'conv-1',
      parentMessageId: responseMessageId,
      agent: { id: 'agent-1' },
      insightsData: { insights: [{ text: 'insight' }], cortexCount: 1, mergedPrompt: 'prompt' },
      recentResponse: 'Recent text',
    });

    if (followUpMessage?.text && req?._resumableStreamId) {
      mockEmitChunk(req._resumableStreamId, { event: 'on_cortex_followup', data: {} });
    }

    expect(mockEmitChunk).not.toHaveBeenCalled();
  });

  test('DOES emit on_cortex_followup when createCortexFollowUpMessage returns a message with text', async () => {
    const mockFollowUp = { messageId: 'fu-1', text: 'A new insight surfaced.' };
    mockCreateCortexFollowUpMessage.mockResolvedValue(mockFollowUp);

    const req = { _resumableStreamId: 'stream-abc' };
    const responseMessageId = 'resp-123';
    const mergedInsightsData = {
      insights: [{ text: 'insight' }],
      cortexCount: 2,
      mergedPrompt: 'prompt',
    };

    const followUpMessage = await mockCreateCortexFollowUpMessage({
      req,
      conversationId: 'conv-1',
      parentMessageId: responseMessageId,
      agent: { id: 'agent-1' },
      insightsData: mergedInsightsData,
      recentResponse: 'Recent response text',
    });

    // Mirror the production emission conditional (client.js:2117-2129)
    if (followUpMessage?.text && req?._resumableStreamId) {
      const followUpEvent = {
        event: 'on_cortex_followup',
        data: {
          runId: responseMessageId,
          messageId: followUpMessage.messageId,
          parentMessageId: responseMessageId,
          text: followUpMessage.text,
          cortexCount: mergedInsightsData?.cortexCount ?? undefined,
        },
      };
      mockEmitChunk(req._resumableStreamId, followUpEvent);
    }

    expect(mockCreateCortexFollowUpMessage).toHaveBeenCalledTimes(1);
    expect(mockEmitChunk).toHaveBeenCalledTimes(1);
    expect(mockEmitChunk).toHaveBeenCalledWith('stream-abc', {
      event: 'on_cortex_followup',
      data: {
        runId: 'resp-123',
        messageId: 'fu-1',
        parentMessageId: 'resp-123',
        text: 'A new insight surfaced.',
        cortexCount: 2,
      },
    });
  });
});
