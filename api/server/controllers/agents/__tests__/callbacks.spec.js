/* === VIVENTIUM START ===
 * Feature: Viventium stream, voice, and timing regression coverage.
 * Purpose: Keep fork-specific callback behavior protected during upstream replay.
 */
const { Tools } = require('librechat-data-provider');
const { GraphEvents, GraphNodeKeys } = require('@librechat/agents');
test('records the native provider-returned model separately from the requested model', async () => {
  const { getDefaultHandlers } = require('../callbacks');
  const req = { body: {} };
  const handlers = getDefaultHandlers({
    req,
    res: {},
    aggregateContent: jest.fn(),
    toolEndCallback: jest.fn(),
    collectedUsage: [],
    streamId: null,
  });
  const graph = {
    getAgentContext: () => ({
      agentId: 'agent-main',
      provider: 'openAI',
      clientOptions: { model: 'grok-build:grok-4.7-build-fast' },
    }),
  };
  await handlers[GraphEvents.CHAT_MODEL_END].handle(
    GraphEvents.CHAT_MODEL_END,
    { output: { content: 'Ready.', response_metadata: { model_name: 'grok-build:grok-4.7' } } },
    { langgraph_node: 'agent_agent-main' },
    graph,
  );
  expect(req._viventiumProviderModelReceipts.get('agent-main')).toEqual({
    requestedModel: 'grok-build:grok-4.7-build-fast',
    model: 'grok-build:grok-4.7',
  });
});

jest.mock('~/models', () => ({
  getNativeResponse: jest.fn(),
  nativeResponseSourceMatches: jest.fn(),
}));

// Mock all dependencies before requiring the module
jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'mock-id'),
}));

jest.mock('@librechat/api', () => ({
  inspectNativeOutputFileCarrier: jest.fn(),
  nativeOutputFilePublisherFromContext: jest.fn(),
  createDeliveryDispositionStreamHandler:
    jest.requireActual('@librechat/api').createDeliveryDispositionStreamHandler,
  getStreamDeliveryDisposition: jest.requireActual('@librechat/api').getStreamDeliveryDisposition,
  inspectProviderPublicPartCompletion:
    jest.requireActual('@librechat/api').inspectProviderPublicPartCompletion,
  createReleasedMainPublicPartOwner: jest.fn((identity) => ({
    identity,
    verifySource: jest.fn(async () => true),
  })),
  isAudioDeliveryRequested: jest.requireActual('@librechat/api').isAudioDeliveryRequested,
  inspectProviderDeliveryDisposition:
    jest.requireActual('@librechat/api').inspectProviderDeliveryDisposition,
  resolveEffectiveDeliveryDisposition:
    jest.requireActual('@librechat/api').resolveEffectiveDeliveryDisposition,
  supportsMessagingDeliveryDisposition:
    jest.requireActual('@librechat/api').supportsMessagingDeliveryDisposition,
  nativeJobMatches: jest.requireActual('@librechat/api').nativeJobMatches,
  nativeIdentityJson: jest.requireActual('@librechat/api').nativeIdentityJson,
  getTrustedInteractionContext: jest.requireActual('@librechat/api').getTrustedInteractionContext,
  setTrustedInteractionContext: jest.requireActual('@librechat/api').setTrustedInteractionContext,
  sendEvent: jest.fn(),
  GenerationJobManager: {
    emitChunk: jest.fn(),
    getJob: jest.fn(),
    getJobStore: jest.fn(),
  },
  writeAttachmentEvent: jest.fn(),
  createToolExecuteHandler: jest.fn().mockReturnValue({ handle: jest.fn() }),
}));

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  getMessageId: jest.fn(),
  ToolEndHandler: jest.fn(() => ({ handle: jest.fn() })),
  handleToolCalls: jest.fn(),
}));

jest.mock('~/server/services/Files/Citations', () => ({
  processFileCitations: jest.fn(),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: jest.fn(),
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  saveBase64Image: jest.fn(),
}));

describe('createToolEndCallback', () => {
  let req, res, artifactPromises, createToolEndCallback;
  let logger;

  beforeEach(() => {
    jest.clearAllMocks();

    // Get the mocked logger
    logger = require('@librechat/data-schemas').logger;

    // Now require the module after all mocks are set up
    const callbacks = require('../callbacks');
    createToolEndCallback = callbacks.createToolEndCallback;

    req = {
      user: { id: 'user123' },
    };
    res = {
      headersSent: false,
      write: jest.fn(),
    };
    artifactPromises = [];
  });

  describe('ui_resources artifact handling', () => {
    it('should process ui_resources artifact and return attachment when headers not sent', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [
              { type: 'button', label: 'Click me' },
              { type: 'input', placeholder: 'Enter text' },
            ],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);

      // Wait for all promises to resolve
      const results = await Promise.all(artifactPromises);

      // When headers are not sent, it returns attachment without writing
      expect(res.write).not.toHaveBeenCalled();

      const attachment = results[0];
      expect(attachment).toEqual({
        type: Tools.ui_resources,
        messageId: 'run456',
        toolCallId: 'tool123',
        conversationId: 'thread789',
        [Tools.ui_resources]: [
          { type: 'button', label: 'Click me' },
          { type: 'input', placeholder: 'Enter text' },
        ],
      });
    });

    it('should write to response when headers are already sent', async () => {
      res.headersSent = true;
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [{ type: 'carousel', items: [] }],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(res.write).toHaveBeenCalled();
      expect(results[0]).toEqual({
        type: Tools.ui_resources,
        messageId: 'run456',
        toolCallId: 'tool123',
        conversationId: 'thread789',
        [Tools.ui_resources]: [{ type: 'carousel', items: [] }],
      });
    });

    it('should handle errors when processing ui_resources', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      // Mock res.write to throw an error
      res.headersSent = true;
      res.write.mockImplementation(() => {
        throw new Error('Write failed');
      });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [{ type: 'test' }],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(logger.error).toHaveBeenCalledWith(
        'Error processing artifact content:',
        expect.any(Error),
      );
      expect(results[0]).toBeNull();
    });

    it('should handle multiple artifacts including ui_resources', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [{ type: 'chart', data: [] }],
          },
          [Tools.web_search]: {
            results: ['result1', 'result2'],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      // Both ui_resources and web_search should be processed
      expect(artifactPromises).toHaveLength(2);
      expect(results).toHaveLength(2);

      // Check ui_resources attachment
      const uiResourceAttachment = results.find((r) => r?.type === Tools.ui_resources);
      expect(uiResourceAttachment).toBeTruthy();
      expect(uiResourceAttachment[Tools.ui_resources]).toEqual([{ type: 'chart', data: [] }]);

      // Check web_search attachment
      const webSearchAttachment = results.find((r) => r?.type === Tools.web_search);
      expect(webSearchAttachment).toBeTruthy();
      expect(webSearchAttachment[Tools.web_search]).toEqual({
        results: ['result1', 'result2'],
      });
    });

    it('should not process artifacts when output has no artifacts', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        content: 'Some regular content',
        // No artifact property
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);

      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should handle empty ui_resources data object', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: [],
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(results[0]).toEqual({
        type: Tools.ui_resources,
        messageId: 'run456',
        toolCallId: 'tool123',
        conversationId: 'thread789',
        [Tools.ui_resources]: [],
      });
    });

    it('should handle ui_resources with complex nested data', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const complexData = {
        0: {
          type: 'form',
          fields: [
            { name: 'field1', type: 'text', required: true },
            { name: 'field2', type: 'select', options: ['a', 'b', 'c'] },
          ],
          nested: {
            deep: {
              value: 123,
              array: [1, 2, 3],
            },
          },
        },
      };

      const output = {
        tool_call_id: 'tool123',
        artifact: {
          [Tools.ui_resources]: {
            data: complexData,
          },
        },
      };

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output }, metadata);
      const results = await Promise.all(artifactPromises);

      expect(results[0][Tools.ui_resources]).toEqual(complexData);
    });

    it('should handle when output is undefined', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback({ output: undefined }, metadata);

      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });

    it('should handle when data parameter is undefined', async () => {
      const toolEndCallback = createToolEndCallback({ req, res, artifactPromises });

      const metadata = {
        run_id: 'run456',
        thread_id: 'thread789',
      };

      await toolEndCallback(undefined, metadata);

      expect(artifactPromises).toHaveLength(0);
      expect(res.write).not.toHaveBeenCalled();
    });
  });
});

describe('getDefaultHandlers voice reasoning guard', () => {
  let getDefaultHandlers;
  let sendEvent;
  let GenerationJobManager;
  let logger;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    getDefaultHandlers = require('../callbacks').getDefaultHandlers;
    ({ sendEvent, GenerationJobManager } = require('@librechat/api'));
    logger = require('@librechat/data-schemas').logger;
  });

  it('suppresses reasoning deltas for voice-mode streams before emit and aggregation', async () => {
    const aggregateContent = jest.fn();
    const handlers = getDefaultHandlers({
      req: {
        body: { voiceMode: true },
        viventiumVoiceLogLatency: true,
        viventiumVoiceRequestId: 'lc_voice_test',
        viventiumVoiceStartAt: Date.now(),
        _viventiumVoiceProcessStreamStartedAt: Date.now(),
      },
      res: {},
      aggregateContent,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'stream-voice-test',
    });

    await handlers[GraphEvents.ON_REASONING_DELTA].handle(
      GraphEvents.ON_REASONING_DELTA,
      {
        id: 'step-1',
        delta: { content: [{ type: 'think', think: 'internal reasoning' }] },
      },
      { last_agent_id: 'agent-1', langgraph_node: 'node_agent-1' },
    );

    expect(GenerationJobManager.emitChunk).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
    expect(aggregateContent).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('stage=voice_reasoning_delta_suppressed'),
    );
  });

  it('keeps the request correlation id across agent start and first model token trace hops', async () => {
    const handlers = getDefaultHandlers({
      req: {
        body: { voiceMode: true },
        viventiumVoiceLogLatency: true,
        viventiumVoiceRequestId: 'request-correlation-1',
        viventiumVoiceStartAt: Date.now(),
        _viventiumVoiceProcessStreamStartedAt: Date.now(),
      },
      res: {},
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'request-correlation-1',
    });

    await handlers[GraphEvents.CHAT_MODEL_START].handle(
      GraphEvents.CHAT_MODEL_START,
      {},
      { ls_model_name: 'synthetic-model' },
    );
    await handlers[GraphEvents.LLM_STREAM].handle(GraphEvents.LLM_STREAM, {}, {});

    const trace = logger.info.mock.calls.map(([line]) => line).join('\n');
    expect(trace).toContain('stage=agent_generation_start');
    expect(trace).toContain('stage=first_model_token');
    expect(trace.match(/request_id=request-correlation-1/g)).toHaveLength(4);
  });

  it('captures the final non-tool disposition and clears it for a later legacy speaker', async () => {
    const req = {
      _viventiumTelegram: true,
      body: { telegramAudioRequested: true },
      _viventiumDeliveryDispositionRequired: true,
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              'glasshive-harness': {
                messaging_delivery_disposition: true,
                messaging_delivery_disposition_version: 1,
              },
            },
          },
        },
      },
    };
    const handlers = getDefaultHandlers({
      req,
      res: {},
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: null,
    });
    const capabilityOwner = Symbol.for(
      'viventium.agent.messaging.delivery-disposition.capability-owner.v1',
    );
    const graph = {
      getAgentContext: jest.fn(() => ({
        provider: 'openAI',
        clientOptions: { [capabilityOwner]: 'glasshive-harness' },
      })),
    };
    const disposition = {
      version: 1,
      audio: 'skip',
      required: true,
      valid: true,
      source: 'model',
    };
    const output = {
      content: 'Final answer.',
      additional_kwargs: {
        __raw_response: {
          choices: [
            {
              index: 0,
              delta: {
                provider_specific_fields: {
                  viventium: { delivery_disposition: disposition },
                },
              },
            },
          ],
        },
      },
    };

    await handlers[GraphEvents.CHAT_MODEL_END].handle(
      GraphEvents.CHAT_MODEL_END,
      { output },
      { last_agent_id: 'main', langgraph_node: 'agent_specialist' },
      graph,
    );
    expect(req._viventiumDeliveryDispositionCapture).toEqual({
      status: 'valid',
      disposition,
    });

    await handlers[GraphEvents.CHAT_MODEL_END].handle(
      GraphEvents.CHAT_MODEL_END,
      { output: { ...output, tool_calls: [{ id: 'handoff-1' }] } },
      { last_agent_id: 'main', langgraph_node: 'agent_main' },
      graph,
    );
    expect(req._viventiumDeliveryDispositionCapture).toEqual({
      status: 'valid',
      disposition,
    });

    await handlers[GraphEvents.CHAT_MODEL_END].handle(
      GraphEvents.CHAT_MODEL_END,
      { output },
      { last_agent_id: 'main', langgraph_node: 'agent_main' },
      graph,
    );
    expect(req._viventiumDeliveryDispositionCapture).toEqual({
      status: 'valid',
      disposition,
    });

    graph.getAgentContext.mockReturnValueOnce({
      provider: 'openAI',
      clientOptions: {},
    });
    await handlers[GraphEvents.CHAT_MODEL_END].handle(
      GraphEvents.CHAT_MODEL_END,
      { output: { content: 'Final answer from a legacy provider.' } },
      { last_agent_id: 'main', langgraph_node: 'agent_legacy' },
      graph,
    );
    expect(req._viventiumDeliveryDispositionCapture).toBeUndefined();
    expect(req._viventiumDeliveryDispositionRequired).toBe(false);
  });

  it('continues to emit reasoning deltas for non-voice streams', async () => {
    const aggregateContent = jest.fn();
    const res = {};
    const data = {
      id: 'step-1',
      delta: { content: [{ type: 'think', think: 'visible text-chat reasoning' }] },
    };
    const handlers = getDefaultHandlers({
      req: { body: {} },
      res,
      aggregateContent,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: null,
    });

    await handlers[GraphEvents.ON_REASONING_DELTA].handle(GraphEvents.ON_REASONING_DELTA, data, {
      last_agent_id: 'agent-1',
      langgraph_node: 'node_agent-1',
    });

    expect(sendEvent).toHaveBeenCalledWith(res, {
      event: GraphEvents.ON_REASONING_DELTA,
      data,
    });
    expect(aggregateContent).toHaveBeenCalledWith({
      event: GraphEvents.ON_REASONING_DELTA,
      data,
    });
  });

  it('renders harness reasoning summaries as dedicated activity while preserving upstream aggregation', async () => {
    const aggregateContent = jest.fn();
    const res = {};
    const req = {
      body: {},
      _viventiumHarnessActivityEnabled: true,
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessInvocationStarted: false,
    };
    const data = {
      id: 'step-harness',
      delta: { content: [{ type: 'think', think: 'The harness started working.\n' }] },
    };
    const handlers = getDefaultHandlers({
      req,
      res,
      aggregateContent,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: null,
    });

    await handlers[GraphEvents.ON_REASONING_DELTA].handle(GraphEvents.ON_REASONING_DELTA, data, {
      last_agent_id: 'agent-1',
      langgraph_node: 'node_agent-1',
    });

    expect(sendEvent).toHaveBeenCalledWith(res, {
      event: GraphEvents.ON_REASONING_DELTA,
      data: expect.objectContaining({
        delta: {
          content: [
            {
              type: 'harness_activity',
              harness_activity: {
                event: 'reasoning-summary',
                summary: 'The harness started working.\n',
              },
            },
          ],
        },
      }),
    });
    expect(aggregateContent).toHaveBeenCalledWith({
      event: GraphEvents.ON_REASONING_DELTA,
      data,
    });
    expect(req._viventiumHarnessInvocationStarted).toBe(true);
    expect(req._viventiumCapturedHarnessActivityParts).toEqual([
      {
        type: 'harness_activity',
        harness_activity: {
          event: 'reasoning-summary',
          summary: 'The harness started working.\n',
        },
      },
    ]);
  });

  it('keeps pre-start fallback available for role-only deltas and locks on visible harness text', async () => {
    const req = {
      body: {},
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessInvocationStarted: false,
    };
    const handlers = getDefaultHandlers({
      req,
      res: {},
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: null,
    });
    const metadata = { last_agent_id: 'agent-1', langgraph_node: 'node_agent-1' };

    await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      { id: 'step-role', delta: { role: 'assistant' } },
      metadata,
    );
    expect(req._viventiumHarnessInvocationStarted).toBe(false);

    await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      { id: 'step-text', delta: { content: [{ type: 'text', text: 'Started.' }] } },
      metadata,
    );
    expect(req._viventiumHarnessInvocationStarted).toBe(true);
  });

  it('normalizes cumulative message snapshots only when the adapter declares snapshot mode', async () => {
    const aggregateContent = jest.fn();
    const handlers = getDefaultHandlers({
      req: { body: { voiceMode: true, viventiumTextDeltaMode: 'incremental' } },
      res: {},
      aggregateContent,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'stream-voice-test',
      messageDeltaMode: 'snapshot',
    });
    const metadata = { last_agent_id: 'agent-1', langgraph_node: 'node_agent-1' };

    await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'step-1',
        delta: { content: [{ type: 'text', text: 'I' }] },
      },
      metadata,
    );
    await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'step-1',
        delta: { content: [{ type: 'text', text: 'I hear you.' }] },
      },
      metadata,
    );

    expect(GenerationJobManager.emitChunk).toHaveBeenNthCalledWith(
      1,
      'stream-voice-test',
      expect.objectContaining({
        data: expect.objectContaining({
          delta: { content: [{ type: 'text', text: 'I' }] },
        }),
      }),
    );
    expect(GenerationJobManager.emitChunk).toHaveBeenNthCalledWith(
      2,
      'stream-voice-test',
      expect.objectContaining({
        data: expect.objectContaining({
          delta: { content: [{ type: 'text', text: ' hear you.' }] },
        }),
      }),
    );
    expect(aggregateContent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          delta: { content: [{ type: 'text', text: ' hear you.' }] },
        }),
      }),
    );
  });

  it('leaves non-voice message deltas unchanged at the boundary', async () => {
    const aggregateContent = jest.fn();
    const handlers = getDefaultHandlers({
      req: { body: {} },
      res: {},
      aggregateContent,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'stream-chat-test',
    });
    const metadata = { last_agent_id: 'agent-1', langgraph_node: 'node_agent-1' };

    await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'step-1',
        delta: { content: [{ type: 'text', text: 'I' }] },
      },
      metadata,
    );
    await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'step-1',
        delta: { content: [{ type: 'text', text: 'I hear you.' }] },
      },
      metadata,
    );

    expect(GenerationJobManager.emitChunk).toHaveBeenNthCalledWith(
      2,
      'stream-chat-test',
      expect.objectContaining({
        data: expect.objectContaining({
          delta: { content: [{ type: 'text', text: 'I hear you.' }] },
        }),
      }),
    );
    expect(aggregateContent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          delta: { content: [{ type: 'text', text: 'I hear you.' }] },
        }),
      }),
    );
  });

  it.each([
    ['a', 'and'],
    ['ha', 'hahaha'],
    ['I', 'Item'],
  ])(
    'preserves ambiguous incremental prefixes at the callback boundary: %s + %s',
    async (first, second) => {
      const aggregateContent = jest.fn();
      const handlers = getDefaultHandlers({
        req: { body: { voiceMode: true, viventiumTextDeltaMode: 'snapshot' } },
        res: {},
        aggregateContent,
        toolEndCallback: jest.fn(),
        collectedUsage: [],
        streamId: null,
      });
      const metadata = { last_agent_id: 'agent-1', langgraph_node: 'node_agent-1' };

      await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
        GraphEvents.ON_MESSAGE_DELTA,
        {
          id: 'step-1',
          delta: { content: [{ type: 'text', text: first }] },
        },
        metadata,
      );
      await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
        GraphEvents.ON_MESSAGE_DELTA,
        {
          id: 'step-1',
          delta: { content: [{ type: 'text', text: second }] },
        },
        metadata,
      );

      expect(sendEvent).toHaveBeenNthCalledWith(
        2,
        {},
        expect.objectContaining({
          data: expect.objectContaining({
            delta: { content: [{ type: 'text', text: second }] },
          }),
        }),
      );
      expect(aggregateContent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            delta: { content: [{ type: 'text', text: second }] },
          }),
        }),
      );
    },
  );
});

describe('typed harness activity carrier', () => {
  const {
    harnessActivityDelta,
    stashTypedHarnessActivity,
    consumeTypedHarnessActivity,
    captureHarnessActivityParts,
  } = require('../callbacks');
  const { ContentTypes } = require('librechat-data-provider');

  const activityChunk = (reasoningText, activity) => ({
    chunk: {
      additional_kwargs: {
        reasoning_content: reasoningText,
        provider_specific_fields: { viventium: { activity } },
      },
    },
  });

  it('attaches the typed activity of the same chunk to the reasoning delta', () => {
    const req = { _viventiumHarnessActivityEnabled: true };
    const summary = 'Connected tool completed: worker delegate once.\n';
    stashTypedHarnessActivity(
      req,
      activityChunk(summary, {
        event: 'tool',
        tool: 'connected_tool',
        task: 'worker delegate once',
        status: 'completed',
      }),
    );
    const visible = harnessActivityDelta(
      { delta: { content: [{ type: 'think', think: summary }] } },
      req,
    );
    expect(visible.delta.content).toEqual([
      {
        type: ContentTypes.HARNESS_ACTIVITY,
        harness_activity: {
          event: 'tool',
          summary,
          tool: 'connected_tool',
          task: 'worker delegate once',
          status: 'completed',
        },
      },
    ]);
    // Consumed once: a later unrelated summary falls back to the plain reasoning-summary part.
    const later = harnessActivityDelta(
      {
        delta: { content: [{ type: 'think', think: 'The harness completed a reasoning step.\n' }] },
      },
      req,
    );
    expect(later.delta.content[0].harness_activity).toEqual({
      event: 'reasoning-summary',
      summary: 'The harness completed a reasoning step.\n',
    });
  });

  it('does not apply a stashed activity to a different summary', () => {
    const req = { _viventiumHarnessActivityEnabled: true };
    stashTypedHarnessActivity(
      req,
      activityChunk('Connected tool completed: active work list.\n', {
        event: 'tool',
        tool: 'connected_tool',
        status: 'completed',
      }),
    );
    expect(consumeTypedHarnessActivity(req, 'The harness started working.\n')).toBeNull();
    expect(
      consumeTypedHarnessActivity(req, 'Connected tool completed: active work list.\n'),
    ).toEqual({
      event: 'tool',
      tool: 'connected_tool',
      status: 'completed',
    });
    expect(
      consumeTypedHarnessActivity(req, 'Connected tool completed: active work list.\n'),
    ).toBeNull();
  });

  it('upgrades an already-captured part when the built-in stream path ran first', () => {
    const req = { _viventiumHarnessActivityEnabled: true };
    const summary = 'Connected tool completed: worker delegate once.\n';
    const visible = harnessActivityDelta(
      { delta: { content: [{ type: 'think', think: summary }] } },
      req,
    );
    captureHarnessActivityParts(req, visible);
    expect(req._viventiumCapturedHarnessActivityParts[0].harness_activity).toEqual({
      event: 'reasoning-summary',
      summary,
    });
    stashTypedHarnessActivity(
      req,
      activityChunk(summary, { event: 'tool', tool: 'connected_tool', status: 'completed' }),
    );
    expect(req._viventiumCapturedHarnessActivityParts[0].harness_activity).toEqual({
      event: 'tool',
      summary,
      tool: 'connected_tool',
      status: 'completed',
    });
    expect(req._viventiumPendingHarnessActivity).toBeUndefined();
  });

  it('carries the typed deferred-callback anchor through the captured-part upgrade', () => {
    const req = { _viventiumHarnessActivityEnabled: true };
    const summary = 'Connected tool completed: worker delegate once.\n';
    const visible = harnessActivityDelta(
      { delta: { content: [{ type: 'think', think: summary }] } },
      req,
    );
    captureHarnessActivityParts(req, visible);
    stashTypedHarnessActivity(
      req,
      activityChunk(summary, {
        event: 'tool',
        tool: 'connected_tool',
        task: 'worker delegate once',
        status: 'completed',
        expects_deferred_callback: true,
      }),
    );
    expect(req._viventiumCapturedHarnessActivityParts[0].harness_activity).toEqual({
      event: 'tool',
      summary,
      tool: 'connected_tool',
      task: 'worker delegate once',
      status: 'completed',
      expects_deferred_callback: true,
    });

    // An ordinary connected tool never gains the anchor, even with a truthy non-boolean value.
    const plainReq = { _viventiumHarnessActivityEnabled: true };
    const plainSummary = 'Connected tool completed: workspace status.\n';
    captureHarnessActivityParts(
      plainReq,
      harnessActivityDelta(
        { delta: { content: [{ type: 'think', think: plainSummary }] } },
        plainReq,
      ),
    );
    stashTypedHarnessActivity(
      plainReq,
      activityChunk(plainSummary, {
        event: 'tool',
        tool: 'connected_tool',
        task: 'workspace status',
        status: 'completed',
        expects_deferred_callback: 'yes',
      }),
    );
    expect(plainReq._viventiumCapturedHarnessActivityParts[0].harness_activity).not.toHaveProperty(
      'expects_deferred_callback',
    );
  });

  it('ignores chunks without the typed namespace', () => {
    const req = {};
    stashTypedHarnessActivity(req, { chunk: { additional_kwargs: { reasoning_content: 'x' } } });
    expect(req._viventiumPendingHarnessActivity).toBeUndefined();
  });
});

describe('authored native preview presentation', () => {
  const { getDefaultHandlers } = require('../callbacks');
  const { GenerationJobManager, setTrustedInteractionContext } = require('@librechat/api');
  const identity = {
    userId: 'owner-a',
    conversationId: 'conversation-a',
    responseMessageId: 'answer-a',
    streamId: 'stream-a',
    jobCreatedAt: 1,
    logicalTurnId: 'turn-a',
    revision: 1,
    invocationId: 'invocation-a',
    agentId: 'agent-a',
    source: { id: 'source-a', messageId: 'question-a', digest: 'a'.repeat(64) },
    deliveryContext: { surface: 'web' },
  };
  const getStoredJob = jest.fn();
  const metadata = { agentId: 'agent-a', last_agent_id: 'agent-a', langgraph_node: 'agent-a' };
  const chunk = (sequence = 1, text = 'Timezone: UTC.') => ({
    chunk: {
      additional_kwargs: {
        provider_specific_fields: {
          viventium: {
            assistant_preview: {
              version: 1,
              sequence,
              text,
              message_id: 'answer-a',
              invocation_id: 'invocation-a',
            },
          },
        },
      },
    },
  });
  const fixture = (overrides = {}, interactionOverrides = {}) => {
    const req = {
      user: { id: 'owner-a' },
      _viventiumNativeResponseIdentity: identity,
      _viventiumHarnessExecutionEnabled: true,
      ...overrides,
    };
    require('~/server/services/viventium/interactionContext').setTrustedInteractionContext(req, {
      version: 1,
      actor_kind: 'external_user',
      origin: 'interactive',
      logical_turn_id: 'turn-a',
      revision: 1,
      source_event_id: 'source-a',
      source_surface: 'web',
      ...interactionOverrides,
    });
    const storedJob = {
      userId: identity.userId,
      streamId: identity.streamId,
      createdAt: 1,
      conversationId: identity.conversationId,
      responseMessageId: 'answer-a',
      userMessage: { messageId: 'question-a' },
      interactionContext: { logical_turn_id: 'turn-a', revision: 1 },
      nativeResponse: identity,
    };
    getStoredJob.mockResolvedValue(storedJob);
    GenerationJobManager.getJobStore.mockReturnValue({ getJob: getStoredJob });
    // Use the actual built manager facade: owner/source fields are nested and
    // nativeResponse is private to the existing stored-job owner.
    const facade = jest.requireActual('@librechat/api').GenerationJobManager.buildJobFacade(
      'stream-a',
      storedJob,
      {
        abortController: new AbortController(),
        readyPromise: Promise.resolve(),
        resolveReady: () => {},
      },
      {},
    );
    GenerationJobManager.getJob.mockResolvedValue(facade);
    const aggregateContent = jest.fn();
    return {
      req,
      aggregateContent,
      handlers: getDefaultHandlers({
        req,
        res: {},
        streamId: 'stream-a',
        aggregateContent,
        toolEndCallback: jest.fn(),
        collectedUsage: [],
      }),
    };
  };
  beforeEach(() => jest.clearAllMocks());
  it('replaces public previews and clears before the unchanged final SDK delta', async () => {
    const { req, handlers, aggregateContent } = fixture();
    expect(
      require('~/server/services/viventium/interactionContext').getTrustedInteractionContext(req),
    ).toMatchObject({
      actor_kind: 'external_user',
      origin: 'interactive',
      logical_turn_id: 'turn-a',
      revision: 1,
    });
    expect(
      require('@librechat/api').nativeJobMatches(await getStoredJob('stream-a'), identity),
    ).toBe(true);
    expect(
      require('@librechat/api').nativeJobMatches(
        await GenerationJobManager.getJob('stream-a'),
        identity,
      ),
    ).toBe(false);
    await handlers[GraphEvents.CHAT_MODEL_STREAM].handle('', chunk(), metadata);
    await handlers[GraphEvents.CHAT_MODEL_STREAM].handle('', chunk(), metadata);
    await handlers[GraphEvents.CHAT_MODEL_STREAM].handle(
      '',
      chunk(2, 'Checking the page.'),
      metadata,
    );
    expect(aggregateContent).not.toHaveBeenCalled();
    expect(GenerationJobManager.emitChunk.mock.calls.map(([, event]) => event.text)).toEqual([
      'Timezone: UTC.',
      'Checking the page.',
    ]);
    const final = {
      id: 'step-a',
      delta: { content: [{ type: 'text', text: 'Final answer only.' }] },
    };
    await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      final,
      metadata,
    );
    expect(GenerationJobManager.emitChunk.mock.calls[2][1]).toMatchObject({
      preview: true,
      text: '',
    });
    expect(aggregateContent.mock.calls[0][0].data).toEqual(final);
    expect(GenerationJobManager.emitChunk.mock.calls[3][1].data).toEqual(final);
  });
  it('retains the public preview across an installed SDK tool handoff until final text', async () => {
    const { Providers, getChatModelClass } = jest.requireActual('@librechat/agents');
    const { handlers, aggregateContent } = fixture();
    await handlers[GraphEvents.CHAT_MODEL_STREAM].handle('', chunk(), metadata);
    const wire =
      [
        { role: 'assistant' },
        {
          tool_calls: [
            {
              index: 0,
              id: 'consult-a',
              type: 'function',
              function: { name: 'consult_sources', arguments: '{}' },
            },
          ],
        },
        {},
      ]
        .map(
          (delta, index) =>
            'data: ' +
            JSON.stringify({
              id: 'request-a',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'synthetic-model',
              choices: [{ index: 0, delta, finish_reason: index === 2 ? 'tool_calls' : null }],
            }) +
            '\n\n',
        )
        .join('') + 'data: [DONE]\n\n';
    const Model = getChatModelClass(Providers.OPENAI);
    const model = new Model({
      model: 'synthetic-model',
      apiKey: 'synthetic-key',
      maxRetries: 0,
      configuration: {
        baseURL: 'http://example.test/v1',
        fetch: async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
      },
    });
    let output;
    for await (const part of await model.stream([
      { role: 'user', content: 'Synthetic request.' },
    ])) {
      output = output ? output.concat(part) : part;
    }
    expect(output.tool_calls).toEqual([
      { id: 'consult-a', name: 'consult_sources', args: {}, type: 'tool_call' },
    ]);
    const graph = {
      getAgentContext: () => ({ provider: Providers.OPENAI, clientOptions: {} }),
      toolCallStepIds: new Set(['consult-a']),
    };
    await handlers[GraphEvents.CHAT_MODEL_END].handle(
      GraphEvents.CHAT_MODEL_END,
      { output },
      metadata,
      graph,
    );
    await handlers[GraphEvents.CHAT_MODEL_END].handle(
      GraphEvents.CHAT_MODEL_END,
      { output: { content: 'Consultation evidence.', tool_calls: [] } },
      { agentId: 'consultant-a' },
      graph,
    );
    expect(GenerationJobManager.emitChunk.mock.calls.map(([, event]) => event.text)).toEqual([
      'Timezone: UTC.',
    ]);
    expect(aggregateContent).not.toHaveBeenCalled();
    const final = {
      id: 'step-a',
      delta: { content: [{ type: 'text', text: 'Final answer only.' }] },
    };
    await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      final,
      metadata,
    );
    expect(GenerationJobManager.emitChunk.mock.calls[1][1]).toMatchObject({
      preview: true,
      text: '',
    });
    expect(aggregateContent.mock.calls[0][0].data).toEqual(final);
  });
  it.each([{ output: { content: '', tool_calls: [] } }, { output: { content: '' } }])(
    'clears at a non-tool terminal model end',
    async ({ output }) => {
      const { handlers } = fixture();
      await handlers[GraphEvents.CHAT_MODEL_STREAM].handle('', chunk(), metadata);
      const graph = { getAgentContext: () => ({ provider: 'openAI', clientOptions: {} }) };
      await handlers[GraphEvents.CHAT_MODEL_END].handle(
        GraphEvents.CHAT_MODEL_END,
        { output },
        metadata,
        graph,
      );
      expect(GenerationJobManager.emitChunk.mock.calls[1][1]).toMatchObject({
        preview: true,
        text: '',
      });
    },
  );
  it('accepts the installed SDK typed author without deprecated chain metadata', async () => {
    const { Run, Providers, getChatModelClass } = jest.requireActual('@librechat/agents');
    const { handlers, aggregateContent } = fixture();
    const preview =
      chunk().chunk.additional_kwargs.provider_specific_fields.viventium.assistant_preview;
    const wire =
      [
        { role: 'assistant' },
        { provider_specific_fields: { viventium: { assistant_preview: preview } } },
        { content: 'Final answer only.' },
        {},
      ]
        .map(
          (delta, index) =>
            'data: ' +
            JSON.stringify({
              id: 'request-a',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'synthetic-model',
              choices: [{ index: 0, delta, finish_reason: index === 3 ? 'stop' : null }],
            }) +
            '\n\n',
        )
        .join('') + 'data: [DONE]\n\n';
    const Model = getChatModelClass(Providers.OPENAI);
    const model = new Model({
      model: 'synthetic-model',
      apiKey: 'synthetic-key',
      maxRetries: 0,
      configuration: {
        baseURL: 'http://example.test/v1',
        fetch: async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }),
      },
    });
    let observedMetadata;
    const run = await Run.create({
      runId: 'answer-a',
      graphConfig: {
        type: 'standard',
        agents: [
          {
            agentId: 'agent-a',
            llmConfig: { provider: Providers.OPENAI, apiKey: 'synthetic-key' },
          },
        ],
      },
      customHandlers: {
        [GraphEvents.CHAT_MODEL_STREAM]: {
          handle: async (event, data, meta, graph) => {
            if (
              data?.chunk?.additional_kwargs?.provider_specific_fields?.viventium?.assistant_preview
            ) {
              observedMetadata = meta;
              await handlers[GraphEvents.CHAT_MODEL_STREAM].handle(event, data, meta, graph);
            }
          },
        },
      },
      returnContent: true,
      skipCleanup: true,
    });
    run.Graph.overrideModel = model;
    await run.processStream(
      { messages: [{ role: 'user', content: 'Synthetic request.' }] },
      {
        configurable: { thread_id: 'conversation-a', last_agent_id: 'agent-a' },
        version: 'v2',
        streamMode: 'values',
      },
    );
    expect(observedMetadata).toMatchObject({ agentId: 'agent-a', messageId: 'answer-a' });
    expect(observedMetadata.last_agent_id).toBeUndefined();
    expect(GenerationJobManager.emitChunk).toHaveBeenCalledWith(
      'stream-a',
      expect.objectContaining({ preview: true, text: 'Timezone: UTC.', messageId: 'answer-a' }),
      identity,
    );
    expect(aggregateContent).not.toHaveBeenCalled();
  });
  it.each([
    'foreign-owner',
    'old-invocation',
    'old-revision',
    'background',
    'voice',
    'other-agent',
    'missing-agent',
    'invalid-agent',
  ])('rejects preview outside the current interactive author: %s', async (kind) => {
    const { req, handlers } = fixture(
      {},
      kind === 'background' ? { actor_kind: 'system', origin: 'scheduler' } : {},
    );
    const data = chunk();
    let meta = metadata;
    if (kind === 'foreign-owner') req.user.id = 'foreign';
    if (kind === 'old-invocation')
      data.chunk.additional_kwargs.provider_specific_fields.viventium.assistant_preview.invocation_id =
        'old';
    if (kind === 'old-revision') getStoredJob.mockResolvedValue(null);
    if (kind === 'voice')
      req._viventiumNativeResponseIdentity = { ...identity, deliveryContext: { surface: 'voice' } };
    if (kind === 'other-agent') meta = { ...metadata, agentId: 'other' };
    if (kind === 'missing-agent') meta = { last_agent_id: 'agent-a', langgraph_node: 'agent-a' };
    if (kind === 'invalid-agent') meta = { ...metadata, agentId: { toString: () => 'agent-a' } };
    await handlers[GraphEvents.CHAT_MODEL_STREAM].handle('', data, meta);
    expect(GenerationJobManager.emitChunk).not.toHaveBeenCalled();
  });
});
/* === VIVENTIUM END === */

describe('exact chunk delivery carrier to real SDK message delta', () => {
  test('a hidden specialist and stale metadata cannot enter Main resume text', async () => {
    const { getDefaultHandlers } = require('../callbacks');
    const { GenerationJobManager } = require('@librechat/api');
    jest.clearAllMocks();
    const aggregateContent = jest.fn();
    const req = {
      body: { voiceMode: true },
      viventiumCallSession: { callSessionId: 'synthetic' },
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              native: {
                messaging_delivery_disposition: true,
                messaging_delivery_disposition_version: 1,
              },
            },
          },
        },
      },
    };
    const handlers = getDefaultHandlers({
      req,
      res: {},
      aggregateContent,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'visible-only-resume',
    });
    const hidden = {
      agentId: 'specialist',
      hide_sequential_outputs: true,
      visible_agent_ids: ['main'],
    };
    const graph = {
      config: {},
      prelimMessageIdsByStepKey: new Map(),
      messageIdsByStepKey: new Map(),
      getAgentContext: () => ({ provider: 'native', currentTokenType: 'text' }),
      dispatchRunStep: jest.fn(async () => 'hidden-step'),
      getStepKey: () => 'hidden-key',
      getStepIdByKey: () => 'hidden-step',
      getRunStep: () => ({ type: 'message_creation' }),
      dispatchMessageDelta: (id, delta, metadata) =>
        handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
          GraphEvents.ON_MESSAGE_DELTA,
          { id, delta, agentId: 'specialist' },
          metadata,
        ),
    };
    await handlers[GraphEvents.CHAT_MODEL_STREAM].handle(
      GraphEvents.CHAT_MODEL_STREAM,
      {
        chunk: {
          content: 'Private specialist evidence.',
          additional_kwargs: {
            provider_specific_fields: {
              viventium: {
                delivery_disposition: {
                  version: 1,
                  audio: 'eligible',
                  source: 'model',
                  required: true,
                  valid: true,
                },
              },
            },
          },
        },
      },
      hidden,
      graph,
    );
    // The exact event actor is still hidden when a stale Main label reaches the callback.
    await handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
      GraphEvents.ON_MESSAGE_DELTA,
      {
        id: 'hidden-step',
        agentId: 'specialist',
        delta: { content: [{ type: 'text', text: 'Private stale role evidence.' }] },
      },
      { ...hidden, agentId: 'main' },
    );
    expect(
      GenerationJobManager.emitChunk.mock.calls.filter(
        ([, event]) => event.event === GraphEvents.ON_MESSAGE_DELTA,
      ),
    ).toEqual([]);
    expect(aggregateContent).not.toHaveBeenCalled();
  });

  it.each(['skip', 'eligible', 'missing'])(
    'keeps %s text visible and marks audio before emission',
    async (audio) => {
      const { getDefaultHandlers } = require('../callbacks');
      const { GenerationJobManager } = require('@librechat/api');
      const aggregateContent = jest.fn();
      const req = {
        body: { voiceMode: true },
        viventiumCallSession: { callSessionId: 'synthetic' },
        _viventiumDeliveryDispositionRequired: audio === 'skip' ? false : true,
        config: {
          endpoints: {
            agents: {
              providerCapabilities: {
                native: {
                  messaging_delivery_disposition: true,
                  messaging_delivery_disposition_version: 1,
                },
              },
            },
          },
        },
      };
      const handlers = getDefaultHandlers({
        req,
        res: {},
        aggregateContent,
        toolEndCallback: jest.fn(),
        collectedUsage: [],
        streamId: 'stream-carrier',
      });
      const graph = {
        config: {},
        prelimMessageIdsByStepKey: new Map(),
        messageIdsByStepKey: new Map(),
        getAgentContext: () => ({ provider: 'native', currentTokenType: 'text' }),
        dispatchRunStep: jest.fn(async () => 'step-carrier'),
        getStepKey: () => 'step-key',
        getStepIdByKey: () => 'step-carrier',
        getRunStep: () => ({ type: 'message_creation' }),
        dispatchMessageDelta: (id, delta, metadata) =>
          handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
            GraphEvents.ON_MESSAGE_DELTA,
            { id, delta, agentId: 'main' },
            metadata,
          ),
      };
      const disposition = { version: 1, audio, required: true, valid: true, source: 'model' };
      const chunk = {
        content: 'Report ready.',
        additional_kwargs:
          audio === 'missing'
            ? {}
            : {
                provider_specific_fields: { viventium: { delivery_disposition: disposition } },
              },
      };
      await handlers[GraphEvents.CHAT_MODEL_STREAM].handle(
        GraphEvents.CHAT_MODEL_STREAM,
        { chunk },
        { agentId: 'main' },
        graph,
      );
      const event = GenerationJobManager.emitChunk.mock.calls.find(
        ([, payload]) => payload.event === GraphEvents.ON_MESSAGE_DELTA,
      )?.[1];
      expect(event.data.delta.content).toEqual([{ type: 'text', text: 'Report ready.' }]);
      expect(event.data.delta.metadata.viventium.deliveryDisposition).toEqual(
        audio === 'missing'
          ? { version: 1, audio: 'skip', required: true, valid: false, source: 'required_missing' }
          : disposition,
      );
      expect(aggregateContent).toHaveBeenCalledWith(expect.objectContaining({ data: event.data }));
      expect(req._viventiumDeliveryDispositionCapture).toBeUndefined();
    },
  );
});

it.each(['eligible', 'skip', 'legacy'])(
  'preserves %s through actual ChatOpenAI raw chunks and SDK dispatch',
  async (audio) => {
    const { initializeModel } = require('@librechat/agents');
    const { getDefaultHandlers } = require('../callbacks');
    const { GenerationJobManager } = require('@librechat/api');
    const {
      attachEffectiveDeliveryDisposition,
    } = require('~/server/services/viventium/deliveryDisposition');
    const words = Array.from({ length: 20 }, (_, index) => `word${index} `);
    const modelDisposition = { version: 1, audio, required: true, valid: true, source: 'model' };
    const chunks = words.map((content) => ({
      id: 'synthetic',
      object: 'chat.completion.chunk',
      model: 'synthetic',
      choices: [
        {
          index: 0,
          delta: {
            content,
            ...(audio === 'legacy'
              ? {}
              : {
                  provider_specific_fields: {
                    viventium: {
                      delivery_disposition: modelDisposition,
                    },
                  },
                }),
          },
          finish_reason: null,
        },
      ],
    }));
    chunks.unshift({
      id: 'synthetic',
      object: 'chat.completion.chunk',
      model: 'synthetic',
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
    const body =
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const model = initializeModel({
      provider: 'openAI',
      clientOptions: {
        apiKey: 'synthetic-key',
        model: 'synthetic',
        streaming: true,
        __includeRawResponse: true,
        streamUsage: false,
        maxRetries: 0,
        configuration: {
          baseURL: 'http://synthetic.invalid/v1',
          fetch: async () =>
            new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
        },
      },
    });
    const req = {
      body: { voiceMode: true },
      viventiumCallSession: { callSessionId: 'synthetic' },
      _viventiumDeliveryDispositionRequired: audio === 'skip' ? false : true,
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              native: {
                messaging_delivery_disposition: true,
                messaging_delivery_disposition_version: 1,
              },
            },
          },
        },
      },
    };
    const aggregateContent = jest.fn();
    const handlers = getDefaultHandlers({
      req,
      res: {},
      aggregateContent,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: 'stream-real-adapter',
    });
    const graph = {
      config: {},
      prelimMessageIdsByStepKey: new Map(),
      messageIdsByStepKey: new Map(),
      getAgentContext: () => ({
        provider: audio === 'legacy' ? 'legacy' : 'native',
        currentTokenType: 'text',
        clientOptions: {},
      }),
      getBaseKeyList: (metadata) => [
        metadata.run_id,
        metadata.thread_id,
        metadata.langgraph_node,
        metadata.langgraph_step,
        metadata.langgraph_checkpoint_ns,
      ],
      getStepKey: () => 'step-key',
      getStepIdByKey: () => 'step-real',
      getRunStep: () => ({ type: 'message_creation' }),
      dispatchRunStep: jest.fn(),
      dispatchMessageDelta: (id, delta, metadata) =>
        handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
          GraphEvents.ON_MESSAGE_DELTA,
          { id, delta, agentId: 'main' },
          metadata,
        ),
    };
    const metadata = {
      agentId: 'main',
      run_id: 'model-run',
      thread_id: 'thread',
      langgraph_node: 'agent_main',
      langgraph_step: 3,
      langgraph_checkpoint_ns: 'checkpoint',
    };
    let finalChunk;
    for await (const chunk of await model.stream('Synthetic question.')) {
      finalChunk = finalChunk ? finalChunk.concat(chunk) : chunk;
      await handlers[GraphEvents.CHAT_MODEL_STREAM].handle(
        GraphEvents.CHAT_MODEL_STREAM,
        { chunk },
        metadata,
        graph,
      );
    }
    await handlers[GraphEvents.CHAT_MODEL_END].handle(
      GraphEvents.CHAT_MODEL_END,
      { output: finalChunk },
      metadata,
      graph,
    );
    const persisted = attachEffectiveDeliveryDisposition(req, {
      text: words.join(''),
      isCreatedByUser: false,
    });
    if (audio === 'legacy') {
      expect(persisted.metadata).toBeUndefined();
    } else {
      expect(persisted.metadata.viventium.deliveryDisposition).toEqual(modelDisposition);
    }
    const emitted = GenerationJobManager.emitChunk.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.event === GraphEvents.ON_MESSAGE_DELTA);
    expect(emitted).toHaveLength(20);
    expect(
      emitted
        .flatMap((event) => event.data.delta.content)
        .map((part) => part.text)
        .join(''),
    ).toBe(words.join(''));
    for (const event of emitted) {
      if (audio === 'legacy') expect(event.data.delta.metadata).toBeUndefined();
      else
        expect(event.data.delta.metadata.viventium.deliveryDisposition).toEqual(modelDisposition);
    }
  },
);

it('does not mute a legacy final after a capable reasoning-only attempt fails', async () => {
  const { getDefaultHandlers } = require('../callbacks');
  const {
    attachEffectiveDeliveryDisposition,
  } = require('~/server/services/viventium/deliveryDisposition');
  const { GenerationJobManager } = require('@librechat/api');
  const req = {
    body: { voiceMode: true },
    viventiumCallSession: { callSessionId: 'synthetic' },
    _viventiumDeliveryDispositionRequired: true,
    config: {
      endpoints: {
        agents: {
          providerCapabilities: {
            native: {
              messaging_delivery_disposition: true,
              messaging_delivery_disposition_version: 1,
            },
          },
        },
      },
    },
  };
  const handlers = getDefaultHandlers({
    req,
    res: {},
    aggregateContent: jest.fn(),
    toolEndCallback: jest.fn(),
    collectedUsage: [],
    streamId: 'stream-fallback',
  });
  let provider = 'native';
  const graph = {
    config: {},
    prelimMessageIdsByStepKey: new Map(),
    messageIdsByStepKey: new Map(),
    getAgentContext: () => ({ provider, currentTokenType: 'text', clientOptions: {} }),
    getStepKey: () => 'step-key',
    getStepIdByKey: () => 'step-fallback',
    getRunStep: () => ({ type: 'message_creation' }),
    dispatchRunStep: jest.fn(),
    dispatchMessageDelta: (id, delta, metadata) =>
      handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
        GraphEvents.ON_MESSAGE_DELTA,
        { id, delta, agentId: 'main' },
        metadata,
      ),
  };
  await handlers[GraphEvents.CHAT_MODEL_STREAM].handle(
    GraphEvents.CHAT_MODEL_STREAM,
    {
      chunk: {
        content: '',
        additional_kwargs: { reasoning_content: 'Synthetic internal reasoning.' },
      },
    },
    { agentId: 'main' },
    graph,
  );
  expect(req._viventiumDeliveryDispositionCapture).toBeUndefined();
  // The capable attempt throws before ModelEnd; the installed SDK then switches context.
  provider = 'legacy';
  await handlers[GraphEvents.CHAT_MODEL_STREAM].handle(
    GraphEvents.CHAT_MODEL_STREAM,
    { chunk: { content: 'Fallback answer.', additional_kwargs: {} } },
    { agentId: 'main' },
    graph,
  );
  await handlers[GraphEvents.CHAT_MODEL_END].handle(
    GraphEvents.CHAT_MODEL_END,
    { output: { content: 'Fallback answer.' } },
    { agentId: 'main' },
    graph,
  );
  expect(req._viventiumDeliveryDispositionRequired).toBe(false);
  expect(req._viventiumDeliveryDispositionCapture).toBeUndefined();
  const lastText = GenerationJobManager.emitChunk.mock.calls
    .map(([, event]) => event)
    .filter((event) => event.event === GraphEvents.ON_MESSAGE_DELTA)
    .at(-1);
  expect(lastText.data.delta.metadata).toBeUndefined();
  const durable = { text: 'Fallback answer.', isCreatedByUser: false };
  expect(attachEffectiveDeliveryDisposition(req, durable)).toEqual(durable);
});

/* === VIVENTIUM START === Final delivery uses exact invocation chunk envelopes. === */
describe('whole delivery envelopes at ModelEnd', () => {
  const contract = (audio = 'eligible') => ({
    version: 1,
    audio,
    required: true,
    valid: true,
    source: 'model',
  });
  const setup = () => {
    const { getDefaultHandlers } = require('../callbacks');
    const req = {
      body: { voiceMode: true },
      viventiumCallSession: { callSessionId: 'synthetic' },
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              native: {
                messaging_delivery_disposition: true,
                messaging_delivery_disposition_version: 1,
              },
            },
          },
        },
      },
    };
    let provider = 'native';
    const handlers = getDefaultHandlers({
      req,
      res: {},
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      streamId: null,
    });
    const graph = {
      config: {},
      prelimMessageIdsByStepKey: new Map(),
      messageIdsByStepKey: new Map(),
      getAgentContext: () => ({ provider, currentTokenType: 'text', clientOptions: {} }),
      getBaseKeyList: (metadata) => [
        metadata.run_id,
        metadata.thread_id,
        metadata.langgraph_node,
        metadata.langgraph_step,
        metadata.langgraph_checkpoint_ns,
      ],
      getStepKey: () => 'step-key',
      getStepIdByKey: () => 'step-final',
      getRunStep: () => ({ type: 'message_creation' }),
      dispatchRunStep: jest.fn(),
      dispatchMessageDelta: jest.fn(),
    };
    const meta = (agent, step) => ({
      agentId: agent,
      run_id: 'run',
      thread_id: 'thread',
      langgraph_node: `agent_${agent}`,
      langgraph_step: step,
      langgraph_checkpoint_ns: 'checkpoint',
    });
    const stream = async (metadata, disposition) => {
      const { AIMessageChunk } = require('@langchain/core/messages');
      const chunk = () =>
        new AIMessageChunk({
          content: 'Result. ',
          additional_kwargs: {
            provider_specific_fields: { viventium: { delivery_disposition: disposition } },
          },
        });
      const first = chunk();
      const second = chunk();
      for (const value of [first, second])
        await handlers[GraphEvents.CHAT_MODEL_STREAM].handle(
          GraphEvents.CHAT_MODEL_STREAM,
          { chunk: value },
          metadata,
          graph,
        );
      return first.concat(second);
    };
    const end = (metadata, output) =>
      handlers[GraphEvents.CHAT_MODEL_END].handle(
        GraphEvents.CHAT_MODEL_END,
        { output },
        metadata,
        graph,
      );
    const start = (metadata) =>
      handlers[GraphEvents.CHAT_MODEL_START].handle(
        GraphEvents.CHAT_MODEL_START,
        {},
        metadata,
        graph,
      );
    return {
      req,
      meta,
      stream,
      end,
      start,
      setProvider: (value) => {
        provider = value;
      },
    };
  };

  it.each(['eligible', 'skip'])(
    'keeps final %s through Main → specialist → Main tool invocations',
    async (audio) => {
      const { req, meta, stream, end, start } = setup();
      for (const [agent, step] of [
        ['main', 0],
        ['specialist', 1],
      ]) {
        const metadata = meta(agent, step);
        await start(metadata);
        const output = await stream(metadata, contract('skip'));
        output.tool_calls = [{ id: `handoff-${step}`, name: 'transfer', args: {} }];
        await end(metadata, output);
        expect(req._viventiumDeliveryDispositionCapture).toBeUndefined();
      }
      const final = meta('main', 2);
      await start(final);
      await end(final, await stream(final, contract(audio)));
      expect(req._viventiumDeliveryDispositionCapture).toEqual({
        status: 'valid',
        disposition: contract(audio),
      });
      // Consuming an invocation cannot feed a later same-agent missing contract.
      await end(meta('main', 3), { content: 'A later result with no contract.' });
      expect(req._viventiumDeliveryDispositionCapture).toEqual({ status: 'missing' });
    },
  );

  it('retains malformed and skip precedence within one invocation', async () => {
    const { req, meta, stream, end, start } = setup();
    const first = meta('main', 0);
    await start(first);
    await stream(first, contract('skip'));
    await end(first, await stream(first, contract('eligible')));
    expect(req._viventiumDeliveryDispositionCapture).toEqual({
      status: 'valid',
      disposition: contract('skip'),
    });
    const next = meta('main', 1);
    await start(next);
    await stream(next, { ...contract(), version: 2 });
    await end(next, await stream(next, contract()));
    expect(req._viventiumDeliveryDispositionCapture).toEqual({ status: 'malformed' });
  });

  it.each(['native', 'legacy'])(
    'drops an interrupted attempt before its %s replacement',
    async (provider) => {
      const { req, meta, stream, end, start, setProvider } = setup();
      const metadata = meta('main', 0);
      await start(metadata);
      await stream(metadata, contract('skip'));
      // The failed attempt has no ModelEnd; the actual next model start owns cleanup.
      setProvider(provider);
      await start(metadata);
      await end(metadata, { content: 'Replacement response.' });
      expect(req._viventiumDeliveryDispositionRequired).toBe(provider === 'native');
      expect(req._viventiumDeliveryDispositionCapture).toEqual(
        provider === 'native' ? { status: 'missing' } : undefined,
      );
    },
  );
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Native selected output follows exact visible invocation, never concatenated ids. === */
describe('typed native output attachments at the actual SDK callback boundary', () => {
  const setup = () => {
    const { getDefaultHandlers } = require('../callbacks');
    const {
      inspectNativeOutputFileCarrier,
      nativeOutputFilePublisherFromContext,
    } = require('@librechat/api');
    nativeOutputFilePublisherFromContext.mockReset();
    inspectNativeOutputFileCarrier.mockImplementation((chunk) => {
      const raw = chunk?.additional_kwargs?.__raw_response;
      const envelope = raw?.glasshive?.output_files;
      if (!envelope) return undefined;
      if (raw.id !== envelope.request_id) throw new Error('invalid');
      return { envelope, requestId: raw.id };
    });
    const callback = jest.fn();
    let provider = 'native';
    const req = {
      body: {},
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              native: { workspace_binding: true, conversation_session: true },
            },
          },
        },
      },
    };
    const handlers = getDefaultHandlers({
      req,
      res: {},
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      nativeOutputCallback: callback,
    });
    const graph = {
      config: {},
      prelimMessageIdsByStepKey: new Map(),
      messageIdsByStepKey: new Map(),
      getAgentContext: (metadata) => ({
        provider,
        agentId: metadata.agentId,
        currentTokenType: 'text',
        clientOptions: {},
      }),
      getBaseKeyList: (metadata) => [metadata.agentId, metadata.langgraph_step],
      getStepKey: () => 'step',
      getStepIdByKey: () => 'step-id',
      getRunStep: () => ({ type: 'message_creation' }),
      dispatchRunStep: jest.fn(),
      dispatchMessageDelta: jest.fn(),
    };
    const metadata = { agentId: 'main', langgraph_node: 'agent_main', langgraph_step: 1 };
    const envelope = { request_id: 'request-one', files: [{ filename: 'result.csv' }] };
    const { AIMessageChunk } = require('@langchain/core/messages');
    const chunk = (carrier = envelope) =>
      new AIMessageChunk({
        content: 'Useful. ',
        additional_kwargs: {
          __raw_response: {
            id: carrier.request_id,
            object: 'chat.completion.chunk',
            glasshive: { output_files: carrier },
          },
        },
      });
    const stream = async (meta = metadata, carrier = envelope) => {
      const first = chunk(carrier),
        second = chunk(carrier);
      for (const item of [first, second])
        await handlers[GraphEvents.CHAT_MODEL_STREAM].handle('', { chunk: item }, meta, graph);
      return first.concat(second);
    };
    const end = (output, meta = metadata) =>
      handlers[GraphEvents.CHAT_MODEL_END].handle('', { output }, meta, graph);
    return {
      handlers,
      graph,
      metadata,
      envelope,
      callback,
      stream,
      end,
      provider: (value) => {
        provider = value;
      },
    };
  };
  test('visible final uses whole current carrier once without trusting aggregate identity', async () => {
    const t = setup();
    const aggregate = await t.stream();
    // The public SDK reducer retains an aggregate; only pre-merge observations own this receipt.
    aggregate.additional_kwargs.__raw_response.id = 'aggregate-identity';
    await t.end(aggregate);
    expect(t.callback).toHaveBeenCalledTimes(1);
    expect(t.callback).toHaveBeenCalledWith(
      { envelope: t.envelope, requestId: 'request-one' },
      'main',
    );
    await t.end(aggregate);
    expect(t.callback).toHaveBeenCalledTimes(1);
  });
  test('handoff tool calls do not publish their incidental file references', async () => {
    const t = setup();
    const aggregate = await t.stream();
    aggregate.tool_calls = [{ id: 'handoff', name: 'transfer', args: {} }];
    await t.end(aggregate);
    expect(t.callback).not.toHaveBeenCalled();
  });
  test('native consultant seals its own route before a non-native Main flushes the carrier', async () => {
    const t = setup();
    const publisher = { providerId: 'native', originSha256: 'a'.repeat(64) };
    const { nativeOutputFilePublisherFromContext } = require('@librechat/api');
    nativeOutputFilePublisherFromContext.mockReturnValue(publisher);
    t.graph.getAgentContext = (metadata) => ({
      provider: metadata.agentId === 'specialist' ? 'native' : 'legacy',
      agentId: metadata.agentId,
      currentTokenType: 'text',
      clientOptions: { configuration: { baseURL: 'https://publisher.example.test/v1' } },
    });
    const hidden = {
      ...t.metadata,
      agentId: 'specialist',
      langgraph_node: 'agent_specialist',
      hide_sequential_outputs: true,
      visible_agent_ids: ['main'],
    };
    const transfer = await t.stream(hidden);
    transfer.tool_calls = [{ id: 'transfer', name: 'handoff', args: {} }];
    await t.end(transfer, hidden);
    await t.end({ content: 'The result is ready.' });
    expect(nativeOutputFilePublisherFromContext).toHaveBeenCalledWith({
      providerId: 'native',
      baseURL: 'https://publisher.example.test/v1',
      capability: { workspace_binding: true, conversation_session: true },
    });
    expect(t.callback).toHaveBeenCalledWith(
      { envelope: t.envelope, requestId: 'request-one', publisher },
      'specialist',
    );
  });
  test('selected transfer files wait for visible Main and retain the original publisher', async () => {
    const t = setup();
    const hidden = {
      ...t.metadata,
      agentId: 'specialist',
      langgraph_node: 'agent_specialist',
      hide_sequential_outputs: true,
      visible_agent_ids: ['main'],
      last_agent_id: 'main',
    };
    const transfer = await t.stream(hidden);
    transfer.tool_calls = [{ id: 'handoff', name: 'transfer', args: {} }];
    await t.end(transfer, hidden);
    expect(t.callback).not.toHaveBeenCalled();
    await t.end({ content: 'The requested result is ready.' });
    expect(t.callback).toHaveBeenCalledTimes(1);
    expect(t.callback).toHaveBeenCalledWith(
      { envelope: t.envelope, requestId: 'request-one' },
      'specialist',
    );
    await t.end({ content: 'The requested result is ready.' });
    expect(t.callback).toHaveBeenCalledTimes(1);
  });
  test('duplicate transfer carriers flush once and preserve distinct published requests', async () => {
    const t = setup();
    for (const [step, carrier] of [
      [1, t.envelope],
      [2, t.envelope],
      [3, { request_id: 'request-two', files: [{ filename: 'second.csv' }] }],
    ]) {
      const metadata = {
        ...t.metadata,
        agentId: 'specialist',
        langgraph_node: 'agent_specialist',
        langgraph_step: step,
        hide_sequential_outputs: true,
        visible_agent_ids: ['main'],
      };
      const output = await t.stream(metadata, carrier);
      output.tool_calls = [{ id: 'handoff', name: 'transfer', args: {} }];
      await t.end(output, metadata);
    }
    expect(t.callback).not.toHaveBeenCalled();
    await t.end({ content: 'Both results are ready.' });
    expect(t.callback).toHaveBeenCalledTimes(2);
    expect(t.callback.mock.calls.map(([carrier]) => carrier.requestId)).toEqual([
      'request-one',
      'request-two',
    ]);
  });
  test('a hidden final cannot emit a retained transfer carrier', async () => {
    const t = setup();
    const transfer = await t.stream();
    transfer.tool_calls = [{ id: 'handoff', name: 'transfer', args: {} }];
    await t.end(transfer);
    const hidden = {
      ...t.metadata,
      agentId: 'specialist',
      langgraph_node: 'agent_specialist',
      hide_sequential_outputs: true,
      visible_agent_ids: ['main'],
    };
    await t.end({ content: 'Private specialist result.' }, hidden);
    expect(t.callback).not.toHaveBeenCalled();
  });
  test('a refused final cannot emit a retained transfer carrier', async () => {
    const t = setup();
    const transfer = await t.stream();
    transfer.tool_calls = [{ id: 'handoff', name: 'transfer', args: {} }];
    await t.end(transfer);
    await expect(
      t.end({ content: '', additional_kwargs: { stop_reason: 'refusal' } }),
    ).rejects.toThrow();
    expect(t.callback).not.toHaveBeenCalled();
  });
  test('an interrupted graph never emits its transfer carrier into another graph', async () => {
    const interrupted = setup();
    const transfer = await interrupted.stream();
    transfer.tool_calls = [{ id: 'handoff', name: 'transfer', args: {} }];
    await interrupted.end(transfer);
    const replacement = setup();
    await replacement.end({ content: 'Replacement result.' });
    expect(interrupted.callback).not.toHaveBeenCalled();
    expect(replacement.callback).not.toHaveBeenCalled();
  });
  test('a selected hidden terminal waits for Main and keeps its exact publisher carrier', async () => {
    const t = setup();
    const hidden = {
      ...t.metadata,
      agentId: 'specialist',
      langgraph_node: 'agent_specialist',
      hide_sequential_outputs: true,
      visible_agent_ids: ['main'],
    };
    const final = await t.stream(hidden);
    final.tool_calls = [];
    await t.end(final, hidden);
    expect(t.callback).not.toHaveBeenCalled();
    await t.end({ content: 'The requested artifact is verified.' });
    expect(t.callback).toHaveBeenCalledTimes(1);
    expect(t.callback).toHaveBeenCalledWith(
      { envelope: t.envelope, requestId: 'request-one' },
      'specialist',
    );
    await t.end({ content: 'The requested artifact is verified.' });
    expect(t.callback).toHaveBeenCalledTimes(1);
  });
  test('a refused Main clears a selected hidden terminal without publishing it', async () => {
    const t = setup();
    const hidden = {
      ...t.metadata,
      agentId: 'specialist',
      langgraph_node: 'agent_specialist',
      hide_sequential_outputs: true,
      visible_agent_ids: ['main'],
    };
    await t.end(await t.stream(hidden), hidden);
    await expect(
      t.end({ content: '', additional_kwargs: { stop_reason: 'refusal' } }),
    ).rejects.toThrow();
    await t.end({ content: 'Another final.' });
    expect(t.callback).not.toHaveBeenCalled();
  });
  test('a provider replacement cannot retain a hidden terminal carrier', async () => {
    const t = setup();
    const hidden = {
      ...t.metadata,
      agentId: 'specialist',
      langgraph_node: 'agent_specialist',
      hide_sequential_outputs: true,
      visible_agent_ids: ['main'],
    };
    const final = await t.stream(hidden);
    t.provider('legacy');
    await t.end(final, hidden);
    await t.end({ content: 'No selected output.' });
    expect(t.callback).not.toHaveBeenCalled();
  });
  test('hidden specialist output never exports selected files', async () => {
    const t = setup();
    const metadata = {
      ...t.metadata,
      agentId: 'specialist',
      langgraph_node: 'agent_specialist',
      hide_sequential_outputs: true,
      visible_agent_ids: ['main'],
      last_agent_id: 'main',
    };
    await t.end(await t.stream(metadata), metadata);
    expect(t.callback).not.toHaveBeenCalled();
  });
  test('provider replacement cannot reuse a captured file carrier from the failed attempt', async () => {
    const t = setup();
    const aggregate = await t.stream();
    t.provider('legacy');
    await t.end(aggregate);
    expect(t.callback).not.toHaveBeenCalled();
  });
  test('next model start clears old carrier even when the graph key is reused', async () => {
    const t = setup();
    await t.stream();
    await t.handlers[GraphEvents.CHAT_MODEL_START].handle('', {}, t.metadata, t.graph);
    await t.end({ content: 'Replacement result.' });
    expect(t.callback).not.toHaveBeenCalled();
  });
});
/* === VIVENTIUM END === */

/* === VIVENTIUM START === Complete public parts use the existing native producer fence. === */
describe('native public content part completion', () => {
  const { getDefaultHandlers } = require('../callbacks');
  const { GenerationJobManager, createReleasedMainPublicPartOwner } = require('@librechat/api');
  const identity = {
    userId: 'owner-a',
    conversationId: 'conversation-a',
    responseMessageId: 'answer-a',
    streamId: 'stream-a',
    jobCreatedAt: 1,
    logicalTurnId: 'turn-a',
    revision: 1,
    invocationId: 'invocation-a',
    agentId: 'agent-a',
    source: { id: 'source-a', messageId: 'question-a', digest: 'a'.repeat(64) },
    deliveryContext: { surface: 'voice' },
  };
  const disposition = {
    version: 1,
    audio: 'eligible',
    required: true,
    valid: true,
    source: 'model',
  };
  const completion = {
    version: 1,
    complete: true,
    request_id: 'request-a',
    run_id: 'run-a',
    part_id: 'run-a:0',
    message_id: 'answer-a',
    stream_id: 'stream-a',
  };
  const makeChunk = (text = '', marker = completion, audio = disposition) => ({
    chunk: {
      content: text,
      additional_kwargs: {
        __raw_response: {
          id: marker.request_id,
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              finish_reason: null,
              delta: {
                content: text,
                provider_specific_fields: {
                  viventium: {
                    public_part_complete: marker,
                    delivery_disposition: audio,
                  },
                },
              },
            },
          ],
        },
      },
    },
  });
  const setup = (interactionOverrides = {}) => {
    jest.clearAllMocks();
    const req = {
      user: { id: 'owner-a' },
      body: { voiceMode: true },
      viventiumCallSession: { callSessionId: 'call-a' },
      _viventiumHarnessExecutionEnabled: true,
      _viventiumNativeResponseIdentity: identity,
      config: {
        endpoints: {
          agents: {
            providerCapabilities: {
              native: {
                messaging_delivery_disposition: true,
                messaging_delivery_disposition_version: 1,
              },
            },
          },
        },
      },
    };
    require('~/server/services/viventium/interactionContext').setTrustedInteractionContext(req, {
      version: 1,
      actor_kind: 'external_user',
      origin: 'interactive',
      logical_turn_id: 'turn-a',
      revision: 1,
      source_event_id: 'source-a',
      surface: 'voice',
      ...interactionOverrides,
    });
    const job = {
      userId: identity.userId,
      streamId: identity.streamId,
      createdAt: 1,
      conversationId: identity.conversationId,
      responseMessageId: identity.responseMessageId,
      userMessage: { messageId: 'question-a' },
      status: 'running',
      interactionContext: { logical_turn_id: 'turn-a', revision: 1 },
      nativeResponse: identity,
    };
    const getJob = jest.fn(async () => job);
    GenerationJobManager.getJobStore.mockReturnValue({ getJob });
    const aggregateContent = jest.fn();
    const handlers = getDefaultHandlers({
      req,
      res: {},
      streamId: 'stream-a',
      aggregateContent,
      toolEndCallback: jest.fn(),
      collectedUsage: [],
    });
    const metadata = { agentId: 'agent-a' };
    const context = { provider: 'native', currentTokenType: 'text', clientOptions: {} };
    const graph = {
      config: {},
      prelimMessageIdsByStepKey: new Map(),
      messageIdsByStepKey: new Map(),
      getAgentContext: () => context,
      getStepKey: () => 'step-key',
      getStepIdByKey: () => 'public-step',
      getRunStep: () => ({ type: 'message_creation' }),
      dispatchRunStep: jest.fn(),
      dispatchReasoningDelta: jest.fn(),
      dispatchMessageDelta: (id, delta, meta) =>
        handlers[GraphEvents.ON_MESSAGE_DELTA].handle(
          GraphEvents.ON_MESSAGE_DELTA,
          { id, delta, agentId: 'agent-a' },
          meta,
        ),
    };
    const emit = (data = makeChunk(), meta = metadata) =>
      handlers[GraphEvents.CHAT_MODEL_STREAM].handle(
        GraphEvents.CHAT_MODEL_STREAM,
        data,
        meta,
        graph,
      );
    const controls = () =>
      GenerationJobManager.emitChunk.mock.calls.filter(
        ([, event]) => event.event === 'on_public_content_part_complete',
      );
    return { req, job, getJob, aggregateContent, metadata, context, graph, emit, controls };
  };
  it('awaits the final public bytes, then emits once without aggregating the control', async () => {
    const { req, job, getJob, emit, controls, aggregateContent } = setup();
    expect(
      require('@librechat/api').inspectProviderPublicPartCompletion(makeChunk().chunk),
    ).toEqual(completion);
    expect(require('@librechat/api').isAudioDeliveryRequested(req)).toBe(true);
    expect(
      require('~/server/services/viventium/interactionContext').getTrustedInteractionContext(req),
    ).toMatchObject({
      actor_kind: 'external_user',
      origin: 'interactive',
      logical_turn_id: 'turn-a',
      revision: 1,
    });
    expect(require('@librechat/api').nativeJobMatches(job, identity)).toBe(true);
    const order = [];
    GenerationJobManager.emitChunk.mockImplementation(async (_stream, event) => {
      await Promise.resolve();
      order.push(event.event);
      return { delivered: true };
    });
    await emit(makeChunk('<emphasis>Cobalt blue.</emphasis>'));
    await emit();
    expect(getJob).toHaveBeenCalled();
    expect(order).toEqual([GraphEvents.ON_MESSAGE_DELTA, 'on_public_content_part_complete']);
    expect(controls()).toEqual([
      [
        'stream-a',
        {
          event: 'on_public_content_part_complete',
          data: { completion, deliveryDisposition: disposition },
        },
        identity,
      ],
    ]);
    expect(aggregateContent).toHaveBeenCalledTimes(1);
    expect(aggregateContent.mock.calls[0][0].data.delta.content).toEqual([
      { type: 'text', text: '<emphasis>Cobalt blue.</emphasis>' },
    ]);
  });
  it('keeps completion-only chunks, later parts, and a new native graph invocation', async () => {
    const { req, job, emit, controls } = setup();
    await emit();
    await emit(makeChunk('Later answer.', { ...completion, part_id: 'run-a:1' }));
    req._viventiumNativeResponseIdentity = { ...identity, invocationId: 'invocation-next' };
    job.nativeResponse = req._viventiumNativeResponseIdentity;
    await emit(
      makeChunk('', {
        ...completion,
        request_id: 'request-next',
        run_id: 'run-next',
        part_id: 'run-next:0',
      }),
    );
    expect(controls()).toHaveLength(3);
    expect(controls().at(-1)[2].invocationId).toBe('invocation-next');
  });
  it('deduplicates concurrent repeated complete chunks after the job read', async () => {
    const { emit, controls } = setup();
    await Promise.all([emit(), emit(), emit()]);
    expect(controls()).toHaveLength(1);
  });
  it.each([
    'foreign-owner',
    'foreign-stream',
    'foreign-message',
    'foreign-request',
    'other-agent',
    'hidden-agent',
    'background',
    'old-turn',
    'disabled',
    'text-only',
    'job-missing',
    'job-binding',
    'aborted',
    'superseded',
    'error',
    'settled',
    'skip',
    'malformed-disposition',
    'tool-step',
    'reasoning',
    'tool-envelope',
  ])('rejects invalid completion: %s', async (kind) => {
    const f = setup(kind === 'background' ? { actor_kind: 'system', origin: 'scheduler' } : {});
    const data = makeChunk();
    const raw = data.chunk.additional_kwargs.__raw_response;
    let meta = f.metadata;
    if (kind === 'foreign-owner') f.req.user.id = 'other';
    if (kind === 'foreign-stream')
      raw.choices[0].delta.provider_specific_fields.viventium.public_part_complete = {
        ...completion,
        stream_id: 'other',
      };
    if (kind === 'foreign-message')
      raw.choices[0].delta.provider_specific_fields.viventium.public_part_complete = {
        ...completion,
        message_id: 'other',
      };
    if (kind === 'foreign-request') raw.id = 'other';
    if (kind === 'other-agent') meta = { agentId: 'other' };
    if (kind === 'hidden-agent')
      meta = {
        agentId: 'agent-a',
        hide_sequential_outputs: true,
        visible_agent_ids: ['different-main'],
      };
    if (kind === 'old-turn') f.job.interactionContext.revision = 2;
    if (kind === 'disabled') f.req._viventiumHarnessExecutionEnabled = false;
    if (kind === 'text-only') f.req.body.voiceMode = false;
    if (kind === 'job-missing') f.getJob.mockResolvedValue(null);
    if (kind === 'job-binding') f.job.nativeResponse = { ...identity, invocationId: 'other' };
    if (['aborted', 'superseded', 'error'].includes(kind)) f.job.status = kind;
    if (kind === 'settled') f.job.nativeResponseSettled = true;
    if (kind === 'skip')
      raw.choices[0].delta.provider_specific_fields.viventium.delivery_disposition = {
        ...disposition,
        audio: 'skip',
      };
    if (kind === 'malformed-disposition')
      raw.choices[0].delta.provider_specific_fields.viventium.delivery_disposition = {
        audio: 'eligible',
      };
    if (kind === 'tool-step') f.graph.getRunStep = () => ({ type: 'tool_calls' });
    if (kind === 'reasoning') f.context.currentTokenType = 'thinking';
    if (kind === 'tool-envelope') raw.choices[0].delta.tool_calls = [{ id: 'tool-a' }];
    await f.emit(data, meta);
    expect(f.controls()).toHaveLength(0);
    expect(f.aggregateContent).not.toHaveBeenCalled();
  });
  it('keeps the later Main marker after the real unsupported-release job shape', async () => {
    const f = setup();
    delete f.job.nativeResponse;
    f.job.nativeResponseSettled = true;
    f.job.generationCompleted = false;
    f.job.nativeResponseCancelled = false;
    await f.emit(makeChunk('Later Main narration.'));
    expect(f.controls()).toHaveLength(1);
    expect(createReleasedMainPublicPartOwner).toHaveBeenCalledWith(
      identity,
      expect.objectContaining({
        getNativeResponse: expect.any(Function),
        nativeResponseSourceMatches: expect.any(Function),
      }),
    );
    expect(f.controls()[0][2].publicPartOwner.identity).toEqual(identity);
    expect(f.aggregateContent).toHaveBeenCalledTimes(1);
  });
  it.each(['cancelled', 'generation-complete', 'replaced'])(
    'keeps released Core %s fenced',
    async (kind) => {
      const f = setup();
      delete f.job.nativeResponse;
      f.job.nativeResponseSettled = true;
      if (kind === 'cancelled') f.job.nativeResponseCancelled = true;
      if (kind === 'generation-complete') f.job.generationCompleted = true;
      if (kind === 'replaced') f.job.createdAt = identity.jobCreatedAt + 1;
      await f.emit();
      expect(f.controls()).toHaveLength(0);
    },
  );
  it.each(['web', 'telegram'])('keeps ordinary %s delivery unchanged', async (surface) => {
    const { req, emit, controls } = setup();
    req.body.voiceMode = false;
    req._viventiumNativeResponseIdentity = { ...identity, deliveryContext: { surface } };
    await emit(makeChunk('Normal answer.'));
    expect(controls()).toHaveLength(0);
    expect(GenerationJobManager.emitChunk.mock.calls.map(([, event]) => event.event)).toEqual([
      GraphEvents.ON_MESSAGE_DELTA,
    ]);
  });
  it('keeps raw completion-only chunks through the real model adapter and SDK, then delivers later text', async () => {
    const { initializeModel } = require('@librechat/agents');
    const { emit, controls, aggregateContent } = setup();
    const words = Array.from({ length: 32 }, (_, index) => `word${index} `);
    const raw = (content, marker) => ({
      id: 'request-a',
      object: 'chat.completion.chunk',
      model: 'synthetic',
      choices: [
        {
          index: 0,
          finish_reason: null,
          delta: {
            content,
            provider_specific_fields: {
              viventium: {
                delivery_disposition: disposition,
                ...(marker ? { public_part_complete: marker } : {}),
              },
            },
          },
        },
      ],
    });
    const chunks = [
      raw(''),
      ...words.map((text) => raw(text)),
      raw('', completion),
      raw('<emphasis>Later words.</emphasis>', { ...completion, part_id: 'run-a:1' }),
      raw('The file could not be delivered.'),
    ];
    chunks[0].choices[0].delta.role = 'assistant';
    const body =
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const model = initializeModel({
      provider: 'openAI',
      clientOptions: {
        apiKey: 'synthetic-key',
        model: 'synthetic',
        streaming: true,
        __includeRawResponse: true,
        streamUsage: false,
        maxRetries: 0,
        configuration: {
          baseURL: 'http://synthetic.invalid/v1',
          fetch: async () =>
            new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
        },
      },
    });
    const eventOrder = [];
    GenerationJobManager.emitChunk.mockImplementation(async (_stream, event) => {
      eventOrder.push(event.event);
      return { delivered: true };
    });
    for await (const chunk of await model.stream([['human', 'Synthetic request.']])) {
      const marker =
        chunk.additional_kwargs.__raw_response?.choices?.[0]?.delta?.provider_specific_fields
          ?.viventium?.public_part_complete;
      if (marker) {
        expect(require('@librechat/api').inspectProviderPublicPartCompletion(chunk)).toEqual(
          marker,
        );
      }
      await emit({ chunk });
    }
    const visibleText = aggregateContent.mock.calls
      .map(([event]) => event.data.delta.content)
      .flat()
      .map((part) => part.text || '')
      .join('');
    expect(visibleText).toBe(
      words.join('') + '<emphasis>Later words.</emphasis>' + 'The file could not be delivered.',
    );
    expect(controls().map(([, event]) => event.data.completion.part_id)).toEqual([
      'run-a:0',
      'run-a:1',
    ]);
    expect(eventOrder.slice(0, 32)).toEqual(Array(32).fill(GraphEvents.ON_MESSAGE_DELTA));
    expect(eventOrder.slice(32)).toEqual([
      'on_public_content_part_complete',
      GraphEvents.ON_MESSAGE_DELTA,
      'on_public_content_part_complete',
      GraphEvents.ON_MESSAGE_DELTA,
    ]);
  });
});
/* === VIVENTIUM END === */
