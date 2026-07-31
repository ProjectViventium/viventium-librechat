const { Constants } = require('librechat-data-provider');
const crypto = require('crypto');

const mockEmitChunk = jest.fn();
jest.mock('@librechat/agents', () => ({
  GraphEvents: { ON_REASONING_DELTA: 'on_reasoning_delta' },
}));
jest.mock('@librechat/api', () => ({
  GenerationJobManager: { emitChunk: mockEmitChunk },
}));

jest.mock('../GlassHiveCapabilityBootstrapService', () => ({
  buildConversationProviderBootstrapBundle: jest.fn(),
}));

const {
  buildConversationProviderBootstrapBundle,
} = require('../GlassHiveCapabilityBootstrapService');
const {
  attachConversationProviderCapabilityBundle,
  bindHarnessCancellation,
  buildHarnessIdempotencyKey,
  declaredMcpServerNames,
} = require('../GlassHiveConversationProviderService');

describe('GlassHiveConversationProviderService', () => {
  const originalBrokerSecret = process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = 'synthetic-bundle-secret';
  });

  afterAll(() => {
    if (originalBrokerSecret === undefined) {
      delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    } else {
      process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET = originalBrokerSecret;
    }
  });

  test('builds stable role-scoped keys for main, Phase B, and parallel cortices', () => {
    expect(buildHarnessIdempotencyKey('main', 'response-1')).toBe('main:response-1');
    expect(buildHarnessIdempotencyKey('phase_b', 'response-1', 'main-agent')).toBe(
      'phase_b:main-agent:response-1',
    );
    expect(buildHarnessIdempotencyKey('cortex', 'response-1', 'research')).toBe(
      'cortex:research:response-1',
    );
    expect(buildHarnessIdempotencyKey('cortex', 'response-1', 'red-team')).not.toBe(
      buildHarnessIdempotencyKey('cortex', 'response-1', 'research'),
    );
  });

  test('delivers an intentional Stop to the exact authenticated main request', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    const onDeliveryError = jest.fn();
    const req = {
      _viventiumHarnessExecutionEnabled: true,
      _viventiumHarnessActivityEnabled: true,
      _viventiumHarnessIdempotencyKey: 'main:response-1',
      _resumableStreamId: 'stream-synthetic',
      body: { responseMessageId: 'response-wrong' },
      user: { id: 'user-synthetic' },
    };

    expect(
      bindHarnessCancellation({
        req,
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1/', apiKey: 'synthetic-key' },
        fetchImpl,
        onDeliveryError,
      }),
    ).toBe(true);

    abortController.abort('user_cancelled');
    await abortController.signal._viventiumHarnessCancellationDelivery;
    await new Promise((resolve) => setImmediate(resolve));

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://glasshive.local/v1/requests/by-idempotency/main%3Aresponse-1/cancel',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer synthetic-key',
          'X-Viventium-User-Id': 'user-synthetic',
        },
      }),
    );
    expect(onDeliveryError).not.toHaveBeenCalled();
    expect(mockEmitChunk).toHaveBeenCalledWith(
      'stream-synthetic',
      expect.objectContaining({
        data: {
          id: 'stream-synthetic-harness-cancelled',
          delta: {
            content: [
              {
                type: 'harness_activity',
                harness_activity: {
                  event: 'cancelled',
                  summary: 'The harness turn was cancelled.\n',
                },
              },
            ],
          },
        },
      }),
    );
  });

  test('delivers an intentional Stop when the signal was already aborted before binding', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    abortController.abort('user_cancelled');

    expect(
      bindHarnessCancellation({
        req: {
          _viventiumHarnessExecutionEnabled: true,
          _viventiumHarnessIdempotencyKey: 'main:response-pre-aborted',
          user: { id: 'user-synthetic' },
        },
        signal: abortController.signal,
        endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
        fetchImpl,
      }),
    ).toBe(true);

    await expect(abortController.signal._viventiumHarnessCancellationDelivery).resolves.toEqual({
      delivered: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('acknowledges native cancellation without waiting for activity delivery', async () => {
    const abortController = new AbortController();
    const onDeliveryError = jest.fn();
    mockEmitChunk.mockImplementationOnce(() => new Promise(() => {}));

    bindHarnessCancellation({
      req: {
        _viventiumHarnessExecutionEnabled: true,
        _viventiumHarnessActivityEnabled: true,
        _viventiumHarnessIdempotencyKey: 'main:response-stalled-activity',
        _resumableStreamId: 'stream-stalled-activity',
        user: { id: 'user-synthetic' },
      },
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl: jest.fn().mockResolvedValue({ ok: true }),
      onDeliveryError,
      activityDeliveryTimeoutMs: 1,
    });

    abortController.abort('user_cancelled');

    await expect(abortController.signal._viventiumHarnessCancellationDelivery).resolves.toEqual({
      delivered: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(onDeliveryError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'GlassHive cancellation activity delivery timed out' }),
    );
  });

  test('does not cancel the native run for a transport disconnect', async () => {
    const abortController = new AbortController();
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    bindHarnessCancellation({
      req: {
        _viventiumHarnessExecutionEnabled: true,
        body: { responseMessageId: 'response-1' },
        user: { id: 'user-synthetic' },
      },
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl,
    });

    abortController.abort('transport_disconnected');
    await Promise.resolve();

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('reports a non-success cancellation response instead of silently accepting it', async () => {
    const abortController = new AbortController();
    const onDeliveryError = jest.fn();
    bindHarnessCancellation({
      req: {
        _viventiumHarnessExecutionEnabled: true,
        _viventiumHarnessIdempotencyKey: 'main:response-1',
        body: {},
        user: { id: 'user-synthetic' },
      },
      signal: abortController.signal,
      endpointConfig: { baseURL: 'http://glasshive.local/v1', apiKey: 'synthetic-key' },
      fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 503 }),
      onDeliveryError,
    });

    abortController.abort('user_cancelled');
    await new Promise((resolve) => setImmediate(resolve));

    expect(onDeliveryError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'GlassHive cancellation returned HTTP 503' }),
    );
  });

  test('projects only declared non-GlassHive MCP servers', () => {
    const delimiter = Constants.mcp_delimiter;
    const names = declaredMcpServerNames(
      {
        tools: [
          `read_mail${delimiter}google-workspace`,
          `read_drive${delimiter}google-workspace`,
          `worker_run${delimiter}glasshive-workers-projects`,
          'file_search',
          { name: 'not-a-persisted-tool-id' },
        ],
      },
      ['glasshive-workers-projects'],
    );

    expect(names).toEqual(['google-workspace']);
  });

  test('does nothing when the selected provider has no workspace binding capability', async () => {
    const targetAgent = { model_parameters: {} };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: false },
      }),
    ).resolves.toBe(false);

    expect(buildConversationProviderBootstrapBundle).not.toHaveBeenCalled();
    expect(targetAgent).toEqual({ model_parameters: {} });
  });

  test('attaches one signed bundle while preserving existing provider headers', async () => {
    buildConversationProviderBootstrapBundle.mockResolvedValue({
      codex_config_append: '[mcp_servers.synthetic]',
    });
    const delimiter = Constants.mcp_delimiter;
    const requestBody = {
      conversationId: 'conversation-synthetic',
      messageId: 'message-synthetic',
    };
    const targetAgent = {
      model_parameters: {
        configuration: { defaultHeaders: { 'X-Existing': 'kept' } },
      },
    };
    const declaredAgent = {
      tools: [
        `search${delimiter}google-workspace`,
        `worker_run${delimiter}glasshive-workers-projects`,
      ],
    };

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent,
        declaredAgent,
        req: { user: { id: 'user-synthetic' }, body: { ignored: true } },
        requestBody,
        capability: {
          workspace_binding: true,
          excluded_mcp_servers: ['glasshive-workers-projects'],
        },
      }),
    ).resolves.toBe(true);

    expect(buildConversationProviderBootstrapBundle).toHaveBeenCalledWith({
      user: { id: 'user-synthetic' },
      requestBody,
      allowedServerNames: ['google-workspace'],
    });
    const headers = targetAgent.model_parameters.configuration.defaultHeaders;
    expect(headers['X-Existing']).toBe('kept');
    expect(
      JSON.parse(Buffer.from(headers['X-GlassHive-Bootstrap-Bundle-B64'], 'base64').toString()),
    ).toEqual({ codex_config_append: '[mcp_servers.synthetic]' });
    const expected = crypto
      .createHmac('sha256', 'synthetic-bundle-secret')
      .update(
        `v1\n${headers['X-GlassHive-Bootstrap-Timestamp']}\n${headers['X-GlassHive-Bootstrap-Bundle-B64']}`,
      )
      .digest('hex');
    expect(headers['X-GlassHive-Bootstrap-Signature']).toBe(`sha256=${expected}`);
  });

  test('fails closed instead of sending an unsigned capability bundle', async () => {
    delete process.env.VIVENTIUM_GLASSHIVE_CAPABILITY_BROKER_SECRET;
    buildConversationProviderBootstrapBundle.mockResolvedValue({ env: { SYNTHETIC: 'value' } });

    await expect(
      attachConversationProviderCapabilityBundle({
        targetAgent: { model_parameters: {} },
        declaredAgent: { tools: [`search${Constants.mcp_delimiter}synthetic-server`] },
        req: { user: { id: 'user-synthetic' }, body: {} },
        capability: { workspace_binding: true },
      }),
    ).rejects.toThrow('bootstrap signature secret is not configured');
  });
});
